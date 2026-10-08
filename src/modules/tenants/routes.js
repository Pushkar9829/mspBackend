import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import * as ctrl from "./controller.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getPublicStore, listPublicStores } from "./service.js";
import { storeListLimiter } from "../../middleware/rateLimits.js";
import { createTenantSchema, updateTenantSchema, idParamSchema, updateMineSchema, listTenantsSchema } from "./validators.js";

const router = Router();

/** Public store directory (no auth, rate limited): active/trial stores, paginated. */
router.get(
  "/public",
  storeListLimiter,
  asyncHandler(async (req, res) => {
    res.json(await listPublicStores(req.query));
  })
);

/** Public storefront info (no auth): active/trial stores by id or slug. */
router.get(
  "/public/:idOrSlug",
  asyncHandler(async (req, res) => {
    res.json(await getPublicStore(req.params.idOrSlug));
  })
);

router.use(authenticate);

router.get("/me", ctrl.getMine);
router.patch("/me", audit("update", "tenant"), authorize("settings.edit"), validate(updateMineSchema), ctrl.updateMine);
router.get("/", authorize("tenants.view"), validate(listTenantsSchema), ctrl.list);
router.get("/:id", authorize("tenants.view"), validate(idParamSchema), ctrl.get);
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
