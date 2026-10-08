import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant, requireStaff } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import { createRoleSchema, updateRoleSchema, idParamSchema } from "./validators.js";

export const permissionRouter = Router();
permissionRouter.use(authenticate);
permissionRouter.get("/", authorize("roles.view"), ctrl.listPermissions);

export const roleRouter = Router();
roleRouter.use(authenticate, resolveTenant, requireStaff);
roleRouter.get("/", authorize("roles.view"), ctrl.listRoles);
roleRouter.get("/:id", authorize("roles.view"), validate(idParamSchema), ctrl.getRole);
roleRouter.post(
  "/",
  audit("create", "role"),
  authorize("roles.create"),
  validate(createRoleSchema),
  ctrl.createRole
);
roleRouter.patch(
  "/:id",
  audit("update", "role"),
  authorize("roles.edit"),
  validate(updateRoleSchema),
  ctrl.updateRole
);
roleRouter.delete(
  "/:id",
  audit("delete", "role"),
  authorize("roles.delete"),
  validate(idParamSchema),
  ctrl.deleteRole
);
