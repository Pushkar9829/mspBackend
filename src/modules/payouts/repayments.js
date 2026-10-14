import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { CreditRepayment } from "./models.js";
import { writeEntries } from "./ledger.js";
import * as ledger from "../ledger/service.js";
import { LedgerEntry } from "../ledger/ledger.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { createRazorpayOrder, razorpayConfigured, hmac, signaturesMatch } from "../checkout/razorpayApi.js";
import { withTransaction } from "../../utils/transaction.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Buyer repays credit / PO dues online through the platform (p4-payouts): a Razorpay order for the
 * amount; on capture (verify or webhook, idempotent) the buyer's ledger gets a `payment` credit
 * (reference = Razorpay payment id) and the seller ledger a `credit_repayment` line (available now).
 */

function assertId(value, label) {
  if (!mongoose.isValidObjectId(value)) throw new AppError(400, `Invalid ${label}`, "VALIDATION_ERROR");
}

export async function createRepaymentOrder(user, tenantId, { amount }) {
  assertId(tenantId, "store id");
  if (!razorpayConfigured()) throw new AppError(503, "Online payment is not configured", "PAYMENT_UNAVAILABLE");
  const account = await ledger.findLedger(user._id, tenantId);
  if (!account) throw new AppError(404, "You have no credit account with this store", "NOT_FOUND");
  const view = ledger.presentLedger(account);
  const paise = ledger.toPaise(amount);
  if (!(paise >= 100)) throw new AppError(400, "Online payments must be at least ₹1", "PAYMENT_AMOUNT");
  if (view.outstandingPaise <= 0) throw new AppError(400, "Nothing is due on this account", "NOTHING_DUE");
  if (paise > view.outstandingPaise) {
    throw new AppError(400, `You can pay up to ₹${(view.outstandingPaise / 100).toFixed(2)} (the amount due)`, "AMOUNT_EXCEEDS_DUE");
  }
  const tenant = await Tenant.findById(tenantId).select("name").lean();
  const created = await createRazorpayOrder({
    amount: paise,
    receipt: `crp_${String(user._id).slice(-8)}_${Date.now().toString(36)}`.slice(0, 40),
    notes: { purpose: "credit_repayment", tenant_id: String(tenantId), user_id: String(user._id) },
  });
  if (!created?.id) throw new AppError(502, "Razorpay did not create the order", "PAYMENT_PROVIDER_ERROR");
  const row = await CreditRepayment.create({ userId: user._id, tenantId, razorpayOrderId: created.id, amountPaise: paise });
  return {
    repaymentId: row._id,
    keyId: env.razorpayKeyId,
    orderId: created.id,
    amount: paise,
    currency: "INR",
    description: `Payment to ${tenant?.name || "store"} (credit account)`,
  };
}

/**
 * Settle a captured repayment exactly once (CreditRepayment created -> paid claim in the same
 * transaction as both ledger writes). Returns { repayment, account, already }.
 */
export async function settleRepayment(razorpayOrderId, payment) {
  const paidPaise = Math.round(Number(payment?.amount) || 0);
  const paymentId = String(payment?.id || "");
  if (!paymentId || !(paidPaise > 0)) throw new AppError(400, "Payment amount missing", "VALIDATION_ERROR");
  return withTransaction(async (session) => {
    const row = await CreditRepayment.findOneAndUpdate(
      { razorpayOrderId, status: "created" },
      { $set: { status: "paid", razorpayPaymentId: paymentId, paidPaise, paidAt: new Date() } },
      { new: true, session }
    );
    if (!row) {
      const current = await CreditRepayment.findOne({ razorpayOrderId }, null, { session });
      if (!current) throw new AppError(404, "Repayment not found", "NOT_FOUND");
      return { repayment: current, account: ledger.presentLedger(await ledger.findLedger(current.userId, current.tenantId, session)), already: true };
    }
    const existing = await LedgerEntry.exists({ tenantId: row.tenantId, userId: row.userId, kind: "payment", referenceKey: ledger.paymentReferenceKey(paymentId) }).session(session);
    let account;
    if (!existing) {
      account = await ledger.applyEntry({
        userId: row.userId,
        tenantId: row.tenantId,
        type: "credit",
        kind: "payment",
        amountPaise: paidPaise,
        reference: paymentId,
        note: `Online payment (Razorpay ${paymentId})`,
        session,
      });
    } else {
      account = await ledger.findLedger(row.userId, row.tenantId, session);
    }
    await writeEntries(
      [
        {
          tenantId: row.tenantId,
          key: `credit_repayment:${paymentId}`,
          kind: "credit_repayment",
          amountPaise: paidPaise,
          availableAt: new Date(),
          memo: "Buyer credit repayment (online)",
          data: { paymentId, razorpayOrderId, userId: String(row.userId) },
        },
      ],
      { session }
    );
    return { repayment: row, account: ledger.presentLedger(account), already: false };
  });
}

export async function verifyRepayment(user, tenantId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  assertId(tenantId, "store id");
  if (!razorpayConfigured()) throw new AppError(503, "Online payment is not configured", "PAYMENT_UNAVAILABLE");
  const expected = hmac(env.razorpayKeySecret, `${razorpayOrderId}|${razorpayPaymentId}`);
  if (!signaturesMatch(expected, razorpaySignature)) throw new AppError(400, "Payment signature did not match", "PAYMENT_SIGNATURE");
  const row = await CreditRepayment.findOne({ razorpayOrderId, userId: user._id, tenantId }).lean();
  if (!row) throw new AppError(404, "Repayment not found", "NOT_FOUND");
  const { readCapturedPayment } = await import("../checkout/razorpay.js");
  const payment = await readCapturedPayment(razorpayPaymentId, { expectedOrderId: razorpayOrderId });
  const res = await settleRepayment(razorpayOrderId, payment);
  return {
    repayment: { id: res.repayment._id, status: res.repayment.status, amountPaise: res.repayment.paidPaise || res.repayment.amountPaise, razorpayPaymentId: res.repayment.razorpayPaymentId },
    account: res.account,
    already: res.already,
  };
}

/** Webhook payment.captured / order.paid for a repayment order. False when the order is not one. */
export async function settleRepaymentFromWebhook(razorpayOrderId, payment) {
  const row = await CreditRepayment.findOne({ razorpayOrderId }).select("_id").lean();
  if (!row) return false;
  let entity = payment;
  try {
    const { fetchPayment, capturePayment } = await import("../checkout/razorpayApi.js");
    if (payment?.id && razorpayConfigured()) {
      const live = await fetchPayment(payment.id);
      if (live?.order_id && live.order_id !== razorpayOrderId) throw new AppError(400, "Webhook payment does not match the Razorpay order", "PAYMENT_ORDER");
      const settled = live?.status === "authorized" ? await capturePayment(live.id, live.amount) : live;
      if (settled?.status && settled.status !== "captured") return true; // not captured yet; a later event settles it
      entity = { ...(payment || {}), ...(live || {}), ...(settled || {}) };
    }
  } catch (err) {
    if (err?.code === "PAYMENT_ORDER") throw err;
  }
  await settleRepayment(razorpayOrderId, entity);
  return true;
}
