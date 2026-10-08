import { AppError } from "../utils/AppError.js";

/**
 * `req.permissions` is already sanitised by `authenticate` ("*" survives only for the system
 * platform role), so the "*" shortcut below is safe.
 */
function has(req, perm) {
  const perms = req.permissions || [];
  return req.isPlatformAdmin === true || perms.includes("*") || perms.includes(perm);
}

export function authorize(...required) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError(401, "Authentication required", "UNAUTHORIZED"));
    }
    if (!required.every((p) => has(req, p))) {
      return next(new AppError(403, "Insufficient permissions", "FORBIDDEN"));
    }
    next();
  };
}

export function authorizeAny(...required) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError(401, "Authentication required", "UNAUTHORIZED"));
    }
    if (required.some((p) => has(req, p))) return next();
    next(new AppError(403, "Insufficient permissions", "FORBIDDEN"));
  };
}

/** True when the request's actor holds `perm` (helper for services). */
export function hasPermission(req, perm) {
  return has(req, perm);
}
