import "dotenv/config";

/**
 * Environment configuration.
 *
 * Safety model:
 * - NODE_ENV defaults to "production" when unset. Only an explicit NODE_ENV=development or
 *   NODE_ENV=test unlocks the developer fallbacks (dev JWT secrets, default admin password).
 * - Outside development/test, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, NOTIFICATION_UNSUBSCRIBE_SECRET
 *   and SUPER_ADMIN_PASSWORD are
 *   required and the well-known example values are rejected at startup.
 */

function required(name, fallback) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : raw;
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).toLowerCase());
}

function list(name, fallback = "") {
  return String(process.env[name] ?? fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Parse "15m", "8h", "7d", "30s", "500ms" or a bare number of seconds into milliseconds. */
export function durationToMs(value, fallbackMs) {
  if (value === undefined || value === null || value === "") return fallbackMs;
  if (typeof value === "number") return value * 1000;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] || "s").toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, y: 31557600000 }[unit];
  return Math.round(n * mult);
}

const nodeEnv = process.env.NODE_ENV || "production";
const isProd = nodeEnv === "production";
const isTest = nodeEnv === "test";
/** True only when NODE_ENV is explicitly development or test. */
const isDevLike = nodeEnv === "development" || nodeEnv === "test";
const isVercel = bool("VERCEL", false);
const isRender = bool("RENDER", false);

const KNOWN_DEFAULT_SECRETS = new Set([
  "dev-access-secret-change-me",
  "dev-refresh-secret-change-me",
  "change-me",
  "changeme",
  "secret",
]);
const KNOWN_DEFAULT_PASSWORDS = new Set(["ChangeMe123!", "changeme", "password", "admin123", "Admin123!"]);

function secret(name, devFallback) {
  if (isDevLike) return required(name, devFallback);
  const value = required(name);
  if (KNOWN_DEFAULT_SECRETS.has(value)) {
    throw new Error(`${name} uses a known example value; set a strong random secret`);
  }
  if (value.length < 32) {
    throw new Error(`${name} must be at least 32 characters`);
  }
  return value;
}

function adminPassword() {
  if (isDevLike) return process.env.SUPER_ADMIN_PASSWORD || "ChangeMe123!";
  const value = required("SUPER_ADMIN_PASSWORD");
  if (KNOWN_DEFAULT_PASSWORDS.has(value) || value.length < 12) {
    throw new Error("SUPER_ADMIN_PASSWORD must be a non-default password of at least 12 characters");
  }
  return value;
}

const jwtAccessSecret = secret("JWT_ACCESS_SECRET", "dev-access-secret-change-me");
const jwtRefreshSecret = secret("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me");
if (!isDevLike && jwtAccessSecret === jwtRefreshSecret) {
  throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ");
}
// Signs email unsubscribe links. Required outside development/test (dev falls back to the access secret).
const notificationUnsubscribeSecret = secret("NOTIFICATION_UNSUBSCRIBE_SECRET", jwtAccessSecret);
if (!isDevLike && notificationUnsubscribeSecret === jwtAccessSecret) {
  throw new Error("NOTIFICATION_UNSUBSCRIBE_SECRET must differ from JWT_ACCESS_SECRET");
}

// Exact origins only. Wildcards ("*" or "https://*.vercel.app") are ignored: the API sends
// credentials (refresh cookie), so a wildcard would let any matching site act as the user.
const DEFAULT_CORS_ORIGINS = ["https://msp-react.vercel.app", ...(isDevLike ? ["http://localhost:5173"] : [])];
const rawOrigins = [...DEFAULT_CORS_ORIGINS, ...list("CORS_ORIGIN"), ...list("FRONTEND_URL")];
const ignoredOrigins = rawOrigins.filter((o) => o.includes("*"));
if (ignoredOrigins.length) {
  console.warn(`[env] Ignoring wildcard CORS origins (exact origins only): ${ignoredOrigins.join(", ")}`);
}
const corsOrigins = [...new Set(rawOrigins.filter((o) => !o.includes("*")).map((o) => o.replace(/\/$/, "")))];

const cookieSameSite = String(process.env.COOKIE_SAMESITE || (isDevLike ? "lax" : "none")).toLowerCase();

/** MSG91_TEMPLATE_<EVENT>=<DLT template id> → { EVENT: id } */
function msg91Templates() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    const m = key.match(/^MSG91_TEMPLATE_(.+)$/);
    if (m && value) out[m[1]] = value;
  }
  return out;
}

const jwtRefreshTtl = process.env.JWT_REFRESH_TTL || "7d";

export const env = {
  nodeEnv,
  isProd,
  isTest,
  isDevLike,
  isVercel,
  isRender,
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT) || 5000,
  mongoUri: required("MONGODB_URI"),
  notificationUnsubscribeSecret,
  corsOrigins,
  jwtAccessSecret,
  jwtRefreshSecret,
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || "8h",
  jwtRefreshTtl,
  jwtRefreshTtlMs: durationToMs(jwtRefreshTtl, 7 * 86400000),
  superAdminEmail: process.env.SUPER_ADMIN_EMAIL || "admin@msp.local",
  superAdminPassword: adminPassword(),
  // Vercel's filesystem is read-only except /tmp, and /tmp is per-instance and ephemeral.
  // Persistent uploads in serverless need object storage (S3/R2/Cloudinary) — not implemented here.
  uploadDir: process.env.UPLOAD_DIR || (isVercel ? "/tmp/uploads" : "uploads"),
  mapsProvider: process.env.MAPS_PROVIDER || "stub",
  mapsApiKey: process.env.MAPS_API_KEY || "",
  cookieSameSite,
  cookieSecure: bool("COOKIE_SECURE", !isDevLike || cookieSameSite === "none"),
  seedOnStart: bool("SEED_ON_START", false),
  seedDemo: bool("SEED_DEMO", false),
  /** Run Model.syncIndexes() for every model at startup. Default on outside production. */
  syncIndexes: bool("SYNC_INDEXES", !isProd),
  /** Checkout requires a verified email. Default on in production. */
  requireEmailVerification: bool("REQUIRE_EMAIL_VERIFICATION", isProd),
  /** Allow running without Mongo transactions (standalone mongod). Never in production. */
  allowNoTransactions: bool("ALLOW_NO_TRANSACTIONS", false),
  /** Shared secret for /api/internal/cron/:name (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). */
  cronSecret: process.env.CRON_SECRET || "",
  /** Disable in-process node-cron (e.g. when Vercel Cron / an external scheduler drives /api/internal/cron). */
  disableInProcessJobs: bool("DISABLE_IN_PROCESS_JOBS", isVercel),
  logLevel: process.env.LOG_LEVEL || (isTest ? "warn" : "info"),
  razorpayKeyId: process.env.RAZORPAY_KEY_ID || "",
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || "",
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
  apiUrl: process.env.API_URL || "",
  publicApiUrl: process.env.PUBLIC_API_URL || process.env.API_URL || "",
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: process.env.SMTP_PASS || "",
  smtpFrom: process.env.SMTP_FROM || "MS₹ <noreply@msr.local>",
  msg91AuthKey: process.env.MSG91_AUTH_KEY || "",
  msg91SenderId: process.env.MSG91_SENDER_ID || "",
  /** DLT principal entity id (required by Indian carriers for transactional SMS). */
  msg91DltEntityId: process.env.MSG91_DLT_ENTITY_ID || "",
  /** Default DLT template id, used when no per-event template is configured. */
  msg91TemplateId: process.env.MSG91_TEMPLATE_ID || "",
  /** Per-event DLT template ids from MSG91_TEMPLATE_<EVENT> (e.g. MSG91_TEMPLATE_ORDER_CREATED). */
  msg91Templates: msg91Templates(),
  delhiveryToken: process.env.DELHIVERY_TOKEN || "",
  delhiveryBaseUrl: process.env.DELHIVERY_BASE_URL || "https://staging-express.delhivery.com",
  delhiveryPickupName: process.env.DELHIVERY_PICKUP_NAME || "",
  delhiveryWebhookSecret: process.env.DELHIVERY_WEBHOOK_SECRET || "",
};

/** Exact-match CORS check. Requests without Origin (curl, server-to-server, mobile) are allowed. */
export function isOriginAllowed(origin) {
  if (!origin) return true;
  if (isDevLike && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return env.corsOrigins.includes(String(origin).replace(/\/$/, ""));
}
