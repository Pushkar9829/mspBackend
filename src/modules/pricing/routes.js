import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant, requireTenant } from "../../middleware/tenantScope.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import {
  createPriceListSchema,
  createOfferSchema,
  createCouponSchema,
  idParamSchema,
} from "./validators.js";

export const pricingRouter = Router();
pricingRouter.use(authenticate, resolveTenant, requireTenant);

pricingRouter.get("/", authorize("pricing.view"), asyncHandler(async (req, res) => {
  res.json(await service.listPriceLists(req));
}));
pricingRouter.post(
  "/",
  authorize("pricing.create"),
  validate(createPriceListSchema),
  audit("create", "priceList"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createPriceList(req, req.body));
  })
);
pricingRouter.patch(
  "/:id",
  authorize("pricing.edit"),
  validate(idParamSchema),
  audit("update", "priceList"),
  asyncHandler(async (req, res) => {
    res.json(await service.updatePriceList(req, req.params.id, req.body));
  })
);
pricingRouter.post(
  "/:id/approve",
  authorize("pricing.approve"),
  validate(idParamSchema),
  audit("approve", "priceList"),
  asyncHandler(async (req, res) => {
    res.json(await service.approvePriceList(req, req.params.id));
  })
);

export const offerRouter = Router();
offerRouter.use(authenticate, resolveTenant, requireTenant);
offerRouter.get("/", authorize("pricing.view"), asyncHandler(async (req, res) => {
  res.json(await service.listOffers(req));
}));
offerRouter.post(
  "/",
  authorize("offers.create"),
  validate(createOfferSchema),
  audit("create", "offer"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createOffer(req, req.body));
  })
);
offerRouter.patch(
  "/:id",
  authorize("offers.edit"),
  validate(idParamSchema),
  audit("update", "offer"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateOffer(req, req.params.id, req.body));
  })
);
offerRouter.post(
  "/:id/approve",
  authorize("pricing.approve"),
  validate(idParamSchema),
  audit("approve", "offer"),
  asyncHandler(async (req, res) => {
    res.json(await service.approveOffer(req, req.params.id));
  })
);

export const couponRouter = Router();
couponRouter.use(authenticate, resolveTenant, requireTenant);
couponRouter.get("/", authorize("pricing.view"), asyncHandler(async (req, res) => {
  res.json(await service.listCoupons(req));
}));
couponRouter.post(
  "/",
  authorize("coupons.create"),
  validate(createCouponSchema),
  audit("create", "coupon"),
  asyncHandler(async (req, res) => {
    res.status(201).json(await service.createCoupon(req, req.body));
  })
);
couponRouter.patch(
  "/:id",
  authorize("coupons.disable"),
  validate(idParamSchema),
  audit("update", "coupon"),
  asyncHandler(async (req, res) => {
    res.json(await service.updateCoupon(req, req.params.id, req.body));
  })
);
couponRouter.post(
  "/:id/disable",
  authorize("coupons.disable"),
  validate(idParamSchema),
  audit("disable", "coupon"),
  asyncHandler(async (req, res) => {
    res.json(await service.disableCoupon(req, req.params.id));
  })
);
