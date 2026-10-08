import mongoose from "mongoose";
import { Category } from "./category.model.js";
import { Brand } from "./brand.model.js";
import { Product } from "./product.model.js";
import { ProductVariant } from "./variant.model.js";
import { Media } from "./media.model.js";
import { RestockAlert } from "./restockAlert.model.js";
import { Inventory } from "../inventory/inventory.model.js";
import { Warehouse } from "../inventory/warehouse.model.js";
import * as inventoryService from "../inventory/service.js";
import { Tenant } from "../tenants/tenant.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { asObjectId, tenantFilter } from "../../middleware/tenantScope.js";
import { storage } from "../../utils/storage.js";
import { checkServiceability, etaWindow, serviceableTenantIds } from "../location/service.js";
import { getCommerceSettings, deliveryInfo, pickPartner } from "../settings/commerce.js";
import { getCachedSetting } from "../settings/service.js";
import { emitDomain } from "../../utils/events.js";
import { bulkItemSchema } from "./validators.js";
import { parseCsv, toCsv } from "./csv.js";
import { alternateSearch, FEW_RESULTS } from "../search/fuzzy.js";
import {
  applyOffersToVariants,
  loadActiveOffers,
  loadBuyerPriceLists,
  matchingOffers,
  serializeOffer,
  qtyRules,
  isBulkProduct,
  packOf,
} from "../pricing/engine.js";

const MAX_Q = 80;
/** Unpaginated list endpoints (legacy array responses) are capped at this many rows. */
const LEGACY_LIST_CAP = 500;
const IN_MEMORY_CAP = 1000;
export const STOREFRONT_TENANT_STATUSES = ["active", "trial"];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function staffTenantId(req) {
  if (req.isPlatformAdmin) return req.tenantId || null;
  return asObjectId(req.user?.tenantId);
}

export function hasPermission(req, perm) {
  const perms = req?.permissions || [];
  return Boolean(req?.isPlatformAdmin || perms.includes("*") || perms.includes(perm));
}

/** Lists return `{data, meta}` when the caller asks for a page; otherwise the legacy capped array. */
function wantsPage(req) {
  const q = req.query || {};
  return q.page != null || q.limit != null;
}

async function listWithOptionalPaging(req, model, filter, sort) {
  if (!wantsPage(req)) return model.find(filter).sort(sort).limit(LEGACY_LIST_CAP);
  const { page, limit, skip } = paginate(req.query);
  const [data, total] = await Promise.all([
    model.find(filter).sort(sort).skip(skip).limit(limit),
    model.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

/* ------------------------------------------------------------------ inventory adapter */

let inventoryOverride = null;
/** Test hook: replace the inventory service (setAvailableQty / deleteVariantInventory). */
export function __setInventoryApiForTests(api) {
  inventoryOverride = api;
}
function inventoryApi() {
  return inventoryOverride || inventoryService;
}

/* ------------------------------------------------------------------ storefront tenant scope */

const ACTIVE_TTL_MS = 30 * 1000;
let activeCache = { at: 0, ids: null, promise: null };

/** Ids of tenants whose products may appear on the storefront (cached ~30s). */
export async function activeTenantIds() {
  if (activeCache.ids && Date.now() - activeCache.at < ACTIVE_TTL_MS) return activeCache.ids;
  if (!activeCache.promise) {
    activeCache.promise = Tenant.find({ status: { $in: STOREFRONT_TENANT_STATUSES } })
      .distinct("_id")
      .then((ids) => {
        activeCache = { at: Date.now(), ids, promise: null };
        return ids;
      })
      .catch((err) => {
        activeCache.promise = null;
        throw err;
      });
  }
  return activeCache.promise;
}

/** Call after a tenant's status changes (B: tenants service may call this; cache expires anyway). */
export function invalidateActiveTenants() {
  activeCache = { at: 0, ids: null, promise: null };
}

async function storefrontTenantScope(requestedTenantId) {
  const ids = await activeTenantIds();
  if (requestedTenantId == null || requestedTenantId === "") return { $in: ids };
  const wanted = asObjectId(requestedTenantId);
  if (!wanted || !ids.some((id) => String(id) === String(wanted))) return { $in: [] };
  return wanted;
}

/* ------------------------------------------------------------------ search helpers */

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalise a user-supplied search string: first value, trimmed, control chars removed, capped. */
export function normalizeQ(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || typeof value === "object") return "";
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_Q);
}

/** Text-index query for >= 3 chars, otherwise an anchored, escaped prefix regex. */
function textClause(q) {
  const cleaned = q.replace(/["\\]/g, " ").replace(/(^|\s)-+/g, "$1").trim();
  if (cleaned.length >= 3) return { $text: { $search: cleaned } };
  const rx = new RegExp(`^${escapeRegex(q)}`, "i");
  return { $or: [{ name: rx }, { sku: new RegExp(`^${escapeRegex(q.toUpperCase())}`) }, { tags: rx }] };
}

function regexClause(q) {
  const rx = new RegExp(escapeRegex(q), "i");
  return { $or: [{ name: rx }, { sku: rx }, { tags: rx }] };
}

/* ------------------------------------------------------------------ slugs + migrations */

/**
 * Backfill `slug` for products that don't have one, and migrate legacy wishlist rows
 * (keyed by lower-cased SKU) to productId + slug. Idempotent and safe to run on every boot /
 * on several instances at once (each write is conditional on the slug still being missing).
 */
export async function ensureProductSlugs({ log = console } = {}) {
  const { buildProductSlug } = await import("./product.model.js");
  let slugged = 0;
  const cursor = Product.find({ $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] })
    .select("_id name")
    .lean()
    .cursor();
  for await (const p of cursor) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const res = await Product.updateOne(
          { _id: p._id, $or: [{ slug: { $exists: false } }, { slug: null }, { slug: "" }] },
          { $set: { slug: buildProductSlug(p.name) } }
        );
        slugged += res.modifiedCount;
        break;
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
    }
  }

  const { WishlistItem } = await import("../wishlist/wishlist.model.js");
  let wishlistMigrated = 0;
  let wishlistOrphans = 0;
  const legacy = WishlistItem.find({ $or: [{ productId: null }, { productId: { $exists: false } }] }).cursor();
  for await (const row of legacy) {
    const product = await findPublicProduct(row.slug, { includeUnpublished: true });
    if (!product) {
      wishlistOrphans += 1;
      continue;
    }
    try {
      await WishlistItem.updateOne({ _id: row._id }, { $set: { productId: product._id, slug: product.slug } });
      wishlistMigrated += 1;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      await WishlistItem.deleteOne({ _id: row._id }); // same product already saved under its new key
    }
  }
  if (slugged || wishlistMigrated || wishlistOrphans) {
    log?.info?.(`[catalog] slugs backfilled=${slugged} wishlist migrated=${wishlistMigrated} unresolved=${wishlistOrphans}`);
  }
  return { slugged, wishlistMigrated, wishlistOrphans };
}

/**
 * Resolve a storefront product by public slug, falling back to the legacy SKU only when exactly
 * one published product (of an active store) has that SKU.
 */
export async function findPublicProduct(slugOrSku, { populate = false, includeUnpublished = false } = {}) {
  const raw = String(slugOrSku || "").trim();
  if (!raw || raw.length > 120) return null;
  const base = includeUnpublished
    ? {}
    : { status: "published", enabled: { $ne: false }, tenantId: { $in: await activeTenantIds() } };
  const withPopulate = (query) =>
    populate ? query.populate("categoryId", "name slug").populate("brandId", "name slug") : query;

  const bySlug = await withPopulate(Product.findOne({ ...base, slug: raw.toLowerCase() }));
  if (bySlug) return bySlug;
  const matches = await Product.find({ ...base, sku: raw.toUpperCase() }).select("_id").limit(2).lean();
  if (matches.length !== 1) return null;
  return withPopulate(Product.findById(matches[0]._id));
}

/* ------------------------------------------------------------------ categories */

/**
 * Shared categories plus the caller's own: a store sees its categories, a buyer browsing a store
 * sees that store's, and the open shop sees store categories that have something published.
 */
export async function listCategories(req) {
  const query = req.query || {};
  const filter = {};
  if (query.parentId === "null") filter.parentId = null;
  else if (query.parentId) filter.parentId = asObjectId(query.parentId);
  if (query.status === "active" || query.status === "inactive") filter.status = query.status;

  const isStaff = req.isPlatformAdmin || (req.permissions || []).includes("categories.create");
  const ownTenant = req.user && isStaff ? staffTenantId(req) : null;
  if (query.scope === "platform") {
    filter.tenantId = null;
  } else if (req.isPlatformAdmin && !ownTenant && query.scope === "all") {
    // every category
  } else if (ownTenant) {
    filter.tenantId = { $in: [null, ownTenant] };
  } else if (asObjectId(query.tenantId)) {
    filter.tenantId = { $in: [null, asObjectId(query.tenantId)] };
  } else {
    const used = await Product.distinct("categoryId", {
      status: "published",
      enabled: { $ne: false },
      tenantId: { $in: await activeTenantIds() },
    });
    filter.$or = [{ tenantId: null }, { _id: { $in: used.filter(Boolean) } }];
  }
  return listWithOptionalPaging(req, Category, filter, { sortOrder: 1, name: 1 });
}

async function uniqueCategorySlug(base, excludeId) {
  let slug = base;
  for (let n = 2; await Category.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }); n += 1) {
    slug = `${base}-${n}`;
  }
  return slug;
}

async function categorySlug(name, tenantId, excludeId) {
  let base = slugify(name);
  if (tenantId) {
    const tenant = await Tenant.findById(tenantId).select("slug").lean();
    if (tenant?.slug) base = `${base}-${tenant.slug}`;
  }
  return uniqueCategorySlug(base || "category", excludeId);
}

/** Stores may only touch their own categories; the platform admin can touch any. */
async function editableCategory(req, id) {
  const cat = await Category.findById(id);
  if (!cat) throw new AppError(404, "Category not found", "NOT_FOUND");
  if (req.isPlatformAdmin) return cat;
  const own = staffTenantId(req);
  if (!cat.tenantId || String(cat.tenantId) !== String(own)) {
    throw new AppError(403, "Shared categories are managed by the platform admin", "FORBIDDEN");
  }
  return cat;
}

/** A product can use a shared category or one of its own store's categories. */
export async function assertCategoryUsable(categoryId, tenantId) {
  if (!categoryId) return;
  const cat = await Category.findById(categoryId).select("tenantId").lean();
  if (!cat) throw new AppError(400, "Category not found", "VALIDATION_ERROR");
  if (cat.tenantId && String(cat.tenantId) !== String(tenantId)) {
    throw new AppError(400, "That category belongs to another store", "VALIDATION_ERROR");
  }
}

async function assertBrandUsable(brandId, tenantId) {
  if (!brandId) return;
  const brand = await Brand.findById(brandId).select("tenantId").lean();
  if (!brand) throw new AppError(400, "Brand not found", "VALIDATION_ERROR");
  if (brand.tenantId && String(brand.tenantId) !== String(tenantId)) {
    throw new AppError(400, "That brand belongs to another store", "VALIDATION_ERROR");
  }
}

export async function createCategory(req, body) {
  const tenantId = staffTenantId(req);
  const parent = body.parentId ? await Category.findById(body.parentId).lean() : null;
  if (body.parentId && !parent) throw new AppError(400, "Parent category not found", "VALIDATION_ERROR");
  if (parent?.tenantId && String(parent.tenantId) !== String(tenantId)) {
    throw new AppError(400, "Parent category belongs to another store", "VALIDATION_ERROR");
  }
  const slug = await categorySlug(body.slug || body.name, tenantId);
  return Category.create({ ...body, tenantId, slug });
}

export async function updateCategory(req, id, body) {
  const cat = await editableCategory(req, id);
  const changes = { ...body };
  if (changes.parentId) {
    if (String(changes.parentId) === String(cat._id)) {
      throw new AppError(400, "A category cannot be its own parent", "VALIDATION_ERROR");
    }
    const parent = await Category.findById(changes.parentId).select("tenantId").lean();
    if (!parent) throw new AppError(400, "Parent category not found", "VALIDATION_ERROR");
    if (parent.tenantId && String(parent.tenantId) !== String(cat.tenantId)) {
      throw new AppError(400, "Parent category belongs to another store", "VALIDATION_ERROR");
    }
  }
  if (changes.slug || changes.name) changes.slug = await categorySlug(changes.slug || changes.name, cat.tenantId, cat._id);
  Object.assign(cat, changes);
  await cat.save();
  return cat;
}

export async function deleteCategory(req, id) {
  await editableCategory(req, id);
  const [inUse, children] = await Promise.all([
    Product.countDocuments({ categoryId: id, status: { $ne: "archived" } }),
    Category.countDocuments({ parentId: id }),
  ]);
  if (inUse) {
    throw new AppError(409, `Used by ${inUse} product${inUse === 1 ? "" : "s"}. Move them to another category first.`, "IN_USE");
  }
  if (children) {
    throw new AppError(409, `Has ${children} sub-categor${children === 1 ? "y" : "ies"}. Delete or move them first.`, "IN_USE");
  }
  const cat = await Category.findByIdAndDelete(id);
  if (!cat) throw new AppError(404, "Category not found", "NOT_FOUND");
  // Archived products must not keep pointing at a deleted category.
  const detached = await Product.updateMany({ categoryId: cat._id }, { $set: { categoryId: null } });
  return { ok: true, id, detachedArchivedProducts: detached.modifiedCount };
}

/* ------------------------------------------------------------------ brands */

export async function listBrands(req) {
  const filter = tenantFilter(req);
  if (req.query?.status === "active" || req.query?.status === "inactive") filter.status = req.query.status;
  return listWithOptionalPaging(req, Brand, filter, { name: 1 });
}

export async function listPublicBrands() {
  const tenants = await activeTenantIds();
  return Brand.aggregate([
    { $match: { status: "active", tenantId: { $in: [null, ...tenants] } } },
    {
      $group: {
        _id: "$slug",
        name: { $first: "$name" },
        slug: { $first: "$slug" },
        logo: { $first: "$logo" },
      },
    },
    { $sort: { name: 1 } },
    { $limit: LEGACY_LIST_CAP },
  ]);
}

export async function createBrand(req, body) {
  const slug = slugify(body.slug || body.name);
  if (!slug) throw new AppError(400, "Brand name must contain letters or digits", "VALIDATION_ERROR");
  return Brand.create({ ...body, slug, tenantId: req.tenantId });
}

export async function updateBrand(req, id, body) {
  const changes = { ...body };
  if (changes.slug) changes.slug = slugify(changes.slug);
  else if (changes.name) changes.slug = slugify(changes.name);
  const brand = await Brand.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, { $set: changes }, {
    new: true,
    runValidators: true,
  });
  if (!brand) throw new AppError(404, "Brand not found", "NOT_FOUND");
  return brand;
}

export async function deleteBrand(req, id) {
  const brand = await Brand.findOne({ _id: id, ...tenantFilter(req) });
  if (!brand) throw new AppError(404, "Brand not found", "NOT_FOUND");
  const inUse = await Product.countDocuments({ brandId: brand._id, status: { $ne: "archived" } });
  if (inUse) {
    throw new AppError(409, `Used by ${inUse} product${inUse === 1 ? "" : "s"}. Change their brand first.`, "IN_USE");
  }
  await Brand.deleteOne({ _id: brand._id });
  const detached = await Product.updateMany({ brandId: brand._id }, { $set: { brandId: null } });
  return { ok: true, id, detachedArchivedProducts: detached.modifiedCount };
}

/* ------------------------------------------------------------------ products */

export async function listProducts(req, { buyer = false } = {}) {
  const { page, limit, skip } = paginate(req.query);
  const filter = buyer ? { status: "published", enabled: { $ne: false } } : tenantFilter(req);
  if (buyer) filter.tenantId = await storefrontTenantScope(req.query.tenantId);
  else if (req.query.tenantId && req.isPlatformAdmin && !req.tenantId) filter.tenantId = asObjectId(req.query.tenantId);
  if (req.query.categoryId) filter.categoryId = asObjectId(req.query.categoryId);
  if (req.query.brandId) filter.brandId = asObjectId(req.query.brandId);
  if (req.query.status && !buyer) filter.status = String(req.query.status);
  else if (!buyer) filter.status = { $ne: "archived" };
  if (req.query.tag) filter.tags = String(req.query.tag);
  if (req.query.bulkEligible === "true" || req.query.bulkEligible === "1") {
    filter["wholesale.bulkEligible"] = true;
  } else if (req.query.bulkEligible === "false" || req.query.bulkEligible === "0") {
    filter["wholesale.bulkEligible"] = { $ne: true };
  }
  const q = normalizeQ(req.query.q);
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { sku: rx }, { tags: rx }, { description: rx }];
  }

  const [rows, total] = await Promise.all([
    Product.find(filter)
      .populate("categoryId", "name slug")
      .populate("brandId", "name slug")
      .populate("tenantId", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Product.countDocuments(filter),
  ]);

  if (buyer) return paginated(rows, total, { page, limit });

  const ids = rows.map((p) => p._id);
  const variants = ids.length
    ? await ProductVariant.find({ productId: { $in: ids }, status: { $ne: "archived" } })
        .sort({ createdAt: 1 })
        .lean()
    : [];
  const variantIds = variants.map((v) => v._id);
  const stocks = variantIds.length
    ? await Inventory.aggregate([
        { $match: { variantId: { $in: variantIds } } },
        {
          $group: {
            _id: "$variantId",
            available: { $sum: "$available" },
            reserved: { $sum: "$reserved" },
          },
        },
      ])
    : [];
  const stockByVariant = new Map(stocks.map((s) => [String(s._id), s]));
  const byProduct = new Map();
  for (const v of variants) {
    const key = String(v.productId);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(v);
  }

  const data = rows.map((p) => {
    const vs = byProduct.get(String(p._id)) || [];
    const available = vs.reduce((sum, v) => sum + (stockByVariant.get(String(v._id))?.available || 0), 0);
    const reserved = vs.reduce((sum, v) => sum + (stockByVariant.get(String(v._id))?.reserved || 0), 0);
    const prices = vs.map((v) => v.sellingPrice).filter((n) => n != null);
    const primary = vs[0] || null;
    return {
      ...p.toObject(),
      variantsCount: vs.length,
      available,
      reserved,
      sellingPrice: prices.length ? Math.min(...prices) : null,
      listPrice: primary?.listPrice ?? null,
      primaryVariantId: primary?._id || null,
      primarySku: primary?.sku || p.sku,
      tierPrices: primary?.tierPrices || [],
    };
  });

  return paginated(data, total, { page, limit });
}

export async function getProduct(req, id, { buyer = false } = {}) {
  const filter = buyer
    ? { _id: id, status: "published", enabled: { $ne: false }, tenantId: { $in: await activeTenantIds() } }
    : { _id: id, ...tenantFilter(req) };
  const product = await Product.findOne(filter)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug");
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  const variants = await ProductVariant.find({
    productId: product._id,
    status: buyer ? "active" : { $ne: "archived" },
  }).sort({ createdAt: 1 });
  return { ...product.toObject(), variants };
}

async function createProductDoc(doc) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await Product.create(doc);
    } catch (err) {
      // Random slug suffix collided — try a fresh one.
      if (err?.code === 11000 && err.keyPattern?.slug && attempt < 4) continue;
      throw err;
    }
  }
}

function assertCanPublish(req, what = "Publishing") {
  if (!hasPermission(req, "products.publish")) {
    throw new AppError(403, `${what} requires the products.publish permission`, "FORBIDDEN");
  }
}

/**
 * Scheduling a publish = publishing later: needs products.publish and a future scheduledAt.
 * Returns the $set fields for a scheduled product ({ status, scheduledAt, scheduledBy }).
 */
function scheduleFields(req, scheduledAt) {
  assertCanPublish(req, "Scheduling a publish");
  const at = scheduledAt ? new Date(scheduledAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw new AppError(400, "scheduledAt is required when status is scheduled", "VALIDATION_ERROR", {
      fields: { scheduledAt: "Required when status is scheduled" },
    });
  }
  if (at.getTime() <= Date.now()) {
    throw new AppError(400, "scheduledAt must be in the future", "VALIDATION_ERROR", {
      fields: { scheduledAt: "Must be in the future" },
    });
  }
  return { status: "scheduled", scheduledAt: at, scheduledBy: req.user?._id || null };
}

/**
 * Default GST rate for a new product without `taxClass.rate`: the store's
 * taxSettings.defaultTaxRate when set (> 0), else the platform setting `platform.defaultTaxRate`.
 */
async function defaultTaxClass(tenantId) {
  const tenant = await Tenant.findById(tenantId).select("taxSettings").lean();
  let rate = Number(tenant?.taxSettings?.defaultTaxRate) || 0;
  if (!rate) {
    const { getSetting } = await import("../settings/service.js");
    rate = Number(await getSetting("platform", null, "platform.defaultTaxRate", 0)) || 0;
  }
  return { name: `GST${rate}`, rate };
}

async function assertWarehouse(warehouseId, tenantId) {
  const ok = await Warehouse.exists({ _id: warehouseId, tenantId });
  if (!ok) throw new AppError(400, "Warehouse not found", "VALIDATION_ERROR");
}

export async function createProduct(req, body) {
  if (!req.tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const { variant, initialStock, sellingPrice, listPrice, packSize, availableQty, tierPrices, status, ...rest } = body;
  const wantsPublish = status === "published";
  if (wantsPublish) assertCanPublish(req);
  const schedule = status === "scheduled" ? scheduleFields(req, rest.scheduledAt) : null;
  if (rest.taxClass?.rate == null) {
    const fallback = await defaultTaxClass(req.tenantId);
    rest.taxClass = { name: rest.taxClass?.name || fallback.name, rate: fallback.rate };
  }
  await assertCategoryUsable(rest.categoryId, req.tenantId);
  await assertBrandUsable(rest.brandId, req.tenantId);
  if (initialStock?.warehouseId) await assertWarehouse(initialStock.warehouseId, req.tenantId);

  const product = await createProductDoc({
    ...rest,
    ...(schedule || {}),
    status: wantsPublish ? "draft" : schedule ? "scheduled" : status || "draft",
    sku: String(rest.sku || "").trim().toUpperCase(),
    tenantId: req.tenantId,
  });

  const variantBody = variant
    ? { ...variant, ...(variant.attributes ? { attributes: createAttributes(variant.attributes) } : {}) }
    : {
        sku: product.sku,
        listPrice: Number(listPrice ?? sellingPrice ?? 0),
        sellingPrice: Number(sellingPrice ?? listPrice ?? 0),
        attributes: { packSize: packSize || "1 pc" },
      };
  if (tierPrices?.length && !variantBody.tierPrices?.length) variantBody.tierPrices = tierPrices;

  let created;
  try {
    created = await ProductVariant.create({
      ...variantBody,
      listPrice: round2(variantBody.listPrice),
      sellingPrice: round2(variantBody.sellingPrice),
      sku: String(variantBody.sku || product.sku).trim().toUpperCase(),
      tenantId: req.tenantId,
      productId: product._id,
    });
  } catch (err) {
    await Product.deleteOne({ _id: product._id }); // don't leave a variant-less product behind
    throw err;
  }

  if (initialStock?.warehouseId) {
    await setVariantAvailable(req, product.tenantId, created._id, Number(initialStock.qty) || 0, initialStock.warehouseId);
    if (initialStock.lowStockThreshold != null) {
      await Inventory.updateOne(
        { tenantId: product.tenantId, warehouseId: initialStock.warehouseId, variantId: created._id },
        { $set: { lowStockThreshold: initialStock.lowStockThreshold } }
      );
    }
  } else if (availableQty != null) {
    await setProductAvailable(req, product, Number(availableQty));
  }

  if (wantsPublish) return publishProduct(req, product._id);
  return product;
}

async function setVariantAvailable(req, tenantId, variantId, qty, warehouseId = null) {
  const fn = inventoryApi().setAvailableQty;
  if (typeof fn !== "function") {
    throw new AppError(503, "Stock updates are unavailable (inventory.setAvailableQty missing)", "NOT_AVAILABLE");
  }
  return fn({
    tenantId,
    variantId,
    warehouseId: warehouseId ? asObjectId(warehouseId) : null,
    qty,
    userId: req?.user?._id || null,
    reason: "adjustment",
  });
}

/** Set sellable stock of the product's primary (oldest live) variant via the inventory service. */
async function setProductAvailable(req, product, qty, warehouseId = null) {
  const primary = await ProductVariant.findOne({ productId: product._id, status: { $ne: "archived" } }).sort({
    createdAt: 1,
  });
  if (!primary) throw new AppError(400, "Product has no variant to stock", "VALIDATION_ERROR");
  if (warehouseId) await assertWarehouse(warehouseId, product.tenantId);
  return setVariantAvailable(req, product.tenantId, primary._id, qty, warehouseId);
}

export async function updateProduct(req, id, body) {
  const { sellingPrice, listPrice, availableQty, tierPrices, packSize, status, warehouseId, ...rest } = body;
  const wantsPublish = status === "published";
  if (wantsPublish) assertCanPublish(req);
  if (status && !wantsPublish) rest.status = status;
  if (rest.sku) rest.sku = String(rest.sku).trim().toUpperCase();

  const current = await Product.findOne({ _id: id, ...tenantFilter(req) }).select("tenantId status scheduledAt").lean();
  if (!current) throw new AppError(404, "Product not found", "NOT_FOUND");
  const staysScheduled = status === "scheduled" || (!status && current.status === "scheduled" && rest.scheduledAt !== undefined);
  if (staysScheduled) {
    if (rest.scheduledAt === null) {
      throw new AppError(400, "scheduledAt is required while the product is scheduled", "VALIDATION_ERROR", {
        fields: { scheduledAt: "Required when status is scheduled" },
      });
    }
    Object.assign(rest, scheduleFields(req, rest.scheduledAt ?? current.scheduledAt));
  } else if (status && status !== "scheduled" && current.status === "scheduled") {
    // Leaving the schedule (draft/review/publish now): drop the pending publish time.
    rest.scheduledAt = null;
    rest.scheduledBy = null;
  }
  if (rest.categoryId) await assertCategoryUsable(rest.categoryId, current.tenantId);
  if (rest.brandId) await assertBrandUsable(rest.brandId, current.tenantId);

  let product = await Product.findOneAndUpdate({ _id: current._id }, { $set: rest }, {
    new: true,
    runValidators: true,
  });
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");

  const live = { productId: product._id, status: { $ne: "archived" } };
  const primary = await ProductVariant.findOne(live).sort({ createdAt: 1 });
  const pricePatch = {};
  if (sellingPrice != null) pricePatch.sellingPrice = round2(sellingPrice);
  if (listPrice != null) pricePatch.listPrice = round2(listPrice);
  if (primary && (Object.keys(pricePatch).length || tierPrices || packSize != null)) {
    Object.assign(primary, pricePatch);
    if (tierPrices) primary.tierPrices = tierPrices;
    if (packSize != null) primary.set("attributes.packSize", packSize);
    await primary.save();
    if (Object.keys(pricePatch).length) {
      await ProductVariant.updateMany({ ...live, _id: { $ne: primary._id } }, { $set: pricePatch });
    }
  } else if (Object.keys(pricePatch).length) {
    await ProductVariant.updateMany(live, { $set: pricePatch });
  }
  if (availableQty != null) await setProductAvailable(req, product, Number(availableQty), warehouseId);
  if (wantsPublish) product = await publishProduct(req, product._id);
  return product;
}

function bulkWholesale(row, existing) {
  const w = row.wholesale || {};
  const base = existing?.wholesale?.toObject?.() || existing?.wholesale || {};
  return {
    ...base,
    bulkEligible: w.bulkEligible ?? base.bulkEligible ?? true,
    moq: w.moq ?? base.moq ?? 1,
    maxQty: w.maxQty !== undefined ? w.maxQty : base.maxQty ?? null,
    packMultiple: w.packMultiple ?? base.packMultiple ?? 1,
    caseQty: w.caseQty ?? base.caseQty ?? 1,
    leadTimeDays: w.leadTimeDays ?? base.leadTimeDays ?? 0,
  };
}

function rowIssues(error) {
  const fields = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "row";
    if (!(key in fields)) fields[key] = issue.message;
  }
  return fields;
}

/**
 * Dry run: validate every row without writing. Reports per row
 * { index, sku, action: "create"|"update"|null, ok, errors: { field: message } }.
 */
async function dryRunBulk(req, items, { availableQtyMode }) {
  const canPublish = hasPermission(req, "products.publish");
  const parsedRows = items.map((raw) => bulkItemSchema.safeParse(raw));
  const skus = parsedRows.filter((r) => r.success).map((r) => r.data.sku.toUpperCase());
  const ids = (key) => [...new Set(parsedRows.filter((r) => r.success && r.data[key]).map((r) => String(r.data[key])))];
  const [existing, categories, brands, warehouses] = await Promise.all([
    skus.length ? Product.find({ tenantId: req.tenantId, sku: { $in: skus } }).select("sku status").lean() : [],
    ids("categoryId").length ? Category.find({ _id: { $in: ids("categoryId") } }).select("_id tenantId status").lean() : [],
    ids("brandId").length ? Brand.find({ _id: { $in: ids("brandId") } }).select("_id tenantId").lean() : [],
    ids("warehouseId").length ? Warehouse.find({ _id: { $in: ids("warehouseId") }, tenantId: req.tenantId }).select("_id").lean() : [],
  ]);
  const existingBySku = new Map(existing.map((p) => [p.sku, p]));
  const catOk = new Set(categories.filter((c) => !c.tenantId || String(c.tenantId) === String(req.tenantId)).map((c) => String(c._id)));
  const brandOk = new Set(brands.filter((b) => !b.tenantId || String(b.tenantId) === String(req.tenantId)).map((b) => String(b._id)));
  const whOk = new Set(warehouses.map((w) => String(w._id)));
  const seen = new Map();
  const rows = parsedRows.map((parsed, index) => {
    const raw = items[index];
    if (!parsed.success) {
      return { index, sku: raw?.sku ?? null, action: null, ok: false, errors: rowIssues(parsed.error) };
    }
    const row = parsed.data;
    const sku = row.sku.toUpperCase();
    const errors = {};
    if (seen.has(sku)) errors.sku = `Duplicate SKU in file (row ${seen.get(sku)})`;
    else seen.set(sku, index);
    const publish = row.publish === true || row.status === "published";
    if ((publish || row.status === "scheduled") && !canPublish) errors.status = "Publishing requires products.publish";
    if (row.status === "scheduled" && (!row.scheduledAt || row.scheduledAt.getTime() <= Date.now())) {
      errors.scheduledAt = "A future scheduledAt is required for scheduled rows";
    }
    if (row.categoryId && !catOk.has(String(row.categoryId))) errors.categoryId = "Category not found";
    if (row.brandId && !brandOk.has(String(row.brandId))) errors.brandId = "Brand not found";
    if (row.warehouseId && !whOk.has(String(row.warehouseId))) errors.warehouseId = "Warehouse not found";
    const current = existingBySku.get(sku);
    const ok = Object.keys(errors).length === 0;
    return {
      index,
      sku,
      action: current ? "update" : "create",
      ok,
      errors,
      stock: row.availableQty != null && availableQtyMode !== "skip" ? { mode: "set", qty: row.availableQty } : null,
    };
  });
  const summary = {
    total: rows.length,
    valid: rows.filter((r) => r.ok).length,
    invalid: rows.filter((r) => !r.ok).length,
    create: rows.filter((r) => r.ok && r.action === "create").length,
    update: rows.filter((r) => r.ok && r.action === "update").length,
  };
  return { dryRun: true, ok: summary.invalid === 0, availableQtyMode, summary, rows };
}

/**
 * Bulk create/update by SKU. `items` are validated row by row so one bad row doesn't sink the file.
 * Options: `dryRun` (validate only, no writes) and `availableQtyMode`:
 *  - "set" (default): `availableQty` SETS the absolute sellable stock of the product's primary
 *    variant through inventory.setAvailableQty (in `warehouseId`, or the default warehouse);
 *  - "skip": the stock column is ignored.
 */
export async function bulkUploadProducts(req, items = [], { dryRun = false, availableQtyMode = "set" } = {}) {
  if (!req.tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const mode = availableQtyMode === "skip" ? "skip" : "set";
  if (dryRun) return dryRunBulk(req, items, { availableQtyMode: mode });
  const created = [];
  const updated = [];
  const errors = [];
  const canPublish = hasPermission(req, "products.publish");

  for (const [index, raw] of items.entries()) {
    const parsed = bulkItemSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push({
        index,
        sku: raw?.sku,
        message: `${issue.path.join(".") || "row"}: ${issue.message}`,
        code: "VALIDATION_ERROR",
        fields: rowIssues(parsed.error),
      });
      continue;
    }
    const row = parsed.data;
    if (mode === "skip") {
      delete row.availableQty;
      delete row.warehouseId;
    }
    try {
      const sku = row.sku.toUpperCase();
      const publish = row.publish === true || row.status === "published";
      if (publish && !canPublish) throw new AppError(403, "Publishing requires products.publish", "FORBIDDEN");
      const status = row.status === "published" ? undefined : row.status;
      const existing = await Product.findOne({ tenantId: req.tenantId, sku });
      const common = {
        name: row.name,
        sellingPrice: row.sellingPrice,
        listPrice: row.listPrice ?? row.sellingPrice,
        ...(row.categoryId ? { categoryId: row.categoryId } : {}),
        ...(row.brandId ? { brandId: row.brandId } : {}),
        ...(row.description != null ? { description: row.description } : {}),
        ...(row.tags ? { tags: row.tags } : {}),
        ...(row.hsn != null ? { hsn: row.hsn } : {}),
        ...(row.packSize ? { packSize: row.packSize } : {}),
        ...(row.tierPrices ? { tierPrices: row.tierPrices } : {}),
        ...(row.specifications ? { specifications: row.specifications } : {}),
        ...(row.scheduledAt ? { scheduledAt: row.scheduledAt } : {}),
        ...(status ? { status } : {}),
        wholesale: bulkWholesale(row, existing),
      };
      if (existing) {
        const next = await updateProduct(req, existing._id, {
          ...common,
          ...(row.availableQty != null ? { availableQty: row.availableQty, warehouseId: row.warehouseId } : {}),
          ...(publish ? { status: "published" } : {}),
        });
        updated.push({ index, id: next._id, sku, slug: next.slug });
      } else {
        const product = await createProduct(req, {
          ...common,
          sku,
          status: publish ? "published" : status || "draft",
          ...(row.availableQty != null
            ? row.warehouseId
              ? { initialStock: { warehouseId: row.warehouseId, qty: row.availableQty } }
              : { availableQty: row.availableQty }
            : {}),
        });
        created.push({ index, id: product._id, sku, slug: product.slug });
      }
    } catch (err) {
      errors.push({
        index,
        sku: row.sku,
        message: err.code === 11000 ? "Duplicate SKU" : err.status && err.status < 500 ? err.message : "Failed",
        code: err.code === 11000 ? "DUPLICATE" : err.code || "ERROR",
        ...(err.extra?.fields ? { fields: err.extra.fields } : {}),
      });
      if (!(err.status && err.status < 500) && err.code !== 11000) console.error("bulk upload row failed", err);
    }
  }

  return { created, updated, errors, ok: errors.length === 0, availableQtyMode: mode };
}

/**
 * Scheduled publishing (called by the scheduled-publish job). Each due product is claimed
 * atomically; the scheduler re-checks that the user who scheduled it is still active and still
 * holds products.publish for that store (and that the store is active). Otherwise the product
 * goes back to draft with `scheduleError` set.
 */
export async function publishScheduledProducts({ batch = 200, now = new Date() } = {}) {
  const [{ User }, { Role }, { effectivePermissions, isPlatformRole }] = await Promise.all([
    import("../users/user.model.js"),
    import("../rbac/role.model.js"),
    import("../../middleware/authenticate.js"),
  ]);
  let published = 0;
  let rejected = 0;
  for (let i = 0; i < batch; i += 1) {
    const claimAt = new Date();
    const product = await Product.findOneAndUpdate(
      {
        status: "scheduled",
        scheduledAt: { $lte: now },
        $or: [{ scheduleClaimedAt: null }, { scheduleClaimedAt: { $lt: new Date(claimAt.getTime() - 10 * 60 * 1000) } }],
      },
      { $set: { scheduleClaimedAt: claimAt } },
      { new: true, sort: { scheduledAt: 1 } }
    ).lean();
    if (!product) break;
    let reason = "";
    if (!product.scheduledBy) reason = "No scheduler recorded";
    else {
      const user = await User.findById(product.scheduledBy).select("status tenantId roleId").lean();
      const role = user ? await Role.findById(user.roleId).lean() : null;
      const tenant = await Tenant.findById(product.tenantId).select("status").lean();
      const perms = role ? effectivePermissions(role) : [];
      const platform = isPlatformRole(role);
      const sameStore = platform || (user?.tenantId && String(user.tenantId) === String(product.tenantId));
      if (!user || user.status !== "active") reason = "The user who scheduled this product is no longer active";
      else if (!sameStore) reason = "The user who scheduled this product no longer belongs to the store";
      else if (!(platform || perms.includes("*") || perms.includes("products.publish"))) {
        reason = "The user who scheduled this product no longer holds products.publish";
      } else if (!tenant || !STOREFRONT_TENANT_STATUSES.includes(tenant.status)) reason = "The store is not active";
    }
    if (reason) {
      await Product.collection.updateOne(
        { _id: product._id, status: "scheduled", scheduleClaimedAt: claimAt },
        { $set: { status: "draft", scheduleError: reason, scheduleClaimedAt: null, updatedAt: new Date() } }
      );
      rejected += 1;
      continue;
    }
    await Product.collection.updateOne(
      { _id: product._id, status: "scheduled", scheduleClaimedAt: claimAt },
      { $set: { status: "published", scheduleError: "", scheduleClaimedAt: null, updatedAt: new Date() } }
    );
    published += 1;
    emitDomain("PRODUCT_PUBLISHED", { tenantId: product.tenantId, productId: product._id, resource: "product", resourceId: product._id, scheduled: true });
  }
  return { published, rejected };
}

/* ------------------------------------------------------------------ CSV import / export */

export const PRODUCT_CSV_COLUMNS = [
  "sku",
  "name",
  "slug",
  "status",
  "sellingPrice",
  "listPrice",
  "packSize",
  "availableQty",
  "warehouseId",
  "categoryId",
  "brandId",
  "hsn",
  "tags",
  "description",
  "publish",
  "bulkEligible",
  "moq",
  "maxQty",
  "packMultiple",
  "caseQty",
  "leadTimeDays",
  "tierPrices",
];

function csvNum(value) {
  const s = String(value ?? "").trim();
  if (s === "") return undefined;
  return Number(s); // NaN is rejected by the zod row schema with a clear message
}
function csvStr(value) {
  const s = String(value ?? "").trim();
  if (s === "") return undefined;
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s; // undo export's formula-injection guard
}
function csvBoolish(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (s === "") return undefined;
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return s; // invalid → zod error
}
/** `10-49@95;50@90` → [{minQty:10,maxQty:49,unitPrice:95},{minQty:50,maxQty:null,unitPrice:90}] */
function csvTiers(value) {
  const s = String(value ?? "").trim();
  if (!s) return undefined;
  return s.split(";").filter(Boolean).map((part) => {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?@\s*([\d.]+)\s*$/.exec(part);
    if (!m) return { minQty: NaN, unitPrice: NaN };
    return { minQty: Number(m[1]), maxQty: m[2] ? Number(m[2]) : null, unitPrice: Number(m[3]) };
  });
}

/** Turn CSV text (header row + data rows) into bulk-upload items. */
export function csvToBulkItems(text) {
  const records = parseCsv(text, { columns: PRODUCT_CSV_COLUMNS });
  if (!records.length) throw new AppError(400, "CSV has no data rows", "VALIDATION_ERROR");
  if (records.length > 1000) throw new AppError(400, "At most 1000 rows per upload", "VALIDATION_ERROR");
  return records.map((r) => {
    const wholesale = {
      bulkEligible: csvBoolish(r.bulkEligible),
      moq: csvNum(r.moq),
      maxQty: csvNum(r.maxQty),
      packMultiple: csvNum(r.packMultiple),
      caseQty: csvNum(r.caseQty),
      leadTimeDays: csvNum(r.leadTimeDays),
    };
    const cleanWholesale = Object.fromEntries(Object.entries(wholesale).filter(([, v]) => v !== undefined));
    const item = {
      name: csvStr(r.name),
      sku: csvStr(r.sku),
      sellingPrice: csvNum(r.sellingPrice),
      listPrice: csvNum(r.listPrice),
      packSize: csvStr(r.packSize),
      availableQty: csvNum(r.availableQty),
      warehouseId: csvStr(r.warehouseId),
      categoryId: csvStr(r.categoryId),
      brandId: csvStr(r.brandId),
      hsn: csvStr(r.hsn),
      description: csvStr(r.description),
      tags: csvStr(r.tags)?.split(";").map((t) => t.trim()).filter(Boolean),
      status: csvStr(r.status),
      publish: csvBoolish(r.publish),
      tierPrices: csvTiers(r.tierPrices),
      wholesale: Object.keys(cleanWholesale).length ? cleanWholesale : undefined,
    };
    return Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined));
  });
}

/**
 * CSV export of the caller's catalogue (same columns the import accepts). Honours the list
 * filters: q (name/SKU/tags/description), categoryId, brandId, status (comma list; default all
 * but archived), tag and bulkEligible.
 */
export async function exportProductsCsv(req) {
  const filter = tenantFilter(req);
  const query = req.query || {};
  if (query.status) {
    const statuses = String(query.status).split(",").map((v) => v.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  } else filter.status = { $ne: "archived" };
  if (query.categoryId) {
    const id = asObjectId(query.categoryId);
    if (!id) throw new AppError(400, "Invalid categoryId", "VALIDATION_ERROR");
    filter.categoryId = id;
  }
  if (query.brandId) {
    const id = asObjectId(query.brandId);
    if (!id) throw new AppError(400, "Invalid brandId", "VALIDATION_ERROR");
    filter.brandId = id;
  }
  if (query.tag) filter.tags = String(query.tag);
  if (query.bulkEligible === "true" || query.bulkEligible === "1") filter["wholesale.bulkEligible"] = true;
  else if (query.bulkEligible === "false" || query.bulkEligible === "0") filter["wholesale.bulkEligible"] = { $ne: true };
  const q = normalizeQ(query.q);
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { sku: rx }, { tags: rx }, { description: rx }];
  }
  const products = await Product.find(filter).sort({ createdAt: 1 }).limit(20000).lean();
  const ids = products.map((p) => p._id);
  const variants = ids.length
    ? await ProductVariant.find({ productId: { $in: ids }, status: { $ne: "archived" } }).sort({ createdAt: 1 }).lean()
    : [];
  const primaryByProduct = new Map();
  for (const v of variants) if (!primaryByProduct.has(String(v.productId))) primaryByProduct.set(String(v.productId), v);
  const primaryIds = [...primaryByProduct.values()].map((v) => v._id);
  const stocks = primaryIds.length
    ? await Inventory.aggregate([
        { $match: { variantId: { $in: primaryIds } } },
        { $group: { _id: "$variantId", available: { $sum: "$available" } } },
      ])
    : [];
  const stockBy = new Map(stocks.map((s) => [String(s._id), s.available]));

  const rows = products.map((p) => {
    const v = primaryByProduct.get(String(p._id));
    const w = p.wholesale || {};
    return {
      sku: p.sku,
      name: p.name,
      slug: p.slug || "",
      status: p.status,
      sellingPrice: v?.sellingPrice ?? "",
      listPrice: v?.listPrice ?? "",
      packSize: v?.attributes?.packSize || "",
      availableQty: v ? stockBy.get(String(v._id)) ?? 0 : "",
      warehouseId: "",
      categoryId: p.categoryId ? String(p.categoryId) : "",
      brandId: p.brandId ? String(p.brandId) : "",
      hsn: p.hsn || "",
      tags: (p.tags || []).join(";"),
      description: p.description || "",
      publish: "",
      bulkEligible: w.bulkEligible ? "true" : "false",
      moq: w.moq ?? "",
      maxQty: w.maxQty ?? "",
      packMultiple: w.packMultiple ?? "",
      caseQty: w.caseQty ?? "",
      leadTimeDays: w.leadTimeDays ?? "",
      tierPrices: (v?.tierPrices || [])
        .map((t) => `${t.minQty}${t.maxQty ? `-${t.maxQty}` : ""}@${t.unitPrice}`)
        .join(";"),
    };
  });
  return toCsv(PRODUCT_CSV_COLUMNS, rows);
}

export async function deleteProduct(req, id) {
  const product = await Product.findOneAndUpdate(
    { _id: id, ...tenantFilter(req) },
    { $set: { status: "archived" } },
    { new: true }
  );
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  return product;
}

/* ------------------------------------------------------------------ variants */

export async function listVariants(req) {
  const filter = tenantFilter(req);
  if (req.query.productId) filter.productId = asObjectId(req.query.productId);
  if (req.query.includeArchived !== "true") filter.status = { $ne: "archived" };
  return listWithOptionalPaging(req, ProductVariant, filter, { sku: 1 });
}

/** Attributes for a new variant: the "clear" markers (`null`) used by updates mean "not set". */
function createAttributes(attrs) {
  const out = { ...attrs };
  for (const key of ["custom", "weight", "dimensions"]) if (out[key] === null) delete out[key];
  return out;
}

/** 409 when `variantId` is the last active variant of a published product (shared by update-to-inactive and delete). */
async function assertNotLastActiveVariant(existing) {
  const product = await Product.findById(existing.productId).select("status").lean();
  if (product?.status !== "published") return;
  const others = await ProductVariant.countDocuments({
    productId: existing.productId,
    _id: { $ne: existing._id },
    status: "active",
  });
  if (!others) {
    throw new AppError(409, "This is the last active variant of a published product. Unpublish or archive the product first.", "IN_USE");
  }
}

export async function createVariant(req, body) {
  const product = await Product.findOne({ _id: body.productId, ...tenantFilter(req) });
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  if (product.status === "archived") throw new AppError(409, "Product is archived", "ARCHIVED");
  const sku = String(body.sku).trim().toUpperCase();
  const clash = await ProductVariant.findOne({ tenantId: product.tenantId, sku }).select("status").lean();
  if (clash) {
    throw new AppError(
      409,
      clash.status === "archived" ? "SKU belongs to an archived variant" : "SKU already exists",
      "DUPLICATE"
    );
  }
  const attributes = body.attributes ? createAttributes(body.attributes) : undefined;
  return ProductVariant.create({
    ...body,
    ...(attributes ? { attributes } : {}),
    sku,
    listPrice: round2(body.listPrice),
    sellingPrice: round2(body.sellingPrice),
    tenantId: product.tenantId,
    productId: product._id,
  });
}

export async function updateVariant(req, id, body) {
  const changes = { ...body };
  if (changes.sku) changes.sku = String(changes.sku).trim().toUpperCase();
  if (changes.listPrice != null) changes.listPrice = round2(changes.listPrice);
  if (changes.sellingPrice != null) changes.sellingPrice = round2(changes.sellingPrice);
  const update = { $set: {} };
  for (const [key, value] of Object.entries(changes)) {
    if (key === "attributes") {
      // Merge attributes field-by-field so a partial update doesn't wipe the others.
      for (const [attr, attrValue] of Object.entries(value || {})) {
        if (["custom", "weight", "dimensions"].includes(attr) && attrValue === null) {
          // `attributes: { custom: {} }` clears every custom attribute; `weight: null` /
          // `dimensions: null` clear those.
          update.$unset = { ...(update.$unset || {}), [`attributes.${attr}`]: "" };
        } else {
          update.$set[`attributes.${attr}`] = attrValue;
        }
      }
    } else {
      update.$set[key] = value;
    }
  }
  if (!Object.keys(update.$set).length) delete update.$set;
  if (changes.status === "inactive") {
    const existing = await ProductVariant.findOne({ _id: id, ...tenantFilter(req), status: { $ne: "archived" } })
      .select("_id productId status")
      .lean();
    if (!existing) throw new AppError(404, "Variant not found", "NOT_FOUND");
    if (existing.status === "active") await assertNotLastActiveVariant(existing);
  }
  const variant = await ProductVariant.findOneAndUpdate(
    { _id: id, ...tenantFilter(req), status: { $ne: "archived" } },
    update,
    { new: true, runValidators: true }
  );
  if (!variant) throw new AppError(404, "Variant not found", "NOT_FOUND");
  if (changes.sku) {
    await inventoryService.syncInventorySku({ tenantId: variant.tenantId, variantId: variant._id, sku: variant.sku });
  }
  return variant;
}

/** Soft delete: archive the variant, zero/archive its inventory and drop pending restock alerts. */
export async function deleteVariant(req, id) {
  const existing = await ProductVariant.findOne({ _id: id, ...tenantFilter(req), status: { $ne: "archived" } });
  if (!existing) throw new AppError(404, "Variant not found", "NOT_FOUND");
  await assertNotLastActiveVariant(existing);
  const variant = await ProductVariant.findOneAndUpdate(
    { _id: existing._id, status: { $ne: "archived" } },
    { $set: { status: "archived", deletedAt: new Date() } },
    { new: true }
  );
  if (!variant) throw new AppError(404, "Variant not found", "NOT_FOUND");
  const fn = inventoryApi().deleteVariantInventory;
  if (typeof fn === "function") {
    await fn({ tenantId: variant.tenantId, variantId: variant._id });
  } else {
    console.warn("[catalog] inventory.deleteVariantInventory missing; inventory for", String(variant._id), "left as-is");
  }
  await RestockAlert.deleteMany({ variantId: variant._id, notifiedAt: null });
  return { ok: true, id, status: "archived" };
}

export async function publishProduct(req, id) {
  const product = await Product.findOneAndUpdate(
    { _id: id, ...tenantFilter(req), status: { $ne: "archived" } },
    { $set: { status: "published" } },
    { new: true }
  );
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  emitDomain("PRODUCT_PUBLISHED", {
    tenantId: product.tenantId,
    productId: product._id,
    resource: "product",
    resourceId: product._id,
  });
  return product;
}

/* ------------------------------------------------------------------ storefront */

function withCatalogOffers(product, variants, offers, buyerId, priceLists = []) {
  const decorated = applyOffersToVariants(variants, offers, product, buyerId, priceLists);
  const liveOffers = matchingOffers(offers, product, buyerId).map(serializeOffer).filter(Boolean);
  return { variants: decorated, offers: liveOffers };
}

/** Stock below or at this many units (when the warehouse row has no threshold) shows as "low". */
export const LOW_STOCK_DEFAULT = 5;

function stockInfo(available = 0, threshold = 0) {
  const qty = Math.max(0, Number(available) || 0);
  const low = Number(threshold) > 0 ? Number(threshold) : LOW_STOCK_DEFAULT;
  const stockStatus = qty <= 0 ? "out" : qty <= low ? "low" : "in_stock";
  return { available: qty, inStock: qty > 0, stockStatus, lowStock: stockStatus === "low", outOfStock: qty <= 0 };
}

/**
 * Sellable stock per variant in ONE aggregation (archived warehouse rows excluded).
 * Map(variantId -> { available, inStock, stockStatus: in_stock|low|out, lowStock, outOfStock }).
 */
export async function variantStockMap(variantIds) {
  const ids = [...new Set((variantIds || []).map(String))].map((id) => new mongoose.Types.ObjectId(id));
  const map = new Map();
  if (!ids.length) return map;
  const rows = await Inventory.aggregate([
    { $match: { variantId: { $in: ids }, archived: { $ne: true } } },
    { $group: { _id: "$variantId", available: { $sum: "$available" }, threshold: { $max: "$lowStockThreshold" } } },
  ]);
  for (const row of rows) map.set(String(row._id), stockInfo(row.available, row.threshold));
  return map;
}

function withStock(variant, stockMap) {
  const plain = variant?.toObject ? variant.toObject() : variant;
  return { ...plain, ...(stockMap.get(String(plain._id)) || stockInfo(0)) };
}

/** Product-level price / stock / discount summary over its (decorated, stocked) variants. */
function productSummary(variants) {
  const prices = variants.map((v) => Number(v.sellingPrice) || 0);
  const cheapest = variants.reduce((best, v) => (!best || v.sellingPrice < best.sellingPrice ? v : best), null);
  const discountPct = variants.reduce((max, v) => {
    const list = Number(v.listPrice) || 0;
    const pct = list > 0 ? Math.round(((list - v.sellingPrice) / list) * 100) : 0;
    return Math.max(max, pct);
  }, 0);
  const available = variants.reduce((sum, v) => sum + (Number(v.available) || 0), 0);
  return {
    price: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    minPrice: prices.length ? Math.min(...prices) : null,
    listPrice: cheapest ? cheapest.listPrice : null,
    unitPricePerBaseUnit: cheapest?.unitPricePerBaseUnit || null,
    discountPct: Math.max(0, discountPct),
    available,
    inStock: available > 0,
    stockStatus: variants.some((v) => v.stockStatus === "in_stock") ? "in_stock" : available > 0 ? "low" : "out",
  };
}

function wholesaleRules(product) {
  const r = qtyRules(product);
  const w = product.wholesale || {};
  return {
    bulkEligible: r.bulkEligible,
    moq: r.moq,
    packMultiple: r.pack,
    maxQty: r.maxQty,
    bulkFrom: r.bulkFrom,
    caseQty: Number(w.caseQty) || 1,
    leadTimeDays: Number(w.leadTimeDays) || 0,
    min: 1,
    step: r.bulkEligible && r.bulkFrom <= 1 ? r.pack : 1,
    max: r.bulkEligible && r.bulkFrom <= 1 ? r.maxQty : null,
    bulk: r.bulk,
  };
}

/** Store rating = review-count weighted average of its published products' cached ratings. */
async function storeRating(tenantId) {
  const [row] = await Product.aggregate([
    { $match: { tenantId: asObjectId(tenantId), status: "published", ratingCount: { $gt: 0 } } },
    { $group: { _id: null, count: { $sum: "$ratingCount" }, sum: { $sum: { $multiply: ["$ratingAvg", "$ratingCount"] } } } },
  ]);
  if (!row?.count) return { rating: null, ratingCount: 0 };
  return { rating: Math.round((row.sum / row.count) * 10) / 10, ratingCount: row.count };
}

export async function lookupBySlug(slug, pack, req) {
  const value = Array.isArray(slug) ? slug[0] : slug;
  if (!value || typeof value !== "string") throw new AppError(400, "slug is required", "VALIDATION_ERROR");
  const product = await findPublicProduct(value, { populate: true });
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  const variants = await ProductVariant.find({ productId: product._id, status: "active" }).sort({ createdAt: 1 });
  if (!variants.length) throw new AppError(404, "Variant not found", "NOT_FOUND");
  const [offers, priceLists, stockMap, seller, rating, commerce] = await Promise.all([
    loadActiveOffers([product.tenantId]),
    loadBuyerPriceLists([product.tenantId], req?.user?._id),
    variantStockMap(variants.map((v) => v._id)),
    Tenant.findById(product.tenantId).select("name slug branding pickupAddress").lean(),
    storeRating(product.tenantId),
    getCommerceSettings(product.tenantId),
  ]);
  const { variants: decorated, offers: liveOffers } = withCatalogOffers(
    product,
    variants,
    offers,
    req?.user?._id,
    priceLists.get(String(product.tenantId)) || []
  );
  const stocked = decorated.map((row) => withStock(row, stockMap));
  let variant = stocked[0];
  if (pack) {
    const wanted = String(Array.isArray(pack) ? pack[0] : pack).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
    variant =
      stocked.find((v) => {
        const size = String(v.attributes?.packSize || v.attributes?.size || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        return size === wanted;
      }) || variant;
  }
  const summary = productSummary(stocked);
  const displayName = seller
    ? String((await getCachedSetting("tenant", seller._id, "store.displayName", "")) || "").trim() || seller.name
    : "";
  const delivery = await deliveryInfo(commerce, product.tenantId);
  const rules = wholesaleRules(product);
  return {
    slug: product.slug,
    product: {
      ...product.toObject(),
      offers: liveOffers,
      ...summary,
      orderLimit: product.wholesale?.maxQty ?? null,
      wholesale: product.wholesale || {},
      rules,
      ratingAvg: product.ratingAvg || 0,
      ratingCount: product.ratingCount || 0,
    },
    variant,
    variants: stocked,
    offers: liveOffers,
    available: summary.available,
    inStock: summary.inStock,
    stockStatus: summary.stockStatus,
    rules,
    store: seller
      ? {
          id: seller._id,
          name: seller.name,
          displayName,
          slug: seller.slug,
          city: seller.pickupAddress?.city || "",
          state: seller.pickupAddress?.state || "",
          logo: seller.branding?.logo || seller.branding?.logoUrl || "",
          rating: rating.rating,
          ratingCount: rating.ratingCount,
        }
      : null,
    returns: {
      enabled: commerce.returnsEnabled,
      easyReturn: Boolean(product.easyReturn),
      returnable: Boolean(commerce.returnsEnabled && product.easyReturn),
      returnWindowDays: commerce.returnWindowDays,
    },
    returnWindowDays: commerce.returnWindowDays,
    delivery: {
      ...delivery,
      deliveryModes: product.deliveryModes?.length ? product.deliveryModes : ["delivery_partner"],
      pickupAvailable: (product.deliveryModes || []).includes("store_pickup"),
      leadTimeDays: rules.bulkEligible ? rules.leadTimeDays : 0,
    },
    pickupAddress: seller?.pickupAddress || null,
  };
}

/**
 * Product page delivery check for one PIN code (public, rate limited). Uses the store's delivery
 * zones (same rules as the cart) and its commerce settings for the fee / free-delivery threshold.
 * Returns { deliverable, reason, reasonCode, pincode, etaDaysMin, etaDaysMax, etaFrom, etaTo,
 * fee, deliveryFee, partnerFee, freeDeliveryAbove, codAvailable, pickupAvailable, inStock, zone }.
 */
export async function productServiceability(slug, { pincode, latitude, longitude, approximate } = {}) {
  const product = await findPublicProduct(slug);
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  const modes = product.deliveryModes?.length ? product.deliveryModes : ["delivery_partner"];
  const variantIds = await ProductVariant.find({ productId: product._id, status: "active" }).distinct("_id");
  const [stockMap, commerce] = await Promise.all([variantStockMap(variantIds), getCommerceSettings(product.tenantId)]);
  const inStock = [...stockMap.values()].some((s) => s.inStock);
  const pickupAvailable = modes.includes("store_pickup");
  const base = {
    pincode,
    inStock,
    pickupAvailable,
    codAvailable: Boolean(commerce.codEnabled),
    freeDeliveryAbove: commerce.freeDeliveryAbove || 0,
    etaDaysMin: null,
    etaDaysMax: null,
    etaFrom: null,
    etaTo: null,
    fee: null,
    deliveryFee: null,
    partnerFee: null,
    zone: null,
  };
  if (!modes.includes("delivery_partner")) {
    return { ...base, deliverable: false, reasonCode: "PICKUP_ONLY", reason: "This product is available for store pickup only" };
  }
  const result = await checkServiceability({ tenantId: product.tenantId, postalCode: pincode, latitude, longitude, approximate });
  if (!result.serviceable) {
    return { ...base, deliverable: false, reasonCode: "NOT_SERVICEABLE", reason: `Delivery is not available to ${pincode}` };
  }
  const lead = isBulkProduct(product) ? Number(product.wholesale?.leadTimeDays) || 0 : 0;
  const eta = etaWindow(result.zone, lead);
  const partner = pickPartner(commerce.deliveryPartners, null, false);
  const deliveryFee = round2(result.zone?.deliveryFee || 0);
  const partnerFee = round2(partner?.fee || 0);
  return {
    ...base,
    deliverable: true,
    reasonCode: inStock ? null : "OUT_OF_STOCK",
    reason: inStock ? "" : "Delivery is available, but the product is out of stock right now",
    etaDaysMin: eta.etaDaysMin,
    etaDaysMax: eta.etaDaysMax,
    etaFrom: eta.etaFrom,
    etaTo: eta.etaTo,
    fee: round2(deliveryFee + partnerFee),
    deliveryFee,
    partnerFee,
    zone: result.zone ? { name: result.zone.name || "default" } : null,
  };
}

/* ------------------------------------------------------------------ search */

const SEARCH_SORTS = ["relevance", "price-asc", "price-desc", "newest", "rating", "discount"];
const SORT_ALIASES = { popular: "rating", "rating-desc": "rating", latest: "newest", new: "newest", "discount-desc": "discount" };

function csvParam(raw, max = 20) {
  const values = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => (v == null || typeof v === "object" ? [] : String(v).split(",")))
    .map((v) => normalizeQ(v))
    .filter(Boolean);
  return [...new Set(values)].slice(0, max);
}

function queryFlag(raw) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

/** A category and all its descendants (breadth-first, bounded). */
async function categoryWithDescendants(rootIds) {
  const all = new Set(rootIds.map(String));
  let frontier = rootIds;
  for (let depth = 0; depth < 6 && frontier.length; depth += 1) {
    const children = await Category.find({ parentId: { $in: frontier } }).select("_id").lean();
    frontier = children.map((c) => c._id).filter((id) => !all.has(String(id)));
    for (const id of frontier) all.add(String(id));
  }
  return [...all].map((id) => new mongoose.Types.ObjectId(id));
}

/** Discount facet buckets: products whose best variant discount is at least `min` percent. */
const DISCOUNT_BUCKETS = [10, 20, 30, 40, 50];

/** Comparable pack-size key: lower case, no spaces, "×" → "x" ("2 X 500 ml" → "2x500ml"). */
export function packKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/×/g, "x")
    .replace(/\s+/g, "")
    .trim();
}

/** Anchored, case-insensitive regex matching a pack size with any spacing ("1kg" matches "1 KG"). */
function packRegex(key) {
  const parts = [...key].map((ch) => (ch === "x" ? "[x×]" : escapeRegex(ch)));
  return new RegExp(String.raw`^\s*` + parts.join(String.raw`\s*`) + String.raw`\s*$`, "i");
}

/**
 * Seller filter: `seller` and/or `tenantId`, each a comma list of store ids or slugs. Returns the
 * matching active store ids, or null when no seller filter was given.
 */
async function resolveSellerFilter(query) {
  const refs = [...csvParam(query.seller), ...csvParam(query.tenantId)];
  if (!refs.length) return null;
  const active = new Set((await activeTenantIds()).map(String));
  const ids = refs.filter((r) => /^[a-f\d]{24}$/i.test(r));
  const slugs = refs.filter((r) => !/^[a-f\d]{24}$/i.test(r)).map((r) => r.toLowerCase());
  const bySlug = slugs.length ? await Tenant.find({ slug: { $in: slugs } }).distinct("_id") : [];
  const wanted = [...new Set([...ids, ...bySlug.map(String)])].filter((id) => active.has(id));
  return wanted.map((id) => new mongoose.Types.ObjectId(id));
}

/**
 * Storefront search. Query: q; seller / tenantId (comma lists of store ids or slugs); category
 * (slug) / categoryId (comma list; descendants included); brand (comma list of slugs or names) /
 * brandId (comma list); tag; bulkEligible; packSize (comma list, matched on variant
 * attributes.packSize / size, spacing and case ignored); minPrice, maxPrice (buyer's effective
 * price); minDiscount (percent, best variant); inStock (alias available); postalCode;
 * sort=relevance|price-asc|price-desc|newest|rating|discount; page; limit; facets=1.
 * Rows carry ratingAvg/ratingCount, price summary, per-variant stock (one Inventory aggregation
 * per page) and slab tables; buyer price lists apply when signed in.
 * Facets (facets=1): brands, sellers, categories (DB counts with every filter except their own and
 * the in-memory ones), priceRange (before the price filter), packSizes (before the pack filter),
 * discounts (before the discount filter) and inStock (before the stock filter), the last four over
 * the in-memory candidate set (≤ IN_MEMORY_CAP).
 */
export async function searchCatalog(req) {
  const query = req.query || {};
  const { page, limit, skip } = paginate(query);
  const rawSort = normalizeQ(query.sort);
  const sort = SORT_ALIASES[rawSort] || (SEARCH_SORTS.includes(rawSort) ? rawSort : "relevance");
  const wantFacets = queryFlag(query.facets) === true;
  const inStockOnly = queryFlag(query.inStock) === true || queryFlag(query.available) === true;
  const emptyFacets = () => ({ brands: [], sellers: [], categories: [], packSizes: [], discounts: [], inStock: 0, priceRange: null });
  const empty = () => {
    const out = paginated([], 0, { page, limit });
    out.meta = { ...out.meta, sort, capped: false, matchedBy: null, didYouMean: null };
    return { ...out, ...(wantFacets ? { facets: emptyFacets() } : {}) };
  };

  const num = (v) => (v != null && v !== "" ? Number(Array.isArray(v) ? v[0] : v) : null);
  const minPrice = num(query.minPrice);
  const maxPrice = num(query.maxPrice);
  if ((minPrice != null && !Number.isFinite(minPrice)) || (maxPrice != null && !Number.isFinite(maxPrice))) {
    throw new AppError(400, "Invalid price filter", "VALIDATION_ERROR");
  }
  const minDiscount = num(query.minDiscount);
  if (minDiscount != null && (!Number.isFinite(minDiscount) || minDiscount < 0 || minDiscount > 100)) {
    throw new AppError(400, "minDiscount must be a percentage between 0 and 100", "VALIDATION_ERROR");
  }
  const packKeys = csvParam(query.packSize).map(packKey).filter(Boolean);

  // Base: what every count shares (status, tag, bulk, text).
  const base = { status: "published", enabled: { $ne: false } };
  if (query.tag) base.tags = normalizeQ(query.tag);
  const bulk = queryFlag(query.bulkEligible);
  if (bulk === true) base["wholesale.bulkEligible"] = true;
  else if (bulk === false) base["wholesale.bulkEligible"] = { $ne: true };

  // Stores: active ones, narrowed by the PIN code (serviceable stores) and by the seller filter.
  const activeIds = await activeTenantIds();
  let storeIds = activeIds;
  const postalCode = normalizeQ(query.postalCode);
  if (postalCode) {
    storeIds = await serviceableTenantIds(activeIds, {
      postalCode,
      latitude: query.latitude ? Number(query.latitude) : undefined,
      longitude: query.longitude ? Number(query.longitude) : undefined,
    });
  }
  const sellerIds = await resolveSellerFilter(query);
  const storeSet = new Set(storeIds.map(String));
  const tenantClause = { $in: sellerIds ? sellerIds.filter((id) => storeSet.has(String(id))) : storeIds };
  const tenantClauseNoSeller = { $in: storeIds };

  // Category: slug or ids, always including child categories.
  const categoryRoots = [];
  const categorySlug = normalizeQ(query.category);
  if (categorySlug && categorySlug !== "all") {
    const cat = await Category.findOne({ slug: categorySlug.toLowerCase() }).select("_id").lean();
    if (!cat) return empty();
    categoryRoots.push(cat._id);
  }
  for (const id of csvParam(query.categoryId)) {
    const oid = asObjectId(id);
    if (!oid) throw new AppError(400, "Invalid categoryId", "VALIDATION_ERROR");
    categoryRoots.push(oid);
  }
  const categoryClause = categoryRoots.length ? { $in: await categoryWithDescendants(categoryRoots) } : null;

  // Brand: several slugs / names and/or ids.
  const brandIds = [];
  for (const id of csvParam(query.brandId)) {
    const oid = asObjectId(id);
    if (!oid) throw new AppError(400, "Invalid brandId", "VALIDATION_ERROR");
    brandIds.push(oid);
  }
  const brandNames = csvParam(query.brand);
  if (brandNames.length) {
    const brands = await Brand.find({
      $or: brandNames.flatMap((b) => [{ slug: b.toLowerCase() }, { name: new RegExp(`^${escapeRegex(b)}$`, "i") }]),
    })
      .select("_id")
      .limit(200)
      .lean();
    if (!brands.length && !brandIds.length) return empty();
    brandIds.push(...brands.map((b) => b._id));
  }
  const brandClause = brandIds.length ? { $in: brandIds } : null;

  // Free-text: text index for >= 3 chars (falls back to an escaped regex when the index finds
  // nothing, e.g. partial words); escaped anchored prefix for 1-2 chars.
  // When that finds fewer than FEW_RESULTS products, synonyms (aata → atta) and then spelling
  // corrections against the cached term dictionary are tried (search/fuzzy.js).
  const q = normalizeQ(query.q);
  let useTextScore = false;
  let matchedBy = null;
  let didYouMean = null;
  if (q) {
    const clause = textClause(q);
    const probe = { ...base, tenantId: tenantClause, ...(categoryClause ? { categoryId: categoryClause } : {}) };
    const count = (c) => Product.countDocuments({ ...probe, ...c });
    let qClause = clause;
    matchedBy = "text";
    if (clause.$text) {
      let found = await count(clause);
      if (found > 0) useTextScore = true;
      else {
        qClause = regexClause(q);
        found = await count(qClause);
      }
      if (found < FEW_RESULTS) {
        const alt = await alternateSearch(q, found, count);
        if (alt) {
          qClause = alt.clause;
          useTextScore = alt.textScore;
          matchedBy = alt.matchedBy;
          didYouMean = alt.didYouMean;
        }
      }
    }
    Object.assign(base, qClause);
  }

  const compose = ({ seller = true, category = true, brand = true } = {}) => ({
    ...base,
    tenantId: seller ? tenantClause : tenantClauseNoSeller,
    ...(category && categoryClause ? { categoryId: categoryClause } : {}),
    ...(brand && brandClause ? { brandId: brandClause } : {}),
  });
  const filter = compose();

  // Pack size: products with a matching active variant. Applied to the main query unless the
  // pack facet needs the unfiltered candidates; always applied to the seller / brand / category
  // facet counts. Variants are also filtered in memory below.
  let packProductIds = null;
  if (packKeys.length) {
    const rx = packKeys.map(packRegex);
    packProductIds = await ProductVariant.distinct("productId", {
      tenantId: tenantClauseNoSeller,
      status: "active",
      $or: [{ "attributes.packSize": { $in: rx } }, { "attributes.size": { $in: rx } }],
    });
    if (!wantFacets) filter._id = { $in: packProductIds };
  }

  const inMemory =
    minPrice != null ||
    maxPrice != null ||
    minDiscount != null ||
    packKeys.length > 0 ||
    inStockOnly ||
    wantFacets ||
    ["price-asc", "price-desc", "discount"].includes(sort);

  let productQuery = Product.find(filter).populate("categoryId", "name slug").populate("brandId", "name slug");
  if (sort === "rating") productQuery = productQuery.sort({ ratingAvg: -1, ratingCount: -1, createdAt: -1 });
  else if (sort === "relevance" && useTextScore) {
    productQuery = productQuery.select({ score: { $meta: "textScore" } }).sort({ score: { $meta: "textScore" }, createdAt: -1 });
  } else productQuery = productQuery.sort({ createdAt: -1, _id: -1 });
  productQuery = inMemory ? productQuery.limit(IN_MEMORY_CAP) : productQuery.skip(skip).limit(limit);
  const [products, total0] = await Promise.all([productQuery, inMemory ? null : Product.countDocuments(filter)]);

  const ids = products.map((p) => p._id);
  const variants = ids.length ? await ProductVariant.find({ productId: { $in: ids }, status: "active" }).sort({ createdAt: 1 }) : [];
  const byProduct = new Map();
  for (const v of variants) {
    const key = String(v.productId);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(v);
  }
  const tenantIds = products.map((p) => p.tenantId);
  const buyerId = req.user?._id;
  const [stockMap, offers, priceLists, stores] = await Promise.all([
    variantStockMap(variants.map((v) => v._id)),
    loadActiveOffers(tenantIds),
    loadBuyerPriceLists(tenantIds, buyerId),
    Tenant.find({ _id: { $in: [...new Set(tenantIds.map(String))] } }).select("name slug pickupAddress.city").lean(),
  ]);
  const storeById = new Map(stores.map((t) => [String(t._id), { id: t._id, name: t.name, slug: t.slug, city: t.pickupAddress?.city || "" }]));

  const packWanted = new Set(packKeys);
  const priceOk = (v) => (minPrice == null || v.sellingPrice >= minPrice) && (maxPrice == null || v.sellingPrice <= maxPrice);
  const packOk = (v) => !packWanted.size || packWanted.has(packKey(packOf(v)));
  const packCounts = new Map(); // key -> { value, count }
  const discountCounts = DISCOUNT_BUCKETS.map(() => 0);
  let inStockCount = 0;

  let data = [];
  const allPrices = [];
  for (const p of products) {
    const { variants: decorated, offers: liveOffers } = withCatalogOffers(
      p,
      byProduct.get(String(p._id)) || [],
      offers,
      buyerId,
      priceLists.get(String(p.tenantId)) || []
    );
    const all = decorated.map((v) => withStock(v, stockMap));
    if (all.length) allPrices.push(...all.map((v) => v.sellingPrice));
    if (wantFacets) {
      // Pack facet: variants that pass the price filter, before the pack filter (one count per product).
      const seen = new Set();
      for (const v of all.filter(priceOk)) {
        const raw = String(packOf(v) || "").trim();
        const key = packKey(raw);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (!packCounts.has(key)) packCounts.set(key, { value: raw, count: 0 });
        packCounts.get(key).count += 1;
      }
    }
    const filtered = minPrice != null || maxPrice != null || packWanted.size;
    const vs = filtered ? all.filter((v) => priceOk(v) && packOk(v)) : all;
    if (filtered && vs.length === 0) continue;
    const summary = productSummary(vs);
    const discountOk = minDiscount == null || summary.discountPct >= minDiscount;
    if (wantFacets) {
      if (discountOk && summary.inStock) inStockCount += 1;
      if (!inStockOnly || summary.inStock) {
        DISCOUNT_BUCKETS.forEach((min, i) => {
          if (summary.discountPct >= min) discountCounts[i] += 1;
        });
      }
    }
    if (inStockOnly && !summary.inStock) continue;
    if (!discountOk) continue;
    data.push({
      ...p.toObject(),
      ratingAvg: p.ratingAvg || 0,
      ratingCount: p.ratingCount || 0,
      store: storeById.get(String(p.tenantId)) || null,
      rules: wholesaleRules(p),
      ...summary,
      variants: vs,
      offers: liveOffers,
    });
  }

  if (sort === "price-asc") data.sort((a, b) => (a.minPrice ?? Infinity) - (b.minPrice ?? Infinity));
  else if (sort === "price-desc") data.sort((a, b) => (b.minPrice ?? -Infinity) - (a.minPrice ?? -Infinity));
  else if (sort === "discount") data.sort((a, b) => b.discountPct - a.discountPct);

  const total = inMemory ? data.length : total0;
  if (inMemory) data = data.slice(skip, skip + limit);
  const out = paginated(data, total, { page, limit });
  out.meta.sort = sort;
  out.meta.capped = Boolean(inMemory && products.length >= IN_MEMORY_CAP);
  out.meta.matchedBy = matchedBy;
  out.meta.didYouMean = didYouMean;
  if (wantFacets) {
    const grouped = (match, field, from) => [
      { $match: packProductIds ? { ...match, _id: { $in: packProductIds } } : match },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 100 },
      { $lookup: { from, localField: "_id", foreignField: "_id", as: "doc" } },
    ];
    const [brandRows, sellerRows, categoryRows] = await Promise.all([
      Product.aggregate(grouped(compose({ brand: false }), "brandId", Brand.collection.name)),
      Product.aggregate(grouped(compose({ seller: false }), "tenantId", Tenant.collection.name)),
      Product.aggregate(grouped(compose({ category: false }), "categoryId", Category.collection.name)),
    ]);
    const rows = (list) =>
      list.filter((row) => row._id && row.doc?.[0]).map((row) => ({ id: row._id, name: row.doc[0].name, slug: row.doc[0].slug, count: row.count }));
    out.facets = {
      brands: rows(brandRows),
      sellers: rows(sellerRows),
      categories: rows(categoryRows),
      packSizes: [...packCounts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, 50),
      discounts: DISCOUNT_BUCKETS.map((min, i) => ({ min, label: `${min}% or more`, count: discountCounts[i] })),
      inStock: inStockCount,
      priceRange: allPrices.length ? { min: Math.min(...allPrices), max: Math.max(...allPrices) } : null,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ media */

export async function uploadMedia(req, file, { folder = "catalog", tags } = {}) {
  if (!file) throw new AppError(400, "File is required", "VALIDATION_ERROR");
  const saved = await storage.save({
    buffer: file.buffer,
    originalName: file.originalname,
    mimeType: file.mimetype,
    folder, // whitelisted by the route validator (MEDIA_FOLDERS); storage derives name + extension
  });
  const tagList = String(tags || "")
    .split(",")
    .map((t) => t.trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 10);
  try {
    return await Media.create({
      tenantId: req.tenantId || null,
      key: saved.key,
      url: saved.url,
      filename: saved.filename,
      mimeType: saved.mimeType,
      size: saved.size,
      folder,
      tags: tagList,
      uploadedBy: req.user._id,
    });
  } catch (err) {
    await storage.remove(saved.key).catch(() => {});
    throw err;
  }
}

export async function listMedia(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);
  if (req.query.folder) filter.folder = String(req.query.folder);
  const [data, total] = await Promise.all([
    Media.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Media.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function deleteMedia(req, id) {
  const media = await Media.findOneAndDelete({ _id: id, ...tenantFilter(req) });
  if (!media) throw new AppError(404, "Media not found", "NOT_FOUND");
  await storage.remove(media.key);
  return { ok: true, id };
}

/* ------------------------------------------------------------------ maintenance */

/** Drop indexes no longer declared and build new ones for catalog/reviews/wishlist/search models. */
export async function syncCatalogIndexes() {
  const names = ["Product", "ProductVariant", "Category", "Brand", "Media", "RestockAlert", "Review", "WishlistItem", "SearchHistory", "SearchTerm"];
  await Promise.all([
    import("../reviews/review.model.js"),
    import("../wishlist/wishlist.model.js"),
    import("../search/searchHistory.model.js"),
    import("../search/searchTerm.model.js"),
  ]);
  const out = {};
  for (const name of names) {
    out[name] = await mongoose.model(name).syncIndexes();
  }
  return out;
}
