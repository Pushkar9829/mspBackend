import { Category } from "./category.model.js";
import { Brand } from "./brand.model.js";
import { Product } from "./product.model.js";
import { ProductVariant } from "./variant.model.js";
import { Media } from "./media.model.js";
import { Inventory } from "../inventory/inventory.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { storage } from "../../utils/storage.js";
import { checkServiceability } from "../location/service.js";
import { emitDomain } from "../../utils/events.js";
import {
  applyOffersToVariants,
  loadActiveOffers,
  matchingOffers,
  serializeOffer,
} from "../pricing/engine.js";

export async function listCategories(query) {
  const filter = {};
  if (query.parentId === "null") filter.parentId = null;
  else if (query.parentId) filter.parentId = query.parentId;
  if (query.status) filter.status = query.status;
  return Category.find(filter).sort({ sortOrder: 1, name: 1 });
}

export async function createCategory(body) {
  const slug = slugify(body.slug || body.name);
  return Category.create({ ...body, slug });
}

export async function updateCategory(id, body) {
  if (body.slug) body.slug = slugify(body.slug);
  const cat = await Category.findByIdAndUpdate(id, body, { new: true, runValidators: true });
  if (!cat) throw new AppError(404, "Category not found", "NOT_FOUND");
  return cat;
}

export async function deleteCategory(id) {
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
  const brand = await Brand.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, body, {
    new: true,
    runValidators: true,
  });
  if (!brand) throw new AppError(404, "Brand not found", "NOT_FOUND");
  return brand;
}

export async function deleteBrand(req, id) {
  const brand = await Brand.findOneAndDelete({ _id: id, ...tenantFilter(req) });
  if (!brand) throw new AppError(404, "Brand not found", "NOT_FOUND");
  return { ok: true, id };
}

export async function listProducts(req, { buyer = false } = {}) {
  const { page, limit, skip } = paginate(req.query);
  const filter = buyer ? { status: "published" } : tenantFilter(req);
  if (buyer && req.query.tenantId) filter.tenantId = req.query.tenantId;
  if (req.query.categoryId) filter.categoryId = req.query.categoryId;
  if (req.query.brandId) filter.brandId = req.query.brandId;
  if (req.query.status && !buyer) filter.status = req.query.status;
  if (req.query.tag) filter.tags = req.query.tag;
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
    return {
      ...p.toObject(),
      variantsCount: vs.length,
      available,
      reserved,
      sellingPrice: prices.length ? Math.min(...prices) : null,
      listPrice: vs[0]?.listPrice ?? null,
      primaryVariantId: vs[0]?._id || null,
      primarySku: vs[0]?.sku || p.sku,
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
  const { variant, initialStock, sellingPrice, listPrice, packSize, ...rest } = body;
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

export async function updateProduct(req, id, body) {
  const { variant, initialStock, ...rest } = body;
  if (rest.sku) rest.sku = String(rest.sku).toUpperCase();
  const product = await Product.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, rest, {
    new: true,
    runValidators: true,
  });
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  void variant;
  void initialStock;
  return product;
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
  const product = await Product.findOne({ sku: String(slug).toUpperCase(), status: "published" })
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
  return {
    slug: String(product.sku || "").toLowerCase(),
    product: {
      ...product.toObject(),
      offers: liveOffers,
      available,
      orderLimit: product.wholesale?.maxQty ?? null,
    },
    variant,
    variants: withStock,
    offers: liveOffers,
    available,
  };
}

export async function searchCatalog(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = { status: "published" };
  if (req.query.tenantId) filter.tenantId = req.query.tenantId;
  if (req.query.categoryId) filter.categoryId = req.query.categoryId;
  if (req.query.brandId) filter.brandId = req.query.brandId;
  if (req.query.tag) filter.tags = req.query.tag;
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
