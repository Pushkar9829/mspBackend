import { Product } from "../catalog/product.model.js";
import { Order } from "../orders/order.model.js";
import { findPublicProduct } from "../catalog/service.js";
import { AppError } from "../../utils/AppError.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { asObjectId, tenantFilter } from "../../middleware/tenantScope.js";
import { Review } from "./review.model.js";
import { User } from "../users/user.model.js";

async function productBySlug(slug) {
  const product = await findPublicProduct(slug);
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  return product;
}

/** Rating summary over ALL published reviews of a product (not just the current page). */
export async function ratingSummary(productId) {
  const rows = await Review.aggregate([
    { $match: { productId: asObjectId(productId), status: "published" } },
    { $group: { _id: { $round: ["$rating", 0] }, n: { $sum: 1 }, sum: { $sum: "$rating" } } },
  ]);
  const buckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let total = 0;
  for (const row of rows) {
    if (buckets[row._id] != null) buckets[row._id] += row.n;
    count += row.n;
    total += row.sum;
  }
  return {
    count,
    rating: count ? Math.round((total / count) * 10) / 10 : 0,
    bars: [5, 4, 3, 2, 1].map((stars) => ({
      stars,
      count: buckets[stars],
      pct: count ? Math.round((buckets[stars] / count) * 100) : 0,
    })),
  };
}

/** Recompute the cached ratingAvg / ratingCount on the product from the reviews collection. */
export async function refreshProductRating(productId) {
  const summary = await ratingSummary(productId);
  await Product.updateOne(
    { _id: productId },
    { $set: { ratingAvg: summary.rating, ratingCount: summary.count } }
  );
  return summary;
}

function serialize(review) {
  return {
    id: review._id,
    authorName: review.authorName || "Buyer",
    rating: review.rating,
    body: review.body,
    verifiedPurchase: Boolean(review.verifiedPurchase),
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

export async function listReviews(slug, query = {}) {
  const product = await productBySlug(slug);
  const { page, limit, skip } = paginate(query);
  const filter = { productId: product._id, status: "published" };
  const [rows, summary] = await Promise.all([
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ratingSummary(product._id),
  ]);
  const meta = paginated([], summary.count, { page, limit }).meta;
  return { summary, reviews: rows.map(serialize), meta };
}

/** The buyer's delivered (not cancelled/refunded) order containing this product, if any. */
async function deliveredOrderFor(userId, productId) {
  return Order.findOne({
    buyerId: userId,
    "items.productId": productId,
    $or: [{ status: "delivered" }, { status: "return_requested", deliveredAt: { $ne: null } }],
  })
    .select("_id")
    .sort({ createdAt: -1 })
    .lean();
}

/**
 * Whether the caller may review this product: { canReview, reason, message, existingReview, orderId }.
 * A verified buyer has a delivered order containing the product (same rule as POST). A buyer who
 * already reviewed can still edit (canReview true, existingReview set).
 * reason: null | "LOGIN_REQUIRED" | "NOT_VERIFIED_BUYER".
 */
export async function reviewEligibility(slug, user) {
  const product = await productBySlug(slug);
  if (!user) {
    return { canReview: false, reason: "LOGIN_REQUIRED", message: "Log in to review this product", existingReview: null, orderId: null };
  }
  const [order, existing] = await Promise.all([
    deliveredOrderFor(user._id, product._id),
    Review.findOne({ productId: product._id, userId: user._id }).lean(),
  ]);
  const existingReview = existing ? { ...serialize(existing), status: existing.status } : null;
  if (!order) {
    return {
      canReview: false,
      reason: "NOT_VERIFIED_BUYER",
      message: "Only buyers who received this product can review it",
      existingReview,
      orderId: null,
    };
  }
  return { canReview: true, reason: null, message: "", existingReview, orderId: order._id };
}

/** Only verified buyers (a delivered order containing the product) may review. One review per buyer. */
export async function upsertReview(slug, user, { rating, body }) {
  const product = await productBySlug(slug);
  const stars = Math.round(Number(rating));
  if (!(stars >= 1 && stars <= 5)) throw new AppError(400, "Choose a rating from 1 to 5", "VALIDATION_ERROR");
  const order = await deliveredOrderFor(user._id, product._id);
  if (!order) {
    throw new AppError(403, "Only buyers who received this product can review it", "NOT_VERIFIED_BUYER");
  }
  let review;
  const filter = { productId: product._id, userId: user._id };
  const update = {
    $set: {
      tenantId: product.tenantId,
      authorName: String(user.name || "Buyer").slice(0, 80),
      rating: stars,
      body: String(body || "").trim().slice(0, 1000),
      verifiedPurchase: true,
      orderId: order._id,
    },
    $setOnInsert: { status: "published" },
  };
  try {
    review = await Review.findOneAndUpdate(filter, update, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    review = await Review.findOneAndUpdate(filter, update, { new: true, runValidators: true });
  }
  await refreshProductRating(product._id);
  return { ...serialize(review), status: review.status };
}

/* ------------------------------------------------------------------ moderation */

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const REVIEW_SORT = { createdAt: "createdAt", updatedAt: "updatedAt", rating: "rating", moderatedAt: "moderatedAt" };

function refSummary(doc, fields) {
  if (!doc || typeof doc !== "object" || !doc._id) return doc ? { id: doc } : null;
  const out = { id: doc._id };
  for (const f of fields) out[f] = doc[f] ?? null;
  return out;
}

/**
 * Moderation queue. Filters: status, productId, userId, rating (1-5 or comma list),
 * minRating/maxRating, verified, q (review text, author name, product name/SKU, buyer name/email).
 * Sort: createdAt (default) | updatedAt | rating | moderatedAt, order asc|desc. Paginated.
 */
export async function listReviewsForModeration(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.productId) filter.productId = asObjectId(req.query.productId);
  if (req.query.userId) filter.userId = asObjectId(req.query.userId);
  if (req.query.rating) {
    const ratings = String(req.query.rating).split(",").map(Number).filter((n) => n >= 1 && n <= 5);
    if (ratings.length) filter.rating = ratings.length > 1 ? { $in: ratings } : ratings[0];
  } else if (req.query.minRating || req.query.maxRating) {
    filter.rating = {};
    if (req.query.minRating) filter.rating.$gte = Number(req.query.minRating);
    if (req.query.maxRating) filter.rating.$lte = Number(req.query.maxRating);
  }
  if (req.query.verified === "true") filter.verifiedPurchase = true;
  if (req.query.verified === "false") filter.verifiedPurchase = { $ne: true };
  const q = String(req.query.q || "").trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q.slice(0, 100)), "i");
    const productScope = req.tenantId ? { tenantId: req.tenantId } : {};
    const [products, users] = await Promise.all([
      Product.find({ ...productScope, $or: [{ name: rx }, { sku: rx }, { slug: rx }] }).select("_id").limit(200).lean(),
      User.find({ $or: [{ name: rx }, { email: rx }] }).select("_id").limit(200).lean(),
    ]);
    filter.$or = [
      { body: rx },
      { authorName: rx },
      { moderationNote: rx },
      ...(products.length ? [{ productId: { $in: products.map((p) => p._id) } }] : []),
      ...(users.length ? [{ userId: { $in: users.map((u) => u._id) } }] : []),
    ];
  }
  const field = REVIEW_SORT[String(req.query.sort || "")] || "createdAt";
  const dir = String(req.query.order || "").toLowerCase() === "asc" ? 1 : -1;
  const [rows, total] = await Promise.all([
    Review.find(filter)
      .populate("productId", "name slug sku")
      .populate("tenantId", "name slug")
      .populate("userId", "name email")
      .populate("moderatedBy", "name email")
      .sort({ [field]: dir, _id: dir })
      .skip(skip)
      .limit(limit)
      .lean(),
    Review.countDocuments(filter),
  ]);
  return paginated(
    rows.map((r) => ({
      ...serialize(r),
      status: r.status,
      tenant: refSummary(r.tenantId, ["name", "slug"]),
      tenantId: r.tenantId?._id || r.tenantId || null,
      buyer: refSummary(r.userId, ["name", "email"]),
      userId: r.userId?._id || r.userId || null,
      product: refSummary(r.productId, ["name", "slug", "sku"]),
      productId: r.productId?._id || r.productId || null,
      orderId: r.orderId || null,
      moderation: {
        status: r.status,
        moderatedAt: r.moderatedAt || null,
        moderatedBy: refSummary(r.moderatedBy, ["name", "email"]),
        note: r.moderationNote || "",
      },
      moderatedAt: r.moderatedAt,
      moderationNote: r.moderationNote,
    })),
    total,
    { page, limit }
  );
}

export async function moderateReview(req, id, { status, note }) {
  const review = await Review.findOneAndUpdate(
    { _id: id, ...tenantFilter(req) },
    {
      $set: {
        status,
        moderatedBy: req.user._id,
        moderatedAt: new Date(),
        ...(note != null ? { moderationNote: note } : {}),
      },
    },
    { new: true }
  );
  if (!review) throw new AppError(404, "Review not found", "NOT_FOUND");
  await refreshProductRating(review.productId);
  return { ...serialize(review), status: review.status };
}

export async function deleteReview(req, id) {
  const review = await Review.findOneAndDelete({ _id: id, ...tenantFilter(req) });
  if (!review) throw new AppError(404, "Review not found", "NOT_FOUND");
  await refreshProductRating(review.productId);
  return { ok: true, id };
}
