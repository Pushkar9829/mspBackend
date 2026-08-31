import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import { createUserSchema, updateUserSchema, idParamSchema } from "./validators.js";

const router = Router();
router.use(authenticate, resolveTenant);

router.get("/", authorize("users.view"), ctrl.list);
router.get("/:id", authorize("users.view"), validate(idParamSchema), ctrl.get);
router.post(
  "/",
  authorize("users.create"),
  validate(createUserSchema),
  audit("create", "user"),
  ctrl.create
);
router.patch(
  "/:id",
  authorize("users.edit"),
  validate(updateUserSchema),
  audit("update", "user"),
  ctrl.update
);
router.delete(
  "/:id",
  authorize("users.delete"),
  validate(idParamSchema),
  audit("delete", "user"),
  ctrl.remove
);

export default router;
