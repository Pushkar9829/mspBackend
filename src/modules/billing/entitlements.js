/**
 * Plan entitlements (Phase 3, "p3-limits"): what a store's subscription plan allows (feature flags)
 * and how many items of each kind it may hold (limits, -1 = unlimited), plus live usage.
 *
 * - getEntitlements(tenantId)            -> { plan, status, features, limits, usage, ... }
 * - invalidateEntitlements(tenantId?)    -> drop the cached plan part (p3-billing calls this on
 *                                           every subscription change; no argument = all tenants)
 * - requireFeature(flag)                 -> express middleware, 403 PLAN_FEATURE_REQUIRED
 * - assertWithinLimit(tenantId, kind, {adding, session, req}) -> 403 LIMIT_REACHED
 *
 * Rules:
 * - Platform admins bypass every check (middleware: req.isPlatformAdmin; services pass `req`).
 * - No subscription, or status "legacy" -> unlimited + every feature (existing stores are never
 *   blocked by accident before / during the migration).
 * - Any other status (active, past_due, awaiting_payment, paused, cancelled) keeps the plan's
 *   limits/features (pausing the store is enforced elsewhere).
 * - Downgrade: nothing is deleted or unpublished; only NEW items are blocked while usage >= limit.
 *   `adding: 0` means "nothing new is added, but block while the store is OVER its limit" (used for
 *   publishing a draft / adding a variant after a downgrade).
 *
 * The plan part is cached ~30 s per tenant; usage is always counted fresh (cheap indexed counts),
 * so consecutive creates can't overshoot a limit through a stale cache.
 */
import mongoose from "mongoose";
import { AppError } from "../../utils/AppError.js";
import { Product } from "../catalog/product.model.js";
import { User } from "../users/user.model.js";
import { Warehouse } from "../inventory/warehouse.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { Offer } from "../pricing/offer.model.js";
import { PriceList } from "../pricing/priceList.model.js";
import { Role } from "../rbac/role.model.js";
import { Rider } from "../fleet/models.js";
import { Plan } from "./plan.model.js";
import { TenantSubscription } from "./subscription.model.js";

export const LIMIT_KINDS = ["products", "staff", "riders", "warehouses", "coupons", "offers", "priceLists"];
export const FEATURE_FLAGS = ["coupons", "offers", "creditTerms", "reports", "exports", "analytics", "featuredPlacement", "customRoles"];

const CACHE_MS = 30 * 1000;
const cache = new Map(); // tenantId -> { at, value: Promise<planPart> }

const KIND_LABELS = {
  products: "products",
  staff: "active staff members",
  riders: "riders",
  warehouses: "active warehouses",
  coupons: "active coupons",
  offers: "active offers",
  priceLists: "active price lists",
};
const FEATURE_LABELS = {
  coupons: "coupons",
  offers: "offers",
  creditTerms: "credit terms and purchase orders",
  reports: "reports",
  exports: "data exports",
  analytics: "analytics",
  featuredPlacement: "featured placement",
  customRoles: "custom roles",
};
/** Creating items of these kinds also needs the feature of the same name. */
const KIND_FEATURE = { coupons: "coupons", offers: "offers" };

const UNLIMITED_LIMITS = Object.freeze(Object.fromEntries(LIMIT_KINDS.map((k) => [k, -1])));
const ALL_FEATURES = Object.freeze(Object.fromEntries(FEATURE_FLAGS.map((f) => [f, true])));

function idOf(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "object" && value._id) return idOf(value._id);
  return mongoose.Types.ObjectId.isValid(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null;
}

/* ------------------------------------------------------------------ plan part */

function normalizeLimits(limits = {}) {
  const out = {};
  for (const k of LIMIT_KINDS) {
    const n = Number(limits?.[k]);
    out[k] = limits?.[k] == null || !Number.isFinite(n) || n < 0 ? -1 : Math.floor(n);
  }
  return out;
}

function normalizeFeatures(features = {}) {
  return Object.fromEntries(FEATURE_FLAGS.map((f) => [f, Boolean(features?.[f])]));
}

function unlimitedPart(source, status = null) {
  return {
    plan: source === "legacy" ? { code: "legacy", name: "Legacy" } : { code: null, name: "No plan" },
    status: status || (source === "legacy" ? "legacy" : "none"),
    source,
    unlimited: true,
    features: { ...ALL_FEATURES },
    limits: { ...UNLIMITED_LIMITS },
  };
}

async function loadPlanPart(tenantId) {
  const sub = await TenantSubscription.findOne({ tenantId }).lean();
  if (!sub) return unlimitedPart("none");
  if (sub.status === "legacy") return unlimitedPart("legacy", "legacy");
  // The snapshot (taken when the plan was bought) is authoritative; an empty one falls back to the plan.
  let snap = sub.planSnapshot?.code ? sub.planSnapshot : null;
  if (!snap && sub.planId) snap = await Plan.findById(sub.planId).lean();
  if (!snap) return unlimitedPart("none", sub.status);
  return {
    plan: { code: snap.code || null, name: snap.name || "" },
    status: sub.status,
    source: "subscription",
    unlimited: false,
    features: normalizeFeatures(snap.features),
    limits: normalizeLimits(snap.limits),
  };
}

async function planPart(tenantId) {
  const key = String(tenantId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = loadPlanPart(tenantId);
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 5000) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_MS) cache.delete(k);
  }
  return value;
}

/** Drop the cached plan of one store (or of every store when called without an id). */
export function invalidateEntitlements(tenantId) {
  if (tenantId === undefined || tenantId === null) cache.clear();
  else cache.delete(String(idOf(tenantId) || tenantId));
}

/* ------------------------------------------------------------------ usage */

function liveWindow(now) {
  return { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] };
}

let riderRoleId = null;
/** _id of the system rider role (cached once found). */
async function riderRole() {
  if (riderRoleId) return riderRoleId;
  const row = await Role.findOne({ slug: "rider", isSystem: true }).select("_id").lean();
  if (row) riderRoleId = row._id;
  return riderRoleId;
}

/** Filters that define "usage" per kind. */
async function usageFilter(kind, tenantId, now = new Date()) {
  switch (kind) {
    case "products":
      return [Product, { tenantId, status: { $ne: "archived" } }];
    case "staff": {
      // Buyers and platform users have tenantId null, so every user of the store is staff —
      // except delivery riders (phase 5), who count as `riders`.
      const rider = await riderRole();
      return [User, rider ? { tenantId, status: "active", roleId: { $ne: rider } } : { tenantId, status: "active" }];
    }
    case "riders":
      // Phase 5: active rider profiles of the store's own delivery fleet.
      return [Rider, { tenantId, status: "active" }];
    case "warehouses":
      return [Warehouse, { tenantId, status: { $ne: "inactive" } }];
    case "coupons":
      return [Coupon, { tenantId, status: "active", ...liveWindow(now) }];
    case "offers":
      return [Offer, { tenantId, status: "active", ...liveWindow(now) }];
    case "priceLists":
      return [PriceList, { tenantId, status: "active" }];
    default:
      return null;
  }
}

export async function countUsage(tenantId, kind, { session } = {}) {
  const spec = await usageFilter(kind, idOf(tenantId));
  if (!spec) return 0;
  const [Model, filter] = spec;
  const q = Model.countDocuments(filter);
  if (session) q.session(session);
  return q;
}

/** True when a coupon / offer document counts towards the "active" usage right now. */
export function isLivePromo(doc, now = new Date()) {
  if (!doc || doc.status !== "active") return false;
  return !doc.endsAt || new Date(doc.endsAt).getTime() > now.getTime();
}

/* ------------------------------------------------------------------ public API */

/**
 * Entitlements of a store: { tenantId, plan: {code,name}, status, source, unlimited, features,
 * limits, usage, remaining }. `remaining[kind]` is null for unlimited kinds.
 */
export async function getEntitlements(tenantId) {
  const id = idOf(tenantId);
  if (!id) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const part = await planPart(id);
  const counts = await Promise.all(LIMIT_KINDS.map((k) => countUsage(id, k)));
  const usage = Object.fromEntries(LIMIT_KINDS.map((k, i) => [k, counts[i]]));
  const remaining = Object.fromEntries(
    LIMIT_KINDS.map((k) => [k, part.limits[k] < 0 ? null : Math.max(0, part.limits[k] - usage[k])])
  );
  return {
    tenantId: id,
    plan: { ...part.plan },
    status: part.status,
    source: part.source,
    unlimited: part.unlimited,
    features: { ...part.features },
    limits: { ...part.limits },
    usage,
    remaining,
  };
}

/** Plan + features only (no usage counts). */
export async function getPlanEntitlements(tenantId) {
  const id = idOf(tenantId);
  if (!id) return { ...unlimitedPart("none") };
  return planPart(id);
}

function featureError(flag, plan) {
  const label = FEATURE_LABELS[flag] || flag;
  const planName = plan?.name ? `Your plan (${plan.name})` : "Your plan";
  return new AppError(403, `${planName} does not include ${label}. Upgrade your plan to use it.`, "PLAN_FEATURE_REQUIRED", {
    feature: flag,
    plan: { code: plan?.code ?? null, name: plan?.name ?? "" },
  });
}

/** True when the store's plan has `flag` (platform admins always do). */
export async function hasFeature(tenantId, flag, { req } = {}) {
  if (req?.isPlatformAdmin) return true;
  const id = idOf(tenantId);
  if (!id) return true;
  const part = await planPart(id);
  return Boolean(part.features[flag]);
}

/** Throws 403 PLAN_FEATURE_REQUIRED when the store's plan lacks `flag`. */
export async function assertFeature(tenantId, flag, { req } = {}) {
  if (req?.isPlatformAdmin) return;
  const id = idOf(tenantId);
  if (!id) return;
  const part = await planPart(id);
  if (!part.features[flag]) throw featureError(flag, part.plan);
}

/**
 * Express middleware: 403 PLAN_FEATURE_REQUIRED { feature, plan } unless the store's plan has
 * `flag`. Must run after authenticate + resolveTenant. Platform admins and requests without a store
 * context pass (tenant guards elsewhere handle those).
 */
export function requireFeature(flag) {
  return (req, _res, next) => {
    if (req.isPlatformAdmin) return next();
    const tenantId = req.tenantId || idOf(req.user?.tenantId);
    if (!tenantId) return next();
    assertFeature(tenantId, flag).then(() => next(), next);
  };
}

/**
 * Throws 403 LIMIT_REACHED { kind, limit, usage, adding, available } when adding `adding` items
 * of `kind` would take the store over its plan limit. `adding: 0` only blocks a store that is
 * already OVER the limit (after a downgrade). Pass `req` so platform admins bypass. Kinds tied to
 * a feature (coupons, offers) throw PLAN_FEATURE_REQUIRED when the feature is off.
 */
export async function assertWithinLimit(tenantId, kind, { adding = 1, session, req } = {}) {
  if (req?.isPlatformAdmin) return;
  const id = idOf(tenantId);
  if (!id) return;
  const part = await planPart(id);
  const flag = KIND_FEATURE[kind];
  if (flag && !part.features[flag]) throw featureError(flag, part.plan);
  const limit = part.limits[kind];
  if (limit == null || limit < 0) return;
  const add = Math.max(0, Number(adding) || 0);
  const usage = await countUsage(id, kind, { session });
  if (usage + add <= limit) return;
  const label = KIND_LABELS[kind] || kind;
  const available = Math.max(0, limit - usage);
  const planName = part.plan?.name ? `Your plan (${part.plan.name})` : "Your plan";
  let message;
  if (add === 0) {
    message = `${planName} allows ${limit} ${label} and this store has ${usage}. Remove some or upgrade your plan to continue.`;
  } else if (add === 1) {
    message = `${planName} allows ${limit} ${label} and this store has ${usage}. Upgrade your plan to add more.`;
  } else {
    message = `${planName} allows ${limit} ${label} and this store has ${usage}: only ${available} more can be added, this request adds ${add}. Upgrade your plan or reduce the batch.`;
  }
  throw new AppError(403, message, "LIMIT_REACHED", {
    kind,
    limit,
    usage,
    adding: add,
    available,
    plan: { code: part.plan?.code ?? null, name: part.plan?.name ?? "" },
  });
}

/** Test hook. */
export function __resetEntitlementsCache() {
  cache.clear();
}
