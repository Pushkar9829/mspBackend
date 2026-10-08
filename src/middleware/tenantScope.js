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

/**
 * Sets the tenant context for the request.
 *
 * - Platform admin: `req.tenantId` from `X-Tenant-Id` header / `?tenantId=` (or null = all tenants).
 * - Tenant staff: `req.tenantId` = their own tenant; a different `X-Tenant-Id` is rejected.
 * - Marketplace buyer (system `buyer` role, `tenantId: null`): passes through as buyer context —
 *   `req.tenantId = null`, `req.isBuyer = true`, `req.homeTenantId` = storefront affinity (may be null).
 *   Buyer-facing handlers must scope by `req.user._id` (buyerId), never by tenant. Staff-only routers
 *   should add `requireTenant` (or `requireStaff`) after this middleware.
 * - Any other user without a tenant: 403.
 */
export async function resolveTenant(req, _res, next) {
  try {
    const headerTenant = req.headers["x-tenant-id"];
    if (req.isPlatformAdmin) {
      const raw = headerTenant || req.query?.tenantId || null;
      req.tenantId = null;
      if (raw) {
        const id = asObjectId(raw);
        if (!id) throw new AppError(400, "Invalid tenant id", "INVALID_ID");
        const tenant = await Tenant.findById(id);
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
      if (req.isBuyer) {
        req.tenantId = null;
        req.homeTenantId = asObjectId(req.user?.homeTenantId);
        return next();
      }
      throw new AppError(403, "Tenant context required", "FORBIDDEN");
    }
    if (headerTenant && String(headerTenant) !== String(req.tenantId)) {
      throw new AppError(403, "Cross-tenant access denied", "FORBIDDEN");
    }
    if (req.user?.tenantId && typeof req.user.tenantId === "object" && req.user.tenantId.status) {
      req.tenant = req.user.tenantId;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Rejects buyers / users without tenant staff membership (platform admins pass). */
export function requireStaff(req, _res, next) {
  if (req.isPlatformAdmin) return next();
  if (req.isBuyer || !asObjectId(req.user?.tenantId)) {
    return next(new AppError(403, "Staff access required", "FORBIDDEN"));
  }
  next();
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
