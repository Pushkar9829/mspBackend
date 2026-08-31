import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { listAudit } from "./service.js";

const router = Router();
router.use(authenticate, resolveTenant);
router.get(
  "/",
  authorize("audit.view"),
  asyncHandler(async (req, res) => {
    res.json(await listAudit(req));
  })
);

export default router;
