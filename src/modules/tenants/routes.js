import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import { createTenantSchema, updateTenantSchema, idParamSchema, updateMineSchema } from "./validators.js";

const router = Router();
router.use(authenticate);

router.get("/me", ctrl.getMine);
router.patch("/me", validate(updateMineSchema), audit("update", "tenant"), ctrl.updateMine);
router.get("/", authorize("tenants.view"), ctrl.list);
router.get("/:id", authorize("tenants.view"), validate(idParamSchema), ctrl.get);
router.post(
  "/",
  authorize("tenants.create"),
  validate(createTenantSchema),
  audit("create", "tenant"),
  ctrl.create
);
router.patch(
  "/:id",
  authorize("tenants.edit"),
  validate(updateTenantSchema),
  audit("update", "tenant"),
  ctrl.update
);

export default router;
