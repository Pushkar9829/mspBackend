/**
 * Phase 4 (p4-payouts): seller ledger + Razorpay Route payouts.
 *  online order lines + held Route transfer, gateway fee allocation over a multi-store payment,
 *  TCS / TDS lines, finality job, partial refund -> transfer reversal + ledger, refund after release ->
 *  debit netted from the next payout, cancel -> full reversal, COD courier vs seller rider, credit order
 *  debits + online repayment (verify + webhook), subscription netting, manual mode pending_manual ->
 *  mark-paid, minimum amount, holds, direct transfer failure -> re-credit, linked account creation +
 *  status webhooks / sync job, idempotency of every step, permissions.
 *
 * Throwaway local replica set only (the database is dropped); Razorpay is faked:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p4p?replicaSet=rs0" node src/tests/phase4Payouts.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";

if (!/127\.0\.0\.1:27027\/msp_test_p4p(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p4p database");
  process.exit(2);
}

const { setup, teardown, makeStore, makeBuyer } = await import("./commerceFixtures.js");
const { requestId } = await import("../middleware/requestId.js");
const { notFound, errorHandler } = await import("../middleware/error.js");
const { signAccessToken } = await import("../utils/tokens.js");
const { bus } = await import("../utils/events.js");
const { ensureSystemRoles } = await import("../seeds/index.js");
const { default: v1 } = await import("../routes/v1.js");
const { User } = await import("../modules/users/user.model.js");
const { Role } = await import("../modules/rbac/role.model.js");
const { Tenant } = await import("../modules/tenants/tenant.model.js");
const { Settings } = await import("../modules/settings/settings.model.js");
const { invalidateSettingCache } = await import("../modules/settings/service.js");
const { setRazorpayClient, hmac } = await import("../modules/checkout/razorpayApi.js");
const { processRazorpayEvent } = await import("../modules/checkout/razorpay.js");
const { addItem, getOrCreateCart, quoteCart } = await import("../modules/cart/service.js");
const { checkout } = await import("../modules/checkout/service.js");
const lifecycle = await import("../modules/orders/lifecycle.js");
const { Order } = await import("../modules/orders/order.model.js");
const ledgerSvc = await import("../modules/ledger/service.js");
const { LedgerEntry } = await import("../modules/ledger/ledger.model.js");
const { SellerLedgerEntry, Payout } = await import("../modules/payouts/models.js");
const payoutLedger = await import("../modules/payouts/ledger.js");
const payouts = await import("../modules/payouts/service.js");
const { taxSettings, withholdingFor } = await import("../modules/payouts/tax.js");
const { encryptSecret } = await import("../modules/sellerApplications/crypto.js");
const { TenantSubscription } = await import("../modules/billing/subscription.model.js");
const { SubscriptionInvoice } = await import("../modules/billing/invoice.model.js");
const { runJob } = await import("../jobs/index.js");
const { PERMISSIONS, TENANT_ADMIN_PERMISSIONS, isPlatformOnlyPermission } = await import("../config/constants.js");

await setup(); // connects + drops the test database
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));

/* ---------------------------------------------------------------- fake Razorpay */
let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq += 1)}`;
const fake = {
  orders: [],
  refunds: [],
  payments: new Map(),
  transfers: new Map(),
  transferCalls: 0,
  reversals: [],
  releases: [],
  direct: [],
  accounts: [],
  stakeholders: [],
  products: [],
  productUpdates: [],
  productStatus: new Map(), // accountId -> activation_status
  defaultProductStatus: "under_review",
};
function makeTransfer({ account, amount, notes, on_hold, source = "" }) {
  const t = { id: `trf_${uid()}`, entity: "transfer", source, recipient: account, amount, amount_reversed: 0, on_hold: Boolean(on_hold), notes: notes || {}, status: "processed", fees: 0, tax: 0 };
  fake.transfers.set(t.id, t);
  return t;
}
setRazorpayClient({
  createOrder: async ({ amount, receipt, notes }) => {
    const row = { id: `order_${uid()}`, amount, receipt, notes };
    fake.orders.push(row);
    return row;
  },
  createRefund: async (paymentId, { amount, notes }) => {
    const row = { id: `rfnd_${uid()}`, payment_id: paymentId, amount, notes, status: "processed" };
    fake.refunds.push(row);
    return row;
  },
  listRefunds: async (paymentId) => ({ items: fake.refunds.filter((r) => r.payment_id === paymentId) }),
  fetchPayment: async (id) => fake.payments.get(id) || { id, status: "captured", currency: "INR" },
  capturePayment: async (id, amount) => ({ ...(fake.payments.get(id) || { id, amount }), status: "captured" }),
  createLinkedAccount: async (body) => {
    const row = { id: `acc_${uid()}`, ...body };
    fake.accounts.push(row);
    return row;
  },
  createStakeholder: async (accountId, body) => {
    const row = { id: `sth_${uid()}`, accountId, ...body };
    fake.stakeholders.push(row);
    return row;
  },
  requestRouteProduct: async (accountId) => {
    const row = { id: `acc_prd_${uid()}`, accountId, activation_status: "requested", requirements: [] };
    fake.products.push(row);
    return row;
  },
  updateRouteProduct: async (accountId, productId, body) => {
    fake.productUpdates.push({ accountId, productId, body });
    return { id: productId, activation_status: fake.productStatus.get(accountId) || fake.defaultProductStatus, requirements: [] };
  },
  fetchRouteProduct: async (accountId, productId) => {
    const status = fake.productStatus.get(accountId) || fake.defaultProductStatus;
    return { id: productId, activation_status: status, requirements: status === "needs_clarification" ? [{ field_reference: "settlements.ifsc_code", reason_code: "field_missing" }] : [] };
  },
  createPaymentTransfers: async (paymentId, transfers) => {
    fake.transferCalls += 1;
    return { entity: "collection", items: transfers.map((t) => makeTransfer({ ...t, source: paymentId })) };
  },
  fetchPaymentTransfers: async (paymentId) => ({ items: [...fake.transfers.values()].filter((t) => t.source === paymentId) }),
  updateTransfer: async (id, body) => {
    const t = fake.transfers.get(id);
    if (!t) throw new Error("no such transfer");
    t.on_hold = Boolean(body.on_hold);
    fake.releases.push(id);
    return t;
  },
  reverseTransfer: async (id, body) => {
    const t = fake.transfers.get(id);
    if (!t) throw new Error("no such transfer");
    if (t.amount_reversed + body.amount > t.amount) throw new Error("reversal exceeds transfer");
    t.amount_reversed += body.amount;
    const row = { id: `rvrsl_${uid()}`, transfer_id: id, amount: body.amount, notes: body.notes };
    fake.reversals.push(row);
    return row;
  },
  createDirectTransfer: async (body) => {
    const t = makeTransfer({ ...body, on_hold: false });
    fake.direct.push(t);
    return t;
  },
  fetchTransfer: async (id) => fake.transfers.get(id) || null,
});
env.razorpayKeyId = "rzp_test_p4p";
env.razorpayKeySecret = "p4p_test_secret";

/* ---------------------------------------------------------------- app + helpers */
const app = express();
app.use(requestId);
app.use(express.json());
app.use("/api/v1", v1);
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, { token, json, headers = {} } = {}) {
  const h = { ...headers };
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
for (const e of ["PAYOUT_PAID", "PAYOUT_FAILED", "LINKED_ACCOUNT_ACTIVATED", "LINKED_ACCOUNT_NEEDS_CLARIFICATION", "PAYOUTS_HELD", "SUBSCRIPTION_PAYMENT_RECEIVED"]) {
  bus.on(e, (p) => events.push({ e, p }));
}
const eventsOf = (e, tenantId) => events.filter((x) => x.e === e && (!tenantId || String(x.p.tenantId) === String(tenantId)));
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;
const P = (rupees) => Math.round(Number(rupees) * 100);

async function setSetting(key, value) {
  await Settings.updateOne({ scope: "platform", tenantId: null, key }, { $set: { value } }, { upsert: true });
  invalidateSettingCache();
}

const roles = await ensureSystemRoles();
await setSetting("payouts.startDate", "2020-01-01");
await setSetting("payouts.mode", "route");
await setSetting("payouts.minAmount", 100);
await setSetting("payouts.holdDaysAfterDelivery", 7);
await setSetting("platform.feeEnabled", true);
await setSetting("platform.feeAmount", 20);
await setSetting("platform.feeBasis", "per_seller_order");

async function mkUser(name, email, role, { tenantId = null } = {}) {
  return User.create({ name, email, passwordHash: "x", roleId: role._id, tenantId, status: "active", emailVerified: true });
}
const tokenFor = async (user) => {
  const fresh = await User.findById(user._id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};
const platformAdmin = await mkUser("Platform", "pa@p4p.test", roles.super_admin);
const T = { platform: await tokenFor(platformAdmin) };

async function activeStore(opts = {}) {
  const store = await makeStore({ stock: 100, price: 500, ...opts });
  await Tenant.updateOne({ _id: store.tenant._id }, { $set: { "payout.razorpayAccountId": `acc_${uid()}`, "payout.status": "activated", "payout.activatedAt": new Date() } });
  store._id = store.tenant._id;
  return store;
}

async function placeOrders(buyer, lines, { paymentMethod = "upi" } = {}) {
  for (const [store, qty] of lines) await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty });
  const quote = await quoteCart(await getOrCreateCart(buyer.user._id), buyer.user._id, buyer.address);
  return checkout({
    expectedGrandTotal: quote.grandTotal,
    user: buyer.user,
    addressId: buyer.address._id,
    paymentMethod,
    poNumber: paymentMethod === "purchase_order" ? "PO-1" : undefined,
    idempotencyKey: `key-${uid()}`,
  });
}

async function payOnline(placed, { fee = 0, tax = 0 } = {}) {
  const rz = placed.razorpay;
  const pid = `pay_${uid()}`;
  fake.payments.set(pid, { id: pid, order_id: rz.orderId, amount: rz.amount, status: "captured", currency: "INR", fee, tax });
  await processRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: rz.orderId, amount: rz.amount } } } });
  return pid;
}

async function deliver(order, { tracking = "" } = {}) {
  let o = await Order.findById(order._id);
  if (o.status === "pending") o = await lifecycle.confirmOrder(o, null);
  o = await lifecycle.advanceOrder(o, "processing", {});
  o = await lifecycle.advanceOrder(o, "ready_to_ship", tracking ? { trackingNumber: tracking, carrier: "TestCourier" } : {});
  o = await lifecycle.advanceOrder(o, "shipped", {});
  o = await lifecycle.advanceOrder(o, "delivered", {});
  await Order.updateOne({ _id: o._id }, { $set: { "items.$[].easyReturn": true } });
  return Order.findById(o._id);
}

/** Pretend delivery happened `days` ago and run the finality step. */
async function makeFinal(order, days = 30) {
  await Order.updateOne({ _id: order._id }, { $set: { deliveredAt: new Date(Date.now() - days * DAY) } });
  return payoutLedger.releaseFinalOrders();
}

const entriesOf = (orderId) => SellerLedgerEntry.find({ orderId }).sort({ createdAt: 1, _id: 1 }).lean();
const sumOf = (rows, kinds = null) => rows.filter((r) => !kinds || kinds.includes(r.kind)).reduce((s, r) => s + r.amountPaise, 0);
const byKind = (rows, kind) => rows.filter((r) => r.kind === kind);

/* ================================================================ A: online order + Route */
const A = await activeStore();
const buyer = await makeBuyer();
let A1;
let A1net;
let A1fee = 236;

await step("online order: sale / fees / gateway fee / TCS / TDS lines, all held", async () => {
  const placed = await placeOrders(buyer, [[A, 2]]);
  assert.ok(placed.razorpay?.orderId, "razorpay order created");
  await payOnline(placed, { fee: A1fee, tax: 36 });
  A1 = await Order.findById(placed.orders[0]._id);
  assert.equal(A1.paymentStatus, "paid");
  assert.ok(A1.payout.recordedAt, "recordedAt set");
  assert.equal(A1.payout.basis, "online");
  const rows = await entriesOf(A1._id);
  const tax = withholdingFor(A1, await taxSettings());
  assert.equal(sumOf(byKind(rows, "sale")), P(A1.total));
  assert.equal(sumOf(byKind(rows, "platform_fee")), -P(A1.platformFee));
  assert.ok(A1.platformFee > 0, "platform fee charged");
  assert.equal(sumOf(byKind(rows, "partner_fee")), -P(A1.partnerFee) || 0);
  assert.equal(sumOf(byKind(rows, "gateway_fee")), -A1fee);
  assert.equal(sumOf(byKind(rows, "tcs")), -tax.tcs.total);
  assert.equal(sumOf(byKind(rows, "tds")), -tax.tds);
  assert.ok(tax.tcs.total > 0 && tax.tds > 0, "TCS + TDS withheld");
  assert.equal(tax.tcs.total, Math.round(tax.base * 0.005) || tax.tcs.cgst + tax.tcs.sgst);
  const tcsRow = byKind(rows, "tcs")[0];
  assert.equal(tcsRow.data.base, tax.base);
  assert.ok(rows.every((r) => r.availableAt === null), "every line held");
  A1net = sumOf(rows);
  assert.equal(A1net, P(A1.total) - P(A1.platformFee) - P(A1.partnerFee) - A1fee - tax.tcs.total - tax.tds);
});

await step("online order: held Route transfer for the order's net", async () => {
  A1 = await Order.findById(A1._id);
  assert.equal(A1.payout.transferStatus, "held");
  const t = fake.transfers.get(A1.payout.transferId);
  assert.ok(t, "transfer exists at Razorpay");
  assert.equal(t.amount, A1net);
  assert.equal(t.on_hold, true);
  assert.equal(t.recipient, (await Tenant.findById(A._id)).payout.razorpayAccountId);
  assert.equal(t.notes.order_id, String(A1._id));
  const sale = await SellerLedgerEntry.findOne({ key: `sale:${A1._id}` }).lean();
  assert.equal(sale.transferId, t.id, "transferId stored on the lines");
});

await step("idempotency: replayed payment webhook / verify adds no lines and no transfer", async () => {
  const before = await SellerLedgerEntry.countDocuments({ orderId: A1._id });
  const calls = fake.transferCalls;
  const pay = fake.payments.get(A1.razorpayPaymentId);
  await processRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: { id: pay.id, order_id: pay.order_id, amount: pay.amount } } } });
  await payoutLedger.recordOnlinePayment(pay.id, pay);
  await payoutLedger.recordMissing();
  assert.equal(await SellerLedgerEntry.countDocuments({ orderId: A1._id }), before);
  assert.equal(fake.transferCalls, calls);
});

let A1refundDebit = 0;
await step("partial refund (return) before finality: refund + TCS/TDS reversal lines (held) and partial transfer reversal", async () => {
  const beforeDelivery = await SellerLedgerEntry.countDocuments({ orderId: A1._id });
  A1 = await deliver(A1);
  assert.ok(A1.deliveredAt);
  assert.equal(await SellerLedgerEntry.countDocuments({ orderId: A1._id }), beforeDelivery, "delivery adds nothing for online orders");
  const item = A1.items[0];
  let o = await lifecycle.requestReturn(A1, { actorId: buyer.user._id, reason: "changed_mind", items: [{ itemId: item._id, qty: 1 }] });
  o = await lifecycle.approveReturn(o, { actorId: null });
  o = await lifecycle.receiveReturn(o, { actorId: null });
  await tick(400);
  o = await Order.findById(A1._id);
  const ret = o.returns[0];
  const key = `${o._id}:return:${ret._id}`;
  const refund = o.refunds.find((r) => r.key === key);
  assert.ok(refund, "refund queued");
  assert.equal(refund.status, "processed");
  const rows = (await entriesOf(o._id)).filter((r) => r.refundRef === key);
  const refundRow = rows.find((r) => r.kind === "refund");
  assert.equal(refundRow.amountPaise, -P(refund.amount));
  assert.ok(rows.find((r) => r.kind === "tcs_reversal")?.amountPaise > 0, "TCS reversed");
  assert.ok(rows.find((r) => r.kind === "tds_reversal")?.amountPaise > 0, "TDS reversed");
  assert.ok(!rows.some((r) => r.kind === "platform_fee"), "buyer-choice return keeps the platform fee");
  assert.ok(rows.every((r) => r.availableAt === null), "refund lines held (order not final)");
  A1refundDebit = -sumOf(rows);
  const rev = fake.reversals.filter((r) => r.transfer_id === o.payout.transferId);
  assert.equal(rev.length, 1, "one reversal");
  assert.equal(rev[0].amount, A1refundDebit, "reversal = refund's net seller debit");
  assert.equal(o.payout.reversedPaise, A1refundDebit);
  // Idempotent: re-recording the same refund row adds nothing.
  assert.equal(await payoutLedger.recordRefundEntries(o, refund), 0);
});

await step("finality job: held lines released once the return window + hold passed; repeated run is a no-op", async () => {
  assert.equal(await payoutLedger.releaseFinalOrders(), 0, "not final yet");
  const released = await makeFinal(A1);
  assert.equal(released, 1);
  const o = await Order.findById(A1._id);
  assert.ok(o.payout.finalAt);
  assert.ok((await entriesOf(o._id)).every((r) => r.availableAt), "all lines available");
  assert.equal(await payoutLedger.releaseFinalOrders(), 0);
});

let A1payout;
await step("payout run (Route): releases the held transfer, payout line, PAYOUT_PAID; second run skipped", async () => {
  const res = await payouts.runPayoutForTenant(A._id);
  A1payout = res.payout;
  assert.equal(A1payout.status, "paid");
  assert.equal(A1payout.mode, "route");
  assert.equal(A1payout.amountPaise, A1net - A1refundDebit);
  const o = await Order.findById(A1._id);
  assert.equal(o.payout.transferStatus, "released");
  assert.ok(fake.releases.includes(o.payout.transferId));
  assert.equal(fake.transfers.get(o.payout.transferId).on_hold, false);
  const line = await SellerLedgerEntry.findOne({ key: `payout:${A1payout._id}` }).lean();
  assert.equal(line.amountPaise, -A1payout.amountPaise);
  assert.equal(A1payout.deductions.refunds, P(o.refunds[0].amount));
  assert.equal(A1payout.deductions.fees, P(o.platformFee) + P(o.partnerFee) + A1fee);
  const bal = await payoutLedger.balanceFor(A._id);
  assert.equal(bal.availablePaise, 0);
  await tick();
  assert.equal(eventsOf("PAYOUT_PAID", A._id).length, 1);
  const again = await payouts.runPayoutForTenant(A._id);
  assert.ok(again.skipped, "nothing left to pay");
  assert.ok(/^PO\/\d{4}\/\d{6}$/.test(A1payout.number), A1payout.number);
});

let carriedDebit = 0;
await step("refund after release: debit available at once, no reversal, negative balance carried", async () => {
  const reversalsBefore = fake.reversals.length;
  await lifecycle.refundOrder(await Order.findById(A1._id), null, "Goodwill refund");
  await tick(400);
  const o = await Order.findById(A1._id);
  const row = o.refunds.find((r) => r.key === `${o._id}:refund`);
  assert.equal(row.status, "processed");
  const lines = (await entriesOf(o._id)).filter((r) => r.refundRef === row.key);
  assert.ok(lines.length >= 2 && lines.every((r) => r.availableAt), "available immediately (order final)");
  assert.equal(fake.reversals.length, reversalsBefore, "released transfer is not reversed");
  carriedDebit = -sumOf(lines);
  const bal = await payoutLedger.balanceFor(A._id);
  assert.equal(bal.availablePaise, -carriedDebit);
  const res = await payouts.runPayoutForTenant(A._id);
  assert.equal(res.skipped, "negative_balance");
});

await step("next payout nets the carried debit: partial reversal of the new held transfer, then release", async () => {
  const placed = await placeOrders(buyer, [[A, 3]]);
  await payOnline(placed, { fee: 300 });
  let o = await Order.findById(placed.orders[0]._id);
  const net = sumOf(await entriesOf(o._id));
  o = await deliver(o);
  await makeFinal(o);
  const res = await payouts.runPayoutForTenant(A._id);
  assert.equal(res.payout.status, "paid");
  assert.equal(res.payout.amountPaise, net - carriedDebit);
  o = await Order.findById(o._id);
  const rev = fake.reversals.filter((r) => r.transfer_id === o.payout.transferId);
  assert.equal(rev.length, 1);
  assert.equal(rev[0].amount, carriedDebit, "carried debit reversed from the new transfer");
  assert.equal(o.payout.transferStatus, "released");
  const row = res.payout.transfers.find((t) => String(t.orderId) === String(o._id));
  assert.equal(row.reversedPaise, carriedDebit);
  assert.equal(row.releasedPaise, net - carriedDebit);
  assert.equal((await payoutLedger.balanceFor(A._id)).availablePaise, 0);
});

await step("cancel of a paid online order: lines net to zero, transfer fully reversed", async () => {
  const placed = await placeOrders(buyer, [[A, 1]]);
  await payOnline(placed, { fee: 100 });
  let o = await Order.findById(placed.orders[0]._id);
  assert.equal(o.payout.transferStatus, "held");
  await lifecycle.cancelOrder(o, null, "Changed my mind", { cancelledBy: "buyer" });
  await tick(400);
  o = await Order.findById(o._id);
  const rows = await entriesOf(o._id);
  assert.equal(sumOf(rows), -100, "only the gateway fee stays with the seller");
  assert.ok(byKind(rows, "platform_fee").some((r) => r.amountPaise > 0), "platform fee reversed on full cancel");
  const t = fake.transfers.get(o.payout.transferId);
  assert.equal(t.amount_reversed, t.amount, "transfer fully reversed");
  assert.equal(o.payout.transferStatus, "reversed");
  assert.equal(o.payout.reversedPaise, t.amount_reversed);
});

/* ================================================================ gateway fee allocation */
await step("gateway fee allocated pro-rata over the seller orders of one payment (sums exactly)", async () => {
  const G = await activeStore({ price: 300 });
  const H = await activeStore({ price: 700 });
  const b = await makeBuyer();
  const placed = await placeOrders(b, [[G, 1], [H, 2]]);
  assert.equal(placed.orders.length, 2);
  await payOnline(placed, { fee: 1001 });
  const orders = await Order.find({ _id: { $in: placed.orders.map((o) => o._id) } });
  const fees = [];
  for (const o of orders) fees.push(-sumOf(byKind(await entriesOf(o._id), "gateway_fee")));
  assert.equal(fees[0] + fees[1], 1001);
  const totalPaise = orders.reduce((s, o) => s + P(o.total), 0);
  const first = [...orders].sort((x, y) => String(x._id).localeCompare(String(y._id)))[0];
  const firstFee = -sumOf(byKind(await entriesOf(first._id), "gateway_fee"));
  assert.equal(firstFee, Math.round((1001 * P(first.total)) / totalPaise));
  for (const o of orders) assert.equal(o.payout.transferStatus, "held");
});

/* ================================================================ B: COD */
const B = await activeStore({ price: 400 });
let Bcourier;
let Bseller;
await step("COD via courier: sale + deductions on delivery, held; nothing collected by the seller", async () => {
  const placed = await placeOrders(buyer, [[B, 2]], { paymentMethod: "cod" });
  let o = placed.orders[0];
  assert.equal(await SellerLedgerEntry.countDocuments({ orderId: o._id }), 0, "nothing before delivery");
  o = await deliver(o, { tracking: "AWB-COD-1" });
  assert.equal(o.codCollection.by, "courier");
  const rows = await entriesOf(o._id);
  assert.equal(sumOf(byKind(rows, "sale")), P(o.total));
  assert.equal(byKind(rows, "collected_by_seller").length, 0);
  assert.ok(rows.every((r) => r.availableAt === null));
  assert.equal(o.payout.basis, "cod_courier");
  Bcourier = o;
});

await step("COD by the seller's rider: collected_by_seller(−total) held with the sale (no temporary 'owed')", async () => {
  const placed = await placeOrders(buyer, [[B, 1]], { paymentMethod: "cod" });
  const o = await deliver(placed.orders[0]);
  assert.equal(o.codCollection.by, "seller");
  const rows = await entriesOf(o._id);
  const col = byKind(rows, "collected_by_seller");
  assert.equal(col.length, 1);
  assert.equal(col[0].amountPaise, -P(o.total));
  assert.equal(col[0].availableAt, null, "held until the order is final");
  assert.ok(byKind(rows, "sale")[0].availableAt === null, "sale held");
  assert.equal(o.payout.basis, "cod_seller");
  Bseller = o;
  const bal = await payoutLedger.balanceFor(B._id);
  assert.equal(bal.availablePaise, 0, "nothing owed before the order is final");
});

let Bpayout;
await step("Route payout of COD money = direct transfer; transfer.failed webhook re-credits the balance (idempotent)", async () => {
  await makeFinal(Bcourier);
  await makeFinal(Bseller);
  const expected = sumOf(await SellerLedgerEntry.find({ tenantId: B._id }).lean());
  const res = await payouts.runPayoutForTenant(B._id);
  Bpayout = res.payout;
  assert.equal(Bpayout.status, "paid");
  assert.equal(Bpayout.amountPaise, expected);
  assert.equal(Bpayout.deductions.cod, P(Bseller.total));
  const direct = Bpayout.transfers.find((t) => t.type === "direct");
  assert.equal(direct.releasedPaise, expected);
  assert.equal(fake.direct.at(-1).amount, expected);
  const ev = { event: "transfer.failed", payload: { transfer: { entity: { id: direct.transferId, status: "failed", error: { description: "Account frozen" } } } } };
  assert.equal((await processRazorpayEvent(ev)).payouts, true);
  await processRazorpayEvent(ev);
  const p = await Payout.findById(Bpayout._id).lean();
  assert.equal(p.status, "failed");
  assert.ok(p.recreditedAt);
  const recredit = await SellerLedgerEntry.find({ key: `payout_failed:${direct.transferId}` }).lean();
  assert.equal(recredit.length, 1);
  assert.equal(recredit[0].amountPaise, expected);
  assert.equal((await payoutLedger.balanceFor(B._id)).availablePaise, expected);
  await tick();
  assert.equal(eventsOf("PAYOUT_FAILED", B._id).length, 1);
  const r = await call("POST", `/admin/payouts/${Bpayout._id}/cancel`, { token: T.platform, json: { reason: "Testing cancel" } });
  assert.equal(r.status, 409, "money moved: cannot cancel");
  const next = await payouts.runPayoutForTenant(B._id);
  assert.equal(next.payout.status, "paid", "re-credited amount paid in the next run");
  assert.equal(next.payout.amountPaise, expected);
});

/* ================================================================ C: credit / PO */
const C = await activeStore({ price: 250 });
const creditBuyer = await makeBuyer();
await ledgerSvc.ensureOpeningBalance(creditBuyer.user._id, C.tenant._id, 50000);
await User.updateOne({ _id: creditBuyer.user._id }, { $set: { status: "active", emailVerified: true } });
const creditToken = await tokenFor({ _id: creditBuyer.user._id });
let Corder;
await step("credit order: fee + TCS/TDS debits on delivery, available at once, no sale", async () => {
  const placed = await placeOrders(creditBuyer, [[C, 4]], { paymentMethod: "credit_terms" });
  Corder = await deliver(placed.orders[0]);
  const rows = await entriesOf(Corder._id);
  assert.equal(byKind(rows, "sale").length, 0);
  assert.ok(byKind(rows, "platform_fee").length === 1 && byKind(rows, "tcs").length === 1 && byKind(rows, "tds").length === 1);
  assert.ok(rows.every((r) => r.availableAt), "available immediately");
  assert.ok(sumOf(rows) < 0);
  assert.equal(Corder.payout.basis, "credit");
});

await step("credit repayment online (order + verify): buyer ledger payment + seller credit_repayment; verify replay is idempotent", async () => {
  const acct = ledgerSvc.presentLedger(await ledgerSvc.findLedger(creditBuyer.user._id, C.tenant._id));
  assert.ok(acct.outstandingPaise > 0);
  const tooMuch = await call("POST", `/ledger/me/${C.tenant._id}/pay`, { token: creditToken, json: { amount: acct.outstandingPaise / 100 + 1 } });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.data.code || tooMuch.data.error?.code, "AMOUNT_EXCEEDS_DUE");
  const r = await call("POST", `/ledger/me/${C.tenant._id}/pay`, { token: creditToken, json: { amount: 300 } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.amount, 30000);
  const pid = `pay_${uid()}`;
  fake.payments.set(pid, { id: pid, order_id: r.data.orderId, amount: 30000, status: "captured", currency: "INR" });
  const body = { razorpayOrderId: r.data.orderId, razorpayPaymentId: pid, razorpaySignature: hmac(env.razorpayKeySecret, `${r.data.orderId}|${pid}`) };
  const bad = await call("POST", `/ledger/me/${C.tenant._id}/pay/verify`, { token: creditToken, json: { ...body, razorpaySignature: "x" } });
  assert.equal(bad.status, 400);
  const v = await call("POST", `/ledger/me/${C.tenant._id}/pay/verify`, { token: creditToken, json: body });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  assert.equal(v.data.already, false);
  assert.equal(v.data.account.outstandingPaise, acct.outstandingPaise - 30000);
  const again = await call("POST", `/ledger/me/${C.tenant._id}/pay/verify`, { token: creditToken, json: body });
  assert.equal(again.data.already, true);
  // Webhook for the same payment is also a no-op.
  await processRazorpayEvent({ event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: r.data.orderId, amount: 30000 } } } });
  assert.equal(await LedgerEntry.countDocuments({ tenantId: C.tenant._id, kind: "payment", reference: pid }), 1);
  const lines = await SellerLedgerEntry.find({ tenantId: C.tenant._id, kind: "credit_repayment" }).lean();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].amountPaise, 30000);
  assert.ok(lines[0].availableAt);
});

await step("credit repayment settled by webhook only (replay safe); seller-recorded offline payment adds no seller line", async () => {
  const r = await call("POST", `/ledger/me/${C.tenant._id}/pay`, { token: creditToken, json: { amount: 150 } });
  const pid = `pay_${uid()}`;
  fake.payments.set(pid, { id: pid, order_id: r.data.orderId, amount: 15000, status: "captured", currency: "INR" });
  const ev = { event: "payment.captured", payload: { payment: { entity: { id: pid, order_id: r.data.orderId, amount: 15000 } } } };
  assert.equal((await processRazorpayEvent(ev)).payouts, true);
  await processRazorpayEvent(ev);
  assert.equal(await SellerLedgerEntry.countDocuments({ tenantId: C.tenant._id, kind: "credit_repayment" }), 2);
  const before = await SellerLedgerEntry.countDocuments({ tenantId: C.tenant._id });
  await ledgerSvc.recordPayment({ tenantId: C.tenant._id, user: { _id: platformAdmin._id } }, creditBuyer.user._id, { amount: 100, reference: "CASH-1" });
  assert.equal(await SellerLedgerEntry.countDocuments({ tenantId: C.tenant._id }), before);
});

/* ================================================================ D: manual mode, min, holds, netting */
const D = await makeStore({ stock: 100, price: 600 });
await Tenant.updateOne(
  { _id: D.tenant._id },
  { $set: { "kyc.bank": { holderName: "D Foods Pvt Ltd", accountLast4: "4321", accountNumberEnc: encryptSecret("987654321"), ifsc: "ICIC0000123" } } }
);
const dAdmin = await mkUser("D Admin", "dadmin@p4p.test", roles.tenant_admin, { tenantId: D.tenant._id });
T.dAdmin = await tokenFor(dAdmin);
let Dexpected = 0;
await step("manual mode: minimum amount respected (balance carried)", async () => {
  await setSetting("payouts.mode", "manual");
  const placed = await placeOrders(buyer, [[D, 2]], { paymentMethod: "cod" });
  const o = await deliver(placed.orders[0], { tracking: "AWB-D-1" });
  await makeFinal(o);
  Dexpected = sumOf(await entriesOf(o._id));
  await setSetting("payouts.minAmount", Dexpected / 100 + 1);
  const res = await payouts.runPayoutForTenant(D.tenant._id);
  assert.equal(res.skipped, "below_minimum");
  assert.equal(res.availablePaise, Dexpected);
  assert.equal(await Payout.countDocuments({ tenantId: D.tenant._id }), 0);
  await setSetting("payouts.minAmount", 100);
});

await step("holds: hold blocks runs (409 / job skip) + PAYOUTS_HELD; release-hold allows them again", async () => {
  const h = await call("POST", `/admin/payouts/sellers/${D.tenant._id}/hold`, { token: T.platform, json: { reason: "KYC re-check" } });
  assert.equal(h.status, 200, JSON.stringify(h.data));
  assert.equal(h.data.hold.reason, "KYC re-check");
  assert.equal(h.data.nextPayoutAt, null);
  const run = await call("POST", `/admin/payouts/sellers/${D.tenant._id}/run`, { token: T.platform });
  assert.equal(run.status, 409);
  assert.equal((await payouts.runPayoutForTenant(D.tenant._id)).skipped, "on_hold");
  await tick();
  assert.equal(eventsOf("PAYOUTS_HELD", D.tenant._id).length, 1);
  const rel = await call("POST", `/admin/payouts/sellers/${D.tenant._id}/release-hold`, { token: T.platform });
  assert.equal(rel.status, 200);
  assert.equal(rel.data.hold, null);
});

let Dpayout;
await step("subscription netting: overdue invoice paid from the payout (method netting) + subscription_netting line", async () => {
  const sub = await TenantSubscription.create({
    tenantId: D.tenant._id,
    status: "past_due",
    planSnapshot: { code: "basic", name: "Basic", interval: "monthly", priceInr: 100 },
    currentPeriodStart: new Date(Date.now() - 40 * DAY),
    currentPeriodEnd: new Date(Date.now() - 10 * DAY),
    pastDueSince: new Date(Date.now() - 10 * DAY),
  });
  const inv = await SubscriptionInvoice.create({
    tenantId: D.tenant._id,
    subscriptionId: sub._id,
    number: `MSPB/2627/${uid().slice(-6)}`,
    kind: "renewal",
    planSnapshot: { code: "basic", name: "Basic", interval: "monthly", priceInr: 100 },
    period: { start: new Date(Date.now() - 10 * DAY), end: new Date(Date.now() + 20 * DAY) },
    lines: [{ description: "Basic monthly", amount: 100 }],
    subtotal: 100,
    total: 118,
    status: "issued",
    issuedAt: new Date(Date.now() - 12 * DAY),
    dueAt: new Date(Date.now() - 10 * DAY),
  });
  const r = await call("POST", `/admin/payouts/sellers/${D.tenant._id}/run`, { token: T.platform });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  Dpayout = r.data.payout;
  assert.equal(Dpayout.status, "pending_manual");
  assert.equal(Dpayout.mode, "manual");
  assert.equal(Dpayout.amountPaise, Dexpected - 11800);
  assert.equal(Dpayout.deductions.subscription, 11800);
  const paidInv = await SubscriptionInvoice.findById(inv._id).lean();
  assert.equal(paidInv.status, "paid");
  assert.equal(paidInv.payment.method, "netting");
  const net = await SellerLedgerEntry.find({ key: `netting:${inv._id}` }).lean();
  assert.equal(net.length, 1);
  assert.equal(net[0].amountPaise, -11800);
  assert.equal(String(net[0].payoutId), String(Dpayout.id));
  assert.equal((await TenantSubscription.findById(sub._id)).status, "active", "subscription active again");
  assert.equal(await SellerLedgerEntry.countDocuments({ key: `payout:${Dpayout.id}` }), 0, "no payout line before money leaves");
});

await step("manual payout: seller sees it pending; admin mark-paid with UTR -> paid + payout line; replay rejected", async () => {
  const me = await call("GET", "/payouts/me", { token: T.dAdmin });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.balance.pendingPayoutPaise, Dpayout.amountPaise);
  assert.equal(me.data.balance.availablePaise, 0);
  const bank = await call("POST", `/admin/payouts/${Dpayout.id}/bank/reveal`, { token: T.platform, json: {} });
  assert.equal(bank.status, 200, JSON.stringify(bank.data));
  assert.equal(bank.data.accountNumber, "987654321");
  assert.equal(bank.data.ifsc, "ICIC0000123");
  assert.equal((await call("POST", `/admin/payouts/${Dpayout.id}/bank/reveal`, { token: T.dAdmin, json: {} })).status, 403);
  const bad = await call("POST", `/admin/payouts/${Dpayout.id}/mark-paid`, { token: T.platform, json: {} });
  assert.equal(bad.status, 400);
  const r = await call("POST", `/admin/payouts/${Dpayout.id}/mark-paid`, { token: T.platform, json: { reference: "UTR123456" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, "paid");
  assert.equal(r.data.reference, "UTR123456");
  assert.ok(r.data.entries.some((e) => e.kind === "payout" && e.amountPaise === -Dpayout.amountPaise));
  const again = await call("POST", `/admin/payouts/${Dpayout.id}/mark-paid`, { token: T.platform, json: { reference: "UTR123456" } });
  assert.equal(again.status, 409);
  await tick();
  assert.equal(eventsOf("PAYOUT_PAID", D.tenant._id).length, 1);
  const list = await call("GET", "/payouts/me/payouts", { token: T.dAdmin });
  assert.equal(list.data.data.length, 1);
  const one = await call("GET", `/payouts/me/payouts/${Dpayout.id}`, { token: T.dAdmin });
  assert.equal(one.status, 200);
  assert.ok(one.data.entries.length >= 5);
});

await step("manual mode: no bank account on file -> no payout (balance carries forward)", async () => {
  const G = await makeStore({ price: 100 });
  const adj = await call("POST", `/admin/payouts/sellers/${G.tenant._id}/adjustment`, { token: T.platform, json: { amount: 500, reason: "Opening balance" } });
  assert.equal(adj.status, 201, JSON.stringify(adj.data));
  const run = await call("POST", `/admin/payouts/sellers/${G.tenant._id}/run`, { token: T.platform, json: {} });
  assert.equal(run.data.code, "NO_BANK_ACCOUNT", JSON.stringify(run.data));
  assert.equal(await Payout.countDocuments({ tenantId: G.tenant._id }), 0);
});

await step("manual pending payout can be cancelled: lines return to the balance", async () => {
  const adj = await call("POST", `/admin/payouts/sellers/${D.tenant._id}/adjustment`, { token: T.platform, json: { amount: 250, reason: "Promo compensation" } });
  assert.equal(adj.status, 201, JSON.stringify(adj.data));
  assert.equal(adj.data.amountPaise, 25000);
  const r = await call("POST", `/admin/payouts/sellers/${D.tenant._id}/run`, { token: T.platform });
  assert.equal(r.data.payout.status, "pending_manual");
  assert.equal(r.data.payout.amountPaise, 25000);
  const c = await call("POST", `/admin/payouts/${r.data.payout.id}/cancel`, { token: T.platform, json: { reason: "Pay with next cycle" } });
  assert.equal(c.status, 200);
  assert.equal(c.data.status, "cancelled");
  assert.equal((await payoutLedger.balanceFor(D.tenant._id)).availablePaise, 25000);
  const neg = await call("POST", `/admin/payouts/sellers/${D.tenant._id}/adjustment`, { token: T.platform, json: { amount: -300, reason: "Penalty" } });
  assert.equal(neg.status, 201);
  assert.equal((await payoutLedger.balanceFor(D.tenant._id)).availablePaise, -5000);
  await setSetting("payouts.mode", "route");
});

/* ================================================================ E: linked accounts */
const E = await makeStore({ price: 100 });
await Tenant.updateOne(
  { _id: E.tenant._id },
  {
    $set: {
      businessProfile: { legalName: "E Traders LLP", gstin: "", email: "e@p4p.test", phone: "9876543210" },
      "kyc.pan": "AABCE1234F",
      "kyc.legalName": "E Traders LLP",
      "kyc.businessType": "llp",
      "kyc.registeredAddress": { addressLine1: "1 Main Rd", addressLine2: "", city: "Pune", state: "Maharashtra", postalCode: "411001", country: "IN" },
      "kyc.bank": { holderName: "E Traders LLP", accountLast4: "6789", accountNumberEnc: encryptSecret("123456789"), ifsc: "HDFC0001234" },
    },
  }
);
await step("linked account: create (account -> stakeholder -> product -> bank) from KYC; refresh does not re-create", async () => {
  fake.defaultProductStatus = "under_review";
  const r = await call("POST", `/admin/payouts/sellers/${E.tenant._id}/linked-account`, { token: T.platform });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.account.status, "under_review");
  assert.equal(fake.accounts.length, 1);
  assert.equal(fake.accounts[0].type, "route");
  assert.equal(fake.accounts[0].legal_info.pan, "AABCE1234F");
  assert.equal(fake.stakeholders.length, 1);
  assert.equal(fake.products.length, 1);
  assert.equal(fake.productUpdates[0].body.settlements.account_number, "123456789");
  assert.equal(fake.productUpdates[0].body.settlements.ifsc_code, "HDFC0001234");
  const again = await call("POST", `/admin/payouts/sellers/${E.tenant._id}/linked-account`, { token: T.platform });
  assert.equal(again.status, 200);
  assert.equal(fake.accounts.length, 1, "no second account");
  assert.equal(fake.productUpdates.length, 1);
});

await step("linked account webhooks: needs_clarification (event + requirements), activation by the sync job (event once)", async () => {
  const acc = (await Tenant.findById(E.tenant._id)).payout.razorpayAccountId;
  fake.productStatus.set(acc, "needs_clarification");
  const res = await processRazorpayEvent({ event: "product.route.needs_clarification", account_id: acc, payload: {} });
  assert.equal(res.payouts, true);
  let t = await Tenant.findById(E.tenant._id);
  assert.equal(t.payout.status, "needs_clarification");
  assert.ok(t.payout.requirements.length > 0);
  await tick();
  assert.equal(eventsOf("LINKED_ACCOUNT_NEEDS_CLARIFICATION", E.tenant._id).length, 1);
  fake.productStatus.set(acc, "activated");
  const job = await runJob("linked-accounts-sync");
  assert.equal(job.ran, true);
  t = await Tenant.findById(E.tenant._id);
  assert.equal(t.payout.status, "activated");
  assert.ok(t.payout.activatedAt);
  await processRazorpayEvent({ event: "product.route.activated", account_id: acc, payload: {} });
  await tick();
  assert.equal(eventsOf("LINKED_ACCOUNT_ACTIVATED", E.tenant._id).length, 1, "activated event once");
});

await step("linked account: incomplete KYC -> failed with lastError (no Razorpay call)", async () => {
  const F = await makeStore({ price: 100 });
  const r = await call("POST", `/admin/payouts/sellers/${F.tenant._id}/linked-account`, { token: T.platform });
  assert.equal(r.status, 200);
  assert.equal(r.data.account.status, "failed");
  assert.match(r.data.account.lastError, /KYC/);
  assert.equal(fake.accounts.length, 1);
});

/* ================================================================ permissions + read APIs */
await step("permissions: payouts.view tenant (tenant_admin default), payouts.manage platform-only", async () => {
  assert.ok(PERMISSIONS.includes("payouts.view") && PERMISSIONS.includes("payouts.manage"));
  assert.ok(isPlatformOnlyPermission("payouts.manage") && !isPlatformOnlyPermission("payouts.view"));
  assert.ok(TENANT_ADMIN_PERMISSIONS.includes("payouts.view") && !TENANT_ADMIN_PERMISSIONS.includes("payouts.manage"));
  const ta = await Role.findOne({ slug: "tenant_admin", isSystem: true }).lean();
  assert.ok(ta.permissions.includes("payouts.view"));
  const aAdmin = await mkUser("A Admin", "aadmin@p4p.test", roles.tenant_admin, { tenantId: A._id });
  T.aAdmin = await tokenFor(aAdmin);
  const clerkRole = await Role.create({ name: "Clerk", slug: "clerk", tenantId: A._id, permissions: ["orders.view"], scope: "tenant" });
  const clerk = await mkUser("Clerk", "clerk@p4p.test", clerkRole, { tenantId: A._id });
  T.clerk = await tokenFor(clerk);
  const buyerUser = await User.findById(buyer.user._id);
  buyerUser.status = "active";
  buyerUser.emailVerified = true;
  await buyerUser.save();
  T.buyer = await tokenFor(buyerUser);

  const me = await call("GET", "/payouts/me", { token: T.aAdmin });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.ok("availablePaise" in me.data.balance && "heldPaise" in me.data.balance && "owedPaise" in me.data.balance);
  assert.equal(me.data.account.status, "activated");
  assert.ok(me.data.nextPayoutAt);
  assert.equal((await call("GET", "/payouts/me", { token: T.clerk })).status, 403);
  assert.equal((await call("GET", "/payouts/me", { token: T.buyer })).status, 403);
  assert.equal((await call("GET", "/payouts/me")).status, 401);
  assert.equal((await call("GET", "/admin/payouts", { token: T.aAdmin })).status, 403);
  assert.equal((await call("POST", `/admin/payouts/sellers/${A._id}/run`, { token: T.aAdmin })).status, 403);
  const other = await call("GET", `/payouts/me/payouts/${Dpayout.id}`, { token: T.aAdmin });
  assert.equal(other.status, 404, "other store's payout hidden");
  const asAdmin = await call("GET", "/payouts/me", { token: T.platform, headers: { "X-Tenant-Id": String(A._id) } });
  assert.equal(asAdmin.status, 200, "platform admin with X-Tenant-Id");
});

await step("read APIs: seller ledger filters/paging, admin lists (payouts, sellers, seller detail)", async () => {
  const led = await call("GET", "/payouts/me/ledger?kind=sale,refund&limit=2", { token: T.aAdmin });
  assert.equal(led.status, 200);
  assert.equal(led.data.data.length, 2);
  assert.ok(led.data.meta.total >= 3);
  assert.ok(led.data.data.every((e) => ["sale", "refund"].includes(e.kind)));
  const byOrder = await call("GET", `/payouts/me/ledger?orderId=${A1._id}`, { token: T.aAdmin });
  assert.ok(byOrder.data.data.every((e) => String(e.orderId) === String(A1._id)));
  assert.equal((await call("GET", "/payouts/me/ledger?kind=bogus", { token: T.aAdmin })).status, 400);
  const list = await call("GET", "/admin/payouts?status=paid", { token: T.platform });
  assert.equal(list.status, 200);
  assert.ok(list.data.data.length >= 3 && list.data.data.every((p) => p.status === "paid"));
  assert.ok(list.data.counts.paid >= 3);
  const sellers = await call("GET", "/admin/payouts/sellers?hasBalance=true", { token: T.platform });
  assert.equal(sellers.status, 200);
  const dRow = sellers.data.data.find((s) => String(s.tenantId) === String(D.tenant._id));
  assert.equal(dRow.balance.netAvailablePaise, -5000);
  assert.equal(dRow.balance.owedPaise, 5000);
  const detail = await call("GET", `/admin/payouts/sellers/${A._id}`, { token: T.platform });
  assert.equal(detail.status, 200);
  assert.ok(detail.data.ledger.data.length > 0 && detail.data.payouts.length >= 2);
  const one = await call("GET", `/admin/payouts/${A1payout._id}`, { token: T.platform });
  assert.equal(one.status, 200);
  assert.ok(one.data.history.length >= 1 && one.data.entries.length > 0);
});

await step("job `payouts`: sweep re-records an order that missed recording; run is idempotent", async () => {
  const placed = await placeOrders(buyer, [[B, 1]], { paymentMethod: "cod" });
  const o = await deliver(placed.orders[0], { tracking: "AWB-SWEEP" });
  await SellerLedgerEntry.deleteMany({ orderId: o._id });
  await Order.updateOne({ _id: o._id }, { $set: { "payout.recordedAt": null, "payout.basis": null } });
  const res = await runJob("payouts");
  assert.equal(res.ran, true);
  assert.ok(res.result.swept.offline >= 1, JSON.stringify(res.result));
  assert.ok((await entriesOf(o._id)).length >= 3);
  const count = await SellerLedgerEntry.countDocuments({});
  const again = await runJob("payouts");
  assert.equal(again.ran, true);
  assert.equal(await SellerLedgerEntry.countDocuments({}), count, "second run writes nothing new");
});

server.close();
console.log(`\nphase4Payouts: ${passed} passed, ${failed} failed`);
await teardown();
process.exit(process.exitCode || 0);
