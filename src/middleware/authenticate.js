import { AppError } from "../utils/AppError.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";

export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      throw new AppError(401, "Authentication required", "UNAUTHORIZED");
    }

    const payload = verifyAccessToken(token);
    const user = await User.findById(payload.sub).populate("roleId").populate("tenantId");
    if (!user) {
      throw new AppError(401, "User not found", "UNAUTHORIZED");
    }
    if (user.status === "suspended" || user.status === "locked") {
      throw new AppError(403, "Account is not active", "FORBIDDEN");
    }

    const role = user.roleId instanceof Role ? user.roleId : await Role.findById(user.roleId);
    req.user = user;
    req.role = role;
    req.permissions = role?.permissions || [];
    req.isPlatformAdmin = role?.slug === "super_admin" || req.permissions.includes("*");
    next();
  } catch (err) {
    next(err.status ? err : new AppError(401, "Invalid or expired token", "UNAUTHORIZED"));
  }
}

export function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  return authenticate(req, _res, next);
}
