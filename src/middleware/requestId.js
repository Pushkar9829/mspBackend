import { nanoid } from "nanoid";
import { logger } from "../utils/logger.js";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export function requestId(req, res, next) {
  const incoming = req.headers["x-request-id"];
  req.requestId = typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : nanoid(12);
  res.setHeader("x-request-id", req.requestId);
  next();
}

/** One log line per request with status and duration. Skips health probes. */
export function requestLogger(req, res, next) {
  if (req.path === "/api/health" || req.path === "/api/ready") return next();
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]("request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl?.split("?")[0],
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10,
      userId: req.user?._id ? String(req.user._id) : undefined,
      ip: req.ip,
    });
  });
  next();
}
