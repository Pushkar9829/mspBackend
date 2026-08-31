import { z } from "zod";
import { PRODUCT_STATUSES } from "../../config/constants.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const createCategorySchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
    slug: z.string().max(80).optional(),
    parentId: objectId.nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    sortOrder: z.number().optional(),
    image: z.string().optional(),
    icon: z.string().optional(),
    seo: z.object({ title: z.string().optional(), description: z.string().optional() }).optional(),
  }),
});

export const updateCategorySchema = z.object({
  params: z.object({ id: objectId }),
  body: createCategorySchema.shape.body.partial(),
});

export const createBrandSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
    slug: z.string().max(80).optional(),
    logo: z.string().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),
});

export const updateBrandSchema = z.object({
  params: z.object({ id: objectId }),
  body: createBrandSchema.shape.body.partial(),
});

export const createProductSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    sku: z.string().min(1).max(80),
    barcode: z.string().optional(),
    description: z.string().optional(),
    specifications: z.record(z.any()).optional(),
    images: z.array(z.string()).optional(),
    videos: z.array(z.string()).optional(),
    documents: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    categoryId: objectId.optional(),
    brandId: objectId.optional(),
    taxClass: z.object({ name: z.string().optional(), rate: z.number().min(0).max(100).optional() }).optional(),
    status: z.enum(PRODUCT_STATUSES).optional(),
    scheduledAt: z.coerce.date().optional(),
    wholesale: z
      .object({
        moq: z.number().min(1).optional(),
        maxQty: z.number().nullable().optional(),
        packMultiple: z.number().min(1).optional(),
        caseQty: z.number().min(1).optional(),
        leadTimeDays: z.number().min(0).optional(),
      })
      .optional(),
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ id: objectId }),
  body: createProductSchema.shape.body.partial(),
});

export const createVariantSchema = z.object({
  body: z.object({
    productId: objectId,
    sku: z.string().min(1).max(80),
    barcode: z.string().optional(),
    attributes: z.object({}).passthrough().optional(),
    listPrice: z.number().min(0),
    sellingPrice: z.number().min(0),
    tierPrices: z
      .array(
        z.object({
          minQty: z.number().min(1),
          maxQty: z.number().nullable().optional(),
          unitPrice: z.number().min(0),
        })
      )
      .optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),
});

export const updateVariantSchema = z.object({
  params: z.object({ id: objectId }),
  body: createVariantSchema.shape.body.partial(),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});
