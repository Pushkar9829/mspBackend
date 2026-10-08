import { z } from "zod";
import { FULFILLMENT_MODES } from "../../config/constants.js";
import { MEDIA_FOLDERS } from "./media.model.js";
import { isSafeMediaUrl } from "../cms/sanitize.js";

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const body = (shape) => z.object(shape).strict();
const shortText = (max = 200) => z.string().trim().max(max);
/** Media URL: http(s) or our own /uploads/ path ("" clears where optional). Never javascript:/data: etc. */
const url = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => v === "" || isSafeMediaUrl(v), "Must be an http(s) URL or an /uploads/ path");
const money = z.number().min(0).max(1e9);
const pageQuery = {
  page: z.coerce.number().int().min(1).max(100000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};

/** Statuses a create/update body may set. `published` is gated on products.publish in the service; `archived` = DELETE. */
const EDITABLE_PRODUCT_STATUSES = ["draft", "pending_review", "scheduled", "published"];

export const listQuerySchema = z.object({ query: z.object(pageQuery).passthrough() });

export const createCategorySchema = z.object({
  body: body({
    name: z.string().trim().min(1).max(120),
    slug: z.string().max(80).optional(),
    parentId: objectId.nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
    sortOrder: z.number().int().min(-1e6).max(1e6).optional(),
    image: url.optional(),
    icon: shortText(200).optional(),
    seo: body({ title: shortText(200).optional(), description: shortText(500).optional() }).optional(),
  }),
});

export const updateCategorySchema = z.object({
  params: z.object({ id: objectId }),
  body: createCategorySchema.shape.body.partial(),
});

export const createBrandSchema = z.object({
  body: body({
    name: z.string().trim().min(1).max(120),
    slug: z.string().max(80).optional(),
    logo: url.optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),
});

export const updateBrandSchema = z.object({
  params: z.object({ id: objectId }),
  body: createBrandSchema.shape.body.partial(),
});

const tierPricesSchema = z
  .array(
    body({
      minQty: z.number().int().min(1),
      maxQty: z.number().int().min(1).nullable().optional(),
      unitPrice: money,
    })
  )
  .max(20);

const wholesaleSchema = body({
  bulkEligible: z.boolean().optional(),
  moq: z.number().int().min(1).optional(),
  maxQty: z.number().int().min(1).nullable().optional(),
  packMultiple: z.number().int().min(1).optional(),
  caseQty: z.number().int().min(1).optional(),
  leadTimeDays: z.number().int().min(0).max(365).optional(),
});

const ATTR_KEY = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;
const FIXED_ATTRS = ["size", "color", "grade", "material", "packSize", "unit", "weight", "dimensions", "custom"];
const attrScalar = z.union([z.string().max(120), z.number(), z.boolean()]);

/**
 * Variant attributes: the fixed ones are typed; anything else (e.g. `flavor`) is kept, either
 * sent under `custom` or as an extra top-level key (moved into `custom`). Nothing is silently dropped.
 */
export const variantAttributesSchema = z
  .object({
    size: shortText(60).optional(),
    color: shortText(60).optional(),
    grade: shortText(60).optional(),
    material: shortText(60).optional(),
    packSize: shortText(40).optional(),
    unit: shortText(20).optional(),
    /** `null` clears (variant update). */
    weight: z.number().min(0).nullable().optional(),
    /** `null` clears (variant update). */
    dimensions: body({
      l: z.number().min(0).optional(),
      w: z.number().min(0).optional(),
      h: z.number().min(0).optional(),
    })
      .nullable()
      .optional(),
    custom: z.record(z.string().regex(ATTR_KEY, "Invalid attribute name"), attrScalar).optional(),
  })
  .catchall(attrScalar)
  .superRefine((attrs, ctx) => {
    const extra = Object.keys(attrs).filter((k) => !FIXED_ATTRS.includes(k));
    for (const key of extra) {
      if (!ATTR_KEY.test(key)) ctx.addIssue({ code: "custom", message: `Invalid attribute name "${key}"`, path: [key] });
    }
    const total = extra.length + Object.keys(attrs.custom || {}).length;
    if (total > 20) ctx.addIssue({ code: "custom", message: "At most 20 custom attributes" });
  })
  .transform((attrs) => {
    const out = {};
    const custom = { ...(attrs.custom || {}) };
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "custom") continue;
      if (FIXED_ATTRS.includes(key)) out[key] = value;
      else custom[key] = value;
    }
    const entries = Object.entries(custom).map(([k, v]) => [k, String(v)]);
    if (entries.length) out.custom = Object.fromEntries(entries);
    // An explicit empty `custom: {}` (and no extra keys) clears every custom attribute.
    else if (attrs.custom !== undefined) out.custom = null;
    return out;
  });

/**
 * Product specifications. Accepts the shapes the seed and the admin UI use:
 * - scalar values: { manufacturer: "Tata", shelfLifeDays: 270, organic: true, note: null }
 * - lists of scalars: { features: ["Strong aroma", "Sealed pack"] }
 * - one level of nested scalars: { nutrition: { energy: "900 kcal", fat: "100 g" } }
 * - label/value rows: { table: [{ label: "Energy", value: "900 kcal" }] }
 * or the whole thing as an array of { label|name|key, value } rows (converted to an object).
 * Max 50 keys, 50 list items, 16KB total.
 */
const SPEC_KEY = z.string().trim().min(1).max(80);
const specScalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
const specRow = z
  .object({
    label: z.string().trim().max(120).optional(),
    name: z.string().trim().max(120).optional(),
    key: z.string().trim().max(120).optional(),
    value: specScalar,
    unit: z.string().trim().max(20).optional(),
  })
  .strict()
  .refine((r) => r.label || r.name || r.key, { message: "row needs a label" });
const specValue = z.union([
  specScalar,
  z.array(z.union([z.string().max(500), z.number().finite(), z.boolean()])).max(50),
  z.array(specRow).max(50),
  z.record(SPEC_KEY, specScalar).refine((o) => Object.keys(o).length <= 50, { message: "At most 50 nested keys" }),
]);
const specObject = z.record(SPEC_KEY, specValue).refine((o) => Object.keys(o).length <= 50, { message: "At most 50 specifications" });
export const specificationsSchema = z
  .union([
    specObject,
    z
      .array(
        z
          .object({
            label: z.string().trim().max(80).optional(),
            name: z.string().trim().max(80).optional(),
            key: z.string().trim().max(80).optional(),
            value: specValue,
          })
          .strict()
          .refine((r) => r.label || r.name || r.key, { message: "row needs a label" })
      )
      .max(50)
      .transform((rows) => Object.fromEntries(rows.map((r) => [r.key || r.label || r.name, r.value]))),
  ])
  .refine((o) => JSON.stringify(o).length <= 16 * 1024, { message: "specifications too large (max 16KB)" });

const variantBodyShape = {
  sku: z.string().trim().min(1).max(80),
  barcode: shortText(80).optional(),
  attributes: variantAttributesSchema.optional(),
  listPrice: money,
  sellingPrice: money,
  tierPrices: tierPricesSchema.optional(),
  status: z.enum(["active", "inactive"]).optional(),
};

const productBodyShape = {
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(80),
  barcode: shortText(80).optional(),
  description: z.string().max(20000).optional(),
  specifications: specificationsSchema.optional(),
  images: z.array(url).max(30).optional(),
  videos: z.array(url).max(10).optional(),
  documents: z.array(url).max(20).optional(),
  tags: z.array(shortText(60)).max(30).optional(),
  categoryId: objectId.optional(),
  brandId: objectId.optional(),
  taxClass: body({ name: shortText(40).optional(), rate: z.number().min(0).max(100).optional() }).optional(),
  hsn: z.string().trim().max(12).optional(),
  status: z.enum(EDITABLE_PRODUCT_STATUSES).optional(),
  enabled: z.boolean().optional(),
  availableQty: z.number().int().min(0).max(1e9).optional(),
  scheduledAt: z.union([z.null(), z.coerce.date()]).optional(),
  sellingPrice: money.optional(),
  listPrice: money.optional(),
  packSize: shortText(40).optional(),
  easyReturn: z.boolean().optional(),
  deliveryModes: z.array(z.enum(FULFILLMENT_MODES)).min(1).optional(),
  wholesale: wholesaleSchema.optional(),
  tierPrices: tierPricesSchema.optional(),
};

export const createProductSchema = z.object({
  body: body({
    ...productBodyShape,
    variant: body({ ...variantBodyShape, sku: variantBodyShape.sku.optional() }).optional(),
    initialStock: body({
      warehouseId: objectId,
      qty: z.number().int().min(0).max(1e9),
      lowStockThreshold: z.number().int().min(0).optional(),
    }).optional(),
  }),
});

export const updateProductSchema = z.object({
  params: z.object({ id: objectId }),
  body: body(productBodyShape)
    .partial()
    .extend({
      categoryId: objectId.nullable().optional(),
      brandId: objectId.nullable().optional(),
      /** Warehouse for an `availableQty` change (default warehouse when omitted). */
      warehouseId: objectId.optional(),
    }),
});

const csvBool = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  if (s === "") return undefined;
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return v;
}, z.boolean().optional());

export const bulkItemSchema = body({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(80),
  sellingPrice: money,
  listPrice: money.optional(),
  description: z.string().max(20000).optional(),
  tags: z.array(shortText(60)).max(30).optional(),
  hsn: z.string().trim().max(12).optional(),
  packSize: shortText(40).optional(),
  categoryId: objectId.optional(),
  brandId: objectId.optional(),
  status: z.enum(["draft", "pending_review", "scheduled", "published"]).optional(),
  publish: csvBool,
  wholesale: wholesaleSchema.optional(),
  tierPrices: tierPricesSchema.optional(),
  availableQty: z.number().int().min(0).max(1e9).optional(),
  warehouseId: objectId.optional(),
  scheduledAt: z.coerce.date().optional(),
  specifications: specificationsSchema.optional(),
});

const queryBool = z.preprocess((v) => (Array.isArray(v) ? v[0] : v), z.enum(["true", "false", "1", "0"]).optional());

/**
 * Query options:
 * - dryRun=true: validate every row (schema, duplicate SKUs in the file, category/brand/warehouse,
 *   publish permission) and report what would happen, writing nothing.
 * - availableQtyMode=set (default) | skip: `availableQty` sets the ABSOLUTE sellable stock of the
 *   product's primary variant via inventory.setAvailableQty (it is not added to current stock);
 *   `skip` ignores the column (catalogue-only import).
 */
export const bulkUploadProductsSchema = z.object({
  query: z
    .object({
      dryRun: queryBool,
      availableQtyMode: z.enum(["set", "skip"]).optional(),
    })
    .passthrough(),
  body: body({
    items: z.array(z.unknown()).min(1).max(1000),
  }),
});

export const createVariantSchema = z.object({
  body: body({ productId: objectId, ...variantBodyShape }),
});

export const updateVariantSchema = z.object({
  params: z.object({ id: objectId }),
  body: body(variantBodyShape).partial(),
});

export const idParamSchema = z.object({
  params: z.object({ id: objectId }),
});

export const mediaUploadSchema = z.object({
  body: z
    .object({
      folder: z.enum(MEDIA_FOLDERS).default("catalog"),
      tags: z.string().max(400).optional(),
    })
    .strict()
    .default({ folder: "catalog" }),
});

export const mediaListSchema = z.object({
  query: z.object({ ...pageQuery, folder: z.enum(MEDIA_FOLDERS).optional() }).passthrough(),
});

export const restockSubscribeSchema = z.object({
  params: z.object({ slug: z.string().trim().min(1).max(120) }),
  body: body({
    email: z.string().trim().email().max(200).optional(),
    variantId: objectId.optional(),
  }).default({}),
});

export const restockConfirmSchema = z.object({
  query: z.object({ token: z.string().regex(/^[a-f\d]{64}$/i, "Invalid token") }).passthrough(),
});

export const reviewCreateSchema = z.object({
  params: z.object({ slug: z.string().trim().min(1).max(120) }),
  body: body({
    rating: z.number().int().min(1).max(5),
    body: z.string().max(1000).optional(),
  }),
});

export const reviewListSchema = z.object({
  params: z.object({ slug: z.string().trim().min(1).max(120) }),
  query: z.object(pageQuery).passthrough(),
});

export const reviewModerateSchema = z.object({
  params: z.object({ reviewId: objectId }),
  body: body({
    status: z.enum(["published", "hidden"]),
    note: z.string().max(500).optional(),
  }),
});

export const reviewIdSchema = z.object({ params: z.object({ reviewId: objectId }) });

export const reviewAdminListSchema = z.object({
  query: z
    .object({
      ...pageQuery,
      status: z.enum(["published", "hidden"]).optional(),
      productId: objectId.optional(),
      userId: objectId.optional(),
      q: z.string().trim().max(100).optional(),
      rating: z
        .string()
        .regex(/^[1-5](,[1-5])*$/, "rating must be 1-5 (comma list allowed)")
        .optional(),
      minRating: z.coerce.number().int().min(1).max(5).optional(),
      maxRating: z.coerce.number().int().min(1).max(5).optional(),
      verified: z.enum(["true", "false"]).optional(),
      sort: z.enum(["createdAt", "updatedAt", "rating", "moderatedAt"]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    })
    .passthrough(),
});

export const productServiceabilitySchema = z.object({
  params: z.object({ slug: z.string().trim().min(1).max(120) }),
  query: z
    .object({
      pincode: z.string().trim().regex(/^\d{6}$/, "Enter a 6-digit PIN code").optional(),
      postalCode: z.string().trim().regex(/^\d{6}$/, "Enter a 6-digit PIN code").optional(),
      latitude: z.coerce.number().min(-90).max(90).optional(),
      longitude: z.coerce.number().min(-180).max(180).optional(),
      approximate: z
        .preprocess((v) => (Array.isArray(v) ? v[0] : v), z.enum(["true", "false", "1", "0"]).optional())
        .transform((v) => v === "true" || v === "1"),
    })
    .passthrough()
    .refine((q) => q.pincode || q.postalCode, { message: "pincode is required", path: ["pincode"] }),
});

export const reviewEligibilitySchema = z.object({
  params: z.object({ slug: z.string().trim().min(1).max(120) }),
});
