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
  if (req.query.q) filter.$text = { $search: req.query.q };
  if (req.query.tag) filter.tags = req.query.tag;

  const [data, total] = await Promise.all([
    Product.find(filter)
      .populate("categoryId", "name slug")
      .populate("brandId", "name slug")
      .populate("tenantId", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Product.countDocuments(filter),
  ]);
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
  return Product.create({ ...body, tenantId: req.tenantId });
}

export async function updateProduct(req, id, body) {
  const product = await Product.findOneAndUpdate({ _id: id, ...tenantFilter(req) }, body, {
    new: true,
    runValidators: true,
  });
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
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

export async function lookupBySlug(slug, pack) {
  if (!slug) throw new AppError(400, "slug is required", "VALIDATION_ERROR");
  const product = await Product.findOne({ sku: String(slug).toUpperCase(), status: "published" })
    .populate("categoryId", "name slug")
    .populate("brandId", "name slug");
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  const variants = await ProductVariant.find({ productId: product._id, status: "active" });
  if (!variants.length) throw new AppError(404, "Variant not found", "NOT_FOUND");
  let variant = variants[0];
  if (pack) {
    const wanted = String(pack).toLowerCase().replace(/\s+/g, " ").trim();
    variant =
      variants.find((v) => {
        const size = String(v.attributes?.packSize || v.attributes?.size || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        return size === wanted;
      }) || variant;
  }
  return {
    slug: String(product.sku || "").toLowerCase(),
    product,
    variant,
    variants,
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
    filter.categoryId = cat._id;
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

  let minPrice = req.query.minPrice != null ? Number(req.query.minPrice) : null;
  let maxPrice = req.query.maxPrice != null ? Number(req.query.maxPrice) : null;

  const data = [];
  for (const p of products) {
    let vs = byProduct.get(String(p._id)) || [];
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

    data.push({ ...p.toObject(), variants: vs });
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
