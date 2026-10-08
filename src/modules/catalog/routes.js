import express, { Router } from "express";
import multer from "multer";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import { authorize, authorizeAny } from "../../middleware/authorize.js";
import { resolveTenant, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import * as rateLimits from "../../middleware/rateLimits.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { MAX_UPLOAD_BYTES } from "../../config/constants.js";
import * as service from "./service.js";
import { subscribeRestock, confirmRestock, listMyRestockAlerts, deleteMyRestockAlert } from "./restock.js";
import { z } from "zod";
import * as reviews from "../reviews/service.js";
import {
  createCategorySchema,
  updateCategorySchema,
  createBrandSchema,
  updateBrandSchema,
  createProductSchema,
  updateProductSchema,
  bulkUploadProductsSchema,
  createVariantSchema,
  updateVariantSchema,
  idParamSchema,
  listQuerySchema,
  mediaUploadSchema,
  mediaListSchema,
  restockSubscribeSchema,
  restockConfirmSchema,
  reviewCreateSchema,
  reviewListSchema,
  reviewModerateSchema,
  reviewIdSchema,
  reviewAdminListSchema,
  productServiceabilitySchema,
  reviewEligibilitySchema,
} from "./validators.js";

const passThrough = (_req, _res, next) => next();
/** Use B's limiter when it exists, else no-op (rate limiting is owned by middleware/rateLimits.js). */
const limiter = (...names) => names.map((n) => rateLimits[n]).find((fn) => typeof fn === "function") || passThrough;
const searchLimiter = limiter("searchLimiter");
const restockLimiter = limiter("restockLimiter", "publicWriteLimiter");
const reviewLimiter = limiter("reviewLimiter", "publicWriteLimiter");
const serviceabilityLimiter = limiter("serviceabilityLimiter", "searchLimiter");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const csvText = express.text({ type: ["text/csv", "application/csv", "text/plain"], limit: "2mb" });

/** Accept bulk upload as JSON `{items}`, a raw text/csv body, or multipart `file` (CSV). */
function bulkBodyFromCsv(req, _res, next) {
  try {
    let text = null;
    if (req.file) text = req.file.buffer.toString("utf8");
    else if (typeof req.body === "string") text = req.body;
    if (text != null) req.body = { items: service.csvToBulkItems(text) };
    next();
  } catch (err) {
    next(err);
  }
}

/** Media: dedicated permission; products.create accepted until every role has media.upload. */
const canUseMedia = authorizeAny("media.upload", "products.create");
/** Review moderation: reviews.moderate (products.edit accepted until roles are migrated). */
const canModerate = authorizeAny("reviews.moderate", "products.edit");

export const categoryRouter = Router();
categoryRouter.get("/", optionalAuth, validate(listQuerySchema), asyncHandler(async (req, res) => {
  res.json(await service.listCategories(req));
}));
categoryRouter.post(
  "/",
  authenticate,
  audit("create", "category"),
  authorize("categories.create"),
  validate(createCategorySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createCategory(req, req.body));
  })
);
categoryRouter.patch(
  "/:id",
  authenticate,
  audit("update", "category"),
  authorize("categories.edit"),
  validate(updateCategorySchema),
  asyncHandler(async (req, res) => {
    res.json(await service.updateCategory(req, req.params.id, req.body));
  })
);
categoryRouter.delete(
  "/:id",
  authenticate,
  audit("delete", "category"),
  authorize("categories.delete"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteCategory(req, req.params.id));
  })
);

export const brandRouter = Router();
brandRouter.get("/public", optionalAuth, asyncHandler(async (req, res) => {
  res.json(await service.listPublicBrands());
}));
brandRouter.use(authenticate, resolveTenant);
brandRouter.get("/", authorize("brands.view"), validate(listQuerySchema), asyncHandler(async (req, res) => {
  res.json(await service.listBrands(req));
}));
brandRouter.post(
  "/",
  audit("create", "brand"),
  authorize("brands.create"),
  requireTenant,
  validate(createBrandSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createBrand(req, req.body));
  })
);
brandRouter.patch(
  "/:id",
  audit("update", "brand"),
  authorize("brands.edit"),
  validate(updateBrandSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.updateBrand(req, req.params.id, req.body));
  })
);
brandRouter.delete(
  "/:id",
  audit("delete", "brand"),
  authorize("brands.delete"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteBrand(req, req.params.id));
  })
);

export const productRouter = Router();
productRouter.get(
  "/search",
  searchLimiter,
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(await service.searchCatalog(req));
  })
);
productRouter.get(
  "/lookup",
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(await service.lookupBySlug(req.query.slug, req.query.pack, req));
  })
);
productRouter.get(
  "/restock-alerts/confirm",
  restockLimiter,
  validate(restockConfirmSchema),
  asyncHandler(async (req, res) => {
    res.json(await confirmRestock(req.query.token));
  })
);
const myRestockQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      status: z.enum(["active", "pending_confirmation", "notified"]).optional(),
    })
    .passthrough(),
});
const restockIdSchema = z.object({ params: z.object({ id: z.string().regex(/^[a-f\d]{24}$/i, "Invalid id") }) });

/** The signed-in buyer's back-in-stock alerts (product, variant, status, current stock). */
productRouter.get(
  "/restock-alerts/mine",
  authenticate,
  validate(myRestockQuerySchema),
  asyncHandler(async (req, res) => {
    res.json(await listMyRestockAlerts(req.user, req.validated?.query || req.query));
  })
);
/** Unsubscribe from one of the caller's alerts (404 when it is not theirs). */
productRouter.delete(
  "/restock-alerts/:id",
  authenticate,
  validate(restockIdSchema),
  asyncHandler(async (req, res) => {
    res.json(await deleteMyRestockAlert(req.user, req.params.id));
  })
);
productRouter.post(
  "/:slug/notify-restock",
  restockLimiter,
  optionalAuth,
  validate(restockSubscribeSchema),
  asyncHandler(async (req, res) => {
    const result = await subscribeRestock(req, req.params.slug, req.body);
    res.status(result.subscribed ? 201 : 202).json(result);
  })
);
productRouter.get(
  "/:slug/serviceability",
  serviceabilityLimiter,
  validate(productServiceabilitySchema),
  asyncHandler(async (req, res) => {
    const q = req.validated.query;
    res.json(
      await service.productServiceability(req.params.slug, {
        pincode: q.pincode || q.postalCode,
        latitude: q.latitude,
        longitude: q.longitude,
        approximate: q.approximate,
      })
    );
  })
);
productRouter.get(
  "/:slug/reviews/eligibility",
  optionalAuth,
  validate(reviewEligibilitySchema),
  asyncHandler(async (req, res) => {
    res.json(await reviews.reviewEligibility(req.params.slug, req.user || null));
  })
);
productRouter.get(
  "/:slug/reviews",
  validate(reviewListSchema),
  asyncHandler(async (req, res) => {
    res.json(await reviews.listReviews(req.params.slug, req.query));
  })
);
productRouter.post(
  "/:slug/reviews",
  reviewLimiter,
  authenticate,
  validate(reviewCreateSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await reviews.upsertReview(req.params.slug, req.user, req.body));
  })
);
productRouter.use(authenticate, resolveTenant);
/**
 * Staff (store-scoped admin view) vs buyer (storefront view) is decided by who the caller is, not by
 * edit/create permissions: platform admins, and non-buyer store members (req.tenantId set by
 * resolveTenant). Staff with only products.view therefore still see only their own store.
 */
function isCatalogStaff(req) {
  return Boolean(req.isPlatformAdmin || (!req.isBuyer && req.tenantId));
}
productRouter.get("/", authorize("products.view"), asyncHandler(async (req, res) => {
  const staff = isCatalogStaff(req);
  res.json(await service.listProducts(req, { buyer: !staff }));
}));
productRouter.get(
  "/export",
  authorizeAny("products.create", "products.edit"),
  asyncHandler(async (req, res) => {
    const csv = await service.exportProductsCsv(req);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="products-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  })
);
productRouter.post(
  "/bulk-upload",
  audit("bulk_upload", "product"),
  authorize("products.create"),
  requireTenant,
  csvText,
  csvUpload.single("file"),
  bulkBodyFromCsv,
  validate(bulkUploadProductsSchema),
  asyncHandler(async (req, res) => {
    const dryRun = ["true", "1"].includes(String(req.query.dryRun || ""));
    res.locals.auditMeta = { dryRun, rows: req.body.items.length };
    const result = await service.bulkUploadProducts(req, req.body.items, {
      dryRun,
      availableQtyMode: req.query.availableQtyMode || "set",
    });
    res.status(dryRun ? 200 : 201).json(result);
  })
);
// Review moderation (seller sees its own store's reviews; platform admin sees all).
productRouter.get(
  "/reviews/manage",
  canModerate,
  validate(reviewAdminListSchema),
  asyncHandler(async (req, res) => {
    res.json(await reviews.listReviewsForModeration(req));
  })
);
productRouter.patch(
  "/reviews/:reviewId",
  audit("moderate", "review"),
  canModerate,
  validate(reviewModerateSchema),
  asyncHandler(async (req, res) => {
    res.json(await reviews.moderateReview(req, req.params.reviewId, req.body));
  })
);
productRouter.delete(
  "/reviews/:reviewId",
  audit("delete", "review"),
  canModerate,
  validate(reviewIdSchema),
  asyncHandler(async (req, res) => {
    res.json(await reviews.deleteReview(req, req.params.reviewId));
  })
);
productRouter.get("/:id", authorize("products.view"), validate(idParamSchema), asyncHandler(async (req, res) => {
  const staff = isCatalogStaff(req);
  res.json(await service.getProduct(req, req.params.id, { buyer: !staff }));
}));
productRouter.post(
  "/",
  audit("create", "product"),
  authorize("products.create"),
  requireTenant,
  validate(createProductSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createProduct(req, req.body));
  })
);
productRouter.patch(
  "/:id",
  audit("update", "product"),
  authorize("products.edit"),
  validate(updateProductSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.updateProduct(req, req.params.id, req.body));
  })
);
productRouter.post(
  "/:id/publish",
  audit("publish", "product"),
  authorize("products.publish"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.publishProduct(req, req.params.id));
  })
);
productRouter.delete(
  "/:id",
  audit("delete", "product"),
  authorize("products.delete"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteProduct(req, req.params.id));
  })
);

export const variantRouter = Router();
variantRouter.use(authenticate, resolveTenant);
variantRouter.get("/", authorize("products.view"), validate(listQuerySchema), asyncHandler(async (req, res) => {
  res.json(await service.listVariants(req));
}));
variantRouter.post(
  "/",
  audit("create", "variant"),
  authorize("products.create"),
  requireTenant,
  validate(createVariantSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createVariant(req, req.body));
  })
);
variantRouter.patch(
  "/:id",
  audit("update", "variant"),
  authorize("products.edit"),
  validate(updateVariantSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.updateVariant(req, req.params.id, req.body));
  })
);
variantRouter.delete(
  "/:id",
  audit("delete", "variant"),
  authorize("products.delete"),
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteVariant(req, req.params.id));
  })
);

export const mediaRouter = Router();
mediaRouter.use(authenticate, resolveTenant);
mediaRouter.get("/", canUseMedia, validate(mediaListSchema), asyncHandler(async (req, res) => {
  res.json(await service.listMedia(req));
}));
mediaRouter.post(
  "/",
  audit("create", "media"),
  canUseMedia,
  upload.single("file"),
  validate(mediaUploadSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.uploadMedia(req, req.file, req.body));
  })
);
mediaRouter.delete(
  "/:id",
  audit("delete", "media"),
  canUseMedia,
  validate(idParamSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteMedia(req, req.params.id));
  })
);
