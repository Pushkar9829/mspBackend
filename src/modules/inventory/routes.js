import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

const warehouseSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    code: z.string().min(1),
    addressLine1: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),
});

const warehouseUpdateSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      name: z.string().min(1).max(120).optional(),
      code: z.string().min(1).max(40).optional(),
      addressLine1: z.string().max(300).optional(),
      city: z.string().max(120).optional(),
      state: z.string().max(120).optional(),
      postalCode: z.string().max(20).optional(),
      country: z.string().max(60).optional(),
      latitude: z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
      status: z.enum(["active", "inactive"]).optional(),
    })
    .strict(),
});

const thresholdSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      lowStockThreshold: z.number().int().min(0).optional(),
      incoming: z.number().int().min(0).optional(),
    })
    .strict()
    .refine((b) => b.lowStockThreshold != null || b.incoming != null, { message: "lowStockThreshold or incoming is required" }),
});

const adjustSchema = z.object({
  body: z.object({
    warehouseId: objectId,
    variantId: objectId,
    reason: z.enum(["inward", "adjustment", "damage", "return", "incoming"]),
    qty: z.number().int(),
    note: z.string().optional(),
  }),
});

const setQuantitySchema = z.object({
  body: z
    .object({
      variantId: objectId,
      warehouseId: objectId,
      qty: z.number().int().min(0).max(10_000_000),
      reason: z.enum(["set", "adjustment", "inward", "return"]).optional(),
      note: z.string().max(500).optional(),
    })
    .strict(),
});

const transferSchema = z.object({
  body: z.object({
    fromWarehouseId: objectId,
    toWarehouseId: objectId,
    variantId: objectId,
    qty: z.number().int().positive(),
    note: z.string().optional(),
  }),
});

export const warehouseRouter = Router();
warehouseRouter.use(authenticate, resolveTenant, requireTenant);
warehouseRouter.get("/", authorize("warehouses.view"), asyncHandler(async (req, res) => {
  res.json(await service.listWarehouses(req));
}));
warehouseRouter.post(
  "/",
  authorize("warehouses.create"),
  validate(warehouseSchema),
  audit("create", "warehouse"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createWarehouse(req, req.body));
  })
);
warehouseRouter.patch(
  "/:id",
  authorize("warehouses.edit"),
  validate(warehouseUpdateSchema),
  audit("update", "warehouse"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateWarehouse(req, req.params.id, req.body));
  })
);

export const inventoryRouter = Router();
inventoryRouter.use(authenticate, resolveTenant, requireTenant);
inventoryRouter.get("/", authorize("inventory.view"), asyncHandler(async (req, res) => {
  res.json(await service.listInventory(req));
}));
inventoryRouter.get("/transactions", authorize("inventory.view"), asyncHandler(async (req, res) => {
  res.json(await service.listTransactions(req));
}));
inventoryRouter.get("/reservations", authorize("inventory.view"), asyncHandler(async (req, res) => {
  res.json(await service.listReservations(req));
}));
inventoryRouter.post(
  "/adjust",
  authorize("inventory.adjust"),
  validate(adjustSchema),
  audit("adjust", "inventory"),
  asyncHandler(async (req, res) => {
    res.json(await service.adjustStock(req, req.body));
  })
);
inventoryRouter.post(
  "/set-quantity",
  authorize("inventory.adjust"),
  validate(setQuantitySchema),
  audit("set_quantity", "inventory"),
  asyncHandler(async (req, res) => {
    res.json(await service.setQuantity(req, req.body));
  })
);
inventoryRouter.post(
  "/transfer",
  authorize("inventory.transfer"),
  validate(transferSchema),
  audit("transfer", "inventory"),
  asyncHandler(async (req, res) => {
    res.json(await service.transferStock(req, req.body));
  })
);
inventoryRouter.patch(
  "/:id",
  authorize("inventory.publish"),
  validate(thresholdSchema),
  audit("publish", "inventory"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateThresholds(req, req.params.id, req.body));
  })
);
