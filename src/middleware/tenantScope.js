import mongoose from "mongoose";
import { AppError } from "../utils/AppError.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { AdminAccessLog } from "../modules/tenants/adminAccessLog.model.js";
import { emitDomain } from "../utils/events.js";
import { logger } from "../utils/logger.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Minimum length of the X-Admin-Reason header on cross-tenant writes. */
export const ADMIN_REASON_MIN = 5;
/** Identical cross-tenant reads (admin + store + method + path) are logged once per window. */
const READ_DEDUPE_MS = 60 * 1000;
/** Store admins get at most one "platform admin changed your store" notice per admin per window. */
export const ADMIN_WRITE_NOTIFY_WINDOW_MS = 30 * 60 * 1000;
const recentReads = new Map();

function readSeenRecently(key, now) {
  const last = recentReads.get(key);
  if (last && now - last < READ_DEDUPE_MS) return true;
  recentReads.set(key, now);
  if (recentReads.size > 5000) {
    for (const [k, at] of recentReads) if (now - at >= READ_DEDUPE_MS) recentReads.delete(k);
  }
  return false;
}

/** Test hook. */
export function __resetAdminAccessDedupe() {
  recentReads.clear();
}

/**
 * Record a platform admin's request inside a store (after the response is sent) and, for
 * successful writes, notify the store's admins (debounced per admin per store). Never throws.
 */
function trackAdminAccess(req, res, tenantId, { write, reason }) {
  const path = String(req.originalUrl || "").split("?")[0].slice(0, 300);
  const method = String(req.method || "GET").toUpperCase();
  if (!write && readSeenRecently(`${req.user?._id}|${tenantId}|${method}|${path}`, Date.now())) return;
  res.on("finish", () => {
    (async () => {
      const failedWrite = write && res.statusCode >= 400;
      const row = await AdminAccessLog.create({
        tenantId,
        adminId: req.user._id,
        adminName: req.user.name || "",
        adminEmail: req.user.email || "",
        kind: write ? "write" : "read",
        method,
        path,
        reason,
        statusCode: res.statusCode,
        ip: req.ip || "",
        userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
        requestId: req.requestId || "",
      });
      if (!write || failedWrite) return;
      const since = new Date(Date.now() - ADMIN_WRITE_NOTIFY_WINDOW_MS);
      const recent = await AdminAccessLog.exists({ tenantId, adminId: req.user._id, notifiedAt: { $gte: since } });
      if (recent) return;
      await AdminAccessLog.updateOne({ _id: row._id }, { $set: { notifiedAt: new Date() } });
      emitDomain("TENANT_ADMIN_ACCESS", {
        tenantId,
        resource: "tenant",
        resourceId: tenantId,
        adminId: req.user._id,
        adminName: req.user.name || "",
        reason,
        method,
        path,
      });
    })().catch((err) => logger.error("admin access log failed", { err: err.message, requestId: req.requestId }));
  });
}

/**
 * X-Admin-Reason value: HTTP headers are Latin-1 only, so clients percent-encode non-Latin-1
 * reasons (encodeURIComponent). Decode when possible; a raw value that is not valid
 * percent-encoding (e.g. "100% sure") is kept as-is.
 */
export function decodeAdminReason(raw) {
  let value = String(Array.isArray(raw) ? raw[0] ?? "" : raw ?? "");
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      /* not percent-encoded: keep raw */
    }
  }
  return value.trim().slice(0, 500);
}

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
 *   Acting inside a store: writes (POST/PUT/PATCH/DELETE) need `X-Admin-Reason` (>= 5 chars,
 *   else 400 REASON_REQUIRED); reads and writes are logged to AdminAccessLog (seller-visible via
 *   GET /tenants/me/access-log) and store admins are notified of writes (TENANT_ADMIN_ACCESS).
 * - Tenant staff: `req.tenantId` = their own tenant; a different `X-Tenant-Id` is rejected.
 * - Marketplace buyer (system `buyer` role, `tenantId: null`): passes through as buyer context —
 *   `req.tenantId = null`, `req.isBuyer = true`, `req.homeTenantId` = storefront affinity (may be null).
 *   Buyer-facing handlers must scope by `req.user._id` (buyerId), never by tenant. Staff-only routers
 *   should add `requireTenant` (or `requireStaff`) after this middleware.
 * - Any other user without a tenant: 403.
 */
export async function resolveTenant(req, res, next) {
  try {
    const headerTenant = req.headers["x-tenant-id"];
    if (req.isPlatformAdmin) {
      const raw = headerTenant || req.query?.tenantId || null;
      req.tenantId = null;
      if (raw) {
        const id = asObjectId(raw);
        if (!id) throw new AppError(400, "Invalid tenant id", "INVALID_ID");
        const write = MUTATING.has(String(req.method || "GET").toUpperCase());
        const reason = decodeAdminReason(req.headers["x-admin-reason"]);
        if (write && reason.length < ADMIN_REASON_MIN) {
          throw new AppError(400, "Changes inside a store need a reason (X-Admin-Reason header, at least 5 characters)", "REASON_REQUIRED", {
            fields: { "X-Admin-Reason": `Required (at least ${ADMIN_REASON_MIN} characters)` },
          });
        }
        const tenant = await Tenant.findById(id);
        if (!tenant) {
          throw new AppError(404, "Tenant not found", "NOT_FOUND");
        }
        req.tenant = tenant;
        req.tenantId = tenant._id;
        req.adminReason = reason;
        if (res && typeof res.on === "function") trackAdminAccess(req, res, tenant._id, { write, reason });
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
  // Delivery riders (phase 5) belong to a store but are not staff.
  const rider = req.role?.isSystem === true && req.role?.slug === "rider";
  if (req.isBuyer || rider || !asObjectId(req.user?.tenantId)) {
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
