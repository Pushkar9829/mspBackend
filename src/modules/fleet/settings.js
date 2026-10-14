import { getSetting } from "../settings/service.js";
import { SETTINGS_REGISTRY } from "../settings/registry.js";

/** Own-fleet settings of a store: store override -> platform value -> registry default. Fresh reads. */
async function read(tenantId, key) {
  const def = SETTINGS_REGISTRY[key];
  if (tenantId && def?.scopes.includes("tenant")) {
    const own = await getSetting("tenant", tenantId, key, undefined).catch(() => undefined);
    if (own !== undefined && own !== null) return own;
  }
  const platform = await getSetting("platform", null, key, undefined).catch(() => undefined);
  return platform !== undefined && platform !== null ? platform : def?.default;
}

export async function fleetSettings(tenantId) {
  const [maxAttempts, autoAssign, keepRider] = await Promise.all([
    read(tenantId, "fleet.maxAttempts"),
    read(tenantId, "fleet.autoAssign"),
    read(tenantId, "fleet.keepRiderOnReschedule"),
  ]);
  const n = Number(maxAttempts);
  return {
    maxAttempts: Number.isInteger(n) && n >= 1 && n <= 5 ? n : 2,
    autoAssign: autoAssign === true,
    // Always on: deliveries are completed only with the buyer's OTP (no skipping).
    otpRequired: true,
    keepRiderOnReschedule: keepRider !== false,
  };
}
