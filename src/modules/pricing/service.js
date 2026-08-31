import { PriceList } from "./priceList.model.js";
import { Offer } from "./offer.model.js";
import { Coupon } from "./coupon.model.js";
import { AppError } from "../../utils/AppError.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { emitDomain } from "../../utils/events.js";

function scoped(req) {
  if (!req.tenantId && !req.isPlatformAdmin) {
    throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  }
  return tenantFilter(req);
}

export async function listPriceLists(req) {
  return PriceList.find(scoped(req)).sort({ createdAt: -1 });
}

export async function createPriceList(req, body) {
  return PriceList.create({ ...body, tenantId: req.tenantId });
}

export async function updatePriceList(req, id, body) {
  const doc = await PriceList.findOneAndUpdate({ _id: id, ...scoped(req) }, body, {
    new: true,
    runValidators: true,
  });
  if (!doc) throw new AppError(404, "Price list not found", "NOT_FOUND");
  return doc;
}

export async function listOffers(req) {
  return Offer.find(scoped(req)).sort({ createdAt: -1 });
}

export async function createOffer(req, body) {
  const offer = await Offer.create({ ...body, tenantId: req.tenantId });
  emitDomain("PRICE_DROP", { tenantId: req.tenantId, offerId: offer._id, name: offer.name });
  return offer;
}

export async function updateOffer(req, id, body) {
  const doc = await Offer.findOneAndUpdate({ _id: id, ...scoped(req) }, body, {
    new: true,
    runValidators: true,
  });
  if (!doc) throw new AppError(404, "Offer not found", "NOT_FOUND");
  return doc;
}

export async function listCoupons(req) {
  return Coupon.find(scoped(req)).sort({ createdAt: -1 });
}

export async function createCoupon(req, body) {
  const coupon = await Coupon.create({
    ...body,
    code: String(body.code).toUpperCase(),
    tenantId: req.tenantId,
  });
  emitDomain("COUPON_CREATED", { tenantId: req.tenantId, couponId: coupon._id, code: coupon.code });
  return coupon;
}

export async function updateCoupon(req, id, body) {
  if (body.code) body.code = String(body.code).toUpperCase();
  const doc = await Coupon.findOneAndUpdate({ _id: id, ...scoped(req) }, body, {
    new: true,
    runValidators: true,
  });
  if (!doc) throw new AppError(404, "Coupon not found", "NOT_FOUND");
  return doc;
}

export async function disableCoupon(req, id) {
  return updateCoupon(req, id, { status: "disabled" });
}

export async function approvePriceList(req, id) {
  const doc = await PriceList.findOneAndUpdate(
    { _id: id, ...scoped(req), status: "pending_approval" },
    { status: "active" },
    { new: true }
  );
  if (!doc) throw new AppError(404, "Price list not pending approval", "NOT_FOUND");
  emitDomain("PRICE_APPROVED", { tenantId: req.tenantId, resource: "priceList", resourceId: doc._id });
  return doc;
}

export async function approveOffer(req, id) {
  const doc = await Offer.findOneAndUpdate(
    { _id: id, ...scoped(req), status: "pending_approval" },
    { status: "active" },
    { new: true }
  );
  if (!doc) throw new AppError(404, "Offer not pending approval", "NOT_FOUND");
  emitDomain("PRICE_APPROVED", { tenantId: req.tenantId, resource: "offer", resourceId: doc._id, name: doc.name });
  return doc;
}
