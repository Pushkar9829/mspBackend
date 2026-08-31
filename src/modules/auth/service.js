import bcrypt from "bcryptjs";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { AppError } from "../../utils/AppError.js";
import {
  hashToken,
  randomToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/tokens.js";
import { env } from "../../config/env.js";
import { LOCKOUT_MINUTES, LOCKOUT_THRESHOLD, SYSTEM_ROLES } from "../../config/constants.js";
import { emitDomain } from "../../utils/events.js";

const SALT = 12;

function publicTenant(tenant) {
  if (!tenant) return null;
  if (typeof tenant !== "object" || !tenant.name) {
    return { id: tenant };
  }
  return {
    id: tenant._id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    branding: tenant.branding,
    businessProfile: tenant.businessProfile,
    taxSettings: tenant.taxSettings,
    orderRules: tenant.orderRules,
    notificationPreferences: tenant.notificationPreferences,
  };
}

export function toPublicUser(user, role) {
  const r = role || user.roleId;
  const tenantDoc = user.tenantId && typeof user.tenantId === "object" && user.tenantId.name ? user.tenantId : null;
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    status: user.status,
    tenantId: tenantDoc?._id || user.tenantId || null,
    tenant: publicTenant(tenantDoc || user.tenantId),
    role: r
      ? {
          id: r._id,
          name: r.name,
          slug: r.slug,
          scope: r.scope,
          permissions: r.permissions,
        }
      : null,
    profile: user.profile,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

function refId(value) {
  if (!value) return null;
  if (typeof value === "object") return value._id || value.id || null;
  return value;
}

export async function issueTokens(user, role) {
  const tenantId = refId(user.tenantId);
  const roleId = refId(user.roleId) || role?._id;
  const payload = {
    sub: String(user._id),
    tenantId: tenantId ? String(tenantId) : null,
    role: role?.slug,
  };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken({ sub: String(user._id) });
  user.refreshTokenHash = hashToken(refreshToken);
  user.tenantId = tenantId;
  if (roleId) user.roleId = roleId;
  await user.save();
  return { accessToken, refreshToken };
}

function setRefreshCookie(res, token) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/api/v1/auth",
  });
}

export async function registerBuyer({ name, email, password, phone, company, tenantSlug }) {
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) throw new AppError(409, "Email already registered", "DUPLICATE");

  const buyerRole = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true });
  if (!buyerRole) throw new AppError(500, "Buyer role not seeded", "SERVER_ERROR");

  let tenantId = null;
  if (tenantSlug) {
    const tenant = await Tenant.findOne({ slug: tenantSlug, status: { $in: ["active", "trial"] } });
    if (!tenant) throw new AppError(404, "Tenant not found or inactive", "NOT_FOUND");
    tenantId = tenant._id;
  }

  const user = await User.create({
    name,
    email: email.toLowerCase(),
    phone: phone || "",
    passwordHash: await bcrypt.hash(password, SALT),
    tenantId,
    roleId: buyerRole._id,
    status: "active",
    profile: { company: company || "" },
  });

  emitDomain("ACCOUNT_CREATED", { userId: user._id, tenantId });
  return user;
}

export async function login({ email, password }, res) {
  const user = await User.findOne({ email: email.toLowerCase() })
    .select("+passwordHash +refreshTokenHash")
    .populate("roleId")
    .populate("tenantId");
  if (!user) throw new AppError(401, "Invalid credentials", "UNAUTHORIZED");

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(423, "Account locked. Try again later", "LOCKED");
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    user.failedLoginAttempts += 1;
    if (user.failedLoginAttempts >= LOCKOUT_THRESHOLD) {
      user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      user.status = "locked";
    }
    const tenantId = refId(user.tenantId);
    user.tenantId = tenantId;
    if (user.roleId?._id) user.roleId = user.roleId._id;
    await user.save();
    emitDomain("ACCOUNT_LOGIN_FAILED", { userId: user._id, tenantId });
    if (user.status === "locked") {
      emitDomain("ACCOUNT_LOCKED", { userId: user._id, tenantId });
    }
    throw new AppError(401, "Invalid credentials", "UNAUTHORIZED");
  }

  if (user.status === "suspended") {
    throw new AppError(403, "Account suspended", "FORBIDDEN");
  }
  if (user.status === "pending") {
    throw new AppError(403, "Account pending activation", "FORBIDDEN");
  }

  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  if (user.status === "locked") user.status = "active";
  user.lastLoginAt = new Date();

  const role = user.roleId;
  const publicUser = toPublicUser(user, role);
  const tenantId = refId(user.tenantId);
  const tokens = await issueTokens(user, role);
  setRefreshCookie(res, tokens.refreshToken);
  emitDomain("ACCOUNT_LOGIN", { userId: user._id, tenantId });
  return { user: publicUser, ...tokens };
}

export async function refresh(req, res) {
  const token = req.body.refreshToken || req.cookies?.refreshToken;
  if (!token) throw new AppError(401, "Refresh token required", "UNAUTHORIZED");

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new AppError(401, "Invalid refresh token", "UNAUTHORIZED");
  }

  const user = await User.findById(payload.sub)
    .select("+refreshTokenHash")
    .populate("roleId");
  if (!user || user.refreshTokenHash !== hashToken(token)) {
    throw new AppError(401, "Invalid refresh token", "UNAUTHORIZED");
  }

  const tokens = await issueTokens(user, user.roleId);
  setRefreshCookie(res, tokens.refreshToken);
  return tokens;
}

export async function logout(req, res) {
  if (req.user) {
    await User.findByIdAndUpdate(req.user._id, { refreshTokenHash: "" });
  }
  res.clearCookie("refreshToken", { path: "/api/v1/auth" });
}

export async function forgotPassword(email) {
  const user = await User.findOne({ email: email.toLowerCase() }).select(
    "+passwordResetTokenHash +passwordResetExpires"
  );
  const generic = { message: "If the email exists, a reset link was sent" };
  if (!user) return generic;

  const token = randomToken();
  user.passwordResetTokenHash = hashToken(token);
  user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000);
  await user.save();

  if (!env.isProd) {
    console.log(`Password reset token for ${email}: ${token}`);
    return { ...generic, token };
  }
  return generic;
}

export async function resetPassword(token, password) {
  const user = await User.findOne({
    passwordResetTokenHash: hashToken(token),
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordResetTokenHash +passwordResetExpires +passwordHash");
  if (!user) throw new AppError(400, "Invalid or expired reset token", "INVALID_TOKEN");

  user.passwordHash = await bcrypt.hash(password, SALT);
  user.passwordResetTokenHash = "";
  user.passwordResetExpires = null;
  user.refreshTokenHash = "";
  user.failedLoginAttempts = 0;
  user.lockedUntil = null;
  if (user.status === "locked") user.status = "active";
  await user.save();
}

export async function changePassword(userId, currentPassword, newPassword) {
  const user = await User.findById(userId).select("+passwordHash");
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new AppError(400, "Current password is incorrect", "INVALID_PASSWORD");
  user.passwordHash = await bcrypt.hash(newPassword, SALT);
  user.refreshTokenHash = "";
  await user.save();
}

export { SALT };
