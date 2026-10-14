import { PriceList } from "./priceList.model.js";
import { Offer } from "./offer.model.js";
import { Coupon } from "./coupon.model.js";
import { AppError } from "../../utils/AppError.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { emitDomain } from "../../utils/events.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { asObjectId } from "../../middleware/tenantScope.js";
import { assertFeature, assertWithinLimit, isLivePromo } from "../billing/entitlements.js";

/** Statuses that are (or are about to become) live: checked against the plan's limit. */
const GOING_LIVE = new Set(["active", "pending_approval"]);

const PRICING_STATUSES = ["draft", "active", "inactive", "pending_approval"];
const OFFER_STATUSES = [...PRICING_STATUSES, "rejected"];
const COUPON_STATUSES = ["active", "disabled"];

function statusParam(value, allowed) {
  if (value === undefined || value === null || value === "") return null;
  const list = String(value).split(",").map((v) => v.trim()).filter(Boolean);
  const bad = list.find((v) => !allowed.includes(v));
  if (bad) throw new AppError(400, `Invalid status "${bad}". Use one of: ${allowed.join(", ")}`, "VALIDATION_ERROR");
  return list.length === 1 ? list[0] : { $in: list };
}

function isDuplicateKey(err) {
  return err?.code === 11000 || /E11000/.test(String(err?.message || ""));
}

function couponConflict(err) {
  if (isDuplicateKey(err)) return new AppError(409, "Coupon code already exists", "DUPLICATE_COUPON_CODE");
  return err;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scoped(req) {
  if (!req.tenantId && !req.isPlatformAdmin) {
    throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  }
  return tenantFilter(req);
}

function canApprove(req) {
  const perms = req.permissions || [];
  return perms.includes("*") || perms.includes("pricing.approve");
}

/**
 * Offers need PLATFORM approval (QA Q1): store staff never self-activate an offer, even with
 * pricing.approve (that permission still lets a store approve its own price lists).
 */
function canApproveOffer(req) {
  return Boolean(req.isPlatformAdmin) && canApprove(req);
}

/** Whitelist: never tenantId, counters, _id; status handled separately. */
function pick(body = {}, fields) {
  const out = {};
  for (const key of fields) if (body[key] !== undefined) out[key] = body[key];
  return out;
}

const PRICE_LIST_FIELDS = ["name", "customerId", "isDefault", "items"];
const OFFER_FIELDS = ["name", "type", "value", "productIds", "categoryIds", "customerIds", "inventoryCap", "appliesTo", "startsAt", "endsAt"];
const COUPON_FIELDS = [
  "code",
  "visibility",
  "customerIds",
  "description",
  "name",
  "type",
  "value",
  "minCartValue",
  "maxRedemptions",
  "perCustomerLimit",
  "excludedProductIds",
  "appliesTo",
  "firstOrderOnly",
  "startsAt",
  "endsAt",
];

/** Without pricing.approve a request to go live becomes a request for approval. */
function initialStatus(req, requested, fallback, approver = canApprove) {
  const status = requested || fallback;
  if (status === "active" && !approver(req)) return "pending_approval";
  return status;
}

async function listMaybePaged(Model, req, filter, sort) {
  if (req.query?.page || req.query?.limit) {
    const { page, limit, skip } = paginate(req.query);
    const [data, total] = await Promise.all([
      Model.find(filter).sort(sort).skip(skip).limit(limit),
      Model.countDocuments(filter),
    ]);
    return paginated(data, total, { page, limit });
  }
  return Model.find(filter).sort(sort).limit(500);
}

/** GET /pricing: q (name), status (comma list). */
export async function listPriceLists(req) {
  const filter = scoped(req);
  const status = statusParam(req.query?.status, PRICING_STATUSES);
  if (status) filter.status = status;
  if (req.query?.q && String(req.query.q).trim()) {
    filter.name = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 100)), "i");
  }
  return listMaybePaged(PriceList, req, filter, { createdAt: -1 });
}

export async function createPriceList(req, body = {}) {
  const status = initialStatus(req, body.status, "active");
  if (GOING_LIVE.has(status)) await assertWithinLimit(req.tenantId, "priceLists", { req });
  return PriceList.create({
    ...pick(body, PRICE_LIST_FIELDS),
    status,
    tenantId: req.tenantId,
  });
}

export async function updatePriceList(req, id, body = {}) {
  const set = pick(body, PRICE_LIST_FIELDS);
  if (body.status && body.status !== "active") set.status = body.status;
  const current = await PriceList.findOne({ _id: id, ...scoped(req) });
  if (!current) throw new AppError(404, "Price list not found", "NOT_FOUND");
  if (set.status === "pending_approval" && !GOING_LIVE.has(current.status)) {
    await assertWithinLimit(current.tenantId, "priceLists", { req });
  }
  if (current.status === "active" && !canApprove(req) && (set.items || set.customerId !== undefined || set.isDefault !== undefined)) {
    set.status = "pending_approval";
  }
  const doc = await PriceList.findOneAndUpdate({ _id: id, ...scoped(req) }, { $set: set }, { new: true, runValidators: true });
  if (!doc) throw new AppError(404, "Price list not found", "NOT_FOUND");
  return doc;
}

/**
 * GET /offers: q, status (comma list). A platform admin without X-Tenant-Id lists every tenant's
 * offers (optionally narrowed by ?tenantId=); rows carry tenantId populated with { name, slug }.
 */
export async function listOffers(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = scoped(req);
  const status = statusParam(req.query.status, OFFER_STATUSES);
  if (status) filter.status = status;
  if (req.query.q) {
    filter.name = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 100)), "i");
  }
  const [data, total] = await Promise.all([
    Offer.find(filter).populate("tenantId", "name slug").sort({ createdAt: -1 }).skip(skip).limit(limit),
    Offer.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function createOffer(req, body = {}) {
  await assertFeature(req.tenantId, "offers", { req });
  const status = initialStatus(req, body.status, "draft", canApproveOffer);
  if (GOING_LIVE.has(status)) await assertWithinLimit(req.tenantId, "offers", { req });
  const offer = await Offer.create({
    ...pick(body, OFFER_FIELDS),
    status,
    inventoryUsed: 0,
    tenantId: req.tenantId,
  });
  if (offer.status === "active") {
    emitDomain("PRICE_DROP", { tenantId: req.tenantId, offerId: offer._id, name: offer.name });
  }
  return offer;
}

export async function updateOffer(req, id, body = {}) {
  const set = pick(body, OFFER_FIELDS);
  if (body.status && body.status !== "active") set.status = body.status;
  const current = await Offer.findOne({ _id: id, ...scoped(req) });
  if (!current) throw new AppError(404, "Offer not found", "NOT_FOUND");
  // Plan limit: re-opening an ended active offer (new end date) or asking to approve one.
  const reopens = set.endsAt !== undefined && current.status === "active" && !isLivePromo(current) && isLivePromo({ status: "active", endsAt: set.endsAt });
  const requests = set.status === "pending_approval" && !GOING_LIVE.has(current.status);
  if (reopens || requests) await assertWithinLimit(current.tenantId, "offers", { req });
  const touchesPrice = ["type", "value", "productIds", "categoryIds", "customerIds", "appliesTo"].some((k) => set[k] !== undefined);
  if (current.status === "active" && !canApproveOffer(req) && touchesPrice) set.status = "pending_approval";
  // Resubmitting a rejected offer clears the old decision.
  if (set.status === "pending_approval") Object.assign(set, { rejectionReason: "", rejectedAt: null, rejectedBy: null });
  const doc = await Offer.findOneAndUpdate({ _id: id, ...scoped(req) }, { $set: set }, { new: true, runValidators: true });
  if (!doc) throw new AppError(404, "Offer not found", "NOT_FOUND");
  return doc;
}

export async function listCoupons(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = scoped(req);
  const status = statusParam(req.query.status, COUPON_STATUSES);
  if (status) filter.status = status;
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 100)), "i");
    filter.$or = [{ code: rx }, { name: rx }];
  }
  const [data, total] = await Promise.all([
    Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Coupon.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function createCoupon(req, body = {}) {
  await assertFeature(req.tenantId, "coupons", { req });
  if (isLivePromo({ status: "active", endsAt: body.endsAt ?? null })) {
    await assertWithinLimit(req.tenantId, "coupons", { req });
  }
  let coupon;
  try {
    coupon = await Coupon.create({
      ...pick(body, COUPON_FIELDS),
      code: String(body.code).toUpperCase(),
      redemptionCount: 0,
      status: "active",
      tenantId: req.tenantId,
    });
  } catch (err) {
    throw couponConflict(err);
  }
  emitDomain("COUPON_CREATED", { tenantId: req.tenantId, couponId: coupon._id, code: coupon.code });
  return coupon;
}

export async function updateCoupon(req, id, body = {}) {
  const set = pick(body, COUPON_FIELDS);
  if (set.code) set.code = String(set.code).toUpperCase();
  if (set.endsAt !== undefined) {
    // Extending an expired active coupon makes it live again: counts against the plan's limit.
    const current = await Coupon.findOne({ _id: id, ...scoped(req) }).select("tenantId status endsAt").lean();
    if (current && current.status === "active" && !isLivePromo(current) && isLivePromo({ status: "active", endsAt: set.endsAt })) {
      await assertWithinLimit(current.tenantId, "coupons", { req });
    }
  }
  let doc;
  try {
    doc = await Coupon.findOneAndUpdate({ _id: id, ...scoped(req) }, { $set: set }, {
      new: true,
      runValidators: true,
    });
  } catch (err) {
    throw couponConflict(err);
  }
  if (!doc) throw new AppError(404, "Coupon not found", "NOT_FOUND");
  return doc;
}

/** Re-enable a disabled coupon. Expired coupons stay enabled-but-expired (dates are not changed). */
export async function enableCoupon(req, id) {
  const current = await Coupon.findOne({ _id: id, ...scoped(req) }).select("tenantId status endsAt").lean();
  if (current && current.status !== "active" && isLivePromo({ ...current, status: "active" })) {
    await assertWithinLimit(current.tenantId, "coupons", { req });
  }
  const doc = await Coupon.findOneAndUpdate({ _id: id, ...scoped(req) }, { $set: { status: "active" } }, { new: true });
  if (!doc) throw new AppError(404, "Coupon not found", "NOT_FOUND");
  emitDomain("COUPON_ENABLED", { tenantId: doc.tenantId, couponId: doc._id, code: doc.code });
  return doc;
}

export async function disableCoupon(req, id) {
  const doc = await Coupon.findOneAndUpdate({ _id: id, ...scoped(req) }, { $set: { status: "disabled" } }, { new: true });
  if (!doc) throw new AppError(404, "Coupon not found", "NOT_FOUND");
  return doc;
}

export async function approvePriceList(req, id) {
  const current = await PriceList.findOne({ _id: id, ...scoped(req), status: { $in: ["pending_approval", "draft"] } }).select("tenantId").lean();
  if (current) await assertWithinLimit(current.tenantId, "priceLists", { req });
  const doc = await PriceList.findOneAndUpdate(
    { _id: id, ...scoped(req), status: { $in: ["pending_approval", "draft"] } },
    { $set: { status: "active" } },
    { new: true }
  );
  if (!doc) throw new AppError(404, "Price list not pending approval", "NOT_FOUND");
  emitDomain("PRICE_APPROVED", { tenantId: req.tenantId, resource: "priceList", resourceId: doc._id });
  return doc;
}

/**
 * Approve an offer. Staff: own tenant only. Platform admin: any tenant; the tenant comes from the
 * offer document (X-Tenant-Id optional; when given it must match).
 */
export async function approveOffer(req, id) {
  const offerId = asObjectId(id);
  if (!offerId) throw new AppError(400, "Invalid id", "INVALID_ID");
  const pending = await Offer.findOne({ _id: offerId, ...scoped(req), status: { $in: ["pending_approval", "draft"] } }).select("tenantId endsAt").lean();
  if (pending && isLivePromo({ status: "active", endsAt: pending.endsAt })) {
    await assertWithinLimit(pending.tenantId, "offers", { req });
  }
  const doc = await Offer.findOneAndUpdate(
    { _id: offerId, ...scoped(req), status: { $in: ["pending_approval", "draft"] } },
    { $set: { status: "active", rejectionReason: "", rejectedAt: null, rejectedBy: null } },
    { new: true }
  );
  if (!doc) {
    const exists = await Offer.findOne({ _id: offerId, ...scoped(req) }).select("status").lean();
    if (!exists) throw new AppError(404, "Offer not found", "NOT_FOUND");
    throw new AppError(409, `Offer is ${exists.status}, not awaiting approval`, "INVALID_STATE");
  }
  const tenantId = doc.tenantId;
  emitDomain("PRICE_APPROVED", { tenantId, resource: "offer", resourceId: doc._id, name: doc.name });
  emitDomain("PRICE_DROP", { tenantId, offerId: doc._id, name: doc.name });
  return doc.populate("tenantId", "name slug");
}

/**
 * Reject an offer awaiting approval (platform admin, pricing.approve; QA R3). The seller sees the
 * status + reason on the offer and gets an OFFER_REJECTED notification (in-app + email). The
 * seller may edit it and request approval again.
 */
export async function rejectOffer(req, id, { reason }) {
  const offerId = asObjectId(id);
  if (!offerId) throw new AppError(400, "Invalid id", "INVALID_ID");
  const text = String(reason || "").trim();
  const doc = await Offer.findOneAndUpdate(
    { _id: offerId, ...scoped(req), status: { $in: ["pending_approval", "draft"] } },
    { $set: { status: "rejected", rejectionReason: text, rejectedAt: new Date(), rejectedBy: req.user?._id || null } },
    { new: true }
  );
  if (!doc) {
    const exists = await Offer.findOne({ _id: offerId, ...scoped(req) }).select("status").lean();
    if (!exists) throw new AppError(404, "Offer not found", "NOT_FOUND");
    throw new AppError(409, `Offer is ${exists.status}, not awaiting approval`, "INVALID_STATE");
  }
  emitDomain("OFFER_REJECTED", { tenantId: doc.tenantId, resource: "offer", resourceId: doc._id, offerId: doc._id, name: doc.name, reason: text });
  return doc.populate("tenantId", "name slug");
}
