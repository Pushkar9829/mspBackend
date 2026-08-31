import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const router = Router();
router.use(authenticate, resolveTenant);

router.get("/", asyncHandler(async (req, res) => {
  res.json(await service.listMine(req));
}));
router.post("/:id/read", asyncHandler(async (req, res) => {
  res.json(await service.markRead(req, req.params.id));
}));
router.post(
  "/",
  authorize("notifications.send"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createAnnouncement(req, req.body));
  })
);

export default router;
