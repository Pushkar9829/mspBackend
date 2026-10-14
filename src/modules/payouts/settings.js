import { Settings } from "../settings/settings.model.js";
import { getSetting, invalidateSettingCache } from "../settings/service.js";
import { SETTINGS_REGISTRY } from "../settings/registry.js";

/** Payout settings (platform scope). Fresh reads: payout runs are rare and must see admin changes at once. */

function def(key, fallback) {
  const d = SETTINGS_REGISTRY[key]?.default;
  return d === undefined ? fallback : d;
}

async function read(key, fallback) {
  try {
    const v = await getSetting("platform", null, key, undefined);
    return v === undefined || v === null ? def(key, fallback) : v;
  } catch {
    return def(key, fallback);
  }
}

/**
 * First day orders go on the seller ledger: the `payouts.startDate` setting, else the moment this
 * was first asked (written back so every instance / later boot uses the same date).
 */
export async function payoutsStartDate() {
  const raw = await getSetting("platform", null, "payouts.startDate", null).catch(() => null);
  const parsed = raw ? new Date(raw) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return parsed;
  const value = new Date().toISOString();
  await Settings.updateOne(
    { scope: "platform", tenantId: null, key: "payouts.startDate", $or: [{ value: null }, { value: "" }, { value: { $exists: false } }] },
    { $set: { value } },
    { upsert: true }
  ).catch((err) => {
    if (err?.code !== 11000) throw err;
  });
  invalidateSettingCache();
  const again = await getSetting("platform", null, "payouts.startDate", value);
  return new Date(again || value);
}

export async function payoutSettings() {
  const [mode, hold, minAmount, passGatewayFees, netSubscriptionDues, schedule] = await Promise.all([
    read("payouts.mode", "manual"),
    read("payouts.holdDaysAfterDelivery", 7),
    read("payouts.minAmount", 100),
    read("payouts.passGatewayFees", true),
    read("payouts.netSubscriptionDues", true),
    read("payouts.schedule", "daily"),
  ]);
  return {
    mode: mode === "route" ? "route" : "manual",
    holdDaysAfterDelivery: Math.max(0, Number.isFinite(Number(hold)) ? Number(hold) : 7),
    minAmountPaise: Math.max(0, Math.round((Number(minAmount) || 0) * 100)),
    passGatewayFees: passGatewayFees !== false,
    netSubscriptionDues: netSubscriptionDues !== false,
    schedule: schedule === "weekly" ? "weekly" : "daily",
  };
}

/** Startup migration (idempotent): fixes payouts.startDate on first run. */
export async function runPayoutMigrations() {
  return { startDate: (await payoutsStartDate()).toISOString() };
}
