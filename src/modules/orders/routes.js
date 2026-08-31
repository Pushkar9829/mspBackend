import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const router = Router();
router.use(authenticate);
router.use((req, res, next) => {
  const perms = req.permissions || [];
  const buyerOnly = !perms.includes("*") && !perms.includes("orders.update");
  if (buyerOnly) return next();
  return resolveTenant(req, res, next);
});

router.get("/", authorize("orders.view"), asyncHandler(async (req, res) => {
  res.json(await service.listOrders(req));
}));
router.get("/:id", authorize("orders.view"), asyncHandler(async (req, res) => {
  res.json(await service.getOrder(req, req.params.id));
}));
router.post(
  "/:id/status",
  authorizeAny("orders.update", "orders.cancel", "orders.refund"),
  audit("status", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateStatus(req, req.params.id, req.body.status, req.body.note));
  })
);
router.post(
  "/:id/reorder",
  authorize("orders.create"),
  asyncHandler(async (req, res) => {
    res.json(await service.reorder(req, req.params.id));
  })
);

export default router;
