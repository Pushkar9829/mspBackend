import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant, tenantFilter } from "../../middleware/tenantScope.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { Order } from "../orders/order.model.js";
import { Inventory } from "../inventory/inventory.model.js";

const router = Router();
router.use(authenticate, resolveTenant);

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T23:59:59.999`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

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

router.get("/customers", authorize("reports.view"), asyncHandler(async (req, res) => {
  if (!req.tenantId) {
    return res.status(400).json({ message: "Tenant context required", code: "TENANT_REQUIRED" });
  }
  res.json(await service.tenantCustomers(req.tenantId, req.query));
}));

router.get(
  "/export/:kind",
  authorize("reports.export"),
  asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    let rows = [];
    if (kind === "orders") {
      const filter = tenantFilter(req);
      if (req.query.status) filter.status = req.query.status;
      if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
      const from = parseDate(req.query.from);
      const to = parseDate(req.query.to, true);
      if (from || to) {
        filter.createdAt = {};
        if (from) filter.createdAt.$gte = from;
        if (to) filter.createdAt.$lte = to;
      }
      rows = await Order.find(filter)
        .populate("buyerId", "name email")
        .sort({ createdAt: -1 })
        .limit(1000)
        .lean();
    } else if (kind === "inventory") {
      rows = await Inventory.find(tenantFilter(req))
        .populate("warehouseId", "name code")
        .populate({ path: "variantId", select: "sku productId", populate: { path: "productId", select: "name" } })
        .limit(1000)
        .lean();
    } else if (kind === "customers") {
      if (!req.tenantId) {
        return res.status(400).json({ message: "Tenant context required", code: "TENANT_REQUIRED" });
      }
      const result = await service.tenantCustomers(req.tenantId, { page: 1, limit: 1000 });
      rows = result.data || [];
    } else if (kind === "sales") {
      rows = await service.salesTrend(req.tenantId, Number(req.query.days) || 90);
    } else if (kind === "skus") {
      const overview = req.tenantId
        ? await service.tenantOverview(req.tenantId)
        : { topSkus: [] };
      rows = (overview.topSkus || []).map((r) => ({
        sku: r._id,
        name: r.name || "",
        qty: r.qty,
        revenue: r.revenue,
      }));
    } else {
      return res.status(400).json({ message: "Unknown export kind", code: "VALIDATION_ERROR" });
    }
    const csv = service.toCsv(kind, rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${kind}.csv`);
    res.send(csv);
  })
);

export default router;
