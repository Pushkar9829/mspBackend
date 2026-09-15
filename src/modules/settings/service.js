import { Settings } from "./settings.model.js";
import { AppError } from "../../utils/AppError.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listSettings(req) {
  const filter = {};
  if (req.isPlatformAdmin && !req.tenantId) {
    filter.scope = req.query.scope === "tenant" ? "tenant" : "platform";
    if (filter.scope === "platform") filter.tenantId = null;
    else if (req.query.tenantId) filter.tenantId = req.query.tenantId;
  } else {
    filter.scope = "tenant";
    filter.tenantId = req.tenantId;
  }
  if (req.query.q) filter.key = new RegExp(escapeRegex(req.query.q.trim()), "i");
  return Settings.find(filter).sort({ key: 1 });
}

export async function upsertSetting(req, key, value) {
  const scope = req.isPlatformAdmin && !req.tenantId ? "platform" : "tenant";
  if (scope === "tenant" && !req.tenantId) {
    throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  }
  return Settings.findOneAndUpdate(
    { scope, tenantId: scope === "platform" ? null : req.tenantId, key },
    { $set: { value } },
    { upsert: true, new: true }
  );
}

export async function getSetting(scope, tenantId, key, fallback = null) {
  const row = await Settings.findOne({
    scope,
    tenantId: tenantId || null,
    key,
  });
  return row ? row.value : fallback;
}
