import { AppError } from "../utils/AppError.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { env } from "../config/env.js";
import { SYSTEM_ROLES, isPlatformOnlyPermission } from "../config/constants.js";

const INACTIVE_TENANT = new Set(["suspended", "archived"]);
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

export async function authenticate(req, _res, next) {
  try {
    applyContext(req, await loadAuthUser(bearer(req)));
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(401, "Invalid or expired token", "UNAUTHORIZED"));
  }
}

/** Attach the user when a valid token is present; continue anonymously when there is none. */
export async function optionalAuth(req, res, next) {
  if (!bearer(req)) return next();
  return authenticate(req, res, next);
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
