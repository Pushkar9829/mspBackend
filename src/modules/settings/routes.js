import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const router = Router();
router.use(authenticate, resolveTenant, authorizeAny("settings.view", "settings.edit", "tenants.edit", "notifications.manage"));

router.get("/", asyncHandler(async (req, res) => {
  res.json(await service.listSettings(req));
}));
router.put(
  "/:key",
  authorize("settings.edit"),
  audit("upsert", "settings"),
  asyncHandler(async (req, res) => {
    res.json(await service.upsertSetting(req, req.params.key, req.body.value));
  })
);

export default router;
