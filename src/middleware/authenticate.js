import { AppError } from "../utils/AppError.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { env } from "../config/env.js";
import { SYSTEM_ROLES, isPlatformOnlyPermission } from "../config/constants.js";

const INACTIVE_TENANT = new Set(["suspended", "archived"]);

/**
 * Staff of a PAUSED store keep working on these API areas (path under /api/v1; `methods` limits
 * the verbs). Everything else -> 403 STORE_PAUSED.
 */
export const PAUSED_STAFF_ALLOWLIST = [
  { prefix: "/auth" },
  { prefix: "/orders" }, // orders, returns, refunds, invoices, credit notes
  { prefix: "/shipping" }, // fulfilling orders already placed
  { prefix: "/chat" },
  { prefix: "/notifications" },
  { prefix: "/files" },
  { prefix: "/billing" }, // placeholder (subscription billing)
  { prefix: "/tenants/me", methods: ["GET"] },
  { prefix: "/settings", methods: ["GET"] },
  // Phase 5: own-fleet deliveries of orders already placed (board, rider app, rider list).
  { prefix: "/fleet" },
  { prefix: "/rider" },
  { prefix: "/riders", methods: ["GET"] },
  // Disputes about placed orders: read them and reply with evidence (like returns), nothing else.
  { prefix: "/disputes", methods: ["GET"] },
  { pattern: /^\/disputes\/[^/]+\/messages$/, methods: ["POST"] },
  // Confirming COD cash a rider hands over (money already collected for placed orders).
  { pattern: /^\/riders\/[^/]+\/cash\/deposits$/, methods: ["POST"] },
  // Read-only view of the store's own seller application (notification links point there).
  { pattern: /^\/seller-applications\/me$/, methods: ["GET"] },
  { pattern: /^\/seller-applications\/me\/documents\/[^/]+\/link$/, methods: ["GET"] },
];

/** Staff of a PENDING store (not approved yet): onboarding only. Everything else -> 403 STORE_PENDING. */
export const PENDING_STAFF_ALLOWLIST = [
  { prefix: "/auth" },
  { prefix: "/files" },
  { prefix: "/seller-applications" },
  { prefix: "/terms" },
  { prefix: "/notifications", methods: ["GET"] },
  { prefix: "/tenants/me", methods: ["GET"] },
];

function apiPath(req) {
  const raw = String(req.originalUrl || req.url || "").split("?")[0];
  return raw.replace(/^\/api\/v1(?=\/|$)/, "") || "/";
}

function allowedBy(list, req) {
  const path = apiPath(req);
  const method = String(req.method || "GET").toUpperCase();
  return list.some(
    (rule) =>
      (rule.pattern ? rule.pattern.test(path) : path === rule.prefix || path.startsWith(`${rule.prefix}/`)) &&
      (!rule.methods || rule.methods.includes(method) || (method === "HEAD" && rule.methods.includes("GET")))
  );
}

/**
 * HTTP-only gate for staff of a paused / pending store (sockets and refresh are not affected).
 * Throws 403 STORE_PAUSED / STORE_PENDING (with `status` + `reason`) outside the allowlists.
 */
export function assertStoreStateAllows(req, user, role) {
  const tenant = user?.tenantId && typeof user.tenantId === "object" && user.tenantId.status ? user.tenantId : null;
  if (!tenant || isPlatformRole(role)) return;
  if (tenant.status === "paused" && !allowedBy(PAUSED_STAFF_ALLOWLIST, req)) {
    throw new AppError(403, "Your store is paused. Only orders, returns, support and notifications are available.", "STORE_PAUSED", {
      status: "paused",
      reason: tenant.statusReason || "",
    });
  }
  if (tenant.status === "pending" && !allowedBy(PENDING_STAFF_ALLOWLIST, req)) {
    throw new AppError(403, "Your store is not approved yet. Only onboarding is available.", "STORE_PENDING", {
      status: "pending",
      reason: tenant.statusReason || "",
    });
  }
}
const INACTIVE_USER = new Set(["suspended", "locked", "deleted", "pending"]);

/** Platform admin = the system role with platform scope. Never derived from permission strings. */
export function isPlatformRole(role) {
  return Boolean(role && role.isSystem === true && role.scope === "platform");
}

/** System buyer role (marketplace customers). */
export function isBuyerRole(role) {
  return Boolean(role && role.isSystem === true && role.slug === SYSTEM_ROLES.BUYER);
}

/** Effective permissions: non-platform roles never get "*" or tenants.* even if stored on the role. */
export function effectivePermissions(role) {
  const perms = Array.isArray(role?.permissions) ? role.permissions : [];
  if (isPlatformRole(role)) return [...perms];
  return perms.filter((p) => !isPlatformOnlyPermission(p));
}

/**
 * Validate that a user (already loaded with roleId + tenantId populated) may act right now.
 * Throws AppError. Shared by HTTP auth, refresh and socket auth.
 */
export function assertUserActive(user, role, { tokenVersion } = {}) {
  if (!user) throw new AppError(401, "Invalid or expired token", "UNAUTHORIZED");
  if (INACTIVE_USER.has(user.status)) {
    throw new AppError(403, "Account is not active", "ACCOUNT_INACTIVE");
  }
  if (tokenVersion !== undefined && Number(tokenVersion || 0) !== Number(user.tokenVersion || 0)) {
    throw new AppError(401, "Session has been revoked", "TOKEN_REVOKED");
  }
  const tenant = user.tenantId && typeof user.tenantId === "object" && user.tenantId.status ? user.tenantId : null;
  if (tenant && !isPlatformRole(role) && INACTIVE_TENANT.has(tenant.status)) {
    throw new AppError(403, "This store account is suspended", "TENANT_SUSPENDED");
  }
}

/**
 * Verify an access token and load the auth context. Used by `authenticate` and by socket auth.
 * Returns { user, role, permissions, isPlatformAdmin, isBuyer, payload }. Throws AppError(401/403).
 */
export async function loadAuthUser(token) {
  if (!token) throw new AppError(401, "Authentication required", "UNAUTHORIZED");
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new AppError(401, "Invalid or expired token", "UNAUTHORIZED");
  }
  const user = await User.findById(payload.sub).populate("roleId").populate("tenantId");
  if (!user) throw new AppError(401, "Invalid or expired token", "UNAUTHORIZED");
  const role = user.roleId instanceof Role ? user.roleId : await Role.findById(user.roleId);
  assertUserActive(user, role, { tokenVersion: payload.tv ?? 0 });
  return {
    user,
    role,
    permissions: effectivePermissions(role),
    isPlatformAdmin: isPlatformRole(role),
    isBuyer: isBuyerRole(role),
    payload,
  };
}

function bearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

function applyContext(req, ctx) {
  req.user = ctx.user;
  req.role = ctx.role;
  req.permissions = ctx.permissions;
  req.isPlatformAdmin = ctx.isPlatformAdmin;
  req.isBuyer = ctx.isBuyer;
  req.homeTenantId = ctx.user.homeTenantId || null;
}

async function authenticateWith(req, next, { gate }) {
  try {
    const ctx = await loadAuthUser(bearer(req));
    if (gate) assertStoreStateAllows(req, ctx.user, ctx.role);
    applyContext(req, ctx);
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(401, "Invalid or expired token", "UNAUTHORIZED"));
  }
}

/** Bearer auth + paused/pending store gate (PAUSED_STAFF_ALLOWLIST / PENDING_STAFF_ALLOWLIST). */
export async function authenticate(req, _res, next) {
  return authenticateWith(req, next, { gate: true });
}

/**
 * Attach the user when a valid token is present; continue anonymously when there is none. Used by
 * public (read) endpoints, so the paused/pending store gate does not apply.
 */
export async function optionalAuth(req, _res, next) {
  if (!bearer(req)) return next();
  return authenticateWith(req, next, { gate: false });
}

/**
 * Gate for actions that need a verified email (checkout). Active only when
 * REQUIRE_EMAIL_VERIFICATION is on (default on in production). Must run after `authenticate`.
 */
export function requireVerifiedEmail(req, _res, next) {
  if (!env.requireEmailVerification || req.isPlatformAdmin) return next();
  if (req.user && !req.user.emailVerified) {
    return next(new AppError(403, "Please verify your email address first", "EMAIL_NOT_VERIFIED"));
  }
  next();
}
