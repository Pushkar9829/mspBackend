/**
 * GET /api/v1/billing/me/entitlements — the store's plan features, limits and live usage (seller
 * panel). Owned by p3-limits; mounted by the billing router (p3-billing) under /billing:
 *   billingRouter.use(entitlementsRouter)   // or v1.use("/billing", entitlementsRouter)
 * A platform admin may pass X-Tenant-Id to see a store's entitlements.
 */
import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { resolveTenant, requireStaff, requireTenant } from "../../middleware/tenantScope.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { getEntitlements } from "./entitlements.js";

const router = Router();

router.get(
  "/me/entitlements",
  authenticate,
  resolveTenant,
  requireStaff,
  requireTenant,
  asyncHandler(async (req, res) => {
    res.json(await getEntitlements(req.tenantId));
  })
);

export default router;
export { router as entitlementsRouter };
