import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const createPriceListSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    customerId: objectId.nullable().optional(),
    isDefault: z.boolean().optional(),
    status: z.enum(["draft", "active", "inactive", "pending_approval"]).optional(),
    items: z
      .array(z.object({ variantId: objectId, unitPrice: z.number().min(0) }))
      .default([]),
  }),
});

export const createOfferSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    type: z.enum(["percent", "fixed", "flash"]),
    value: z.number().min(0),
    productIds: z.array(objectId).optional(),
    categoryIds: z.array(objectId).optional(),
    customerIds: z.array(objectId).optional(),
    inventoryCap: z.number().nullable().optional(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    status: z.enum(["draft", "active", "inactive", "pending_approval"]).optional(),
  }),
});

export const createCouponSchema = z.object({
  body: z.object({
    code: z.string().min(2).max(40),
    name: z.string().min(1),
    type: z.enum(["percent", "fixed"]),
    value: z.number().min(0),
    minCartValue: z.number().min(0).optional(),
    maxRedemptions: z.number().nullable().optional(),
    perCustomerLimit: z.number().min(1).optional(),
    excludedProductIds: z.array(objectId).optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
  }),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});
