import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getPublicStore, listPublicStores } from "./service.js";
import { storeListLimiter } from "../../middleware/rateLimits.js";
import {
  createTenantSchema,
  updateTenantSchema,
  idParamSchema,
  updateMineSchema,
  listTenantsSchema,
  setStatusSchema,
  accessLogSchema,
  accessLogByIdSchema,
} from "./validators.js";

const router = Router();

/** Public store directory (no auth, rate limited): active stores only, paginated. */
router.get(
  "/public",
  storeListLimiter,
  asyncHandler(async (req, res) => {
    res.json(await listPublicStores(req.query));
  })
);

/** Public storefront info (no auth): active stores by id or slug. */
router.get(
  "/public/:idOrSlug",
  asyncHandler(async (req, res) => {
    res.json(await getPublicStore(req.params.idOrSlug));
  })
);

router.use(authenticate);

router.get("/me", ctrl.getMine);
/** Platform-admin access to this store (reads + writes with their reason). Any staff member. */
router.get("/me/access-log", validate(accessLogSchema), ctrl.myAccessLog);
router.patch("/me", audit("update", "tenant"), authorize("settings.edit"), validate(updateMineSchema), ctrl.updateMine);
router.get("/", authorize("tenants.view"), validate(listTenantsSchema), ctrl.list);
router.get("/:id", authorize("tenants.view"), validate(idParamSchema), ctrl.get);
router.get("/:id/access-log", authorize("tenants.view"), validate(accessLogByIdSchema), ctrl.accessLog);
/** Pause / resume / suspend / reactivate / archive with a reason (tenants.suspend). */
router.post("/:id/status", audit("status", "tenant"), authorize("tenants.suspend"), validate(setStatusSchema), ctrl.setStatus);
router.post(
  "/",
  audit("create", "tenant"),
  authorize("tenants.create"),
  validate(createTenantSchema),
  ctrl.create
);
router.patch(
  "/:id",
  audit("update", "tenant"),
  authorize("tenants.edit"),
  validate(updateTenantSchema),
  ctrl.update
);

export default router;
