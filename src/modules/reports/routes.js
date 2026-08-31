import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { Order } from "../orders/order.model.js";
import { Inventory } from "../inventory/inventory.model.js";
import { tenantFilter } from "../../middleware/tenantScope.js";

const router = Router();
router.use(authenticate, resolveTenant);

router.get("/overview", authorize("reports.view"), asyncHandler(async (req, res) => {
  if (req.isPlatformAdmin && !req.tenantId) {
    res.json(await service.platformOverview());
  } else {
    res.json(await service.tenantOverview(req.tenantId));
  }
}));

router.get("/sales", authorize("reports.view"), asyncHandler(async (req, res) => {
  res.json(await service.salesTrend(req.tenantId, Number(req.query.days) || 30));
}));

router.get(
  "/export/:kind",
  authorize("reports.export"),
  asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    let rows = [];
    if (kind === "orders") {
      rows = await Order.find(tenantFilter(req)).sort({ createdAt: -1 }).limit(1000).lean();
    } else if (kind === "inventory") {
      rows = await Inventory.find(tenantFilter(req)).limit(1000).lean();
    } else {
      return res.status(400).json({ message: "Unknown export kind", code: "VALIDATION_ERROR" });
    }
    const csv = service.toCsv(kind, rows);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=${kind}.csv`);
    res.send(csv);
  })
);

export default router;
