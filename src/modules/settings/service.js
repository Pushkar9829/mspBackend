import { Settings } from "./settings.model.js";
import { AppError } from "../../utils/AppError.js";

export async function listSettings(req) {
  const filter = req.isPlatformAdmin && !req.tenantId
    ? { $or: [{ scope: "platform" }, { scope: "tenant" }] }
    : { scope: "tenant", tenantId: req.tenantId };
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
