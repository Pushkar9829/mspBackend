import { AuditLog } from "../modules/audit/auditLog.model.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SECRET_KEYS = new Set([
  "password",
  "passwordHash",
  "refreshToken",
  "refreshTokenHash",
  "token",
  "accessToken",
]);

export function audit(action, resource) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      res.locals.auditBody = body;
      return originalJson(body);
    };

    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      const method = String(req.method || "GET").toUpperCase();
      const mutating = MUTATING.has(method);
      AuditLog.create({
        actorId: req.user?._id,
        tenantId: req.tenantId || req.user?.tenantId || null,
        action,
        resource,
        resourceId: req.params.id || res.locals.auditBody?._id || res.locals.auditBody?.id || null,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.requestId,
        before: mutating ? summarize(req.body) : null,
        after: summarize(res.locals.auditBody),
        metadata: {
          method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          query: compact(req.query),
          params: compact(req.params),
        },
      }).catch((err) => console.error("audit write failed", err.message));
    });

    next();
  };
}

function compact(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const entries = Object.entries(obj).filter(([, v]) => v != null && v !== "");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function summarize(body) {
  if (body == null) return null;
  if (typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map((item) => summarize(item));
  const clone = { ...body };
  for (const key of SECRET_KEYS) delete clone[key];
  if (clone.admin && typeof clone.admin === "object") {
    const admin = { ...clone.admin };
    delete admin.password;
    clone.admin = admin;
  }
  if (clone.orders) {
    return { orderCount: clone.orders.length, ids: clone.orders.map((o) => o._id) };
  }
  return clone;
}
