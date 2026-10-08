import crypto from "crypto";
import mongoose from "mongoose";
import { Product } from "./product.model.js";
import { ProductVariant } from "./variant.model.js";
import { RestockAlert } from "./restockAlert.model.js";
import { Inventory } from "../inventory/inventory.model.js";
import { AppError } from "../../utils/AppError.js";
import { links } from "../../utils/links.js";
import { persistAndPush } from "../notifications/service.js";
import { sendMail } from "../notifications/mailer.js";
import { findPublicProduct, variantStockMap, activeTenantIds } from "./service.js";

const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;
const RESEND_AFTER_MS = 10 * 60 * 1000;
const NOTIFIED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 500;

const hashToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** Always the storefront page (/restock/confirm?token=); it calls GET /api/v1/products/restock-alerts/confirm. */
function confirmLink(token) {
  return links.restockConfirm(token);
}

function productLink(product) {
  return links.product(product.slug);
}

async function resolveVariant(product, variantId) {
  if (!variantId) return null;
  const variant = await ProductVariant.findOne({
    _id: variantId,
    productId: product._id,
    status: { $ne: "archived" },
  }).select("_id");
  if (!variant) throw new AppError(400, "Variant not found for this product", "VALIDATION_ERROR");
  return variant._id;
}

/**
 * Subscribe to a back-in-stock alert. Signed-in users are subscribed directly; guests get a
 * double-opt-in email and are only notified after confirming. The response never reveals
 * whether an address was already subscribed.
 */
export async function subscribeRestock(req, slug, { email, variantId } = {}) {
  const product = await findPublicProduct(slug);
  if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
  const variant = await resolveVariant(product, variantId);
  const userId = req.user?._id || null;

  if (userId) {
    const filter = { productId: product._id, variantId: variant, userId };
    const update = {
      $set: { tenantId: product.tenantId, confirmed: true, notifiedAt: null, expiresAt: null },
      $setOnInsert: { email: "" },
    };
    let doc;
    try {
      doc = await RestockAlert.findOneAndUpdate(filter, update, { upsert: true, new: true });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      doc = await RestockAlert.findOneAndUpdate(filter, update, { new: true }); // lost an upsert race
    }
    return { ok: true, subscribed: true, pendingConfirmation: false, id: doc?._id };
  }

  const mail = String(email || "").trim().toLowerCase();
  if (!mail) throw new AppError(400, "Email is required", "VALIDATION_ERROR");

  const filter = { productId: product._id, variantId: variant, email: mail, userId: null };
  const existing = await RestockAlert.findOne(filter).lean();
  if (existing?.confirmed && !existing.notifiedAt) {
    return { ok: true, subscribed: false, pendingConfirmation: true };
  }
  if (existing && !existing.confirmed && existing.confirmSentAt && Date.now() - existing.confirmSentAt.getTime() < RESEND_AFTER_MS) {
    return { ok: true, subscribed: false, pendingConfirmation: true };
  }

  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const set = {
    tenantId: product.tenantId,
    confirmed: false,
    confirmTokenHash: hashToken(token),
    confirmSentAt: now,
    notifiedAt: null,
    expiresAt: new Date(now.getTime() + CONFIRM_TTL_MS),
  };
  try {
    await RestockAlert.updateOne(filter, { $set: set }, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    return { ok: true, subscribed: false, pendingConfirmation: true }; // concurrent request already handled it
  }
  await sendMail({
    to: mail,
    subject: `Confirm your back-in-stock alert for ${product.name}`,
    text:
      `Someone (hopefully you) asked to be emailed when "${product.name}" is back in stock.\n\n` +
      `Confirm within 48 hours: ${confirmLink(token)}\n\n` +
      `If this wasn't you, ignore this email and nothing will be sent.`,
  }).catch((err) => console.error("restock confirm email failed", err.message));
  return { ok: true, subscribed: false, pendingConfirmation: true };
}

/** Redeem a double-opt-in token. */
export async function confirmRestock(token) {
  const doc = await RestockAlert.findOneAndUpdate(
    { confirmTokenHash: hashToken(String(token || "")), confirmed: false, expiresAt: { $gt: new Date() } },
    { $set: { confirmed: true, confirmTokenHash: null, expiresAt: null } },
    { new: true }
  );
  if (!doc) throw new AppError(400, "This confirmation link is invalid or has expired", "INVALID_TOKEN");
  return { ok: true, confirmed: true };
}

async function currentStock(variantId) {
  const [row] = await Inventory.aggregate([
    { $match: { variantId: new mongoose.Types.ObjectId(String(variantId)) } },
    { $group: { _id: null, qty: { $sum: "$available" } } },
  ]);
  return row?.qty || 0;
}

/**
 * Notify subscribers of a variant that is sellable again. Each alert is claimed atomically
 * (notifiedAt null → now) before sending, so concurrent calls / instances never double-notify.
 * Only alerts for this variant, or product-level alerts (variantId null), are notified.
 * Safe to call whenever stock may have returned (adjustment, cancel/release, return).
 */
export async function notifyRestock({ tenantId = null, variantId } = {}) {
  if (!variantId) return { notified: 0 };
  const variant = await ProductVariant.findOne({
    _id: variantId,
    ...(tenantId ? { tenantId } : {}),
    status: "active",
  }).select("productId sku tenantId");
  if (!variant) return { notified: 0 };
  const product = await Product.findOne({ _id: variant.productId, status: "published", enabled: { $ne: false } }).select(
    "name sku slug tenantId"
  );
  if (!product) return { notified: 0 };
  if ((await currentStock(variant._id)) <= 0) return { notified: 0 };

  let notified = 0;
  for (let i = 0; i < MAX_PER_RUN; i += 1) {
    const now = new Date();
    const alert = await RestockAlert.findOneAndUpdate(
      {
        productId: product._id,
        confirmed: true,
        notifiedAt: null,
        $or: [{ variantId: variant._id }, { variantId: null }],
      },
      { $set: { notifiedAt: now, expiresAt: new Date(now.getTime() + NOTIFIED_RETENTION_MS) } },
      { sort: { createdAt: 1 }, new: true }
    );
    if (!alert) break;
    try {
      const title = "Back in stock";
      const body = `${product.name} is back in stock. Buy again now.`;
      if (alert.userId) {
        await persistAndPush({
          userId: alert.userId,
          tenantId: null, // buyer notification: don't broadcast to the seller's room
          event: "RESTOCK_AVAILABLE",
          title,
          body,
          data: { productId: product._id, slug: product.slug, variantId: variant._id, tenantId: product.tenantId },
        });
      } else if (alert.email) {
        await sendMail({
          to: alert.email,
          subject: `${product.name} is back in stock`,
          text: `${body}\n\n${productLink(product)}\n\nYou received this because you asked for a back-in-stock alert. This is a one-time email.`,
        });
      }
      notified += 1;
    } catch (err) {
      // At-most-once delivery: the alert stays claimed; log for follow-up.
      console.error("restock notify failed", String(alert._id), err.message);
    }
  }
  return { notified };
}

/** Back-compat wrapper (inventory/service.js calls this after an inward adjustment). */
export async function notifyRestockForVariant(variantId) {
  return notifyRestock({ variantId });
}

/* ------------------------------------------------------------------ buyer's own alerts */

/** Alerts that belong to this user: their signed-in alerts plus guest alerts for their verified email. */
function ownAlertsFilter(user) {
  const or = [{ userId: user._id }];
  if (user.email && user.emailVerified !== false) or.push({ userId: null, email: String(user.email).toLowerCase() });
  return { $or: or };
}

function alertStatus(alert) {
  if (alert.notifiedAt) return "notified";
  if (!alert.confirmed) return "pending_confirmation";
  return "active";
}

/**
 * GET /products/restock-alerts/mine — the buyer's back-in-stock alerts, newest first, with the
 * product, the variant (null = any variant) and the current stock. Paginated (?page=&limit=,
 * ?status=active|pending_confirmation|notified).
 */
export async function listMyRestockAlerts(user, { page = 1, limit = 20, status } = {}) {
  const filter = ownAlertsFilter(user);
  if (status === "notified") filter.notifiedAt = { $ne: null };
  else if (status === "active") Object.assign(filter, { notifiedAt: null, confirmed: true });
  else if (status === "pending_confirmation") Object.assign(filter, { notifiedAt: null, confirmed: false });
  const pageNum = Math.max(1, Number(page) || 1);
  const size = Math.min(100, Math.max(1, Number(limit) || 20));
  const [rows, total] = await Promise.all([
    RestockAlert.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((pageNum - 1) * size)
      .limit(size)
      .lean(),
    RestockAlert.countDocuments(filter),
  ]);
  const productIds = [...new Set(rows.map((r) => String(r.productId)))];
  const [allProducts, allVariants, activeIds] = await Promise.all([
    Product.find({ _id: { $in: productIds } }).select("name slug sku images status enabled tenantId").lean(),
    ProductVariant.find({ productId: { $in: productIds }, status: { $ne: "archived" } })
      .select("productId sku attributes sellingPrice listPrice status")
      .lean(),
    activeTenantIds(),
  ]);
  // Storefront visibility: details only for published, enabled products of an active store. Others
  // (draft, disabled, archived, suspended store) are listed as unavailable without product details.
  const activeSet = new Set(activeIds.map(String));
  const products = allProducts.filter(
    (p) => p.status === "published" && p.enabled !== false && activeSet.has(String(p.tenantId))
  );
  const visible = new Set(products.map((p) => String(p._id)));
  const variants = allVariants.filter((v) => visible.has(String(v.productId)));
  const stock = await variantStockMap(variants.map((v) => v._id));
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const variantById = new Map(variants.map((v) => [String(v._id), v]));
  const stockByVariant = new Map(variants.map((v) => [String(v._id), stock.get(String(v._id))?.available || 0]));
  // Product-level stock (alerts on "any variant") = sum over its active variants.
  const productStock = new Map();
  for (const v of variants) {
    if (v.status !== "active") continue;
    const pid = String(v.productId);
    productStock.set(pid, (productStock.get(pid) || 0) + (stockByVariant.get(String(v._id)) || 0));
  }
  const data = rows.map((alert) => {
    const product = productById.get(String(alert.productId));
    const variant = alert.variantId ? variantById.get(String(alert.variantId)) : null;
    const available = alert.variantId ? stockByVariant.get(String(alert.variantId)) || 0 : productStock.get(String(alert.productId)) || 0;
    const firstImage = (list) => (Array.isArray(list) && list.length ? String(list[0] || "") : "");
    return {
      id: alert._id,
      status: alertStatus(alert),
      productId: alert.productId,
      variantId: alert.variantId || null,
      tenantId: alert.tenantId,
      createdAt: alert.createdAt,
      notifiedAt: alert.notifiedAt || null,
      channel: alert.userId ? "account" : "email",
      product: product
        ? {
            id: product._id,
            name: product.name,
            slug: product.slug,
            sku: product.sku,
            image: firstImage(product.images),
            available: true,
          }
        : null,
      unavailable: !product,
      variant: variant
        ? {
            id: variant._id,
            sku: variant.sku,
            packSize: variant.attributes?.packSize || variant.attributes?.size || "",
            attributes: variant.attributes || {},
            sellingPrice: variant.sellingPrice,
            listPrice: variant.listPrice,
            active: variant.status === "active",
          }
        : null,
      inStock: available > 0,
    };
  });
  return { data, meta: { total, page: pageNum, limit: size, pages: Math.max(1, Math.ceil(total / size)) } };
}

/** DELETE /products/restock-alerts/:id — unsubscribe. 404 for alerts that are not the caller's. */
export async function deleteMyRestockAlert(user, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(404, "Alert not found", "NOT_FOUND");
  const doc = await RestockAlert.findOneAndDelete({ _id: id, ...ownAlertsFilter(user) });
  if (!doc) throw new AppError(404, "Alert not found", "NOT_FOUND");
  return { ok: true, id: doc._id, deleted: true };
}
