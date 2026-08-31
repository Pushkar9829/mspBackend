import { AppError } from "../utils/AppError.js";

export function notFound(_req, res) {
  res.status(404).json({
    message: "Not found",
    code: "NOT_FOUND",
    requestId: _req.requestId,
  });
}

export function errorHandler(err, req, res, _next) {
  if (!(err instanceof AppError)) {
    console.error(err);
  }

  if (err.name === "CastError") {
    return res.status(400).json({
      message: "Invalid id",
      code: "INVALID_ID",
      requestId: req.requestId,
    });
  }

  if (err.name === "ValidationError") {
    return res.status(400).json({
      message: err.message,
      code: "VALIDATION_ERROR",
      requestId: req.requestId,
    });
  }

  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return res.status(401).json({
      message: "Invalid or expired token",
      code: "UNAUTHORIZED",
      requestId: req.requestId,
    });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || "field";
    return res.status(409).json({
      message: `${field} already exists`,
      code: "DUPLICATE",
      requestId: req.requestId,
    });
  }

  const status = err.status || 500;
  res.status(status).json({
    message: status >= 500 ? "Server error" : err.message,
    code: err.code || (status >= 500 ? "SERVER_ERROR" : "ERROR"),
    requestId: req.requestId,
  });
}
