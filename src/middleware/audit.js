import { AuditLog } from "../modules/audit/auditLog.model.js";

export function audit(action, resource) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      res.locals.auditBody = body;
      return originalJson(body);
    };

    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      AuditLog.create({
        actorId: req.user?._id,
        tenantId: req.tenantId || req.user?.tenantId || null,
        action,
        resource,
        resourceId: req.params.id || res.locals.auditBody?._id || res.locals.auditBody?.id || null,
        ip: req.ip,
        userAgent: req.headers["user-agent"],
        requestId: req.requestId,
        after: summarize(res.locals.auditBody),
        metadata: {
          method: req.method,
          path: req.originalUrl,
        },
      }).catch((err) => console.error("audit write failed", err.message));
    });

    next();
  };
}

function summarize(body) {
  if (!body || typeof body !== "object") return body ?? null;
  const clone = { ...body };
  delete clone.password;
  delete clone.passwordHash;
  delete clone.refreshToken;
  delete clone.token;
  delete clone.accessToken;
  if (clone.orders) {
    return { orderCount: clone.orders.length, ids: clone.orders.map((o) => o._id) };
  }
  return clone;
}
