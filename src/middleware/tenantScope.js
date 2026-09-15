import mongoose from "mongoose";
import { AppError } from "../utils/AppError.js";
import { Tenant } from "../modules/tenants/tenant.model.js";

export function asObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "object" && value._id) return asObjectId(value._id);
  if (mongoose.Types.ObjectId.isValid(String(value))) {
    return new mongoose.Types.ObjectId(String(value));
  }
  return null;
}

export async function resolveTenant(req, _res, next) {
  try {
    const headerTenant = req.headers["x-tenant-id"];
    if (req.isPlatformAdmin) {
      req.tenantId = asObjectId(headerTenant || req.query.tenantId) || headerTenant || req.query.tenantId || null;
      if (req.tenantId) {
        const tenant = await Tenant.findById(req.tenantId);
        if (!tenant) {
          throw new AppError(404, "Tenant not found", "NOT_FOUND");
        }
        req.tenant = tenant;
        req.tenantId = tenant._id;
      }
      return next();
    }

    req.tenantId = asObjectId(req.user?.tenantId);
    if (!req.tenantId) {
      throw new AppError(403, "Tenant context required", "FORBIDDEN");
    }
    if (headerTenant && String(headerTenant) !== String(req.tenantId)) {
      throw new AppError(403, "Cross-tenant access denied", "FORBIDDEN");
    }
    next();
  } catch (err) {
    next(err);
  }
}

export function requireTenant(req, _res, next) {
  if (!req.tenantId) {
    return next(new AppError(400, "Tenant context required (X-Tenant-Id)", "TENANT_REQUIRED"));
  }
  next();
}

export function tenantFilter(req, extra = {}) {
  if (req.isPlatformAdmin && !req.tenantId) {
    return { ...extra };
  }
  return { tenantId: req.tenantId, ...extra };
}
