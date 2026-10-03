import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { getCommerceSettings } from "../settings/commerce.js";

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
router.get("/:id/invoice", authorize("orders.view"), asyncHandler(async (req, res) => {
  res.json(await service.getInvoice(req, req.params.id));
}));
router.get("/:id", authorize("orders.view"), asyncHandler(async (req, res) => {
  const [order, commerce] = await Promise.all([service.getOrder(req, req.params.id), getCommerceSettings()]);
  res.json({
    ...order.toObject(),
    returnUntil: service.returnDeadline(order, commerce),
    returnWindowDays: commerce.returnWindowDays,
  });
}));
router.post(
  "/:id/return",
  authorize("orders.view"),
  audit("return_request", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.requestReturn(req, req.params.id, req.body || {}));
  })
);
router.post(
  "/:id/return/reject",
  authorize("orders.refund"),
  audit("return_reject", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.rejectReturn(req, req.params.id, req.body?.note));
  })
);
router.post(
  "/:id/status",
  authorizeAny("orders.update", "orders.cancel", "orders.refund"),
  audit("status", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateStatus(req, req.params.id, req.body.status, req.body.note));
  })
);
router.patch(
  "/:id",
  authorize("orders.update"),
  audit("update", "order"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateNotes(req, req.params.id, req.body));
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
