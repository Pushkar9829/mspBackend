import crypto from "crypto";
import { OtpChallenge, Rider } from "./models.js";
import { User } from "../users/user.model.js";
import { AppError } from "../../utils/AppError.js";
import { env } from "../../config/env.js";
import { SYSTEM_ROLES } from "../../config/constants.js";
import { logger } from "../../utils/logger.js";
import { emitDomain } from "../../utils/events.js";
import { issueLoginResponse, toPublicUser } from "../auth/service.js";
import { assertUserActive } from "../../middleware/authenticate.js";
import { normalizeRiderPhone, sendFleetSms } from "./util.js";

/**
 * Rider login with mobile + OTP (phase 5).
 *  POST /auth/otp/request {phone}       -> always 200 { ok, message, cooldownSeconds, expiresInSeconds, devCode? }
 *  POST /auth/otp/verify  {phone, code} -> same token response as POST /auth/login
 * A challenge is created for every well-formed number (so responses never reveal which numbers
 * are riders); the SMS is sent only to active riders. 6 digits, HMAC-hashed, 5 min expiry,
 * 5 wrong tries, 30 s resend cooldown. `devCode` is returned outside production only.
 */

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_COOLDOWN_MS = 30 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
const PURPOSE = "rider_login";

function codeHash(phone, code) {
  return crypto.createHmac("sha256", `msp:otp:${env.jwtAccessSecret}`).update(`${PURPOSE}:${phone}:${code}`).digest("hex");
}

export function randomCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ""), "hex");
  const y = Buffer.from(String(b || ""), "hex");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cooldownError(res, until) {
  const retryAfter = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  res?.set?.("Retry-After", String(retryAfter));
  return new AppError(429, `Please wait ${retryAfter} seconds before asking for a new code`, "OTP_COOLDOWN", { retryAfter });
}

async function activeRiderUser(phone) {
  const rider = await Rider.findOne({ phone }).lean();
  if (!rider) return { rider: null, user: null };
  const user = await User.findById(rider.userId).populate("roleId").populate("tenantId");
  return { rider, user };
}

export async function requestLoginOtp({ phone: raw }, req, res) {
  const phone = normalizeRiderPhone(raw);
  if (!phone) throw new AppError(400, "Enter a valid 10-digit Indian mobile number", "VALIDATION_ERROR", { fields: { phone: "Invalid mobile number" } });
  const last = await OtpChallenge.findOne({ phone, purpose: PURPOSE }).sort({ createdAt: -1 }).lean();
  if (last && Date.now() - new Date(last.sentAt).getTime() < OTP_COOLDOWN_MS) {
    throw cooldownError(res, new Date(last.sentAt).getTime() + OTP_COOLDOWN_MS);
  }
  const code = randomCode();
  const now = new Date();
  // A new code replaces older unused ones.
  await OtpChallenge.updateMany({ phone, purpose: PURPOSE, consumedAt: null }, { $set: { consumedAt: now } });
  await OtpChallenge.create({
    phone,
    purpose: PURPOSE,
    codeHash: codeHash(phone, code),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    sentAt: now,
    ip: req?.ip || "",
  });
  const { rider, user } = await activeRiderUser(phone);
  const tenant = user?.tenantId && typeof user.tenantId === "object" ? user.tenantId : null;
  const sendable = rider?.status === "active" && user?.status === "active" && tenant && !["suspended", "archived"].includes(tenant.status);
  if (sendable) {
    await sendFleetSms({
      phone,
      kind: "LOGIN_OTP",
      vars: { otp: code, name: rider.name, message: `Login code ${code}` },
      message: `Your MS₹ rider login code is ${code}. It expires in 5 minutes.`,
    }).catch((err) => logger.error("rider OTP sms failed", { err: err.message }));
  }
  const out = {
    ok: true,
    message: "If this number belongs to a delivery partner, a login code was sent by SMS.",
    cooldownSeconds: OTP_COOLDOWN_MS / 1000,
    expiresInSeconds: OTP_TTL_MS / 1000,
  };
  if (!env.isProd) out.devCode = code;
  return out;
}

export async function verifyLoginOtp({ phone: raw, code }, req, res) {
  const phone = normalizeRiderPhone(raw);
  if (!phone) throw new AppError(400, "Enter a valid 10-digit Indian mobile number", "VALIDATION_ERROR", { fields: { phone: "Invalid mobile number" } });
  const challenge = await OtpChallenge.findOne({ phone, purpose: PURPOSE, consumedAt: null }).sort({ createdAt: -1 });
  if (!challenge || challenge.expiresAt <= new Date()) {
    throw new AppError(400, "The code has expired. Ask for a new one.", "OTP_EXPIRED");
  }
  if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
    throw new AppError(429, "Too many wrong codes. Ask for a new one.", "OTP_LOCKED");
  }
  const { rider, user } = await activeRiderUser(phone);
  const match = safeEqualHex(codeHash(phone, String(code || "").trim()), challenge.codeHash);
  if (!match || !rider || !user) {
    const updated = await OtpChallenge.findOneAndUpdate({ _id: challenge._id }, { $inc: { attempts: 1 } }, { new: true });
    const attemptsLeft = Math.max(0, OTP_MAX_ATTEMPTS - (updated?.attempts || OTP_MAX_ATTEMPTS));
    throw new AppError(400, attemptsLeft ? `Wrong code. ${attemptsLeft} tries left.` : "Wrong code. Ask for a new one.", "OTP_INVALID", { attemptsLeft });
  }
  // Single use (a concurrent verify of the same code gets OTP_EXPIRED).
  const claimed = await OtpChallenge.findOneAndUpdate({ _id: challenge._id, consumedAt: null }, { $set: { consumedAt: new Date() } });
  if (!claimed) throw new AppError(400, "The code has expired. Ask for a new one.", "OTP_EXPIRED");

  const role = user.roleId;
  if (!role || role.slug !== SYSTEM_ROLES.RIDER || !role.isSystem) {
    throw new AppError(403, "This number is not a delivery partner account", "FORBIDDEN");
  }
  if (rider.status !== "active") throw new AppError(403, "Your rider account is inactive. Contact the store.", "RIDER_INACTIVE");
  const tenant = user.tenantId && typeof user.tenantId === "object" ? user.tenantId : null;
  if (!tenant || ["suspended", "archived", "pending"].includes(tenant.status)) {
    throw new AppError(403, "This store is not active", "TENANT_SUSPENDED");
  }
  assertUserActive(user, role);
  if (res?.locals) {
    res.locals.auditActorId = user._id;
    res.locals.auditTenantId = tenant._id;
  }
  const now = new Date();
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: now, failedLoginAttempts: 0, lockedUntil: null } });
  user.lastLoginAt = now;
  const tokens = await issueLoginResponse(user, role, req, res);
  emitDomain("ACCOUNT_LOGIN", { userId: user._id, tenantId: tenant._id, method: "otp" });
  return { user: toPublicUser(user, role), ...tokens };
}
