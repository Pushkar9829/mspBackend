import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { logger } from "../../utils/logger.js";
import { withTransaction, withSession } from "../../utils/transaction.js";
import {
  toPaise,
  hmac,
  signaturesMatch,
  razorpayConfigured,
  createRazorpayOrder,
  fetchPayment,
  capturePayment,
  createRazorpayPlan,
  createRazorpaySubscription,
  updateRazorpaySubscription,
  cancelRazorpaySubscription,
  createRazorpayPaymentLink,
  fetchRazorpaySubscription,
} from "../checkout/razorpayApi.js";
import { Plan, planPrice, snapshotOf, LEGACY_PLAN_CODE } from "./plan.model.js";
import { TenantSubscription } from "./subscription.model.js";
import { SubscriptionInvoice } from "./invoice.model.js";
import { SUBSCRIPTION_GST_RATE, round2 } from "./invoicing.js";
import {
  issuePeriodInvoice,
  markInvoicePaid,
  needsFirstPurchase,
  invalidateTenantEntitlements,
  presentInvoice,
  getInvoice,
} from "./service.js";

/**
 * Razorpay side of seller billing:
 *  - autopay = Razorpay Subscriptions (one Razorpay plan per our plan + interval, created lazily at
 *    the GST-inclusive amount; one Razorpay subscription per store);
 *  - manual invoices paid online through a Razorpay order (checkout + signature verify) or a
 *    payment link;
 *  - webhook branch (called from checkout/razorpay.js processRazorpayEvent).
 */

const ACTIVE_RZP = ["created", "authenticated", "active", "pending"];
const withGst = (amount) => round2(amount * (1 + SUBSCRIPTION_GST_RATE / 100));

function requireConfigured() {
  if (!razorpayConfigured()) throw new AppError(503, "Online payment is not configured. Add Razorpay keys.", "PAYMENT_UNAVAILABLE");
}

/** Razorpay plan id for (plan, interval), created on first use and stored on the plan. */
export async function ensureRazorpayPlan(plan, interval) {
  const field = `razorpayPlanIds.${interval}`;
  const fresh = await Plan.findById(plan._id).lean();
  if (fresh?.razorpayPlanIds?.[interval]) return fresh.razorpayPlanIds[interval];
  const amount = toPaise(withGst(planPrice(fresh, interval)));
  if (amount < 100) throw new AppError(400, "Autopay needs a paid plan", "PAYMENT_AMOUNT");
  const created = await createRazorpayPlan({
    period: interval === "yearly" ? "yearly" : "monthly",
    interval: 1,
    item: { name: `${fresh.name} (${interval})`.slice(0, 120), amount, currency: "INR", description: `Seller subscription, incl. ${SUBSCRIPTION_GST_RATE}% GST` },
    notes: { planId: String(fresh._id), code: fresh.code, interval },
  });
  const set = await Plan.findOneAndUpdate({ _id: fresh._id, [field]: { $in: ["", null] } }, { $set: { [field]: created.id } }, { new: true });
  if (set) return created.id;
  return (await Plan.findById(fresh._id).lean())?.razorpayPlanIds?.[interval] || created.id;
}

/** Which plan + interval autopay should charge for this subscription. */
async function autopayPlanFor(sub) {
  const id = sub.pendingPlanId || sub.planId;
  const plan = id ? await Plan.findById(id) : null;
  if (!plan || plan.code === LEGACY_PLAN_CODE) throw new AppError(409, "Choose a subscription plan first", "PLAN_REQUIRED");
  return { plan, interval: sub.pendingInterval || (String(plan._id) === String(sub.planId) ? sub.planSnapshot?.interval : null) || plan.interval };
}

/**
 * Seller sets up autopay: creates (or returns the not-yet-authorised) Razorpay subscription. When
 * a paid period is running, the first charge is scheduled at its end (start_at); otherwise the
 * first charge happens at authorisation. Activation / charges arrive by webhook.
 */
export async function setupAutopay(tenantId, { by = null } = {}) {
  requireConfigured();
  const sub = await TenantSubscription.findOne({ tenantId });
  if (!sub) throw new AppError(409, "Choose a subscription plan first", "PLAN_REQUIRED");
  if (sub.razorpaySubscriptionId && ACTIVE_RZP.includes(sub.razorpaySubscriptionStatus)) {
    if (sub.razorpaySubscriptionStatus === "created" && sub.razorpayShortUrl) {
      return { razorpaySubscriptionId: sub.razorpaySubscriptionId, shortUrl: sub.razorpayShortUrl, keyId: env.razorpayKeyId, status: "created" };
    }
    throw new AppError(409, "Autopay is already set up", "AUTOPAY_ACTIVE");
  }
  const { plan, interval } = await autopayPlanFor(sub);
  const planId = await ensureRazorpayPlan(plan, interval);
  const body = {
    plan_id: planId,
    total_count: interval === "yearly" ? 10 : 120,
    quantity: 1,
    customer_notify: 1,
    notes: { tenantId: String(tenantId), subscriptionId: String(sub._id), planId: String(plan._id), interval },
  };
  const running = !needsFirstPurchase(sub) && sub.status === "active" && sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > Date.now() + 5 * 60 * 1000;
  if (running) body.start_at = Math.floor(sub.currentPeriodEnd.getTime() / 1000);
  const created = await createRazorpaySubscription(body);
  await TenantSubscription.updateOne(
    { _id: sub._id },
    {
      $set: { razorpaySubscriptionId: created.id, razorpaySubscriptionStatus: created.status || "created", razorpayShortUrl: created.short_url || "" },
      $push: { history: { $each: [{ at: new Date(), action: "autopay_created", by, data: { razorpaySubscriptionId: created.id, planId: String(plan._id), interval } }], $slice: -300 } },
    }
  );
  return { razorpaySubscriptionId: created.id, shortUrl: created.short_url || "", keyId: env.razorpayKeyId, status: created.status || "created" };
}

/**
 * Checkout handler for the autopay mandate (signature = HMAC(payment_id|subscription_id)).
 * Only switches the mode on once Razorpay reports the subscription authenticated/active; charges
 * are still recorded from the subscription.charged webhook (the mandate payment can be a small
 * authorisation amount when autopay starts at the next renewal).
 */
export async function verifyAutopay(tenantId, { razorpaySubscriptionId, razorpayPaymentId, razorpaySignature }, { by = null } = {}) {
  requireConfigured();
  const sub = await TenantSubscription.findOne({ tenantId });
  if (!sub || !sub.razorpaySubscriptionId || sub.razorpaySubscriptionId !== razorpaySubscriptionId) {
    throw new AppError(400, "This mandate is for a different subscription", "PAYMENT_ORDER");
  }
  const expected = hmac(env.razorpayKeySecret, `${razorpayPaymentId}|${razorpaySubscriptionId}`);
  if (!signaturesMatch(expected, razorpaySignature)) throw new AppError(400, "Payment signature did not match", "PAYMENT_SIGNATURE");
  const remote = await fetchRazorpaySubscription(razorpaySubscriptionId);
  const status = remote?.status || "";
  if (["authenticated", "active"].includes(status) && sub.razorpaySubscriptionStatus !== status) {
    await TenantSubscription.updateOne(
      { _id: sub._id },
      {
        $set: { razorpaySubscriptionStatus: status, billingMode: "autopay", razorpayShortUrl: "" },
        $push: { history: { $each: [{ at: new Date(), action: "autopay_" + status, by, data: { razorpayStatus: status, via: "checkout" } }], $slice: -300 } },
      }
    );
    await invalidateTenantEntitlements(sub.tenantId);
  }
  return { status: status || sub.razorpaySubscriptionStatus || "created", billingMode: ["authenticated", "active"].includes(status) ? "autopay" : sub.billingMode };
}

export async function cancelAutopayAtRazorpay(sub) {
  if (!sub.razorpaySubscriptionId) return null;
  requireConfigured();
  return cancelRazorpaySubscription(sub.razorpaySubscriptionId, { cancelAtCycleEnd: false });
}

/** Seller turns autopay off: Razorpay subscription cancelled, renewals by invoice again. */
export async function cancelAutopay(tenantId, { by = null } = {}) {
  const sub = await TenantSubscription.findOne({ tenantId });
  if (!sub?.razorpaySubscriptionId || !ACTIVE_RZP.includes(sub.razorpaySubscriptionStatus)) {
    throw new AppError(409, "Autopay is not set up", "AUTOPAY_NOT_SET_UP");
  }
  await cancelAutopayAtRazorpay(sub);
  await TenantSubscription.updateOne(
    { _id: sub._id },
    {
      $set: { billingMode: "manual", razorpaySubscriptionStatus: "cancelled", razorpayShortUrl: "" },
      $push: { history: { $each: [{ at: new Date(), action: "autopay_cancelled", from: sub.billingMode, to: "manual", by }], $slice: -300 } },
    }
  );
  await invalidateTenantEntitlements(tenantId);
  return { ok: true };
}

/** Autopay plan change at Razorpay: "now" (upgrade) or "cycle_end" (downgrade / price change). */
export async function syncAutopayPlanChange(sub, plan, interval, when = "cycle_end") {
  requireConfigured();
  const planId = await ensureRazorpayPlan(plan, interval);
  return updateRazorpaySubscription(sub.razorpaySubscriptionId, { plan_id: planId, schedule_change_at: when, customer_notify: 1 });
}

/** After a plan price change: move live autopay subscriptions to the new Razorpay plan at cycle end. */
export async function syncAutopayPlanPrice(plan) {
  if (!razorpayConfigured()) return { updated: 0 };
  const subs = await TenantSubscription.find({
    billingMode: "autopay",
    razorpaySubscriptionId: { $gt: "" },
    razorpaySubscriptionStatus: { $in: ACTIVE_RZP },
    $or: [{ planId: plan._id, pendingPlanId: null }, { pendingPlanId: plan._id }],
  }).limit(1000);
  let updated = 0;
  for (const sub of subs) {
    try {
      await syncAutopayPlanChange(sub, plan, sub.pendingInterval || sub.planSnapshot?.interval || plan.interval, "cycle_end");
      updated += 1;
    } catch (err) {
      logger.error("autopay price sync", { subscription: String(sub._id), err: err.message });
    }
  }
  return { updated };
}

/* --------------------------------------------------------------- manual invoice paid online */

/**
 * Seller pays an issued invoice online. method "order" (default): Razorpay order for checkout
 * (reused while the invoice is open), then POST .../verify. method "link": Razorpay payment link
 * (short_url), confirmed by the payment_link.paid webhook.
 */
export async function createInvoicePayment(tenantId, invoiceId, { method = "order" } = {}) {
  requireConfigured();
  const inv = await getInvoice(invoiceId, { tenantId });
  if (inv.status !== "issued") throw new AppError(409, `This invoice is ${inv.status}`, "INVALID_STATE");
  const amount = toPaise(inv.total);
  if (amount < 100) throw new AppError(400, "Online payments must be at least Rs. 1", "PAYMENT_AMOUNT");
  if (method === "link") {
    if (!inv.payment?.razorpayPaymentLinkId) {
      const link = await createRazorpayPaymentLink({
        amount,
        description: `Subscription invoice ${inv.number}`,
        reference_id: inv.number,
        notes: { kind: "subscription_invoice", invoiceId: String(inv._id), tenantId: String(tenantId) },
      });
      await SubscriptionInvoice.updateOne(
        { _id: inv._id, "payment.razorpayPaymentLinkId": { $in: ["", null] } },
        { $set: { "payment.razorpayPaymentLinkId": link.id, "payment.shortUrl": link.short_url || "" } }
      );
    }
    const fresh = await SubscriptionInvoice.findById(inv._id).lean();
    return { invoiceId: inv._id, method: "link", paymentLinkId: fresh.payment.razorpayPaymentLinkId, shortUrl: fresh.payment.shortUrl, amount, currency: "INR" };
  }
  if (!inv.payment?.razorpayOrderId) {
    const order = await createRazorpayOrder({
      amount,
      receipt: String(inv.number).slice(0, 40),
      notes: { kind: "subscription_invoice", invoiceId: String(inv._id), tenantId: String(tenantId) },
    });
    await SubscriptionInvoice.updateOne(
      { _id: inv._id, "payment.razorpayOrderId": { $in: ["", null] } },
      { $set: { "payment.razorpayOrderId": order.id } }
    );
  }
  const fresh = await SubscriptionInvoice.findById(inv._id).lean();
  return {
    invoiceId: inv._id,
    method: "order",
    keyId: env.razorpayKeyId,
    orderId: fresh.payment.razorpayOrderId,
    amount,
    currency: "INR",
    description: `Subscription invoice ${inv.number}`,
  };
}

/** Razorpay's view of the payment decides; capture on manual-capture accounts. */
async function capturedPayment(paymentId, { orderId, amount }) {
  let payment = await fetchPayment(paymentId);
  if (!payment?.id) throw new AppError(502, "Razorpay did not return the payment", "PAYMENT_PROVIDER_ERROR");
  if (orderId && payment.order_id && payment.order_id !== orderId) throw new AppError(400, "This payment is for a different order", "PAYMENT_ORDER");
  if (payment.currency && payment.currency !== "INR") throw new AppError(400, "Payment currency must be INR", "PAYMENT_CURRENCY");
  if (payment.status === "authorized") payment = await capturePayment(payment.id, payment.amount ?? amount);
  if (payment.status !== "captured") throw new AppError(409, "Payment is not captured yet", "PAYMENT_PENDING");
  if (payment.amount != null && Number(payment.amount) !== amount) {
    throw new AppError(400, "Paid amount does not match the invoice", "PAYMENT_AMOUNT");
  }
  return payment;
}

export async function verifyInvoicePayment(tenantId, invoiceId, { razorpayOrderId, razorpayPaymentId, razorpaySignature }, { by = null } = {}) {
  requireConfigured();
  const inv = await getInvoice(invoiceId, { tenantId });
  const expected = hmac(env.razorpayKeySecret, `${razorpayOrderId}|${razorpayPaymentId}`);
  if (!signaturesMatch(expected, razorpaySignature)) throw new AppError(400, "Payment signature did not match", "PAYMENT_SIGNATURE");
  if (!inv.payment?.razorpayOrderId || inv.payment.razorpayOrderId !== razorpayOrderId) {
    throw new AppError(400, "This payment is for a different invoice", "PAYMENT_ORDER");
  }
  if (inv.status === "paid") return presentInvoice(inv);
  const payment = await capturedPayment(razorpayPaymentId, { orderId: razorpayOrderId, amount: toPaise(inv.total) });
  const { invoice } = await markInvoicePaid(inv._id, { method: "razorpay", razorpayPaymentId: payment.id, razorpayOrderId, reference: payment.id }, { by });
  return presentInvoice(invoice);
}

/* --------------------------------------------------------------- webhooks */

async function subscriptionForRzp(rzpSub) {
  const id = rzpSub?.id || "";
  if (id) {
    const sub = await TenantSubscription.findOne({ razorpaySubscriptionId: id });
    if (sub) return sub;
  }
  const notesId = rzpSub?.notes?.subscriptionId;
  if (notesId && /^[a-f\d]{24}$/i.test(String(notesId))) return TenantSubscription.findById(notesId);
  return null;
}

async function setRzpState(sub, status, extra = {}, action = null) {
  const update = { $set: { razorpaySubscriptionStatus: status, ...extra } };
  if (action) update.$push = { history: { $each: [{ at: new Date(), action, data: { razorpayStatus: status } }], $slice: -300 } };
  await TenantSubscription.updateOne({ _id: sub._id }, update);
  await invalidateTenantEntitlements(sub.tenantId);
}

/**
 * Autopay charge (subscription.charged / invoice.paid): a paid platform invoice for the period
 * (first purchase or next renewal) is created from the amount Razorpay collected and applied.
 * Idempotent per Razorpay payment id. A charge for a period already paid by other means is kept
 * as account credit.
 */
export async function recordAutopayCharge(sub, { paymentId, amountPaise, rzpSub = null }) {
  if (!paymentId) return null;
  if (await SubscriptionInvoice.exists({ "payment.razorpayPaymentId": paymentId })) return null;
  const gross = round2(Number(amountPaise || 0) / 100);
  let planOverride = null;
  if (rzpSub?.plan_id) {
    const planDoc = await Plan.findOne({ $or: [{ "razorpayPlanIds.monthly": rzpSub.plan_id }, { "razorpayPlanIds.yearly": rzpSub.plan_id }] });
    if (planDoc) {
      const interval = planDoc.razorpayPlanIds?.yearly === rzpSub.plan_id ? "yearly" : "monthly";
      planOverride = { planDoc, snap: snapshotOf(planDoc, interval) };
    }
  }
  try {
    return await withTransaction(async (session) => {
      const s = await TenantSubscription.findById(sub._id, null, withSession(session));
      if (!planOverride) {
        const id = s.pendingPlanId || s.planId;
        const planDoc = id ? await Plan.findById(id, null, withSession(session)) : null;
        if (planDoc && planDoc.code !== LEGACY_PLAN_CODE) {
          const interval = s.pendingInterval || (String(planDoc._id) === String(s.planId) ? s.planSnapshot?.interval : null) || planDoc.interval;
          planOverride = { planDoc, snap: snapshotOf(planDoc, interval) };
        }
      }
      await TenantSubscription.updateOne(
        { _id: s._id },
        { $set: { billingMode: "autopay", razorpaySubscriptionStatus: rzpSub?.status || "active" } },
        withSession(session)
      );
      const inv = await issuePeriodInvoice(s, {
        session,
        planOverride,
        grossTotal: gross,
        payment: { method: "razorpay", razorpayPaymentId: paymentId, razorpaySubscriptionId: rzpSub?.id || s.razorpaySubscriptionId, reference: paymentId },
      });
      if (inv?.payment?.razorpayPaymentId !== paymentId) {
        // That period was already paid (e.g. by bank transfer): keep the money as credit.
        const credit = round2(gross / (1 + SUBSCRIPTION_GST_RATE / 100));
        await TenantSubscription.updateOne(
          { _id: s._id },
          {
            $inc: { credits: credit },
            $push: { history: { $each: [{ at: new Date(), action: "credit_added", note: "Autopay charge for a period already paid", data: { paymentId, amount: credit } }], $slice: -300 } },
          },
          withSession(session)
        );
      }
      return inv;
    });
  } catch (err) {
    if (err?.code === 11000 && (await SubscriptionInvoice.exists({ "payment.razorpayPaymentId": paymentId }))) return null;
    throw err;
  }
}

/**
 * Billing branch of the Razorpay webhook. Returns true when the event belonged to billing
 * (the order logic is then skipped), false otherwise.
 */
export async function handleBillingRazorpayEvent(event) {
  const name = String(event?.event || "");
  const payload = event?.payload || {};
  const payment = payload.payment?.entity;

  if (name.startsWith("subscription.") || name === "invoice.paid") {
    const rzpInvoice = payload.invoice?.entity;
    const rzpSub = payload.subscription?.entity || (rzpInvoice?.subscription_id ? { id: rzpInvoice.subscription_id } : null);
    if (!rzpSub?.id) return false;
    const sub = await subscriptionForRzp(rzpSub);
    if (!sub) {
      logger.warn("billing webhook: unknown Razorpay subscription", { id: rzpSub.id, event: name });
      return true;
    }
    if (!sub.razorpaySubscriptionId) await TenantSubscription.updateOne({ _id: sub._id }, { $set: { razorpaySubscriptionId: rzpSub.id } });
    switch (name) {
      case "subscription.authenticated":
      case "subscription.activated":
      case "subscription.resumed":
        await setRzpState(sub, rzpSub.status || name.split(".")[1], { billingMode: "autopay", razorpayShortUrl: "" }, "autopay_" + name.split(".")[1]);
        break;
      case "subscription.charged":
      case "invoice.paid": {
        const paymentId = payment?.id || rzpInvoice?.payment_id || "";
        const amount = payment?.amount ?? rzpInvoice?.amount_paid ?? rzpInvoice?.amount ?? 0;
        if (payment?.status && payment.status !== "captured") return true;
        await recordAutopayCharge(sub, { paymentId, amountPaise: amount, rzpSub: payload.subscription?.entity || rzpSub });
        break;
      }
      case "subscription.pending":
        await setRzpState(sub, "pending", {}, "autopay_pending");
        emitDomain("SUBSCRIPTION_PAYMENT_FAILED", { resource: "subscription", tenantId: sub.tenantId, final: false, reason: "Autopay charge failed. Razorpay will retry." });
        break;
      case "subscription.halted":
        await setRzpState(sub, "halted", { billingMode: "manual" }, "autopay_halted");
        emitDomain("SUBSCRIPTION_PAYMENT_FAILED", { resource: "subscription", tenantId: sub.tenantId, final: true, reason: "Autopay stopped after repeated failures. Pay the invoice to keep the store live." });
        break;
      case "subscription.cancelled":
      case "subscription.completed":
      case "subscription.expired":
        await setRzpState(sub, name.split(".")[1], { billingMode: "manual", razorpayShortUrl: "" }, "autopay_" + name.split(".")[1]);
        break;
      default:
        if (rzpSub.status) await setRzpState(sub, rzpSub.status);
    }
    return true;
  }

  if ((name === "payment.captured" || name === "order.paid") && (payment?.order_id || payload.order?.entity?.id)) {
    const orderId = payment?.order_id || payload.order.entity.id;
    const inv = await SubscriptionInvoice.findOne({ "payment.razorpayOrderId": orderId });
    if (!inv) return false;
    if (inv.status === "paid") return true;
    let paymentId = payment?.id || "";
    let amount = payment?.amount ?? payload.order?.entity?.amount_paid ?? null;
    if (paymentId && razorpayConfigured()) {
      const live = await capturedPayment(paymentId, { orderId, amount: toPaise(inv.total) }).catch((err) => {
        if (err.code === "PAYMENT_PENDING") return null;
        throw err;
      });
      if (!live) return true;
      paymentId = live.id;
      amount = live.amount ?? amount;
    }
    if (amount != null && Number(amount) !== toPaise(inv.total)) {
      logger.error("billing webhook: amount mismatch", { invoice: inv.number, amount, expected: toPaise(inv.total) });
      emitDomain("PAYMENT_MISMATCH", { razorpayOrderId: orderId, razorpayPaymentId: paymentId, amountPaise: amount, expected: toPaise(inv.total), subscriptionInvoiceId: inv._id });
      return true;
    }
    if (!paymentId) return true; // order.paid without a payment entity: wait for payment.captured
    await markInvoicePaid(inv._id, { method: "razorpay", razorpayPaymentId: paymentId, razorpayOrderId: orderId, reference: paymentId });
    return true;
  }

  if (name === "payment_link.paid") {
    const link = payload.payment_link?.entity;
    if (!link?.id) return false;
    const inv =
      (await SubscriptionInvoice.findOne({ "payment.razorpayPaymentLinkId": link.id })) ||
      (link.notes?.kind === "subscription_invoice" && /^[a-f\d]{24}$/i.test(String(link.notes.invoiceId || "")) ? await SubscriptionInvoice.findById(link.notes.invoiceId) : null);
    if (!inv) return false;
    if (inv.status === "paid") return true;
    const amount = payment?.amount ?? link.amount_paid ?? null;
    if (amount != null && Number(amount) !== toPaise(inv.total)) {
      logger.error("billing webhook: payment link amount mismatch", { invoice: inv.number, amount });
      return true;
    }
    await markInvoicePaid(inv._id, { method: "razorpay", razorpayPaymentId: payment?.id || "", razorpayPaymentLinkId: link.id, reference: payment?.id || link.id });
    return true;
  }
  return false;
}
