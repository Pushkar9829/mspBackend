import rateLimit from "express-rate-limit";

/**
 * NOTE: the default store is in-memory, i.e. per process. On multiple instances / serverless each
 * instance counts separately. Use a shared store (e.g. rate-limit-redis) when scaling out.
 */
function limiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message, code: "RATE_LIMIT" },
  });
}

export const loginLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many login attempts" });
export const registerLimiter = limiter({ windowMs: 60 * 60 * 1000, max: 10, message: "Too many sign-ups from this network" });
export const forgotLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 5, message: "Too many reset requests" });
export const resetLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 10, message: "Too many reset attempts" });
export const verifyLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 10, message: "Too many verification requests" });
export const refreshLimiter = limiter({ windowMs: 60 * 1000, max: 60, message: "Too many refresh requests" });
export const sensitiveLimiter = limiter({ windowMs: 15 * 60 * 1000, max: 10, message: "Too many attempts" });

export const couponLimiter = limiter({ windowMs: 60 * 1000, max: 30, message: "Too many coupon checks" });
export const chatLimiter = limiter({ windowMs: 60 * 1000, max: 60, message: "Too many chat requests" });
export const searchLimiter = limiter({ windowMs: 60 * 1000, max: 120, message: "Too many search requests" });
export const publicWriteLimiter = limiter({ windowMs: 60 * 60 * 1000, max: 20, message: "Too many requests" });
export const restockLimiter = limiter({ windowMs: 60 * 60 * 1000, max: 10, message: "Too many restock alert requests" });
export const reviewLimiter = limiter({ windowMs: 60 * 60 * 1000, max: 10, message: "Too many reviews" });
/** Public product-page PIN code checks (GET /products/:slug/serviceability). */
export const serviceabilityLimiter = limiter({ windowMs: 60 * 1000, max: 30, message: "Too many delivery checks" });
/** Public PIN code → city/state lookups (GET /location/pincode/:pin). */
export const pincodeLimiter = limiter({ windowMs: 60 * 1000, max: 30, message: "Too many PIN code lookups" });
/** Public store directory (GET /tenants/public). */
export const storeListLimiter = limiter({ windowMs: 60 * 1000, max: 60, message: "Too many store list requests" });
