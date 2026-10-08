import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { validate } from "../../middleware/validate.js";
import * as service from "./service.js";
import { ANALYTICS_CATEGORIES } from "./events.catalog.js";

const querySchema = z.object({
  query: z
    .object({
      from: z.string().max(40).optional(),
      to: z.string().max(40).optional(),
      event: z.string().regex(/^[A-Z_]{1,60}$/).optional(),
      category: z.enum(ANALYTICS_CATEGORIES).optional(),
      importance: z.enum(["critical", "high", "normal", "low"]).optional(),
      userId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .passthrough(),
});

const router = Router();
router.use(authenticate, resolveTenant, authorizeAny("analytics.view", "reports.view", "audit.view"), validate(querySchema));

router.get("/catalog", asyncHandler(async (_req, res) => {
  res.json(service.catalog());
}));
router.get("/overview", asyncHandler(async (req, res) => {
  res.json(await service.overview(req));
}));
router.get("/by-date", asyncHandler(async (req, res) => {
  res.json(await service.byDate(req));
}));
router.get("/by-event", asyncHandler(async (req, res) => {
  res.json(await service.byEvent(req));
}));
router.get("/by-tenant", asyncHandler(async (req, res) => {
  res.json(await service.byTenant(req));
}));
router.get("/important", asyncHandler(async (req, res) => {
  res.json(await service.important(req));
}));
router.get("/events", asyncHandler(async (req, res) => {
  res.json(await service.feed(req));
}));

export default router;
