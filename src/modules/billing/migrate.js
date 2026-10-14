import { Plan, snapshotOf, LEGACY_PLAN_CODE, PLAN_LIMIT_KEYS, PLAN_FEATURE_KEYS } from "./plan.model.js";
import { TenantSubscription } from "./subscription.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { Settings } from "../settings/settings.model.js";
import { getSetting, invalidateSettingCache } from "../settings/service.js";
import { logger } from "../../utils/logger.js";

export const LEGACY_DEFAULT_DAYS = 90;

/** Free legacy plan (code `legacy`, price 0, unlimited, every feature, hidden). Idempotent. */
export async function ensureLegacyPlan() {
  await Plan.updateOne(
    { code: LEGACY_PLAN_CODE },
    {
      $setOnInsert: {
        code: LEGACY_PLAN_CODE,
        name: "Legacy",
        description: "Free plan for stores that joined before subscriptions. Choose a paid plan before it ends.",
        priceInr: 0,
        interval: "monthly",
        limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, -1])),
        features: Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, true])),
        isPublic: false,
        sortOrder: 9999,
        status: "active",
      },
    },
    { upsert: true }
  ).catch((err) => {
    if (err?.code !== 11000) throw err;
  });
  return Plan.findOne({ code: LEGACY_PLAN_CODE });
}

/**
 * End of the legacy period: setting `billing.legacyUntil` when set, else 90 days after the first
 * migration run (written back to the setting so every instance / later boot uses the same date).
 */
export async function legacyUntilDate() {
  const raw = await getSetting("platform", null, "billing.legacyUntil", null);
  const parsed = raw ? new Date(raw) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  const value = new Date(Date.now() + LEGACY_DEFAULT_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await Settings.updateOne(
    { scope: "platform", tenantId: null, key: "billing.legacyUntil", $or: [{ value: null }, { value: "" }, { value: { $exists: false } }] },
    { $set: { value } },
    { upsert: true }
  ).catch((err) => {
    if (err?.code !== 11000) throw err;
  });
  invalidateSettingCache();
  const again = await getSetting("platform", null, "billing.legacyUntil", value);
  return new Date(again || value);
}

/**
 * Bootstrap migration (idempotent): legacy plan + a `legacy` TenantSubscription (until
 * legacyUntil) for every existing store without a subscription. Stores approved through the
 * billing flow already have one and are skipped.
 */
export async function runBillingMigrations() {
  const legacy = await ensureLegacyPlan();
  const tenantIds = await Tenant.find({}).distinct("_id");
  const have = new Set((await TenantSubscription.find({ tenantId: { $in: tenantIds } }).distinct("tenantId")).map(String));
  const missing = tenantIds.filter((id) => !have.has(String(id)));
  if (!missing.length) return { legacyAssigned: 0 };
  const until = await legacyUntilDate();
  const now = new Date();
  const ops = missing.map((tenantId) => ({
    updateOne: {
      filter: { tenantId },
      update: {
        $setOnInsert: {
          tenantId,
          planId: legacy._id,
          planSnapshot: snapshotOf(legacy, legacy.interval),
          status: "legacy",
          billingMode: "manual",
          currentPeriodStart: now,
          currentPeriodEnd: until,
          legacyUntil: until,
          credits: 0,
          notices: [],
          history: [{ at: now, action: "created", to: "legacy", note: "Legacy plan assigned by migration" }],
        },
      },
      upsert: true,
    },
  }));
  let assigned = 0;
  for (let i = 0; i < ops.length; i += 500) {
    try {
      const res = await TenantSubscription.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      assigned += res.upsertedCount || 0;
    } catch (err) {
      if (err?.code !== 11000 && !err?.writeErrors) throw err;
      assigned += err?.result?.upsertedCount || err?.result?.nUpserted || 0;
    }
  }
  if (assigned) logger.info("billing migration: legacy plan assigned", { stores: assigned, legacyUntil: until.toISOString() });
  return { legacyAssigned: assigned };
}
