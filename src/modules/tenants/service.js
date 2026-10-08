import bcrypt from "bcryptjs";
import { Tenant } from "./tenant.model.js";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { AppError } from "../../utils/AppError.js";
import { slugify } from "../../utils/slug.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { SYSTEM_ROLES, FULFILLMENT_MODES } from "../../config/constants.js";
import { Product } from "../catalog/product.model.js";
import { Settings } from "../settings/settings.model.js";
import { SALT } from "../auth/service.js";
import { emitDomain } from "../../utils/events.js";
import { geocodeAddress } from "../location/service.js";
import { normalizeIndianState } from "../location/pincode.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NESTED = ["branding", "businessProfile", "taxSettings", "orderRules", "notificationPreferences", "pickupAddress"];

const TENANT_SORT_FIELDS = { createdAt: "createdAt", updatedAt: "updatedAt", name: "name", slug: "slug", status: "status" };

/**
 * Platform tenant list. q (name/slug/legal name/email/GSTIN/zone), status (comma list),
 * sort (createdAt|updatedAt|name|slug|status) + order (asc|desc). Each row carries `staffCount`
 * (members with tenantId = store, not deleted). Per-tenant sales stats come from /reports/tenants.
 */
export async function listTenants(query) {
  const { page, limit, skip } = paginate(query);
  const filter = {};
  if (query.status) {
    const statuses = String(query.status).split(",").map((v) => v.trim()).filter(Boolean);
    filter.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q).trim().slice(0, 100)), "i");
    filter.$or = [
      { name: rx },
      { slug: rx },
      { "businessProfile.legalName": rx },
      { "businessProfile.email": rx },
      { "businessProfile.gstin": rx },
      { "deliveryZones.name": rx },
    ];
  }
  const field = TENANT_SORT_FIELDS[String(query.sort || "")] || "createdAt";
  const dir = String(query.order || "").toLowerCase() === "asc" ? 1 : -1;
  const [rows, total] = await Promise.all([
    Tenant.find(filter)
      .collation({ locale: "en", strength: 2 })
      .sort({ [field]: dir, _id: dir })
      .skip(skip)
      .limit(limit)
      .lean(),
    Tenant.countDocuments(filter),
  ]);
  const counts = rows.length
    ? await User.aggregate([
        { $match: { tenantId: { $in: rows.map((t) => t._id) }, status: { $ne: "deleted" } } },
        { $group: { _id: "$tenantId", n: { $sum: 1 } } },
      ])
    : [];
  const byTenant = new Map(counts.map((c) => [String(c._id), c.n]));
  const data = rows.map((t) => ({ ...t, id: t._id, staffCount: byTenant.get(String(t._id)) || 0 }));
  return paginated(data, total, { page, limit });
}

export async function getTenant(id) {
  const tenant = await Tenant.findById(id);
  if (!tenant) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  return tenant;
}

async function withGeocodedPickup(input) {
  if (!input) return undefined;
  // Store the canonical state name ("DL" / "New Delhi" -> "Delhi") so GST place-of-supply
  // comparisons on invoices see the same spelling as buyer addresses.
  const address = input.state !== undefined ? { ...input, state: normalizeIndianState(input.state).state } : input;
  const hasPlace = address.addressLine1 || address.city || address.postalCode;
  if (!hasPlace) return address;
  const geo = await geocodeAddress(address);
  return {
    ...address,
    latitude: geo.latitude,
    longitude: geo.longitude,
    placeId: geo.placeId || "",
    formatted: geo.formatted || "",
  };
}

export async function createTenant(body) {
  const slug = slugify(body.slug || body.name);
  if (!slug) throw new AppError(400, "Invalid slug", "VALIDATION_ERROR");
  const exists = await Tenant.findOne({ slug });
  if (exists) throw new AppError(409, "Slug already in use", "DUPLICATE");

  let adminRole = null;
  if (body.admin) {
    adminRole = await Role.findOne({ slug: SYSTEM_ROLES.TENANT_ADMIN, isSystem: true });
    if (!adminRole) throw new AppError(500, "Tenant admin role not seeded", "SERVER_ERROR");
    const existing = await User.findOne({ email: body.admin.email.toLowerCase() }).select("_id");
    if (existing) throw new AppError(409, "Admin email already registered", "DUPLICATE");
  }

  const tenant = await Tenant.create({
    name: body.name,
    slug,
    status: body.status || "pending",
    branding: body.branding,
    businessProfile: body.businessProfile,
    taxSettings: body.taxSettings,
    orderRules: body.orderRules,
    deliveryZones: body.deliveryZones || [],
    pickupAddress: await withGeocodedPickup(body.pickupAddress),
    notificationPreferences: body.notificationPreferences,
  });

  if (body.admin) {
    try {
      await User.create({
        name: body.admin.name,
        email: body.admin.email.toLowerCase(),
        passwordHash: await bcrypt.hash(body.admin.password, SALT),
        tenantId: tenant._id,
        roleId: adminRole._id,
        status: "active",
        emailVerified: true,
        emailVerifiedAt: new Date(),
      });
    } catch (err) {
      // Don't leave a tenant without its admin behind.
      await Tenant.deleteOne({ _id: tenant._id }).catch(() => {});
      throw err;
    }
  }

  return tenant;
}

/** Build a $set that merges nested objects field-by-field instead of replacing them. */
function toSet(patch) {
  const set = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (NESTED.includes(key) && value && typeof value === "object" && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) set[`${key}.${k}`] = v;
      }
    } else {
      set[key] = value;
    }
  }
  return set;
}

export async function updateTenant(id, body) {
  const before = await Tenant.findById(id);
  if (!before) throw new AppError(404, "Tenant not found", "NOT_FOUND");
  const patch = { ...body };
  if (body.pickupAddress) {
    const merged = { ...(before.pickupAddress?.toObject?.() || {}), ...body.pickupAddress };
    patch.pickupAddress = await withGeocodedPickup(merged);
  }
  const tenant = await Tenant.findByIdAndUpdate(id, { $set: toSet(patch) }, { new: true, runValidators: true });
  if (body.status && body.status !== before.status) {
    try {
      const catalog = await import("../catalog/service.js");
      if (typeof catalog.invalidateActiveTenants === "function") catalog.invalidateActiveTenants();
    } catch {
      /* catalog cache is optional */
    }
    if (["suspended", "archived"].includes(body.status)) {
      emitDomain("TENANT_SUSPENDED", { tenantId: tenant._id, resource: "tenant", resourceId: tenant._id, status: body.status });
    } else if (["suspended", "archived"].includes(before.status)) {
      emitDomain("TENANT_REACTIVATED", { tenantId: tenant._id, resource: "tenant", resourceId: tenant._id, status: body.status });
    }
  }
  return tenant;
}

async function storeDisplayName(tenant) {
  try {
    const { getCachedSetting } = await import("../settings/service.js");
    const value = String((await getCachedSetting("tenant", tenant._id, "store.displayName", "")) || "").trim();
    return value || tenant.name;
  } catch {
    return tenant.name;
  }
}

async function publicStorefront(tenant) {
  return {
    _id: tenant._id,
    id: tenant._id,
    name: tenant.name,
    displayName: await storeDisplayName(tenant),
    slug: tenant.slug,
    status: tenant.status,
    branding: tenant.branding,
  };
}

/**
 * Public store info by id or slug (active/trial stores only): { id, name, displayName, slug,
 * branding, pickupCity, deliveryZones: [{ name, etaDaysMin, etaDaysMax }] }.
 */
export async function getPublicStore(idOrSlug) {
  const key = String(idOrSlug || "").trim();
  const byId = /^[a-f\d]{24}$/i.test(key);
  const tenant = await Tenant.findOne({
    ...(byId ? { _id: key } : { slug: key.toLowerCase() }),
    status: { $in: ["active", "trial"] },
  }).lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  return {
    ...(await publicStorefront(tenant)),
    pickupCity: tenant.pickupAddress?.city || "",
    deliveryZones: (tenant.deliveryZones || []).map((z) => ({ name: z.name, etaDaysMin: z.etaDaysMin, etaDaysMax: z.etaDaysMax })),
  };
}

const PUBLIC_STORE_STATUSES = ["active", "trial"];
const PUBLIC_STORE_SORTS = ["name", "newest", "rating", "products"];
/** In-memory sorts (rating / products) consider at most this many stores. */
const PUBLIC_STORE_CAP = 2000;

/** Published-catalogue stats per store in ONE aggregation: Map(id -> { productCount, rating, ratingCount, deliveryModes }). */
async function storeCatalogStats(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = await Product.aggregate([
    { $match: { tenantId: { $in: ids }, status: "published", enabled: { $ne: false } } },
    {
      $group: {
        _id: "$tenantId",
        productCount: { $sum: 1 },
        ratingCount: { $sum: { $ifNull: ["$ratingCount", 0] } },
        ratingSum: { $sum: { $multiply: [{ $ifNull: ["$ratingAvg", 0] }, { $ifNull: ["$ratingCount", 0] }] } },
        modes: { $addToSet: "$deliveryModes" },
      },
    },
  ]);
  for (const row of rows) {
    const modes = new Set((row.modes || []).flat().filter(Boolean));
    if (!modes.size) modes.add("delivery_partner"); // product default
    map.set(String(row._id), {
      productCount: row.productCount,
      rating: row.ratingCount > 0 ? Math.round((row.ratingSum / row.ratingCount) * 10) / 10 : null,
      ratingCount: row.ratingCount,
      deliveryModes: FULFILLMENT_MODES.filter((m) => modes.has(m)),
    });
  }
  return map;
}

/**
 * Public store directory (no auth): active and trial stores only. Query: q (name / slug), city,
 * state, sort=name|newest|rating|products (default name), page, limit (≤ 100).
 * Row: { id, name, displayName, slug, city, state, logo, rating, ratingCount, productCount,
 * deliveryModes, minOrderValue }. `rating` = review-weighted average of the store's published
 * products (null without reviews); `deliveryModes` = union over its published products.
 */
export async function listPublicStores(query = {}) {
  const { page, limit, skip } = paginate(query);
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const text = (v) => String(one(v) ?? "").trim().slice(0, 80);
  const sort = PUBLIC_STORE_SORTS.includes(text(query.sort)) ? text(query.sort) : "name";
  const filter = { status: { $in: PUBLIC_STORE_STATUSES } };
  const q = text(query.q);
  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    filter.$or = [{ name: rx }, { slug: rx }];
  }
  const city = text(query.city);
  if (city) filter["pickupAddress.city"] = new RegExp(`^${escapeRegex(city)}$`, "i");
  const state = text(query.state);
  if (state) filter["pickupAddress.state"] = new RegExp(`^${escapeRegex(state)}$`, "i");

  const fields = "name slug branding.logo pickupAddress.city pickupAddress.state orderRules.minOrderValue createdAt";
  let tenants;
  let total;
  let stats;
  if (sort === "rating" || sort === "products") {
    const all = await Tenant.find(filter).select(fields).sort({ name: 1, _id: 1 }).limit(PUBLIC_STORE_CAP).lean();
    stats = await storeCatalogStats(all.map((t) => t._id));
    const key = (t) => stats.get(String(t._id)) || { productCount: 0, rating: null, ratingCount: 0 };
    all.sort((a, b) =>
      sort === "rating"
        ? (key(b).rating ?? -1) - (key(a).rating ?? -1) || key(b).ratingCount - key(a).ratingCount || a.name.localeCompare(b.name)
        : key(b).productCount - key(a).productCount || a.name.localeCompare(b.name)
    );
    total = all.length;
    tenants = all.slice(skip, skip + limit);
  } else {
    const order = sort === "newest" ? { createdAt: -1, _id: -1 } : { name: 1, _id: 1 };
    [tenants, total] = await Promise.all([
      Tenant.find(filter).select(fields).sort(order).skip(skip).limit(limit).lean(),
      Tenant.countDocuments(filter),
    ]);
    stats = await storeCatalogStats(tenants.map((t) => t._id));
  }
  const names = tenants.length
    ? await Settings.find({ scope: "tenant", tenantId: { $in: tenants.map((t) => t._id) }, key: "store.displayName" }).select("tenantId value").lean()
    : [];
  const nameById = new Map(names.map((row) => [String(row.tenantId), String(row.value || "").trim()]));
  const data = tenants.map((t) => {
    const st = stats.get(String(t._id)) || { productCount: 0, rating: null, ratingCount: 0, deliveryModes: [] };
    return {
      id: t._id,
      name: t.name,
      displayName: nameById.get(String(t._id)) || t.name,
      slug: t.slug,
      city: t.pickupAddress?.city || "",
      state: t.pickupAddress?.state || "",
      logo: t.branding?.logo || "",
      rating: st.rating,
      ratingCount: st.ratingCount,
      productCount: st.productCount,
      deliveryModes: st.deliveryModes,
      minOrderValue: Number(t.orderRules?.minOrderValue) || 0,
    };
  });
  const out = paginated(data, total, { page, limit });
  out.meta.sort = sort;
  return out;
}

/** Staff: their tenant. Buyers: public storefront info of their home tenant (or null). */
export async function getMyTenant(req) {
  const tenantId = req.user?.tenantId?._id || req.user?.tenantId;
  if (tenantId) return getTenant(tenantId);
  if (req.isBuyer && req.user?.homeTenantId) {
    const tenant = await Tenant.findById(req.user.homeTenantId);
    return tenant ? await publicStorefront(tenant) : null;
  }
  throw new AppError(400, "No tenant on this account", "TENANT_REQUIRED");
}

export async function updateMyTenant(req, body) {
  const tenantId = req.user?.tenantId?._id || req.user?.tenantId;
  if (!tenantId || req.isBuyer) throw new AppError(403, "Staff access required", "FORBIDDEN");
  const allowed = {
    name: body.name,
    branding: body.branding,
    businessProfile: body.businessProfile,
    taxSettings: body.taxSettings,
    orderRules: body.orderRules,
    deliveryZones: body.deliveryZones,
    pickupAddress: body.pickupAddress,
    notificationPreferences: body.notificationPreferences,
  };
  const patch = Object.fromEntries(Object.entries(allowed).filter(([, v]) => v !== undefined));
  return updateTenant(tenantId, patch);
}
