import mongoose from "mongoose";
import { Category } from "./category.model.js";
import { Product } from "./product.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { catalogVersion } from "../search/catalogVersion.js";
import { emitDomain } from "../../utils/events.js";
import { logger } from "../../utils/logger.js";

/**
 * FSSAI compliance for food categories.
 * - A category requires FSSAI when it (or any ancestor) has `requiresFssai: true`.
 * - Buyer-facing product / store / PDP responses expose the seller's FSSAI number for such products.
 * - Daily job (runFssaiCompliance): reminders 30 / 7 / 1 days before expiry (FSSAI_EXPIRING); on
 *   expiry the store's food products are hidden: `enabled: false` + `complianceHold: "fssai_expired"`
 *   (never deleted). Renewal (admin updates tenant.kyc.fssai with a future expiry) releases them.
 */

export const FSSAI_HOLD = "fssai_expired";
export const FSSAI_REMINDER_DAYS = [30, 7, 1];
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 30 * 1000;
let cache = { at: 0, version: -1, ids: null };

/** Set (strings) of category ids that require FSSAI (flagged or under a flagged ancestor). Cached. */
export async function foodCategoryIds() {
  if (cache.ids && cache.version === catalogVersion() && Date.now() - cache.at < CACHE_TTL_MS) return cache.ids;
  const version = catalogVersion();
  const rows = await Category.find({}).select("_id parentId requiresFssai").lean();
  const byId = new Map(rows.map((c) => [String(c._id), c]));
  const ids = new Set();
  for (const c of rows) {
    let cur = c;
    for (let depth = 0; cur && depth < 20; depth += 1) {
      if (cur.requiresFssai) {
        ids.add(String(c._id));
        break;
      }
      cur = cur.parentId ? byId.get(String(cur.parentId)) : null;
    }
  }
  cache = { at: Date.now(), version, ids };
  return ids;
}

export function invalidateFoodCategories() {
  cache = { at: 0, version: -1, ids: null };
}

export async function isFoodCategory(categoryId) {
  if (!categoryId) return false;
  const id = categoryId._id || categoryId;
  return (await foodCategoryIds()).has(String(id));
}

/** Buyer-facing { number } of the store's FSSAI licence for a food product, else null. */
export async function fssaiForProduct(product, tenant) {
  const number = String(tenant?.kyc?.fssai?.number || "").trim();
  if (!number || !(await isFoodCategory(product?.categoryId))) return null;
  return { number };
}

/** Hide the store's (enabled) food products while its FSSAI licence is expired. Returns count. */
export async function holdFoodProducts(tenantId) {
  const food = [...(await foodCategoryIds())].map((id) => new mongoose.Types.ObjectId(id));
  if (!food.length) return 0;
  const res = await Product.updateMany(
    { tenantId, categoryId: { $in: food }, enabled: { $ne: false } },
    { $set: { enabled: false, complianceHold: FSSAI_HOLD } }
  );
  return res.modifiedCount || 0;
}

/** Licence renewed: re-enable the products the hold disabled and clear the hold. Returns count. */
export async function releaseFssaiHold(tenantId) {
  const res = await Product.updateMany({ tenantId, complianceHold: FSSAI_HOLD }, { $set: { enabled: true, complianceHold: "" } });
  await Tenant.updateOne({ _id: tenantId }, { $set: { "compliance.fssaiHoldAt": null } });
  return res.modifiedCount || 0;
}

/** Is the store currently under an FSSAI hold (expired licence)? */
export async function tenantUnderFssaiHold(tenantId) {
  const t = await Tenant.findById(tenantId).select("compliance.fssaiHoldAt kyc.fssai").lean();
  if (!t) return false;
  const at = t.kyc?.fssai?.expiresAt;
  return Boolean(t.compliance?.fssaiHoldAt || (t.kyc?.fssai?.number && at && new Date(at) <= new Date()));
}

/**
 * Daily FSSAI job. Per store with a licence expiry (not archived):
 * - expiry in the future: lift a leftover hold; send the reminder for the smallest threshold
 *   (30/7/1 days) reached and not yet sent for this expiry date (FSSAI_EXPIRING).
 * - expired: hide food products (also new ones created since), mark compliance.fssaiHoldAt once
 *   and emit FSSAI_EXPIRED.
 */
export async function runFssaiCompliance({ now = new Date(), limit = 5000 } = {}) {
  const tenants = await Tenant.find({ "kyc.fssai.expiresAt": { $type: "date" }, status: { $ne: "archived" } })
    .select("_id kyc.fssai compliance status")
    .limit(limit)
    .lean();
  let reminders = 0;
  let held = 0;
  let products = 0;
  let released = 0;
  for (const t of tenants) {
    try {
      const expiresAt = new Date(t.kyc.fssai.expiresAt);
      const msLeft = expiresAt.getTime() - now.getTime();
      if (msLeft > 0) {
        if (t.compliance?.fssaiHoldAt) {
          released += await releaseFssaiHold(t._id);
          emitDomain("FSSAI_RENEWED", { tenantId: t._id, resource: "tenant", resourceId: t._id, expiresAt });
        }
        const daysLeft = Math.ceil(msLeft / DAY_MS);
        const sent = new Set(
          (t.compliance?.fssaiReminders || [])
            .filter((r) => r.expiresAt && new Date(r.expiresAt).getTime() === expiresAt.getTime())
            .map((r) => r.days)
        );
        const due = FSSAI_REMINDER_DAYS.filter((d) => daysLeft <= d);
        const smallest = due.length ? Math.min(...due) : null;
        if (smallest != null && !sent.has(smallest)) {
          // Mark every threshold already passed as sent so a late start sends one reminder only.
          const rows = due.filter((d) => !sent.has(d)).map((d) => ({ days: d, expiresAt, sentAt: now }));
          const res = await Tenant.updateOne(
            { _id: t._id, "kyc.fssai.expiresAt": expiresAt, "compliance.fssaiReminders": { $not: { $elemMatch: { days: smallest, expiresAt } } } },
            { $push: { "compliance.fssaiReminders": { $each: rows } } }
          );
          if (res.modifiedCount) {
            reminders += 1;
            emitDomain("FSSAI_EXPIRING", { tenantId: t._id, resource: "tenant", resourceId: t._id, daysLeft, expiresAt, number: t.kyc.fssai.number });
          }
        }
        continue;
      }
      products += await holdFoodProducts(t._id);
      if (!t.compliance?.fssaiHoldAt) {
        const res = await Tenant.updateOne({ _id: t._id, "compliance.fssaiHoldAt": null }, { $set: { "compliance.fssaiHoldAt": now } });
        if (res.modifiedCount) {
          held += 1;
          emitDomain("FSSAI_EXPIRED", { tenantId: t._id, resource: "tenant", resourceId: t._id, expiresAt, number: t.kyc.fssai.number });
        }
      }
    } catch (err) {
      logger.error("fssai compliance failed", { tenantId: String(t._id), err: err.message });
    }
  }
  return { checked: tenants.length, reminders, held, productsHidden: products, productsReleased: released };
}
