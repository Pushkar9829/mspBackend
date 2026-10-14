/**
 * Phase 1 order fixes: proof of delivery + COD collection, two-step RTO, item-level returns with
 * partial refunds / credit notes, offline (COD) refund payouts, ledger refund records, seller
 * confirm timeout, cancel -> credit note, GST document numbers <= 16 chars.
 *
 * Throwaway local DB only:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p1orders?replicaSet=rs0" node src/tests/orderPhase1.js
 */
import { setup, teardown, makeStore, makeBuyer, stockRow, check, finish, fulfilled } from "./commerceFixtures.js";
import { addItem, getOrCreateCart, quoteCart } from "../modules/cart/service.js";
import { checkout } from "../modules/checkout/service.js";
import { confirmOrder, cancelOrder, advanceOrder, approveReturn, receiveReturn, returnToOrigin, refundOrder } from "../modules/orders/lifecycle.js";
import * as orders from "../modules/orders/service.js";
import { Order } from "../modules/orders/order.model.js";
import { Invoice, CreditNote } from "../modules/invoices/invoice.model.js";
import { formatDocNumber, MAX_DOC_NUMBER_LENGTH } from "../modules/invoices/service.js";
import { classifyReason, ALLOWED_TRANSITIONS } from "../modules/orders/statuses.js";
import { normalizeDestination, valueReturn, lineValue } from "../modules/orders/returns.js";
import { mapDelhiveryStatus } from "../modules/shipping/delhivery.js";
import { mapShiprocketStatus } from "../modules/shipping/shiprocket.js";
import { LedgerEntry } from "../modules/ledger/ledger.model.js";
import * as ledger from "../modules/ledger/service.js";
import { runJob } from "../jobs/index.js";
import { round2 } from "../modules/pricing/engine.js";
import { revenueMatch, revenueGroupFields, NON_REVENUE_STATUSES } from "../modules/reports/revenue.js";
import { processRazorpayEvent } from "../modules/checkout/razorpay.js";
import { categoryFor } from "../modules/notifications/preferences.js";
import { bus } from "../utils/events.js";

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

async function place(buyer, { paymentMethod = "cod" } = {}) {
  const cart = await getOrCreateCart(buyer.user._id);
  const quote = await quoteCart(cart, buyer.user._id, buyer.address);
  const { orders: placed } = await checkout({
    user: buyer.user,
    addressId: buyer.address._id,
    paymentMethod,
    poNumber: paymentMethod === "purchase_order" ? "PO-1" : undefined,
    idempotencyKey: `key-${Math.random()}`,
    expectedGrandTotal: quote.grandTotal,
  });
  return placed[0];
}

function staffReq(store, extra = {}) {
  return { user: { _id: store.tenant._id }, permissions: ["*"], tenantId: store.tenant._id, isPlatformAdmin: false, isBuyer: false, ...extra };
}
function buyerReq(buyer) {
  return { user: { _id: buyer.user._id }, permissions: ["orders.view", "orders.cancel", "orders.create"], isBuyer: true, isPlatformAdmin: false };
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    check(false, `${label} (expected ${code}, succeeded)`);
  } catch (err) {
    check(err.code === code, `${label} (${err.code}: ${err.message})`);
  }
}

async function delivered(store, buyer, qty, { paymentMethod = "cod" } = {}) {
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty });
  let o = await place(buyer, { paymentMethod });
  o = await confirmOrder(o, null);
  for (const step of ["processing", "ready_to_ship", "shipped", "delivered"]) o = await advanceOrder(o, step, {});
  await Order.updateOne({ _id: o._id }, { $set: { "items.$[].easyReturn": true } });
  return Order.findById(o._id);
}

function testPure() {
  console.log("\n# pure helpers");
  for (const [code, fy, seq, kind] of [
    ["ACME", "2026-27", 123, "invoice"],
    ["ACMEWHOLESALE", "2026-27", 999999, "invoice"],
    ["ACME", "2026-27", 1234567, "invoice"],
    ["ACME", "2026-27", 42, "credit_note"],
    ["ACME", "2026-27", 1234567, "credit_note"],
  ]) {
    const n = formatDocNumber(code, fy, seq, kind);
    check(n.length <= MAX_DOC_NUMBER_LENGTH, `doc number ${n} <= 16 chars`);
  }
  check(formatDocNumber("ACME", "2026-27", 123) === "ACME/2627/000123", "invoice format CODE/YYYY/SEQ");
  check(formatDocNumber("ACME", "2026-27", 12, "credit_note") === "ACME/2627/C00012", "credit note format CODE/YYYY/Cseq");
  check(classifyReason("damaged").sellerFault && classifyReason("Damaged or defective item").sellerFault, "damaged = seller fault");
  check(!classifyReason("changed_mind").sellerFault && !classifyReason("Ordered by mistake").sellerFault, "changed mind / mistake = buyer choice");
  check(classifyReason("Wrong item sent").sellerFault, "free-text 'wrong item' classified as seller fault");
  check(mapDelhiveryStatus("In Transit", "RT") === "rto_in_transit" && mapDelhiveryStatus("RTO", "DL") === "returned_to_origin", "Delhivery RT -> rto_in_transit, DL+RTO -> returned_to_origin");
  check(mapShiprocketStatus("RTO INITIATED", 9) === "rto_in_transit" && mapShiprocketStatus("RTO DELIVERED", 10) === "returned_to_origin", "Shiprocket 9 -> rto_in_transit, 10 -> returned_to_origin");
  check(ALLOWED_TRANSITIONS.rto_in_transit.includes("returned_to_origin") && ALLOWED_TRANSITIONS.shipped.includes("rto_in_transit"), "RTO transitions");
  check(normalizeDestination({ type: "upi", upiId: "buyer@okbank" }).upiId === "buyer@okbank", "UPI destination accepted");
  let bad = false;
  try {
    normalizeDestination({ type: "bank", accountNumber: "12", ifsc: "X", accountName: "A" });
  } catch (err) {
    bad = err.code === "VALIDATION_ERROR";
  }
  check(bad, "bad bank details rejected");
  // 4 units, 400 value, fees 40: 1 unit buyer-choice = 100, no fees; seller-fault rest = 300 + all fees.
  const order = {
    items: [{ _id: "a", qty: 4, unitPrice: 100, lineSubtotal: 400, couponShare: 0, taxRate: 18, taxableValue: 338.98, tax: 61.02 }],
    deliveryFee: 40,
    returns: [],
  };
  const one = valueReturn(order, [{ itemId: "a", qty: 1 }], { sellerFault: false });
  check(one.itemsAmount === 100 && one.feesAmount === 0, `buyer-choice return refunds item value only (${one.refundAmount})`);
  order.returns.push({ status: "received", sellerFault: false, itemsAmount: 100, feesAmount: 0, items: [{ itemId: "a", qty: 1, ...one.items[0] }] });
  order.items[0].returnedQty = 1;
  const rest = valueReturn(order, [{ itemId: "a", qty: 3 }], { sellerFault: true });
  check(rest.itemsAmount === 300 && rest.feesAmount === 30, `seller-fault return refunds proportional fees (${rest.itemsAmount} + ${rest.feesAmount})`);
  check(near(one.items[0].amount + rest.items[0].amount, lineValue(order, order.items[0]).amount), "line refunds add up to the line value");
}

async function testDocNumbersAndCancel() {
  console.log("\n# invoice number <= 16 chars, cancel after confirm -> credit note");
  const store = await makeStore({ stock: 10 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  const o = await confirmOrder(await place(buyer), null);
  const inv = await Invoice.findOne({ orderId: o._id });
  check(inv.invoiceNumber.length <= 16 && /^[A-Z0-9]{1,4}\/\d{4}\/\d{6}$/.test(inv.invoiceNumber), `invoice number ${inv.invoiceNumber}`);
  const cancelled = await orders.cancel(staffReq(store), String(o._id), "out of stock");
  check(cancelled.status === "cancelled" && cancelled.cancelledBy === "seller" && cancelled.cancelCause === "seller", "seller cancel recorded (by/cause)");
  const invAfter = await Invoice.findOne({ orderId: o._id });
  const cn = await CreditNote.findOne({ orderId: o._id });
  check(invAfter.status === "issued", "invoice is not voided");
  check(cn && near(cn.totals.grandTotal, o.total) && cn.creditNoteNumber.length <= 16, `full credit note issued (${cn?.creditNoteNumber})`);

  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  const p2 = await place(buyer);
  const byBuyer = await orders.cancel(buyerReq(buyer), String(p2._id), "");
  check(byBuyer.cancelledBy === "buyer" && byBuyer.cancelCause === "buyer" && byBuyer.cancelReason === "buyer_request", "buyer cancel recorded");
  check(!(await CreditNote.exists({ orderId: p2._id })), "no credit note for an order without an invoice");
}

async function testDeliveryProof() {
  console.log("\n# delivered only by the carrier webhook when a courier ships; COD collection recorded");
  process.env.DELHIVERY_WEBHOOK_SECRET = "test-secret";
  const store = await makeStore({ stock: 10 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  let o = await confirmOrder(await place(buyer), null);
  o = await advanceOrder(o, "processing", {});
  o = await advanceOrder(o, "ready_to_ship", {});
  o = await orders.updateStatus(staffReq(store), String(o._id), "shipped", "", { trackingNumber: "WB123", carrier: "Delhivery" });
  await expectCode(orders.updateStatus(staffReq(store), String(o._id), "delivered", "done"), "CARRIER_MANAGED", "seller cannot mark a courier order delivered");
  const actions = orders.allowedActions(staffReq(store), await Order.findById(o._id), { returnsEnabled: true, returnWindowDays: 7 });
  check(actions.markDelivered === false, "allowedActions.markDelivered false for courier order");
  const res = await orders.applyCarrierUpdate({ waybill: "WB123", status: "Delivered", statusType: "DL" });
  const fresh = await Order.findById(o._id);
  check(res.status === "delivered" && fresh.paymentStatus === "paid", "carrier webhook marks delivered + COD paid");
  check(fresh.codCollection?.by === "courier" && /delhivery/i.test(fresh.codCollection.carrier) && near(fresh.codCollection.amount, fresh.total), "COD collected by courier recorded");

  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  let s = await confirmOrder(await place(buyer), null);
  for (const step of ["processing", "ready_to_ship", "shipped"]) s = await advanceOrder(s, step, {});
  s = await orders.updateStatus(staffReq(store), String(s._id), "delivered", "handed over");
  check(s.status === "delivered" && s.codCollection?.by === "seller", "seller-delivered order: manual delivered allowed, COD collected by seller");
  delete process.env.DELHIVERY_WEBHOOK_SECRET;
}

async function testRto() {
  console.log("\n# RTO: in transit (no restock/refund) -> returned to origin (restock with damaged + credit note)");
  process.env.DELHIVERY_WEBHOOK_SECRET = "test-secret";
  const store = await makeStore({ stock: 10 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 3 });
  let o = await confirmOrder(await place(buyer), null);
  o = await advanceOrder(o, "processing", {});
  o = await advanceOrder(o, "ready_to_ship", {});
  o = await advanceOrder(o, "shipped", { trackingNumber: "WBRTO", carrier: "Delhivery" });
  let row = await stockRow(store);
  check(row.available === 7, `shipped consumed 3 (available ${row.available})`);
  const r1 = await orders.applyCarrierUpdate({ waybill: "WBRTO", status: "In Transit", statusType: "RT" });
  row = await stockRow(store);
  check(r1.status === "rto_in_transit" && row.available === 7, "first RTO scan -> rto_in_transit, nothing restocked");
  check(!(await CreditNote.exists({ orderId: o._id })), "no credit note while in transit");
  const lineId = String(o.items[0]._id);
  const back = await orders.updateStatus(staffReq(store), String(o._id), "returned_to_origin", "parcel back", { items: [{ itemId: lineId, damagedQty: 1 }] });
  row = await stockRow(store);
  check(back.status === "returned_to_origin" && row.available === 9 && row.damaged === 1, `seller marks RTO received: 2 restocked + 1 damaged (available ${row.available}, damaged ${row.damaged})`);
  check((await CreditNote.countDocuments({ orderId: o._id })) === 1, "credit note on RTO receipt");
  const again = await Promise.allSettled([orders.applyCarrierUpdate({ waybill: "WBRTO", status: "RTO", statusType: "DL" })]);
  row = await stockRow(store);
  check(fulfilled(again).length === 1 && row.available === 9, "late carrier RTO-delivered scan does not restock twice");
  delete process.env.DELHIVERY_WEBHOOK_SECRET;
}

async function testItemReturns() {
  console.log("\n# item-level returns: partial refund + partial credit note + COD payout");
  const store = await makeStore({ stock: 10 });
  const buyer = await makeBuyer();
  let o = await delivered(store, buyer, 4);
  const lineId = String(o.items[0]._id);
  const lineVal = lineValue(o, o.items[0]).amount;
  await expectCode(
    orders.requestReturn(buyerReq(buyer), String(o._id), { reason: "changed_mind", items: [{ itemId: lineId, qty: 5 }] }),
    "RETURN_QTY_EXCEEDED",
    "cannot return more than delivered"
  );
  o = await orders.requestReturn(buyerReq(buyer), String(o._id), { reason: "changed_mind", items: [{ itemId: lineId, qty: 1 }] });
  const r1 = o.returns[0];
  check(o.status === "return_requested" && r1.items[0].qty === 1 && r1.feesAmount === 0 && near(r1.refundAmount, lineVal / 4), `return of 1 of 4 units, item value only (${r1.refundAmount})`);
  await expectCode(orders.requestReturn(buyerReq(buyer), String(o._id), { reason: "damaged" }), "INVALID_STATE", "one active return at a time");
  o = await approveReturn(o, { actorId: null });
  const before = await stockRow(store);
  o = await receiveReturn(o, { actorId: null, damaged: {} });
  let row = await stockRow(store);
  check(o.status === "delivered" && o.items[0].returnedQty === 1, "partial return received: order back to delivered, returnedQty 1");
  check(row.available === before.available + 1, `only the returned unit restocked (available ${before.available} -> ${row.available})`);
  const [rev] = await Order.aggregate([{ $match: revenueMatch({ _id: o._id }) }, { $group: { _id: null, ...revenueGroupFields() } }]);
  const orderFees = round2((o.deliveryFee || 0) + (o.platformFee || 0) + (o.partnerFee || 0));
  check(
    rev && near(rev.gmv, o.total - r1.refundAmount) && near(rev.netSales, o.total - orderFees - r1.itemsAmount),
    `revenue nets out the received partial return (gmv ${rev?.gmv}, netSales ${rev?.netSales})`
  );
  const cn1 = await CreditNote.findOne({ orderId: o._id, returnId: r1._id });
  check(cn1 && cn1.scope === "partial" && near(cn1.totals.grandTotal, r1.refundAmount) && cn1.lines.every((l) => l.kind === "item"), "partial credit note covers just that unit");
  const payout = o.refunds.find((r) => r.returnId && String(r.returnId) === String(r1._id));
  check(payout && payout.method === "cod" && payout.status === "pending_payout" && near(payout.amount, r1.refundAmount), "COD refund recorded as pending_payout");
  await expectCode(orders.markRefundPaid(staffReq(store), String(o._id), payout.key, { reference: "UTR1" }), "FORBIDDEN", "seller cannot mark a payout paid");
  await expectCode(orders.markRefundPaid(staffReq(store, { isPlatformAdmin: true }), String(o._id), payout.key, { reference: "UTR1" }), "DESTINATION_REQUIRED", "payout needs a destination");
  await orders.setRefundDestination(buyerReq(buyer), String(o._id), payout.key, { type: "upi", upiId: "buyer@okbank" });
  const paid = await orders.markRefundPaid(staffReq(store, { isPlatformAdmin: true }), String(o._id), payout.key, { reference: "UTR1" });
  const paidRow = paid.refunds.find((r) => r.key === payout.key);
  check(paidRow.status === "processed" && paidRow.payoutReference === "UTR1", "platform marks payout paid with reference");

  // Remaining 3 units, seller fault: their value + all fees.
  o = await orders.requestReturn(buyerReq(buyer), String(o._id), { reason: "damaged", refundDestination: { type: "store_credit" } });
  const r2 = o.returns[1];
  const fees = round2((o.deliveryFee || 0) + (o.platformFee || 0) + (o.partnerFee || 0));
  check(r2.items[0].qty === 3 && near(r2.itemsAmount, lineVal - r1.itemsAmount) && near(r2.feesAmount, fees), `seller-fault return: rest of the line + fees (${r2.itemsAmount} + ${r2.feesAmount})`);
  o = await approveReturn(o, { actorId: null });
  o = await receiveReturn(o, { actorId: null, damaged: { [lineId]: 1 } });
  row = await stockRow(store);
  check(o.status === "returned" && o.items[0].returnedQty === 4, "all units back -> returned");
  check(row.damaged >= 1, "damaged unit booked to damaged stock");
  const sc = o.refunds.find((r) => String(r.returnId || "") === String(r2._id));
  check(sc && sc.status === "processed" && sc.destination.type === "store_credit", "store-credit refund settled at once");
  const totalRefunded = o.refunds.reduce((s, r) => s + r.amount, 0);
  check(near(totalRefunded, o.total), `refunds add up to the order total (${totalRefunded} / ${o.total})`);
  const closed = await refundOrder(o, null, "close");
  check(closed.status === "refunded" && near(closed.refunds.reduce((s, r) => s + r.amount, 0), o.total), "closing refund adds nothing extra");
}

async function testLedgerReturn() {
  console.log("\n# credit order partial return -> ledger credit + ledger_credit refund record");
  const store = await makeStore({ stock: 10 });
  const buyer = await makeBuyer();
  await ledger.ensureOpeningBalance(buyer.user._id, store.tenant._id, 100000);
  let o = await delivered(store, buyer, 2, { paymentMethod: "credit_terms" });
  const debit = o.ledgerDebit;
  o = await orders.requestReturn(buyerReq(buyer), String(o._id), { reason: "changed_mind", items: [{ itemId: String(o.items[0]._id), qty: 1 }] });
  o = await approveReturn(o, { actorId: null });
  o = await receiveReturn(o, { actorId: null });
  const rec = o.refunds.find((r) => r.method === "ledger_credit");
  check(rec && rec.status === "processed" && near(o.ledgerDebit, debit - rec.amount), `ledger_credit refund ${rec?.amount}; remaining debit ${o.ledgerDebit}`);
  check(Boolean(await LedgerEntry.exists({ orderId: o._id, type: "credit", reference: rec?.key })), "ledger credit entry written");
}

async function testPaymentFailedAndCategories() {
  console.log("\n# Razorpay payment.failed -> paymentStatus failed + explicit PAYMENT_FAILED; new events categorised; RTO not revenue");
  const store = await makeStore({ stock: 5 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  const o = await place(buyer);
  await Order.collection.updateOne({ _id: o._id }, { $set: { paymentMethod: "upi", paymentStatus: "pending", razorpayOrderId: "order_p1fail" } });
  const seen = [];
  const listener = (p) => seen.push(p);
  bus.on("PAYMENT_FAILED", listener);
  try {
    await processRazorpayEvent({ event: "payment.failed", payload: { payment: { entity: { id: "pay_p1fail", order_id: "order_p1fail", error_description: "declined" } } } });
  } finally {
    bus.off("PAYMENT_FAILED", listener);
  }
  const fresh = await Order.findById(o._id);
  check(fresh.paymentStatus === "failed" && fresh.status === "pending", `pending order marked payment failed (${fresh.paymentStatus})`);
  check(seen.length === 1 && String(seen[0].orderId) === String(o._id), `PAYMENT_FAILED emitted once for the order (${seen.length})`);
  const events = ["ORDER_RETURN_APPROVED", "ORDER_RETURN_REJECTED", "ORDER_RETURNED", "ORDER_REFUND_PROCESSED", "ORDER_RTO_IN_TRANSIT", "ORDER_RETURNED_TO_ORIGIN", "ORDER_AUTO_CANCELLED", "PAYMENT_FAILED", "PAYMENT_MISMATCH", "REFUND_FAILED"];
  check(events.every((e) => categoryFor(e) === "order"), "new order/payment events use the order notification category");
  check(NON_REVENUE_STATUSES.includes("rto_in_transit") && NON_REVENUE_STATUSES.includes("returned_to_origin"), "RTO statuses are not revenue");
}

async function testSellerTimeout() {
  console.log("\n# offline order not confirmed in time -> auto-cancelled (system / seller fault)");
  const store = await makeStore({ stock: 5 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 2 });
  const o = await place(buyer);
  await Order.collection.updateOne({ _id: o._id }, { $set: { createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000) } });
  const result = await runJob("order-sla");
  const fresh = await Order.findById(o._id);
  const row = await stockRow(store);
  check(result.ran && fresh.status === "cancelled", `order-sla job cancelled the order (${fresh.status})`);
  check(fresh.cancelledBy === "system" && fresh.cancelCause === "seller" && fresh.cancelReason === "seller_timeout", "cancel recorded as system / seller / seller_timeout");
  check(row.available === 5 && row.reserved === 0, "stock released");
}

const fake = await setup();
void fake;
try {
  testPure();
  await testDocNumbersAndCancel();
  await testDeliveryProof();
  await testRto();
  await testItemReturns();
  await testLedgerReturn();
  await testPaymentFailedAndCategories();
  await testSellerTimeout();
} catch (err) {
  console.error(err);
  check(false, `unexpected error: ${err.message}`);
} finally {
  await teardown();
  finish("orderPhase1");
}
