import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import { createRoleSchema, updateRoleSchema, idParamSchema } from "./validators.js";

export const permissionRouter = Router();
permissionRouter.use(authenticate);
permissionRouter.get("/", authorize("roles.view"), ctrl.listPermissions);

export const roleRouter = Router();
roleRouter.use(authenticate, resolveTenant);
roleRouter.get("/", authorize("roles.view"), ctrl.listRoles);
roleRouter.get("/:id", authorize("roles.view"), validate(idParamSchema), ctrl.getRole);
roleRouter.post(
  "/",
  authorize("roles.create"),
  validate(createRoleSchema),
  audit("create", "role"),
  ctrl.createRole
);
roleRouter.patch(
  "/:id",
  authorize("roles.edit"),
  validate(updateRoleSchema),
  audit("update", "role"),
  ctrl.updateRole
);
roleRouter.delete(
  "/:id",
  authorize("roles.delete"),
  validate(idParamSchema),
  audit("delete", "role"),
  ctrl.deleteRole
);
