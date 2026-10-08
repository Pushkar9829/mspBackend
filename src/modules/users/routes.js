import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant, requireStaff } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import { createUserSchema, updateUserSchema, idParamSchema, listUsersSchema } from "./validators.js";

const router = Router();
router.use(authenticate, resolveTenant, requireStaff);

router.get("/", authorize("users.view"), validate(listUsersSchema), ctrl.list);
router.get("/:id", authorize("users.view"), validate(idParamSchema), ctrl.get);
router.post(
  "/",
  audit("create", "user"),
  authorize("users.create"),
  validate(createUserSchema),
  ctrl.create
);
router.patch(
  "/:id",
  audit("update", "user"),
  authorize("users.edit"),
  validate(updateUserSchema),
  ctrl.update
);
router.post(
  "/:id/sign-out-everywhere",
  audit("sign_out_everywhere", "user"),
  authorize("users.edit"),
  validate(idParamSchema),
  ctrl.signOutEverywhere
);
router.delete(
  "/:id",
  audit("delete", "user"),
  authorize("users.delete"),
  validate(idParamSchema),
  ctrl.remove
);

export default router;
