import mongoose from "mongoose";
import { Order, orderEventPayload } from "./order.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { CouponUsage, CouponCustomerUse } from "../pricing/couponUsage.model.js";
import { Offer } from "../pricing/offer.model.js";
import {
  commitOrderStock,
  releaseOrderStock,
  consumeOrderStock,
  restoreReturnedStock,
  restoreReturnedLines,
} from "../inventory/service.js";
import * as ledger from "../ledger/service.js";
import { generateInvoice, issueCreditNote } from "../invoices/service.js";
import { queueRefund, queueOfflineRefund, recordLedgerRefund } from "../checkout/refunds.js";
import { recordDelivery } from "../payouts/ledger.js";
import { ONLINE_PAYMENT_METHODS } from "../checkout/razorpayApi.js";
import {
  createForwardShipment,
  createReturnShipment,
  cancelShipment,
  delhiveryConfigured,
} from "../shipping/delhivery.js";
import {
  createForwardShipment as createShiprocketShipment,
  createReturnShipment as createShiprocketReturn,
  cancelShiprocketOrder,
  shiprocketConfigured,
} from "../shipping/shiprocket.js";
import { withTransaction, withSession, afterCommit } from "../../utils/transaction.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { round2 } from "../pricing/engine.js";
import { orderUpdatedAfterCommit } from "./events.js";
import {
  isOwnFleet,
  ensureDeliveryTask,
  cancelTasksForOrder,
  closeTasksOnRto,
  markTasksDelivered,
  closeReturnPickup,
  createReturnPickupTask,
  cancelReturnPickupTask,
} from "../fleet/hooks.js";
import { SLA_CANCEL_REASONS, phase6Sla, decideByFor } from "./sla.js";
import {
  CANCELLABLE_STATUSES,
  REFUNDABLE_STATUSES,
  ALLOWED_TRANSITIONS,
  EVENT_MAP,
  previousStatusesFor,
  RTO_STATUS,
  RTO_FROM_STATUSES,
  RTO_IN_TRANSIT,
  RTO_IN_TRANSIT_FROM,
  classifyReason,
} from "./statuses.js";
import {
  ACTIVE_RETURN_STATUSES,
  BLOCKING_CLOSED_STATUSES,
  pickReturnItems,
  valueReturn,
  fullyReturnedAfter,
  remainingRefund,
  refundedSoFar,
  lineValue,
} from "./returns.js";

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

function isLedger(order) {
  return ledger.LEDGER_PAYMENT_METHODS.includes(order.paymentMethod);
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

/**
 * Reverse the order's whole remaining credit / PO debit and record it as a `ledger_credit`
 * refund row. Returns the amount credited (0 when nothing was debited).
 */
async function reverseLedgerDebit(order, { note, key, reason, actorId, session }) {
  const debit = Number(order.ledgerDebit) || 0;
  const done = await ledger.creditOrder(order, note, { session, actorId });
  if (!done || debit <= 0) return 0;
  await recordLedgerRefund(order, { key, amount: debit, reason, session });
  return debit;
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
 * Cancel before shipping. Releases/restores the order's own reservations, coupons, offers and
 * ledger debit, reverses an issued invoice with a full credit note (an issued invoice is never
 * voided), and queues a Razorpay refund for paid online orders, all in the same transaction.
 * `requireUnpaid` (timeout job) only matches orders that are still unpaid.
 *
 * Every cancel records `cancelledBy` (buyer | seller | admin | system), `cancelCause` (buyer |
 * seller | system | payment_timeout) and `cancelReason` (machine code, e.g. seller_timeout).
 */
export async function cancelOrder(
  order,
  actorId,
  note,
  { timeout = false, requireUnpaid = false, session = null, from = CANCELLABLE_STATUSES, cancelledBy = null, cancelCause = null, reasonCode = "" } = {}
) {
  const reason = note || (timeout ? "Payment not received in time" : "Cancelled");
  const by = cancelledBy || (timeout || !actorId ? "system" : "seller");
  const cause = cancelCause || (timeout ? "payment_timeout" : by === "buyer" ? "buyer" : by === "system" ? "system" : "seller");
  const code = reasonCode || (timeout ? "payment_timeout" : by === "buyer" ? "buyer_request" : by === "system" ? "system" : "seller_cancel");
  const run = async (s) => {
    const extraFilter = requireUnpaid ? { paymentStatus: { $nin: ["paid", "refunded"] } } : {};
    const cancelled = await transition(order, {
      from,
      to: "cancelled",
      actorId,
      note: reason,
      extraFilter,
      set: { cancelledAt: new Date(), cancelledBy: by, cancelCause: cause, cancelReason: code },
      session: s,
    });
    await releaseOrderStock(cancelled._id, { session: s, note: reason, actorId });
    await releasePromotions(cancelled, s);
    if (cancelled.invoiceId) {
      await issueCreditNote(cancelled, { refundKey: `${cancelled._id}:cancel`, reason: `Order cancelled: ${reason}`, session: s });
    }
    await reverseLedgerDebit(cancelled, { note: `Cancelled ${cancelled.orderNumber}`, key: `${cancelled._id}:cancel`, reason, actorId, session: s });
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
    if (forward && /shiprocket/i.test(forward.carrier || "") && shiprocketConfigured()) {
      afterCommit(s, async () => {
        await cancelShiprocketOrder(forward.externalOrderId);
        await Order.updateOne(
          { _id: cancelled._id, "fulfillments._id": forward._id },
          { $set: { "fulfillments.$.cancelledAt": new Date(), "fulfillments.$.status": "cancelled" } }
        );
      });
    }
    // Own fleet (phase 5): the order's open delivery task is cancelled with it.
    await cancelTasksForOrder(cancelled._id, s, `Order cancelled: ${reason}`);
    const extra = { actorId, reason, timeout, cancelledBy: by, cancelCause: cause, cancelReason: code };
    if (timeout) emitAfter(s, "ORDER_TIMEOUT", cancelled, extra);
    // Deadline auto-cancels (seller did not confirm / ship in time) are the seller's fault.
    if (SLA_CANCEL_REASONS.includes(code)) emitAfter(s, "ORDER_AUTO_CANCELLED", cancelled, extra);
    emitAfter(s, "ORDER_CANCELLED", cancelled, extra);
    return cancelled;
  };
  return session ? run(session) : withTransaction(run);
}

function needsCarrier(order) {
  return (order?.items || []).some((item) => item.fulfillmentMode !== "store_pickup");
}

/** The live forward shipment booked with a courier (carrier name + tracking number), if any. */
export function liveForwardShipment(order) {
  return (order?.fulfillments || []).find((f) => f.kind !== "return" && f.trackingNumber && f.carrier && !f.cancelledAt) || null;
}

/* --------------------------------------------------------- fulfilment flow */

/**
 * processing / ready_to_ship / shipped / out_for_delivery / delivered.
 * ready_to_ship books the carrier shipment before the transition; if the transition
 * then fails, the shipment is cancelled again. shipped consumes the committed stock.
 * Shiprocket is used for home delivery when SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD are set.
 * Delhivery still books orders whose partner is Delhivery.
 * Who may set `delivered` is decided by the caller (service.updateStatus / carrier webhook).
 * COD: delivery marks the order paid and records who collected the cash (`codCollection`).
 *
 * Own fleet (phase 5, `deliveryMethod: "own_fleet"`): no courier is booked (no AWB, manual
 * tracking ignored); ready_to_ship opens the order's delivery task. `riderAction` marks calls from
 * the rider flow (fleet/service.js); `codCollectedBy` ("seller" = rider took cash, "platform" =
 * UPI QR to the platform) overrides the COD collector; `eventExtra` is merged into the event.
 */
export async function advanceOrder(
  order,
  to,
  { actorId = null, note = "", trackingNumber = "", carrier = "", source = "manual", riderAction = false, codCollectedBy = null, codPaymentId = "", eventExtra = {} } = {}
) {
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
  if ((to === "ready_to_ship" || to === "shipped") && !hasTracking && !isOwnFleet(current)) {
    if (manual) {
      // Record the carrier so carrier webhooks can match this waybill.
      const fallbackCarrier = current.deliveryPartner?.id === "delhivery" ? "Delhivery" : current.deliveryPartner?.id === "shiprocket" ? "Shiprocket" : "";
      booked = { carrier: String(carrier || "").trim() || fallbackCarrier, trackingNumber: manual };
    } else if (current.deliveryPartner?.id === "delhivery" && delhiveryConfigured()) {
      const shipment = await createForwardShipment(current, { invoiceNumber: current.invoiceNumber });
      booked = { carrier: "Delhivery", trackingNumber: shipment.waybill, fromCarrier: true };
    } else if (needsCarrier(current) && shiprocketConfigured()) {
      const shipment = await createShiprocketShipment(current);
      booked = {
        carrier: "Shiprocket",
        trackingNumber: shipment.awb || current.orderNumber,
        externalOrderId: shipment.orderId,
        shipmentId: shipment.shipmentId,
        fromCarrier: true,
      };
    }
  }

  try {
    return await withTransaction(async (session) => {
      const set = {};
      const push = {};
      if (to === "delivered") {
        set.deliveredAt = new Date();
        if (current.paymentMethod === "cod") {
          set.paymentStatus = "paid";
          const courier = liveForwardShipment(current);
          set.codCollection = {
            by: codCollectedBy || (courier ? "courier" : "seller"),
            carrier: codCollectedBy ? "" : courier?.carrier || "",
            amount: round2(current.total || 0),
            at: new Date(),
            remittedAt: null,
            remittanceReference: "",
            paymentId: String(codPaymentId || ""),
          };
        }
      }
      if (booked) {
        push.fulfillments = {
          kind: "forward",
          carrier: booked.carrier,
          trackingNumber: booked.trackingNumber,
          externalOrderId: booked.externalOrderId || "",
          shipmentId: booked.shipmentId || "",
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
      // Seller ledger (p4-payouts): COD / credit orders go on the ledger when delivered.
      if (to === "delivered") await recordDelivery(updated, { session });
      // Own fleet (phase 5): ready_to_ship opens the delivery task; a delivery outside the rider
      // flow (platform admin override) closes it.
      if (to === "ready_to_ship") await ensureDeliveryTask(updated, session);
      if (to === "delivered" && !riderAction && isOwnFleet(updated)) {
        await markTasksDelivered(updated._id, session, { actorId, note: note || "Marked delivered by the platform" });
      }
      const event = EVENT_MAP[to];
      if (event) emitAfter(session, event, updated, { ...eventExtra, actorId, source });
      return updated;
    });
  } catch (err) {
    if (booked?.fromCarrier) {
      const undo = booked.carrier === "Shiprocket" ? cancelShiprocketOrder(booked.externalOrderId) : cancelShipment(booked.trackingNumber);
      undo.catch(() => {});
    }
    throw err;
  }
}

/* ------------------------------------------------------ return to origin */

/**
 * First RTO step: the carrier could not deliver and is bringing the parcel back. Nothing moves
 * (no restock, no refund, no credit note) until the parcel reaches the seller.
 */
export async function markRtoInTransit(order, actorId, note, { session = null, source = "manual" } = {}) {
  const reason = note || (source === "carrier" ? "Carrier: returning to seller" : "Returning to seller");
  const run = async (s) => {
    const row = await transition(order, { from: RTO_IN_TRANSIT_FROM, to: RTO_IN_TRANSIT, actorId, note: reason, session: s });
    // A parcel on its way back has left the warehouse.
    await consumeOrderStock(row._id, { session: s, actorId, note: "rto" });
    emitAfter(s, EVENT_MAP[RTO_IN_TRANSIT], row, { actorId, reason, source });
    return row;
  };
  return session ? run(session) : withTransaction(run);
}

/**
 * The parcel physically reached the seller (seller marks it, or the carrier's "RTO delivered"
 * scan). Only now: units go back to stock (`damaged` maps order item id -> damaged units, booked
 * to damaged stock), coupons/offers are released, the credit-order ledger debit is reversed, paid
 * online orders get a refund queued, and the issued invoice is reversed with a credit note.
 * COD was never collected, so its payment status is left as is.
 */
export async function returnToOrigin(order, actorId, note, { session = null, source = "manual", damaged = {} } = {}) {
  const reason = note || (source === "carrier" ? "Returned to seller (carrier)" : "Returned to seller");
  const run = async (s) => {
    const rto = await transition(order, { from: RTO_FROM_STATUSES, to: RTO_STATUS, actorId, note: reason, session: s });
    await closeTasksOnRto(rto._id, s, reason);
    await restoreReturnedStock(rto._id, { session: s, actorId, damagedByLine: damaged, note: `RTO ${rto.orderNumber}` });
    await releaseOrderStock(rto._id, { session: s, note: `RTO ${rto.orderNumber}`, actorId });
    await releasePromotions(rto, s);
    await reverseLedgerDebit(rto, { note: `Returned to origin ${rto.orderNumber}`, key: `${rto._id}:rto`, reason, actorId, session: s });
    if (rto.invoiceId) await issueCreditNote(rto, { refundKey: `${rto._id}:rto`, reason, session: s });
    if (isOnline(rto) && rto.paymentStatus === "paid") {
      await queueRefund(rto, { key: `${rto._id}:rto`, amount: rto.total, reason, session: s });
    }
    emitAfter(s, EVENT_MAP[RTO_STATUS], rto, { actorId, reason, source });
    return rto;
  };
  return session ? run(session) : withTransaction(run);
}

/* ---------------------------------------------------------------- returns */

function returnMirror(ret) {
  return {
    status: ret.status,
    reason: ret.reason || "",
    note: ret.note || "",
    requestedAt: ret.requestedAt || null,
    decidedAt: ret.decidedAt || null,
    receivedAt: ret.receivedAt || null,
    decisionNote: ret.decisionNote || "",
    returnId: ret._id,
  };
}

/**
 * The order (fresh, in the session) and its active return. Orders whose return was requested
 * before item-level returns existed get a whole-order return record created on the fly.
 */
async function loadActiveReturn(order, session, wantStatus) {
  let current = await Order.findById(idOf(order), null, withSession(session));
  if (!current) throw new AppError(404, "Order not found", "NOT_FOUND");
  let ret = (current.returns || []).find((r) => ACTIVE_RETURN_STATUSES.includes(r.status));
  if (!ret && !(current.returns || []).length && ACTIVE_RETURN_STATUSES.includes(current.returnRequest?.status)) {
    const legacy = current.returnRequest;
    const kind = classifyReason(legacy.reason);
    const items = (current.items || []).map((i) => ({ itemId: i._id, qty: i.qty }));
    const valued = valueReturn(current, items, { sellerFault: kind.sellerFault });
    const record = {
      _id: new mongoose.Types.ObjectId(),
      status: legacy.status,
      reason: legacy.reason || "",
      reasonCode: kind.code,
      sellerFault: kind.sellerFault,
      note: legacy.note || "",
      ...valued,
      requestedAt: legacy.requestedAt || new Date(),
      decidedAt: legacy.decidedAt || null,
      decisionNote: legacy.decisionNote || "",
      legacy: true,
    };
    current = await Order.findOneAndUpdate(
      { _id: current._id, "returns.0": { $exists: false } },
      { $push: { returns: record }, $set: { "returnRequest.returnId": record._id } },
      withSession(session, { new: true })
    );
    if (!current) throw new AppError(409, "The return changed. Refresh and try again.", "INVALID_STATE");
    ret = current.returns.find((r) => String(r._id) === String(record._id));
  }
  if (!ret || (wantStatus && ret.status !== wantStatus)) {
    throw new AppError(409, `This order has no ${wantStatus || "active"} return. Refresh and try again.`, "INVALID_STATE");
  }
  return { current, ret };
}

/**
 * Buyer requests a return of some (or all) delivered units. `items` = [{ itemId, qty }];
 * omitted = every returnable unit. `strict` (buyer API) only allows "easy return" lines; internal
 * callers may return any delivered line. `refundDestination` (COD orders) is where the refund
 * should be paid: { type: upi|bank|store_credit, ... } (validated by the caller).
 */
export async function requestReturn(order, { actorId, reason, note, items = null, refundDestination = null, strict = false }) {
  // Phase 6: the seller must decide by `decideBy` (returns.decideWithinHours, store override).
  const sla = await phase6Sla(order?.tenantId?._id || order?.tenantId || null);
  return withTransaction(async (session) => {
    const current = await Order.findById(idOf(order), null, withSession(session));
    if (!current) throw new AppError(404, "Order not found", "NOT_FOUND");
    if (current.status !== "delivered") {
      throw new AppError(409, `Order cannot move from ${current.status} to return_requested. Refresh and try again.`, "INVALID_STATE");
    }
    const picks = pickReturnItems(current, items, { requireEasyReturn: strict });
    const kind = classifyReason(reason);
    const valued = valueReturn(current, picks, { sellerFault: kind.sellerFault });
    const record = {
      _id: new mongoose.Types.ObjectId(),
      status: "requested",
      reason: String(reason || "").slice(0, 120),
      reasonCode: kind.code,
      sellerFault: kind.sellerFault,
      note: String(note || "").slice(0, 1000),
      ...valued,
      refundDestination: refundDestination || { type: "" },
      requestedAt: new Date(),
      requestedBy: actorId || null,
      decideBy: decideByFor(new Date(), sla.decideWithinHours),
    };
    const updated = await transition(current, {
      from: "delivered",
      to: "return_requested",
      actorId,
      note: reason,
      extraFilter: { returns: { $not: { $elemMatch: { status: { $in: ACTIVE_RETURN_STATUSES } } } } },
      set: { returnRequest: returnMirror(record) },
      push: { returns: record },
      session,
    });
    emitAfter(session, "ORDER_RETURN_REQUESTED", updated, {
      actorId,
      reason,
      returnId: record._id,
      refundAmount: record.refundAmount,
      decideBy: record.decideBy,
      items: record.items.map((i) => ({ itemId: i.itemId, name: i.name, qty: i.qty })),
    });
    return updated;
  });
}

export async function rejectReturn(order, { actorId, note }) {
  return withTransaction(async (session) => {
    const { current, ret } = await loadActiveReturn(order, session, "requested");
    const now = new Date();
    const row = await transition(current, {
      from: "return_requested",
      to: "delivered",
      actorId,
      note: `Return rejected: ${note}`,
      extraFilter: { returns: { $elemMatch: { _id: ret._id, status: "requested" } } },
      set: {
        "returns.$.status": "rejected",
        "returns.$.decidedAt": now,
        "returns.$.decidedBy": actorId || null,
        "returns.$.decisionNote": String(note).slice(0, 1000),
        "returnRequest.status": "rejected",
        "returnRequest.decidedAt": now,
        "returnRequest.decisionNote": String(note).slice(0, 1000),
        "returnRequest.returnId": ret._id,
      },
      session,
    });
    emitAfter(session, "ORDER_RETURN_REJECTED", row, { actorId, reason: String(note).slice(0, 300), returnId: ret._id });
    return row;
  });
}

/**
 * Seller accepts the return; books a reverse pickup (returned lines only) when a courier shipped
 * the order. `auto` (phase 6 returns-sla job): the seller missed `decideBy`, so the system approves
 * it (`autoApproved`, counted against the seller).
 */
export async function approveReturn(order, { actorId, note = "", auto = false }) {
  let approved = null;
  const updated = await withTransaction(async (session) => {
    const { current, ret } = await loadActiveReturn(order, session, "requested");
    const now = new Date();
    const row = await transition(current, {
      from: "return_requested",
      to: "return_approved",
      actorId,
      note: note || (auto ? "Return approved automatically" : "Return approved"),
      extraFilter: { returns: { $elemMatch: { _id: ret._id, status: "requested" } } },
      set: {
        "returns.$.status": "approved",
        "returns.$.decidedAt": now,
        "returns.$.decidedBy": actorId || null,
        "returns.$.decisionNote": String(note).slice(0, 1000),
        "returns.$.autoApproved": Boolean(auto),
        "returnRequest.status": "approved",
        "returnRequest.decidedAt": now,
        "returnRequest.decisionNote": String(note).slice(0, 1000),
        "returnRequest.returnId": ret._id,
      },
      session,
    });
    approved = ret;
    emitAfter(session, "ORDER_RETURN_APPROVED", row, { actorId, returnId: ret._id, refundAmount: ret.refundAmount, autoApproved: Boolean(auto) });
    return row;
  });
  await bookReturnPickup(updated, approved);
  return Order.findById(updated._id);
}

/**
 * Book the pickup of an approved return (returned lines only): Delhivery / Shiprocket reverse
 * pickup when a courier shipped the order, an own-fleet return_pickup task for rider-delivered
 * orders. Never throws (a failed booking is logged; the seller can still receive the return).
 * Emits ORDER_RETURN_PICKUP_SCHEDULED (phase 6) when something was booked.
 */
export async function bookReturnPickup(updated, approved) {
  // The pickup carries only the returned units; later returns of the same order get a suffix.
  const index = (updated.returns || []).findIndex((r) => String(r._id) === String(approved._id));
  const plain = typeof updated.toObject === "function" ? updated.toObject() : updated;
  const pickupOrder = {
    ...plain,
    orderNumber: index > 0 ? `${plain.orderNumber}-${index + 1}` : plain.orderNumber,
    items: (approved.items || [])
      .map((it) => {
        const line = plain.items.find((i) => String(i._id) === String(it.itemId));
        return line ? { ...line, qty: it.qty, lineSubtotal: round2((line.unitPrice || 0) * it.qty), lineTotal: it.amount } : null;
      })
      .filter(Boolean),
    total: approved.itemsAmount,
  };
  const shippedByDelhivery = (updated.fulfillments || []).some((f) => f.kind !== "return" && /delhivery/i.test(f.carrier || ""));
  const shippedByShiprocket = (updated.fulfillments || []).some((f) => f.kind !== "return" && /shiprocket/i.test(f.carrier || ""));
  let booked = null;
  if (shippedByDelhivery && delhiveryConfigured()) {
    try {
      const pickup = await createReturnShipment(pickupOrder);
      await Order.updateOne(
        { _id: updated._id },
        { $push: { fulfillments: { kind: "return", carrier: "Delhivery", trackingNumber: pickup.waybill, status: "pickup_scheduled" } } }
      );
      booked = { method: "courier", carrier: "Delhivery", trackingNumber: pickup.waybill };
    } catch (err) {
      console.error("return pickup booking failed", updated.orderNumber, err.message);
    }
  } else if (isOwnFleet(updated)) {
    // Own fleet (phase 5): the store's rider picks the return up (return_pickup task).
    try {
      await createReturnPickupTask(updated, approved);
      booked = { method: "own_fleet", carrier: "", trackingNumber: "" };
    } catch (err) {
      console.error("return pickup task failed", updated.orderNumber, err.message);
    }
  } else if (shippedByShiprocket && shiprocketConfigured()) {
    try {
      const pickup = await createShiprocketReturn(pickupOrder);
      const trackingNumber = pickup.awb || `${pickupOrder.orderNumber}-R`;
      await Order.updateOne(
        { _id: updated._id },
        {
          $push: {
            fulfillments: {
              kind: "return",
              carrier: "Shiprocket",
              trackingNumber,
              externalOrderId: pickup.orderId || "",
              shipmentId: pickup.shipmentId || "",
              status: "pickup_scheduled",
            },
          },
        }
      );
      booked = { method: "courier", carrier: "Shiprocket", trackingNumber };
    } catch (err) {
      console.error("return pickup booking failed", updated.orderNumber, err.message);
    }
  }
  if (booked) {
    await Order.updateOne({ _id: updated._id, "returns._id": approved._id }, { $set: { "returns.$.pickupScheduledAt": new Date() } }).catch(() => {});
    emitDomain(
      "ORDER_RETURN_PICKUP_SCHEDULED",
      orderEventPayload(updated, { returnId: approved._id, pickupMethod: booked.method, carrier: booked.carrier, trackingNumber: booked.trackingNumber })
    );
  }
  return booked;
}

/**
 * Phase 6: the pickup of the active (approved) return could not be done — the courier gave up
 * after `returns.maxPickupAttempts` failed attempts / cancelled the reverse pickup, the store's
 * rider failed the last attempt, or the seller recorded it. The return is closed as
 * `pickup_failed` (order back to `delivered`, nothing refunded); the buyer is told and can open a
 * dispute within disputes.windowDays. `returnId` (optional) guards against acting on a newer return.
 */
export async function markReturnPickupFailed(order, { actorId = null, reason = "", source = "manual", returnId = null } = {}) {
  const text = String(reason || "Pickup could not be completed").slice(0, 500);
  return withTransaction(async (session) => {
    const { current, ret } = await loadActiveReturn(order, session, "approved");
    if (returnId && String(ret._id) !== String(returnId)) {
      throw new AppError(409, "That return is no longer waiting for pickup", "INVALID_STATE");
    }
    const now = new Date();
    const row = await transition(current, {
      from: "return_approved",
      to: "delivered",
      actorId,
      note: `Return pickup failed: ${text}`,
      extraFilter: { returns: { $elemMatch: { _id: ret._id, status: "approved" } } },
      set: {
        "returns.$.status": "pickup_failed",
        "returns.$.pickupFailedAt": now,
        "returns.$.pickupFailReason": text,
        "returnRequest.status": "pickup_failed",
        "returnRequest.returnId": ret._id,
      },
      session,
    });
    await cancelReturnPickupTask(row._id, ret._id, session, `Pickup failed: ${text}`);
    // A courier reverse pickup that gave up is not reused.
    if ((row.fulfillments || []).some((f) => f.kind === "return" && !f.cancelledAt)) {
      await Order.updateOne(
        { _id: row._id },
        { $set: { "fulfillments.$[f].cancelledAt": now } },
        withSession(session, { arrayFilters: [{ "f.kind": "return", "f.cancelledAt": null }] })
      );
    }
    emitAfter(session, "ORDER_RETURN_PICKUP_FAILED", row, { actorId, returnId: ret._id, reason: text, source });
    return Order.findById(row._id, null, withSession(session));
  });
}

/**
 * Money back for one received return, inside the receive transaction (the seller never moves
 * money; this only records / queues it):
 *  - online paid  -> Razorpay refund queued (system worker),
 *  - COD paid     -> offline refund `pending_payout` (platform pays to UPI / bank, or store credit),
 *  - credit / PO  -> ledger credit for the amount + `ledger_credit` refund row.
 * Capped so the order is never refunded more than its total.
 */
async function refundReturn(order, ret, valued, { actorId, session }) {
  return refundToBuyer(order, {
    key: `${order._id}:return:${ret._id}`,
    amount: valued.refundAmount,
    reason: `Return: ${ret.reason || "returned items"}`,
    destination: ret.refundDestination,
    returnId: ret._id,
    actorId,
    session,
  });
}

/**
 * Pay `amount` back to the buyer the way the order was paid (inside the caller's transaction):
 * Razorpay refund (online paid), offline payout pending_payout / store credit (COD paid), ledger
 * credit (credit / PO). Capped so the order is never refunded more than its total.
 * Returns { key, amount, method }.
 */
export async function refundToBuyer(order, { key, amount: wanted, reason, destination = null, returnId = null, actorId = null, session }) {
  const amount = round2(Math.max(0, Math.min(Number(wanted) || 0, (order.total || 0) - refundedSoFar(order))));
  const ret = { _id: returnId, refundDestination: destination };
  let method = null;
  if (amount > 0 && isOnline(order) && order.paymentStatus === "paid") {
    if (await queueRefund(order, { key, amount, reason, session })) method = "razorpay";
  } else if (amount > 0 && order.paymentMethod === "cod" && order.paymentStatus === "paid") {
    await queueOfflineRefund(order, { key, amount, reason, destination: ret.refundDestination, returnId: ret._id, session });
    method = "cod";
  } else if (amount > 0 && isLedger(order) && (order.ledgerDebit || 0) > 0) {
    const credit = round2(Math.min(amount, order.ledgerDebit));
    const dec = await Order.updateOne(
      { _id: order._id, ledgerDebit: { $gte: credit } },
      { $inc: { ledgerDebit: -credit } },
      withSession(session)
    );
    if (dec.modifiedCount) {
      await ledger.applyEntry({
        userId: order.buyerId,
        tenantId: order.tenantId,
        type: "credit",
        kind: "adjustment",
        amount: credit,
        note: `Return ${order.orderNumber}`,
        reference: key,
        orderId: order._id,
        actorId,
        session,
      });
      await recordLedgerRefund(order, { key, amount: credit, reason, returnId: ret._id, session });
      method = "ledger_credit";
    }
  }
  return { key, amount, method };
}

/**
 * Goods of the active (approved) return are back and inspected. Restocks ONLY the returned units
 * (`damaged` maps order item id -> damaged units, booked to damaged stock), issues a credit note
 * for just those lines (+ fee share for seller-fault returns) and queues the refund. The order
 * goes to `returned` when every unit has now come back, else back to `delivered` (the rest of
 * the order stays with the buyer and can still be returned within the window).
 *
 * Phase 6 quality check: `rejected` maps order item id -> { qty, reason } of units the seller
 * rejected after inspection (`qc` = { note, photos: [fileId], disposition }). Rejected units are
 * not restocked, not refunded and not counted as returned; they are recorded in `returns.$.qc`
 * (the buyer can dispute them). When every unit is rejected the return becomes `qc_rejected`
 * (no refund, no credit note) and the order goes back to `delivered`.
 */
export async function receiveReturn(order, { actorId, note = "", damaged = {}, rejected = {}, qc = null }) {
  return withTransaction(async (session) => {
    const { current, ret } = await loadActiveReturn(order, session, "approved");
    const rejectedRows = [];
    const lines = [];
    for (const it of ret.items || []) {
      const rej = rejected[String(it.itemId)] || null;
      const rejectedQty = Math.max(0, Math.min(it.qty, Number(rej?.qty) || 0));
      if (rejectedQty > 0) rejectedRows.push({ itemId: it.itemId, name: it.name || "", qty: rejectedQty, reason: String(rej.reason || "").slice(0, 300) });
      const accepted = it.qty - rejectedQty;
      if (accepted > 0) {
        lines.push({ itemId: it.itemId, qty: accepted, damagedQty: Math.max(0, Math.min(accepted, Number(damaged[String(it.itemId)]) || 0)) });
      }
    }
    const now = new Date();
    let qcSet = {};
    if (rejectedRows.length) {
      const rejValue = valueReturn(current, rejectedRows, { sellerFault: false });
      const qcItems = rejectedRows.map((r) => ({ ...r, amount: rejValue.items.find((v) => String(v.itemId) === String(r.itemId))?.amount || 0 }));
      qcSet = {
        "returns.$.qc": {
          at: now,
          by: actorId || null,
          note: String(qc?.note || "").slice(0, 1000),
          photos: (qc?.photos || []).map((id) => new mongoose.Types.ObjectId(String(id))),
          disposition: qc?.disposition || "",
          items: qcItems,
          rejectedAmount: rejValue.itemsAmount,
        },
      };
    }

    if (!lines.length) {
      // Every unit failed the quality check: nothing comes back into stock, nothing is refunded.
      const row = await transition(current, {
        from: "return_approved",
        to: "delivered",
        actorId,
        note: note || "Return rejected after quality check",
        extraFilter: { returns: { $elemMatch: { _id: ret._id, status: "approved" } } },
        set: {
          "returns.$.status": "qc_rejected",
          "returns.$.receivedAt": now,
          "returns.$.receivedBy": actorId || null,
          "returns.$.receiveNote": String(note || "").slice(0, 1000),
          ...qcSet,
          "returnRequest.status": "qc_rejected",
          "returnRequest.receivedAt": now,
          "returnRequest.returnId": ret._id,
        },
        session,
      });
      await closeReturnPickup(row._id, ret._id, session);
      const fresh = await Order.findById(row._id, null, withSession(session));
      emitAfter(session, "ORDER_RETURN_QC_REJECTED", fresh, {
        actorId,
        returnId: ret._id,
        partial: false,
        rejectedQty: rejectedRows.reduce((s, r) => s + r.qty, 0),
        reason: String(qc?.note || rejectedRows[0]?.reason || "").slice(0, 300),
        disposition: qc?.disposition || "",
      });
      return fresh;
    }

    const valued = valueReturn(current, lines, { sellerFault: ret.sellerFault });
    const full = fullyReturnedAfter(current, lines);
    const to = full ? "returned" : "delivered";
    const key = `${current._id}:return:${ret._id}`;
    const sla = await phase6Sla(current.tenantId);
    const row = await transition(current, {
      from: "return_approved",
      to,
      actorId,
      note: note || (full ? "Return received" : "Return received (partial)"),
      extraFilter: { returns: { $elemMatch: { _id: ret._id, status: "approved" } } },
      set: {
        "returns.$.status": "received",
        "returns.$.receivedAt": now,
        "returns.$.receivedBy": actorId || null,
        "returns.$.receiveNote": String(note || "").slice(0, 1000),
        "returns.$.items": valued.items,
        "returns.$.itemsAmount": valued.itemsAmount,
        "returns.$.feesAmount": valued.feesAmount,
        "returns.$.refundAmount": valued.refundAmount,
        "returns.$.refundKey": key,
        "returns.$.refundDueBy": new Date(now.getTime() + sla.refundWithinHours * 60 * 60 * 1000),
        ...qcSet,
        "returnRequest.status": "received",
        "returnRequest.receivedAt": now,
        "returnRequest.returnId": ret._id,
      },
      session,
    });
    if (lines.length) {
      const inc = {};
      const arrayFilters = [];
      lines.forEach((l, idx) => {
        inc[`items.$[l${idx}].returnedQty`] = l.qty;
        arrayFilters.push({ [`l${idx}._id`]: l.itemId });
      });
      await Order.updateOne({ _id: row._id }, { $inc: inc }, withSession(session, { arrayFilters }));
    }
    await restoreReturnedLines(
      row._id,
      lines.map((l) => ({ lineId: l.itemId, qty: l.qty, damagedQty: l.damagedQty })),
      { session, actorId, note: `return ${row.orderNumber}` }
    );
    if (valued.refundAmount > 0 && (row.invoiceId || current.invoiceId)) {
      const note2 = await issueCreditNote(row, {
        refundKey: key,
        reason: `Return: ${ret.reason || ""}`.trim(),
        session,
        part: { items: valued.items, feesAmount: valued.feesAmount, returnId: ret._id },
      });
      await Order.updateOne({ _id: row._id, "returns._id": ret._id }, { $set: { "returns.$.creditNoteId": note2._id } }, withSession(session));
    }
    const refund = await refundReturn(row, ret, valued, { actorId, session });
    await closeReturnPickup(row._id, ret._id, session);
    const fresh = await Order.findById(row._id, null, withSession(session));
    emitAfter(session, "ORDER_RETURNED", fresh, {
      actorId,
      returnId: ret._id,
      partial: !full,
      refundAmount: refund.amount,
      refundMethod: refund.method,
      refundDestinationType: ret.refundDestination?.type || "",
      qcRejectedQty: rejectedRows.reduce((s, r) => s + r.qty, 0),
    });
    if (rejectedRows.length) {
      emitAfter(session, "ORDER_RETURN_QC_REJECTED", fresh, {
        actorId,
        returnId: ret._id,
        partial: true,
        rejectedQty: rejectedRows.reduce((s, r) => s + r.qty, 0),
        reason: String(qc?.note || rejectedRows[0]?.reason || "").slice(0, 300),
        disposition: qc?.disposition || "",
      });
    }
    return fresh;
  });
}

/* ------------------------------------------------------- disputes (phase 6) */

/** Units a dispute is about: QC-rejected units, else the whole (rejected / pickup-failed) return. */
export function disputedUnits(ret) {
  if (ret?.qc?.items?.length && (ret.status === "qc_rejected" || ret.status === "received")) {
    return ret.qc.items.map((i) => ({ itemId: i.itemId, name: i.name || "", qty: i.qty }));
  }
  return (ret?.items || []).map((i) => ({ itemId: i.itemId, name: i.name || "", qty: i.qty }));
}

/** Refund value of the disputed units (same money rules as a return of them). */
export function disputeValue(order, ret) {
  return valueReturn(order, disputedUnits(ret), { sellerFault: Boolean(ret?.sellerFault) });
}

/**
 * Dispute decided "reopen": a NEW approved return record for the disputed units (the closed
 * record keeps its history and gets `reopenedAs`), order delivered -> return_approved, and the
 * pickup is booked again (not for a QC rejection whose goods the seller holds). The seller then
 * receives it as usual (refund on receive).
 */
export async function reopenReturnForDispute(order, { returnId, disputeId, actorId = null, note = "" }) {
  let created = null;
  let needsPickup = true;
  const updated = await withTransaction(async (session) => {
    const current = await Order.findById(idOf(order), null, withSession(session));
    if (!current) throw new AppError(404, "Order not found", "NOT_FOUND");
    const ret = (current.returns || []).find((r) => String(r._id) === String(returnId));
    if (!ret) throw new AppError(404, "Return not found", "NOT_FOUND");
    if (ret.reopenedAs) throw new AppError(409, "This return was already reopened", "INVALID_STATE");
    if (!(BLOCKING_CLOSED_STATUSES.includes(ret.status) || (ret.status === "received" && ret.qc?.items?.length))) {
      throw new AppError(409, "Only a rejected, pickup-failed or quality-check-rejected return can be reopened", "INVALID_STATE");
    }
    if (current.status !== "delivered") {
      throw new AppError(409, `The order is ${current.status}; a return can only be reopened while it is delivered`, "INVALID_STATE");
    }
    const units = disputedUnits(ret);
    const valued = valueReturn(current, units, { sellerFault: ret.sellerFault });
    const now = new Date();
    needsPickup = !(ret.qc?.items?.length && ret.qc.disposition === "hold");
    const record = {
      _id: new mongoose.Types.ObjectId(),
      status: "approved",
      reason: ret.reason || "",
      reasonCode: ret.reasonCode || "other",
      sellerFault: Boolean(ret.sellerFault),
      note: ret.note || "",
      ...valued,
      refundDestination: ret.refundDestination || { type: "" },
      requestedAt: ret.requestedAt || now,
      requestedBy: ret.requestedBy || null,
      decidedAt: now,
      decidedBy: actorId || null,
      decisionNote: String(note || "Reopened by the platform after a dispute").slice(0, 1000),
      reopenedFrom: ret._id,
      // The dispute that reopened it — NOT disputeId, so a new dispute stays possible if this
      // reopened return fails again (e.g. pickup failed).
      reopenedByDisputeId: disputeId || null,
    };
    const row = await transition(current, {
      from: "delivered",
      to: "return_approved",
      actorId,
      note: record.decisionNote,
      extraFilter: {
        returns: { $not: { $elemMatch: { status: { $in: ACTIVE_RETURN_STATUSES } } } },
      },
      set: { returnRequest: { ...returnMirror(record) } },
      push: { returns: record },
      session,
    });
    await Order.updateOne({ _id: row._id, "returns._id": ret._id }, { $set: { "returns.$.reopenedAs": record._id } }, withSession(session));
    created = record;
    emitAfter(session, "ORDER_RETURN_APPROVED", row, { actorId, returnId: record._id, refundAmount: record.refundAmount, reopened: true, disputeId });
    return row;
  });
  if (needsPickup) await bookReturnPickup(updated, created);
  return { order: await Order.findById(updated._id), returnId: created._id };
}

/**
 * Dispute decided "refund": the platform forces a refund of `amount` (<= what is still
 * refundable) for the disputed units without the goods coming back. Same money paths as a return
 * (Razorpay / COD payout / ledger credit), a partial credit note scaled to the amount, and seller
 * ledger debit (payouts onRefundQueued; the refund key ends in `:return:<returnId>` so the fee /
 * tax split uses the return record). Order status is unchanged.
 */
export async function refundForDispute(order, { returnId, disputeId, amount, actorId = null, reason = "" }) {
  return withTransaction(async (session) => {
    const current = await Order.findById(idOf(order), null, withSession(session));
    if (!current) throw new AppError(404, "Order not found", "NOT_FOUND");
    const ret = (current.returns || []).find((r) => String(r._id) === String(returnId));
    if (!ret) throw new AppError(404, "Return not found", "NOT_FOUND");
    const remaining = round2(Math.max(0, (current.total || 0) - refundedSoFar(current)));
    const value = disputeValue(current, ret);
    const wanted = amount != null ? round2(Number(amount)) : value.refundAmount;
    if (!(wanted > 0)) throw new AppError(400, "Refund amount must be more than 0", "VALIDATION_ERROR");
    if (wanted > remaining + 0.001) {
      throw new AppError(400, `At most ${remaining.toFixed(2)} can still be refunded on this order`, "REFUND_TOO_HIGH");
    }
    const key = `${current._id}:dispute:${disputeId}:return:${ret._id}`;
    const text = `Dispute refund${reason ? `: ${String(reason).slice(0, 200)}` : ""}`;
    if (current.invoiceId && value.refundAmount > 0) {
      const factor = Math.min(1, wanted / value.refundAmount);
      const items = value.items.map((i) => {
        const amt = round2(i.amount * factor);
        const taxableValue = round2(i.taxableValue * factor);
        return { ...i, amount: amt, taxableValue, tax: round2(amt - taxableValue) };
      });
      await issueCreditNote(current, { refundKey: key, reason: text, session, part: { items, feesAmount: round2(value.feesAmount * factor), returnId: ret._id } });
    }
    const refund = await refundToBuyer(current, {
      key,
      amount: wanted,
      reason: text,
      destination: ret.refundDestination,
      returnId: ret._id,
      actorId,
      session,
    });
    const fresh = await Order.findById(current._id, null, withSession(session));
    emitAfter(session, "ORDER_REFUNDED", fresh, {
      actorId,
      reason: text,
      refundAmount: refund.amount,
      refundMethod: refund.method,
      refundDestinationType: ret.refundDestination?.type || "",
      disputeId,
      returnId: ret._id,
    });
    return { order: fresh, refund };
  });
}

/* ---------------------------------------------------------------- refunds */

/**
 * Refund a delivered (goods kept, no restock) or returned order in full: whatever earlier
 * partial returns have not refunded yet. Credit note (whole invoice, or just the remaining lines
 * and fees after partial returns), ledger reversal, coupon release, and the money: Razorpay
 * refund for paid online orders, an offline payout (pending_payout) for paid COD orders, a ledger
 * credit for credit / PO orders.
 */
export async function refundOrder(order, actorId, note, { session = null } = {}) {
  const reason = note || "Refunded";
  const run = async (s) => {
    const current = await Order.findById(idOf(order), null, withSession(s));
    if (!current) throw new AppError(404, "Order not found", "NOT_FOUND");
    const onlinePaid = isOnline(current) && current.paymentStatus === "paid";
    const codPaid = current.paymentMethod === "cod" && current.paymentStatus === "paid";
    const set = onlinePaid || codPaid ? {} : { paymentStatus: current.paymentStatus === "paid" || current.ledgerDebit > 0 ? "refunded" : current.paymentStatus };
    const refunded = await transition(current, { from: REFUNDABLE_STATUSES, to: "refunded", actorId, note: reason, set, session: s });
    const rem = remainingRefund(current);
    const amount = round2(Math.max(0, Math.min(rem.amount, (current.total || 0) - refundedSoFar(current))));
    await releasePromotions(refunded, s);
    await reverseLedgerDebit(refunded, { note: `Refund ${refunded.orderNumber}`, key: `${refunded._id}:refund`, reason, actorId, session: s });
    if (!rem.partial) {
      await issueCreditNote(refunded, { refundKey: `${refunded._id}:refund`, reason, session: s });
    } else if (rem.amount > 0) {
      await issueCreditNote(refunded, { refundKey: `${refunded._id}:refund`, reason, session: s, part: { items: rem.items, feesAmount: rem.feesAmount } });
    }
    if (onlinePaid && amount > 0) {
      await queueRefund(refunded, { key: `${refunded._id}:refund`, amount, reason, session: s });
    } else if (codPaid && amount > 0) {
      const last = [...(current.returns || [])].reverse().find((r) => r.refundDestination?.type);
      await queueOfflineRefund(refunded, { key: `${refunded._id}:refund`, amount, reason, destination: last?.refundDestination || null, session: s });
    }
    emitAfter(s, "ORDER_REFUNDED", refunded, { actorId, reason, refundAmount: amount, refundMethod: onlinePaid ? "razorpay" : codPaid ? "cod" : isLedger(current) ? "ledger_credit" : null });
    return refunded;
  };
  return session ? run(session) : withTransaction(run);
}

export { ALLOWED_TRANSITIONS, CANCELLABLE_STATUSES, REFUNDABLE_STATUSES, lineValue };
