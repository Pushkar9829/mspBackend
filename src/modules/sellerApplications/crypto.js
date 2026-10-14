import crypto from "crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

/**
 * At-rest encryption for seller bank account numbers (AES-256-GCM).
 * Key: KYC_ENCRYPTION_KEY (64 hex chars = raw 32-byte key, anything else is SHA-256'd; at least
 * 32 characters outside development/test). Development/test fall back to a key derived from the
 * JWT access secret, like the other dev secrets in config/env.js.
 * Stored format: "v1:<iv b64url>:<tag b64url>:<ciphertext b64url>".
 */
let cachedKey = null;

function masterKey() {
  if (cachedKey) return cachedKey;
  const raw = String(process.env.KYC_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    if (!env.isDevLike) throw new AppError(500, "KYC_ENCRYPTION_KEY is not configured", "SERVER_ERROR");
    cachedKey = crypto.createHash("sha256").update(`msp:kyc-dev:${env.jwtAccessSecret}`).digest();
    return cachedKey;
  }
  if (!env.isDevLike && raw.length < 32) throw new AppError(500, "KYC_ENCRYPTION_KEY must be at least 32 characters", "SERVER_ERROR");
  cachedKey = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : crypto.createHash("sha256").update(raw).digest();
  return cachedKey;
}

function subKey(purpose) {
  return crypto.createHmac("sha256", masterKey()).update(`msp:kyc:${purpose}`).digest();
}

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", subKey("enc"), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}

/** Plain text, or null when the value cannot be decrypted (wrong key / tampered). */
export function decryptSecret(stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", subKey("enc"), Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Keyed hash for duplicate detection (same account number → same hash, not reversible). */
export function hashSecret(plain) {
  return crypto.createHmac("sha256", subKey("hash")).update(String(plain)).digest("hex");
}
