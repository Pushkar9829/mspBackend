import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const router = Router();
router.use(authenticate, resolveTenant, authorizeAny("analytics.view", "reports.view", "audit.view"));

router.get("/overview", asyncHandler(async (req, res) => {
  res.json(await service.overview(req));
}));
router.get("/by-date", asyncHandler(async (req, res) => {
  res.json(await service.byDate(req));
}));
router.get("/by-event", asyncHandler(async (req, res) => {
  res.json(await service.byEvent(req));
}));
router.get("/important", asyncHandler(async (req, res) => {
  res.json(await service.important(req));
}));
router.get("/events", asyncHandler(async (req, res) => {
  res.json(await service.feed(req));
}));

export default router;
