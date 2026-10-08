import { Router } from "express";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import {
  createPageSchema,
  updatePageSchema,
  idSchema,
  adminListSchema,
  publicListSchema,
  publicSlugSchema,
  transitionSchema,
  scheduleSchema,
} from "./validators.js";
import { audit } from "../../middleware/audit.js";

export const cmsPublicRouter = Router();
cmsPublicRouter.get(
  "/pages",
  optionalAuth,
  validate(publicListSchema),
  asyncHandler(async (req, res) => {
    res.json(await service.listPages(req, { publicOnly: true }));
  })
);
cmsPublicRouter.get(
  "/pages/:slug",
  optionalAuth,
  validate(publicSlugSchema),
  asyncHandler(async (req, res) => {
    const { tenantId, tenantSlug, tenant } = req.query;
    res.json(await service.getBySlug(req.params.slug, tenantId || tenantSlug || tenant ? { tenantId, tenantSlug, tenant } : null));
  })
);

export const cmsAdminRouter = Router();
cmsAdminRouter.use(authenticate, resolveTenant);
cmsAdminRouter.get("/", authorize("cms.view"), validate(adminListSchema), asyncHandler(async (req, res) => {
  res.json(await service.listPages(req));
}));
cmsAdminRouter.post("/", audit("create", "cms"), authorize("cms.create"), validate(createPageSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await service.createPage(req, req.body));
}));
cmsAdminRouter.get("/:id", authorize("cms.view"), validate(idSchema), asyncHandler(async (req, res) => {
  res.json(await service.getPage(req, req.params.id));
}));
cmsAdminRouter.get("/:id/versions", authorize("cms.view"), validate(idSchema), asyncHandler(async (req, res) => {
  res.json(await service.listVersions(req, req.params.id));
}));
cmsAdminRouter.patch("/:id", audit("update", "cms"), authorize("cms.edit"), validate(updatePageSchema), asyncHandler(async (req, res) => {
  res.json(await service.updatePage(req, req.params.id, req.body));
}));
cmsAdminRouter.post("/:id/review", audit("review", "cms"), authorize("cms.edit"), validate(transitionSchema), asyncHandler(async (req, res) => {
  res.json(await service.transition(req, req.params.id, "review", req.body));
}));
cmsAdminRouter.post("/:id/publish", audit("publish", "cms"), authorize("cms.publish"), validate(transitionSchema), asyncHandler(async (req, res) => {
  res.json(await service.transition(req, req.params.id, "published", req.body));
}));
cmsAdminRouter.post("/:id/unpublish", audit("unpublish", "cms"), authorize("cms.publish"), validate(transitionSchema), asyncHandler(async (req, res) => {
  res.json(await service.transition(req, req.params.id, "unpublished", req.body));
}));
cmsAdminRouter.post("/:id/draft", audit("draft", "cms"), authorize("cms.edit"), validate(transitionSchema), asyncHandler(async (req, res) => {
  res.json(await service.transition(req, req.params.id, "draft", req.body));
}));
cmsAdminRouter.post("/:id/schedule", audit("schedule", "cms"), authorize("cms.publish"), validate(scheduleSchema), asyncHandler(async (req, res) => {
  res.json(await service.schedulePage(req, req.params.id, req.body));
}));
cmsAdminRouter.delete("/:id", audit("delete", "cms"), authorize("cms.edit"), validate(idSchema), asyncHandler(async (req, res) => {
  res.json(await service.deletePage(req, req.params.id));
}));
