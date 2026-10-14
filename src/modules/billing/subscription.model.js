import mongoose from "mongoose";
import { PLAN_LIMIT_KEYS, PLAN_FEATURE_KEYS, PLAN_INTERVALS } from "./plan.model.js";

const { ObjectId } = mongoose.Schema.Types;

export const SUBSCRIPTION_STATUSES = ["awaiting_payment", "active", "past_due", "paused", "cancelled", "legacy"];
export const BILLING_MODES = ["autopay", "manual"];

export const planSnapshotSchema = new mongoose.Schema(
  {
    code: { type: String, default: "" },
    name: { type: String, default: "" },
    priceInr: { type: Number, default: 0 },
    interval: { type: String, enum: PLAN_INTERVALS, default: "monthly" },
    limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, { type: Number, default: -1 }])),
    features: Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, { type: Boolean, default: false }])),
  },
  { _id: false }
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    by: { type: ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

/** Percent off for `cyclesLeft` invoices, or a fixed INR amount (GST-exclusive) off the next `cyclesLeft` invoices. */
const discountSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["percent", "amount", null], default: null },
    value: { type: Number, default: 0 },
    cyclesLeft: { type: Number, default: 0 },
  },
  { _id: false }
);

/**
 * One per store. Lifecycle: awaiting_payment -> active (first payment) -> renewals; unpaid renewal
 * -> past_due (grace `graceEndsAt`) -> paused (store paused) -> active on payment. Existing stores
 * start as `legacy` until `legacyUntil` (= currentPeriodEnd), then behave like a renewal due.
 */
const subscriptionSchema = new mongoose.Schema(
  {
    tenantId: { type: ObjectId, ref: "Tenant", required: true },
    planId: { type: ObjectId, ref: "Plan", default: null },
    planSnapshot: { type: planSnapshotSchema, default: () => ({}) },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: "awaiting_payment", index: true },
    billingMode: { type: String, enum: BILLING_MODES, default: "manual" },
    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null, index: true },
    graceEndsAt: { type: Date, default: null },
    /** When the current overdue episode started (reminders day 0 / 3 / 6 count from here). */
    pastDueSince: { type: Date, default: null },
    /** Downgrade (or interval change) applied at the next renewal. */
    pendingPlanId: { type: ObjectId, ref: "Plan", default: null },
    pendingInterval: { type: String, enum: [...PLAN_INTERVALS, null], default: null },
    razorpaySubscriptionId: { type: String, default: "" },
    razorpaySubscriptionStatus: { type: String, default: "" },
    razorpayShortUrl: { type: String, default: "" },
    legacyUntil: { type: Date, default: null },
    discount: { type: discountSchema, default: () => ({}) },
    /** INR credit (GST-exclusive) consumed by the next invoices. */
    credits: { type: Number, default: 0, min: 0 },
    /** Dunning / reminder keys already sent (e.g. "2026-11-01:d3", "legacy:14"). */
    notices: { type: [String], default: [] },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);
subscriptionSchema.index({ tenantId: 1 }, { unique: true });
subscriptionSchema.index({ razorpaySubscriptionId: 1 }, { partialFilterExpression: { razorpaySubscriptionId: { $gt: "" } } });

export const TenantSubscription = mongoose.models.TenantSubscription || mongoose.model("TenantSubscription", subscriptionSchema);
