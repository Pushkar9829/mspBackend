import { AppError } from "../utils/AppError.js";

export function authorize(...required) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError(401, "Authentication required", "UNAUTHORIZED"));
    }
    const perms = req.permissions || [];
    if (perms.includes("*")) return next();
    const ok = required.every((p) => perms.includes(p));
    if (!ok) {
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
    const perms = req.permissions || [];
    if (perms.includes("*")) return next();
    if (required.some((p) => perms.includes(p))) return next();
    next(new AppError(403, "Insufficient permissions", "FORBIDDEN"));
  };
}
