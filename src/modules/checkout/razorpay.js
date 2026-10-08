import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { Order, orderEventPayload } from "../orders/order.model.js";
import { payAndConfirm } from "../orders/lifecycle.js";
import { queueRefund, applyRefundWebhook } from "./refunds.js";
import { withTransaction } from "../../utils/transaction.js";
import { emitDomain } from "../../utils/events.js";
import { orderUpdatedAfterCommit, emitOrderUpdated } from "../orders/events.js";
import { RazorpayOrder } from "./razorpayOrder.model.js";
import {
  ONLINE_PAYMENT_METHODS,
  toPaise,
  hmac,
  signaturesMatch,
  razorpayConfigured,
  createRazorpayOrder,
} from "./razorpayApi.js";

export { ONLINE_PAYMENT_METHODS, toPaise, razorpayConfigured };

export function razorpayCheckoutPayload(orders) {
  const amount = orders.reduce((sum, order) => sum + toPaise(order.total), 0);
  return {
    keyId: env.razorpayKeyId,
    orderId: orders[0].razorpayOrderId,
    amount,
    currency: "INR",
  };
}

/** Orders of one checkout that can still be paid online. */
export function payableOrders(orders) {
  return orders.filter(
    (order) => ONLINE_PAYMENT_METHODS.includes(order.paymentMethod) && order.status === "pending" && order.paymentStatus !== "paid"
  );
}

/**
 * One Razorpay order covers every payable seller order of a checkout. Ids are set with a
 * conditional update inside a transaction (only when the orders still point to `expectedId`),
 * so two concurrent requests can never overwrite each other's Razorpay order id.
 */
export async function attachRazorpay(orders, { expectedId = "" } = {}) {
  const payable = payableOrders(orders);
  if (!payable.length) throw new AppError(400, "Nothing left to pay on this order", "INVALID_STATE");
  const amount = payable.reduce((sum, order) => sum + toPaise(order.total), 0);
  if (amount < 100) throw new AppError(400, "Online payments must be at least ₹1", "PAYMENT_AMOUNT");
  const created = await createRazorpayOrder({
    amount,
    receipt: String(payable[0].orderNumber).slice(0, 40),
    notes: { orders: payable.map((order) => order.orderNumber).join(",").slice(0, 240) },
  });
  const ids = payable.map((order) => order._id);
  // Durable record of what this Razorpay order covers, so a payment that lands after the
  // seller orders moved on to a newer Razorpay order can still be fully accounted for.
  await RazorpayOrder.updateOne({ _id: created.id }, { $setOnInsert: { orderIds: ids, amountPaise: amount } }, { upsert: true });
  const attached = await withTransaction(async (session) => {
    const current = await Order.find({ _id: { $in: ids } }).session(session);
    const stillExpected = current.every(
      (row) => (row.razorpayOrderId || "") === expectedId && row.status === "pending" && row.paymentStatus !== "paid"
    );
    if (!stillExpected) return null;
    for (const row of current) {
      const update = {
        $set: { razorpayOrderId: created.id, razorpayAmountPaise: amount, paymentStatus: "pending" },
      };
      if (row.razorpayOrderId) update.$addToSet = { razorpayOrderHistory: row.razorpayOrderId };
      await Order.updateOne({ _id: row._id, razorpayOrderId: row.razorpayOrderId || { $in: ["", null] } }, update, { session });
      orderUpdatedAfterCommit(session, row);
    }
    return true;
  });
  const fresh = await Order.find({ _id: { $in: ids } }).sort({ createdAt: 1 });
  if (!attached) {
    // Someone else attached first: reuse theirs when it still covers exactly these orders.
    const shared = fresh[0]?.razorpayOrderId;
    if (shared && fresh.every((row) => row.razorpayOrderId === shared && row.razorpayAmountPaise === amount)) {
      return { ...razorpayCheckoutPayload(fresh), orders: fresh };
    }
    throw new AppError(409, "Payment was started in another tab. Refresh and try again.", "PAYMENT_CONFLICT");
  }
  return { ...razorpayCheckoutPayload(fresh), orders: fresh };
}

/**
 * Payment captured for a Razorpay order. It covers the seller orders it was created for
 * (RazorpayOrder record; legacy: orders referencing it now or in their history). Each is
 * handled in its own transaction:
 *  - pending + unpaid  -> paid + confirmed (stock committed, invoice issued, ORDER_PAID emitted),
 *                         also when the order has since moved on to a newer Razorpay order
 *  - cancelled (still on this Razorpay order) -> recorded as paid and refunded (late payment)
 *  - already paid      -> no-op (webhook + client verify both arrive)
 * The captured amount must match what the Razorpay order was created for (else it is refunded
 * in full). Whatever part of the captured amount did not end up on an order paid by this
 * payment is refunded once, keyed `stray:${paymentId}`.
 */
export async function markRazorpayPaid(razorpayOrderId, razorpayPaymentId, amountPaise = null) {
  const record = await RazorpayOrder.findById(razorpayOrderId).lean();
  const current = await Order.find({ razorpayOrderId }).sort({ createdAt: 1 });
  const groupFilter = record?.orderIds?.length
    ? { $or: [{ _id: { $in: record.orderIds } }, { razorpayOrderId }] }
    : { $or: [{ razorpayOrderId }, { razorpayOrderHistory: razorpayOrderId }] };
  const group = await Order.find(groupFilter).sort({ createdAt: 1, _id: 1 });
  if (!group.length) return [];
  const anchor = group[0]; // deterministic home for mismatch / stray refund intents
  const expected =
    record?.amountPaise ??
    (current.length ? current[0].razorpayAmountPaise || current.reduce((s, o) => s + toPaise(o.total), 0) : null);
  const captured = amountPaise != null ? Number(amountPaise) : expected;
  if (captured == null) return current; // legacy superseded order, amount unknown: the webhook carries it

  if (expected != null && captured !== expected) {
    console.error("razorpay amount mismatch", razorpayOrderId, captured, expected);
    await withTransaction((session) =>
      queueRefund(anchor, {
        key: `mismatch:${razorpayPaymentId}`,
        amount: captured / 100,
        paymentId: razorpayPaymentId,
        reason: "Paid amount did not match the order",
        session,
      })
    );
    emitDomain("PAYMENT_MISMATCH", { razorpayOrderId, razorpayPaymentId, amountPaise: captured, expected });
    return Order.find({ razorpayOrderId });
  }

  let budget = captured;
  for (const order of group) {
    const share = toPaise(order.total);
    if (order.paymentStatus === "paid" || order.paymentStatus === "refunded") {
      if (razorpayPaymentId && order.razorpayPaymentId === razorpayPaymentId) budget -= share; // replayed event
      continue;
    }
    const onThis = order.razorpayOrderId === razorpayOrderId;
    if (order.status === "pending" && ONLINE_PAYMENT_METHODS.includes(order.paymentMethod) && share <= budget) {
      try {
        await payAndConfirm(order, { paymentId: razorpayPaymentId });
        budget -= share;
        continue;
      } catch (err) {
        if (err.code !== "INVALID_STATE" && err.code !== "RESERVATION_MISSING" && err.code !== "INVENTORY_DRIFT") throw err;
        // Fall through: the order changed under us (e.g. cancelled) or its stock is gone.
        if (err.code !== "INVALID_STATE") {
          const paid = await Order.findOneAndUpdate(
            { _id: order._id, status: "pending", paymentStatus: { $ne: "paid" } },
            { $set: { paymentStatus: "paid", razorpayPaymentId, paidAt: new Date() } },
            { new: true }
          );
          if (paid) {
            budget -= share;
            emitDomain("ORDER_PAID", orderEventPayload(paid, { paymentId: razorpayPaymentId, needsReview: true }));
            await emitOrderUpdated(paid);
            continue;
          }
        }
      }
    }
    // Superseded orders that can no longer take this payment are covered by the stray refund below.
    if (!onThis || share > budget) continue;
    // Late payment: the order was cancelled (e.g. by the timeout job). Record it and refund.
    const lateApplied = await withTransaction(async (session) => {
      const late = await Order.findOneAndUpdate(
        { _id: order._id, status: "cancelled", paymentStatus: { $nin: ["paid", "refunded"] } },
        { $set: { paymentStatus: "paid", razorpayPaymentId, paidAt: new Date() } },
        { new: true, session }
      );
      if (!late) return false;
      orderUpdatedAfterCommit(session, late);
      await queueRefund(late, {
        key: `${late._id}:late-payment`,
        amount: late.total,
        paymentId: razorpayPaymentId,
        reason: "Payment arrived after the order was cancelled",
        session,
      });
      return true;
    });
    if (lateApplied) budget -= share;
  }

  // Account for every paisa captured: whatever did not land on an order paid by this payment
  // (paid+confirmed, or late-paid and refunded on its own) goes back once as a stray refund.
  // Recomputed from stored state so a duplicate webhook / client verify yields the same result.
  if (razorpayPaymentId) {
    const settled = await Order.find({ _id: { $in: group.map((o) => o._id) }, razorpayPaymentId }).select("total").lean();
    const applied = settled.reduce((s, o) => s + toPaise(o.total), 0);
    const stray = captured - applied;
    if (stray > 0) {
      await withTransaction((session) =>
        queueRefund(anchor, {
          key: `stray:${razorpayPaymentId}`,
          amount: stray / 100,
          paymentId: razorpayPaymentId,
          reason: "Payment for a superseded payment link",
          session,
        })
      );
    }
  }
  return Order.find({ razorpayOrderId }).sort({ createdAt: 1 });
}

export async function verifyRazorpayPayment({ user, razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  if (!razorpayConfigured()) {
    throw new AppError(503, "Online payment is not configured", "PAYMENT_UNAVAILABLE");
  }
  const expected = hmac(env.razorpayKeySecret, `${razorpayOrderId}|${razorpayPaymentId}`);
  if (!signaturesMatch(expected, razorpaySignature)) {
    throw new AppError(400, "Payment signature did not match", "PAYMENT_SIGNATURE");
  }
  const owned = await Order.find({
    buyerId: user._id,
    $or: [{ razorpayOrderId }, { razorpayOrderHistory: razorpayOrderId }],
  });
  if (!owned.length) throw new AppError(404, "Order not found for this payment", "NOT_FOUND");
  return markRazorpayPaid(razorpayOrderId, razorpayPaymentId);
}

/**
 * Re-open Razorpay for an unpaid online order and its still-payable siblings. A new Razorpay
 * order is created whenever the payable set or amount differs from the existing one (e.g. a
 * sibling was cancelled), so the buyer is never charged for cancelled orders.
 */
export async function resumeRazorpayPayment({ user, orderId }) {
  const order = await Order.findOne({ _id: orderId, buyerId: user._id });
  if (!order) throw new AppError(404, "Order not found", "NOT_FOUND");
  if (!ONLINE_PAYMENT_METHODS.includes(order.paymentMethod)) {
    throw new AppError(400, "This order is not paid online", "PAYMENT_METHOD");
  }
  if (order.paymentStatus === "paid") return { orders: [order], razorpay: null, paid: true };
  if (order.status !== "pending") {
    throw new AppError(400, "This order can no longer be paid", "INVALID_STATE");
  }
  const siblings = order.idempotencyKey
    ? await Order.find({ buyerId: user._id, idempotencyKey: order.idempotencyKey }).sort({ createdAt: 1 })
    : [order];
  const payable = payableOrders(siblings);
  if (!payable.length) return { orders: siblings, razorpay: null, paid: true };
  return presentPayment(payable);
}

/** A Razorpay order's record (when it has one) must list exactly these orders for this amount. */
async function coversExactly(razorpayOrderId, payable, amount) {
  const record = await RazorpayOrder.findById(razorpayOrderId).lean();
  if (!record) return true; // created before records existed
  const ids = new Set(record.orderIds.map(String));
  return record.amountPaise === amount && ids.size === payable.length && payable.every((row) => ids.has(String(row._id)));
}

/** Reuse the attached Razorpay order only when it covers exactly the payable orders. */
export async function presentPayment(payable) {
  const amount = payable.reduce((sum, row) => sum + toPaise(row.total), 0);
  const shared = payable[0].razorpayOrderId;
  const reusable =
    shared &&
    payable.every((row) => row.razorpayOrderId === shared) &&
    payable[0].razorpayAmountPaise === amount &&
    (await Order.countDocuments({ razorpayOrderId: shared })) === payable.length &&
    (await coversExactly(shared, payable, amount));
  if (reusable) return { orders: payable, razorpay: razorpayCheckoutPayload(payable), paid: false };
  const sameExpected = payable.every((row) => (row.razorpayOrderId || "") === (shared || ""));
  if (!sameExpected) {
    // Mixed ids: detach each to a fresh order one at a time is not possible atomically; ask to retry.
    throw new AppError(409, "Payment state changed. Refresh and try again.", "PAYMENT_CONFLICT");
  }
  const result = await attachRazorpay(payable, { expectedId: shared || "" });
  const { orders, ...razorpay } = result;
  return { orders, razorpay, paid: false };
}

export async function handleRazorpayWebhook(rawBody, signature) {
  if (!env.razorpayWebhookSecret) {
    throw new AppError(503, "Razorpay webhook secret is not configured", "PAYMENT_UNAVAILABLE");
  }
  const expected = hmac(env.razorpayWebhookSecret, rawBody);
  if (!signaturesMatch(expected, signature)) {
    throw new AppError(400, "Webhook signature did not match", "PAYMENT_SIGNATURE");
  }
  let event;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new AppError(400, "Invalid webhook payload", "VALIDATION_ERROR");
  }
  return processRazorpayEvent(event);
}

/** Exposed separately so tests can drive events without signing them. */
export async function processRazorpayEvent(event) {
  const name = event?.event;
  const payment = event?.payload?.payment?.entity;
  const rzpOrder = event?.payload?.order?.entity;
  const refund = event?.payload?.refund?.entity;
  if ((name === "payment.captured" || name === "order.paid") && (payment?.order_id || rzpOrder?.id)) {
    await markRazorpayPaid(payment?.order_id || rzpOrder.id, payment?.id || "", payment?.amount ?? rzpOrder?.amount_paid ?? null);
  } else if (name === "payment.failed" && payment?.order_id) {
    const failing = await Order.find({ razorpayOrderId: payment.order_id, status: "pending", paymentStatus: "pending" }).select("_id").lean();
    if (failing.length) {
      await Order.updateMany(
        { _id: { $in: failing.map((o) => o._id) }, status: "pending", paymentStatus: "pending" },
        { $set: { paymentStatus: "failed" } }
      );
      await emitOrderUpdated(failing);
    }
  } else if ((name === "refund.processed" || name === "refund.failed") && refund) {
    await applyRefundWebhook(refund, name);
  }
  return { ok: true };
}
