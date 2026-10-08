import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { RefreshSession } from "./refreshSession.model.js";
import { AppError } from "../../utils/AppError.js";
import {
  hashToken,
  randomToken,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../utils/tokens.js";
import { env } from "../../config/env.js";
import {
  LOCKOUT_BASE_SECONDS,
  LOCKOUT_MINUTES,
  LOCKOUT_THRESHOLD,
  SYSTEM_ROLES,
} from "../../config/constants.js";
import { emitDomain } from "../../utils/events.js";
import { getIo } from "../../utils/io.js";
import { logger } from "../../utils/logger.js";
import { sendMail } from "../notifications/mailer.js";
import { links } from "../../utils/links.js";
import { assertUserActive, isBuyerRole } from "../../middleware/authenticate.js";

const SALT = 12;
const REFRESH_GRACE_MS = 30 * 1000;
const FAILED_WINDOW_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;
const OPEN_ORDER_STATUSES = ["pending", "confirmed", "processing", "ready_to_ship", "shipped", "out_for_delivery", "return_requested"];

// Used to keep login timing similar for unknown emails.
let dummyHash;
async function dummyCompare(password) {
  dummyHash ||= await bcrypt.hash("dummy-password-for-timing", SALT);
  await bcrypt.compare(String(password || ""), dummyHash);
}

const devLog = (msg) => {
  if (env.nodeEnv === "development") logger.info(msg);
};

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
    emailVerified: Boolean(user.emailVerified),
    tenantId: tenantDoc?._id || user.tenantId || null,
    tenant: publicTenant(tenantDoc || user.tenantId),
    homeTenantId: user.homeTenantId?._id || user.homeTenantId || null,
    homeTenant:
      user.homeTenantId && typeof user.homeTenantId === "object" && user.homeTenantId.name
        ? { id: user.homeTenantId._id, name: user.homeTenantId.name, slug: user.homeTenantId.slug }
        : null,
    role: r && typeof r === "object"
      ? {
          id: r._id,
          name: r.name,
          slug: r.slug,
          scope: r.scope,
          permissions: r.permissions,
        }
      : null,
    profile: user.profile,
    businessType: user.profile?.businessType || "",
    gstin: user.profile?.gstin || "",
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

function refId(value) {
  if (!value) return null;
  if (typeof value === "object") return value._id || value.id || null;
  return value;
}

export function isMobileClient(req) {
  return String(req?.get?.("x-client") || req?.headers?.["x-client"] || "").toLowerCase() === "mobile";
}

function refreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: env.cookieSameSite,
    secure: env.cookieSecure,
    path: "/api/v1/auth",
  };
}

function setRefreshCookie(res, token) {
  res?.cookie?.("refreshToken", token, { ...refreshCookieOptions(), maxAge: env.jwtRefreshTtlMs });
}

export function clearRefreshCookie(res) {
  res?.clearCookie?.("refreshToken", refreshCookieOptions());
}

function signAccess(user, role) {
  const tenantId = refId(user.tenantId);
  return signAccessToken({
    sub: String(user._id),
    tenantId: tenantId ? String(tenantId) : null,
    role: role?.slug || undefined,
    tv: Number(user.tokenVersion || 0),
  });
}

/** Create a new refresh session (one per login/device) and return both tokens. */
export async function issueTokens(user, role, req = null) {
  const sid = new mongoose.Types.ObjectId();
  const tv = Number(user.tokenVersion || 0);
  const refreshToken = signRefreshToken({ sub: String(user._id), sid: String(sid), tv });
  await RefreshSession.create({
    _id: sid,
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    tokenVersion: tv,
    client: isMobileClient(req) ? "mobile" : "web",
    userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 300),
    ip: req?.ip || "",
    expiresAt: new Date(Date.now() + env.jwtRefreshTtlMs),
  });
  return { accessToken: signAccess(user, role), refreshToken };
}

/** Shape the token response: refresh token goes in the httpOnly cookie; JSON only for X-Client: mobile. */
function tokenResponse(req, res, tokens) {
  setRefreshCookie(res, tokens.refreshToken);
  const out = { accessToken: tokens.accessToken };
  if (isMobileClient(req)) out.refreshToken = tokens.refreshToken;
  return out;
}

export async function revokeAllSessions(userId, reason = "revoked") {
  await RefreshSession.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
}

/** Invalidate every access + refresh token of the user. */
export async function bumpTokenVersion(userId, reason = "revoked") {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  await revokeAllSessions(userId, reason);
  disconnectUserSockets(userId);
}

/** Drop the user's live sockets (they were authorised with a now-revoked token); clients reconnect with a fresh token. */
function disconnectUserSockets(userId) {
  try {
    getIo()?.in(`user:${userId}`).disconnectSockets(true);
  } catch (err) {
    logger.error("socket disconnect failed", { userId: String(userId), err: err.message });
  }
}

// ---------------------------------------------------------------------------------------------
// Registration & email verification
// ---------------------------------------------------------------------------------------------

async function issueEmailVerification(userId, email) {
  const token = randomToken();
  await User.updateOne(
    { _id: userId },
    { $set: { emailVerifyTokenHash: hashToken(token), emailVerifyExpires: new Date(Date.now() + VERIFY_TTL_MS) } }
  );
  const link = links.verifyEmail(token);
  await sendMail({
    to: email,
    subject: "Verify your MS₹ email",
    text: `Confirm your email address within 24 hours: ${link}`,
  }).catch((err) => logger.error("verification email failed", { err: err.message }));
  devLog(`Email verification token for ${email}: ${token}`);
}

const REGISTER_MESSAGE = "If this email can be used, your account is ready. Check your inbox to verify your email.";

/**
 * Buyer self-registration. Buyers are marketplace customers: `tenantId` stays null, `tenantSlug`
 * only sets `homeTenantId` (storefront affinity). The response is identical for new and existing
 * emails (no user enumeration); an existing account owner gets a heads-up email instead.
 */
export async function registerBuyer({ name, email, password, phone, company, tenantSlug, businessType, gstin }) {
  const lowered = email.toLowerCase();
  const generic = { ok: true, email: lowered, message: REGISTER_MESSAGE };

  let homeTenantId = null;
  if (tenantSlug) {
    const tenant = await Tenant.findOne({ slug: tenantSlug, status: { $in: ["active", "trial"] } }).select("_id");
    if (tenant) homeTenantId = tenant._id;
  }

  const existing = await User.findOne({ email: lowered }).select("_id email");
  if (existing) {
    await sendMail({
      to: lowered,
      subject: "Sign-up attempt on MS₹",
      text: "Someone tried to create an MS₹ account with this email. If it was you, sign in or reset your password instead.",
    }).catch((err) => logger.error("duplicate-signup email failed", { err: err.message }));
    return generic;
  }

  const buyerRole = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true });
  if (!buyerRole) throw new AppError(500, "Buyer role not seeded", "SERVER_ERROR");

  let user;
  try {
    user = await User.create({
      name,
      email: lowered,
      phone: phone || "",
      passwordHash: await bcrypt.hash(password, SALT),
      tenantId: null,
      homeTenantId,
      roleId: buyerRole._id,
      status: "active",
      emailVerified: false,
      profile: { company: company || "", businessType: businessType || "", gstin: gstin || "" },
    });
  } catch (err) {
    if (err?.code === 11000) return generic; // concurrent duplicate
    throw err;
  }

  await issueEmailVerification(user._id, user.email);
  emitDomain("ACCOUNT_CREATED", { userId: user._id, tenantId: homeTenantId });
  return generic;
}

export async function verifyEmail(token) {
  const user = await User.findOneAndUpdate(
    { emailVerifyTokenHash: hashToken(token), emailVerifyExpires: { $gt: new Date() } },
    { $set: { emailVerified: true, emailVerifiedAt: new Date(), emailVerifyTokenHash: "", emailVerifyExpires: null } },
    { new: true }
  );
  if (!user) throw new AppError(400, "Invalid or expired verification link", "INVALID_TOKEN");
  emitDomain("ACCOUNT_EMAIL_VERIFIED", { userId: user._id });
  return { ok: true, emailVerified: true };
}

export async function resendVerification({ user, email }) {
  const generic = { ok: true, message: "If the account needs verification, a new link was sent" };
  const target = user || (email ? await User.findOne({ email: String(email).toLowerCase() }) : null);
  if (!target || target.emailVerified || target.status === "deleted") return generic;
  await issueEmailVerification(target._id, target.email);
  return generic;
}

// ---------------------------------------------------------------------------------------------
// Login / refresh / logout
// ---------------------------------------------------------------------------------------------

function lockDelaySeconds(attempts) {
  if (attempts < LOCKOUT_THRESHOLD) return 0;
  return Math.min(LOCKOUT_MINUTES * 60, LOCKOUT_BASE_SECONDS * 2 ** (attempts - LOCKOUT_THRESHOLD));
}

async function recordFailedLogin(user) {
  const now = new Date();
  const stale = !user.lastFailedLoginAt || now - user.lastFailedLoginAt > FAILED_WINDOW_MS;
  const updated = await User.findOneAndUpdate(
    { _id: user._id },
    stale
      ? { $set: { failedLoginAttempts: 1, lastFailedLoginAt: now } }
      : { $inc: { failedLoginAttempts: 1 }, $set: { lastFailedLoginAt: now } },
    { new: true, projection: { failedLoginAttempts: 1 } }
  );
  const attempts = updated?.failedLoginAttempts || 1;
  const delay = lockDelaySeconds(attempts);
  const tenantId = refId(user.tenantId);
  emitDomain("ACCOUNT_LOGIN_FAILED", { userId: user._id, tenantId });
  if (delay > 0) {
    await User.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() + delay * 1000) } });
    if (attempts === LOCKOUT_THRESHOLD) emitDomain("ACCOUNT_LOCKED", { userId: user._id, tenantId });
  }
}

/**
 * Failed-login tracking for emails with no account, so the 429 LOGIN_DELAYED response does not
 * reveal which emails exist. In-memory (per process), keyed by a hash of the email, bounded LRU.
 */
const UNKNOWN_LOGIN_MAX = 10000;
const unknownLoginFailures = new Map(); // sha256(email) -> { attempts, lastFailedAt, lockedUntil }

function unknownLoginEntry(email) {
  const key = hashToken(String(email).toLowerCase());
  const entry = unknownLoginFailures.get(key);
  if (entry && Date.now() - entry.lastFailedAt > FAILED_WINDOW_MS && (!entry.lockedUntil || entry.lockedUntil <= Date.now())) {
    unknownLoginFailures.delete(key);
    return { key, entry: null };
  }
  return { key, entry };
}

function recordUnknownLoginFailure(key, entry) {
  const now = Date.now();
  const attempts = (entry?.attempts || 0) + 1;
  const delay = lockDelaySeconds(attempts);
  unknownLoginFailures.delete(key); // re-insert to refresh LRU order
  unknownLoginFailures.set(key, { attempts, lastFailedAt: now, lockedUntil: delay > 0 ? now + delay * 1000 : null });
  while (unknownLoginFailures.size > UNKNOWN_LOGIN_MAX) {
    unknownLoginFailures.delete(unknownLoginFailures.keys().next().value);
  }
}

function loginDelayed(res, lockedUntilMs) {
  const retryAfter = Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 1000));
  res?.set?.("Retry-After", String(retryAfter));
  return new AppError(429, `Too many failed attempts. Try again in ${retryAfter} seconds`, "LOGIN_DELAYED");
}

/**
 * Login. Too many failures add a temporary, growing per-account delay (`lockedUntil`); the account
 * status is never changed and existing sessions stay alive.
 */
export async function login({ email, password }, req, res) {
  const user = await User.findOne({ email: email.toLowerCase() })
    .select("+passwordHash")
    .populate("roleId")
    .populate("tenantId");
  if (!user) {
    const { key, entry } = unknownLoginEntry(email);
    if (entry?.lockedUntil && entry.lockedUntil > Date.now()) throw loginDelayed(res, entry.lockedUntil);
    await dummyCompare(password);
    recordUnknownLoginFailure(key, entry);
    throw new AppError(401, "Invalid credentials", "UNAUTHORIZED");
  }
  // Audit trail: the login attempt belongs to this account (success or failure).
  if (res?.locals) {
    res.locals.auditActorId = user._id;
    res.locals.auditTenantId = refId(user.tenantId);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw loginDelayed(res, user.lockedUntil.getTime());
  }

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) {
    await recordFailedLogin(user);
    throw new AppError(401, "Invalid credentials", "UNAUTHORIZED");
  }

  // Legacy: old lockout flipped status to "locked"; a correct password restores it.
  if (user.status === "locked") user.status = "active";
  if (user.status === "suspended" || user.status === "deleted") {
    throw new AppError(403, "Account is not active", "ACCOUNT_INACTIVE");
  }
  if (user.status === "pending") {
    throw new AppError(403, "Account pending activation", "ACCOUNT_PENDING");
  }
  const role = user.roleId;
  assertUserActive(user, role);

  const now = new Date();
  await User.updateOne(
    { _id: user._id },
    { $set: { failedLoginAttempts: 0, lockedUntil: null, lastFailedLoginAt: null, lastLoginAt: now, status: user.status } }
  );
  user.lastLoginAt = now;

  const tokens = await issueTokens(user, role, req);
  emitDomain("ACCOUNT_LOGIN", { userId: user._id, tenantId: refId(user.tenantId) });
  return { user: toPublicUser(user, role), ...tokenResponse(req, res, tokens) };
}

function readRefreshToken(req) {
  const fromBody = req.body && typeof req.body.refreshToken === "string" ? req.body.refreshToken : "";
  return fromBody || req.cookies?.refreshToken || "";
}

/**
 * Rotate the refresh token. Detects reuse: presenting an already-rotated token (outside a 30s
 * grace window for concurrent tabs) revokes every session of the user.
 */
export async function refresh(req, res) {
  const token = readRefreshToken(req);
  if (!token) throw new AppError(401, "Refresh token required", "UNAUTHORIZED");

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new AppError(401, "Invalid refresh token", "UNAUTHORIZED");
  }
  if (!payload.sid || !mongoose.Types.ObjectId.isValid(payload.sid)) {
    throw new AppError(401, "Invalid refresh token", "UNAUTHORIZED");
  }

  const session = await RefreshSession.findById(payload.sid);
  if (!session || session.revokedAt || String(session.userId) !== String(payload.sub)) {
    clearRefreshCookie(res);
    throw new AppError(401, "Invalid refresh token", "UNAUTHORIZED");
  }

  const presented = hashToken(token);
  if (presented !== session.tokenHash) {
    const withinGrace =
      presented === session.prevTokenHash && session.rotatedAt && Date.now() - session.rotatedAt.getTime() < REFRESH_GRACE_MS;
    if (withinGrace) {
      throw new AppError(401, "Refresh token already rotated; retry with the latest token", "REFRESH_RACE");
    }
    await bumpTokenVersion(session.userId, "refresh_reuse");
    emitDomain("ACCOUNT_REFRESH_REUSE", { userId: session.userId });
    logger.warn("refresh token reuse detected", { userId: String(session.userId), sid: String(session._id) });
    clearRefreshCookie(res);
    throw new AppError(401, "Session revoked", "TOKEN_REUSE");
  }

  const user = await User.findById(payload.sub).populate("roleId").populate("tenantId");
  try {
    assertUserActive(user, user?.roleId, { tokenVersion: payload.tv ?? 0 });
  } catch (err) {
    await RefreshSession.updateOne({ _id: session._id }, { $set: { revokedAt: new Date(), revokedReason: err.code || "inactive" } });
    clearRefreshCookie(res);
    throw err;
  }

  const next = signRefreshToken({ sub: String(user._id), sid: String(session._id), tv: Number(user.tokenVersion || 0) });
  const rotated = await RefreshSession.findOneAndUpdate(
    { _id: session._id, tokenHash: presented, revokedAt: null },
    {
      $set: {
        tokenHash: hashToken(next),
        prevTokenHash: presented,
        rotatedAt: new Date(),
        expiresAt: new Date(Date.now() + env.jwtRefreshTtlMs),
      },
    },
    { new: true }
  );
  if (!rotated) {
    throw new AppError(401, "Refresh token already rotated; retry with the latest token", "REFRESH_RACE");
  }
  return tokenResponse(req, res, { accessToken: signAccess(user, user.roleId), refreshToken: next });
}

/** Logout this device. Works without a valid access token (uses the refresh cookie/body token). */
export async function logout(req, res) {
  const token = readRefreshToken(req);
  if (token) {
    try {
      const payload = verifyRefreshToken(token, { ignoreExpiration: true });
      if (res?.locals && payload.sub) res.locals.auditActorId = payload.sub;
      if (payload.sid && mongoose.Types.ObjectId.isValid(payload.sid)) {
        await RefreshSession.updateOne(
          { _id: payload.sid, userId: payload.sub, revokedAt: null },
          { $set: { revokedAt: new Date(), revokedReason: "logout" } }
        );
      }
    } catch {
      /* invalid token: nothing to revoke */
    }
  }
  clearRefreshCookie(res);
}

/** Logout everywhere: revokes every refresh session and invalidates all access tokens. */
export async function logoutAll(userId, res) {
  await bumpTokenVersion(userId, "logout_all");
  clearRefreshCookie(res);
  emitDomain("ACCOUNT_LOGOUT_ALL", { userId });
}

// ---------------------------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------------------------

/** Always returns the same generic message. The token is emailed; only logged in development. */
export async function forgotPassword(email) {
  const generic = { message: "If the email exists, a reset link was sent" };
  const user = await User.findOne({ email: email.toLowerCase(), status: { $nin: ["deleted"] } }).select("_id email");
  if (!user) return generic;

  const token = randomToken();
  await User.updateOne(
    { _id: user._id },
    { $set: { passwordResetTokenHash: hashToken(token), passwordResetExpires: new Date(Date.now() + RESET_TTL_MS) } }
  );

  const link = links.resetPassword(token);
  await sendMail({
    to: user.email,
    subject: "Reset your MS₹ password",
    text: `Reset your password within one hour: ${link}`,
  }).catch((err) => logger.error("reset email failed", { err: err.message }));

  devLog(`Password reset token for ${user.email}: ${token}`);
  return generic;
}

export async function resetPassword(token, password) {
  const passwordHash = await bcrypt.hash(password, SALT);
  const user = await User.findOneAndUpdate(
    { passwordResetTokenHash: hashToken(token), passwordResetExpires: { $gt: new Date() } },
    {
      $set: {
        passwordHash,
        passwordResetTokenHash: "",
        passwordResetExpires: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
        // Proving inbox ownership also verifies the email.
        emailVerified: true,
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true }
  );
  if (!user) throw new AppError(400, "Invalid or expired reset token", "INVALID_TOKEN");
  if (user.status === "locked") await User.updateOne({ _id: user._id }, { $set: { status: "active" } });
  await revokeAllSessions(user._id, "password_reset");
  disconnectUserSockets(user._id);
  emitDomain("ACCOUNT_PASSWORD_RESET", { userId: user._id });
}

/** Change password; revokes all other sessions and returns fresh tokens for this one. */
export async function changePassword(req, res, currentPassword, newPassword) {
  const user = await User.findById(req.user._id).select("+passwordHash");
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw new AppError(400, "Current password is incorrect", "INVALID_PASSWORD");
  const passwordHash = await bcrypt.hash(newPassword, SALT);
  const updated = await User.findOneAndUpdate(
    { _id: user._id },
    { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
    { new: true }
  );
  await revokeAllSessions(user._id, "password_change");
  disconnectUserSockets(user._id);
  emitDomain("ACCOUNT_PASSWORD_CHANGED", { userId: user._id });
  updated.tenantId = req.user.tenantId;
  const tokens = await issueTokens(updated, req.role, req);
  return { ok: true, ...tokenResponse(req, res, tokens) };
}

// ---------------------------------------------------------------------------------------------
// Profile, export, deletion
// ---------------------------------------------------------------------------------------------

const PROFILE_FIELDS = ["company", "gstin", "businessType", "addressLine1", "preferredSizes", "location"];

export async function updateMe(userId, body) {
  const set = {};
  if (body.businessType !== undefined) set["profile.businessType"] = body.businessType;
  if (body.gstin !== undefined) set["profile.gstin"] = body.gstin;
  if (body.name !== undefined) set.name = body.name;
  if (body.phone !== undefined) set.phone = body.phone;
  if (body.profile) {
    for (const key of PROFILE_FIELDS) {
      if (body.profile[key] === undefined) continue;
      if (key === "location") {
        for (const [lk, lv] of Object.entries(body.profile.location || {})) set[`profile.location.${lk}`] = lv;
      } else {
        set[`profile.${key}`] = body.profile[key];
      }
    }
  }
  const user = await User.findByIdAndUpdate(userId, { $set: set }, { new: true, runValidators: true });
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  await user.populate("roleId");
  await user.populate("tenantId", "name slug status branding businessProfile taxSettings orderRules notificationPreferences");
  return toPublicUser(user, user.roleId);
}

function model(name) {
  return mongoose.models[name] || null;
}

/** GDPR-style export of the caller's own data. */
export async function exportMe(req) {
  const userId = req.user._id;
  const user = await User.findById(userId).populate("roleId").populate("tenantId", "name slug");
  const Address = model("Address");
  const Order = model("Order");
  const Wishlist = model("WishlistItem");
  const [addresses, orders, wishlist] = await Promise.all([
    Address ? Address.find({ userId }).lean() : [],
    Order
      ? Order.find({ buyerId: userId })
          .select("orderNumber tenantId status paymentStatus paymentMethod grandTotal createdAt items.name items.sku items.qty items.quantity")
          .populate("tenantId", "name slug")
          .sort({ createdAt: -1 })
          .limit(1000)
          .lean()
      : [],
    Wishlist ? Wishlist.find({ userId }).lean() : [],
  ]);
  return {
    exportedAt: new Date().toISOString(),
    profile: toPublicUser(user, user.roleId),
    addresses,
    orders,
    wishlist,
  };
}

/**
 * Self-deletion (buyers only). Personal data is anonymised; orders/invoices are retained for tax
 * law but no longer link to identifiable profile data on the user record.
 */
export async function deleteMe(req, res, password) {
  if (!isBuyerRole(req.role)) {
    throw new AppError(403, "Staff accounts must be removed by an administrator", "FORBIDDEN");
  }
  const user = await User.findById(req.user._id).select("+passwordHash");
  if (!user) throw new AppError(404, "User not found", "NOT_FOUND");
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw new AppError(400, "Password is incorrect", "INVALID_PASSWORD");

  const Order = model("Order");
  if (Order && (await Order.exists({ buyerId: user._id, status: { $in: OPEN_ORDER_STATUSES } }))) {
    throw new AppError(409, "You have open orders. Complete or cancel them before deleting your account", "OPEN_ORDERS");
  }

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        name: "Deleted user",
        email: `deleted+${user._id}@deleted.invalid`,
        phone: "",
        passwordHash: await bcrypt.hash(randomToken(), SALT),
        status: "deleted",
        deletedAt: new Date(),
        emailVerified: false,
        homeTenantId: null,
        profile: {},
        passwordResetTokenHash: "",
        emailVerifyTokenHash: "",
      },
      $inc: { tokenVersion: 1 },
    }
  );
  await revokeAllSessions(user._id, "account_deleted");
  disconnectUserSockets(user._id);
  await Promise.all(
    ["Address", "WishlistItem", "SearchHistory"].map((name) =>
      model(name)?.deleteMany({ userId: user._id }).catch((err) => logger.error("account deletion cleanup failed", { name, err: err.message }))
    )
  );
  clearRefreshCookie(res);
  emitDomain("ACCOUNT_DELETED", { userId: user._id });
  return { ok: true };
}

export { SALT };
