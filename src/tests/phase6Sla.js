/**
 * Phase 6 (p6-backend) deadlines + seller scorecard numbers.
 *  order-sla: ship deadline auto-cancel (ship_timeout, seller fault; online paid -> refund),
 *  courier-booked packed orders only flagged, kill switch, confirm deadline unchanged, "due soon"
 *  reminders once; returns-sla: auto-approve after decideBy (+ legacy returns), store override of
 *  returns.decideWithinHours, decision reminders, overdue-refund admin alerts; scorecard counters.
 *
 * Throwaway local replica set only (the database is dropped); Razorpay / SMS / FCM faked:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p6s?replicaSet=rs0" node src/tests/phase6Sla.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";

if (!/127\.0\.0\.1:27027\/msp_test_p6s(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p6s database");
  process.exit(2);
}
delete process.env.FCM_SERVICE_ACCOUNT_JSON;
delete process.env.FCM_SERVICE_ACCOUNT_PATH;

const { setup, makeStore, makeBuyer } = await import("./commerceFixtures.js");
const { requestId } = await import("../middleware/requestId.js");
const { notFound, errorHandler } = await import("../middleware/error.js");
const { signAccessToken } = await import("../utils/tokens.js");
const { bus } = await import("../utils/events.js");
const { ensureSystemRoles } = await import("../seeds/index.js");
const { default: v1 } = await import("../routes/v1.js");
const { User } = await import("../modules/users/user.model.js");
const { Product } = await import("../modules/catalog/product.model.js");
const { Settings } = await import("../modules/settings/settings.model.js");
const { invalidateSettingCache } = await import("../modules/settings/service.js");
const { addItem, getOrCreateCart, quoteCart } = await import("../modules/cart/service.js");
const { checkout } = await import("../modules/checkout/service.js");
const lifecycle = await import("../modules/orders/lifecycle.js");
const { Order } = await import("../modules/orders/order.model.js");
const { Notification } = await import("../modules/notifications/notification.model.js");
const { registerNotificationListeners } = await import("../modules/notifications/service.js");
const { setPushSender } = await import("../modules/notifications/push.js");
const { runJob } = await import("../jobs/index.js");
const { storeScorecard } = await import("../modules/scorecard/service.js");

await setup();
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));
registerNotificationListeners();
setPushSender(async () => ({ ok: true }));

const app = express();
app.use(requestId);
app.use(express.json());
app.use("/api/v1", v1);
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
async function call(method, url, { token, json } = {}) {
  const h = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + "/api/v1" + url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
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
for (const e of ["ORDER_AUTO_CANCELLED", "ORDER_CANCELLED", "SELLER_DEADLINE_SOON", "ORDER_RETURN_APPROVED", "REFUND_OVERDUE"]) bus.on(e, (p) => events.push({ e, p }));
const eventsOf = (e, orderId = null) => events.filter((x) => x.e === e && (!orderId || String(x.p.orderId) === String(orderId)));
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600000;

async function setSetting(key, value, tenantId = null) {
  await Settings.updateOne({ scope: tenantId ? "tenant" : "platform", tenantId, key }, { $set: { value } }, { upsert: true });
  invalidateSettingCache();
}

const roles = await ensureSystemRoles();
await setSetting("payouts.startDate", "2020-01-01");
const tokenFor = async (id) => {
  const fresh = await User.findById(id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};

const S = await makeStore({ stock: 500, price: 200 });
await Product.updateOne({ _id: S.product._id }, { $set: { easyReturn: true } });
const admin = await User.create({ name: "Admin", email: "admin@p6s.test", passwordHash: "x", roleId: roles.tenant_admin._id, tenantId: S.tenant._id, status: "active", emailVerified: true });
const buyer = await makeBuyer();
await User.updateOne({ _id: buyer.user._id }, { $set: { status: "active", emailVerified: true } });
const T = { admin: await tokenFor(admin._id), buyer: await tokenFor(buyer.user._id) };

let seq = 0;
async function placeOrder(store, qty = 1, { paymentMethod = "cod" } = {}) {
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty });
  const quote = await quoteCart(await getOrCreateCart(buyer.user._id), buyer.user._id, buyer.address);
  const placed = await checkout({ expectedGrandTotal: quote.grandTotal, user: buyer.user, addressId: buyer.address._id, paymentMethod, idempotencyKey: `p6s-${(seq += 1)}-${Date.now()}` });
  let order = await Order.findById(placed.orders[0]._id);
  if (paymentMethod !== "cod") order = await lifecycle.payAndConfirm(order, { paymentId: `pay_p6s_${seq}` });
  return order;
}

/** Move an order's createdAt and status history timestamps back (raw driver: createdAt is immutable in mongoose). */
async function backdate(orderId, { createdHoursAgo, statusHoursAgo = {} }) {
  const now = Date.now();
  const order = await Order.collection.findOne({ _id: orderId });
  const history = (order.statusHistory || []).map((h) => (statusHoursAgo[h.status] != null ? { ...h, at: new Date(now - statusHoursAgo[h.status] * HOUR) } : h));
  await Order.collection.updateOne({ _id: orderId }, { $set: { createdAt: new Date(now - createdHoursAgo * HOUR), statusHistory: history } });
}

async function confirmed(store, opts = {}) {
  const o = await placeOrder(store, 1, opts);
  return o.status === "pending" ? lifecycle.confirmOrder(o, null) : o;
}

/* ================================================================ ship SLA */
let shipLate;
let shipLateOnline;
let packedBooked;
let fresh;
let pendingOld;
await step("order-sla: unshipped orders past shipBy are auto-cancelled (ship_timeout, seller fault); online paid refunded", async () => {
  shipLate = await confirmed(S);
  await backdate(shipLate._id, { createdHoursAgo: 80, statusHoursAgo: { confirmed: 75 } });
  shipLateOnline = await confirmed(S, { paymentMethod: "upi" });
  shipLateOnline = await lifecycle.advanceOrder(shipLateOnline, "processing", {});
  await backdate(shipLateOnline._id, { createdHoursAgo: 90, statusHoursAgo: { confirmed: 89, processing: 50 } });
  packedBooked = await confirmed(S);
  packedBooked = await lifecycle.advanceOrder(packedBooked, "processing", {});
  packedBooked = await lifecycle.advanceOrder(packedBooked, "ready_to_ship", { trackingNumber: "AWBP6S1", carrier: "Delhivery" });
  await backdate(packedBooked._id, { createdHoursAgo: 100, statusHoursAgo: { confirmed: 99 } });
  fresh = await confirmed(S);
  await backdate(fresh._id, { createdHoursAgo: 10, statusHoursAgo: { confirmed: 9 } });
  pendingOld = await placeOrder(S, 1);
  await backdate(pendingOld._id, { createdHoursAgo: 50 });

  const job = await runJob("order-sla");
  assert.equal(job.ran, true, JSON.stringify(job));
  assert.equal(job.result.cancelled, 1, "confirm deadline (pending COD)");
  assert.equal(job.result.shipCancelled, 2, JSON.stringify(job.result));

  const a = await Order.findById(shipLate._id);
  assert.equal(a.status, "cancelled");
  assert.equal(a.cancelReason, "ship_timeout");
  assert.equal(a.cancelCause, "seller");
  assert.equal(a.cancelledBy, "system");
  const b = await Order.findById(shipLateOnline._id);
  assert.equal(b.status, "cancelled");
  assert.ok(b.refunds.some((r) => r.key === `${b._id}:cancel` && r.amount === b.total), "online refund queued");
  assert.equal((await Order.findById(packedBooked._id)).status, "ready_to_ship", "courier-booked packed order only flagged");
  assert.equal((await Order.findById(fresh._id)).status, "confirmed");
  const p = await Order.findById(pendingOld._id);
  assert.equal(p.cancelReason, "seller_timeout");
  await settle();
  const auto = eventsOf("ORDER_AUTO_CANCELLED", shipLate._id);
  assert.equal(auto.length, 1);
  assert.equal(auto[0].p.cancelReason, "ship_timeout");
  const note = await Notification.findOne({ userId: buyer.user._id, event: "ORDER_AUTO_CANCELLED", "data.orderId": shipLate._id }).lean();
  assert.match(note.body, /did not ship it in time/);
  assert.equal(await Notification.countDocuments({ userId: buyer.user._id, event: "ORDER_CANCELLED", "data.orderId": shipLate._id }), 0, "no duplicate generic cancel notice");
  const online = await Notification.findOne({ userId: buyer.user._id, event: "ORDER_AUTO_CANCELLED", "data.orderId": shipLateOnline._id }).lean();
  assert.match(online.body, /full refund has been initiated/);
  const staff = await Notification.findOne({ tenantId: S.tenant._id, event: "ORDER_AUTO_CANCELLED", "data.orderId": shipLate._id, "audience.type": "staff" }).lean();
  assert.match(staff.body, /not shipped in time/);
  const view = await call("GET", `/orders/${packedBooked._id}`, { token: T.admin });
  assert.equal(view.data.sla.shipOverdue, true);
});

await step("order-sla: orders.shipSlaAutoCancel=false only flags", async () => {
  await setSetting("orders.shipSlaAutoCancel", false);
  const o = await confirmed(S);
  await backdate(o._id, { createdHoursAgo: 80, statusHoursAgo: { confirmed: 79 } });
  const job = await runJob("order-sla");
  assert.equal(job.result.disabled, true);
  assert.equal((await Order.findById(o._id)).status, "confirmed");
  await setSetting("orders.shipSlaAutoCancel", true);
  const again = await runJob("order-sla");
  assert.equal(again.result.shipCancelled, 1);
  assert.equal((await Order.findById(o._id)).cancelReason, "ship_timeout");
});

await step("order-sla: 'due soon' reminders for confirm + ship, once each", async () => {
  const pend = await placeOrder(S, 1);
  await backdate(pend._id, { createdHoursAgo: 47 });
  const conf = await confirmed(S);
  await backdate(conf._id, { createdHoursAgo: 71.5, statusHoursAgo: { confirmed: 71 } });
  await runJob("order-sla");
  await runJob("order-sla");
  await settle();
  const c = eventsOf("SELLER_DEADLINE_SOON", pend._id);
  assert.equal(c.length, 1);
  assert.equal(c[0].p.kind, "confirm");
  const s = eventsOf("SELLER_DEADLINE_SOON", conf._id);
  assert.equal(s.length, 1);
  assert.equal(s[0].p.kind, "ship");
  assert.ok(Math.abs(new Date(s[0].p.dueAt).getTime() - (Date.now() + HOUR)) < 5 * 60000);
  assert.ok(await Notification.exists({ tenantId: S.tenant._id, event: "SELLER_DEADLINE_SOON", "data.orderId": pend._id, "audience.type": "staff" }));
  assert.equal((await Order.findById(pend._id)).status, "pending");
  assert.equal(eventsOf("SELLER_DEADLINE_SOON", fresh._id).length, 0, "not due yet");
  const v = await call("GET", `/orders/${conf._id}`, { token: T.admin });
  assert.equal(v.data.sla.shipDueSoon, true);
  assert.equal(v.data.sla.warningHours, 2);
  const list = await call("GET", "/orders?limit=100", { token: T.admin });
  assert.equal(list.data.data.find((r) => String(r._id) === String(pend._id)).sla.confirmDueSoon, true, "list rows carry due-soon flags");
});

/* ================================================================ returns SLA */
async function deliveredOrder(store = S, qty = 1, opts = {}) {
  let o = await placeOrder(store, qty, opts);
  if (o.status === "pending") o = await lifecycle.confirmOrder(o, null);
  for (const to of ["processing", "ready_to_ship", "shipped", "delivered"]) o = await lifecycle.advanceOrder(o, to, {});
  return Order.findById(o._id);
}

await step("returns-sla: undecided return past decideBy is auto-approved (seller told; legacy returns use requestedAt)", async () => {
  let o = await deliveredOrder();
  o = await lifecycle.requestReturn(o, { actorId: buyer.user._id, reason: "damaged" });
  const ret = o.returns.at(-1);
  assert.ok(Math.abs(new Date(ret.decideBy) - new Date(ret.requestedAt) - 48 * HOUR) < 1000);
  await Order.updateOne({ _id: o._id, "returns._id": ret._id }, { $set: { "returns.$.decideBy": new Date(Date.now() - 60000) } });
  let legacy = await deliveredOrder();
  legacy = await lifecycle.requestReturn(legacy, { actorId: buyer.user._id, reason: "changed_mind" });
  await Order.updateOne({ _id: legacy._id }, { $set: { "returns.0.decideBy": null, "returns.0.requestedAt": new Date(Date.now() - 50 * HOUR) } });
  const job = await runJob("returns-sla");
  assert.equal(job.ran, true);
  assert.equal(job.result.autoApproved, 2, JSON.stringify(job.result));
  const a = await Order.findById(o._id);
  assert.equal(a.status, "return_approved");
  assert.equal(a.returns.at(-1).status, "approved");
  assert.equal(a.returns.at(-1).autoApproved, true);
  assert.equal((await Order.findById(legacy._id)).returns[0].autoApproved, true);
  await settle();
  const ev = eventsOf("ORDER_RETURN_APPROVED", o._id);
  assert.equal(ev[0].p.autoApproved, true);
  const buyerNote = await Notification.findOne({ userId: buyer.user._id, event: "ORDER_RETURN_APPROVED", "data.orderId": o._id }).lean();
  assert.match(buyerNote.body, /approved automatically/);
  const staff = await Notification.findOne({ tenantId: S.tenant._id, event: "ORDER_RETURN_APPROVED", "data.orderId": o._id, "audience.type": "staff" }).lean();
  assert.equal(staff.title, "Return auto-approved");
  assert.equal((await runJob("returns-sla")).result.autoApproved, 0);
  // a seller approving by hand is not "auto"
  let m = await deliveredOrder();
  m = await lifecycle.requestReturn(m, { actorId: buyer.user._id, reason: "damaged" });
  const ok = await call("POST", `/orders/${m._id}/return/approve`, { token: T.admin, json: {} });
  assert.equal(ok.status, 200);
  assert.equal((await Order.findById(m._id)).returns.at(-1).autoApproved, false);
  await settle();
  assert.equal(await Notification.countDocuments({ tenantId: S.tenant._id, event: "ORDER_RETURN_APPROVED", "data.orderId": m._id, "audience.type": "staff" }), 0, "no staff notice for manual approvals");
});

await step("returns.decideWithinHours: store override changes decideBy; reminder before the deadline (once)", async () => {
  await setSetting("returns.decideWithinHours", 12, S.tenant._id);
  let o = await deliveredOrder();
  o = await lifecycle.requestReturn(o, { actorId: buyer.user._id, reason: "damaged" });
  const ret = o.returns.at(-1);
  assert.ok(Math.abs(new Date(ret.decideBy) - new Date(ret.requestedAt) - 12 * HOUR) < 1000, "store override");
  await Settings.deleteOne({ scope: "tenant", tenantId: S.tenant._id, key: "returns.decideWithinHours" });
  invalidateSettingCache();
  await Order.updateOne({ _id: o._id, "returns._id": ret._id }, { $set: { "returns.$.decideBy": new Date(Date.now() + HOUR) } });
  await runJob("returns-sla");
  await runJob("returns-sla");
  await settle();
  const w = eventsOf("SELLER_DEADLINE_SOON", o._id);
  assert.equal(w.length, 1);
  assert.equal(w[0].p.kind, "return_decision");
  assert.equal(String(w[0].p.returnId), String(ret._id));
  assert.equal((await Order.findById(o._id)).status, "return_requested", "not approved before the deadline");
  const v = await call("GET", `/orders/${o._id}`, { token: T.admin });
  assert.equal(v.data.sla.returnDecideDueSoon, true);
  assert.equal(v.data.sla.returnDecideOverdue, false);
});

await step("returns-sla: refund still not done after refundDueBy -> one admin alert; completed refunds are not alerted", async () => {
  let o = await deliveredOrder(S, 1, { paymentMethod: "upi" });
  o = await lifecycle.requestReturn(o, { actorId: buyer.user._id, reason: "damaged" });
  o = await lifecycle.approveReturn(o, { actorId: admin._id });
  o = await lifecycle.receiveReturn(o, { actorId: admin._id });
  await settle();
  const ret = o.returns.at(-1);
  assert.ok(ret.refundDueBy);
  assert.ok(Math.abs(new Date(ret.refundDueBy) - new Date(ret.receivedAt) - 48 * HOUR) < 1000);
  await Order.updateOne(
    { _id: o._id },
    { $set: { "returns.$[r].refundDueBy": new Date(Date.now() - 60000), "refunds.$[f].status": "failed" } },
    { arrayFilters: [{ "r._id": ret._id }, { "f.key": ret.refundKey }] }
  );
  let ok = await deliveredOrder(S, 1, { paymentMethod: "upi" });
  ok = await lifecycle.requestReturn(ok, { actorId: buyer.user._id, reason: "damaged" });
  ok = await lifecycle.approveReturn(ok, { actorId: admin._id });
  ok = await lifecycle.receiveReturn(ok, { actorId: admin._id });
  await settle();
  const okRet = ok.returns.at(-1);
  await Order.updateOne({ _id: ok._id, "returns._id": okRet._id }, { $set: { "returns.$.refundDueBy": new Date(Date.now() - 60000) } });
  const job = await runJob("returns-sla");
  assert.equal(job.result.refundAlerts, 1, JSON.stringify(job.result));
  assert.equal((await runJob("returns-sla")).result.refundAlerts, 0, "once");
  await settle();
  const ev = eventsOf("REFUND_OVERDUE", o._id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].p.refundStatus, "failed");
  assert.ok(await Notification.exists({ event: "REFUND_OVERDUE", "audience.roleSlug": "super_admin", "data.orderId": o._id }));
  assert.equal(eventsOf("REFUND_OVERDUE", ok._id).length, 0);
});

/* ================================================================ scorecard numbers */
await step("scorecard: seller-caused cancels, late shipments, returns, auto-approvals counted for a store", async () => {
  const X = await makeStore({ stock: 100, price: 100 });
  await Product.updateOne({ _id: X.product._id }, { $set: { easyReturn: true } });
  // a) seller cancel
  const a = await confirmed(X);
  await lifecycle.cancelOrder(a, admin._id, "Out of stock", { cancelledBy: "seller", cancelCause: "seller", reasonCode: "seller_cancel" });
  // b) buyer cancel
  const b = await placeOrder(X, 1);
  await lifecycle.cancelOrder(b, buyer.user._id, "Changed my mind", { cancelledBy: "buyer", cancelCause: "buyer", reasonCode: "buyer_request" });
  // c) ship timeout
  const c = await confirmed(X);
  await backdate(c._id, { createdHoursAgo: 80, statusHoursAgo: { confirmed: 79 } });
  await runJob("order-sla");
  assert.equal((await Order.findById(c._id)).cancelReason, "ship_timeout");
  // d) shipped late (confirmed 100h before shipping)
  const d = await deliveredOrder(X);
  await backdate(d._id, { createdHoursAgo: 120, statusHoursAgo: { confirmed: 110, processing: 60, ready_to_ship: 20, shipped: 10, delivered: 5 } });
  // e) on time, 1 of 2 units returned (seller fault)
  let e = await deliveredOrder(X, 2);
  e = await lifecycle.requestReturn(e, { actorId: buyer.user._id, reason: "damaged", items: [{ itemId: e.items[0]._id, qty: 1 }] });
  e = await lifecycle.approveReturn(e, { actorId: admin._id });
  await lifecycle.receiveReturn(e, { actorId: admin._id });
  // f) return auto-approved
  let f = await deliveredOrder(X);
  f = await lifecycle.requestReturn(f, { actorId: buyer.user._id, reason: "changed_mind" });
  await lifecycle.approveReturn(f, { actorId: null, auto: true });

  const sc = await storeScorecard(X.tenant._id, { days: 30 });
  assert.equal(sc.orders, 6);
  assert.equal(sc.cancellations.total, 3);
  assert.equal(sc.cancellations.sellerCaused, 2, "seller cancel + ship timeout");
  assert.equal(sc.cancellations.buyer, 1);
  assert.equal(sc.cancellations.shipTimeouts, 1);
  assert.equal(sc.shipments.shipped, 3);
  assert.equal(sc.shipments.late, 1);
  assert.equal(sc.metrics.cancelRate.count, 2);
  assert.equal(sc.metrics.cancelRate.base, 6);
  assert.equal(sc.metrics.cancelRate.percent, 33.33);
  assert.equal(sc.metrics.cancelRate.status, "bad");
  assert.equal(sc.metrics.lateShipRate.count, 2, "late shipment + ship timeout");
  assert.equal(sc.metrics.lateShipRate.base, 4);
  assert.equal(sc.metrics.lateShipRate.percent, 50);
  assert.equal(sc.unitsDelivered, 4);
  assert.equal(sc.unitsReturned, 1);
  assert.equal(sc.metrics.returnRate.percent, 25);
  assert.equal(sc.metrics.returnRate.sellerFaultCount, 1);
  assert.equal(sc.returns.autoApproved, 1);
  assert.equal(sc.returns.requests, 2);
  assert.equal(sc.metrics.disputeRate.count, 0);
  assert.equal(sc.metrics.disputeRate.status, "good");
  assert.equal(sc.overall, "bad");
  assert.ok(sc.avgShipHours >= 0);
  assert.ok(sc.avgConfirmHours != null);
  // thresholds come from settings
  await setSetting("scorecard.maxCancelRate", 50);
  const sc2 = await storeScorecard(X.tenant._id, { days: 90 });
  assert.equal(sc2.metrics.cancelRate.threshold, 50);
  assert.equal(sc2.metrics.cancelRate.status, "good", "33% < 75% of 50%");
  await setSetting("scorecard.maxCancelRate", 40);
  assert.equal((await storeScorecard(X.tenant._id, { days: 30 })).metrics.cancelRate.status, "warning", "33% > 75% of 40%");
});

await settle(300);
server.close();
setPushSender(null);
await mongoose.disconnect();
console.log(`\nphase6Sla: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
