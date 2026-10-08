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

const SEGMENTS = new Set(["body", "params", "query"]);

/**
 * Turn zod issues into { message, fields }. `message` keeps the first issue ("path: message"),
 * `fields` maps EVERY failing path (dot-joined, without the body/params/query prefix) to its
 * first message. Issues without a path are keyed "_".
 */
export function zodIssues(issues = [], { stripSegments = true } = {}) {
  const fields = {};
  let message = "Validation failed";
  issues.forEach((issue, index) => {
    const parts = (issue.path || []).filter((p, i) => !(stripSegments && i === 0 && SEGMENTS.has(p)));
    const path = parts.join(".");
    const key = path || "_";
    if (!(key in fields)) fields[key] = issue.message;
    if (index === 0) message = path ? `${path}: ${issue.message}` : issue.message;
  });
  return { message, fields };
}

export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse({
      body: req.body ?? {},
      params: req.params,
      query: req.query,
    });

    if (!result.success) {
      const { message, fields } = zodIssues(result.error.issues);
      return next(new AppError(400, message, "VALIDATION_ERROR", { fields }));
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
