import { Order } from "../orders/order.model.js";
import { createRefund, fetchRefund, toPaise } from "./razorpayApi.js";
import { withSession, afterCommit } from "../../utils/transaction.js";
import { emitDomain } from "../../utils/events.js";
import { orderUpdatedAfterCommit, emitOrderUpdated } from "../orders/events.js";
import { applyEntry } from "../ledger/service.js";
import { AppError } from "../../utils/AppError.js";
import { onRefundQueued } from "../payouts/ledger.js";

const LOCK_MS = 2 * 60 * 1000;
export const MAX_ATTEMPTS = 8;
/** Refund rows the Razorpay worker handles (rows created before `method` existed have none). */
const RAZORPAY_METHOD = { $in: ["razorpay", null] };
/** Refunds still pending at Razorpay are polled this long after the last check (webhook fallback). */
const POLL_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Refunds of money that was never this order's own payment (a payment on a superseded Razorpay
 * order, or an amount mismatch) only use the order as their home; they must not count toward
 * the order being refunded.
 */
export function isStrayRefundKey(key) {
  return /^(stray|mismatch):/.test(String(key || ""));
}

/**
 * Outbox for money going back to the buyer. Inside the business transaction we only record a
 * refund intent on the order (`refunds[]`, keyed so it is added at most once). After commit,
 * `processRefund` calls Razorpay; the `process-refunds` job retries failures.
 */
export async function queueRefund(order, { key, amount, reason = "", paymentId = null, session = null }) {
  const pid = paymentId || order.razorpayPaymentId;
  if (!pid || !(Number(amount) > 0)) return false;
  const res = await Order.updateOne(
    { _id: order._id, "refunds.key": { $ne: key } },
    {
      $push: {
        refunds: {
          key,
          provider: "razorpay",
          paymentId: pid,
          amount: Math.round(Number(amount) * 100) / 100,
          status: "pending",
          reason,
        },
      },
    },
    withSession(session)
  );
  if (res.modifiedCount) {
    // Seller ledger (p4-payouts): refund + fee / TCS / TDS reversal lines, same transaction.
    await onRefundQueued(order, { key, amount, reason, method: "razorpay" }, { session });
    orderUpdatedAfterCommit(session, order);
    afterCommit(session, () => processRefund(order._id, key));
    return true;
  }
  return false;
}

/** ORDER_REFUND_PROCESSED payload (money has actually reached the buyer / their account). */
function processedPayload(order, row) {
  return {
    orderId: order._id,
    orderNumber: order.orderNumber,
    key: row.key,
    providerRefundId: row.providerRefundId || "",
    amount: row.amount,
    method: row.method || "razorpay",
    destinationType: row.destination?.type || "",
    payoutReference: row.payoutReference || "",
    tenantId: order.tenantId,
    buyerId: order.buyerId,
    resource: "order",
    resourceId: order._id,
  };
}

async function markRefundProcessed(orderId, key, providerRefundId, { extraSet = {}, session = null } = {}) {
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, refunds: { $elemMatch: { key, status: { $ne: "processed" } } } },
    {
      $set: {
        "refunds.$.status": "processed",
        "refunds.$.providerRefundId": providerRefundId || "",
        "refunds.$.processedAt": new Date(),
        "refunds.$.lockedUntil": null,
        ...extraSet,
      },
    },
    withSession(session, { new: true })
  );
  if (!updated) return null;
  const refunded = updated.refunds
    .filter((r) => r.status === "processed" && !isStrayRefundKey(r.key))
    .reduce((s, r) => s + r.amount, 0);
  if (refunded + 0.005 >= Number(updated.total)) {
    await Order.updateOne({ _id: orderId, paymentStatus: { $ne: "refunded" } }, { $set: { paymentStatus: "refunded" } }, withSession(session));
  }
  const payload = processedPayload(updated, updated.refunds.find((r) => r.key === key));
  if (session) {
    orderUpdatedAfterCommit(session, updated);
    afterCommit(session, () => emitDomain("ORDER_REFUND_PROCESSED", payload));
  } else {
    emitDomain("ORDER_REFUND_PROCESSED", payload);
    await emitOrderUpdated(orderId);
  }
  return updated;
}

/* ------------------------------------------------- offline / ledger refunds */

/**
 * Credit / PO orders: the ledger credit itself is written by the caller (ledger service); this
 * records it as a refund row (`method: ledger_credit`, processed) so every refund has a record.
 */
export async function recordLedgerRefund(order, { key, amount, reason = "", returnId = null, session = null }) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!(value > 0)) return false;
  const res = await Order.updateOne(
    { _id: order._id, "refunds.key": { $ne: key } },
    {
      $push: {
        refunds: { key, provider: "ledger", method: "ledger_credit", amount: value, status: "processed", reason, returnId, processedAt: new Date() },
      },
    },
    withSession(session)
  );
  if (!res.modifiedCount) return false;
  await onRefundQueued(order, { key, amount: value, reason, method: "ledger_credit" }, { session });
  orderUpdatedAfterCommit(session, order);
  const payload = processedPayload(order, { key, amount: value, method: "ledger_credit" });
  afterCommit(session, () => emitDomain("ORDER_REFUND_PROCESSED", payload));
  return true;
}

/** Credit the buyer's account with this store (store credit for an offline refund). */
async function creditStore(order, row, session) {
  await applyEntry({
    userId: order.buyerId?._id || order.buyerId,
    tenantId: order.tenantId?._id || order.tenantId,
    type: "credit",
    kind: "adjustment",
    amount: row.amount,
    note: `Store credit refund ${order.orderNumber}`,
    reference: row.key,
    orderId: order._id,
    session,
  });
}

/**
 * COD (offline) refund: the money is paid out by the platform, never by the seller. Recorded as
 * `method: cod`, `status: pending_payout` until the platform marks it paid with a reference
 * (markPayoutPaid). A `store_credit` destination is settled at once as a ledger credit.
 */
export async function queueOfflineRefund(order, { key, amount, reason = "", destination = null, returnId = null, session = null }) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!(value > 0)) return false;
  const dest = destination?.type ? destination : { type: "" };
  const res = await Order.updateOne(
    { _id: order._id, "refunds.key": { $ne: key } },
    {
      $push: {
        refunds: { key, provider: "manual", method: "cod", amount: value, status: "pending_payout", reason, returnId, destination: dest },
      },
    },
    withSession(session)
  );
  if (!res.modifiedCount) return false;
  await onRefundQueued(order, { key, amount: value, reason, method: "cod" }, { session });
  orderUpdatedAfterCommit(session, order);
  if (dest.type === "store_credit") {
    await creditStore(order, { key, amount: value }, session);
    await markRefundProcessed(order._id, key, "", { session });
  }
  return true;
}

/**
 * Buyer (or platform) sets where a pending COD refund should go; store_credit settles it at once.
 * Run inside a transaction (`session`).
 */
export async function setRefundDestination(orderId, key, destination, { session = null } = {}) {
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, refunds: { $elemMatch: { key, method: "cod", status: "pending_payout" } } },
    { $set: { "refunds.$.destination": destination } },
    withSession(session, { new: true })
  );
  if (!updated) throw new AppError(409, "This refund is not waiting for payout details", "INVALID_STATE");
  orderUpdatedAfterCommit(session, updated);
  if (destination.type === "store_credit") {
    await creditStore(updated, updated.refunds.find((r) => r.key === key), session);
    return markRefundProcessed(orderId, key, "", { session });
  }
  return updated;
}

/** Platform records that it paid an offline refund (UTR / transaction reference). */
export async function markPayoutPaid(orderId, key, { reference, actorId = null, session = null }) {
  const ref = String(reference || "").trim();
  if (!ref) throw new AppError(400, "Enter the payout reference (UTR / transaction id)", "VALIDATION_ERROR");
  const order = await Order.findOne({ _id: orderId, "refunds.key": key }, null, withSession(session));
  const row = order?.refunds.find((r) => r.key === key);
  if (!row) throw new AppError(404, "Refund not found", "NOT_FOUND");
  if (row.method !== "cod" || row.status !== "pending_payout") {
    throw new AppError(409, `Refund is ${row.status}; only pending offline payouts can be marked paid`, "INVALID_STATE");
  }
  if (!["upi", "bank"].includes(row.destination?.type)) {
    throw new AppError(409, "The buyer has not provided a UPI id or bank account for this refund yet", "DESTINATION_REQUIRED");
  }
  const updated = await markRefundProcessed(orderId, key, "", {
    extraSet: { "refunds.$.payoutReference": ref.slice(0, 100), "refunds.$.paidBy": actorId || null },
    session,
  });
  if (!updated) throw new AppError(409, "Refund changed. Refresh and try again.", "INVALID_STATE");
  return updated;
}

/** Claim one refund intent (lease), call the provider, record the result. Safe to call repeatedly. */
export async function processRefund(orderId, key) {
  const now = new Date();
  const claimed = await Order.findOneAndUpdate(
    {
      _id: orderId,
      refunds: {
        $elemMatch: {
          key,
          method: RAZORPAY_METHOD,
          status: { $in: ["pending", "failed", "processing"] },
          providerRefundId: "",
          attempts: { $lt: MAX_ATTEMPTS },
          $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
        },
      },
    },
    {
      $set: { "refunds.$.status": "processing", "refunds.$.lockedUntil": new Date(now.getTime() + LOCK_MS) },
      $inc: { "refunds.$.attempts": 1 },
    },
    { new: true }
  );
  if (!claimed) return null;
  const refund = claimed.refunds.find((r) => r.key === key);
  try {
    // Razorpay Route (p4-payouts): pull the seller's part back from a still-held transfer first.
    const { reverseForRefund } = await import("../payouts/route.js");
    await reverseForRefund(claimed, refund);
    const result = await createRefund({
      paymentId: refund.paymentId,
      amountPaise: toPaise(refund.amount),
      refundKey: key,
      reason: refund.reason,
    });
    if (result?.status === "processed") return markRefundProcessed(orderId, key, result.id);
    if (result?.status === "failed") throw new Error("Razorpay reported the refund as failed");
    // Pending at Razorpay: keep "processing" with the provider id; the refund.processed webhook
    // finalises it, and processPendingRefunds polls Razorpay once lockedUntil passes.
    await Order.updateOne(
      { _id: orderId, "refunds.key": key },
      { $set: { "refunds.$.providerRefundId": result?.id || "", "refunds.$.lockedUntil": new Date(Date.now() + POLL_AFTER_MS) } }
    );
    return claimed;
  } catch (err) {
    await Order.updateOne(
      { _id: orderId, "refunds.key": key },
      { $set: { "refunds.$.status": "failed", "refunds.$.lastError": String(err.message || err).slice(0, 300), "refunds.$.lockedUntil": null } }
    );
    console.error("refund failed", String(orderId), key, err.message);
    if ((refund.attempts || 0) >= MAX_ATTEMPTS) {
      // Out of automatic attempts: alert the platform once (staff can retry from the refunds list).
      const flagged = await Order.findOneAndUpdate(
        { _id: orderId, refunds: { $elemMatch: { key, alertedAt: null } } },
        { $set: { "refunds.$.alertedAt": new Date() } },
        { new: true }
      );
      if (flagged) {
        emitDomain("REFUND_FAILED", {
          orderId,
          orderNumber: flagged.orderNumber,
          tenantId: flagged.tenantId,
          buyerId: flagged.buyerId,
          key,
          amount: refund.amount,
          attempts: refund.attempts,
          error: String(err.message || err).slice(0, 300),
          resource: "order",
          resourceId: orderId,
        });
      }
    }
    await emitOrderUpdated(orderId);
    return null;
  }
}

/** Webhook: refund.processed / refund.failed. */
export async function applyRefundWebhook(refundEntity, eventName) {
  if (!refundEntity?.id) return null;
  const key = refundEntity.notes?.refund_key;
  const order =
    (await Order.findOne({ "refunds.providerRefundId": refundEntity.id })) ||
    (key ? await Order.findOne({ "refunds.key": key }) : null);
  if (!order) return null;
  const row = order.refunds.find((r) => r.providerRefundId === refundEntity.id || (key && r.key === key));
  if (!row) return null;
  if (eventName === "refund.processed") return markRefundProcessed(order._id, row.key, refundEntity.id);
  if (eventName === "refund.failed") {
    // Only the attempt this row currently tracks (or none): a late failure of an earlier attempt
    // must not reset a newer attempt that is still processing.
    await Order.updateOne(
      {
        _id: order._id,
        refunds: { $elemMatch: { key: row.key, status: { $ne: "processed" }, providerRefundId: { $in: [refundEntity.id, ""] } } },
      },
      { $set: { "refunds.$.status": "failed", "refunds.$.providerRefundId": "", "refunds.$.lastError": "Razorpay refund failed", "refunds.$.lockedUntil": null } }
    );
    await emitOrderUpdated(order._id);
  }
  return order;
}

/**
 * Refunds pending at Razorpay whose webhook never arrived: once lockedUntil passes, lease the row
 * again, ask Razorpay for the refund's status and finalise it (processed / failed -> retried).
 */
async function pollProviderRefunds({ limit, now }) {
  const due = {
    status: "processing",
    providerRefundId: { $ne: "" },
    $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
  };
  const orders = await Order.find({ refunds: { $elemMatch: due } }).select("_id refunds").limit(limit).lean();
  let done = 0;
  for (const order of orders) {
    for (const row of order.refunds) {
      if (row.status !== "processing" || !row.providerRefundId) continue;
      if (row.lockedUntil && new Date(row.lockedUntil) >= now) continue;
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, refunds: { $elemMatch: { ...due, key: row.key, providerRefundId: row.providerRefundId } } },
        { $set: { "refunds.$.lockedUntil": new Date(now.getTime() + POLL_AFTER_MS) } }
      );
      if (!claimed) continue;
      try {
        const remote = await fetchRefund(row.paymentId, row.providerRefundId);
        if (remote?.status === "processed") {
          if (await markRefundProcessed(order._id, row.key, row.providerRefundId)) done += 1;
        } else if (remote?.status === "failed") {
          await Order.updateOne(
            { _id: order._id, refunds: { $elemMatch: { key: row.key, status: "processing", providerRefundId: row.providerRefundId } } },
            { $set: { "refunds.$.status": "failed", "refunds.$.providerRefundId": "", "refunds.$.lastError": "Razorpay refund failed", "refunds.$.lockedUntil": null } }
          );
          await emitOrderUpdated(order._id);
          done += 1;
        }
      } catch (err) {
        console.error("refund status poll failed", String(order._id), row.key, err.message);
      }
    }
  }
  return done;
}

/** Job: retry pending / failed refunds whose lease has expired; poll ones pending at Razorpay. */
export async function processPendingRefunds({ limit = 25 } = {}) {
  const now = new Date();
  const orders = await Order.find({
    refunds: {
      $elemMatch: {
        method: RAZORPAY_METHOD,
        status: { $in: ["pending", "failed", "processing"] },
        providerRefundId: "",
        attempts: { $lt: MAX_ATTEMPTS },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
      },
    },
  })
    .select("_id refunds")
    .limit(limit)
    .lean();
  let done = 0;
  for (const order of orders) {
    for (const row of order.refunds) {
      if (row.providerRefundId || !["pending", "failed", "processing"].includes(row.status)) continue;
      if (row.method && row.method !== "razorpay") continue;
      if (await processRefund(order._id, row.key)) done += 1;
    }
  }
  done += await pollProviderRefunds({ limit, now });
  return done;
}

/**
 * Staff retry of a failed refund (including ones that ran out of automatic attempts): resets the
 * attempt counter of that one failed intent and processes it again. Returns the order.
 */
export async function retryFailedRefund(orderId, key) {
  const reset = await Order.findOneAndUpdate(
    { _id: orderId, refunds: { $elemMatch: { key, status: "failed", providerRefundId: "" } } },
    { $set: { "refunds.$.attempts": 0, "refunds.$.lockedUntil": null, "refunds.$.lastError": "" } },
    { new: true }
  );
  if (!reset) return null;
  await processRefund(orderId, key);
  return Order.findById(orderId);
}
