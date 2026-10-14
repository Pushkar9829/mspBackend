import mongoose from "mongoose";

/** Limit kinds (numeric, -1 = unlimited) and feature flags every plan carries. */
export const PLAN_LIMIT_KEYS = ["products", "staff", "riders", "warehouses", "coupons", "offers", "priceLists"];
export const PLAN_FEATURE_KEYS = ["coupons", "offers", "creditTerms", "reports", "exports", "analytics", "featuredPlacement", "customRoles"];
export const PLAN_INTERVALS = ["monthly", "yearly"];
export const LEGACY_PLAN_CODE = "legacy";

const limitsDef = Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, { type: Number, default: -1 }]));
const featuresDef = Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, { type: Boolean, default: false }]));

/**
 * Seller subscription plan (dynamic, managed by platform admins). `priceInr` is GST-exclusive and
 * applies to `interval`; `intervalPrices` optionally overrides the price of the other interval
 * (default: monthly x 12 for yearly, yearly / 12 for monthly). Price changes affect new
 * subscriptions / next renewal only (subscriptions keep a `planSnapshot`).
 * `razorpayPlanIds` are created lazily per interval and cleared when the price changes.
 */
const planSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    priceInr: { type: Number, required: true, min: 0 },
    interval: { type: String, enum: PLAN_INTERVALS, default: "monthly" },
    intervalPrices: {
      monthly: { type: Number, default: null },
      yearly: { type: Number, default: null },
    },
    limits: limitsDef,
    features: featuresDef,
    isPublic: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "archived"], default: "active", index: true },
    razorpayPlanIds: {
      monthly: { type: String, default: "" },
      yearly: { type: String, default: "" },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);
planSchema.index({ code: 1 }, { unique: true });
planSchema.index({ status: 1, isPublic: 1, sortOrder: 1 });

export const Plan = mongoose.models.Plan || mongoose.model("Plan", planSchema);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** GST-exclusive price of `plan` for `interval`. */
export function planPrice(plan, interval = plan?.interval) {
  if (!plan) return 0;
  const want = PLAN_INTERVALS.includes(interval) ? interval : plan.interval;
  if (want === plan.interval) return round2(plan.priceInr);
  const override = plan.intervalPrices?.[want];
  if (override != null && override >= 0) return round2(override);
  return want === "yearly" ? round2(plan.priceInr * 12) : round2(plan.priceInr / 12);
}

/** Snapshot stored on a subscription / invoice. */
export function snapshotOf(plan, interval = plan?.interval) {
  const p = typeof plan?.toObject === "function" ? plan.toObject() : plan || {};
  const want = PLAN_INTERVALS.includes(interval) ? interval : p.interval || "monthly";
  return {
    code: p.code || "",
    name: p.name || "",
    priceInr: planPrice(p, want),
    interval: want,
    limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, p.limits?.[k] ?? -1])),
    features: Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, Boolean(p.features?.[k])])),
  };
}
