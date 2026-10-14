import { Order } from "./order.model.js";
import { cancelOrder, approveReturn, liveForwardShipment } from "./lifecycle.js";
import { orderSla, phase6Sla, OFFLINE_PAYMENT_METHODS, NOT_SHIPPED_STATUSES, HOUR } from "./sla.js";
import { isOwnFleet } from "../fleet/hooks.js";
import { emitDomain } from "../../utils/events.js";
import { logger } from "../../utils/logger.js";

/**
 * Phase 6 deadline jobs (wired in jobs/index.js):
 *  - shipSlaStep (order-sla): orders not shipped by shipBy are cancelled (cancelCause seller,
 *    cancelReason ship_timeout, buyer refunded by cancelOrder) — except packed orders already
 *    booked with a courier (the courier's pickup is late, not the seller): only flagged late.
 *  - deadlineWarningsStep (order-sla): SELLER_DEADLINE_SOON once per order for confirm / ship.
 *  - runReturnsSla (returns-sla): auto-approve undecided returns past decideBy, warn sellers
 *    before decideBy, alert admins about refunds still not done after refundDueBy.
 */

function bookedWithCourier(order) {
  return order.status === "ready_to_ship" && Boolean(liveForwardShipment(order));
}

export async function shipSlaStep({ now = new Date(), limit = 50 } = {}) {
  const [sla, p6] = await Promise.all([orderSla(), phase6Sla()]);
  if (!p6.shipSlaAutoCancel) return { shipCancelled: 0, disabled: true };
  // confirmedAt >= createdAt, so shipBy >= createdAt + shipWithinHours.
  const cutoff = new Date(now.getTime() - sla.shipWithinHours * HOUR);
  const candidates = await Order.find({ status: { $in: NOT_SHIPPED_STATUSES }, createdAt: { $lt: cutoff } })
    .sort({ createdAt: 1 })
    .limit(500);
  let cancelled = 0;
  for (const order of candidates) {
    if (cancelled >= limit) break;
    const view = sla.forOrder(order);
    if (!view.shipOverdue || bookedWithCourier(order)) continue;
    try {
      await cancelOrder(order, null, `Seller did not ship within ${sla.shipWithinHours} hours`, {
        from: NOT_SHIPPED_STATUSES,
        cancelledBy: "system",
        cancelCause: "seller",
        reasonCode: "ship_timeout",
      });
      cancelled += 1;
    } catch (err) {
      if (err.code !== "INVALID_STATE") logger.error("order-sla ship cancel", { order: order.orderNumber, err: err.message });
    }
  }
  return { shipCancelled: cancelled };
}

export async function deadlineWarningsStep({ now = new Date(), limit = 200 } = {}) {
  const [sla, p6] = await Promise.all([orderSla(), phase6Sla()]);
  const warnMs = p6.warningHours * HOUR;
  let warned = 0;
  // Confirm: pending offline orders whose confirm deadline is within the warning window.
  const confirmFrom = new Date(now.getTime() - sla.confirmWithinHours * HOUR);
  const confirmTo = new Date(now.getTime() - sla.confirmWithinHours * HOUR + warnMs);
  const pending = await Order.find({
    status: "pending",
    paymentMethod: { $in: OFFLINE_PAYMENT_METHODS },
    createdAt: { $gt: confirmFrom, $lte: confirmTo },
    "slaWarnings.confirmAt": null,
  })
    .limit(limit)
    .lean();
  for (const o of pending) {
    const dueAt = new Date(new Date(o.createdAt).getTime() + sla.confirmWithinHours * HOUR);
    const claim = await Order.updateOne({ _id: o._id, status: "pending", "slaWarnings.confirmAt": null }, { $set: { "slaWarnings.confirmAt": now } });
    if (!claim.modifiedCount) continue;
    emitDomain("SELLER_DEADLINE_SOON", { kind: "confirm", tenantId: o.tenantId, orderId: o._id, orderNumber: o.orderNumber, dueAt, resource: "order", resourceId: o._id });
    warned += 1;
  }
  // Ship: not-shipped orders whose ship deadline (confirmedAt + hours) is within the window.
  const shipCut = new Date(now.getTime() - sla.shipWithinHours * HOUR + warnMs);
  const toShip = await Order.find({ status: { $in: NOT_SHIPPED_STATUSES }, createdAt: { $lte: shipCut }, "slaWarnings.shipAt": null })
    .sort({ createdAt: 1 })
    .limit(limit);
  for (const o of toShip) {
    const view = sla.forOrder(o);
    if (!view.shipBy || view.shipOverdue) continue;
    const left = view.shipBy.getTime() - now.getTime();
    if (left > warnMs || left <= 0) continue;
    if (p6.shipSlaAutoCancel && bookedWithCourier(o)) continue;
    const claim = await Order.updateOne({ _id: o._id, status: { $in: NOT_SHIPPED_STATUSES }, "slaWarnings.shipAt": null }, { $set: { "slaWarnings.shipAt": now } });
    if (!claim.modifiedCount) continue;
    emitDomain("SELLER_DEADLINE_SOON", {
      kind: "ship",
      tenantId: o.tenantId,
      orderId: o._id,
      orderNumber: o.orderNumber,
      dueAt: view.shipBy,
      ownFleet: isOwnFleet(o),
      resource: "order",
      resourceId: o._id,
    });
    warned += 1;
  }
  return { warned };
}

/** Job `returns-sla`. */
export async function runReturnsSla({ now = new Date(), limit = 50 } = {}) {
  const p6 = await phase6Sla();
  const legacyCut = new Date(now.getTime() - p6.decideWithinHours * HOUR);
  const overdue = await Order.find({
    status: "return_requested",
    returns: {
      $elemMatch: {
        status: "requested",
        $or: [{ decideBy: { $ne: null, $lte: now } }, { decideBy: null, requestedAt: { $lte: legacyCut } }],
      },
    },
  })
    .sort({ updatedAt: 1 })
    .limit(limit);
  let autoApproved = 0;
  for (const order of overdue) {
    try {
      await approveReturn(order, { actorId: null, note: "Approved automatically: the seller did not decide in time", auto: true });
      autoApproved += 1;
    } catch (err) {
      if (err.code !== "INVALID_STATE") logger.error("returns-sla auto-approve", { order: order.orderNumber, err: err.message });
    }
  }

  // Warn sellers before decideBy.
  const warnUntil = new Date(now.getTime() + p6.warningHours * HOUR);
  const soon = await Order.find({
    status: "return_requested",
    returns: { $elemMatch: { status: "requested", decideBy: { $gt: now, $lte: warnUntil }, decideWarnedAt: null } },
  })
    .limit(200)
    .lean();
  let warned = 0;
  for (const o of soon) {
    const ret = (o.returns || []).find((r) => r.status === "requested" && r.decideBy && !r.decideWarnedAt);
    if (!ret) continue;
    const claim = await Order.updateOne(
      { _id: o._id, returns: { $elemMatch: { _id: ret._id, status: "requested", decideWarnedAt: null } } },
      { $set: { "returns.$.decideWarnedAt": now } }
    );
    if (!claim.modifiedCount) continue;
    emitDomain("SELLER_DEADLINE_SOON", {
      kind: "return_decision",
      tenantId: o.tenantId,
      orderId: o._id,
      orderNumber: o.orderNumber,
      returnId: ret._id,
      dueAt: ret.decideBy,
      resource: "order",
      resourceId: o._id,
    });
    warned += 1;
  }

  // Refunds of received returns still not completed after refundDueBy -> admin alert (once).
  const late = await Order.find({ returns: { $elemMatch: { status: "received", refundDueBy: { $ne: null, $lte: now }, refundAlertedAt: null } } })
    .limit(200)
    .lean();
  let refundAlerts = 0;
  for (const o of late) {
    for (const ret of o.returns || []) {
      if (ret.status !== "received" || !ret.refundDueBy || new Date(ret.refundDueBy) > now || ret.refundAlertedAt) continue;
      const row = (o.refunds || []).find((r) => r.key === ret.refundKey);
      const done = !row || row.status === "processed";
      const claim = await Order.updateOne(
        { _id: o._id, returns: { $elemMatch: { _id: ret._id, refundAlertedAt: null } } },
        { $set: { "returns.$.refundAlertedAt": now } }
      );
      if (!claim.modifiedCount || done) continue;
      emitDomain("REFUND_OVERDUE", {
        tenantId: o.tenantId,
        orderId: o._id,
        orderNumber: o.orderNumber,
        returnId: ret._id,
        key: row.key,
        amount: row.amount,
        refundStatus: row.status,
        hours: p6.refundWithinHours,
        resource: "order",
        resourceId: o._id,
      });
      refundAlerts += 1;
    }
  }
  return { autoApproved, warned, refundAlerts };
}
