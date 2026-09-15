import "dotenv/config";

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
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

const nodeEnv = process.env.NODE_ENV || "development";
const isProd = nodeEnv === "production";
const isVercel = bool("VERCEL", false);
const isRender = bool("RENDER", false);

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:5173",
  "https://msp-react.vercel.app",
];

const corsOrigins = [
  ...DEFAULT_CORS_ORIGINS,
  ...list("CORS_ORIGIN"),
  ...list("FRONTEND_URL"),
];

const cookieSameSite = String(
  process.env.COOKIE_SAMESITE || (isProd ? "none" : "lax")
).toLowerCase();

export const env = {
  nodeEnv,
  isProd,
  isVercel,
  isRender,
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT) || 5000,
  mongoUri: required("MONGODB_URI"),
  corsOrigins: [...new Set(corsOrigins)],
  jwtAccessSecret: isProd
    ? required("JWT_ACCESS_SECRET")
    : required("JWT_ACCESS_SECRET", "dev-access-secret-change-me"),
  jwtRefreshSecret: isProd
    ? required("JWT_REFRESH_SECRET")
    : required("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me"),
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || "8h",
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL || "7d",
  superAdminEmail: process.env.SUPER_ADMIN_EMAIL || "admin@msp.local",
  superAdminPassword: process.env.SUPER_ADMIN_PASSWORD || "ChangeMe123!",
  uploadDir: process.env.UPLOAD_DIR || (isVercel ? "/tmp/uploads" : "uploads"),
  mapsProvider: process.env.MAPS_PROVIDER || "stub",
  mapsApiKey: process.env.MAPS_API_KEY || "",
  cookieSameSite,
  cookieSecure: bool("COOKIE_SECURE", isProd || cookieSameSite === "none"),
  seedOnStart: bool("SEED_ON_START", !isVercel),
  seedDemo: bool("SEED_DEMO", !isProd),
};

export function isOriginAllowed(origin) {
  if (!origin) return true;
  return env.corsOrigins.some((allowed) => {
    if (allowed === "*" || allowed === origin) return true;
    if (!allowed.includes("*")) return false;
    const pattern = allowed
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${pattern}$`).test(origin);
  });
}
