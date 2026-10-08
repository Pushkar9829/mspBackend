import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../middleware/authenticate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { validate } from "../../middleware/validate.js";
import { AppError } from "../../utils/AppError.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { Product } from "../catalog/product.model.js";
import { ProductVariant } from "../catalog/variant.model.js";
import { activeTenantIds } from "../catalog/service.js";
import { applyOffersToVariants, loadActiveOffers, loadBuyerPriceLists } from "../pricing/engine.js";
import { WishlistItem } from "./wishlist.model.js";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const LEGACY_CAP = 100;

const router = Router();
router.use(authenticate);

/** Snapshot built from the DB — never from client input. */
async function buildSnapshot(product, variantId) {
  const variants = await ProductVariant.find({ productId: product._id, status: "active" }).sort({ createdAt: 1 }).lean();
  const variant = (variantId && variants.find((v) => String(v._id) === String(variantId))) || variants[0] || null;
  return {
    id: product.slug,
    slug: product.slug,
    productId: product._id,
    variantId: variant?._id || null,
    name: product.name,
    image: product.images?.[0] || "",
    sku: variant?.sku || product.sku,
    price: variant?.sellingPrice ?? null,
    listPrice: variant?.listPrice ?? null,
    packSize: variant?.attributes?.packSize || "",
  };
}

/**
 * Rebuild current data for listed rows (prices/availability may have changed since saving).
 * Prices are the buyer's effective prices, exactly as search and the product page show them:
 * the buyer's customer price list (else the store's default list), then the best live offer.
 * `catalogPrice` is the variant's catalogue selling price before those.
 */
async function present(rows, buyerId) {
  const productIds = rows.map((r) => r.productId).filter(Boolean);
  const [allProducts, variants, activeIds] = await Promise.all([
    Product.find({ _id: { $in: productIds } }).select("tenantId categoryId wholesale name slug sku images status enabled").lean(),
    ProductVariant.find({ productId: { $in: productIds }, status: "active" }).sort({ createdAt: 1 }).lean(),
    activeTenantIds(),
  ]);
  // Storefront visibility: only published, enabled products of an active store are shown live;
  // anything else falls back to the saved snapshot and is marked unavailable.
  const activeSet = new Set(activeIds.map(String));
  const products = allProducts.filter(
    (p) => p.status === "published" && p.enabled !== false && activeSet.has(String(p.tenantId))
  );
  const tenantIds = products.map((p) => p.tenantId);
  const [offers, priceLists] = await Promise.all([loadActiveOffers(tenantIds), loadBuyerPriceLists(tenantIds, buyerId)]);
  const productBy = new Map(products.map((p) => [String(p._id), p]));
  const variantsBy = new Map();
  for (const v of variants) {
    const key = String(v.productId);
    if (!variantsBy.has(key)) variantsBy.set(key, []);
    variantsBy.get(key).push(v);
  }
  const priced = new Map();
  for (const p of products) {
    const list = variantsBy.get(String(p._id)) || [];
    priced.set(String(p._id), applyOffersToVariants(list, offers, p, buyerId, priceLists.get(String(p.tenantId)) || []));
  }
  return rows.map((row) => {
    const p = row.productId ? productBy.get(String(row.productId)) : null;
    const vs = p ? priced.get(String(p._id)) || [] : [];
    const v = (row.variantId && vs.find((x) => String(x._id) === String(row.variantId))) || vs[0] || null;
    const snap = row.snapshot || {};
    const listPrice = v?.listPrice ?? null;
    const price = v?.sellingPrice ?? null;
    return {
      id: p?.slug || row.slug,
      slug: p?.slug || row.slug,
      productId: row.productId,
      variantId: v?._id || row.variantId || null,
      tenantId: p?.tenantId || null,
      name: p?.name ?? snap.name ?? "",
      image: p?.images?.[0] ?? snap.image ?? "",
      sku: v?.sku || p?.sku || snap.sku || "",
      price,
      listPrice,
      catalogPrice: v?.catalogSellingPrice ?? null,
      discountPct: listPrice > 0 && price != null ? Math.max(0, Math.round(((listPrice - price) / listPrice) * 100)) : 0,
      offer: v?.offer || null,
      unitPricePerBaseUnit: v?.unitPricePerBaseUnit || null,
      packSize: v?.attributes?.packSize || snap.packSize || "",
      available: Boolean(p && p.status === "published" && p.enabled !== false && v),
      savedAt: row.updatedAt,
    };
  });
}

router.get(
  "/",
  validate(
    z.object({
      query: z
        .object({
          page: z.coerce.number().int().min(1).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .passthrough(),
    })
  ),
  asyncHandler(async (req, res) => {
    const filter = { userId: req.user._id };
    const paged = req.query.page != null || req.query.limit != null;
    if (!paged) {
      const rows = await WishlistItem.find(filter).sort({ updatedAt: -1 }).limit(LEGACY_CAP).lean();
      res.json(await present(rows, req.user._id));
      return;
    }
    const { page, limit, skip } = paginate(req.query);
    const [rows, total] = await Promise.all([
      WishlistItem.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      WishlistItem.countDocuments(filter),
    ]);
    res.json(paginated(await present(rows, req.user._id), total, { page, limit }));
  })
);

router.put(
  "/",
  validate(
    z.object({
      body: z.object({ productId: objectId, variantId: objectId.nullable().optional() }).strict(),
    })
  ),
  asyncHandler(async (req, res) => {
    const product = await Product.findOne({
      _id: req.body.productId,
      status: "published",
      enabled: { $ne: false },
      tenantId: { $in: await activeTenantIds() },
    });
    if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
    let variantId = null;
    if (req.body.variantId) {
      const variant = await ProductVariant.findOne({ _id: req.body.variantId, productId: product._id, status: "active" })
        .select("_id")
        .lean();
      if (!variant) throw new AppError(400, "Variant not found for this product", "VALIDATION_ERROR");
      variantId = variant._id;
    }
    const snapshot = await buildSnapshot(product, variantId);
    const count = await WishlistItem.countDocuments({ userId: req.user._id });
    const filter = { userId: req.user._id, productId: product._id };
    const exists = await WishlistItem.exists(filter);
    if (!exists && count >= 500) throw new AppError(400, "Wishlist is full (500 items)", "LIMIT");
    let result;
    try {
      result = await WishlistItem.updateOne(
        filter,
        { $set: { slug: product.slug, variantId, snapshot } },
        { upsert: true }
      );
    } catch (err) {
      if (err?.code !== 11000) throw err;
      result = await WishlistItem.updateOne(filter, { $set: { slug: product.slug, variantId, snapshot } });
    }
    // Respond with the buyer's effective price (same as GET), not the stored catalogue snapshot.
    const [shown] = await present([{ productId: product._id, variantId, slug: product.slug, snapshot, updatedAt: new Date() }], req.user._id);
    res.status(result.upsertedCount ? 201 : 200).json({ ...snapshot, ...shown, created: Boolean(result.upsertedCount) });
  })
);

router.delete(
  "/:key",
  validate(z.object({ params: z.object({ key: z.string().min(1).max(160) }) })),
  asyncHandler(async (req, res) => {
    const key = req.params.key;
    const filter = /^[a-f\d]{24}$/i.test(key)
      ? { userId: req.user._id, $or: [{ productId: key }, { slug: key.toLowerCase() }] }
      : { userId: req.user._id, slug: key.toLowerCase() };
    const result = await WishlistItem.deleteMany(filter);
    res.json({ id: key, removed: result.deletedCount });
  })
);

export default router;
