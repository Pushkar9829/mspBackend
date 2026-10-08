import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant, requireStaff } from "../../middleware/tenantScope.js";
import { AppError } from "../../utils/AppError.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import { Order } from "../orders/order.model.js";
import { buildOrderFilter, orderSort } from "../orders/service.js";
import { exportInventory } from "../inventory/service.js";
import { validate } from "../../middleware/validate.js";

const router = Router();
router.use(authenticate, resolveTenant, requireStaff);

const EXPORT_CAP = 1000;
const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

const rangeFields = {
  days: z.coerce.number().int().min(1).max(366).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
};
const rangeQuery = z.object({ query: z.object(rangeFields).passthrough() });
const pageFields = {
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};
const customersQuery = z.object({
  query: z
    .object({
      ...pageFields,
      ...rangeFields,
      q: z.string().max(100).optional(),
      sort: z.enum(["spend", "orders", "lastOrderAt", "name"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .passthrough(),
});
const customerDetailSchema = z.object({
  params: z.object({ userId: objectId }),
  query: z.object(pageFields).passthrough(),
});
const tenantsQuery = z.object({
  query: z
    .object({
      ...pageFields,
      ...rangeFields,
      q: z.string().max(100).optional(),
      status: z.string().max(100).optional(),
      sort: z.enum(["gmv", "ordersCount", "staffCount", "aov", "name", "createdAt"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .passthrough(),
});
const exportSchema = z.object({
  params: z.object({ kind: z.enum(["orders", "inventory", "customers", "sales", "skus"]) }),
  query: z.object(rangeFields).passthrough(),
});

function requireTenantContext(req) {
  if (!req.tenantId) throw new AppError(400, "Tenant context required (X-Tenant-Id)", "TENANT_REQUIRED");
}

function platformOnly(req, _res, next) {
  if (!req.isPlatformAdmin) return next(new AppError(403, "Platform admin only", "FORBIDDEN"));
  next();
}

const canSeeCustomers = authorizeAny("reports.view", "orders.view", "ledger.view");

router.get("/overview", authorize("reports.view"), validate(rangeQuery), asyncHandler(async (req, res) => {
  if (req.isPlatformAdmin && !req.tenantId) {
    res.json(await service.platformOverview());
  } else {
    res.json(await service.tenantOverview(req.tenantId, req.query));
  }
}));

router.get("/sales", authorize("reports.view"), validate(rangeQuery), asyncHandler(async (req, res) => {
  res.json(await service.salesTrend(req.tenantId, service.resolveRange(req.query, 30)));
}));

router.get("/tenants", platformOnly, validate(tenantsQuery), asyncHandler(async (req, res) => {
  res.json(await service.tenantsSummary(req.query));
}));

router.get("/customers", canSeeCustomers, validate(customersQuery), asyncHandler(async (req, res) => {
  requireTenantContext(req);
  res.json(await service.tenantCustomers(req.tenantId, req.query));
}));

router.get("/customers/:userId", canSeeCustomers, validate(customerDetailSchema), asyncHandler(async (req, res) => {
  requireTenantContext(req);
  res.json(await service.customerDetail(req.tenantId, req.params.userId, req.query));
}));

function sendCsv(res, kind, csvText, { total, truncated } = {}) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename=${kind}.csv`);
  if (total != null) res.setHeader("X-Export-Total", String(total));
  if (truncated) {
    res.setHeader("X-Export-Truncated", "true");
    res.setHeader("X-Export-Limit", String(EXPORT_CAP));
  }
  res.send(csvText);
}

router.get(
  "/export/:kind",
  authorize("reports.export"),
  validate(exportSchema),
  asyncHandler(async (req, res) => {
    const kind = req.params.kind;
    if (kind === "orders") {
      // Same filters, search and sort as GET /orders.
      const filter = await buildOrderFilter(req);
      const [rows, total] = await Promise.all([
        Order.find(filter)
          .populate("buyerId", "name email")
          .populate("tenantId", "name")
          .sort(orderSort(req.query))
          .limit(EXPORT_CAP)
          .lean(),
        Order.countDocuments(filter),
      ]);
      return sendCsv(res, kind, service.toCsv(kind, rows), { total, truncated: total > EXPORT_CAP });
    }
    if (kind === "inventory") {
      const { rows, total, truncated } = await exportInventory(req, { cap: EXPORT_CAP });
      return sendCsv(res, kind, service.toCsv(kind, rows), { total, truncated });
    }
    if (kind === "customers") {
      requireTenantContext(req);
      const result = await service.tenantCustomers(req.tenantId, req.query, { all: true, cap: EXPORT_CAP });
      const total = result.meta.total;
      return sendCsv(res, kind, service.toCsv(kind, result.data || []), { total, truncated: total > EXPORT_CAP });
    }
    if (kind === "sales") {
      const rows = await service.salesTrend(req.tenantId, service.resolveRange(req.query, 90));
      return sendCsv(res, kind, service.toCsv(kind, rows), { total: rows.length });
    }
    // skus: top SKUs of the store for the requested range (lifetime without one).
    requireTenantContext(req);
    const overview = await service.tenantOverview(req.tenantId, req.query);
    const rows = (overview.topSkus || []).map((r) => ({ sku: r._id, name: r.name || "", qty: r.qty, revenue: r.revenue }));
    return sendCsv(res, kind, service.toCsv(kind, rows), { total: rows.length });
  })
);

export default router;
