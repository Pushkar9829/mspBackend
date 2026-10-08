import mongoose from "mongoose";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { SYSTEM_ROLES } from "../config/constants.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { normalizeAddressStates } from "../modules/location/address.service.js";
import { invalidateSettingCache } from "../modules/settings/service.js";
import { repairDeep, repairMojibake, MOJIBAKE_MARKER_DB } from "../utils/mojibake.js";
import { ensureDefaultCmsPages } from "./cmsDefaults.js";
import { logger } from "../utils/logger.js";

/**
 * Idempotent data migrations for the auth/tenancy model. Cheap; safe on every start.
 * - Buyers are no longer tenant members: tenantId -> homeTenantId.
 * - Accounts created before email verification existed are grandfathered as verified.
 * - Legacy lockout status "locked" -> "active" (lockout is now a temporary lockedUntil only).
 */
export async function runAuthMigrations() {
  const buyerRole = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true }).select("_id");
  if (buyerRole) {
    const res = await User.updateMany({ roleId: buyerRole._id, tenantId: { $ne: null } }, [
      { $set: { homeTenantId: { $ifNull: ["$homeTenantId", "$tenantId"] }, tenantId: null } },
    ]);
    if (res.modifiedCount) logger.info("migrated buyers out of tenant membership", { count: res.modifiedCount });
  }
  const verified = await User.updateMany({ emailVerified: { $exists: false } }, { $set: { emailVerified: true } });
  if (verified.modifiedCount) logger.info("grandfathered email verification", { count: verified.modifiedCount });
  await User.updateMany({ status: "locked" }, { $set: { status: "active" } });
  await User.updateMany({ tokenVersion: { $exists: false } }, { $set: { tokenVersion: 0 } });
}

/**
 * Idempotent storefront data fixes. Cheap; safe on every start.
 * - Settings values (any key/scope) and order delivery-partner snapshots stored double-encoded
 *   ("MSâ‚¹ Delivery" → "MS₹ Delivery"). Only strings with mojibake markers are rewritten.
 * - Default global CMS policy pages (grievance, terms, privacy, refunds, shipping, about) are
 *   inserted when missing; seeded pages an admin has not edited are updated to the current seed
 *   content (seed hash), edited pages are never touched.
 * - Order line items get `slug` / `image` snapshots looked up from their products
 *   (backfillOrderItemSnapshots).
 * - Saved addresses: `state` → full state name, plus `stateCode` (normalizeAddressStates).
 */
export async function runStorefrontMigrations() {
  let settingsFixed = 0;
  const rows = await Settings.find({}).select("_id value").lean();
  for (const row of rows) {
    const { value, changed } = repairDeep(row.value);
    if (!changed) continue;
    await Settings.updateOne({ _id: row._id }, { $set: { value } });
    settingsFixed += 1;
  }
  if (settingsFixed) {
    invalidateSettingCache();
    logger.info("repaired double-encoded settings", { count: settingsFixed });
  }
  let ordersFixed = 0;
  const orders = await Order.find({ "deliveryPartner.name": MOJIBAKE_MARKER_DB }).select("_id deliveryPartner.name").limit(5000).lean();
  for (const order of orders) {
    const name = repairMojibake(order.deliveryPartner.name);
    if (name === order.deliveryPartner.name) continue;
    await Order.updateOne({ _id: order._id }, { $set: { "deliveryPartner.name": name } });
    ordersFixed += 1;
  }
  if (ordersFixed) logger.info("repaired double-encoded order delivery partners", { count: ordersFixed });
  const cms = await ensureDefaultCmsPages({ details: true });
  const orderItems = await backfillOrderItemSnapshots();
  const addressesNormalized = await normalizeAddressStates();
  if (addressesNormalized) logger.info("normalised address states", { count: addressesNormalized });
  return {
    settingsFixed,
    ordersFixed,
    cmsCreated: cms.created,
    cmsUpdated: cms.updated,
    orderItemsBackfilled: orderItems.items,
    addressesNormalized,
  };
}

/** Line items that still need a slug / image snapshot: no slug, "" or the legacy lower-cased SKU; or no image field. */
const ITEM_NEEDS_SNAPSHOT = {
  $expr: {
    $anyElementTrue: [
      {
        $map: {
          input: { $ifNull: ["$items", []] },
          as: "i",
          in: {
            $or: [
              { $eq: [{ $type: "$$i.slug" }, "missing"] },
              { $eq: ["$$i.slug", ""] },
              { $eq: ["$$i.slug", { $toLower: { $ifNull: ["$$i.sku", ""] } }] },
              { $eq: [{ $type: "$$i.image" }, "missing"] },
            ],
          },
        },
      },
    ],
  },
};

function itemNeedsSnapshot(item) {
  return item.slug === undefined || item.slug === "" || item.slug === String(item.sku || "").toLowerCase() || item.image === undefined;
}

/**
 * Idempotent: copy the product's public `slug` and first image onto order line items that lack
 * them (orders placed before checkout snapshotted them, or with the legacy SKU slug), so "Buy
 * again" can link to the product. A line whose product no longer exists gets `slug: null` (and
 * keeps / gets an empty image), so it is not looked at again. Batches of `batch` orders, at most
 * `max` orders per run. Returns { orders, items, unresolved }.
 */
export async function backfillOrderItemSnapshots({ batch = 200, max = 50000 } = {}) {
  let orders = 0;
  let items = 0;
  let unresolved = 0;
  const cursor = Order.find(ITEM_NEEDS_SNAPSHOT).select("_id items._id items.productId items.slug items.sku items.image").limit(max).lean().cursor();
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const productIds = [...new Set(pending.flatMap((o) => o.items.filter(itemNeedsSnapshot).map((i) => String(i.productId))))];
    const products = await Product.find({ _id: { $in: productIds } }).select("slug images").lean();
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const ops = [];
    for (const order of pending) {
      const set = {};
      const arrayFilters = [];
      order.items.forEach((item) => {
        if (!itemNeedsSnapshot(item)) return;
        const product = byId.get(String(item.productId));
        const key = `i${arrayFilters.length}`;
        arrayFilters.push({ [`${key}._id`]: item._id });
        if (product?.slug) set[`items.$[${key}].slug`] = product.slug;
        else {
          set[`items.$[${key}].slug`] = null;
          unresolved += 1;
        }
        if (item.image === undefined || item.image === "" || product) set[`items.$[${key}].image`] = product?.images?.[0] || item.image || "";
        items += 1;
      });
      if (arrayFilters.length) ops.push({ updateOne: { filter: { _id: order._id }, update: { $set: set }, arrayFilters } });
    }
    if (ops.length) await Order.collection.bulkWrite(ops, { ordered: false });
    orders += ops.length;
    pending = [];
  };
  for await (const order of cursor) {
    pending.push(order);
    if (pending.length >= batch) await flush();
  }
  await flush();
  if (items) logger.info("backfilled order item slug/image snapshots", { orders, items, unresolved });
  return { orders, items, unresolved };
}

/** Model.syncIndexes() for every registered model (creates new indexes, drops ones no longer declared). */
export async function syncAllIndexes() {
  for (const name of mongoose.modelNames()) {
    try {
      const dropped = await mongoose.model(name).syncIndexes();
      if (dropped?.length) logger.info("dropped stale indexes", { model: name, dropped });
    } catch (err) {
      logger.error("syncIndexes failed", { model: name, err: err.message });
    }
  }
}

