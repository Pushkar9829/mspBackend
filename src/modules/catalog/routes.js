import { Router } from "express";
import multer from "multer";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { MAX_UPLOAD_BYTES } from "../../config/constants.js";
import * as service from "./service.js";
import {
  createCategorySchema,
  updateCategorySchema,
  createBrandSchema,
  updateBrandSchema,
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
  idParamSchema,
} from "./validators.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES } });

export const categoryRouter = Router();
categoryRouter.get("/", optionalAuth, asyncHandler(async (req, res) => {
  res.json(await service.listCategories(req.query));
}));
categoryRouter.post(
  "/",
  authenticate,
  authorize("categories.create"),
  validate(createCategorySchema),
  audit("create", "category"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createCategory(req.body));
  })
);
categoryRouter.patch(
  "/:id",
  authenticate,
  authorize("categories.edit"),
  validate(updateCategorySchema),
  audit("update", "category"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateCategory(req.params.id, req.body));
  })
);
categoryRouter.delete(
  "/:id",
  authenticate,
  authorize("categories.delete"),
  validate(idParamSchema),
  audit("delete", "category"),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteCategory(req.params.id));
  })
);

export const brandRouter = Router();
brandRouter.use(authenticate, resolveTenant);
brandRouter.get("/", authorize("brands.view"), asyncHandler(async (req, res) => {
  res.json(await service.listBrands(req));
}));
brandRouter.post(
  "/",
  authorize("brands.create"),
  requireTenant,
  validate(createBrandSchema),
  audit("create", "brand"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createBrand(req, req.body));
  })
);
brandRouter.patch(
  "/:id",
  authorize("brands.edit"),
  validate(updateBrandSchema),
  audit("update", "brand"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateBrand(req, req.params.id, req.body));
  })
);
brandRouter.delete(
  "/:id",
  authorize("brands.delete"),
  validate(idParamSchema),
  audit("delete", "brand"),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteBrand(req, req.params.id));
  })
);

export const productRouter = Router();
productRouter.get(
  "/search",
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(await service.searchCatalog(req));
  })
);
productRouter.get(
  "/lookup",
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(await service.lookupBySlug(req.query.slug, req.query.pack));
  })
);
productRouter.use(authenticate, resolveTenant);
productRouter.get("/", authorize("products.view"), asyncHandler(async (req, res) => {
  const staff = req.permissions.includes("*") || req.permissions.includes("products.edit") || req.permissions.includes("products.create");
  res.json(await service.listProducts(req, { buyer: !staff }));
}));
productRouter.get("/:id", authorize("products.view"), validate(idParamSchema), asyncHandler(async (req, res) => {
  const staff = req.permissions.includes("*") || req.permissions.includes("products.edit") || req.permissions.includes("products.create");
  res.json(await service.getProduct(req, req.params.id, { buyer: !staff }));
}));
productRouter.post(
  "/",
  authorize("products.create"),
  requireTenant,
  validate(createProductSchema),
  audit("create", "product"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createProduct(req, req.body));
  })
);
productRouter.patch(
  "/:id",
  authorize("products.edit"),
  validate(updateProductSchema),
  audit("update", "product"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateProduct(req, req.params.id, req.body));
  })
);
productRouter.post(
  "/:id/publish",
  authorize("products.publish"),
  validate(idParamSchema),
  audit("publish", "product"),
  asyncHandler(async (req, res) => {
    res.json(await service.publishProduct(req, req.params.id));
  })
);
productRouter.delete(
  "/:id",
  authorize("products.delete"),
  validate(idParamSchema),
  audit("delete", "product"),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteProduct(req, req.params.id));
  })
);

export const variantRouter = Router();
variantRouter.use(authenticate, resolveTenant);
variantRouter.get("/", authorize("products.view"), asyncHandler(async (req, res) => {
  res.json(await service.listVariants(req));
}));
variantRouter.post(
  "/",
  authorize("products.create"),
  requireTenant,
  validate(createVariantSchema),
  audit("create", "variant"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createVariant(req, req.body));
  })
);
variantRouter.patch(
  "/:id",
  authorize("products.edit"),
  validate(updateVariantSchema),
  audit("update", "variant"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateVariant(req, req.params.id, req.body));
  })
);
variantRouter.delete(
  "/:id",
  authorize("products.delete"),
  validate(idParamSchema),
  audit("delete", "variant"),
  asyncHandler(async (req, res) => {
    res.json(await service.deleteVariant(req, req.params.id));
  })
);

export const mediaRouter = Router();
mediaRouter.use(authenticate, resolveTenant);
mediaRouter.get("/", asyncHandler(async (req, res) => {
  res.json(await service.listMedia(req));
}));
mediaRouter.post(
  "/",
  upload.single("file"),
  audit("create", "media"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.uploadMedia(req, req.file));
  })
);
