import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { zodIssues } from "./validate.js";

/** Index keys that only scope a unique index; they never explain a duplicate to a user. */
const SCOPE_KEYS = new Set(["tenantId", "scope", "userId", "buyerId", "productId", "pageId", "conversationId", "warehouseId", "variantId", "parentId", "status", "isSystem"]);
const FIELD_LABELS = {
  slug: "Slug",
  sku: "SKU",
  email: "Email",
  code: "Code",
  key: "Key",
  name: "Name",
  barcode: "Barcode",
  orderNumber: "Order number",
  invoiceNumber: "Invoice number",
  phone: "Phone",
};

/**
 * Explain an E11000 error. For compound indexes ({ tenantId, slug }) the meaningful field is the
 * first non-scope key; `fields` lists every meaningful key → message.
 */
export function describeDuplicate(err) {
  const pattern = Object.keys(err.keyPattern || err.keyValue || {});
  if (!pattern.length) {
    const m = /index: (\S+) dup key/.exec(String(err.message || ""));
    if (m) pattern.push(...m[1].split("_").filter((p, i) => i % 2 === 0 && p));
  }
  let meaningful = pattern.filter((k) => !SCOPE_KEYS.has(k));
  if (!meaningful.length) meaningful = pattern.length ? [pattern[pattern.length - 1]] : ["value"];
  const label = (k) => FIELD_LABELS[k.split(".").pop()] || k.split(".").pop().replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  const scoped = pattern.some((k) => k === "tenantId");
  const fields = {};
  for (const k of meaningful) fields[k] = `${label(k)} is already in use${scoped ? " in this store" : ""}`;
  const main = meaningful[0];
  const message = meaningful.length > 1
    ? `This combination of ${meaningful.map(label).join(", ").toLowerCase()} already exists`
    : `${label(main)} is already in use${scoped ? " in this store" : ""}`;
  return { message, fields, field: main };
}

export function notFound(req, res) {
  res.status(404).json({
    message: "Not found",
    code: "NOT_FOUND",
    requestId: req.requestId,
  });
}

function send(res, req, status, message, code, extra = {}) {
  return res.status(status).json({ message, code, ...extra, requestId: req.requestId });
}

export function errorHandler(err, req, res, _next) {
  if (res.headersSent) return;

  if (err instanceof AppError) {
    const status = err.status || 500;
    if (status >= 500) logger.error("app error", { requestId: req.requestId, err });
    return send(res, req, status, status >= 500 ? "Server error" : err.message, err.code || "ERROR", status >= 500 ? {} : err.extra || {});
  }

  // Body parser / multer errors
  if (err.type === "entity.parse.failed") return send(res, req, 400, "Malformed JSON body", "BAD_JSON");
  if (err.type === "entity.too.large" || err.code === "LIMIT_FILE_SIZE") {
    return send(res, req, 413, "Payload too large", "PAYLOAD_TOO_LARGE");
  }
  if (err.name === "MulterError") return send(res, req, 400, "Invalid upload", "UPLOAD_ERROR");

  if (err.name === "CastError") return send(res, req, 400, "Invalid id", "INVALID_ID");

  if (err.name === "ZodError" && Array.isArray(err.issues)) {
    const { message, fields } = zodIssues(err.issues, { stripSegments: false });
    return send(res, req, 400, message, "VALIDATION_ERROR", { fields });
  }

  if (err.name === "ValidationError") {
    // path -> message (Mongoose kind only, never the rejected value).
    const names = Object.keys(err.errors || {});
    const fields = Object.fromEntries(
      names.map((name) => {
        const e = err.errors[name];
        const kind = e?.kind === "required" ? "is required" : e?.kind === "enum" ? "has an invalid value" : "is invalid";
        return [name, `${name} ${kind}`];
      })
    );
    return send(res, req, 400, names.length ? `Invalid fields: ${names.join(", ")}` : "Validation failed", "VALIDATION_ERROR", { fields });
  }

  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return send(res, req, 401, "Invalid or expired token", "UNAUTHORIZED");
  }

  if (err.code === 11000 || err.cause?.code === 11000) {
    const { message, fields, field } = describeDuplicate(err.code === 11000 ? err : err.cause);
    return send(res, req, 409, message, "DUPLICATE", { field, fields });
  }

  const status = Number(err.status || err.statusCode) || 500;
  if (status >= 500) {
    logger.error("unhandled error", { requestId: req.requestId, path: req.originalUrl, err });
  }
  return send(
    res,
    req,
    status,
    status >= 500 ? "Server error" : err.expose === false ? "Request failed" : err.message,
    err.code && typeof err.code === "string" ? err.code : status >= 500 ? "SERVER_ERROR" : "ERROR"
  );
}
