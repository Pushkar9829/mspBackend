import { AppError } from "../utils/AppError.js";

function assignRequestField(req, field, value) {
  try {
    req[field] = value;
  } catch {
    Object.defineProperty(req, field, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    });

    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue.path.filter((p) => p !== "body" && p !== "params" && p !== "query").join(".");
      const message = path ? `${path}: ${issue.message}` : issue.message;
      return next(new AppError(400, message, "VALIDATION_ERROR"));
    }

    req.validated = result.data;
    if (result.data.body) req.body = result.data.body;
    if (result.data.params) {
      assignRequestField(req, "params", { ...req.params, ...result.data.params });
    }
    if (result.data.query) {
      assignRequestField(req, "query", { ...req.query, ...result.data.query });
    }
    next();
  };
}
