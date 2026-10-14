/**
 * Phase 6 (p6-backend): returns QC reject / pickup failed, disputes, device tokens + push, payout
 * hold, seller scorecard endpoints.
 *  devices register / refresh / move / delete; buyer + seller dispute evidence uploads; return
 *  rejected -> dispute (eligibility, one per return, payout hold of a final order) -> seller
 *  reply -> review -> admin request-info -> buyer reply -> forced refund (COD payout + seller
 *  ledger debit + credit note) -> payouts released again; pickup failed (seller) -> dispute ->
 *  seller silent -> disputes-sla escalates -> reopen -> receive -> refund; QC partial reject (photo
 *  required) -> dispute rejected; full QC reject -> dispute withdrawn; window over; courier
 *  reverse-pickup failures (counted, deduped, max attempts); rider final pickup failure; push
 *  payloads + deep links + invalid-token pruning + push preference; scorecard endpoints.
 *
 * Throwaway local replica set only (the database is dropped); Razorpay, SMS and FCM are faked:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p6d?replicaSet=rs0" node src/tests/phase6Disputes.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import os from "os";
import path from "path";
import { env } from "../config/env.js";

if (!/127\.0\.0\.1:27027\/msp_test_p6d(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p6d database");
  process.exit(2);
}
process.env.PRIVATE_UPLOAD_DIR = path.join(os.tmpdir(), "msp-p6d-private");
delete process.env.FCM_SERVICE_ACCOUNT_JSON;
delete process.env.FCM_SERVICE_ACCOUNT_PATH;

const { setup, makeStore, makeBuyer } = await import("./commerceFixtures.js");
const { requestId } = await import("../middleware/requestId.js");
const { notFound, errorHandler } = await import("../middleware/error.js");
const { signAccessToken } = await import("../utils/tokens.js");
const { bus } = await import("../utils/events.js");
const { ensureSystemRoles } = await import("../seeds/index.js");
const { default: v1 } = await import("../routes/v1.js");
const { default: privateFilesRouter } = await import("../modules/files/routes.js");
const { User } = await import("../modules/users/user.model.js");
const { Product } = await import("../modules/catalog/product.model.js");
const { Settings } = await import("../modules/settings/settings.model.js");
const { invalidateSettingCache } = await import("../modules/settings/service.js");
const { settingDefinition } = await import("../modules/settings/registry.js");
const { addItem, getOrCreateCart, quoteCart } = await import("../modules/cart/service.js");
const { checkout } = await import("../modules/checkout/service.js");
const lifecycle = await import("../modules/orders/lifecycle.js");
const { applyCarrierUpdate } = await import("../modules/orders/service.js");
const { Order } = await import("../modules/orders/order.model.js");
const { CreditNote } = await import("../modules/invoices/invoice.model.js");
const { SellerLedgerEntry } = await import("../modules/payouts/models.js");
const { releaseFinalOrders } = await import("../modules/payouts/ledger.js");
const { Dispute } = await import("../modules/disputes/dispute.model.js");
const { DeviceToken } = await import("../modules/notifications/device.model.js");
const { setPushSender, deepLinkFor } = await import("../modules/notifications/push.js");
const { Notification } = await import("../modules/notifications/notification.model.js");
const { registerNotificationListeners } = await import("../modules/notifications/service.js");
const { updatePreferences } = await import("../modules/notifications/preferences.js");
const { runJob } = await import("../jobs/index.js");
const { Rider, DeliveryTask } = await import("../modules/fleet/models.js");
const { failTask } = await import("../modules/fleet/service.js");
const { PrivateFile } = await import("../modules/files/privateFile.model.js");

const fakeRzp = await setup(); // connects + drops the test database, fakes Razorpay
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));
registerNotificationListeners();

/* ---------------------------------------------------------------- fakes */
const pushes = [];
setPushSender(async (msg) => {
  pushes.push(msg);
  if (String(msg.token).startsWith("bad-")) return { ok: false, invalidToken: true };
  return { ok: true };
});

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
  const res = await fetch(base + (url.startsWith("/api/") ? url : "/api/v1" + url), {
    method,
    headers: h,
    body: form || (json !== undefined ? JSON.stringify(json) : undefined),
  });
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
for (const e of [
  "DISPUTE_OPENED",
  "DISPUTE_MESSAGE",
  "DISPUTE_INFO_REQUESTED",
  "DISPUTE_UNDER_REVIEW",
  "DISPUTE_DECIDED",
  "DISPUTE_WITHDRAWN",
  "ORDER_RETURN_PICKUP_FAILED",
  "ORDER_RETURN_QC_REJECTED",
  "ORDER_RETURN_PICKUP_SCHEDULED",
  "ORDER_RETURN_APPROVED",
]) {
  bus.on(e, (p) => events.push({ e, p }));
}
const eventsOf = (e) => events.filter((x) => x.e === e);
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

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

/* ---------------------------------------------------------------- stores, users */
const S = await makeStore({ stock: 200, price: 500 });
const SID = S.tenant._id;
await Product.updateOne({ _id: S.product._id }, { $set: { easyReturn: true } });
const S2 = await makeStore({ stock: 10, price: 100 });
const admin = await mkUser("Store Admin", "admin@p6d.test", roles.tenant_admin, { tenantId: SID });
const admin2 = await mkUser("Other Admin", "admin2@p6d.test", roles.tenant_admin, { tenantId: S2.tenant._id });
const platformAdmin = await mkUser("Platform", "pa@p6d.test", roles.super_admin);
const buyer = await makeBuyer();
await User.updateOne({ _id: buyer.user._id }, { $set: { status: "active", emailVerified: true } });
const buyer2 = await makeBuyer();
await User.updateOne({ _id: buyer2.user._id }, { $set: { status: "active", emailVerified: true } });
const T = {
  admin: await tokenFor(admin),
  admin2: await tokenFor(admin2),
  platform: await tokenFor(platformAdmin),
  buyer: await tokenFor(buyer.user._id),
  buyer2: await tokenFor(buyer2.user._id),
};

let seq = 0;
async function placeOrder(b, qty = 1, { paymentMethod = "cod" } = {}) {
  await addItem(b.user._id, null, { variantId: String(S.variant._id), qty });
  const quote = await quoteCart(await getOrCreateCart(b.user._id), b.user._id, b.address);
  const placed = await checkout({ expectedGrandTotal: quote.grandTotal, user: b.user, addressId: b.address._id, paymentMethod, idempotencyKey: `p6d-${(seq += 1)}-${Date.now()}` });
  let order = await Order.findById(placed.orders[0]._id);
  if (paymentMethod !== "cod") order = await lifecycle.payAndConfirm(order, { paymentId: `pay_p6d_${seq}` });
  return order;
}

async function deliver(order) {
  let o = await Order.findById(order._id);
  if (o.status === "pending") o = await lifecycle.confirmOrder(o, null);
  for (const to of ["processing", "ready_to_ship", "shipped", "delivered"]) o = await lifecycle.advanceOrder(o, to, {});
  return Order.findById(o._id);
}

async function requestReturn(order, reason = "damaged", items = null) {
  const res = await call("POST", `/orders/${order._id}/return`, { token: T.buyer, json: { reason, ...(items ? { items } : {}) } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return Order.findById(order._id);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
async function upload(token, folder = "disputes", headers = {}) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "evidence.png");
  form.append("folder", folder);
  form.append("purpose", "dispute_evidence");
  return call("POST", "/files/private", { token, form, headers });
}

/* ================================================================ 1. settings + devices */
await step("settings: phase 6 keys registered with the right scopes", async () => {
  assert.deepEqual(settingDefinition("disputes.windowDays").scopes, ["platform"]);
  assert.deepEqual(settingDefinition("returns.decideWithinHours").scopes, ["platform", "tenant"]);
  assert.equal(settingDefinition("returns.refundWithinHours").default, 48);
  assert.equal(settingDefinition("disputes.sellerResponseHours").default, 48);
  assert.equal(settingDefinition("scorecard.maxCancelRate").default, 5);
  assert.equal(settingDefinition("scorecard.maxLateShipRate").default, 10);
  assert.equal(settingDefinition("scorecard.maxReturnRate").default, 15);
  const keys = await call("GET", "/settings/keys", { token: T.platform });
  assert.equal(keys.status, 200);
  const list = Array.isArray(keys.data) ? keys.data : keys.data.data || keys.data.keys || [];
  assert.ok(JSON.stringify(list).includes("disputes.windowDays"), "listed for the admin settings UI");
  const put = await call("PUT", "/settings/disputes.windowDays", { token: T.admin, json: { value: 30 } });
  assert.equal(put.status, 404, "platform-only key");
});

await step("devices: register (201), refresh (200), list masked, move to another user, delete on logout, validation", async () => {
  const tok = "fcm-buyer-token-0001-abcdefghijklmnop";
  const r1 = await call("POST", "/devices", { token: T.buyer, json: { token: tok, platform: "android", app: "buyer" } });
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  assert.equal(r1.data.tokenSuffix, tok.slice(-8));
  assert.equal(r1.data.token, undefined, "full token never returned");
  const r2 = await call("POST", "/devices", { token: T.buyer, json: { token: tok, platform: "android", app: "buyer", appVersion: "1.2.0" } });
  assert.equal(r2.status, 200);
  assert.equal(await DeviceToken.countDocuments({ token: tok }), 1);
  const bad = await call("POST", "/devices", { token: T.buyer, json: { token: tok, platform: "windows", app: "buyer" } });
  assert.equal(bad.status, 400);
  const list = await call("GET", "/devices", { token: T.buyer });
  assert.equal(list.data.data.length, 1);
  assert.equal(list.data.data[0].appVersion, "1.2.0");
  // Same phone, another account signs in: the token moves.
  const moved = await call("POST", "/devices", { token: T.buyer2, json: { token: tok, platform: "android", app: "buyer" } });
  assert.equal(moved.status, 201);
  assert.equal(String((await DeviceToken.findOne({ token: tok })).userId), String(buyer2.user._id));
  const del = await call("DELETE", `/devices/${encodeURIComponent(tok)}`, { token: T.buyer2 });
  assert.equal(del.status, 200);
  assert.equal(del.data.removed, 1);
  const anon = await call("POST", "/devices", { json: { token: tok, platform: "android", app: "buyer" } });
  assert.equal(anon.status, 401);
  // Buyer's real device for the rest of the run (+ one FCM will reject).
  assert.equal((await call("POST", "/devices", { token: T.buyer, json: { token: "fcm-buyer-good-000000000001", platform: "ios", app: "buyer" } })).status, 201);
  assert.equal((await call("POST", "/devices", { token: T.buyer, json: { token: "bad-fcm-token-0000000000001", platform: "android", app: "buyer" } })).status, 201);
  const viaBody = await call("DELETE", "/devices", { token: T.buyer, json: { token: "does-not-exist-000000" } });
  assert.equal(viaBody.status, 200);
  assert.equal(viaBody.data.removed, 0);
});

await step("push: deep links per notification type", async () => {
  assert.equal(deepLinkFor("DISPUTE_DECIDED", { disputeId: "abc", orderId: "o1" }), "msp://dispute/abc");
  assert.equal(deepLinkFor("RIDER_ASSIGNED", { taskId: "t1", orderId: "o1" }), "msp://rider/task/t1");
  assert.equal(deepLinkFor("ORDER_SHIPPED", { orderId: "o1" }), "msp://order/o1");
  assert.equal(deepLinkFor("GLOBAL_ANNOUNCEMENT", {}), "msp://notifications");
});

/* ================================================================ 2. rejected return -> dispute -> refund */
let O1;
let D1;
let buyerFile;
let sellerFile;
await step("uploads: buyer + seller dispute evidence (folder disputes only for buyers)", async () => {
  const b = await upload(T.buyer);
  assert.equal(b.status, 201, JSON.stringify(b.data));
  assert.equal(b.data.tenantId, null);
  assert.equal(b.data.folder, "disputes");
  buyerFile = b.data.id;
  const kyc = await upload(T.buyer, "kyc");
  assert.equal(kyc.status, 403);
  const s = await upload(T.admin);
  assert.equal(s.status, 201);
  assert.equal(String(s.data.tenantId), String(SID));
  sellerFile = s.data.id;
  // the buyer may preview their own evidence, not the seller's
  assert.equal((await call("GET", `/files/private/${buyerFile}/link`, { token: T.buyer })).status, 200);
  assert.equal((await call("GET", `/files/private/${sellerFile}/link`, { token: T.buyer })).status, 404);
});

await step("return rejected -> buyer order view shows dispute eligibility; return requests carry decideBy", async () => {
  O1 = await deliver(await placeOrder(buyer, 2));
  O1 = await requestReturn(O1, "damaged");
  const ret = O1.returns.at(-1);
  assert.ok(ret.decideBy, "decideBy stamped");
  const hrs = (new Date(ret.decideBy) - new Date(ret.requestedAt)) / 3600000;
  assert.ok(Math.abs(hrs - 48) < 0.01, `decide within 48h (${hrs})`);
  const before = await call("GET", `/orders/${O1._id}`, { token: T.buyer });
  assert.equal(before.data.returns[0].dispute, null, "nothing to dispute while requested");
  const rej = await call("POST", `/orders/${O1._id}/return/reject`, { token: T.admin, json: { note: "Item was used" } });
  assert.equal(rej.status, 200, JSON.stringify(rej.data));
  const view = await call("GET", `/orders/${O1._id}`, { token: T.buyer });
  const info = view.data.returns[0].dispute;
  assert.equal(info.kind, "return_rejected");
  assert.equal(info.eligible, true);
  assert.equal(info.disputeId, null);
  const deadlineDays = (new Date(info.deadline) - new Date(view.data.returns[0].decidedAt)) / DAY;
  assert.ok(Math.abs(deadlineDays - 7) < 0.001);
  // not disputable by someone else
  const other = await call("POST", "/disputes", { token: T.buyer2, json: { orderId: String(O1._id), returnId: String(ret._id), message: "Not my order but hey" } });
  assert.equal(other.status, 404);
});

await step("payout hold: a final order goes back on hold when a dispute opens", async () => {
  await Order.updateOne({ _id: O1._id }, { $set: { deliveredAt: new Date(Date.now() - 40 * DAY) } });
  await releaseFinalOrders();
  const fin = await Order.findById(O1._id);
  assert.ok(fin.payout.recordedAt, "COD order recorded on the seller ledger at delivery");
  assert.ok(fin.payout.finalAt, "final before the dispute");
  assert.ok((await SellerLedgerEntry.countDocuments({ orderId: O1._id, availableAt: null })) === 0);
});

await step("dispute open: validation, 201, one per return, order return flags, seller notified, buyer push", async () => {
  const ret = O1.returns.at(-1);
  const short = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(O1._id), returnId: String(ret._id), message: "no" } });
  assert.equal(short.status, 400);
  const foreignFile = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(O1._id), returnId: String(ret._id), message: "The box was crushed on arrival", fileIds: [sellerFile] } });
  assert.equal(foreignFile.status, 400, "cannot attach someone else's file");
  const staff = await call("POST", "/disputes", { token: T.admin, json: { orderId: String(O1._id), returnId: String(ret._id), message: "seller cannot open" } });
  assert.equal(staff.status, 403);
  pushes.length = 0;
  const res = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(O1._id), returnId: String(ret._id), message: "The box was crushed on arrival, photos attached", fileIds: [buyerFile] } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  D1 = res.data;
  assert.match(D1.number, /^DSP-\d{6}$/);
  assert.equal(D1.status, "open");
  assert.equal(D1.kind, "return_rejected");
  assert.equal(D1.awaiting, "seller");
  assert.equal(D1.claimAmount, ret.refundAmount);
  assert.equal(D1.items.length, 1);
  assert.equal(D1.messages.length, 1);
  assert.equal(D1.messages[0].files[0].id, buyerFile);
  assert.ok(Math.abs((new Date(D1.respondBy) - Date.now()) / 3600000 - 48) < 0.1);
  assert.equal(D1.allowedActions.withdraw, true);
  assert.equal(D1.return.status, "rejected");
  assert.equal(D1.return.decisionNote, "Item was used");
  const again = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(O1._id), returnId: String(ret._id), message: "Opening it a second time" } });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, "DISPUTE_EXISTS");
  const o = await Order.findById(O1._id);
  const r = o.returns.at(-1);
  assert.equal(String(r.disputeId), String(D1.id));
  assert.equal(r.disputeOpen, true);
  assert.equal(r.disputeStatus, "open");
  // payouts re-held
  assert.equal(o.payout.finalAt, null);
  assert.ok((await SellerLedgerEntry.countDocuments({ orderId: O1._id, availableAt: null })) > 0, "ledger lines held again");
  await releaseFinalOrders();
  assert.equal((await Order.findById(O1._id)).payout.finalAt, null, "open dispute keeps the order from becoming final");
  const view = await call("GET", `/orders/${O1._id}`, { token: T.buyer });
  assert.equal(view.data.returns[0].dispute.eligible, false);
  assert.equal(String(view.data.returns[0].dispute.disputeId), String(D1.id));
  await settle();
  assert.equal(eventsOf("DISPUTE_OPENED").length, 1);
  const staffNote = await Notification.findOne({ event: "DISPUTE_OPENED", tenantId: SID, "audience.type": "staff" }).lean();
  assert.ok(staffNote, "store staff notified");
  const p = pushes.find((x) => x.data.event === "DISPUTE_OPENED");
  assert.ok(p, "buyer got a push");
  assert.equal(p.data.deepLink, `msp://dispute/${D1.id}`);
  assert.equal(p.data.disputeId, String(D1.id));
  assert.ok(Object.values(p.data).every((v) => typeof v === "string"), "FCM data values are strings");
  assert.equal(await DeviceToken.countDocuments({ token: "bad-fcm-token-0000000000001" }), 0, "invalid token pruned");
});

await step("dispute access: lists + detail scoped to buyer / store; others 404 / 403", async () => {
  const bl = await call("GET", "/disputes", { token: T.buyer });
  assert.equal(bl.status, 200);
  assert.equal(bl.data.data.length, 1);
  assert.equal(bl.data.data[0].buyer, null);
  assert.equal(bl.data.counts.open, 1);
  const sl = await call("GET", "/disputes?status=open_all", { token: T.admin });
  assert.equal(sl.data.data.length, 1);
  assert.equal(sl.data.data[0].buyer.email, undefined, "sellers do not see buyer contact details");
  assert.equal((await call("GET", "/disputes", { token: T.admin2 })).data.data.length, 0);
  assert.equal((await call("GET", `/disputes/${D1.id}`, { token: T.admin2 })).status, 404);
  assert.equal((await call("GET", `/disputes/${D1.id}`, { token: T.buyer2 })).status, 404);
  assert.equal((await call("GET", "/admin/disputes", { token: T.admin })).status, 403);
  assert.equal((await call("GET", "/disputes?status=bogus", { token: T.buyer })).status, 400);
  const byOrder = await call("GET", `/disputes?orderId=${O1._id}`, { token: T.buyer });
  assert.equal(byOrder.data.data.length, 1);
  assert.equal(byOrder.data.counts.open, 1, "counts honour the order filter");
});

await step("seller replies with evidence -> under review (admin alert); evidence links for both sides", async () => {
  const res = await call("POST", `/disputes/${D1.id}/messages`, { token: T.admin, json: { text: "Buyer used the item; see our photo", fileIds: [sellerFile] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, "under_review");
  assert.equal(res.data.awaiting, "admin");
  await settle();
  assert.ok(await Notification.exists({ event: "DISPUTE_UNDER_REVIEW", "audience.roleSlug": "super_admin" }), "admin alert");
  assert.ok(pushes.some((x) => x.data.event === "DISPUTE_MESSAGE"), "buyer pushed about the seller reply");
  const link = await call("GET", `/disputes/${D1.id}/files/${sellerFile}/link`, { token: T.buyer });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const bytes = await fetch(base + link.data.url);
  assert.equal(bytes.status, 200);
  assert.equal(Buffer.from(await bytes.arrayBuffer()).length, PNG.length);
  const sLink = await call("GET", `/disputes/${D1.id}/files/${buyerFile}/link`, { token: T.admin });
  assert.equal(sLink.status, 200);
  const stray = await upload(T.buyer);
  assert.equal((await call("GET", `/disputes/${D1.id}/files/${stray.data.id}/link`, { token: T.admin })).status, 404, "files not on the dispute are not exposed");
});

await step("admin queue + request-info from the buyer -> awaiting_buyer -> buyer reply -> under_review", async () => {
  const q = await call("GET", "/admin/disputes?status=under_review", { token: T.platform });
  assert.equal(q.status, 200);
  assert.equal(q.data.data.length, 1);
  assert.equal(q.data.counts.under_review, 1);
  assert.ok(q.data.data[0].buyer.email, "admin sees buyer contact");
  assert.equal(q.data.data[0].store.name, S.tenant.name);
  const aged = await call("GET", "/admin/disputes?age=24h", { token: T.platform });
  assert.equal(aged.data.data.length, 0, "opened just now");
  const byStore = await call("GET", `/admin/disputes?tenantId=${S2.tenant._id}`, { token: T.platform });
  assert.equal(byStore.data.data.length, 0);
  const detail = await call("GET", `/admin/disputes/${D1.id}`, { token: T.platform });
  assert.equal(detail.data.allowedActions.decide, true);
  assert.equal(detail.data.messages.length, 2);
  assert.ok(detail.data.messages[1].byName, "admin sees who wrote");
  pushes.length = 0;
  const ri = await call("POST", `/admin/disputes/${D1.id}/request-info`, { token: T.platform, json: { from: "buyer", message: "Please send a photo of the outer box" } });
  assert.equal(ri.status, 200, JSON.stringify(ri.data));
  assert.equal(ri.data.status, "awaiting_buyer");
  assert.equal(ri.data.awaiting, "buyer");
  await settle();
  const p = pushes.find((x) => x.data.event === "DISPUTE_INFO_REQUESTED");
  assert.ok(p, "buyer pushed");
  assert.equal(p.data.deepLink, `msp://dispute/${D1.id}`);
  const empty = await call("POST", `/disputes/${D1.id}/messages`, { token: T.buyer, json: { text: "" } });
  assert.equal(empty.status, 400);
  const reply = await call("POST", `/disputes/${D1.id}/messages`, { token: T.buyer, json: { text: "Here it is", fileIds: [buyerFile] } });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.status, "under_review");
});

await step("admin decides refund: COD payout queued, credit note, seller ledger debit, payouts final again; second decide 409", async () => {
  const tooMuch = await call("POST", `/admin/disputes/${D1.id}/decide`, { token: T.platform, json: { action: "refund", amount: 999999, reason: "Box damage confirmed" } });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.data.code, "REFUND_TOO_HIGH");
  const noReason = await call("POST", `/admin/disputes/${D1.id}/decide`, { token: T.platform, json: { action: "refund", amount: 300 } });
  assert.equal(noReason.status, 400);
  const res = await call("POST", `/admin/disputes/${D1.id}/decide`, { token: T.platform, json: { action: "refund", amount: 300, reason: "Box damage confirmed by courier photo" } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, "resolved_refund");
  assert.equal(res.data.decision.action, "refund");
  assert.equal(res.data.decision.amount, 300);
  assert.equal(res.data.decision.refundMethod, "cod");
  assert.equal(res.data.allowedActions.message, false);
  const o = await Order.findById(O1._id);
  const row = o.refunds.find((r) => r.key.includes(":dispute:"));
  assert.ok(row, "refund recorded");
  assert.equal(row.amount, 300);
  assert.equal(row.method, "cod");
  assert.equal(row.status, "pending_payout");
  assert.equal(o.status, "delivered", "order status unchanged");
  assert.ok(await CreditNote.exists({ orderId: O1._id, refundKey: row.key }), "credit note issued");
  const debit = await SellerLedgerEntry.findOne({ orderId: O1._id, kind: "refund", refundRef: row.key }).lean();
  assert.ok(debit, "seller ledger debited");
  assert.equal(debit.amountPaise, -30000);
  const r = o.returns.at(-1);
  assert.equal(r.disputeOpen, false);
  assert.equal(r.disputeStatus, "resolved_refund");
  await releaseFinalOrders();
  assert.ok((await Order.findById(O1._id)).payout.finalAt, "released after the dispute closed");
  const again = await call("POST", `/admin/disputes/${D1.id}/decide`, { token: T.platform, json: { action: "reject", reason: "changed my mind" } });
  assert.equal(again.status, 409);
  const late = await call("POST", `/disputes/${D1.id}/messages`, { token: T.buyer, json: { text: "thanks" } });
  assert.equal(late.status, 409);
  await settle();
  const decided = eventsOf("DISPUTE_DECIDED");
  assert.equal(decided.length, 1);
  assert.equal(decided[0].p.action, "refund");
  assert.ok(await Notification.exists({ event: "DISPUTE_DECIDED", userId: buyer.user._id }));
  assert.ok(await Notification.exists({ event: "DISPUTE_DECIDED", tenantId: SID, "audience.type": "staff" }));
});

/* ================================================================ 3. pickup failed -> reopen */
let O2;
let D2;
await step("seller records a failed pickup -> return pickup_failed, buyer notified; dispute; seller silent -> disputes-sla", async () => {
  O2 = await deliver(await placeOrder(buyer, 1));
  O2 = await requestReturn(O2, "wrong_item");
  const ap = await call("POST", `/orders/${O2._id}/return/approve`, { token: T.admin, json: {} });
  assert.equal(ap.status, 200);
  const noNote = await call("POST", `/orders/${O2._id}/return/pickup-failed`, { token: T.admin, json: {} });
  assert.equal(noNote.status, 400);
  const pf = await call("POST", `/orders/${O2._id}/return/pickup-failed`, { token: T.admin, json: { note: "Buyer not reachable on 3 visits" } });
  assert.equal(pf.status, 200, JSON.stringify(pf.data));
  assert.equal(pf.data.status, "delivered");
  const ret = pf.data.returns.at(-1);
  assert.equal(ret.status, "pickup_failed");
  assert.equal(ret.pickupFailReason, "Buyer not reachable on 3 visits");
  await settle();
  assert.equal(eventsOf("ORDER_RETURN_PICKUP_FAILED").length, 1);
  assert.ok(await Notification.exists({ event: "ORDER_RETURN_PICKUP_FAILED", userId: buyer.user._id }));
  // the units stay blocked (dispute instead of a new request)
  const again = await call("POST", `/orders/${O2._id}/return`, { token: T.buyer, json: { reason: "wrong_item" } });
  assert.equal(again.status, 400);
  const open = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(O2._id), returnId: String(ret._id), message: "Nobody came to pick it up" } });
  assert.equal(open.status, 201, JSON.stringify(open.data));
  D2 = open.data;
  assert.equal(D2.kind, "pickup_failed");
  await Dispute.updateOne({ _id: D2.id }, { $set: { respondBy: new Date(Date.now() - 60000) } });
  const job = await runJob("disputes-sla");
  assert.equal(job.ran, true);
  assert.equal(job.result.escalated, 1);
  const d = await Dispute.findById(D2.id);
  assert.equal(d.status, "under_review");
  assert.equal(d.timedOut, true);
  assert.equal(d.messages.at(-1).from, "system");
  assert.equal((await runJob("disputes-sla")).result.escalated, 0, "idempotent");
});

await step("admin reopens: new approved return for the disputed units, order return_approved; seller receives -> refund", async () => {
  const res = await call("POST", `/admin/disputes/${D2.id}/decide`, { token: T.platform, json: { action: "reopen", reason: "Courier records show no visit" } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.status, "resolved_reopened");
  assert.ok(res.data.decision.newReturnId);
  let o = await Order.findById(O2._id);
  assert.equal(o.status, "return_approved");
  assert.equal(o.returns.length, 2);
  const [orig, fresh] = o.returns;
  assert.equal(String(orig.reopenedAs), String(fresh._id));
  assert.equal(String(fresh.reopenedFrom), String(orig._id));
  assert.equal(fresh.status, "approved");
  assert.equal(String(fresh.reopenedByDisputeId), String(D2.id));
  assert.ok(!fresh.disputeId, "the reopened return is not itself disputed");
  // The seller can't undo the platform's reopen by marking the pickup failed by hand.
  const pf = await call("POST", `/orders/${O2._id}/return/pickup-failed`, { token: T.admin, json: { note: "Buyer not home" } });
  assert.equal(pf.status, 409, JSON.stringify(pf.data));
  assert.equal(pf.data.code, "RETURN_REOPENED_BY_PLATFORM");
  const staffView = await call("GET", `/orders/${O2._id}`, { token: T.admin });
  assert.equal(staffView.data.allowedActions.returnPickupFailed, false);
  assert.equal(fresh.items[0].qty, 1);
  const rec = await call("POST", `/orders/${O2._id}/return/receive`, { token: T.admin, json: {} });
  assert.equal(rec.status, 200, JSON.stringify(rec.data));
  o = await Order.findById(O2._id);
  assert.equal(o.status, "returned");
  assert.ok(o.refunds.some((r) => r.key === `${O2._id}:return:${fresh._id}` && r.method === "cod"));
  assert.ok(o.returns[1].refundDueBy, "refund deadline stamped");
});

/* ================================================================ 4. QC partial reject -> dispute rejected */
let O3;
let D3;
await step("QC: rejecting units needs a reason + photo; partial QC refunds accepted units only", async () => {
  O3 = await deliver(await placeOrder(buyer, 3, { paymentMethod: "upi" }));
  assert.equal(O3.paymentStatus, "paid");
  O3 = await requestReturn(O3, "not_as_described");
  assert.equal((await call("POST", `/orders/${O3._id}/return/approve`, { token: T.admin, json: {} })).status, 200);
  const lineId = String(O3.items[0]._id);
  const noReason = await call("POST", `/orders/${O3._id}/return/receive`, { token: T.admin, json: { items: [{ itemId: lineId, rejectedQty: 1 }] } });
  assert.equal(noReason.status, 400);
  const noPhoto = await call("POST", `/orders/${O3._id}/return/receive`, { token: T.admin, json: { items: [{ itemId: lineId, rejectedQty: 1, rejectReason: "Seal broken, used" }] } });
  assert.equal(noPhoto.status, 400);
  assert.equal(noPhoto.data.code, "QC_PHOTOS_REQUIRED");
  const tooMany = await call("POST", `/orders/${O3._id}/return/receive`, {
    token: T.admin,
    json: { items: [{ itemId: lineId, rejectedQty: 3, damagedQty: 1, rejectReason: "x" }], qcPhotos: [sellerFile] },
  });
  assert.equal(tooMany.status, 400);
  const buyerPhoto = await call("POST", `/orders/${O3._id}/return/receive`, {
    token: T.admin,
    json: { items: [{ itemId: lineId, rejectedQty: 1, rejectReason: "Seal broken, used" }], qcPhotos: [buyerFile] },
  });
  assert.equal(buyerPhoto.status, 400, "photo must be the store's own upload");
  const ok = await call("POST", `/orders/${O3._id}/return/receive`, {
    token: T.admin,
    json: { items: [{ itemId: lineId, rejectedQty: 1, rejectReason: "Seal broken, used" }], qcNote: "1 of 3 opened and used", qcPhotos: [sellerFile], qcDisposition: "return_to_buyer" },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const o = await Order.findById(O3._id);
  assert.equal(o.status, "delivered", "not every unit came back");
  const ret = o.returns.at(-1);
  assert.equal(ret.status, "received");
  assert.equal(ret.items[0].qty, 2);
  assert.equal(ret.qc.items[0].qty, 1);
  assert.equal(ret.qc.items[0].reason, "Seal broken, used");
  assert.equal(ret.qc.disposition, "return_to_buyer");
  assert.equal(String(ret.qc.photos[0]), sellerFile);
  assert.ok(ret.qc.rejectedAmount > 0);
  assert.equal(o.items[0].returnedQty, 2);
  const refund = o.refunds.find((r) => r.key === `${O3._id}:return:${ret._id}`);
  assert.ok(refund, "refund for accepted units");
  assert.equal(refund.amount, ret.refundAmount);
  await settle();
  const qc = eventsOf("ORDER_RETURN_QC_REJECTED").at(-1);
  assert.equal(qc.p.partial, true);
  assert.equal(qc.p.rejectedQty, 1);
  assert.ok(await Notification.exists({ event: "ORDER_RETURN_QC_REJECTED", userId: buyer.user._id }));
  // the rejected unit cannot be requested again (blocked), nothing else is returnable
  const view = await call("GET", `/orders/${O3._id}`, { token: T.buyer });
  assert.equal(view.data.allowedActions.return, false);
  assert.equal(view.data.returns[0].dispute.kind, "qc_rejected");
  assert.equal(view.data.returns[0].dispute.eligible, true);
});

await step("QC dispute: claim = rejected units, QC photos visible to the buyer, admin rejects", async () => {
  const ret = (await Order.findById(O3._id)).returns.at(-1);
  const res = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(O3._id), returnId: String(ret._id), message: "The seal was intact when I sent it" } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  D3 = res.data;
  assert.equal(D3.kind, "qc_rejected");
  assert.equal(D3.items[0].qty, 1);
  assert.ok(Math.abs(D3.claimAmount - ret.qc.rejectedAmount) < 0.02, `${D3.claimAmount} vs ${ret.qc.rejectedAmount}`);
  assert.equal(D3.return.qc.photos.length, 1);
  const photoLink = await call("GET", `/disputes/${D3.id}/files/${sellerFile}/link`, { token: T.buyer });
  assert.equal(photoLink.status, 200, "buyer can open the seller's QC photo");
  const rej = await call("POST", `/admin/disputes/${D3.id}/decide`, { token: T.platform, json: { action: "reject", reason: "Seller photos show clear use" } });
  assert.equal(rej.status, 200);
  assert.equal(rej.data.status, "rejected");
  const o = await Order.findById(O3._id);
  assert.equal(o.refunds.filter((r) => r.key.includes(":dispute:")).length, 0, "no refund on reject");
  assert.equal(o.returns.at(-1).disputeStatus, "rejected");
});

await step("full QC reject -> qc_rejected (no refund, no restock); dispute withdrawn; cannot reopen another", async () => {
  let o = await deliver(await placeOrder(buyer, 1));
  o = await requestReturn(o, "changed_mind");
  assert.equal((await call("POST", `/orders/${o._id}/return/approve`, { token: T.admin, json: {} })).status, 200);
  const res = await call("POST", `/orders/${o._id}/return/receive`, {
    token: T.admin,
    json: { items: [{ itemId: String(o.items[0]._id), rejectedQty: 1, rejectReason: "Different item returned" }], qcPhotos: [sellerFile], qcDisposition: "hold" },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  o = await Order.findById(o._id);
  assert.equal(o.status, "delivered");
  const ret = o.returns.at(-1);
  assert.equal(ret.status, "qc_rejected");
  assert.equal(o.items[0].returnedQty, 0);
  assert.equal(o.refunds.length, 0);
  assert.equal(o.returnRequest.status, "qc_rejected");
  const d = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(o._id), returnId: String(ret._id), message: "I returned the right item" } });
  assert.equal(d.status, 201);
  const w = await call("POST", `/disputes/${d.data.id}/withdraw`, { token: T.buyer, json: {} });
  assert.equal(w.status, 200, JSON.stringify(w.data));
  assert.equal(w.data.status, "withdrawn");
  assert.equal((await call("POST", `/disputes/${d.data.id}/withdraw`, { token: T.buyer, json: {} })).status, 409);
  assert.equal((await call("POST", `/disputes/${d.data.id}/withdraw`, { token: T.admin, json: {} })).status, 403);
  const again = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(o._id), returnId: String(ret._id), message: "Opening it again now" } });
  assert.equal(again.status, 409);
  await settle();
  assert.ok(eventsOf("DISPUTE_WITHDRAWN").length >= 1);
  // reopen of a QC-held return books no pickup: covered by reopen rules (disposition hold).
});

await step("dispute window over / not disputable", async () => {
  let o = await deliver(await placeOrder(buyer, 1));
  o = await requestReturn(o, "damaged");
  const ret = o.returns.at(-1);
  const notYet = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(o._id), returnId: String(ret._id), message: "Still waiting for the seller" } });
  assert.equal(notYet.status, 400);
  assert.equal(notYet.data.code, "NOT_DISPUTABLE");
  assert.equal((await call("POST", `/orders/${o._id}/return/reject`, { token: T.admin, json: { note: "No" } })).status, 200);
  await Order.updateOne({ _id: o._id, "returns._id": ret._id }, { $set: { "returns.$.decidedAt": new Date(Date.now() - 8 * DAY) } });
  const late = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(o._id), returnId: String(ret._id), message: "I was travelling" } });
  assert.equal(late.status, 400);
  assert.equal(late.data.code, "DISPUTE_WINDOW_OVER");
  const view = await call("GET", `/orders/${o._id}`, { token: T.buyer });
  assert.equal(view.data.returns[0].dispute.eligible, false);
  assert.match(view.data.returns[0].dispute.reason, /window/);
});

/* ================================================================ 5. courier + rider pickup failures */
await step("courier reverse pickup: failed scans counted (dupes ignored); max attempts -> pickup_failed", async () => {
  let o = await deliver(await placeOrder(buyer, 1));
  o = await requestReturn(o, "damaged");
  assert.equal((await call("POST", `/orders/${o._id}/return/approve`, { token: T.admin, json: {} })).status, 200);
  await Order.updateOne({ _id: o._id }, { $push: { fulfillments: { kind: "return", carrier: "Delhivery", trackingNumber: "RETP6D1", status: "pickup_scheduled" } } });
  const t0 = Date.now() - 3 * 3600000;
  const scan = (i, status = "Pickup Failed - customer not available") => applyCarrierUpdate({ waybill: "RETP6D1", status, statusType: "PU", at: new Date(t0 + i * 3600000).toISOString() });
  const ok = await applyCarrierUpdate({ waybill: "RETP6D1", status: "Pickup scheduled", statusType: "PU", at: new Date(t0).toISOString() });
  assert.equal(ok.recorded, true);
  const a1 = await scan(1);
  assert.equal(a1.pickupAttempts, 1);
  const dup = await scan(1);
  assert.equal(dup.duplicate, true);
  const a2 = await scan(2);
  assert.equal(a2.pickupAttempts, 2);
  assert.equal((await Order.findById(o._id)).status, "return_approved");
  const a3 = await scan(3);
  assert.equal(a3.returnStatus, "pickup_failed", JSON.stringify(a3));
  o = await Order.findById(o._id);
  assert.equal(o.status, "delivered");
  assert.equal(o.returns.at(-1).status, "pickup_failed");
  assert.ok(o.fulfillments.find((f) => f.kind === "return").cancelledAt);
  // courier cancellation closes immediately
  let c = await deliver(await placeOrder(buyer, 1));
  c = await requestReturn(c, "damaged");
  assert.equal((await call("POST", `/orders/${c._id}/return/approve`, { token: T.admin, json: {} })).status, 200);
  await Order.updateOne({ _id: c._id }, { $push: { fulfillments: { kind: "return", carrier: "Delhivery", trackingNumber: "RETP6D2", status: "pickup_scheduled" } } });
  const cn = await applyCarrierUpdate({ waybill: "RETP6D2", status: "Cancelled", statusType: "CN", at: new Date().toISOString() });
  assert.equal(cn.returnStatus, "pickup_failed");
});

await step("own rider: last return-pickup attempt fails -> return pickup_failed, task cancelled", async () => {
  let o = await deliver(await placeOrder(buyer, 1));
  await Order.updateOne({ _id: o._id }, { $set: { deliveryMethod: "own_fleet" } });
  o = await requestReturn(o, "damaged");
  const ap = await call("POST", `/orders/${o._id}/return/approve`, { token: T.admin, json: {} });
  assert.equal(ap.status, 200);
  await settle();
  assert.ok(eventsOf("ORDER_RETURN_PICKUP_SCHEDULED").some((x) => String(x.p.orderId) === String(o._id) && x.p.pickupMethod === "own_fleet"));
  const task = await DeliveryTask.findOne({ orderId: o._id, kind: "return_pickup" });
  assert.ok(task);
  const riderUser = await mkUser("Rider P6", "rider@p6d.test", roles.rider, { tenantId: SID });
  const rider = await Rider.create({ tenantId: SID, userId: riderUser._id, name: "Rider P6", phone: "+919800000006" });
  await DeliveryTask.updateOne({ _id: task._id }, { $set: { riderId: rider._id, status: "accepted", maxAttempts: 1 } });
  const req = { user: await User.findById(riderUser._id), role: { slug: "rider", isSystem: true }, permissions: ["rider.app"] };
  await failTask(req, String(task._id), { reason: "buyer_unavailable", note: "No one home" });
  const fresh = await Order.findById(o._id);
  assert.equal(fresh.status, "delivered");
  assert.equal(fresh.returns.at(-1).status, "pickup_failed");
  assert.match(fresh.returns.at(-1).pickupFailReason, /rider could not pick up/);
  assert.equal((await DeliveryTask.findById(task._id)).status, "cancelled");
});

/* ================================================================ 6. push preference */
await step("push respects the user's push preference; no devices -> skipped", async () => {
  await updatePreferences(buyer.user._id, { order: { push: false } });
  pushes.length = 0;
  let o = await deliver(await placeOrder(buyer, 1));
  await settle();
  assert.equal(pushes.filter((x) => x.data.orderId === String(o._id)).length, 0, "push off for orders");
  assert.ok(await Notification.exists({ userId: buyer.user._id, event: "ORDER_DELIVERED", "data.orderId": o._id }), "in-app still created");
  await updatePreferences(buyer.user._id, { order: { push: true } });
  o = await requestReturn(o, "damaged");
  await settle();
  assert.ok(pushes.some((x) => x.data.event === "ORDER_RETURN_REQUESTED" && x.data.deepLink === `msp://order/${o._id}`), "buyer confirmation pushed");
  const prefs = await call("GET", "/notifications/preferences", { token: T.buyer });
  assert.equal(prefs.status, 200);
  assert.equal(prefs.data.order.push, true);
  const patch = await call("PUT", "/notifications/preferences", { token: T.buyer, json: { marketing: { push: true } } });
  assert.ok([200, 404].includes(patch.status));
});

/* ================================================================ 7. scorecard endpoints */
await step("scorecard: seller /me (30/90), admin list sortable + per-store, validation and access", async () => {
  const me = await call("GET", "/scorecard/me?days=30", { token: T.admin });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.days, 30);
  assert.ok(me.data.orders >= 8);
  for (const k of ["cancelRate", "lateShipRate", "returnRate", "disputeRate"]) {
    assert.ok(["good", "warning", "bad"].includes(me.data.metrics[k].status), k);
    assert.equal(typeof me.data.metrics[k].percent, "number");
  }
  assert.ok(me.data.disputes.opened >= 4);
  assert.ok(me.data.disputes.lost >= 2, "refund + reopen count as lost");
  assert.ok(me.data.returns.pickupFailed >= 3);
  assert.ok(me.data.returns.qcRejected >= 2);
  assert.equal(me.data.metrics.returnRate.threshold, 15);
  assert.equal((await call("GET", "/scorecard/me?days=45", { token: T.admin })).status, 400);
  assert.equal((await call("GET", "/scorecard/me", { token: T.buyer })).status, 403);
  const list = await call("GET", "/admin/scorecards?days=90&sort=disputeRate&order=desc", { token: T.platform });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.data.days, 90);
  assert.equal(String(list.data.data[0].tenantId), String(SID));
  assert.deepEqual(Object.keys(list.data.counts).sort(), ["bad", "good", "warning"]);
  assert.equal(list.data.thresholds.cancelRate, 5);
  const one = await call("GET", `/admin/scorecards/${SID}`, { token: T.platform });
  assert.equal(one.status, 200);
  assert.equal(one.data.d30.days, 30);
  assert.equal(one.data.d90.days, 90);
  assert.equal((await call("GET", "/admin/scorecards", { token: T.admin })).status, 403);
});

/* ================================================================ reopened return fails again -> new dispute */
await step("reopened return whose pickup fails (courier) can be disputed again", async () => {
  let o = await deliver(await placeOrder(buyer, 1, { paymentMethod: "cod" }));
  o = await requestReturn(o, "damaged");
  const first = o.returns.at(-1);
  assert.equal((await call("POST", `/orders/${o._id}/return/reject`, { token: T.admin, json: { note: "Looks fine to us" } })).status, 200);
  const d = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(o._id), returnId: String(first._id), message: "It was broken on arrival" } });
  assert.equal(d.status, 201, JSON.stringify(d.data));
  const re = await call("POST", `/admin/disputes/${d.data.id}/decide`, { token: T.platform, json: { action: "reopen", reason: "Buyer photo convincing" } });
  assert.equal(re.status, 200, JSON.stringify(re.data));
  o = await Order.findById(o._id);
  const fresh = o.returns.at(-1);
  await lifecycle.markReturnPickupFailed(o, { reason: "Courier: consignee unavailable x3", source: "courier" });
  const view = await call("GET", `/orders/${o._id}`, { token: T.buyer });
  const info = view.data.returns.find((r) => String(r._id) === String(fresh._id)).dispute;
  assert.equal(info.kind, "pickup_failed");
  assert.equal(info.eligible, true, JSON.stringify(info));
  const d2 = await call("POST", "/disputes", { token: T.buyer, json: { orderId: String(o._id), returnId: String(fresh._id), message: "Nobody came to collect it" } });
  assert.equal(d2.status, 201, JSON.stringify(d2.data));
});

/* ---------------------------------------------------------------- done */
await settle(300);
server.close();
setPushSender(null);
await mongoose.disconnect();
console.log(`\nphase6Disputes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
