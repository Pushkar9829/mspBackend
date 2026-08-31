import { Router } from "express";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

export const cmsPublicRouter = Router();
cmsPublicRouter.get(
  "/pages",
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(await service.listPages(req, { publicOnly: true }));
  })
);
cmsPublicRouter.get(
  "/pages/:slug",
  optionalAuth,
  asyncHandler(async (req, res) => {
    res.json(await service.getBySlug(req.params.slug, req.query.tenantId || null));
  })
);

export const cmsAdminRouter = Router();
cmsAdminRouter.use(authenticate, resolveTenant);
cmsAdminRouter.get("/", authorize("cms.view"), asyncHandler(async (req, res) => {
  res.json(await service.listPages(req));
}));
cmsAdminRouter.post("/", authorize("cms.create"), asyncHandler(async (req, res) => {
  res.status(201).json(await service.createPage(req, req.body));
}));
cmsAdminRouter.patch("/:id", authorize("cms.edit"), asyncHandler(async (req, res) => {
  res.json(await service.updatePage(req, req.params.id, req.body));
}));
cmsAdminRouter.post("/:id/review", authorize("cms.edit"), asyncHandler(async (req, res) => {
  res.json(await service.transition(req, req.params.id, "review"));
}));
cmsAdminRouter.post("/:id/publish", authorize("cms.publish"), asyncHandler(async (req, res) => {
  res.json(await service.transition(req, req.params.id, "published"));
}));
cmsAdminRouter.post("/:id/unpublish", authorize("cms.publish"), asyncHandler(async (req, res) => {
  res.json(await service.transition(req, req.params.id, "unpublished"));
}));
