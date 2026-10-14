/**
 * Phase 5 (p5-backend): the store's own delivery fleet.
 *  riders CRUD + plan limit, staff counts exclude riders, rider OTP login (cooldown, expiry, wrong
 *  tries, inactive rider / store), checkout picks own_fleet by delivery zone, delivery task at
 *  ready_to_ship without AWB, board / assign / reject / auto-assign / accept, seller manual
 *  delivery blocked (RIDER_MANAGED), start -> buyer OTP + buyer sees rider / OTP, deliver with
 *  wrong / right OTP, COD cash -> codCollection seller + ledger collected_by_seller + rider cash +
 *  deposit, UPI QR -> platform (webhook), fail x2 -> RTO -> returned to store, return pickup flow,
 *  riders never see other riders' tasks, private delivery photos.
 *
 * Throwaway local replica set only (the database is dropped); Razorpay + SMS are faked:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p5f?replicaSet=rs0" node src/tests/phase5Fleet.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import os from "os";
import path from "path";
import { env } from "../config/env.js";

if (!/127\.0\.0\.1:27027\/msp_test_p5f(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p5f database");
  process.exit(2);
}
// Private uploads (delivery photos) go to a temp dir, never the repo.
process.env.PRIVATE_UPLOAD_DIR = path.join(os.tmpdir(), "msp-p5f-private");

const { setup, teardown, makeStore, makeBuyer } = await import("./commerceFixtures.js");
const { requestId } = await import("../middleware/requestId.js");
const { notFound, errorHandler } = await import("../middleware/error.js");
const { signAccessToken } = await import("../utils/tokens.js");
const { bus } = await import("../utils/events.js");
const { ensureSystemRoles } = await import("../seeds/index.js");
const { default: v1 } = await import("../routes/v1.js");
const { default: privateFilesRouter } = await import("../modules/files/routes.js");
const { User } = await import("../modules/users/user.model.js");
const { Tenant } = await import("../modules/tenants/tenant.model.js");
const { Address } = await import("../modules/location/address.model.js");
const { Settings } = await import("../modules/settings/settings.model.js");
const { invalidateSettingCache } = await import("../modules/settings/service.js");
const { setRazorpayClient } = await import("../modules/checkout/razorpayApi.js");
const { processRazorpayEvent } = await import("../modules/checkout/razorpay.js");
const { addItem, getOrCreateCart, quoteCart } = await import("../modules/cart/service.js");
const { checkout } = await import("../modules/checkout/service.js");
const lifecycle = await import("../modules/orders/lifecycle.js");
const { Order } = await import("../modules/orders/order.model.js");
const { SellerLedgerEntry } = await import("../modules/payouts/models.js");
const { unremittedCod } = await import("../modules/payouts/reconciliation.js");
const { TenantSubscription } = await import("../modules/billing/subscription.model.js");
const { countUsage, __resetEntitlementsCache } = await import("../modules/billing/entitlements.js");
const { Rider, DeliveryTask, DeliveryRun, RiderCashEntry, OtpChallenge } = await import("../modules/fleet/models.js");
const { ensureDeliveryTask } = await import("../modules/fleet/hooks.js");
const { setFleetSmsSender } = await import("../modules/fleet/util.js");
const { Inventory } = await import("../modules/inventory/inventory.model.js");

await setup(); // connects + drops the test database
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));
__resetEntitlementsCache();

/* ---------------------------------------------------------------- fakes */
let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq += 1)}`;
const fake = { orders: [], refunds: [], qrs: [], qrPayments: new Map() };
setRazorpayClient({
  createOrder: async ({ amount }) => {
    const row = { id: `order_${uid()}`, amount };
    fake.orders.push(row);
    return row;
  },
  createRefund: async (paymentId, { amount, notes }) => {
    const row = { id: `rfnd_${uid()}`, payment_id: paymentId, amount, notes, status: "processed" };
    fake.refunds.push(row);
    return row;
  },
  listRefunds: async (paymentId) => ({ items: fake.refunds.filter((r) => r.payment_id === paymentId) }),
  fetchPayment: async (id) => ({ id, status: "captured", currency: "INR" }),
  capturePayment: async (id, amount) => ({ id, status: "captured", amount, currency: "INR" }),
  createQrCode: async (body) => {
    const row = { id: `qr_${uid()}`, image_url: `https://rzp.io/qr/${seq}.png`, status: "active", ...body };
    fake.qrs.push(row);
    return row;
  },
  closeQrCode: async (id) => ({ id, status: "closed" }),
  fetchQrPayments: async (id) => ({ items: fake.qrPayments.get(id) || [] }),
});
env.razorpayKeyId = "rzp_test_p5f";
env.razorpayKeySecret = "p5f_test_secret";

const sms = [];
setFleetSmsSender(async (args) => {
  sms.push(args);
  return { sent: true };
});
const lastSms = (kind, phone) => [...sms].reverse().find((m) => m.kind === kind && (!phone || m.phone === phone));

/* ---------------------------------------------------------------- app + helpers */
const app = express();
app.use(requestId);
app.use(express.json());
app.use("/api/v1/files", privateFilesRouter);
app.use("/api/v1", v1);
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, { token, json, headers = {}, form } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + "/api/v1" + url, { method, headers: h, body: form || (json !== undefined ? JSON.stringify(json) : undefined) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

let passed = 0;
let failed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${err.stack}`);
    process.exitCode = 1;
  }
}

const events = [];
for (const e of ["RIDER_ASSIGNED", "RIDER_REJECTED_TASK", "DELIVERY_ATTEMPT_FAILED", "ORDER_OUT_FOR_DELIVERY", "ORDER_DELIVERED", "DELIVERY_METHOD_CHANGED"]) {
  bus.on(e, (p) => events.push({ e, p }));
}
const eventsOf = (e) => events.filter((x) => x.e === e);
const P = (rupees) => Math.round(Number(rupees) * 100);

async function setSetting(key, value) {
  await Settings.updateOne({ scope: "platform", tenantId: null, key }, { $set: { value } }, { upsert: true });
  invalidateSettingCache();
}

const roles = await ensureSystemRoles();
await setSetting("payouts.startDate", "2020-01-01");

async function mkUser(name, email, role, { tenantId = null } = {}) {
  return User.create({ name, email, passwordHash: "x", roleId: role._id, tenantId, status: "active", emailVerified: true });
}
const tokenFor = async (user) => {
  const fresh = await User.findById(user._id || user).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};

/* ---------------------------------------------------------------- store S */
const S = await makeStore({ stock: 100, price: 500 });
const SID = S.tenant._id;
await Tenant.updateOne(
  { _id: SID },
  {
    $set: {
      deliveryZones: [
        { name: "Near", pincodes: ["400001", "400002"], method: "own_fleet", deliveryFee: 30, etaDaysMin: 0, etaDaysMax: 1 },
        { name: "Far", pincodes: ["560001"], method: "partner", deliveryFee: 60, etaDaysMin: 2, etaDaysMax: 5 },
      ],
    },
  }
);
await TenantSubscription.create({
  tenantId: SID,
  status: "active",
  planSnapshot: { code: "basic", name: "Basic", limits: { riders: 2, staff: 3 }, features: {} },
});
const admin = await mkUser("Store Admin", "admin@p5f.test", roles.tenant_admin, { tenantId: SID });
const platformAdmin = await mkUser("Platform", "pa@p5f.test", roles.super_admin);
const T = { admin: await tokenFor(admin), platform: await tokenFor(platformAdmin) };

const buyer = await makeBuyer(); // PIN 400001 -> Near (own fleet)
await User.updateOne({ _id: buyer.user._id }, { $set: { status: "active", emailVerified: true, phone: "9811111111" } });
const buyerFar = await makeBuyer();
await Address.updateOne({ _id: buyerFar.address._id }, { $set: { postalCode: "560001", city: "Bengaluru", state: "Karnataka" } });
buyerFar.address = await Address.findById(buyerFar.address._id);
await User.updateOne({ _id: buyerFar.user._id }, { $set: { status: "active", emailVerified: true } });
T.buyer = await tokenFor(buyer.user._id);

async function placeOrder(b, qty = 1, { paymentMethod = "cod" } = {}) {
  await addItem(b.user._id, null, { variantId: String(S.variant._id), qty });
  const quote = await quoteCart(await getOrCreateCart(b.user._id), b.user._id, b.address);
  const placed = await checkout({
    expectedGrandTotal: quote.grandTotal,
    user: b.user,
    addressId: b.address._id,
    paymentMethod,
    idempotencyKey: `key-${uid()}`,
  });
  return { quote, order: await Order.findById(placed.orders[0]._id) };
}

async function toReady(order, { viaApi = false } = {}) {
  let o = await Order.findById(order._id);
  if (o.status === "pending") o = await lifecycle.confirmOrder(o, null);
  o = await lifecycle.advanceOrder(o, "processing", {});
  if (viaApi) {
    const res = await call("POST", `/orders/${o._id}/status`, { token: T.admin, json: { status: "ready_to_ship" } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  } else {
    await lifecycle.advanceOrder(o, "ready_to_ship", {});
  }
  return Order.findById(o._id);
}

const taskOf = (orderId, kind = "delivery") => DeliveryTask.findOne({ orderId, kind });

/* ================================================================ 1. riders */
let R1;
let R2;
let R3;
await step("riders: create / list / patch, duplicate mobile 409, plan limit, staff counts exclude riders", async () => {
  assert.equal(await countUsage(SID, "staff"), 1);
  const c1 = await call("POST", "/riders", {
    token: T.admin,
    json: { name: "Ravi Rider", phone: "98765 00001", vehicle: { type: "bike", number: "MH01AB1234" }, idProof: { type: "aadhaar", number: "1234 5678 9012" }, zoneNames: ["Near"] },
  });
  assert.equal(c1.status, 201, JSON.stringify(c1.data));
  R1 = c1.data;
  assert.equal(R1.phone, "+919876500001");
  assert.equal(R1.idProof.last4, "9012");
  assert.equal(R1.idProof.numberHash, undefined, "hash never returned");
  assert.equal(R1.status, "active");
  const u1 = await User.findById(R1.userId).populate("roleId").lean();
  assert.equal(u1.roleId.slug, "rider");
  assert.match(u1.email, /^rider\+[a-f\d]{24}@riders\.invalid$/);
  assert.equal(String(u1.tenantId), String(SID));

  const dup = await call("POST", "/riders", { token: T.admin, json: { name: "Dup", phone: "+91 9876500001" } });
  assert.equal(dup.status, 409);
  const bad = await call("POST", "/riders", { token: T.admin, json: { name: "Bad", phone: "12345" } });
  assert.equal(bad.status, 400);

  const c2 = await call("POST", "/riders", { token: T.admin, json: { name: "Suresh Rider", phone: "9876500002", vehicle: { type: "scooter" } } });
  assert.equal(c2.status, 201);
  R2 = c2.data;
  const c3 = await call("POST", "/riders", { token: T.admin, json: { name: "Third Rider", phone: "9876500003" } });
  assert.equal(c3.status, 403);
  assert.equal(c3.data.code, "LIMIT_REACHED");
  assert.equal(c3.data.kind, "riders");

  assert.equal(await countUsage(SID, "staff"), 1, "riders are not staff");
  assert.equal(await countUsage(SID, "riders"), 2);

  const list = await call("GET", "/riders", { token: T.admin });
  assert.equal(list.status, 200);
  assert.equal(list.data.data.length, 2);
  assert.deepEqual(list.data.limit, { limit: 2, usage: 2, remaining: 0 });
  assert.equal(list.data.data[0].cashInHandPaise, 0);

  const patch = await call("PATCH", `/riders/${R2.id}`, { token: T.admin, json: { vehicle: { number: "KA05XY9999" }, idProof: { type: "dl", number: "DL0420110012345" } } });
  assert.equal(patch.status, 200);
  assert.equal(patch.data.vehicle.number, "KA05XY9999");
  assert.equal(patch.data.vehicle.type, "scooter");
  assert.equal(patch.data.idProof.last4, "2345");

  // deactivate R2 frees a slot; re-activating it while full -> LIMIT_REACHED
  const off = await call("POST", `/riders/${R2.id}/deactivate`, { token: T.admin });
  assert.equal(off.status, 200);
  assert.equal(off.data.status, "inactive");
  assert.equal((await User.findById(R2.userId).lean()).status, "suspended");
  const c3b = await call("POST", "/riders", { token: T.admin, json: { name: "Third Rider", phone: "9876500003" } });
  assert.equal(c3b.status, 201);
  R3 = c3b.data;
  const on = await call("POST", `/riders/${R2.id}/activate`, { token: T.admin });
  assert.equal(on.status, 403);
  assert.equal(on.data.code, "LIMIT_REACHED");
});

await step("riders are not staff: staff list, role lists, permissions, /users edits and role assignment", async () => {
  const staff = await call("GET", "/users?staff=true&limit=100", { token: T.admin });
  assert.equal(staff.status, 200);
  assert.ok(!staff.data.data.some((u) => u.role?.slug === "rider"), "riders hidden from staff list");
  const rolesRes = await call("GET", "/roles?limit=100", { token: T.admin });
  assert.ok(!rolesRes.data.data.some((r) => r.slug === "rider"));
  const perms = await call("GET", "/permissions", { token: T.admin });
  assert.ok(perms.data.some((p) => p.key === "riders.manage"));
  assert.ok(!perms.data.some((p) => p.key === "rider.app"));
  const create = await call("POST", "/users", { token: T.admin, json: { name: "Xavier", email: "x@p5f.test", password: "Password123!Abc", roleId: String(roles.rider._id) } });
  assert.equal(create.status, 403, JSON.stringify(create.data));
  const edit = await call("PATCH", `/users/${R1.userId}`, { token: T.admin, json: { name: "Renamed" } });
  assert.equal(edit.status, 403);
  assert.equal(edit.data.code, "RIDER_ACCOUNT");
  const role = await call("POST", "/roles", { token: T.platform, headers: { "X-Tenant-Id": String(SID), "X-Admin-Reason": "test custom role" }, json: { name: "Fake rider", permissions: ["rider.app"] } });
  assert.equal(role.status, 403, "rider.app is never grantable");
});

/* ================================================================ 2. OTP login */
let riderToken;
let r3Token;
await step("OTP login: cooldown, unknown number (no enumeration), wrong code, success (+mobile refresh token)", async () => {
  const before = sms.length;
  const r1 = await call("POST", "/auth/otp/request", { json: { phone: "9876500001" } });
  assert.equal(r1.status, 200);
  assert.match(r1.data.devCode, /^\d{6}$/);
  assert.equal(sms.length, before + 1);
  assert.equal(lastSms("LOGIN_OTP").phone, "+919876500001");
  assert.equal(lastSms("LOGIN_OTP").vars.otp, r1.data.devCode);
  const again = await call("POST", "/auth/otp/request", { json: { phone: "9876500001" } });
  assert.equal(again.status, 429);
  assert.equal(again.data.code, "OTP_COOLDOWN");

  const unknown = await call("POST", "/auth/otp/request", { json: { phone: "9000000001" } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.message, r1.data.message, "same answer for unknown numbers");
  assert.equal(sms.length, before + 1, "no SMS to unknown numbers");
  const vUnknown = await call("POST", "/auth/otp/verify", { json: { phone: "9000000001", code: unknown.data.devCode } });
  assert.equal(vUnknown.status, 400);
  assert.equal(vUnknown.data.code, "OTP_INVALID");

  const wrong = await call("POST", "/auth/otp/verify", { json: { phone: "9876500001", code: r1.data.devCode === "000000" ? "111111" : "000000" } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.code, "OTP_INVALID");
  assert.equal(wrong.data.attemptsLeft, 4);

  const ok = await call("POST", "/auth/otp/verify", { json: { phone: "+919876500001", code: r1.data.devCode } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.accessToken);
  assert.equal(ok.data.refreshToken, undefined, "web: refresh token only in the cookie");
  assert.match(ok.headers.get("set-cookie") || "", /refreshToken=/);
  assert.equal(ok.data.user.role.slug, "rider");
  assert.equal(ok.data.user.isRider, true);
  riderToken = ok.data.accessToken;
  const reuse = await call("POST", "/auth/otp/verify", { json: { phone: "9876500001", code: r1.data.devCode } });
  assert.equal(reuse.status, 400, "codes are single use");

  // mobile client: refresh token in the body (like POST /auth/login with X-Client: mobile)
  await OtpChallenge.updateMany({ phone: "+919876500001" }, { $set: { sentAt: new Date(Date.now() - 60_000) } });
  const r2 = await call("POST", "/auth/otp/request", { json: { phone: "9876500001" } });
  const mob = await call("POST", "/auth/otp/verify", { headers: { "X-Client": "mobile" }, json: { phone: "9876500001", code: r2.data.devCode } });
  assert.equal(mob.status, 200);
  assert.ok(mob.data.refreshToken && mob.data.accessToken);
  const refreshed = await call("POST", "/auth/refresh", { headers: { "X-Client": "mobile" }, json: { refreshToken: mob.data.refreshToken } });
  assert.equal(refreshed.status, 200);
  const me = await call("GET", "/auth/me", { token: riderToken });
  assert.equal(me.data.role.slug, "rider");
});

await step("OTP login: 5 wrong tries lock the code, expiry, inactive rider and suspended store are refused", async () => {
  await OtpChallenge.updateMany({}, { $set: { sentAt: new Date(Date.now() - 60_000) } });
  const r = await call("POST", "/auth/otp/request", { json: { phone: "9876500003" } });
  const wrongCode = r.data.devCode === "999999" ? "888888" : "999999";
  for (let i = 0; i < 5; i += 1) {
    const w = await call("POST", "/auth/otp/verify", { json: { phone: "9876500003", code: wrongCode } });
    assert.equal(w.status, 400);
  }
  const locked = await call("POST", "/auth/otp/verify", { json: { phone: "9876500003", code: r.data.devCode } });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.code, "OTP_LOCKED");

  await OtpChallenge.updateMany({}, { $set: { sentAt: new Date(Date.now() - 60_000) } });
  const r2 = await call("POST", "/auth/otp/request", { json: { phone: "9876500003" } });
  await OtpChallenge.updateOne({ phone: "+919876500003", consumedAt: null }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await call("POST", "/auth/otp/verify", { json: { phone: "9876500003", code: r2.data.devCode } });
  assert.equal(expired.status, 400);
  assert.equal(expired.data.code, "OTP_EXPIRED");

  // inactive rider (R2): 200 on request but no SMS; verify -> 403
  const before = sms.length;
  const rq = await call("POST", "/auth/otp/request", { json: { phone: "9876500002" } });
  assert.equal(rq.status, 200);
  assert.equal(sms.length, before, "no SMS for an inactive rider");
  const vi = await call("POST", "/auth/otp/verify", { json: { phone: "9876500002", code: rq.data.devCode } });
  assert.equal(vi.status, 403);
  assert.equal(vi.data.code, "RIDER_INACTIVE");

  // suspended store
  await Tenant.updateOne({ _id: SID }, { $set: { status: "suspended" } });
  await OtpChallenge.updateMany({}, { $set: { sentAt: new Date(Date.now() - 60_000) } });
  const rs = await call("POST", "/auth/otp/request", { json: { phone: "9876500003" } });
  const vs = await call("POST", "/auth/otp/verify", { json: { phone: "9876500003", code: rs.data.devCode } });
  assert.equal(vs.status, 403);
  const blocked = await call("GET", "/rider/me", { token: riderToken });
  assert.equal(blocked.status, 403, "suspended store: rider app locked");
  await Tenant.updateOne({ _id: SID }, { $set: { status: "active" } });

  await OtpChallenge.updateMany({}, { $set: { sentAt: new Date(Date.now() - 60_000) } });
  const r3 = await call("POST", "/auth/otp/request", { json: { phone: "9876500003" } });
  const v3 = await call("POST", "/auth/otp/verify", { json: { phone: "9876500003", code: r3.data.devCode } });
  assert.equal(v3.status, 200);
  r3Token = v3.data.accessToken;

  assert.equal((await call("POST", "/auth/otp/request", { json: { phone: "abc" } })).status, 400);
});

await step("rider tokens reach only the rider app", async () => {
  assert.equal((await call("GET", "/orders", { token: riderToken })).status, 403);
  assert.equal((await call("GET", "/users", { token: riderToken })).status, 403);
  assert.equal((await call("GET", "/fleet/board", { token: riderToken })).status, 403);
  assert.equal((await call("GET", "/riders", { token: riderToken })).status, 403);
  assert.equal((await call("GET", "/files/private", { token: riderToken })).status, 200, "own uploads only");
  const me = await call("GET", "/rider/me", { token: riderToken });
  assert.equal(me.status, 200);
  assert.equal(me.data.rider.name, "Ravi Rider");
  assert.equal(me.data.store.name, S.tenant.name);
  assert.equal(me.data.cashInHandPaise, 0);
  assert.equal((await call("GET", "/rider/me", { token: T.admin })).status, 403, "store admin is not a rider");
});

/* ================================================================ 3. checkout */
let O1;
await step("checkout: own_fleet zone -> deliveryMethod own_fleet, no partner fee; other zone -> partner", async () => {
  const { quote, order } = await placeOrder(buyer, 1);
  assert.equal(quote.groups[0].deliveryMethod, "own_fleet");
  assert.equal(quote.groups[0].deliveryPartnerChoiceEnabled, false);
  assert.equal(order.deliveryMethod, "own_fleet");
  assert.equal(order.deliveryPartner.id, "own_fleet");
  assert.equal(order.deliveryPartner.fee, 0);
  assert.equal(order.partnerFee, 0);
  assert.equal(order.deliveryFee, 30);
  O1 = order;
  const far = await placeOrder(buyerFar, 1);
  assert.equal(far.quote.groups[0].deliveryMethod, "partner");
  assert.equal(far.order.deliveryMethod, "partner");
  assert.notEqual(far.order.deliveryPartner?.id, "own_fleet");
  assert.equal(far.order.deliveryFee, 60);
  const ready = await toReady(far.order);
  assert.equal(ready.status, "ready_to_ship");
  assert.equal(await DeliveryTask.countDocuments({ orderId: far.order._id }), 0, "partner orders get no task");
});

/* ================================================================ 4. task */
let T1;
await step("ready_to_ship opens one unassigned delivery task (no AWB booked)", async () => {
  const o = await toReady(O1, { viaApi: true });
  assert.equal(o.status, "ready_to_ship");
  assert.equal((o.fulfillments || []).length, 0, "no courier shipment");
  T1 = await taskOf(O1._id);
  assert.ok(T1);
  assert.equal(T1.status, "unassigned");
  assert.equal(T1.area, "Near");
  assert.equal(T1.cod.amount, o.total);
  assert.equal(T1.dropoff.pincode, "400001");
  assert.equal(T1.buyer.phone, "9999999999");
  await ensureDeliveryTask(o);
  assert.equal(await DeliveryTask.countDocuments({ orderId: O1._id }), 1, "idempotent");
});

/* ================================================================ 5. board / assign */
await step("board shows the task by area; assign, reject (seller notified), auto-assign by zone, accept", async () => {
  const b = await call("GET", "/fleet/board", { token: T.admin });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  assert.equal(b.data.unassigned[0].area, "Near");
  assert.equal(b.data.unassigned[0].tasks[0].orderNumber, O1.orderNumber);
  assert.ok(b.data.riders.some((r) => r.rider.id === R1.id));

  const a = await call("POST", `/fleet/tasks/${T1._id}/assign`, { token: T.admin, json: { riderId: R3.id } });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.status, "assigned");
  assert.equal(a.data.rider.name, "Third Rider");
  assert.ok(eventsOf("RIDER_ASSIGNED").some((x) => String(x.p.taskId) === String(T1._id)));
  const inactive = await call("POST", `/fleet/tasks/${T1._id}/assign`, { token: T.admin, json: { riderId: R2.id } });
  assert.equal(inactive.status, 409);

  // other riders never see it
  assert.equal((await call("GET", `/rider/tasks/${T1._id}`, { token: riderToken })).status, 404);
  const rej = await call("POST", `/rider/tasks/${T1._id}/reject`, { token: r3Token, json: { reason: "Too far" } });
  assert.equal(rej.status, 200);
  assert.equal((await taskOf(O1._id)).status, "unassigned");
  assert.ok(eventsOf("RIDER_REJECTED_TASK").some((x) => String(x.p.taskId) === String(T1._id) && x.p.reason === "Too far"));

  const auto = await call("POST", "/fleet/auto-assign", { token: T.admin, json: {} });
  assert.equal(auto.status, 200);
  assert.equal(auto.data.assigned, 1);
  assert.equal(auto.data.assignments[0].riderId, R1.id, "zone rider preferred");
  const run = await DeliveryRun.findOne({ riderId: R1.id });
  assert.ok(run && run.taskIds.some((id) => String(id) === String(T1._id)));
  assert.equal(run.area, "Near");

  const mine = await call("GET", "/rider/tasks?scope=today", { token: riderToken });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.data.length, 1);
  assert.equal(mine.data.data[0].buyer.phone, "9999999999");
  assert.ok(mine.data.data[0].dropoff.mapUrl.startsWith("https://www.google.com/maps"));
  assert.equal(mine.data.data[0].order.items[0].qty, 1);
  assert.equal((await call("GET", "/rider/tasks?scope=open", { token: r3Token })).data.data.length, 0);

  assert.equal((await call("POST", `/rider/tasks/${T1._id}/pickup`, { token: riderToken })).status, 409, "accept first");
  const acc = await call("POST", `/rider/tasks/${T1._id}/accept`, { token: riderToken });
  assert.equal(acc.status, 200);
  assert.equal(acc.data.status, "accepted");
});

/* ================================================================ 6/7. pickup, manual block, start */
let otpCode;
await step("pickup -> order shipped; seller cannot mark out for delivery / delivered (RIDER_MANAGED)", async () => {
  const p = await call("POST", `/rider/tasks/${T1._id}/pickup`, { token: riderToken });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.status, "picked_up");
  const o = await Order.findById(O1._id);
  assert.equal(o.status, "shipped");
  assert.equal((o.fulfillments || []).length, 0, "still no AWB");
  const ofd = await call("POST", `/orders/${O1._id}/status`, { token: T.admin, json: { status: "out_for_delivery" } });
  assert.equal(ofd.status, 409);
  assert.equal(ofd.data.code, "RIDER_MANAGED");
  const del = await call("POST", `/orders/${O1._id}/status`, { token: T.admin, json: { status: "delivered" } });
  assert.equal(del.status, 409);
  assert.equal(del.data.code, "RIDER_MANAGED");
  assert.equal(del.data.message, "Delivered only by the rider with the buyer's OTP");
  const view = await call("GET", `/orders/${O1._id}`, { token: T.admin });
  assert.equal(view.data.allowedActions.markDelivered, false);
  assert.equal(view.data.allowedActions.markOutForDelivery, false);
  assert.equal(view.data.allowedActions.riderManaged, true);
  assert.equal(view.data.delivery.method, "own_fleet");
  assert.equal(view.data.delivery.task.status, "picked_up");
  assert.equal(view.data.delivery.task.rider.name, "Ravi Rider");
});

await step("start -> out for delivery, buyer SMS code + sees rider and OTP; rider / seller never see the code", async () => {
  const before = await call("GET", `/orders/${O1._id}`, { token: T.buyer });
  assert.equal(before.data.delivery.otp, null);
  assert.equal(before.data.delivery.rider, null);
  const s = await call("POST", `/rider/tasks/${T1._id}/start`, { token: riderToken });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.status, "out_for_delivery");
  assert.equal(s.data.otp.sent, true);
  assert.equal(JSON.stringify(s.data).includes("cipher"), false);
  assert.equal((await Order.findById(O1._id)).status, "out_for_delivery");
  const msg = lastSms("DELIVERY_OTP");
  assert.equal(msg.phone, "9999999999");
  otpCode = msg.vars.otp;
  assert.match(otpCode, /^\d{6}$/);
  assert.equal(msg.vars.rider, "Ravi Rider");
  const ev = eventsOf("ORDER_OUT_FOR_DELIVERY").find((x) => String(x.p.orderId) === String(O1._id));
  assert.equal(ev.p.rider.name, "Ravi Rider");
  assert.equal(ev.p.rider.phone, "+919876500001");
  const bv = await call("GET", `/orders/${O1._id}`, { token: T.buyer });
  assert.equal(bv.status, 200);
  assert.deepEqual(bv.data.delivery.rider, { name: "Ravi Rider", phone: "+919876500001" });
  assert.equal(bv.data.delivery.otp, otpCode);
  const sv = await call("GET", `/orders/${O1._id}`, { token: T.admin });
  assert.equal(JSON.stringify(sv.data.delivery).includes(otpCode), false, "seller never sees the code");
  const rv = await call("GET", `/rider/tasks/${T1._id}`, { token: riderToken });
  assert.equal(JSON.stringify(rv.data).includes(otpCode), false, "rider never sees the code");
  const resend = await call("POST", `/rider/tasks/${T1._id}/resend-otp`, { token: riderToken });
  assert.equal(resend.status, 429);
  assert.equal(resend.data.code, "OTP_COOLDOWN");
});

/* ================================================================ 8. deliver (cash) */
let photoId;
await step("delivery photo: rider uploads to the private `delivery` folder only; reads only their own files", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const form = new FormData();
  form.append("folder", "delivery");
  form.append("file", new Blob([png], { type: "image/png" }), "proof.png");
  const up = await call("POST", "/files/private", { token: riderToken, form });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.folder, "delivery");
  photoId = up.data.id;
  const kycForm = new FormData();
  kycForm.append("folder", "kyc");
  kycForm.append("file", new Blob([png], { type: "image/png" }), "x.png");
  assert.equal((await call("POST", "/files/private", { token: riderToken, form: kycForm })).status, 403);
  // store's KYC file is invisible to riders, visible to the store
  const { PrivateFile } = await import("../modules/files/privateFile.model.js");
  const kyc = await PrivateFile.create({ tenantId: SID, uploadedBy: admin._id, key: `kyc/${uid()}.png`, folder: "kyc", mimeType: "image/png" });
  assert.equal((await call("GET", `/files/private/${kyc._id}/link`, { token: riderToken })).status, 404);
  assert.equal((await call("GET", `/files/private/${photoId}/link`, { token: riderToken })).status, 200);
  assert.equal((await call("GET", `/files/private/${photoId}/link`, { token: T.admin })).status, 200, "store sees delivery photos");
  assert.equal((await call("GET", `/files/private/${photoId}/link`, { token: r3Token })).status, 404, "other riders do not");
  // Order staff without file permissions: delivery proof yes, KYC no.
  const { Role } = await import("../modules/rbac/role.model.js");
  const packer = await Role.create({ name: "Packer", slug: `packer-${uid()}`, tenantId: SID, permissions: ["orders.view", "orders.update"] });
  const packerUser = await mkUser("Packer", `packer-${uid()}@p5f.test`, packer, { tenantId: SID });
  const packerToken = await tokenFor(packerUser);
  assert.equal((await call("GET", `/files/private/${photoId}/link`, { token: packerToken })).status, 200, "order staff see delivery photos");
  assert.equal((await call("GET", `/files/private/${kyc._id}/link`, { token: packerToken })).status, 404, "but not KYC files");
});

await step("deliver: wrong OTP refused, COD needs a method; cash -> delivered, codCollection seller, ledger collected_by_seller, rider cash", async () => {
  const wrong = await call("POST", `/rider/tasks/${T1._id}/deliver`, { token: riderToken, json: { otp: otpCode === "000000" ? "111111" : "000000", cod: { method: "cash" } } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.code, "OTP_INVALID");
  assert.equal(wrong.data.attemptsLeft, 4);
  const noMethod = await call("POST", `/rider/tasks/${T1._id}/deliver`, { token: riderToken, json: { otp: otpCode } });
  assert.equal(noMethod.status, 400);
  assert.equal((await Order.findById(O1._id)).status, "out_for_delivery");
  const ok = await call("POST", `/rider/tasks/${T1._id}/deliver`, { token: riderToken, json: { otp: otpCode, photoFileId: photoId, cod: { method: "cash" } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "delivered");
  assert.equal(ok.data.otp.verified, true);
  assert.equal(ok.data.cod.method, "cash");
  assert.equal(String(ok.data.proofPhotoFileId), String(photoId));
  const o = await Order.findById(O1._id);
  assert.equal(o.status, "delivered");
  assert.equal(o.paymentStatus, "paid");
  assert.equal(o.codCollection.by, "seller");
  assert.equal(o.payout.basis, "cod_seller");
  const col = await SellerLedgerEntry.find({ orderId: O1._id, kind: "collected_by_seller" }).lean();
  assert.equal(col.length, 1);
  assert.equal(col[0].amountPaise, -P(o.total));
  const again = await call("POST", `/rider/tasks/${T1._id}/deliver`, { token: riderToken, json: { otp: otpCode, cod: { method: "cash" } } });
  assert.equal(again.status, 409, "delivered once");
  const me = await call("GET", "/rider/me", { token: riderToken });
  assert.equal(me.data.cashInHandPaise, P(o.total));
  assert.equal(me.data.rider.stats.delivered, 1);
  assert.equal(await RiderCashEntry.countDocuments({ taskId: T1._id }), 1);
  const bv = await call("GET", `/orders/${O1._id}`, { token: T.buyer });
  assert.equal(bv.data.delivery.otp, null, "code hidden after delivery");
  assert.equal(bv.data.delivery.rider, null);
});

await step("rider cash: overview, history, seller deposit (partial; over-deposit 409)", async () => {
  const o = await Order.findById(O1._id);
  const ov = await call("GET", "/fleet/cash", { token: T.admin });
  assert.equal(ov.status, 200);
  const row = ov.data.data.find((r) => r.rider.id === R1.id);
  assert.equal(row.cashInHandPaise, P(o.total));
  assert.equal(ov.data.totalCashInHandPaise, P(o.total));
  const over = await call("POST", `/riders/${R1.id}/cash/deposits`, { token: T.admin, json: { amount: o.total + 1 } });
  assert.equal(over.status, 409);
  const dep = await call("POST", `/riders/${R1.id}/cash/deposits`, { token: T.admin, json: { amount: 100, note: "Evening handover" } });
  assert.equal(dep.status, 201, JSON.stringify(dep.data));
  assert.equal(dep.data.cashInHandPaise, P(o.total) - 10000);
  const hist = await call("GET", `/riders/${R1.id}/cash`, { token: T.admin });
  assert.equal(hist.data.cashInHandPaise, P(o.total) - 10000);
  assert.equal(hist.data.data.length, 2);
  assert.equal(hist.data.data[0].kind, "deposit");
  assert.equal(hist.data.data[0].amountPaise, -10000);
  const mine = await call("GET", "/rider/cash", { token: riderToken });
  assert.equal(mine.data.cashInHandPaise, P(o.total) - 10000);
  // A paused store still confirms cash handovers, but cannot add riders.
  const tenantId = o.tenantId;
  await Tenant.updateOne({ _id: tenantId }, { $set: { status: "paused", statusReason: "Paused by admin" } });
  try {
    const paused = await call("POST", `/riders/${R1.id}/cash/deposits`, { token: T.admin, json: { amount: 1, note: "While paused" } });
    assert.equal(paused.status, 201, JSON.stringify(paused.data));
    const add = await call("POST", "/riders", { token: T.admin, json: { name: "Paused Rider", phone: "9811100099", vehicle: { type: "bike" } } });
    assert.equal(add.data.code, "STORE_PAUSED", JSON.stringify(add.data));
  } finally {
    await Tenant.updateOne({ _id: tenantId }, { $set: { status: "active", statusReason: "" } });
  }
});

/* ================================================================ 9. UPI QR */
async function riderRunToOfd(order) {
  await toReady(order);
  const task = await taskOf(order._id);
  assert.equal((await call("POST", `/fleet/tasks/${task._id}/assign`, { token: T.admin, json: { riderId: R1.id } })).status, 200);
  assert.equal((await call("POST", `/rider/tasks/${task._id}/accept`, { token: riderToken })).status, 200);
  assert.equal((await call("POST", `/rider/tasks/${task._id}/pickup`, { token: riderToken })).status, 200);
  const s = await call("POST", `/rider/tasks/${task._id}/start`, { token: riderToken });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return { task, code: lastSms("DELIVERY_OTP").vars.otp };
}

let O2;
await step("COD by UPI QR: QR for the exact amount, webhook marks it paid, delivered with codCollection platform (no seller cash)", async () => {
  ({ order: O2 } = await placeOrder(buyer, 2));
  const { task, code } = await riderRunToOfd(O2);
  const early = await call("POST", `/rider/tasks/${task._id}/deliver`, { token: riderToken, json: { otp: code, cod: { method: "upi_qr" } } });
  assert.equal(early.status, 409);
  assert.equal(early.data.code, "COD_NOT_PAID");
  const qr = await call("POST", `/rider/tasks/${task._id}/cod/qr`, { token: riderToken });
  assert.equal(qr.status, 200, JSON.stringify(qr.data));
  assert.equal(qr.data.amountPaise, P(O2.total));
  assert.equal(qr.data.paid, false);
  assert.ok(qr.data.imageUrl);
  const made = fake.qrs.at(-1);
  assert.equal(made.payment_amount, P(O2.total));
  assert.equal(made.usage, "single_use");
  assert.equal(made.fixed_amount, true);
  const same = await call("POST", `/rider/tasks/${task._id}/cod/qr`, { token: riderToken });
  assert.equal(same.data.qrId, qr.data.qrId, "QR reused");
  assert.equal(fake.qrs.length, 1);

  // a webhook for an unrelated QR is ignored; the right one marks it paid (idempotent)
  assert.equal((await processRazorpayEvent({ event: "qr_code.credited", payload: { qr_code: { entity: { id: "qr_other" } }, payment: { entity: { id: "pay_x", amount: 1 } } } })).fleet, undefined);
  const ev = { event: "qr_code.credited", payload: { qr_code: { entity: { id: qr.data.qrId } }, payment: { entity: { id: "pay_qr_1", amount: P(O2.total), status: "captured" } } } };
  assert.equal((await processRazorpayEvent(ev)).fleet, true);
  await processRazorpayEvent(ev);
  const st = await call("GET", `/rider/tasks/${task._id}/cod/qr`, { token: riderToken });
  assert.equal(st.data.paid, true);
  assert.equal(st.data.razorpayPaymentId, "pay_qr_1");

  const cashBefore = (await call("GET", "/rider/me", { token: riderToken })).data.cashInHandPaise;
  const ok = await call("POST", `/rider/tasks/${task._id}/deliver`, { token: riderToken, json: { otp: code, cod: { method: "cash" } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.cod.method, "upi_qr", "a UPI-paid order is never counted as cash");
  const o = await Order.findById(O2._id);
  assert.equal(o.codCollection.by, "platform");
  assert.equal(o.codCollection.paymentId, "pay_qr_1");
  assert.equal(o.payout.basis, "cod_platform");
  assert.equal(await SellerLedgerEntry.countDocuments({ orderId: O2._id, kind: "collected_by_seller" }), 0);
  assert.ok((await SellerLedgerEntry.countDocuments({ orderId: O2._id, kind: "sale" })) === 1);
  assert.equal((await call("GET", "/rider/me", { token: riderToken })).data.cashInHandPaise, cashBefore, "no cash in hand");
  const unremitted = await unremittedCod({});
  const ids = (unremitted.data || unremitted.rows || []).map((r) => String(r.orderId || r.id || r._id));
  assert.ok(!ids.includes(String(O2._id)) && !ids.includes(String(O1._id)), "COD remittance lists only courier COD");
});

await step("QR poll: payment found by fetching the QR's payments (no webhook)", async () => {
  const { order } = await placeOrder(buyer, 1);
  const { task } = await riderRunToOfd(order);
  const qr = await call("POST", `/rider/tasks/${task._id}/cod/qr`, { token: riderToken });
  fake.qrPayments.set(qr.data.qrId, [{ id: "pay_poll_1", amount: P(order.total), status: "captured" }]);
  const st = await call("GET", `/rider/tasks/${task._id}/cod/qr`, { token: riderToken });
  assert.equal(st.data.paid, true);
  // leave it out for delivery; cancel nothing
});

/* ================================================================ 10. fail x2 -> RTO */
await step("failed attempt -> rescheduled (order back to shipped, buyer notified, no extra charge); 2nd failure -> RTO -> returned to store", async () => {
  const stockBefore = (await Inventory.findOne({ variantId: S.variant._id }).lean()).available;
  const { order } = await placeOrder(buyer, 3);
  const totalBefore = order.total;
  const { task } = await riderRunToOfd(order);
  const f1 = await call("POST", `/rider/tasks/${task._id}/fail`, { token: riderToken, json: { reason: "buyer_unavailable", note: "Door locked" } });
  assert.equal(f1.status, 200, JSON.stringify(f1.data));
  assert.equal(f1.data.status, "failed");
  assert.equal(f1.data.attemptsCount, 1);
  assert.ok(f1.data.rescheduledFor);
  let o = await Order.findById(order._id);
  assert.equal(o.status, "shipped");
  assert.equal(o.total, totalBefore, "no re-delivery charge");
  assert.ok(o.statusHistory.at(-1).note.includes("Delivery attempt 1 failed"));
  const ev = eventsOf("DELIVERY_ATTEMPT_FAILED").find((x) => String(x.p.orderId) === String(order._id));
  assert.equal(ev.p.final, false);
  assert.equal(ev.p.reason, "buyer_unavailable");
  const bv = await call("GET", `/orders/${order._id}`, { token: T.buyer });
  assert.equal(bv.data.delivery.attemptsCount, 1);
  assert.equal(bv.data.delivery.attempts[0].reasonLabel, "Buyer not available");
  assert.equal(bv.data.delivery.otp, null);

  // kept on the rider (fleet.keepRiderOnReschedule default true): start again next day
  const s2 = await call("POST", `/rider/tasks/${task._id}/start`, { token: riderToken });
  assert.equal(s2.status, 200, JSON.stringify(s2.data));
  assert.equal((await Order.findById(order._id)).status, "out_for_delivery");
  const f2 = await call("POST", `/rider/tasks/${task._id}/fail`, { token: riderToken, json: { reason: "buyer_refused" } });
  assert.equal(f2.status, 200);
  assert.equal(f2.data.status, "returning");
  o = await Order.findById(order._id);
  assert.equal(o.status, "rto_in_transit");
  assert.ok(eventsOf("DELIVERY_ATTEMPT_FAILED").some((x) => String(x.p.orderId) === String(order._id) && x.p.final === true));
  const back = await call("POST", `/rider/tasks/${task._id}/return-to-store`, { token: riderToken, json: {} });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.status, "returned_to_store");
  o = await Order.findById(order._id);
  assert.equal(o.status, "returned_to_origin");
  assert.equal((await Inventory.findOne({ variantId: S.variant._id }).lean()).available, stockBefore, "stock restored");
  const me = await call("GET", "/rider/me", { token: riderToken });
  assert.equal(me.data.rider.stats.failed, 2);
});

await step("keepRiderOnReschedule=false sends a failed delivery back to the pool; cancel before ship cancels the task", async () => {
  await Settings.updateOne({ scope: "tenant", tenantId: SID, key: "fleet.keepRiderOnReschedule" }, { $set: { value: false } }, { upsert: true });
  invalidateSettingCache();
  const { order } = await placeOrder(buyer, 1);
  const { task } = await riderRunToOfd(order);
  const f = await call("POST", `/rider/tasks/${task._id}/fail`, { token: riderToken, json: { reason: "address_not_found" } });
  assert.equal(f.status, 200, JSON.stringify(f.data));
  const t = await DeliveryTask.findById(task._id);
  assert.equal(t.status, "failed");
  assert.equal(t.riderId, null);
  const tomorrow = t.dueDate;
  const board = await call("GET", `/fleet/board?date=${tomorrow}`, { token: T.admin });
  assert.ok(board.data.unassigned.some((g) => g.tasks.some((x) => String(x.id) === String(task._id))));
  await Settings.deleteOne({ scope: "tenant", tenantId: SID, key: "fleet.keepRiderOnReschedule" });
  invalidateSettingCache();

  const { order: o2 } = await placeOrder(buyer, 1);
  await toReady(o2);
  const t2 = await taskOf(o2._id);
  const c = await call("POST", `/orders/${o2._id}/cancel`, { token: T.admin, json: { note: "Out of stock" } });
  assert.equal(c.status, 200);
  assert.equal((await DeliveryTask.findById(t2._id)).status, "cancelled");
});

await step("platform admin may override with a note; the task closes", async () => {
  const { order } = await placeOrder(buyer, 1, { paymentMethod: "cod" });
  const { task } = await riderRunToOfd(order);
  const noNote = await call("POST", `/orders/${order._id}/status`, { token: T.platform, headers: { "X-Tenant-Id": String(SID), "X-Admin-Reason": "buyer confirmed by phone" }, json: { status: "delivered" } });
  assert.equal(noNote.status, 400);
  const ok = await call("POST", `/orders/${order._id}/status`, { token: T.platform, headers: { "X-Tenant-Id": String(SID), "X-Admin-Reason": "buyer confirmed by phone" }, json: { status: "delivered", note: "POD photo on support ticket" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await DeliveryTask.findById(task._id)).status, "delivered");
});

/* ================================================================ 11. return pickup */
await step("return pickup: approve -> pickup task; rider checks items + photos, returns to store; store receives with damaged qty pre-filled", async () => {
  const o = await Order.findById(O1._id);
  await lifecycle.requestReturn(o, { actorId: buyer.user._id, reason: "damaged", items: [{ itemId: o.items[0]._id, qty: 1 }] });
  const ap = await call("POST", `/orders/${O1._id}/return/approve`, { token: T.admin, json: { note: "OK" } });
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  const task = await taskOf(O1._id, "return_pickup");
  assert.ok(task, "return pickup task");
  assert.equal(task.status, "unassigned");
  assert.equal(task.itemCheck.length, 1);
  assert.equal((await call("POST", `/fleet/tasks/${task._id}/assign`, { token: T.admin, json: { riderId: R1.id } })).status, 200);
  assert.equal((await call("POST", `/rider/tasks/${task._id}/accept`, { token: riderToken })).status, 200);
  const detail = await call("GET", `/rider/tasks/${task._id}`, { token: riderToken });
  assert.equal(detail.data.kind, "return_pickup");
  assert.equal(detail.data.returnItems[0].qty, 1);
  // First pickup attempt fails; the task stays with the rider, who retries the next visit.
  const miss = await call("POST", `/rider/tasks/${task._id}/fail`, { token: riderToken, json: { reason: "buyer_unavailable" } });
  assert.equal(miss.status, 200, JSON.stringify(miss.data));
  assert.equal(miss.data.status, "failed");
  assert.equal(miss.data.attemptsCount, 1);
  const pr = await call("POST", `/rider/tasks/${task._id}/pickup-return`, {
    token: riderToken,
    json: { itemCheck: [{ lineId: String(o.items[0]._id), okQty: 0, damagedQty: 1, note: "Crushed box" }], photos: [photoId] },
  });
  assert.equal(pr.status, 200, JSON.stringify(pr.data));
  assert.equal(pr.data.status, "picked_up");
  assert.equal(pr.data.itemCheck[0].damagedQty, 1);
  let ord = await Order.findById(O1._id);
  assert.ok(ord.fulfillments.some((f) => f.kind === "return" && f.carrier === "Own fleet" && f.status === "picked_up"));
  const back = await call("POST", `/rider/tasks/${task._id}/return-to-store`, { token: riderToken, json: {} });
  assert.equal(back.status, 200);
  assert.equal(back.data.status, "returned_to_store");
  const sv = await call("GET", `/orders/${O1._id}`, { token: T.admin });
  assert.equal(sv.data.delivery.returnPickups[0].itemCheck[0].damagedQty, 1);
  const rec = await call("POST", `/orders/${O1._id}/return/receive`, { token: T.admin, json: {} });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  ord = await Order.findById(O1._id);
  assert.equal(ord.status, "returned");
  const ret = ord.returns.at(-1);
  assert.equal(ret.status, "received");
  assert.equal(ret.items[0].damagedQty, 1, "damaged qty from the rider's item check");
});

await step("seller task endpoints: detail, reschedule, unassign, cancel (order leaves the own fleet)", async () => {
  const { order } = await placeOrder(buyer, 1);
  await toReady(order);
  const task = await taskOf(order._id);
  assert.equal((await call("POST", `/fleet/tasks/${task._id}/assign`, { token: T.admin, json: { riderId: R1.id } })).status, 200);
  const d = await call("GET", `/fleet/tasks/${task._id}`, { token: T.admin });
  assert.equal(d.status, 200);
  assert.equal(d.data.order.orderNumber, order.orderNumber);
  assert.ok(d.data.run);
  const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const rs = await call("POST", `/fleet/tasks/${task._id}/reschedule`, { token: T.admin, json: { date: future } });
  assert.equal(rs.status, 200, JSON.stringify(rs.data));
  assert.equal(rs.data.dueDate, future);
  assert.equal((await call("POST", `/fleet/tasks/${task._id}/reschedule`, { token: T.admin, json: { date: "2020-01-01" } })).status, 400);
  const un = await call("POST", `/fleet/tasks/${task._id}/unassign`, { token: T.admin });
  assert.equal(un.data.status, "unassigned");
  const cn = await call("POST", `/fleet/tasks/${task._id}/cancel`, { token: T.admin, json: { note: "Courier instead" } });
  assert.equal(cn.status, 200);
  assert.equal(cn.data.status, "cancelled");
  assert.equal((await Order.findById(order._id)).deliveryMethod, "partner");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(eventsOf("DELIVERY_METHOD_CHANGED").some((x) => String(x.p.orderId) === String(order._id)), "buyer is told the delivery method changed");
  // a store without riders.manage / orders.update cannot use the board
  const agent = await mkUser("Agent", "agent@p5f.test", roles.support_agent, { tenantId: SID });
  assert.equal((await call("GET", "/fleet/board", { token: await tokenFor(agent) })).status, 403);
});

server.close();
console.log(`\nphase5Fleet: ${passed} passed, ${failed} failed`);
setFleetSmsSender(null);
await teardown();
process.exit(process.exitCode || 0);
