import { Order } from "../orders/order.model.js";
import { createRefund, fetchRefund, toPaise } from "./razorpayApi.js";
import { withSession, afterCommit } from "../../utils/transaction.js";
import { emitDomain } from "../../utils/events.js";
import { orderUpdatedAfterCommit, emitOrderUpdated } from "../orders/events.js";

const LOCK_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 8;
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
    orderUpdatedAfterCommit(session, order);
    afterCommit(session, () => processRefund(order._id, key));
    return true;
  }
  return false;
}

async function markRefundProcessed(orderId, key, providerRefundId) {
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, refunds: { $elemMatch: { key, status: { $ne: "processed" } } } },
    {
      $set: {
        "refunds.$.status": "processed",
        "refunds.$.providerRefundId": providerRefundId || "",
        "refunds.$.processedAt": new Date(),
        "refunds.$.lockedUntil": null,
      },
    },
    { new: true }
  );
  if (!updated) return null;
  const refunded = updated.refunds
    .filter((r) => r.status === "processed" && !isStrayRefundKey(r.key))
    .reduce((s, r) => s + r.amount, 0);
  if (refunded + 0.005 >= Number(updated.total)) {
    await Order.updateOne({ _id: orderId, paymentStatus: { $ne: "refunded" } }, { $set: { paymentStatus: "refunded" } });
  }
  emitDomain("ORDER_REFUND_PROCESSED", { orderId, key, providerRefundId, tenantId: updated.tenantId, buyerId: updated.buyerId });
  await emitOrderUpdated(orderId);
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
      if (row.providerRefundId || row.status === "processed") continue;
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
