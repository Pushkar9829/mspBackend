import "dotenv/config";

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProd = nodeEnv === "production";

export const env = {
  nodeEnv,
  isProd,
  port: Number(process.env.PORT) || 5000,
  mongoUri: required("MONGODB_URI"),
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
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
  uploadDir: process.env.UPLOAD_DIR || "uploads",
  mapsProvider: process.env.MAPS_PROVIDER || "stub",
  mapsApiKey: process.env.MAPS_API_KEY || "",
};
