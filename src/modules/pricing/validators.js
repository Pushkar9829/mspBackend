import { z } from "zod";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const money = z.number().min(0).max(1e9);

const priceItems = z.array(z.object({ variantId: objectId, unitPrice: money }).strict()).max(5000);

/** Approval only happens through POST /:id/approve, so create can only ask for draft / review. */
export const createPriceListSchema = z.object({
  body: z
    .object({
      name: z.string().min(1).max(120),
      customerId: objectId.nullable().optional(),
      isDefault: z.boolean().optional(),
      status: z.enum(["draft", "active", "inactive", "pending_approval"]).optional(),
      items: priceItems.default([]),
    })
    .strict(),
});

export const updatePriceListSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      name: z.string().min(1).max(120).optional(),
      customerId: objectId.nullable().optional(),
      isDefault: z.boolean().optional(),
      /** Only taking a list out of service; activation goes through approve. */
      status: z.enum(["draft", "inactive", "pending_approval"]).optional(),
      items: priceItems.optional(),
    })
    .strict(),
});

const offerBody = {
  name: z.string().min(1).max(120),
  type: z.enum(["percent", "fixed", "flash"]),
  value: money,
  productIds: z.array(objectId).max(1000).optional(),
  categoryIds: z.array(objectId).max(500).optional(),
  customerIds: z.array(objectId).max(1000).optional(),
  inventoryCap: z.number().int().min(0).nullable().optional(),
  appliesTo: z.enum(["all", "regular", "bulk"]).optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
};

export const createOfferSchema = z.object({
  body: z
    .object({
      ...offerBody,
      status: z.enum(["draft", "active", "inactive", "pending_approval"]).optional(),
    })
    .strict()
    .refine((b) => b.type !== "percent" || b.value <= 100, { message: "Percent offers cannot exceed 100" })
    .refine((b) => b.endsAt > b.startsAt, { message: "endsAt must be after startsAt" }),
});

export const updateOfferSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      name: offerBody.name.optional(),
      type: offerBody.type.optional(),
      value: offerBody.value.optional(),
      productIds: offerBody.productIds,
      categoryIds: offerBody.categoryIds,
      customerIds: offerBody.customerIds,
      inventoryCap: offerBody.inventoryCap,
      appliesTo: offerBody.appliesTo,
      startsAt: z.coerce.date().optional(),
      endsAt: z.coerce.date().optional(),
      status: z.enum(["draft", "inactive", "pending_approval"]).optional(),
    })
    .strict()
    .refine((b) => b.type !== "percent" || b.value == null || b.value <= 100, { message: "Percent offers cannot exceed 100" }),
});

const couponBody = {
  code: z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9_-]+$/, "Use letters, digits, - or _"),
  name: z.string().min(1).max(120),
  type: z.enum(["percent", "fixed"]),
  value: money,
  minCartValue: money.optional(),
  maxRedemptions: z.number().int().min(1).nullable().optional(),
  perCustomerLimit: z.number().int().min(1).max(1000).optional(),
  excludedProductIds: z.array(objectId).max(1000).optional(),
  appliesTo: z.enum(["all", "regular", "bulk"]).optional(),
  firstOrderOnly: z.boolean().optional(),
  visibility: z.enum(["public", "private"]).optional(),
  customerIds: z.array(objectId).max(1000).optional(),
  description: z.string().trim().max(300).optional(),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
};

export const createCouponSchema = z.object({
  body: z
    .object(couponBody)
    .strict()
    .refine((b) => b.type !== "percent" || b.value <= 100, { message: "Percent coupons cannot exceed 100" }),
});

/** No status (use /disable), no redemptionCount, no tenantId. */
export const updateCouponSchema = z.object({
  params: z.object({ id: objectId }),
  body: z
    .object({
      code: couponBody.code.optional(),
      name: couponBody.name.optional(),
      type: couponBody.type.optional(),
      value: couponBody.value.optional(),
      minCartValue: couponBody.minCartValue,
      maxRedemptions: couponBody.maxRedemptions,
      perCustomerLimit: couponBody.perCustomerLimit,
      excludedProductIds: couponBody.excludedProductIds,
      appliesTo: couponBody.appliesTo,
      firstOrderOnly: couponBody.firstOrderOnly,
      visibility: couponBody.visibility,
      customerIds: couponBody.customerIds,
      description: couponBody.description,
      startsAt: couponBody.startsAt,
      endsAt: couponBody.endsAt,
    })
    .strict(),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});
