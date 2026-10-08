import mongoose from "mongoose";
import { logger } from "../utils/logger.js";
import { AuditLog } from "../modules/audit/auditLog.model.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SECRET_KEYS = new Set([
  "password",
  "passwordHash",
  "refreshToken",
  "refreshTokenHash",
  "token",
  "accessToken",
  "currentPassword",
  "newPassword",
  "passwordResetTokenHash",
  "passwordResetExpires",
  "emailVerifyTokenHash",
  "emailVerifyExpires",
  "tokenVersion",
  "tokenHash",
  "prevTokenHash",
  "secret",
  "apiKey",
  "keySecret",
  "webhookSecret",
]);
const MAX_SNAPSHOT_BYTES = 10 * 1024;
const MAX_DEPTH = 6;

/**
 * Resource → how to load the document as it was BEFORE the handler ran (for `before`).
 * `model` is a mongoose model name (resolved lazily from mongoose.models, so this file does not
 * import other modules' models), `param` the route param holding the id (default "id").
 * `load(req)` may replace the default findById for resources not addressed by id.
 */
export const AUDIT_RESOURCES = {
  user: { model: "User" },
  role: { model: "Role" },
  tenant: {
    model: "Tenant",
    id: (req) => req.params?.id || req.user?.tenantId?._id || req.user?.tenantId || null,
  },
  product: { model: "Product" },
  category: { model: "Category" },
  brand: { model: "Brand" },
  variant: { model: "ProductVariant" },
  media: { model: "Media" },
  review: { model: "Review", param: "reviewId" },
  cms: { model: "CmsPage" },
  order: { model: "Order" },
  coupon: { model: "Coupon" },
  offer: { model: "Offer" },
  priceList: { model: "PriceList" },
  warehouse: { model: "Warehouse" },
  notification: { model: "Notification" },
  settings: {
    model: "Settings",
    load: async (req, Model) => {
      const key = req.params?.key;
      if (!key) return null;
      const platform = req.isPlatformAdmin && !req.tenantId;
      return Model.findOne({ scope: platform ? "platform" : "tenant", tenantId: platform ? null : req.tenantId || null, key }).lean();
    },
  },
};

/** Load the pre-change state of the addressed document (never throws). */
async function loadBefore(req, resource) {
  const def = AUDIT_RESOURCES[resource];
  if (!def) return undefined;
  const Model = mongoose.models[def.model];
  if (!Model) return undefined;
  try {
    if (def.load) return await def.load(req, Model);
    const id = def.id ? def.id(req) : req.params?.[def.param || "id"];
    const raw = id && typeof id === "object" && id._id ? id._id : id;
    if (!raw || !mongoose.isValidObjectId(String(raw))) return undefined;
    return await Model.findById(String(raw)).lean();
  } catch (err) {
    logger.warn("audit before-load failed", { resource, err: err.message });
    return undefined;
  }
}

function actorFrom(req, res) {
  if (req.user?._id) return req.user._id;
  const fromLocals = res.locals.auditActorId;
  if (fromLocals && mongoose.isValidObjectId(String(fromLocals))) return fromLocals;
  return null;
}

function tenantFrom(req, res) {
  const t = req.tenantId || req.user?.tenantId || res.locals.auditTenantId || null;
  if (!t) return null;
  return t._id || t;
}

function errorSummary(body) {
  if (!body || typeof body !== "object") return null;
  return {
    message: typeof body.message === "string" ? body.message.slice(0, 500) : undefined,
    code: body.code,
    fields: body.fields && typeof body.fields === "object" ? summarize(body.fields) : undefined,
  };
}

/**
 * Audit trail middleware. Records successful AND failed (4xx/5xx) calls of mutating routes with
 * `outcome` = success | failure. For PATCH/PUT/DELETE/POST on a known resource (AUDIT_RESOURCES)
 * with an id, `before` is the document as loaded before the handler ran (secret-stripped, capped
 * at 10KB). `metadata.input` keeps the (secret-stripped) request body.
 *
 * Handlers without `req.user` (login/logout) can set `res.locals.auditActorId` / `auditTenantId`.
 */
export function audit(action, resource) {
  return async (req, res, next) => {
    const method = String(req.method || "GET").toUpperCase();
    const mutating = MUTATING.has(method);

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      res.locals.auditBody = body;
      return originalJson(body);
    };

    let beforeDoc;
    if (mutating && method !== "POST") beforeDoc = await loadBefore(req, resource);
    else if (method === "POST" && AUDIT_RESOURCES[resource] && (req.params?.id || req.params?.reviewId)) {
      beforeDoc = await loadBefore(req, resource);
    }

    res.on("finish", () => {
      const failed = res.statusCode >= 400;
      // Failed reads are not interesting (and noisy); failed writes are.
      if (failed && !mutating) return;
      const body = res.locals.auditBody;
      const resourceId =
        req.params?.id ||
        req.params?.reviewId ||
        req.params?.key ||
        (!failed && (body?._id || body?.id || body?.user?.id)) ||
        (beforeDoc?._id ?? null);
      AuditLog.create({
        actorId: actorFrom(req, res),
        tenantId: tenantFrom(req, res),
        action,
        resource,
        resourceId: resourceId ? String(resourceId) : null,
        outcome: failed ? "failure" : "success",
        ip: req.ip,
        userAgent: String(req.headers["user-agent"] || "").slice(0, 300),
        requestId: req.requestId,
        // Never keep `before` of a failed call: the actor may not have been allowed to see it.
        before: !failed && beforeDoc ? summarize(beforeDoc) : null,
        after: failed ? null : summarize(body),
        error: failed ? errorSummary(body) : null,
        metadata: {
          method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          query: compact(req.query),
          params: compact(req.params),
          input: mutating ? summarize(req.body) : undefined,
          ...(res.locals.auditMeta && typeof res.locals.auditMeta === "object" ? summarize(res.locals.auditMeta) : {}),
        },
      }).catch((err) => logger.error("audit write failed", { err: err.message, requestId: req.requestId }));
    });

    next();
  };
}

/** Write an audit entry from a service (no HTTP middleware). Never throws. */
export async function recordAudit(req, { action, resource, resourceId = null, before = null, after = null, outcome = "success", metadata = {} }) {
  try {
    await AuditLog.create({
      actorId: req?.user?._id || null,
      tenantId: req?.tenantId || req?.user?.tenantId?._id || req?.user?.tenantId || null,
      action,
      resource,
      resourceId: resourceId ? String(resourceId) : null,
      outcome,
      ip: req?.ip || "",
      userAgent: String(req?.headers?.["user-agent"] || "").slice(0, 300),
      requestId: req?.requestId || "",
      before: summarize(before),
      after: summarize(after),
      metadata: { method: req?.method, path: req?.originalUrl, ...summarize(metadata) },
    });
  } catch (err) {
    logger.error("audit write failed", { err: err.message });
  }
}

function compact(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const entries = Object.entries(obj).filter(([k, v]) => v != null && v !== "" && !SECRET_KEYS.has(k));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function summarize(body) {
  const out = summarizeRaw(body, 0);
  if (out == null || typeof out !== "object") return out;
  try {
    const size = Buffer.byteLength(JSON.stringify(out));
    if (size > MAX_SNAPSHOT_BYTES) return { truncated: true, bytes: size, id: out._id || out.id || undefined };
  } catch {
    return { truncated: true };
  }
  return out;
}

function summarizeRaw(body, depth) {
  if (body == null) return null;
  if (typeof body !== "object") return body;
  if (body instanceof Date) return body;
  if (body instanceof mongoose.Types.ObjectId) return body;
  if (Buffer.isBuffer(body)) return { buffer: true, bytes: body.length };
  if (depth > MAX_DEPTH) return "[depth]";
  if (Array.isArray(body)) return body.map((item) => summarizeRaw(item, depth + 1));
  const source = typeof body.toObject === "function" ? body.toObject() : body;
  if (source && source._bsontype === "ObjectId") return source;
  if (Array.isArray(source.orders) && depth === 0) {
    return { orderCount: source.orders.length, ids: source.orders.map((o) => o?._id) };
  }
  const clone = {};
  for (const [key, value] of Object.entries(source)) {
    if (SECRET_KEYS.has(key)) continue;
    clone[key] = summarizeRaw(value, depth + 1);
  }
  return clone;
}
