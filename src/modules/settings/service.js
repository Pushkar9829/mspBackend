import { Settings } from "./settings.model.js";
import { AppError } from "../../utils/AppError.js";
import { settingDefinition, knownKeys, describeSetting } from "./registry.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listSettings(req) {
  const filter = {};
  if (req.isPlatformAdmin && !req.tenantId) {
    filter.scope = req.query.scope === "tenant" ? "tenant" : "platform";
    if (filter.scope === "platform") filter.tenantId = null;
    else if (req.query.tenantId && /^[a-f\d]{24}$/i.test(String(req.query.tenantId))) filter.tenantId = req.query.tenantId;
  } else {
    if (!req.tenantId) throw new AppError(403, "Tenant context required", "FORBIDDEN");
    filter.scope = "tenant";
    filter.tenantId = req.tenantId;
  }
  if (req.query.q) filter.key = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 100)), "i");
  return Settings.find(filter).sort({ key: 1 }).limit(500);
}

/**
 * Schema metadata for admin UIs. `keys` = keys writable in the caller's scope (legacy list);
 * `definitions` = one entry per key with type, label, description, group, min/max/enum,
 * default, allowed scopes, overridable, secret and public flags.
 */
export function listKeys(req) {
  const scope = req.isPlatformAdmin && !req.tenantId ? "platform" : "tenant";
  const keys = knownKeys(scope);
  return { scope, keys, definitions: keys.map(describeSetting) };
}

function callerScope(req) {
  const scope = req.isPlatformAdmin && !req.tenantId ? "platform" : "tenant";
  if (scope === "tenant" && !req.tenantId) {
    throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  }
  return scope;
}

/**
 * Validate `value` against the key's schema and upsert it in the caller's scope.
 * Unknown keys / keys not writable in this scope → 404; invalid value → 400.
 */
export async function upsertSetting(req, key, value) {
  const scope = callerScope(req);
  const def = settingDefinition(key);
  if (!def || !def.scopes.includes(scope)) {
    throw new AppError(404, `Unknown setting "${key}" for ${scope} scope`, "NOT_FOUND");
  }
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) {
    const fields = {};
    for (const issue of parsed.error.issues) {
      const path = ["value", ...issue.path].join(".");
      if (!(path in fields)) fields[path] = issue.message;
    }
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new AppError(400, `value${path ? `.${path}` : ""}: ${issue.message}`, "VALIDATION_ERROR", { fields });
  }
  const row = await Settings.findOneAndUpdate(
    { scope, tenantId: scope === "platform" ? null : req.tenantId, key },
    { $set: { value: parsed.data } },
    { upsert: true, new: true }
  );
  invalidateSettingCache();
  return row;
}

/**
 * Remove a store override so the store falls back to the platform default.
 * Only `scope=tenant` is supported (platform values are edited, not deleted). Tenant staff act on
 * their own store; platform admins pass `tenantId` (query, resolved into req.tenantId).
 * Returns { ok, key, scope, tenantId, removed, effective } where `effective` is the value now in force.
 */
export async function deleteTenantOverride(req, key) {
  const requested = String(req.query.scope || "tenant");
  if (requested !== "tenant") {
    throw new AppError(400, "Only tenant overrides can be removed (scope=tenant)", "VALIDATION_ERROR");
  }
  if (!req.tenantId) throw new AppError(400, "Tenant context required (tenantId)", "TENANT_REQUIRED");
  const def = settingDefinition(key);
  if (!def || !def.scopes.includes("tenant")) {
    throw new AppError(404, `Unknown setting "${key}" for tenant scope`, "NOT_FOUND");
  }
  const removed = await Settings.findOneAndDelete({ scope: "tenant", tenantId: req.tenantId, key });
  invalidateSettingCache();
  const effective = def.scopes.includes("platform")
    ? await getSetting("platform", null, key, def.default ?? null)
    : def.default ?? null;
  return {
    ok: true,
    key,
    scope: "tenant",
    tenantId: req.tenantId,
    removed: Boolean(removed),
    previous: removed ? removed.value : undefined,
    effective,
    source: def.scopes.includes("platform") ? "platform" : "default",
  };
}

export async function getSetting(scope, tenantId, key, fallback = null) {
  const row = await Settings.findOne({
    scope,
    tenantId: tenantId || null,
    key,
  }).lean();
  return row ? row.value : fallback;
}

/* ---------------------------------------------------------------- small read cache */

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

/** Cached getSetting for hot paths (emails, public endpoints). 60s TTL; cleared on writes. */
export async function getCachedSetting(scope, tenantId, key, fallback = null) {
  const id = `${scope}:${tenantId || ""}:${key}`;
  const hit = cache.get(id);
  if (hit && hit.at > Date.now() - CACHE_TTL_MS) return hit.value === undefined ? fallback : hit.value;
  const value = await getSetting(scope, tenantId, key, undefined);
  cache.set(id, { at: Date.now(), value });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value === undefined ? fallback : value;
}

export function invalidateSettingCache() {
  cache.clear();
}

/** Platform support email (setting, else SUPPORT_EMAIL env, else ""). Never throws. */
export async function supportEmail() {
  try {
    const value = await getCachedSetting("platform", null, "platform.supportEmail", "");
    return String(value || process.env.SUPPORT_EMAIL || "").trim();
  } catch {
    return String(process.env.SUPPORT_EMAIL || "").trim();
  }
}

/** Effective maps provider: the platform setting, else MAPS_PROVIDER env ("stub"). */
export async function mapsProvider(fallback = "stub") {
  try {
    return String((await getCachedSetting("platform", null, "platform.mapsProvider", fallback)) || fallback);
  } catch {
    return fallback;
  }
}
