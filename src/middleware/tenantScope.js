import { AppError } from "../utils/AppError.js";
import { Tenant } from "../modules/tenants/tenant.model.js";

export async function resolveTenant(req, _res, next) {
  try {
    const headerTenant = req.headers["x-tenant-id"];
    if (req.isPlatformAdmin) {
      req.tenantId = headerTenant || req.query.tenantId || null;
      if (req.tenantId) {
        const tenant = await Tenant.findById(req.tenantId);
        if (!tenant) {
          throw new AppError(404, "Tenant not found", "NOT_FOUND");
        }
        req.tenant = tenant;
      }
      return next();
    }

    req.tenantId = req.user?.tenantId || null;
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
