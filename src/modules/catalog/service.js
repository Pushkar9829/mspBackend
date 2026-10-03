import { Category } from "./category.model.js";
import { Brand } from "./brand.model.js";
import { Product } from "./product.model.js";
import { ProductVariant } from "./variant.model.js";
import { Media } from "./media.model.js";
import { Inventory } from "../inventory/inventory.model.js";
import { Warehouse } from "../inventory/warehouse.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { asObjectId, tenantFilter } from "../../middleware/tenantScope.js";
import { storage } from "../../utils/storage.js";
import { checkServiceability } from "../location/service.js";
import { emitDomain } from "../../utils/events.js";
import {
  applyOffersToVariants,
  loadActiveOffers,
  matchingOffers,
  serializeOffer,
} from "../pricing/engine.js";

function staffTenantId(req) {
  if (req.isPlatformAdmin) return req.tenantId || null;
  return asObjectId(req.user?.tenantId);
}

/**
 * Shared categories plus the caller's own: a store sees its categories, a buyer browsing a store
 * sees that store's, and the open shop sees store categories that have something published.
 */
export async function listCategories(req) {
  const query = req.query || {};
  const filter = {};
  if (query.parentId === "null") filter.parentId = null;
  else if (query.parentId) filter.parentId = query.parentId;
  if (query.status) filter.status = query.status;

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
    const used = await Product.distinct("categoryId", { status: "published", enabled: { $ne: false } });
    filter.$or = [{ tenantId: null }, { _id: { $in: used.filter(Boolean) } }];
  }
  return Category.find(filter).sort({ sortOrder: 1, name: 1 });
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
  return uniqueCategorySlug(base, excludeId);
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
  const { tenantId: _ignored, ...changes } = body;
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
  return { ok: true, id };
}

export async function listBrands(req) {
  return Brand.find(tenantFilter(req)).sort({ name: 1 });
}

export async function listPublicBrands() {
  return Brand.aggregate([
    { $match: { status: "active" } },
    {
      $group: {
        _id: "$slug",
        name: { $first: "$name" },
        slug: { $first: "$slug" },
        logo: { $first: "$logo" },
      },
    },
    { $sort: { name: 1 } },
  ]);
}

export async function createBrand(req, body) {
  const slug = slugify(body.slug || body.name);
  return Brand.create({ ...body, slug, tenantId: req.tenantId });
}

export async function updateBrand(req, id, body) {
  if (body.slug) body.slug = slugify(body.slug);
  else if (body.name) body.slug = slugify(body.name);
  const brand = await Brand.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, body, {
    new: true,
    runValidators: true,
  });
  if (!brand) throw new AppError(404, "Brand not found", "NOT_FOUND");
  return brand;
}

export async function deleteBrand(req, id) {
  const inUse = await Product.countDocuments({ brandId: id, status: { $ne: "archived" } });
  if (inUse) {
    throw new AppError(409, `Used by ${inUse} product${inUse === 1 ? "" : "s"}. Change their brand first.`, "IN_USE");
  }
  const brand = await Brand.findOneAndDelete({ _id: id, ...tenantFilter(req) });
  if (!brand) throw new AppError(404, "Brand not found", "NOT_FOUND");
  return { ok: true, id };
}

export async function listProducts(req, { buyer = false } = {}) {
  const { page, limit, skip } = paginate(req.query);
  const filter = buyer ? { status: "published", enabled: { $ne: false } } : tenantFilter(req);
  if (buyer && req.query.tenantId) filter.tenantId = req.query.tenantId;
  if (req.query.categoryId) filter.categoryId = req.query.categoryId;
  if (req.query.brandId) filter.brandId = req.query.brandId;
  if (req.query.status && !buyer) filter.status = req.query.status;
  else if (!buyer) filter.status = { $ne: "archived" };
  if (req.query.tag) filter.tags = req.query.tag;
  if (req.query.bulkEligible === "true" || req.query.bulkEligible === "1") {
    filter["wholesale.bulkEligible"] = true;
  } else if (req.query.bulkEligible === "false" || req.query.bulkEligible === "0") {
    filter["wholesale.bulkEligible"] = { $ne: true };
  }
  if (req.query.q) {
    const rx = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
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
  const variants = ids.length ? await ProductVariant.find({ productId: { $in: ids } }).lean() : [];
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
  const filter = buyer ? { _id: id, status: "published" } : { _id: id, ...tenantFilter(req) };
  const product = await Product.findOne(filter)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug");
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  const variants = await ProductVariant.find({ productId: product._id, ...(buyer ? { status: "active" } : {}) });
  return { ...product.toObject(), variants };
}

export async function createProduct(req, body) {
  if (!req.tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const { variant, initialStock, sellingPrice, listPrice, packSize, availableQty, tierPrices, ...rest } = body;
  void availableQty;
  await assertCategoryUsable(rest.categoryId, req.tenantId);
  const product = await Product.create({
    ...rest,
    sku: String(rest.sku || "").toUpperCase(),
    tenantId: req.tenantId,
  });

  const variantBody = variant || {
    sku: product.sku,
    listPrice: Number(listPrice ?? sellingPrice ?? 0),
    sellingPrice: Number(sellingPrice ?? listPrice ?? 0),
    attributes: { packSize: packSize || "1 pc" },
  };
  if (tierPrices?.length && !variantBody.tierPrices?.length) {
    variantBody.tierPrices = tierPrices;
  }

  const created = await ProductVariant.create({
    ...variantBody,
    sku: String(variantBody.sku || product.sku).toUpperCase(),
    tenantId: req.tenantId,
    productId: product._id,
  });
  if (initialStock?.warehouseId && Number(initialStock.qty) >= 0) {
    await Inventory.create({
      tenantId: req.tenantId,
      warehouseId: initialStock.warehouseId,
      variantId: created._id,
      sku: created.sku,
      available: Number(initialStock.qty) || 0,
      lowStockThreshold: initialStock.lowStockThreshold ?? 10,
    });
  }

  return product;
}

async function setProductAvailable(product, qty) {
  const variants = await ProductVariant.find({ productId: product._id }).sort({ createdAt: 1 });
  if (!variants.length) return;
  let stock = await Inventory.findOne({ variantId: variants[0]._id });
  if (!stock) {
    const warehouse = await Warehouse.findOne({ tenantId: product.tenantId, status: "active" });
    if (!warehouse) throw new AppError(400, "Add a warehouse before setting available stock", "WAREHOUSE_REQUIRED");
    await Inventory.create({
      tenantId: product.tenantId,
      warehouseId: warehouse._id,
      variantId: variants[0]._id,
      sku: variants[0].sku,
      available: qty,
    });
    return;
  }
  stock.available = qty;
  await stock.save();
}

export async function updateProduct(req, id, body) {
  const { variant, initialStock, sellingPrice, listPrice, availableQty, tierPrices, ...rest } = body;
  if (rest.sku) rest.sku = String(rest.sku).toUpperCase();
  if (rest.categoryId) {
    const current = await Product.findOne({ _id: id, ...tenantFilter(req) }).select("tenantId").lean();
    if (!current) throw new AppError(404, "Product not found", "NOT_FOUND");
    await assertCategoryUsable(rest.categoryId, current.tenantId);
  }
  const product = await Product.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, rest, {
    new: true,
    runValidators: true,
  });
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  void variant;
  void initialStock;
  const primary = await ProductVariant.findOne({ productId: product._id }).sort({ createdAt: 1 });
  if (primary && (sellingPrice != null || listPrice != null || tierPrices)) {
    if (sellingPrice != null) primary.sellingPrice = Number(sellingPrice);
    if (listPrice != null) primary.listPrice = Number(listPrice);
    if (tierPrices) primary.tierPrices = tierPrices;
    await primary.save();
    if (sellingPrice != null || listPrice != null) {
      const patch = {};
      if (sellingPrice != null) patch.sellingPrice = Number(sellingPrice);
      if (listPrice != null) patch.listPrice = Number(listPrice);
      await ProductVariant.updateMany({ productId: product._id, _id: { $ne: primary._id } }, patch);
    }
  } else if (sellingPrice != null || listPrice != null) {
    const patch = {};
    if (sellingPrice != null) patch.sellingPrice = Number(sellingPrice);
    if (listPrice != null) patch.listPrice = Number(listPrice);
    await ProductVariant.updateMany({ productId: product._id }, patch);
  }
  if (availableQty != null) await setProductAvailable(product, Number(availableQty));
  return product;
}

export async function bulkUploadProducts(req, items = []) {
  if (!req.tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const created = [];
  const updated = [];
  const errors = [];

  for (const [index, row] of items.entries()) {
    try {
      const sku = String(row.sku || "").trim().toUpperCase();
      if (!sku) throw new AppError(400, "SKU is required", "VALIDATION_ERROR");
      const wholesale = {
        bulkEligible: row.wholesale?.bulkEligible !== false,
        moq: Number(row.wholesale?.moq || 1),
        maxQty: row.wholesale?.maxQty == null || row.wholesale?.maxQty === "" ? null : Number(row.wholesale.maxQty),
        packMultiple: Math.max(1, Number(row.wholesale?.packMultiple || 1)),
        caseQty: Number(row.wholesale?.caseQty || 1),
        leadTimeDays: Number(row.wholesale?.leadTimeDays || 0),
      };
      const existing = await Product.findOne({ tenantId: req.tenantId, sku });
      const tierPrices = Array.isArray(row.tierPrices) ? row.tierPrices : undefined;
      if (existing) {
        const next = await updateProduct(req, existing._id, {
          name: row.name,
          sellingPrice: row.sellingPrice,
          listPrice: row.listPrice ?? row.sellingPrice,
          categoryId: row.categoryId,
          brandId: row.brandId,
          wholesale: { ...(existing.wholesale?.toObject?.() || existing.wholesale || {}), ...wholesale },
          tierPrices,
          availableQty: row.availableQty,
          status: row.status,
        });
        if (row.publish) await publishProduct(req, existing._id);
        updated.push({ index, id: next._id, sku });
      } else {
        const product = await createProduct(req, {
          name: row.name,
          sku,
          sellingPrice: row.sellingPrice,
          listPrice: row.listPrice ?? row.sellingPrice,
          categoryId: row.categoryId,
          brandId: row.brandId,
          status: row.status || "draft",
          wholesale,
          tierPrices,
          ...(row.warehouseId != null && row.availableQty != null
            ? { initialStock: { warehouseId: row.warehouseId, qty: row.availableQty } }
            : {}),
        });
        if (row.publish) await publishProduct(req, product._id);
        created.push({ index, id: product._id, sku });
      }
    } catch (err) {
      errors.push({ index, sku: row.sku, message: err.message || "Failed", code: err.code || "ERROR" });
    }
  }

  return { created, updated, errors, ok: errors.length === 0 };
}

export async function deleteProduct(req, id) {
  const product = await Product.findOneAndUpdate(
    { _id: id, ...tenantFilter(req) },
    { status: "archived" },
    { new: true }
  );
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  return product;
}

export async function listVariants(req) {
  const filter = tenantFilter(req);
  if (req.query.productId) filter.productId = req.query.productId;
  return ProductVariant.find(filter).sort({ sku: 1 });
}

export async function createVariant(req, body) {
  const product = await Product.findOne({ _id: body.productId, ...tenantFilter(req) });
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  return ProductVariant.create({ ...body, tenantId: product.tenantId, productId: product._id });
}

export async function updateVariant(req, id, body) {
  const variant = await ProductVariant.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, body, {
    new: true,
    runValidators: true,
  });
  if (!variant) throw new AppError(404, "Variant not found", "NOT_FOUND");
  return variant;
}

export async function deleteVariant(req, id) {
  const variant = await ProductVariant.findOneAndDelete({ _id: id, ...tenantFilter(req) });
  if (!variant) throw new AppError(404, "Variant not found", "NOT_FOUND");
  return { ok: true, id };
}

export async function publishProduct(req, id) {
  const product = await Product.findOneAndUpdate(
    { _id: id, ...tenantFilter(req) },
    { status: "published" },
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

function withCatalogOffers(product, variants, offers, buyerId) {
  const decorated = applyOffersToVariants(variants, offers, product, buyerId);
  const liveOffers = matchingOffers(offers, product, buyerId).map(serializeOffer).filter(Boolean);
  return { variants: decorated, offers: liveOffers };
}

export async function lookupBySlug(slug, pack, req) {
  if (!slug) throw new AppError(400, "slug is required", "VALIDATION_ERROR");
  const product = await Product.findOne({ sku: String(slug).toUpperCase(), status: "published", enabled: { $ne: false } })
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug");
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  const variants = await ProductVariant.find({ productId: product._id, status: "active" });
  if (!variants.length) throw new AppError(404, "Variant not found", "NOT_FOUND");
  const offers = await loadActiveOffers([product.tenantId]);
  const { variants: decorated, offers: liveOffers } = withCatalogOffers(
    product,
    variants,
    offers,
    req?.user?._id
  );
  const stocks = decorated.length
    ? await Inventory.aggregate([
        { $match: { variantId: { $in: decorated.map((row) => row._id) } } },
        { $group: { _id: "$variantId", available: { $sum: "$available" } } },
      ])
    : [];
  const stockByVariant = new Map(stocks.map((row) => [String(row._id), row.available || 0]));
  const withStock = decorated.map((row) => ({
    ...(row.toObject ? row.toObject() : row),
    available: stockByVariant.get(String(row._id)) || 0,
  }));
  let variant = withStock[0];
  if (pack) {
    const wanted = String(pack).toLowerCase().replace(/\s+/g, " ").trim();
    variant =
      withStock.find((v) => {
        const size = String(v.attributes?.packSize || v.attributes?.size || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        return size === wanted;
      }) || variant;
  }
  const available = withStock.reduce((sum, row) => sum + (Number(row.available) || 0), 0);
  const seller = await Tenant.findById(product.tenantId).select("name pickupAddress");
  return {
    slug: String(product.sku || "").toLowerCase(),
    product: {
      ...product.toObject(),
      offers: liveOffers,
      available,
      orderLimit: product.wholesale?.maxQty ?? null,
      wholesale: product.wholesale || {},
    },
    variant,
    variants: withStock,
    offers: liveOffers,
    available,
    pickupAddress: seller?.pickupAddress || null,
  };
}

export async function searchCatalog(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = { status: "published", enabled: { $ne: false } };
  if (req.query.tenantId) filter.tenantId = req.query.tenantId;
  if (req.query.categoryId) filter.categoryId = req.query.categoryId;
  if (req.query.brandId) filter.brandId = req.query.brandId;
  if (req.query.tag) filter.tags = req.query.tag;
  if (req.query.bulkEligible === "true" || req.query.bulkEligible === "1") {
    filter["wholesale.bulkEligible"] = true;
  } else if (req.query.bulkEligible === "false" || req.query.bulkEligible === "0") {
    filter["wholesale.bulkEligible"] = { $ne: true };
  }
  if (req.query.q) {
    filter.$or = [
      { name: new RegExp(req.query.q, "i") },
      { sku: new RegExp(req.query.q, "i") },
      { tags: new RegExp(req.query.q, "i") },
    ];
  }

  if (req.query.category && req.query.category !== "all") {
    const cat = await Category.findOne({ slug: String(req.query.category).toLowerCase() });
    if (!cat) return paginated([], 0, { page, limit });
    const children = await Category.find({ parentId: cat._id }).select("_id");
    filter.categoryId = { $in: [cat._id, ...children.map((c) => c._id)] };
  }

  if (req.query.brand) {
    const raw = String(req.query.brand).trim();
    const rx = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const brands = await Brand.find({ $or: [{ slug: raw.toLowerCase() }, { name: rx }] }).select("_id");
    if (!brands.length) return paginated([], 0, { page, limit });
    filter.brandId = { $in: brands.map((b) => b._id) };
  }

  if (req.query.postalCode && !req.query.tenantId) {
    const tenants = await Tenant.find({ status: { $in: ["active", "trial"] } }).select("_id deliveryZones");
    const ok = [];
    for (const t of tenants) {
      const result = await checkServiceability({
        tenantId: t._id,
        postalCode: req.query.postalCode,
        latitude: req.query.latitude ? Number(req.query.latitude) : undefined,
        longitude: req.query.longitude ? Number(req.query.longitude) : undefined,
      });
      if (result.serviceable) ok.push(t._id);
    }
    filter.tenantId = { $in: ok };
  }

  const products = await Product.find(filter)
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug")
    .skip(skip)
    .limit(limit)
    .sort({ createdAt: -1 });

  const ids = products.map((p) => p._id);
  const variants = await ProductVariant.find({ productId: { $in: ids }, status: "active" });
  const byProduct = new Map();
  for (const v of variants) {
    const key = String(v.productId);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(v);
  }

  const offers = await loadActiveOffers(products.map((p) => p.tenantId));
  const buyerId = req.user?._id;
  let minPrice = req.query.minPrice != null ? Number(req.query.minPrice) : null;
  let maxPrice = req.query.maxPrice != null ? Number(req.query.maxPrice) : null;

  const data = [];
  for (const p of products) {
    const { variants: vs0, offers: liveOffers } = withCatalogOffers(
      p,
      byProduct.get(String(p._id)) || [],
      offers,
      buyerId
    );
    let vs = vs0;
    if (minPrice != null) vs = vs.filter((v) => v.sellingPrice >= minPrice);
    if (maxPrice != null) vs = vs.filter((v) => v.sellingPrice <= maxPrice);
    if ((minPrice != null || maxPrice != null) && vs.length === 0) continue;

    let available = true;
    if (req.query.available === "true") {
      const stock = await Inventory.aggregate([
        { $match: { variantId: { $in: vs.map((v) => v._id) } } },
        { $group: { _id: null, qty: { $sum: "$available" } } },
      ]);
      available = (stock[0]?.qty || 0) > 0;
      if (!available) continue;
    }

    data.push({ ...p.toObject(), variants: vs, offers: liveOffers });
  }

  const sort = req.query.sort;
  if (sort === "price-asc") {
    data.sort((a, b) => (a.variants[0]?.sellingPrice || 0) - (b.variants[0]?.sellingPrice || 0));
  } else if (sort === "price-desc") {
    data.sort((a, b) => (b.variants[0]?.sellingPrice || 0) - (a.variants[0]?.sellingPrice || 0));
  }

  const total = await Product.countDocuments(filter);
  return paginated(data, total, { page, limit });
}

export async function uploadMedia(req, file) {
  if (!file) throw new AppError(400, "File is required", "VALIDATION_ERROR");
  const saved = await storage.save({
    buffer: file.buffer,
    originalName: file.originalname,
    mimeType: file.mimetype,
    folder: req.body.folder || "catalog",
  });
  return Media.create({
    tenantId: req.tenantId || null,
    ...saved,
    folder: req.body.folder || "catalog",
    tags: req.body.tags ? String(req.body.tags).split(",") : [],
    uploadedBy: req.user._id,
  });
}

export async function listMedia(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);
  if (req.query.folder) filter.folder = req.query.folder;
  const [data, total] = await Promise.all([
    Media.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Media.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}
