import { Router } from "express";
import { z } from "zod";
import { optionalAuth } from "../../middleware/authenticate.js";
import { validate } from "../../middleware/validate.js";
import * as rateLimits from "../../middleware/rateLimits.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const passThrough = (_req, _res, next) => next();
const searchLimiter = typeof rateLimits.searchLimiter === "function" ? rateLimits.searchLimiter : passThrough;

const term = z.string().max(200);

const router = Router();
router.use(optionalAuth);

router.get("/suggestions", searchLimiter, asyncHandler(async (req, res) => {
  res.json(await service.suggestions(req));
}));

router.post(
  "/",
  searchLimiter,
  validate(
    z.object({
      body: z
        .object({ q: term.optional(), term: term.optional() })
        .strict()
        .refine((b) => b.q != null || b.term != null, "q is required"),
    })
  ),
  asyncHandler(async (req, res) => {
    res.json(await service.recordSearch(req, req.body.q ?? req.body.term ?? ""));
  })
);

router.delete(
  "/recent",
  validate(z.object({ query: z.object({ q: term.optional() }).passthrough() })),
  asyncHandler(async (req, res) => {
    if (req.query.q) {
      res.json(await service.removeRecent(req, req.query.q));
      return;
    }
    res.json(await service.clearRecent(req));
  })
);

export default router;
