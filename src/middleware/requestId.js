import { nanoid } from "nanoid";

export function requestId(req, res, next) {
  req.requestId = req.headers["x-request-id"] || nanoid(12);
  res.setHeader("x-request-id", req.requestId);
  next();
}
