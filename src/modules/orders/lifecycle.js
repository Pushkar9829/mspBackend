import { Order, orderEventPayload } from "./order.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { CouponUsage, CouponCustomerUse } from "../pricing/couponUsage.model.js";
import { Offer } from "../pricing/offer.model.js";
import {
  commitOrderStock,
  releaseOrderStock,
  consumeOrderStock,
  restoreReturnedStock,
} from "../inventory/service.js";
import * as ledger from "../ledger/service.js";
import { generateInvoice, cancelInvoice, issueCreditNote } from "../invoices/service.js";
import { queueRefund } from "../checkout/refunds.js";
import { ONLINE_PAYMENT_METHODS } from "../checkout/razorpayApi.js";
import {
  createForwardShipment,
  createReturnShipment,
  cancelShipment,
  delhiveryConfigured,
} from "../shipping/delhivery.js";
import { withTransaction, withSession, afterCommit } from "../../utils/transaction.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { orderUpdatedAfterCommit } from "./events.js";
import {
  CANCELLABLE_STATUSES,
  REFUNDABLE_STATUSES,
  ALLOWED_TRANSITIONS,
  EVENT_MAP,
  previousStatusesFor,
  RTO_STATUS,
  RTO_FROM_STATUSES,
} from "./statuses.js";

/**
 * Order state machine. Every status change is one conditional update
 * (`{ _id, status: { $in: from } }`) inside a transaction together with all of its side effects
 * (stock, coupons, ledger, invoice/credit note, refund intent). A stale or repeated request
 * matches nothing and gets 409, so cancelled/refunded orders can never be resurrected and side
 * effects never run twice. Events and carrier/payment HTTP calls run after commit.
 */

function idOf(order) {
  return order?._id || order;
}

function emitAfter(session, event, order, extra = {}) {
  afterCommit(session, () => emitDomain(event, orderEventPayload(order, extra)));
}

export async function transition(order, { from, to, actorId = null, note = "", set = {}, extraFilter = {}, push = {}, session }) {
  const fromList = Array.isArray(from) ? from : [from];
  const updated = await Order.findOneAndUpdate(
    { _id: idOf(order), status: { $in: fromList }, ...extraFilter },
    {
      $set: { status: to, ...set },
      $push: { statusHistory: { status: to, actorId, note: note || "", at: new Date() }, ...push },
    },
    withSession(session, { new: true })
  );
  if (!updated) {
    const current = await Order.findById(idOf(order), "status paymentStatus", withSession(session)).lean();
    if (!current) throw new AppError(404, "Order not found", "NOT_FOUND");
    throw new AppError(409, `Order cannot move from ${current.status} to ${to}. Refresh and try again.`, "INVALID_STATE");
  }
  orderUpdatedAfterCommit(session, updated);
  return updated;
}

function isOnline(order) {
  return ONLINE_PAYMENT_METHODS.includes(order.paymentMethod);
}

/** Undo coupon redemption (global + per-customer) and offer caps consumed by this order. */
export async function releasePromotions(order, session) {
  const usages = await CouponUsage.find({ orderId: order._id }, null, withSession(session));
  for (const usage of usages) {
    const removed = await CouponUsage.deleteOne({ _id: usage._id }, withSession(session));
    if (!removed.deletedCount) continue;
    await Coupon.updateOne({ _id: usage.couponId, redemptionCount: { $gt: 0 } }, { $inc: { redemptionCount: -1 } }, withSession(session));
    await CouponCustomerUse.updateOne(
      { couponId: usage.couponId, userId: usage.userId, count: { $gt: 0 } },
      { $inc: { count: -1 } },
      withSession(session)
    );
  }
  for (const [offerId, qty] of offerUsageFromItems(order.items || [])) {
    if (qty <= 0) continue;
    await Offer.updateOne(
      { _id: offerId, tenantId: order.tenantId, inventoryUsed: { $gte: qty } },
      { $inc: { inventoryUsed: -qty } },
      withSession(session)
    );
  }
}

/** Units consumed per offer. A line counts once even if the breakdown repeats the offer id. */
export function offerUsageFromItems(items) {
  const qtyByOffer = new Map();
  for (const item of items || []) {
    const seen = new Set();
    for (const step of item.breakdown || []) {
      if (!step?.offerId) continue;
      const id = String(step.offerId);
      if (seen.has(id)) continue;
      seen.add(id);
      qtyByOffer.set(id, (qtyByOffer.get(id) || 0) + (Number(item.qty) || 0));
    }
  }
  return qtyByOffer;
}

/* --------------------------------------------------------------- confirm */

async function confirmInSession(order, { actorId, note, session, paid = null }) {
  const extraFilter = {};
  const set = {};
  if (paid) {
    extraFilter.paymentStatus = { $ne: "paid" };
    Object.assign(set, { paymentStatus: "paid", razorpayPaymentId: paid.paymentId || "", paidAt: new Date() });
  } else if (isOnline(order)) {
    extraFilter.paymentStatus = "paid";
  }
  const confirmed = await transition(order, { from: "pending", to: "confirmed", actorId, note: note || "Confirmed", set, extraFilter, session });
  await commitOrderStock(confirmed, { session, actorId });
  await generateInvoice(confirmed, { session });
  if (paid) emitAfter(session, "ORDER_PAID", confirmed, { paymentId: paid.paymentId });
  emitAfter(session, "ORDER_CONFIRMED", confirmed, { actorId });
  return confirmed;
}

/** Seller confirms a pending order: commit its stock and issue the GST invoice atomically. */
export async function confirmOrder(order, actorId, { session = null } = {}) {
  if (order.status && order.status !== "pending") {
    throw new AppError(400, "Only pending orders can be confirmed", "INVALID_STATE");
  }
  if (isOnline(order) && order.paymentStatus && order.paymentStatus !== "paid") {
    throw new AppError(400, "Collect payment before confirming this order", "PAYMENT_REQUIRED");
  }
  const run = (s) => confirmInSession(order, { actorId, session: s });
  return session ? run(session) : withTransaction(run);
}

/** Payment captured for a pending order: mark paid + confirm in one transaction. */
export async function payAndConfirm(order, { paymentId, session = null }) {
  const run = (s) => confirmInSession(order, { actorId: null, note: "Payment received", session: s, paid: { paymentId } });
  return session ? run(session) : withTransaction(run);
}

/* ---------------------------------------------------------------- cancel */

/**
 * Cancel before shipping. Releases/restores the order's own reservations, coupons, offers,
 * ledger debit and invoice, and queues a Razorpay refund for paid online orders, all in the
 * same transaction. `requireUnpaid` (timeout job) only matches orders that are still unpaid.
 */
export async function cancelOrder(order, actorId, note, { timeout = false, requireUnpaid = false, session = null, from = CANCELLABLE_STATUSES } = {}) {
  const reason = note || (timeout ? "Payment not received in time" : "Cancelled");
  const run = async (s) => {
    const extraFilter = requireUnpaid ? { paymentStatus: { $nin: ["paid", "refunded"] } } : {};
    const cancelled = await transition(order, { from, to: "cancelled", actorId, note: reason, extraFilter, session: s });
    await releaseOrderStock(cancelled._id, { session: s, note: reason, actorId });
    await releasePromotions(cancelled, s);
    await cancelInvoice(cancelled._id, { session: s });
    await ledger.creditOrder(cancelled, `Cancelled ${cancelled.orderNumber}`, { session: s, actorId });
    if (isOnline(cancelled) && cancelled.paymentStatus === "paid") {
      await queueRefund(cancelled, { key: `${cancelled._id}:cancel`, amount: cancelled.total, reason, session: s });
    } else if (isOnline(cancelled) && cancelled.paymentStatus !== "paid") {
      await Order.updateOne({ _id: cancelled._id, paymentStatus: { $in: ["pending", "unpaid"] } }, { $set: { paymentStatus: "failed" } }, { session: s });
    }
    const forward = (cancelled.fulfillments || []).find((f) => f.kind !== "return" && f.trackingNumber && !f.cancelledAt);
    if (forward && /delhivery/i.test(forward.carrier || "") && delhiveryConfigured()) {
      afterCommit(s, async () => {
        await cancelShipment(forward.trackingNumber);
        await Order.updateOne(
          { _id: cancelled._id, "fulfillments._id": forward._id },
          { $set: { "fulfillments.$.cancelledAt": new Date(), "fulfillments.$.status": "cancelled" } }
        );
      });
    }
    if (timeout) emitAfter(s, "ORDER_TIMEOUT", cancelled, { actorId });
    emitAfter(s, "ORDER_CANCELLED", cancelled, { actorId, reason, timeout });
    return cancelled;
  };
  return session ? run(session) : withTransaction(run);
}

/* --------------------------------------------------------- fulfilment flow */

/**
 * processing / ready_to_ship / shipped / out_for_delivery / delivered.
 * ready_to_ship books the Delhivery shipment (AWB) before the transition; if the transition
 * then fails, the shipment is cancelled again. shipped consumes the committed stock.
 */
export async function advanceOrder(order, to, { actorId = null, note = "", trackingNumber = "", carrier = "", source = "manual" } = {}) {
  const from = previousStatusesFor(to).filter((s) => !["return_requested"].includes(s));
  if (!from.length || !["processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered"].includes(to)) {
    throw new AppError(400, `Use the dedicated endpoint to move an order to ${to}`, "INVALID_STATE");
  }
  const current = await Order.findById(idOf(order));
  if (!current) throw new AppError(404, "Order not found", "NOT_FOUND");
  if (!from.includes(current.status)) {
    throw new AppError(409, `Order cannot move from ${current.status} to ${to}`, "INVALID_STATE");
  }

  let booked = null;
  const hasTracking = (current.fulfillments || []).some((f) => f.kind !== "return" && f.trackingNumber && !f.cancelledAt);
  const manual = String(trackingNumber || "").trim();
  if ((to === "ready_to_ship" || to === "shipped") && !hasTracking) {
    if (manual) {
      // Record the carrier so carrier webhooks can match this waybill (they require carrier = Delhivery).
      const fallbackCarrier = current.deliveryPartner?.id === "delhivery" ? "Delhivery" : "";
      booked = { carrier: String(carrier || "").trim() || fallbackCarrier, trackingNumber: manual };
    } else if (current.deliveryPartner?.id === "delhivery" && delhiveryConfigured()) {
      const shipment = await createForwardShipment(current, { invoiceNumber: current.invoiceNumber });
      booked = { carrier: "Delhivery", trackingNumber: shipment.waybill, fromCarrier: true };
    }
  }

  try {
    return await withTransaction(async (session) => {
      const set = {};
      const push = {};
      if (to === "delivered") {
        set.deliveredAt = new Date();
        if (current.paymentMethod === "cod") set.paymentStatus = "paid";
      }
      if (booked) {
        push.fulfillments = {
          kind: "forward",
          carrier: booked.carrier,
          trackingNumber: booked.trackingNumber,
          shippedAt: to === "shipped" ? new Date() : null,
          status: to,
        };
      }
      const updated = await transition(current, { from, to, actorId, note: note || (source === "carrier" ? "Carrier update" : ""), set, push, session });
      if (to === "shipped") {
        await Order.updateOne(
          { _id: updated._id, fulfillments: { $elemMatch: { kind: "forward", shippedAt: null } } },
          { $set: { "fulfillments.$.shippedAt": new Date() } },
          { session }
        );
      }
      if (["shipped", "out_for_delivery", "delivered"].includes(to)) {
        // Goods left the warehouse (a carrier may skip steps); committed -> consumed happens once.
        await consumeOrderStock(updated._id, { session, actorId, note: to });
      }
      const event = EVENT_MAP[to];
      if (event) emitAfter(session, event, updated, { actorId });
      return updated;
    });
  } catch (err) {
    if (booked?.fromCarrier) cancelShipment(booked.trackingNumber).catch(() => {});
    throw err;
  }
}

/* ------------------------------------------------------ return to origin */

/**
 * The carrier could not deliver and the parcel came back to the store (Delhivery RTO / DTO), or
 * the seller/admin records that manually. Same money/stock side effects as cancelOrder, in one
 * transaction: units consumed at shipping go back to available, coupons/offers are released,
 * the credit-order ledger debit is reversed, and paid online orders get a refund queued. COD was
 * never collected, so its payment status is left as is. The invoice was issued and the goods
 * moved, so it is reversed with a credit note (not cancelled).
 */
export async function returnToOrigin(order, actorId, note, { session = null, source = "manual" } = {}) {
  const reason = note || (source === "carrier" ? "Returned to origin by carrier" : "Returned to origin");
  const run = async (s) => {
    const rto = await transition(order, { from: RTO_FROM_STATUSES, to: RTO_STATUS, actorId, note: reason, session: s });
    await restoreReturnedStock(rto._id, { session: s, actorId, note: `RTO ${rto.orderNumber}` });
    await releaseOrderStock(rto._id, { session: s, note: `RTO ${rto.orderNumber}`, actorId });
    await releasePromotions(rto, s);
    await ledger.creditOrder(rto, `Returned to origin ${rto.orderNumber}`, { session: s, actorId });
    if (rto.invoiceId) await issueCreditNote(rto, { refundKey: `${rto._id}:rto`, reason, session: s });
    if (isOnline(rto) && rto.paymentStatus === "paid") {
      await queueRefund(rto, { key: `${rto._id}:rto`, amount: rto.total, reason, session: s });
    }
    emitAfter(s, EVENT_MAP[RTO_STATUS], rto, { actorId, reason });
    return rto;
  };
  return session ? run(session) : withTransaction(run);
}

/* ---------------------------------------------------------------- returns */

export async function requestReturn(order, { actorId, reason, note }) {
  return withTransaction(async (session) => {
    const updated = await transition(order, {
      from: "delivered",
      to: "return_requested",
      actorId,
      note: reason,
      extraFilter: { "returnRequest.status": null },
      set: {
        returnRequest: {
          status: "requested",
          reason: String(reason).slice(0, 120),
          note: String(note || "").slice(0, 1000),
          requestedAt: new Date(),
        },
      },
      session,
    });
    emitAfter(session, "ORDER_RETURN_REQUESTED", updated, { actorId, reason });
    return updated;
  });
}

export async function rejectReturn(order, { actorId, note }) {
  return withTransaction(async (session) =>
    transition(order, {
      from: "return_requested",
      to: "delivered",
      actorId,
      note: `Return rejected: ${note}`,
      extraFilter: { "returnRequest.status": "requested" },
      set: {
        "returnRequest.status": "rejected",
        "returnRequest.decidedAt": new Date(),
        "returnRequest.decisionNote": String(note).slice(0, 1000),
      },
      session,
    })
  );
}

/** Seller accepts the return; books a reverse pickup with Delhivery when it shipped the order. */
export async function approveReturn(order, { actorId, note = "" }) {
  const updated = await withTransaction(async (session) => {
    const row = await transition(order, {
      from: "return_requested",
      to: "return_approved",
      actorId,
      note: note || "Return approved",
      set: { "returnRequest.status": "approved", "returnRequest.decidedAt": new Date(), "returnRequest.decisionNote": String(note).slice(0, 1000) },
      session,
    });
    emitAfter(session, "ORDER_RETURN_APPROVED", row, { actorId });
    return row;
  });
  const shippedByDelhivery = (updated.fulfillments || []).some((f) => f.kind !== "return" && /delhivery/i.test(f.carrier || ""));
  if (shippedByDelhivery && delhiveryConfigured()) {
    try {
      const pickup = await createReturnShipment(updated);
      await Order.updateOne(
        { _id: updated._id },
        { $push: { fulfillments: { kind: "return", carrier: "Delhivery", trackingNumber: pickup.waybill, status: "pickup_scheduled" } } }
      );
    } catch (err) {
      console.error("return pickup booking failed", updated.orderNumber, err.message);
    }
  }
  return Order.findById(updated._id);
}

/**
 * Goods are back and inspected: restock (or book as damaged per line), then the order can be
 * refunded. `damaged` maps order item id -> damaged units.
 */
export async function receiveReturn(order, { actorId, note = "", damaged = {} }) {
  return withTransaction(async (session) => {
    const row = await transition(order, {
      from: "return_approved",
      to: "returned",
      actorId,
      note: note || "Return received",
      set: { "returnRequest.status": "received", "returnRequest.receivedAt": new Date() },
      session,
    });
    await restoreReturnedStock(row._id, { session, actorId, damagedByLine: damaged, note: `return ${row.orderNumber}` });
    emitAfter(session, "ORDER_RETURNED", row, { actorId });
    return row;
  });
}

/* ---------------------------------------------------------------- refunds */

/**
 * Refund a delivered (goods kept, no restock) or returned (already restocked) order: credit
 * note, ledger reversal, coupon release and a Razorpay refund for paid online orders.
 */
export async function refundOrder(order, actorId, note, { session = null } = {}) {
  const reason = note || "Refunded";
  const run = async (s) => {
    const current = await Order.findById(idOf(order), null, withSession(s));
    if (!current) throw new AppError(404, "Order not found", "NOT_FOUND");
    const onlinePaid = isOnline(current) && current.paymentStatus === "paid";
    const set = onlinePaid ? {} : { paymentStatus: current.paymentStatus === "paid" || current.ledgerDebit > 0 ? "refunded" : current.paymentStatus };
    const refunded = await transition(current, { from: REFUNDABLE_STATUSES, to: "refunded", actorId, note: reason, set, session: s });
    await releasePromotions(refunded, s);
    await ledger.creditOrder(refunded, `Refund ${refunded.orderNumber}`, { session: s, actorId });
    await issueCreditNote(refunded, { refundKey: `${refunded._id}:refund`, reason, session: s });
    if (onlinePaid) {
      await queueRefund(refunded, { key: `${refunded._id}:refund`, amount: refunded.total, reason, session: s });
    }
    emitAfter(s, "ORDER_REFUNDED", refunded, { actorId, reason });
    return refunded;
  };
  return session ? run(session) : withTransaction(run);
}

export { ALLOWED_TRANSITIONS, CANCELLABLE_STATUSES, REFUNDABLE_STATUSES };
