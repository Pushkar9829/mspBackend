import mongoose from "mongoose";
import { Plan, planPrice, snapshotOf, LEGACY_PLAN_CODE, PLAN_INTERVALS, PLAN_LIMIT_KEYS, PLAN_FEATURE_KEYS } from "./plan.model.js";
import { TenantSubscription } from "./subscription.model.js";
import { SubscriptionInvoice } from "./invoice.model.js";
import { billingSettings, recipientFor, computeTotals, nextInvoiceNumber, round2, SUBSCRIPTION_GST_RATE } from "./invoicing.js";
import { Tenant } from "../tenants/tenant.model.js";
import { AppError } from "../../utils/AppError.js";
import { withTransaction, withSession, afterCommit } from "../../utils/transaction.js";
import { emitDomain } from "../../utils/events.js";
import { logger } from "../../utils/logger.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { loadUserRefs, userRef } from "../../utils/userRefs.js";

/**
 * Seller subscription billing (p3-billing): plans, per-store subscription lifecycle, platform GST
 * invoices, manual payments, dunning. Razorpay autopay lives in razorpayBilling.js and calls back
 * into settleInvoice / applyPaidInvoice here.
 *
 * Lifecycle: awaiting_payment -(first invoice paid)-> active -(period end, renewal unpaid)->
 * past_due (grace, reminders day 0/3/6) -(grace over)-> paused (store paused) -(paid)-> active.
 * legacy: free plan until legacyUntil (= currentPeriodEnd), then like a renewal due (the seller must
 * choose a paid plan: a "first" invoice). Upgrades apply when their pro-rated invoice is paid;
 * downgrades / interval decreases at the next renewal (pendingPlanId).
 */

export const BILLING_PAUSE_REASONS = {
  awaiting: "Awaiting first subscription payment",
  overdue: "Subscription payment overdue",
};
const BILLING_REASON_SET = new Set(Object.values(BILLING_PAUSE_REASONS));

/** Renewal invoices (manual mode) are issued this many days before the period ends. */
export const RENEWAL_LEAD_DAYS = 3;
/** Autopay: Razorpay charges at the period end; mark past_due only after this slack. */
export const AUTOPAY_SLACK_MS = 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
export const PAST_DUE_REMINDER_DAYS = [0, 3, 6];
export const LEGACY_REMINDER_DAYS = [14, 3];

/* ------------------------------------------------------------------ helpers */

function idOf(v) {
  if (!v) return null;
  return v._id || v;
}

/** `date` + one billing interval, clamped to the month end (31 Jan + 1 month = 28/29 Feb). */
export function addInterval(date, interval = "monthly", count = 1) {
  const d = new Date(date);
  const months = (interval === "yearly" ? 12 : 1) * count;
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target;
}

const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/** Entitlement cache drop (p3-limits). Missing module (not built yet) is tolerated. */
export async function invalidateTenantEntitlements(tenantId) {
  try {
    const mod = await import("./entitlements.js");
    if (typeof mod.invalidateEntitlements === "function") await mod.invalidateEntitlements(tenantId);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") logger.warn("invalidateEntitlements failed", { err: err.message });
  }
}

function changed(session, tenantId) {
  afterCommit(session, () => invalidateTenantEntitlements(tenantId));
}

function emitAfter(session, event, payload) {
  afterCommit(session, () => emitDomain(event, { resource: "subscription", ...payload }));
}

function historyPush(entry) {
  return { $push: { history: { $each: [{ at: new Date(), ...entry }], $slice: -300 } } };
}

/** A "first" purchase is due (no paid plan period yet): awaiting payment, legacy, cancelled, or lapsed legacy. */
export function needsFirstPurchase(sub) {
  if (!sub) return true;
  if (["awaiting_payment", "legacy", "cancelled"].includes(sub.status)) return true;
  return sub.planSnapshot?.code === LEGACY_PLAN_CODE || !sub.planId || !sub.currentPeriodEnd;
}

/* ------------------------------------------------------------------ plans */

export function presentPlan(plan, { admin = false } = {}) {
  if (!plan) return null;
  const p = typeof plan.toObject === "function" ? plan.toObject() : plan;
  const prices = { monthly: planPrice(p, "monthly"), yearly: planPrice(p, "yearly") };
  const out = {
    id: p._id,
    code: p.code,
    name: p.name,
    description: p.description || "",
    priceInr: p.priceInr,
    interval: p.interval,
    prices,
    gstRate: SUBSCRIPTION_GST_RATE,
    pricesWithGst: { monthly: round2(prices.monthly * 1.18), yearly: round2(prices.yearly * 1.18) },
    limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, p.limits?.[k] ?? -1])),
    features: Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, Boolean(p.features?.[k])])),
    isPublic: Boolean(p.isPublic),
    sortOrder: p.sortOrder || 0,
    status: p.status,
  };
  if (admin) {
    out.intervalPrices = p.intervalPrices || { monthly: null, yearly: null };
    out.razorpayPlanIds = p.razorpayPlanIds || {};
    out.createdAt = p.createdAt;
    out.updatedAt = p.updatedAt;
  }
  return out;
}

export async function listPublicPlans() {
  const plans = await Plan.find({ status: "active", isPublic: true, code: { $ne: LEGACY_PLAN_CODE } }).sort({ sortOrder: 1, priceInr: 1 }).lean();
  return { data: plans.map((p) => presentPlan(p)) };
}

export async function listPlans(query = {}) {
  const filter = {};
  if (query.status) filter.status = query.status;
  const plans = await Plan.find(filter).sort({ status: 1, sortOrder: 1, priceInr: 1 }).lean();
  // Stores actually on (or about to pay for) the plan; cancelled / legacy ones don't count.
  const counts = await TenantSubscription.aggregate([
    { $match: { status: { $in: ["awaiting_payment", "active", "past_due", "paused"] } } },
    { $group: { _id: "$planId", n: { $sum: 1 } } },
  ]);
  const byPlan = new Map(counts.map((c) => [String(c._id), c.n]));
  return { data: plans.map((p) => ({ ...presentPlan(p, { admin: true }), subscribers: byPlan.get(String(p._id)) || 0 })) };
}

async function loadPlan(id, { session = null } = {}) {
  if (!mongoose.isValidObjectId(String(id))) throw new AppError(404, "Plan not found", "NOT_FOUND");
  const plan = await Plan.findById(id, null, withSession(session));
  if (!plan) throw new AppError(404, "Plan not found", "NOT_FOUND");
  return plan;
}

export async function getPlan(id) {
  return presentPlan(await loadPlan(id), { admin: true });
}

export async function createPlan(req, body) {
  if (body.code === LEGACY_PLAN_CODE) throw new AppError(409, "The legacy plan is managed by the platform", "CONFLICT");
  if (await Plan.exists({ code: body.code })) {
    throw new AppError(409, "A plan with this code already exists", "DUPLICATE", { fields: { code: "Already used" } });
  }
  try {
    const plan = await Plan.create({ ...body, createdBy: req.user?._id || null, updatedBy: req.user?._id || null });
    return presentPlan(plan, { admin: true });
  } catch (err) {
    if (err?.code === 11000) throw new AppError(409, "A plan with this code already exists", "DUPLICATE", { fields: { code: "Already used" } });
    throw err;
  }
}

export async function updatePlan(req, id, body) {
  const plan = await loadPlan(id);
  const legacy = plan.code === LEGACY_PLAN_CODE;
  if (legacy && ((body.priceInr != null && body.priceInr !== 0) || body.isPublic === true || body.status === "archived")) {
    throw new AppError(409, "The legacy plan must stay free, hidden and active", "CONFLICT");
  }
  const set = { updatedBy: req.user?._id || null };
  for (const k of ["name", "description", "priceInr", "interval", "isPublic", "sortOrder", "status"]) if (body[k] !== undefined) set[k] = body[k];
  for (const k of PLAN_LIMIT_KEYS) if (body.limits?.[k] !== undefined) set[`limits.${k}`] = body.limits[k];
  for (const k of PLAN_FEATURE_KEYS) if (body.features?.[k] !== undefined) set[`features.${k}`] = body.features[k];
  for (const k of PLAN_INTERVALS) if (body.intervalPrices?.[k] !== undefined) set[`intervalPrices.${k}`] = body.intervalPrices[k];
  const before = plan.toObject();
  const priceChanged =
    (set.priceInr !== undefined && set.priceInr !== before.priceInr) ||
    (set.interval !== undefined && set.interval !== before.interval) ||
    PLAN_INTERVALS.some((k) => set[`intervalPrices.${k}`] !== undefined && set[`intervalPrices.${k}`] !== before.intervalPrices?.[k]);
  // Razorpay plans carry a fixed amount: new ones are created lazily at the new price.
  if (priceChanged) Object.assign(set, { "razorpayPlanIds.monthly": "", "razorpayPlanIds.yearly": "" });
  const updated = await Plan.findOneAndUpdate({ _id: plan._id }, { $set: set }, { new: true, runValidators: true });
  if (priceChanged) {
    // Existing autopay subscriptions move to the new price at their next renewal (best effort).
    import("./razorpayBilling.js")
      .then((m) => m.syncAutopayPlanPrice(updated))
      .catch((err) => logger.error("autopay price sync failed", { plan: String(updated._id), err: err.message }));
  }
  // Limits / features of existing subscribers come from their snapshot (refreshed at renewal).
  return presentPlan(updated, { admin: true });
}

export async function archivePlan(req, id) {
  const plan = await loadPlan(id);
  if (plan.code === LEGACY_PLAN_CODE) throw new AppError(409, "The legacy plan cannot be archived", "CONFLICT");
  const updated = await Plan.findOneAndUpdate({ _id: plan._id }, { $set: { status: "archived", updatedBy: req.user?._id || null } }, { new: true });
  return presentPlan(updated, { admin: true });
}

/** Cheapest-first default for approvals without a chosen plan: active, public, paid. */
export async function defaultPlan(session = null) {
  return Plan.findOne({ status: "active", isPublic: true, priceInr: { $gt: 0 }, code: { $ne: LEGACY_PLAN_CODE } }, null, withSession(session)).sort({
    sortOrder: 1,
    priceInr: 1,
  });
}

/* ------------------------------------------------------------------ presenters */

export function presentInvoice(inv, { admin = false } = {}) {
  if (!inv) return null;
  const i = typeof inv.toObject === "function" ? inv.toObject() : inv;
  const out = {
    id: i._id,
    number: i.number || null,
    kind: i.kind,
    tenantId: i.tenantId,
    subscriptionId: i.subscriptionId,
    plan: i.planSnapshot ? { id: i.planId, code: i.planSnapshot.code, name: i.planSnapshot.name, interval: i.planSnapshot.interval, priceInr: i.planSnapshot.priceInr } : null,
    period: i.period,
    lines: (i.lines || []).map((l) => ({ description: l.description, sac: l.sac, amount: l.amount })),
    subtotal: i.subtotal,
    taxRate: i.taxRate,
    tax: i.tax,
    total: i.total,
    supplyType: i.supplyType,
    placeOfSupply: i.placeOfSupply,
    supplier: i.supplier,
    recipient: i.recipient,
    status: i.status,
    issuedAt: i.issuedAt,
    dueAt: i.dueAt,
    paidAt: i.paidAt,
    payment: i.payment?.method
      ? {
          method: i.payment.method,
          mode: i.payment.mode || "",
          reference: i.payment.reference || "",
          razorpayPaymentId: i.payment.razorpayPaymentId || "",
          razorpayOrderId: i.payment.razorpayOrderId || "",
        }
      : null,
    pdf: i.pdf || "",
    note: i.note || "",
    voidReason: i.voidReason || "",
    voidedAt: i.voidedAt,
    createdAt: i.createdAt,
  };
  if (admin) out.createdBy = i.createdBy || null;
  return out;
}

export function presentSubscription(sub, { admin = false, pendingPlan = null } = {}) {
  if (!sub) return null;
  const s = typeof sub.toObject === "function" ? sub.toObject() : sub;
  const out = {
    id: s._id,
    tenantId: s.tenantId?._id || s.tenantId,
    planId: s.planId,
    plan: s.planSnapshot,
    status: s.status,
    billingMode: s.billingMode,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    graceEndsAt: s.graceEndsAt,
    pastDueSince: s.pastDueSince || null,
    pendingPlanId: s.pendingPlanId,
    pendingInterval: s.pendingInterval,
    pendingPlan: pendingPlan ? { id: pendingPlan._id, code: pendingPlan.code, name: pendingPlan.name, priceInr: planPrice(pendingPlan, s.pendingInterval || pendingPlan.interval), interval: s.pendingInterval || pendingPlan.interval } : null,
    razorpaySubscriptionId: s.razorpaySubscriptionId || "",
    razorpaySubscriptionStatus: s.razorpaySubscriptionStatus || "",
    autopayUrl: s.razorpayShortUrl || "",
    legacyUntil: s.legacyUntil,
    discount: s.discount?.type && s.discount.cyclesLeft > 0 ? s.discount : null,
    credits: s.credits || 0,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
  if (s.tenantId && typeof s.tenantId === "object" && s.tenantId.name) {
    out.tenant = { id: s.tenantId._id, name: s.tenantId.name, slug: s.tenantId.slug, status: s.tenantId.status, statusReason: s.tenantId.statusReason || "" };
  }
  out.history = (s.history || []).slice(-(admin ? 100 : 20)).map((h) => (admin ? h : { at: h.at, action: h.action, from: h.from, to: h.to, note: h.note }));
  return out;
}

async function outstandingFor(tenantId) {
  const open = await SubscriptionInvoice.find({ tenantId, status: "issued" }).sort({ dueAt: 1 }).lean();
  return {
    amount: round2(open.reduce((s, i) => s + (i.total || 0), 0)),
    count: open.length,
    invoices: open.map((i) => ({ id: i._id, number: i.number, kind: i.kind, total: i.total, dueAt: i.dueAt })),
  };
}

/** Outstanding subscription dues of a store (exposed for payouts netting in phase 4). */
export async function outstandingAmount(tenantId) {
  return (await outstandingFor(tenantId)).amount;
}

/* ------------------------------------------------------------------ subscription load */

export async function subscriptionFor(tenantId, session = null) {
  return TenantSubscription.findOne({ tenantId }, null, withSession(session));
}

async function loadSubscriptionByIdOrTenant(id) {
  if (!mongoose.isValidObjectId(String(id))) throw new AppError(404, "Subscription not found", "NOT_FOUND");
  const sub = (await TenantSubscription.findById(id)) || (await TenantSubscription.findOne({ tenantId: id }));
  if (!sub) throw new AppError(404, "Subscription not found", "NOT_FOUND");
  return sub;
}

/** Stores without a subscription (created before billing / not migrated yet) get a legacy one. */
async function ensureSubscription(tenantId, { by = null, session = null } = {}) {
  const existing = await subscriptionFor(tenantId, session);
  if (existing) return existing;
  const { ensureLegacyPlan, legacyUntilDate } = await import("./migrate.js");
  const legacy = await ensureLegacyPlan();
  const until = await legacyUntilDate();
  await TenantSubscription.updateOne(
    { tenantId },
    {
      $setOnInsert: {
        tenantId,
        planId: legacy._id,
        planSnapshot: snapshotOf(legacy, legacy.interval),
        status: "legacy",
        billingMode: "manual",
        currentPeriodStart: new Date(),
        currentPeriodEnd: until,
        legacyUntil: until,
        history: [{ at: new Date(), action: "created", to: "legacy", by, note: "Legacy plan assigned" }],
      },
    },
    withSession(session, { upsert: true })
  );
  return subscriptionFor(tenantId, session);
}

/* ------------------------------------------------------------------ invoices */

function planLine(snap, period, sac) {
  const label = `${snap.name} plan (${snap.interval})`;
  return { description: period?.start ? `${label} ${isoDay(period.start)} to ${isoDay(period.end)}` : label, sac, amount: round2(snap.priceInr) };
}

/**
 * Create + issue an invoice inside `session`. `adjust` applies the subscription's discount and
 * credits (first / renewal invoices). A zero total is settled at once ("No amount due").
 * Returns the (possibly already paid) invoice.
 */
async function createInvoice(sub, { kind, planDoc = null, snap = null, period = null, lines = null, dueAt = null, note = "", by = null, restartPeriod = false, adjust = true, comp = "", periodKey, grossTotal = null, payment = null, session }) {
  const settings = await billingSettings();
  const tenant = await Tenant.findById(sub.tenantId, null, withSession(session)).lean();
  if (!tenant) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  const recipient = recipientFor(tenant);
  const out = lines
    ? lines.map((l) => ({ ...l, sac: l.sac || settings.sac, amount: round2(l.amount) }))
    : [grossTotal != null ? { ...planLine(snap, period, settings.sac), amount: round2(grossTotal / (1 + SUBSCRIPTION_GST_RATE / 100)) } : planLine(snap, period, settings.sac)];
  let creditsApplied = 0;
  let discountApplied = false;
  if (comp) {
    const base = round2(out.reduce((s, l) => s + l.amount, 0));
    if (base > 0) out.push({ description: `Complimentary period${comp === true ? "" : `: ${String(comp).slice(0, 80)}`}`, sac: settings.sac, amount: -base });
  } else if (adjust && ["first", "renewal"].includes(kind) && grossTotal == null) {
    let base = round2(out.reduce((s, l) => s + l.amount, 0));
    const fresh = await TenantSubscription.findById(sub._id, null, withSession(session)).lean();
    const disc = fresh?.discount;
    if (disc?.type && disc.cyclesLeft > 0 && base > 0) {
      const off = disc.type === "percent" ? round2((base * Math.min(100, disc.value)) / 100) : round2(Math.min(base, disc.value));
      if (off > 0) {
        out.push({ description: disc.type === "percent" ? `Discount ${disc.value}%` : "Discount", sac: settings.sac, amount: -off });
        base = round2(base - off);
        discountApplied = true;
        await TenantSubscription.updateOne({ _id: sub._id }, { $inc: { "discount.cyclesLeft": -1 } }, withSession(session));
      }
    }
    const credits = round2(fresh?.credits || 0);
    if (credits > 0 && base > 0) {
      creditsApplied = round2(Math.min(credits, base));
      out.push({ description: "Account credit applied", sac: settings.sac, amount: -creditsApplied });
      await TenantSubscription.updateOne({ _id: sub._id, credits: { $gte: creditsApplied } }, { $inc: { credits: -creditsApplied } }, withSession(session));
    }
  }
  const totals = computeTotals(out, { supplier: settings.supplier, recipient, grossTotal });
  const issuedAt = new Date();
  const { number, financialYear, sequence } = await nextInvoiceNumber(settings.invoicePrefix, session, issuedAt);
  const [inv] = await SubscriptionInvoice.create(
    [
      {
        tenantId: sub.tenantId,
        subscriptionId: sub._id,
        number,
        financialYear,
        sequence,
        kind,
        planId: planDoc?._id || null,
        planSnapshot: snap || null,
        restartPeriod,
        period: period || { start: null, end: null },
        lines: out,
        ...totals,
        supplier: settings.supplier,
        recipient,
        status: "issued",
        issuedAt,
        dueAt: dueAt || issuedAt,
        periodKey: periodKey || undefined,
        note,
        createdBy: by,
        creditsApplied,
        discountApplied,
      },
    ],
    withSession(session)
  );
  inv.pdf = `/api/v1/billing/me/invoices/${inv._id}/pdf`;
  await SubscriptionInvoice.updateOne({ _id: inv._id }, { $set: { pdf: inv.pdf } }, withSession(session));
  if (payment) return (await settleInvoice(inv, payment, { by, session })).invoice;
  if (inv.total <= 0) {
    return (await settleInvoice(inv, { method: "manual", reference: comp ? `Complimentary${comp === true ? "" : `: ${comp}`}` : "No amount due" }, { by, session })).invoice;
  }
  emitAfter(session, "SUBSCRIPTION_INVOICE_ISSUED", {
    tenantId: sub.tenantId,
    resourceId: inv._id,
    invoiceId: inv._id,
    number: inv.number,
    kind,
    total: inv.total,
    dueAt: inv.dueAt,
  });
  return inv;
}

/** Void an open invoice (credits / discount cycle given back). */
async function voidInvoiceIn(inv, { reason, by = null, session }) {
  const voided = await SubscriptionInvoice.findOneAndUpdate(
    { _id: inv._id, status: { $in: ["draft", "issued"] } },
    { $set: { status: "void", voidReason: String(reason || "").slice(0, 500), voidedAt: new Date() }, $unset: { periodKey: 1 } },
    withSession(session, { new: true })
  );
  if (!voided) return null;
  const inc = {};
  if (voided.creditsApplied > 0) inc.credits = voided.creditsApplied;
  if (voided.discountApplied) inc["discount.cyclesLeft"] = 1;
  if (Object.keys(inc).length) await TenantSubscription.updateOne({ _id: voided.subscriptionId }, { $inc: inc }, withSession(session));
  await TenantSubscription.updateOne(
    { _id: voided.subscriptionId },
    historyPush({ action: "invoice_voided", by, note: reason || "", data: { invoiceId: voided._id, number: voided.number } }),
    withSession(session)
  );
  return voided;
}

async function voidOpen(sub, filter, { reason, by, session }) {
  const open = await SubscriptionInvoice.find({ subscriptionId: sub._id, status: "issued", ...filter }, null, withSession(session));
  for (const inv of open) await voidInvoiceIn(inv, { reason, by, session });
  return open.length;
}

/**
 * The plan + interval the next period is billed on: pending (downgrade / chosen) plan, else the
 * current plan at its CURRENT price (price changes apply at renewal), else the snapshot.
 */
async function nextPlanFor(sub, session) {
  const id = sub.pendingPlanId || sub.planId;
  const interval = sub.pendingInterval || sub.planSnapshot?.interval || "monthly";
  const planDoc = id ? await Plan.findById(id, null, withSession(session)) : null;
  if (!planDoc || planDoc.code === LEGACY_PLAN_CODE) return null;
  return { planDoc, snap: snapshotOf(planDoc, interval) };
}

/**
 * Issue the invoice for the next due period (idempotent: returns the open one when it exists):
 *  - first purchase (awaiting / legacy / lapsed legacy): kind "first", period starts at payment;
 *  - otherwise kind "renewal" for [currentPeriodEnd, +interval], due at currentPeriodEnd.
 * Throws 409 PLAN_REQUIRED when no paid plan is chosen yet.
 */
export async function issuePeriodInvoice(sub, { by = null, comp = "", note = "", payment = null, grossTotal = null, period: forcedPeriod = null, planOverride = null, session }) {
  const first = needsFirstPurchase(sub);
  let chosen = planOverride;
  if (!chosen) {
    if (first) {
      const id = sub.status === "awaiting_payment" ? sub.pendingPlanId || sub.planId : sub.pendingPlanId;
      const interval = sub.pendingInterval || (sub.status === "awaiting_payment" ? sub.planSnapshot?.interval : null);
      const planDoc = id ? await Plan.findById(id, null, withSession(session)) : null;
      chosen = planDoc && planDoc.code !== LEGACY_PLAN_CODE ? { planDoc, snap: snapshotOf(planDoc, interval || planDoc.interval) } : null;
    } else {
      chosen = await nextPlanFor(sub, session);
    }
  }
  if (!chosen) throw new AppError(409, "Choose a subscription plan first", "PLAN_REQUIRED");
  const now = new Date();
  let kind;
  let period;
  let dueAt;
  let periodKey;
  if (first) {
    kind = "first";
    // Legacy stores choosing early too: the paid period starts at payment (re-stamped then).
    // Payment itself is only required once the free period ends (dueAt).
    const start = now;
    period = forcedPeriod || { start, end: addInterval(start, chosen.snap.interval) };
    dueAt = sub.status === "legacy" && sub.legacyUntil && sub.legacyUntil > now ? sub.legacyUntil : start;
    periodKey = `${sub._id}:first`;
  } else {
    kind = "renewal";
    const start = sub.currentPeriodEnd;
    period = forcedPeriod || { start, end: addInterval(start, chosen.snap.interval) };
    dueAt = start;
    periodKey = `${sub._id}:${new Date(period.start).toISOString()}`;
  }
  const open = await SubscriptionInvoice.findOne({ periodKey }, null, withSession(session));
  if (open) {
    const samePlan = String(open.planId) === String(chosen.planDoc._id) && open.planSnapshot?.interval === chosen.snap.interval;
    if (!comp && !payment && samePlan) return open;
    await voidInvoiceIn(open, { reason: comp ? "Replaced by complimentary period" : payment ? "Paid by autopay" : "Replaced (plan changed)", by, session });
  }
  if (kind === "renewal") {
    const paid = await SubscriptionInvoice.findOne({ subscriptionId: sub._id, kind: "renewal", status: "paid", "period.start": period.start }, null, withSession(session));
    if (paid) return paid;
  }
  return createInvoice(sub, { kind, planDoc: chosen.planDoc, snap: chosen.snap, period, dueAt, by, comp, note, periodKey, payment, grossTotal, session });
}

/* ------------------------------------------------------------------ payment */

/** Resume the store when it is paused for a billing reason. */
async function resumeIfBillingPaused(tenantId, { by, session }) {
  const tenant = await Tenant.findById(tenantId, null, withSession(session)).lean();
  if (!tenant || tenant.status !== "paused" || !BILLING_REASON_SET.has(tenant.statusReason)) return false;
  const { setTenantStatus } = await import("../tenants/service.js");
  await setTenantStatus(tenantId, "active", { by, session, source: "billing" });
  return true;
}

/**
 * Apply a paid invoice to its subscription (inside `session`):
 *  first   -> active, plan from the invoice, period [paidAt, +interval]
 *  renewal -> period advanced to the invoice period once it has started (stale periods restart
 *             at payment); active; pending plan consumed
 *  upgrade -> plan switched now (period restarted when `restartPeriod`); open renewal re-issued later
 * A store paused for billing is resumed.
 */
export async function applyPaidInvoice(inv, { by = null, session, now = new Date() }) {
  const sub = await TenantSubscription.findById(inv.subscriptionId, null, withSession(session));
  if (!sub) return null;
  const from = sub.status;
  const set = {};
  let action = "payment";
  if (inv.kind === "first") {
    // Always [paidAt, +interval] — also for a legacy store paying before its free period ends
    // (the remaining free days are given up; upgrades then pro-rate against the real period).
    const start = now;
    const end = addInterval(start, inv.planSnapshot.interval);
    Object.assign(set, {
      status: "active",
      planId: inv.planId,
      planSnapshot: inv.planSnapshot,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      graceEndsAt: null,
      pastDueSince: null,
      pendingPlanId: null,
      pendingInterval: null,
    });
    await SubscriptionInvoice.updateOne({ _id: inv._id }, { $set: { "period.start": start, "period.end": end } }, withSession(session));
    action = "activated";
  } else if (inv.kind === "renewal") {
    if (inv.period?.start && new Date(inv.period.start) <= now) {
      let start = new Date(inv.period.start);
      let end = new Date(inv.period.end);
      if (end <= now) {
        // Paid long after the period: the paid period starts now.
        start = now;
        end = addInterval(now, inv.planSnapshot.interval);
        await SubscriptionInvoice.updateOne({ _id: inv._id }, { $set: { "period.start": start, "period.end": end } }, withSession(session));
      }
      Object.assign(set, { status: "active", planId: inv.planId, planSnapshot: inv.planSnapshot, currentPeriodStart: start, currentPeriodEnd: end, graceEndsAt: null, pastDueSince: null });
      if (sub.pendingPlanId && String(sub.pendingPlanId) === String(inv.planId)) Object.assign(set, { pendingPlanId: null, pendingInterval: null });
      action = from === "active" ? "renewed" : "reactivated";
    } else {
      action = "renewal_prepaid";
    }
  } else if (inv.kind === "upgrade") {
    Object.assign(set, { planId: inv.planId, planSnapshot: inv.planSnapshot, pendingPlanId: null, pendingInterval: null });
    if (inv.restartPeriod) Object.assign(set, { currentPeriodStart: now, currentPeriodEnd: addInterval(now, inv.planSnapshot.interval) });
    action = "upgraded";
    // A renewal already issued on the old plan is replaced at the next job run.
    await voidOpen(sub, { kind: "renewal" }, { reason: "Replaced after upgrade", by, session });
    emitAfter(session, "SUBSCRIPTION_PLAN_CHANGED", { tenantId: sub.tenantId, from: sub.planSnapshot?.code, to: inv.planSnapshot?.code, effective: "now" });
  }
  const updated = await TenantSubscription.findOneAndUpdate(
    { _id: sub._id },
    { ...(Object.keys(set).length ? { $set: set } : {}), ...historyPush({ action, from, to: set.status || from, by, data: { invoiceId: inv._id, number: inv.number, total: inv.total } }) },
    withSession(session, { new: true })
  );
  let resumed = false;
  if (updated.status === "active") resumed = await resumeIfBillingPaused(sub.tenantId, { by, session });
  if (resumed || (from !== "active" && updated.status === "active" && from !== "awaiting_payment" && from !== "legacy")) {
    emitAfter(session, "SUBSCRIPTION_RESUMED", { tenantId: sub.tenantId, storeResumed: resumed });
  }
  changed(session, sub.tenantId);
  return updated;
}

/**
 * Mark `inv` paid inside `session` (conditional issued -> paid; replays return the paid one) and
 * apply it to the subscription. payment = { method, reference, mode, razorpayPaymentId,
 * razorpayOrderId, razorpayPaymentLinkId, razorpaySubscriptionId, paidAt }.
 */
export async function settleInvoice(inv, payment, { by = null, session }) {
  const paidAt = payment.paidAt ? new Date(payment.paidAt) : new Date();
  const paid = await SubscriptionInvoice.findOneAndUpdate(
    { _id: inv._id, status: "issued" },
    {
      $set: {
        status: "paid",
        paidAt,
        "payment.method": payment.method,
        "payment.reference": String(payment.reference || "").slice(0, 200),
        "payment.mode": payment.mode || "",
        "payment.razorpayPaymentId": payment.razorpayPaymentId || "",
        "payment.razorpayOrderId": payment.razorpayOrderId || inv.payment?.razorpayOrderId || "",
        "payment.razorpayPaymentLinkId": payment.razorpayPaymentLinkId || inv.payment?.razorpayPaymentLinkId || "",
        "payment.razorpaySubscriptionId": payment.razorpaySubscriptionId || "",
        "payment.recordedBy": by,
      },
      $unset: { periodKey: 1 },
    },
    withSession(session, { new: true })
  );
  if (!paid) {
    const current = await SubscriptionInvoice.findById(inv._id, null, withSession(session));
    if (current?.status === "paid") return { invoice: current, already: true };
    throw new AppError(409, `This invoice is ${current?.status || "missing"} and cannot be paid`, "INVALID_STATE");
  }
  const subscription = await applyPaidInvoice(paid, { by, session, now: paidAt > new Date() ? new Date() : paidAt });
  if (paid.total > 0) {
    emitAfter(session, "SUBSCRIPTION_PAYMENT_RECEIVED", {
      tenantId: paid.tenantId,
      resourceId: paid._id,
      invoiceId: paid._id,
      number: paid.number,
      total: paid.total,
      method: payment.method,
    });
  }
  return { invoice: await SubscriptionInvoice.findById(paid._id, null, withSession(session)), subscription, already: false };
}

/** Pay an invoice in its own transaction (webhooks, verify, admin). */
export async function markInvoicePaid(invoiceId, payment, { by = null } = {}) {
  return withTransaction(async (session) => {
    const inv = await SubscriptionInvoice.findById(invoiceId, null, withSession(session));
    if (!inv) throw new AppError(404, "Invoice not found", "NOT_FOUND");
    return settleInvoice(inv, payment, { by, session });
  });
}

/* ------------------------------------------------------------------ approval hook */

/**
 * Called by tenants/service.js createTenantFromApplication (same transaction). Creates the
 * store's subscription (awaiting_payment) on the chosen (or default) plan, issues the first
 * invoice and pauses the store until it is paid. When no paid plan exists at all (billing not
 * set up) nothing happens and the store stays active. Returns the updated tenant or null.
 */
export async function onTenantApproved(tenant, application, { by = null, session = null } = {}) {
  const tenantId = idOf(tenant);
  if (await subscriptionFor(tenantId, session)) return null;
  let plan = null;
  if (application?.planId && mongoose.isValidObjectId(String(application.planId))) {
    plan = await Plan.findOne({ _id: application.planId, status: "active", code: { $ne: LEGACY_PLAN_CODE } }, null, withSession(session));
  }
  if (!plan) plan = await defaultPlan(session);
  if (!plan) {
    logger.warn("billing: no active paid plan, store approved without a subscription", { tenantId: String(tenantId) });
    return null;
  }
  const interval = PLAN_INTERVALS.includes(application?.planInterval) ? application.planInterval : plan.interval;
  const [sub] = await TenantSubscription.create(
    [
      {
        tenantId,
        planId: plan._id,
        planSnapshot: snapshotOf(plan, interval),
        status: "awaiting_payment",
        billingMode: "manual",
        history: [{ at: new Date(), action: "created", to: "awaiting_payment", by, note: "Store approved", data: { applicationId: application?._id || null } }],
      },
    ],
    withSession(session)
  );
  const inv = await issuePeriodInvoice(sub, { by, session });
  changed(session, tenantId);
  if (inv.status === "paid") return null; // free plan: active right away
  const { setTenantStatus } = await import("../tenants/service.js");
  return setTenantStatus(tenantId, "paused", { reason: BILLING_PAUSE_REASONS.awaiting, by, session, source: "billing" });
}

/* ------------------------------------------------------------------ seller views */

async function pendingPlanDoc(sub) {
  return sub?.pendingPlanId ? Plan.findById(sub.pendingPlanId).lean() : null;
}

/** `summary`: staff without settings access only get what the status banners need. */
export async function getMyBilling(tenantId, { summary = false } = {}) {
  const sub = await subscriptionFor(tenantId);
  const outstanding = await outstandingFor(tenantId);
  if (summary) {
    if (!sub) return { subscription: null, summary: true };
    return {
      summary: true,
      subscription: { status: sub.status, graceEndsAt: sub.graceEndsAt, currentPeriodEnd: sub.currentPeriodEnd, legacyUntil: sub.legacyUntil, plan: { name: sub.planSnapshot?.name || "" } },
      outstanding: { count: outstanding.count },
      needsPlan: needsFirstPurchase(sub) && !(sub.status === "awaiting_payment" && sub.planId) && !sub.pendingPlanId,
    };
  }
  if (!sub) return { subscription: null, plan: null, outstanding, gstRate: SUBSCRIPTION_GST_RATE };
  const plan = sub.planId ? await Plan.findById(sub.planId).lean() : null;
  return {
    subscription: presentSubscription(sub, { pendingPlan: await pendingPlanDoc(sub) }),
    plan: plan ? presentPlan(plan) : null,
    outstanding,
    needsPlan: needsFirstPurchase(sub) && !(sub.status === "awaiting_payment" && sub.planId) && !sub.pendingPlanId,
    gstRate: SUBSCRIPTION_GST_RATE,
  };
}

export async function listInvoices(filter, query = {}) {
  const { page, limit, skip } = paginate(query);
  const f = { ...filter };
  if (query.status) f.status = { $in: String(query.status).split(",").map((s) => s.trim()) };
  const [rows, total] = await Promise.all([
    SubscriptionInvoice.find(f).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    SubscriptionInvoice.countDocuments(f),
  ]);
  return paginated(rows.map((r) => presentInvoice(r, { admin: !filter.tenantId })), total, { page, limit });
}

export async function getInvoice(id, { tenantId = null } = {}) {
  if (!mongoose.isValidObjectId(String(id))) throw new AppError(404, "Invoice not found", "NOT_FOUND");
  const inv = await SubscriptionInvoice.findOne(tenantId ? { _id: id, tenantId } : { _id: id });
  if (!inv) throw new AppError(404, "Invoice not found", "NOT_FOUND");
  return inv;
}

/* ------------------------------------------------------------------ plan change */

/**
 * Seller (or admin) chooses a plan.
 *  - no paid period yet (awaiting / legacy / lapsed legacy / cancelled): (re)issue the first
 *    invoice for the plan; it applies when paid.
 *  - past_due / paused: the open renewal is re-issued on the chosen plan.
 *  - active: higher price (same interval) = upgrade now with a pro-rated invoice for the rest of
 *    the period; monthly -> yearly = upgrade now, unused part credited, period restarts at payment;
 *    lower price or yearly -> monthly = downgrade at the next renewal (pendingPlanId).
 *    Choosing the current plan again cancels a pending downgrade.
 * Autopay: Razorpay is updated first (razorpayBilling.js); nothing changes here if that fails.
 */
export async function changePlan(tenantId, { planId, interval, by = null, admin = false }) {
  const plan = await loadPlan(planId);
  if (plan.status !== "active") throw new AppError(409, "This plan is not available", "PLAN_UNAVAILABLE");
  if (plan.code === LEGACY_PLAN_CODE) throw new AppError(409, "The legacy plan cannot be chosen", "PLAN_UNAVAILABLE");
  if (!admin && !plan.isPublic) {
    const current = await subscriptionFor(tenantId);
    if (String(current?.planId) !== String(plan._id)) throw new AppError(409, "This plan is not available", "PLAN_UNAVAILABLE");
  }
  const want = PLAN_INTERVALS.includes(interval) ? interval : plan.interval;
  const snap = snapshotOf(plan, want);
  const pre = await ensureSubscription(tenantId, { by });
  const decision = classifyChange(pre, plan, snap);
  if (pre.billingMode === "autopay" && pre.razorpaySubscriptionId && ["upgrade", "upgrade_restart", "downgrade", "cancel_pending"].includes(decision.type)) {
    const rb = await import("./razorpayBilling.js");
    await rb.syncAutopayPlanChange(pre, plan, want, decision.type === "upgrade" || decision.type === "upgrade_restart" ? "now" : "cycle_end");
  }
  const result = await withTransaction(async (session) => {
    const sub = await subscriptionFor(tenantId, session);
    const d = classifyChange(sub, plan, snap);
    const from = sub.planSnapshot?.code || "";
    let invoice = null;
    let effective = "on_payment";
    if (d.type === "first") {
      await TenantSubscription.updateOne(
        { _id: sub._id },
        {
          $set: sub.status === "awaiting_payment" || sub.status === "cancelled"
            ? { planId: plan._id, planSnapshot: snap, pendingPlanId: null, pendingInterval: null }
            : { pendingPlanId: plan._id, pendingInterval: want },
          ...historyPush({ action: "plan_chosen", by, note: `${plan.code} (${want})` }),
        },
        withSession(session)
      );
      const fresh = await subscriptionFor(tenantId, session);
      invoice = await issuePeriodInvoice(fresh, { by, session, planOverride: { planDoc: plan, snap } });
    } else if (d.type === "renewal_due") {
      await TenantSubscription.updateOne(
        { _id: sub._id },
        { $set: { pendingPlanId: plan._id, pendingInterval: want }, ...historyPush({ action: "plan_chosen", by, note: `${plan.code} (${want})` }) },
        withSession(session)
      );
      const fresh = await subscriptionFor(tenantId, session);
      invoice = await issuePeriodInvoice(fresh, { by, session, planOverride: { planDoc: plan, snap } });
    } else if (d.type === "cancel_pending") {
      await TenantSubscription.updateOne(
        { _id: sub._id },
        { $set: { pendingPlanId: null, pendingInterval: null }, ...historyPush({ action: "downgrade_cancelled", by }) },
        withSession(session)
      );
      await voidOpen(sub, { kind: "renewal" }, { reason: "Replaced (pending plan change cancelled)", by, session });
      effective = "unchanged";
    } else if (d.type === "same") {
      throw new AppError(409, "You are already on this plan", "SAME_PLAN");
    } else if (d.type === "downgrade") {
      await TenantSubscription.updateOne(
        { _id: sub._id },
        { $set: { pendingPlanId: plan._id, pendingInterval: want }, ...historyPush({ action: "downgrade_scheduled", by, note: `${from} -> ${plan.code} (${want})` }) },
        withSession(session)
      );
      await voidOpen(sub, { kind: "renewal" }, { reason: "Replaced (plan changes at renewal)", by, session });
      effective = "renewal";
      emitAfter(session, "SUBSCRIPTION_PLAN_CHANGED", { tenantId, from, to: plan.code, effective: "renewal", at: sub.currentPeriodEnd });
    } else {
      // upgrade / upgrade_restart: pro-rated invoice, applied when paid.
      await voidOpen(sub, { kind: "upgrade" }, { reason: "Replaced by a new plan change", by, session });
      const now = new Date();
      const total = Math.max(1, sub.currentPeriodEnd - sub.currentPeriodStart);
      const fraction = Math.min(1, Math.max(0, (sub.currentPeriodEnd - now) / total));
      const oldPrice = round2(sub.planSnapshot?.priceInr || 0);
      const settings = await billingSettings();
      let lines;
      let period;
      if (d.type === "upgrade") {
        const amount = round2((snap.priceInr - oldPrice) * fraction);
        period = { start: now, end: sub.currentPeriodEnd };
        lines = [{ description: `Upgrade ${sub.planSnapshot?.name || from} -> ${snap.name} (${snap.interval}), pro-rated ${isoDay(now)} to ${isoDay(sub.currentPeriodEnd)}`, sac: settings.sac, amount }];
      } else {
        const credit = round2(oldPrice * fraction);
        period = { start: now, end: addInterval(now, snap.interval) };
        lines = [planLine(snap, period, settings.sac)];
        if (credit > 0) lines.push({ description: `Unused ${sub.planSnapshot?.name || from} (${sub.planSnapshot?.interval}) credit`, sac: settings.sac, amount: -Math.min(credit, snap.priceInr) });
      }
      await TenantSubscription.updateOne({ _id: sub._id }, historyPush({ action: "upgrade_requested", by, note: `${from} -> ${plan.code} (${want})` }), withSession(session));
      invoice = await createInvoice(sub, {
        kind: "upgrade",
        planDoc: plan,
        snap,
        period,
        lines,
        by,
        restartPeriod: d.type === "upgrade_restart",
        adjust: false,
        periodKey: `${sub._id}:upgrade`,
        session,
      });
      effective = invoice.status === "paid" ? "now" : "on_payment";
    }
    changed(session, tenantId);
    return { effective, invoiceId: invoice?._id || null };
  });
  const out = await getMyBilling(tenantId);
  return { ...out, effective: result.effective, invoice: result.invoiceId ? presentInvoice(await SubscriptionInvoice.findById(result.invoiceId)) : null };
}

function classifyChange(sub, plan, snap) {
  if (needsFirstPurchase(sub)) return { type: "first" };
  if (sub.status === "past_due" || sub.status === "paused") return { type: "renewal_due" };
  const cur = sub.planSnapshot || {};
  const samePlan = String(sub.planId) === String(plan._id) && cur.interval === snap.interval;
  if (samePlan) return sub.pendingPlanId ? { type: "cancel_pending" } : { type: "same" };
  if (cur.interval === snap.interval) return snap.priceInr > (cur.priceInr || 0) ? { type: "upgrade" } : { type: "downgrade" };
  if (cur.interval === "monthly" && snap.interval === "yearly") return { type: "upgrade_restart" };
  return { type: "downgrade" };
}

/* ------------------------------------------------------------------ admin actions */

export async function listSubscriptions(query = {}) {
  const { page, limit, skip } = paginate(query);
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(",").map((s) => s.trim()) };
  if (query.billingMode) filter.billingMode = query.billingMode;
  if (query.planId && mongoose.isValidObjectId(String(query.planId))) filter.planId = query.planId;
  if (query.q) {
    const rx = new RegExp(String(query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const tenants = await Tenant.find({ $or: [{ name: rx }, { slug: rx }, { "businessProfile.gstin": rx }] }).select("_id").limit(500).lean();
    filter.tenantId = { $in: tenants.map((t) => t._id) };
  }
  const [rows, total, counts] = await Promise.all([
    TenantSubscription.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).populate("tenantId", "name slug status statusReason").lean(),
    TenantSubscription.countDocuments(filter),
    TenantSubscription.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const dues = await SubscriptionInvoice.aggregate([
    { $match: { status: "issued", tenantId: { $in: rows.map((r) => r.tenantId?._id || r.tenantId) } } },
    { $group: { _id: "$tenantId", amount: { $sum: "$total" }, n: { $sum: 1 } } },
  ]);
  const dueBy = new Map(dues.map((d) => [String(d._id), d]));
  const data = rows.map((r) => {
    const out = presentSubscription(r);
    delete out.history;
    const due = dueBy.get(String(r.tenantId?._id || r.tenantId));
    out.outstanding = { amount: round2(due?.amount || 0), count: due?.n || 0 };
    return out;
  });
  return { ...paginated(data, total, { page, limit }), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])) };
}

export async function getSubscriptionDetail(id) {
  const sub = await loadSubscriptionByIdOrTenant(id);
  await sub.populate("tenantId", "name slug status statusReason");
  const tenantId = sub.tenantId._id;
  const [plan, pending, invoices, outstanding] = await Promise.all([
    sub.planId ? Plan.findById(sub.planId).lean() : null,
    pendingPlanDoc(sub),
    SubscriptionInvoice.find({ tenantId }).sort({ createdAt: -1 }).limit(50).lean(),
    outstandingFor(tenantId),
  ]);
  const subscription = presentSubscription(sub, { admin: true, pendingPlan: pending });
  // "by" ids -> { id, name, email } so the history shows who acted (admin or seller staff).
  const refs = await loadUserRefs(subscription.history.map((h) => h.by));
  subscription.history = subscription.history.map((h) => ({ ...(h.toObject ? h.toObject() : h), by: userRef(h.by, refs) }));
  return {
    subscription,
    plan: plan ? presentPlan(plan, { admin: true }) : null,
    invoices: invoices.map((i) => presentInvoice(i, { admin: true })),
    outstanding,
  };
}

export async function adminChangePlan(req, id, { planId, interval, when = "now", prorate = true }) {
  const sub = await loadSubscriptionByIdOrTenant(id);
  const by = req.user?._id || null;
  const live = !needsFirstPurchase(sub) && sub.status === "active";
  if (live && (when === "renewal" || !prorate)) {
    const plan = await loadPlan(planId);
    if (plan.code === LEGACY_PLAN_CODE) throw new AppError(409, "The legacy plan cannot be chosen", "PLAN_UNAVAILABLE");
    const want = PLAN_INTERVALS.includes(interval) ? interval : plan.interval;
    await withTransaction(async (session) => {
      if (when === "renewal") {
        // Scheduled for the next renewal (any direction).
        await TenantSubscription.updateOne(
          { _id: sub._id },
          { $set: { pendingPlanId: plan._id, pendingInterval: want }, ...historyPush({ action: "plan_change_scheduled", by, note: `admin: ${plan.code} (${want}) at renewal` }) },
          withSession(session)
        );
        await voidOpen(sub, { kind: "renewal" }, { reason: "Replaced (plan changes at renewal)", by, session });
        emitAfter(session, "SUBSCRIPTION_PLAN_CHANGED", { tenantId: sub.tenantId, from: sub.planSnapshot?.code, to: plan.code, effective: "renewal", at: sub.currentPeriodEnd });
      } else {
        // Now, without proration: switch immediately, no charge.
        await TenantSubscription.updateOne(
          { _id: sub._id },
          {
            $set: { planId: plan._id, planSnapshot: snapshotOf(plan, want), pendingPlanId: null, pendingInterval: null },
            ...historyPush({ action: "plan_changed", by, note: `admin: ${plan.code} (${want}) now, no charge` }),
          },
          withSession(session)
        );
        await voidOpen(sub, { kind: { $in: ["renewal", "upgrade"] } }, { reason: "Replaced (plan changed by admin)", by, session });
        emitAfter(session, "SUBSCRIPTION_PLAN_CHANGED", { tenantId: sub.tenantId, from: sub.planSnapshot?.code, to: plan.code, effective: "now" });
      }
      changed(session, sub.tenantId);
    });
  } else {
    // Same rules as the seller: first invoice / overdue renewal re-issued / pro-rated upgrade / downgrade at renewal.
    await changePlan(sub.tenantId, { planId, interval, by, admin: true });
  }
  return getSubscriptionDetail(sub._id);
}

export async function setBillingMode(req, id, { billingMode }) {
  const sub = await loadSubscriptionByIdOrTenant(id);
  if (sub.billingMode === billingMode) return getSubscriptionDetail(sub._id);
  if (billingMode === "autopay") {
    if (!sub.razorpaySubscriptionId || !["active", "authenticated"].includes(sub.razorpaySubscriptionStatus)) {
      throw new AppError(409, "The seller must set up autopay first (Billing > Autopay)", "AUTOPAY_NOT_SET_UP");
    }
  } else if (sub.razorpaySubscriptionId && !["cancelled", "completed", "expired"].includes(sub.razorpaySubscriptionStatus)) {
    const rb = await import("./razorpayBilling.js");
    await rb.cancelAutopayAtRazorpay(sub);
  }
  await TenantSubscription.updateOne(
    { _id: sub._id },
    {
      $set: { billingMode, ...(billingMode === "manual" && sub.razorpaySubscriptionId ? { razorpaySubscriptionStatus: "cancelled" } : {}) },
      ...historyPush({ action: "billing_mode", from: sub.billingMode, to: billingMode, by: req.user?._id || null }),
    }
  );
  await invalidateTenantEntitlements(sub.tenantId);
  return getSubscriptionDetail(sub._id);
}

/**
 * Extend grace: past_due -> graceEndsAt pushed out; paused (billing) -> back to past_due with a
 * new grace window and the store resumed; legacy -> legacyUntil / period end pushed out.
 */
export async function extendGrace(req, id, { days, reason = "" }) {
  const sub = await loadSubscriptionByIdOrTenant(id);
  const by = req.user?._id || null;
  const ms = days * DAY;
  await withTransaction(async (session) => {
    const s = await TenantSubscription.findById(sub._id, null, withSession(session));
    const now = new Date();
    if (s.status === "past_due") {
      const base = s.graceEndsAt && s.graceEndsAt > now ? s.graceEndsAt : now;
      await TenantSubscription.updateOne({ _id: s._id }, { $set: { graceEndsAt: new Date(base.getTime() + ms) }, ...historyPush({ action: "grace_extended", by, note: reason, data: { days } }) }, withSession(session));
    } else if (s.status === "paused") {
      await TenantSubscription.updateOne(
        { _id: s._id, status: "paused" },
        { $set: { status: "past_due", graceEndsAt: new Date(now.getTime() + ms) }, ...historyPush({ action: "grace_extended", from: "paused", to: "past_due", by, note: reason, data: { days } }) },
        withSession(session)
      );
      const resumed = await resumeIfBillingPaused(s.tenantId, { by, session });
      if (resumed) emitAfter(session, "SUBSCRIPTION_RESUMED", { tenantId: s.tenantId, storeResumed: true, grace: true });
    } else if (s.status === "legacy") {
      const base = s.currentPeriodEnd && s.currentPeriodEnd > now ? s.currentPeriodEnd : now;
      const until = new Date(base.getTime() + ms);
      await TenantSubscription.updateOne({ _id: s._id }, { $set: { currentPeriodEnd: until, legacyUntil: until }, ...historyPush({ action: "legacy_extended", by, note: reason, data: { days } }) }, withSession(session));
    } else {
      throw new AppError(409, `Grace can only be extended for past due, paused or legacy subscriptions (this one is ${s.status})`, "INVALID_STATE");
    }
    changed(session, s.tenantId);
  });
  return getSubscriptionDetail(sub._id);
}

/** Comp: the next due period is settled at zero (first purchase, renewal or overdue period). */
export async function compPeriod(req, id, { reason, planId = null, interval = null }) {
  const sub = await loadSubscriptionByIdOrTenant(id);
  const by = req.user?._id || null;
  await withTransaction(async (session) => {
    let s = await TenantSubscription.findById(sub._id, null, withSession(session));
    let planOverride = null;
    if (planId) {
      const plan = await loadPlan(planId, { session });
      planOverride = { planDoc: plan, snap: snapshotOf(plan, PLAN_INTERVALS.includes(interval) ? interval : plan.interval) };
    }
    await TenantSubscription.updateOne({ _id: s._id }, historyPush({ action: "comp", by, note: reason }), withSession(session));
    s = await TenantSubscription.findById(sub._id, null, withSession(session));
    const inv = await issuePeriodInvoice(s, { by, session, comp: reason || true, planOverride });
    if (inv.status !== "paid") throw new AppError(409, "Could not comp this period", "INVALID_STATE");
  });
  return getSubscriptionDetail(sub._id);
}

export async function setDiscount(req, id, body) {
  const sub = await loadSubscriptionByIdOrTenant(id);
  const by = req.user?._id || null;
  let update;
  if (body.type === "credit") {
    update = { $inc: { credits: round2(body.value) }, ...historyPush({ action: "credit_added", by, note: body.reason || "", data: { amount: body.value } }) };
  } else if (body.type === "none") {
    update = { $set: { discount: { type: null, value: 0, cyclesLeft: 0 } }, ...historyPush({ action: "discount_removed", by, note: body.reason || "" }) };
  } else {
    const cycles = body.cycles || 1;
    update = {
      $set: { discount: { type: body.type, value: round2(body.value), cyclesLeft: cycles } },
      ...historyPush({ action: "discount_set", by, note: body.reason || "", data: { type: body.type, value: body.value, cycles } }),
    };
  }
  await TenantSubscription.updateOne({ _id: sub._id }, update);
  return getSubscriptionDetail(sub._id);
}

/** Admin: issue the next due invoice, or a custom invoice from lines. */
export async function adminGenerateInvoice(req, id, body) {
  const sub = await loadSubscriptionByIdOrTenant(id);
  const by = req.user?._id || null;
  const invId = await withTransaction(async (session) => {
    const s = await TenantSubscription.findById(sub._id, null, withSession(session));
    let inv;
    if (body.kind === "custom") {
      inv = await createInvoice(s, { kind: "custom", lines: body.lines, dueAt: body.dueAt || null, note: body.note || "", by, adjust: false, session });
    } else {
      inv = await issuePeriodInvoice(s, { by, note: body.note || "", session });
      if (body.dueAt && inv.status === "issued") {
        await SubscriptionInvoice.updateOne({ _id: inv._id }, { $set: { dueAt: body.dueAt } }, withSession(session));
      }
    }
    await TenantSubscription.updateOne({ _id: s._id }, historyPush({ action: "invoice_generated", by, data: { invoiceId: inv._id, number: inv.number } }), withSession(session));
    return inv._id;
  });
  return presentInvoice(await SubscriptionInvoice.findById(invId), { admin: true });
}

export async function adminMarkPaid(req, invoiceId, { reference, mode = "bank_transfer", paidAt = null }) {
  const inv = await getInvoice(invoiceId);
  if (inv.status !== "issued") throw new AppError(409, `This invoice is ${inv.status}`, "INVALID_STATE");
  const { invoice } = await markInvoicePaid(inv._id, { method: "manual", reference, mode, paidAt }, { by: req.user?._id || null });
  return presentInvoice(invoice, { admin: true });
}

export async function adminVoidInvoice(req, invoiceId, { reason }) {
  const inv = await getInvoice(invoiceId);
  if (inv.status === "paid") throw new AppError(409, "A paid invoice cannot be voided", "INVALID_STATE");
  if (inv.status === "void") return presentInvoice(inv, { admin: true });
  await withTransaction((session) => voidInvoiceIn(inv, { reason, by: req.user?._id || null, session }));
  return presentInvoice(await SubscriptionInvoice.findById(inv._id), { admin: true });
}

/* ------------------------------------------------------------------ dunning job */

async function claimNotice(subId, key) {
  const res = await TenantSubscription.updateOne({ _id: subId, notices: { $ne: key } }, { $push: { notices: { $each: [key], $slice: -100 } } });
  return res.modifiedCount === 1;
}

async function outstandingTotal(tenantId) {
  return outstandingAmount(tenantId);
}

/**
 * Hourly (jobs/index.js "billing-renewals"). Every step is a conditional update, safe to overlap.
 *  1. legacy ending soon reminders (14 / 3 days)
 *  2. manual mode: renewal invoice issued RENEWAL_LEAD_DAYS before the period end (also for
 *     past_due / paused stores whose renewal has no open invoice, e.g. after autopay halted)
 *  3. period end: prepaid renewal -> period advanced; else -> past_due (grace = billing.graceDays)
 *  4. past_due reminders (day 3, 6)
 *  5. grace over -> subscription paused + store paused ("Subscription payment overdue")
 */
export async function runBillingRenewals({ now = new Date(), limit = 200 } = {}) {
  const out = { legacyReminders: 0, invoices: 0, renewed: 0, pastDue: 0, reminders: 0, paused: 0, errors: 0 };
  const settings = await billingSettings();
  const graceMs = settings.graceDays * DAY;
  const safe = async (sub, fn) => {
    try {
      await fn();
    } catch (err) {
      out.errors += 1;
      logger.error("billing-renewals", { subscription: String(sub._id), err: err.message });
    }
  };

  // 1. legacy ending soon
  const soon = await TenantSubscription.find({ status: "legacy", currentPeriodEnd: { $gt: now, $lte: new Date(now.getTime() + LEGACY_REMINDER_DAYS[0] * DAY) } }).limit(limit);
  for (const sub of soon) {
    await safe(sub, async () => {
      const daysLeft = Math.ceil((sub.currentPeriodEnd - now) / DAY);
      const due = LEGACY_REMINDER_DAYS.filter((d) => daysLeft <= d).sort((a, b) => a - b)[0];
      if (due == null) return;
      // Late start: only the smallest threshold due is sent.
      const key = `legacy:${isoDay(sub.currentPeriodEnd)}:${due}`;
      if (sub.notices.includes(key)) return;
      for (const d of LEGACY_REMINDER_DAYS.filter((x) => x >= due)) await claimNotice(sub._id, `legacy:${isoDay(sub.currentPeriodEnd)}:${d}`);
      emitDomain("SUBSCRIPTION_LEGACY_ENDING", { resource: "subscription", tenantId: sub.tenantId, legacyUntil: sub.currentPeriodEnd, daysLeft });
      out.legacyReminders += 1;
    });
  }

  // 2. renewal invoices (manual mode, or no live autopay)
  const lead = new Date(now.getTime() + RENEWAL_LEAD_DAYS * DAY);
  const renewable = await TenantSubscription.find({
    status: { $in: ["active", "past_due", "paused"] },
    currentPeriodEnd: { $ne: null, $lte: lead },
    "planSnapshot.code": { $ne: LEGACY_PLAN_CODE },
    $or: [{ billingMode: "manual" }, { razorpaySubscriptionStatus: { $in: ["halted", "cancelled", "completed", "expired", ""] } }],
  }).limit(limit);
  for (const sub of renewable) {
    await safe(sub, async () => {
      const start = sub.currentPeriodEnd;
      const exists = await SubscriptionInvoice.exists({ subscriptionId: sub._id, kind: "renewal", status: { $in: ["issued", "paid"] }, "period.start": start });
      if (exists) return;
      await withTransaction(async (session) => {
        const s = await TenantSubscription.findById(sub._id, null, withSession(session));
        if (String(s.currentPeriodEnd?.getTime()) !== String(start.getTime())) return;
        const inv = await issuePeriodInvoice(s, { session });
        if (inv) out.invoices += 1;
      });
    });
  }

  // 3. period ended: roll a prepaid renewal, else past_due
  const ended = await TenantSubscription.find({ status: { $in: ["active", "legacy"] }, currentPeriodEnd: { $ne: null, $lte: now } }).limit(limit);
  for (const sub of ended) {
    await safe(sub, async () => {
      const prepaid = await SubscriptionInvoice.findOne({ subscriptionId: sub._id, kind: "renewal", status: "paid", "period.start": sub.currentPeriodEnd });
      if (prepaid) {
        await withTransaction((session) => applyPaidInvoice(prepaid, { session, now: new Date(Math.max(now.getTime(), prepaid.period.start.getTime())) }));
        out.renewed += 1;
        return;
      }
      const autopayLive = sub.billingMode === "autopay" && ["active", "authenticated", "pending"].includes(sub.razorpaySubscriptionStatus);
      if (autopayLive && sub.currentPeriodEnd.getTime() + AUTOPAY_SLACK_MS > now.getTime()) return;
      const graceEndsAt = new Date(sub.currentPeriodEnd.getTime() + graceMs);
      const moved = await withTransaction(async (session) => {
        const res = await TenantSubscription.findOneAndUpdate(
          { _id: sub._id, status: sub.status, currentPeriodEnd: sub.currentPeriodEnd },
          { $set: { status: "past_due", graceEndsAt, pastDueSince: now }, ...historyPush({ action: "past_due", from: sub.status, to: "past_due", note: sub.status === "legacy" ? "Legacy plan ended" : "Renewal unpaid" }) },
          withSession(session, { new: true })
        );
        if (res) changed(session, sub.tenantId);
        return res;
      });
      if (!moved) return;
      out.pastDue += 1;
      await claimNotice(sub._id, `pastdue:${isoDay(now)}:0`);
      emitDomain("SUBSCRIPTION_PAST_DUE", {
        resource: "subscription",
        tenantId: sub.tenantId,
        day: 0,
        graceEndsAt,
        amount: await outstandingTotal(sub.tenantId),
        needsPlan: sub.status === "legacy" && !sub.pendingPlanId,
      });
    });
  }

  // 4. reminders day 3 / 6
  const overdue = await TenantSubscription.find({ status: "past_due", pastDueSince: { $ne: null }, graceEndsAt: { $gt: now } }).limit(limit);
  for (const sub of overdue) {
    await safe(sub, async () => {
      const days = Math.floor((now - sub.pastDueSince) / DAY);
      const due = PAST_DUE_REMINDER_DAYS.filter((d) => d > 0 && days >= d).sort((a, b) => b - a)[0];
      if (!due) return;
      const base = `pastdue:${isoDay(sub.pastDueSince)}`;
      if (sub.notices.includes(`${base}:${due}`)) return;
      for (const d of PAST_DUE_REMINDER_DAYS.filter((x) => x > 0 && x <= due)) await claimNotice(sub._id, `${base}:${d}`);
      emitDomain("SUBSCRIPTION_PAST_DUE", {
        resource: "subscription",
        tenantId: sub.tenantId,
        day: due,
        graceEndsAt: sub.graceEndsAt,
        amount: await outstandingTotal(sub.tenantId),
        needsPlan: needsFirstPurchase(sub) && !sub.pendingPlanId,
      });
      out.reminders += 1;
    });
  }

  // 5. grace over -> pause
  const lapsed = await TenantSubscription.find({ status: "past_due", graceEndsAt: { $ne: null, $lte: now } }).limit(limit);
  for (const sub of lapsed) {
    await safe(sub, async () => {
      const done = await withTransaction(async (session) => {
        const res = await TenantSubscription.findOneAndUpdate(
          { _id: sub._id, status: "past_due", graceEndsAt: { $lte: now } },
          { $set: { status: "paused" }, ...historyPush({ action: "paused", from: "past_due", to: "paused", note: "Grace period over" }) },
          withSession(session, { new: true })
        );
        if (!res) return false;
        const tenant = await Tenant.findById(sub.tenantId, null, withSession(session)).lean();
        if (tenant?.status === "active") {
          const { setTenantStatus } = await import("../tenants/service.js");
          await setTenantStatus(sub.tenantId, "paused", { reason: BILLING_PAUSE_REASONS.overdue, session, source: "billing" });
        }
        changed(session, sub.tenantId);
        emitAfter(session, "SUBSCRIPTION_PAUSED", { tenantId: sub.tenantId, reason: BILLING_PAUSE_REASONS.overdue, amount: await outstandingTotal(sub.tenantId) });
        return true;
      });
      if (done) out.paused += 1;
    });
  }
  return out;
}
