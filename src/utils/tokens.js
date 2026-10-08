import jwt from "jsonwebtoken";
import crypto from "crypto";
import { env } from "../config/env.js";

const ALG = "HS256";

/** Access token payload: { sub, tenantId, role, tv } — `tv` is User.tokenVersion at issue time. */
export function signAccessToken(payload) {
  return jwt.sign(payload, env.jwtAccessSecret, { expiresIn: env.jwtAccessTtl, algorithm: ALG });
}

/** Refresh token payload: { sub, sid, tv } — `sid` is the RefreshSession id. A random jti makes every token unique. */
export function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwtRefreshSecret, {
    expiresIn: env.jwtRefreshTtl,
    algorithm: ALG,
    jwtid: crypto.randomBytes(12).toString("hex"),
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret, { algorithms: [ALG] });
}

export function verifyRefreshToken(token, { ignoreExpiration = false } = {}) {
  return jwt.verify(token, env.jwtRefreshSecret, { algorithms: [ALG], ignoreExpiration });
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}
