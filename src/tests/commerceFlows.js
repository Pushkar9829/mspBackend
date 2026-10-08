/**
 * Order lifecycle / payments / coupons / ledger tests.
 *   MONGODB_URI=mongodb://127.0.0.1:27027/msp_test_a?replicaSet=rs0 node src/tests/commerceFlows.js
 */
import mongoose from "mongoose";
import {
  setup,
  teardown,
  makeStore,
  makeBuyer,
  stockRow,
  assertCountersMatchReservations,
  check,
  finish,
  fulfilled,
  rejected,
} from "./commerceFixtures.js";
import { addItem, getOrCreateCart, quoteCart, applyCartCoupon } from "../modules/cart/service.js";
import { checkout, redeemCoupon } from "../modules/checkout/service.js";
import {
  confirmOrder,
  cancelOrder,
  refundOrder,
  advanceOrder,
  requestReturn,
  approveReturn,
  receiveReturn,
} from "../modules/orders/lifecycle.js";
import { markRazorpayPaid, resumeRazorpayPayment, processRazorpayEvent } from "../modules/checkout/razorpay.js";
import { processPendingRefunds } from "../modules/checkout/refunds.js";
import { Order } from "../modules/orders/order.model.js";
import { Coupon } from "../modules/pricing/coupon.model.js";
import { CouponUsage, CouponCustomerUse } from "../modules/pricing/couponUsage.model.js";
import { Invoice, CreditNote } from "../modules/invoices/invoice.model.js";
import { financialYear } from "../modules/invoices/service.js";
import { renderTaxDocumentPdf } from "../modules/invoices/pdf.js";
import * as ledger from "../modules/ledger/service.js";
import { runJob } from "../jobs/index.js";
import { bus } from "../utils/events.js";
import { withTransaction } from "../utils/transaction.js";

const seen = [];
for (const name of ["ORDER_CREATED", "ORDER_CANCELLED", "ORDER_REFUNDED", "ORDER_PAID", "ORDER_RETURN_REQUESTED", "ORDER_TIMEOUT"]) {
  bus.on(name, (payload) => seen.push({ name, orderId: String(payload?.order?._id || "") }));
}
const sawEvent = (name, orderId) => seen.some((e) => e.name === name && e.orderId === String(orderId));
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function place(buyer, { paymentMethod = "cod", key } = {}) {
  const cart = await getOrCreateCart(buyer.user._id);
  const quote = await quoteCart(cart, buyer.user._id, buyer.address);
  return checkout({
    user: buyer.user,
    addressId: buyer.address._id,
    paymentMethod,
    poNumber: paymentMethod === "purchase_order" ? "PO-1" : undefined,
    idempotencyKey: key || `key-${Math.random()}`,
    expectedGrandTotal: quote.grandTotal,
  });
}

async function testDoubleCancel() {
  console.log("\n# double cancel");
  const store = await makeStore({ stock: 6 });
  const coupon = await Coupon.create({ tenantId: store.tenant._id, code: "TENOFF", name: "10%", type: "percent", value: 10, perCustomerLimit: 1 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 2 });
  await applyCartCoupon(buyer.user._id, null, "TENOFF");
  const { orders } = await place(buyer);
  const order = orders[0];
  check(order.couponDiscount > 0, `coupon applied (${order.couponDiscount})`);
  await settle();
  check(sawEvent("ORDER_CREATED", order._id), "ORDER_CREATED emitted with { order }");
  const results = await Promise.allSettled([cancelOrder(order, null, "a"), cancelOrder(order, null, "b"), cancelOrder(order, null, "c")]);
  check(fulfilled(results).length === 1, `one cancel wins (${fulfilled(results).length})`);
  check(rejected(results).every((r) => r.reason.code === "INVALID_STATE"), "others get INVALID_STATE");
  const row = await assertCountersMatchReservations(store, "after cancel");
  check(row.available === 6 && row.reserved === 0, `stock released exactly once (available ${row.available})`);
  const c = await Coupon.findById(coupon._id);
  const use = await CouponCustomerUse.findOne({ couponId: coupon._id });
  check(c.redemptionCount === 0 && use.count === 0, `coupon released once (redemptions ${c.redemptionCount}, customer ${use.count})`);
  await settle();
  check(sawEvent("ORDER_CANCELLED", order._id), "ORDER_CANCELLED emitted");
}

async function testRefundAndReturn() {
  console.log("\n# double refund (no restock) and return flow (restock on receipt)");
  const store = await makeStore({ stock: 10 });
  const buyer = await makeBuyer({ state: "Karnataka" });
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 2 });
  const { orders } = await place(buyer);
  let order = await confirmOrder(orders[0], null);
  check(order.status === "confirmed", "confirmed");
  let row = await assertCountersMatchReservations(store, "confirmed");
  check(row.committed === 2, "committed 2");
  const invoice = await Invoice.findOne({ orderId: order._id });
  check(invoice && invoice.supplyType === "inter" && invoice.financialYear === financialYear(new Date()), `invoice issued in transaction (${invoice?.invoiceNumber}, IGST)`);
  for (const step of ["processing", "ready_to_ship", "shipped", "delivered"]) order = await advanceOrder(order, step, {});
  row = await assertCountersMatchReservations(store, "delivered");
  check(row.available === 8 && row.committed === 0, `shipped units consumed (available ${row.available})`);
  const refunds = await Promise.allSettled([refundOrder(order, null, "x"), refundOrder(order, null, "y")]);
  check(fulfilled(refunds).length === 1, "one refund wins");
  row = await stockRow(store);
  check(row.available === 8, "refund without return does not restock");
  check((await CreditNote.countDocuments({ orderId: order._id })) === 1, "one credit note issued");
  await settle();
  check(sawEvent("ORDER_REFUNDED", order._id), "ORDER_REFUNDED emitted");

  // Return flow
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 3 });
  const placed = await place(buyer);
  let o2 = await confirmOrder(placed.orders[0], null);
  for (const step of ["processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered"]) o2 = await advanceOrder(o2, step, {});
  o2 = await requestReturn(o2, { actorId: buyer.user._id, reason: "Damaged box" });
  const dup = await Promise.allSettled([requestReturn(o2, { actorId: buyer.user._id, reason: "again" })]);
  check(rejected(dup).length === 1, "second return request rejected");
  o2 = await approveReturn(o2, { actorId: null });
  row = await stockRow(store);
  check(row.available === 5, `no restock on approval (available ${row.available})`);
  const lineId = String(o2.items[0]._id);
  const recv = await Promise.allSettled([
    receiveReturn(o2, { actorId: null, damaged: { [lineId]: 1 } }),
    receiveReturn(o2, { actorId: null, damaged: { [lineId]: 1 } }),
  ]);
  check(fulfilled(recv).length === 1, "return received once");
  row = await stockRow(store);
  check(row.available === 7 && row.damaged === 1, `restocked 2 sellable + 1 damaged (available ${row.available}, damaged ${row.damaged})`);
  const done = await refundOrder(o2, null, "returned");
  check(done.status === "refunded", "refund after return");
  await settle();
  check(sawEvent("ORDER_RETURN_REQUESTED", o2._id), "ORDER_RETURN_REQUESTED emitted");
}

async function testCouponLimits() {
  console.log("\n# coupon per-customer limit under concurrency + multi-seller scoping");
  const a = await makeStore({ stock: 20 });
  const b = await makeStore({ stock: 20 });
  const coupon = await Coupon.create({ tenantId: a.tenant._id, code: "AONLY", name: "A", type: "fixed", value: 50, perCustomerLimit: 1, maxRedemptions: 2 });
  const buyer = await makeBuyer();
  const tries = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      withTransaction((session) =>
        redeemCoupon({ group: { couponId: coupon._id, tenantId: a.tenant._id }, order: { _id: new mongoose.Types.ObjectId() }, userId: buyer.user._id, session })
      )
    )
  );
  check(fulfilled(tries).length === 1, `per-customer limit holds under concurrency (${fulfilled(tries).length} succeeded)`);
  const others = await Promise.all(Array.from({ length: 4 }, () => makeBuyer()));
  const global = await Promise.allSettled(
    others.map((o) =>
      withTransaction((session) =>
        redeemCoupon({ group: { couponId: coupon._id, tenantId: a.tenant._id }, order: { _id: new mongoose.Types.ObjectId() }, userId: o.user._id, session })
      )
    )
  );
  const total = (await Coupon.findById(coupon._id)).redemptionCount;
  check(fulfilled(global).length === 1 && total === 2, `maxRedemptions holds (${total})`);

  // Scoping: store A's coupon must not discount store B's lines.
  const c2 = await Coupon.create({ tenantId: a.tenant._id, code: "AHALF", name: "A50", type: "percent", value: 50, perCustomerLimit: 1 });
  const shopper = await makeBuyer();
  await addItem(shopper.user._id, null, { variantId: String(a.variant._id), qty: 1 });
  await addItem(shopper.user._id, null, { variantId: String(b.variant._id), qty: 1 });
  const quote = await applyCartCoupon(shopper.user._id, null, "AHALF");
  const ga = quote.groups.find((g) => String(g.tenantId) === String(a.tenant._id));
  const gb = quote.groups.find((g) => String(g.tenantId) === String(b.tenant._id));
  check(ga.couponDiscount === 50 && gb.couponDiscount === 0, `discount only on store A (A ${ga.couponDiscount}, B ${gb.couponDiscount})`);
  const { orders } = await place(shopper);
  const orderA = orders.find((o) => String(o.tenantId) === String(a.tenant._id));
  const usage = await CouponUsage.findOne({ couponId: c2._id });
  check(usage && String(usage.orderId) === String(orderA._id), "usage recorded on store A's order");
}

async function testPayments(fake) {
  console.log("\n# online payment: late payment after cancel, resume after sibling cancel");
  const a = await makeStore({ stock: 5 });
  const b = await makeStore({ stock: 5 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(a.variant._id), qty: 1 });
  const placed = await place(buyer, { paymentMethod: "upi" });
  const order = placed.orders[0];
  check(Boolean(placed.razorpay?.orderId) && order.paymentStatus === "pending", "razorpay order attached");
  await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });
  const runs = await Promise.allSettled([runJob("reservation-timeout"), runJob("reservation-timeout")]);
  check(rejected(runs).length === 0, "timeout job ran");
  let fresh = await Order.findById(order._id);
  check(fresh.status === "cancelled", "unpaid order cancelled by timeout");
  const row = await stockRow(a);
  check(row.available === 5 && row.reserved === 0, "stock released on timeout");
  await processRazorpayEvent({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_late", order_id: placed.razorpay.orderId, amount: placed.razorpay.amount } } },
  });
  await settle();
  await processPendingRefunds();
  // The refund started after commit may still be finishing; wait for its final write.
  for (let i = 0; i < 20; i += 1) {
    fresh = await Order.findById(order._id);
    if (fresh.paymentStatus === "refunded") break;
    await settle();
  }
  check(fresh.status === "cancelled", "late payment does not resurrect the order");
  check(fresh.refunds.length === 1 && fresh.refunds[0].status === "processed", `late payment refunded (${fresh.refunds[0]?.status})`);
  check(fresh.paymentStatus === "refunded", `payment status refunded (${fresh.paymentStatus})`);
  check(fake.refunds.filter((r) => r.payment_id === "pay_late").length === 1, "exactly one provider refund");

  // Two sellers, one cancelled → resume must charge only the remaining order.
  await addItem(buyer.user._id, null, { variantId: String(a.variant._id), qty: 1 });
  await addItem(buyer.user._id, null, { variantId: String(b.variant._id), qty: 1 });
  const two = await place(buyer, { paymentMethod: "card" });
  check(two.orders.length === 2, "two seller orders");
  await cancelOrder(two.orders[1], null, "seller cancelled");
  const resumed = await resumeRazorpayPayment({ user: buyer.user, orderId: two.orders[0]._id });
  check(resumed.razorpay.orderId !== two.razorpay.orderId, "new Razorpay order after payable set changed");
  check(resumed.razorpay.amount === Math.round(two.orders[0].total * 100), `amount covers only the open order (${resumed.razorpay.amount})`);
  // Pay the new one: confirms + ORDER_PAID; the stale one gets refunded if paid later.
  await markRazorpayPaid(resumed.razorpay.orderId, "pay_ok", resumed.razorpay.amount);
  fresh = await Order.findById(two.orders[0]._id);
  check(fresh.status === "confirmed" && fresh.paymentStatus === "paid", "webhook payment confirms the order");
  await settle();
  check(sawEvent("ORDER_PAID", fresh._id), "ORDER_PAID emitted");
  const dupPay = await markRazorpayPaid(resumed.razorpay.orderId, "pay_ok", resumed.razorpay.amount);
  check(dupPay.every((o) => o.status === "confirmed"), "duplicate webhook is a no-op");
  await markRazorpayPaid(two.razorpay.orderId, "pay_stale", two.razorpay.amount);
  await settle();
  await processPendingRefunds();
  check(fake.refunds.some((r) => r.payment_id === "pay_stale"), "payment on superseded Razorpay order refunded");

  // Paid then cancelled → refund
  await cancelOrder(fresh, null, "out of stock");
  await settle();
  await processPendingRefunds();
  const after = await Order.findById(fresh._id);
  check(after.refunds.some((r) => r.key.endsWith(":cancel") && r.status === "processed"), "cancel of paid order refunds via Razorpay");
}

async function testLedger() {
  console.log("\n# credit terms ledger");
  const store = await makeStore({ stock: 10, price: 1000 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  const denied = await Promise.allSettled([place(buyer, { paymentMethod: "credit_terms" })]);
  check(rejected(denied)[0]?.reason?.code === "TERMS_NOT_ENABLED", "credit terms need the store's allowlist");
  await ledger.setBuyerTerms({ tenantId: store.tenant._id, user: { _id: null } }, buyer.user._id, { creditEnabled: true, creditLimit: 1500 });
  const { orders } = await place(buyer, { paymentMethod: "credit_terms" });
  let account = await ledger.findLedger(buyer.user._id, store.tenant._id);
  check(account.balancePaise === 150000 - Math.round(orders[0].total * 100), `debited in paise (${account.balancePaise})`);
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  const over = await Promise.allSettled([place(buyer, { paymentMethod: "credit_terms" })]);
  check(rejected(over)[0]?.reason?.code === "INSUFFICIENT_CREDIT", "credit floor enforced");
  const row = await stockRow(store);
  check(row.reserved === 2, "failed checkout left the cart hold, created no order hold");
  await Promise.allSettled([cancelOrder(orders[0], null, "x"), cancelOrder(orders[0], null, "y")]);
  account = await ledger.findLedger(buyer.user._id, store.tenant._id);
  check(account.balancePaise === 150000, `reversed exactly once (${account.balancePaise})`);
  const opening = await Promise.allSettled([
    ledger.ensureOpeningBalance(buyer.user._id, store.tenant._id, 500),
    ledger.ensureOpeningBalance(buyer.user._id, store.tenant._id, 500),
  ]);
  account = await ledger.findLedger(buyer.user._id, store.tenant._id);
  check(account.balancePaise === 150000, `opening credit not granted twice / not after terms (${account.balancePaise}, ${fulfilled(opening).length})`);
  const pdf = renderTaxDocumentPdf((await Invoice.findOne()).toObject(), { title: "TAX INVOICE" });
  check(pdf.subarray(0, 5).toString() === "%PDF-" && pdf.includes(Buffer.from("%%EOF")), `invoice PDF renders (${pdf.length} bytes)`);
  check(financialYear(new Date("2026-03-31T19:00:00Z")) === "2026-27", "FY uses IST (31 Mar 19:00 UTC = 1 Apr IST)");
}

async function main() {
  const fake = await setup();
  await testDoubleCancel();
  await testRefundAndReturn();
  await testCouponLimits();
  await testPayments(fake);
  await testLedger();
  finish("commerceFlows");
  await teardown();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await teardown().catch(() => {});
});
