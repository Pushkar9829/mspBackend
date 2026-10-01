import { Cart } from "./cart.model.js";
import { Product } from "../catalog/product.model.js";
import { ProductVariant } from "../catalog/variant.model.js";
import { AppError } from "../../utils/AppError.js";
import { Coupon } from "../pricing/coupon.model.js";
import {
  calculateLinePrice,
  applyCoupon,
  previewCoupon,
  allocateCoupon,
  applyOffersToVariants,
  loadActiveOffers,
  isBulkProduct,
  round2,
} from "../pricing/engine.js";
import { pickWarehouseForVariant } from "../inventory/service.js";
import { checkServiceability, etaWindow } from "../location/service.js";
import { FULFILLMENT_MODES } from "../../config/constants.js";
import { computePlatformFee, getCommerceSettings, pickPartner } from "../settings/commerce.js";

export function resolveFulfillment(product, requested) {
  const modes = (product?.deliveryModes || []).filter((mode) => FULFILLMENT_MODES.includes(mode));
  const allowed = modes.length ? modes : ["delivery_partner"];
  if (requested && allowed.includes(requested)) return requested;
  if (allowed.includes("delivery_partner")) return "delivery_partner";
  return allowed[0];
}

export async function getOrCreateCart(userId, guestKey) {
  const filter = userId ? { userId } : { guestKey };
  let cart = await Cart.findOne(filter);
  if (!cart) cart = await Cart.create(filter);
  return cart;
}

/** MOQ / max / pack rules only apply to bulk-eligible products. */
export function bulkRules(product) {
  if (!isBulkProduct(product)) return { bulk: false, moq: 1, maxQty: null, pack: 1, minQty: 1 };
  const w = product.wholesale || {};
  const pack = Math.max(1, Number(w.packMultiple) || 1);
  const moq = Math.max(1, Number(w.moq) || 1);
  const max = Number(w.maxQty) > 0 ? Number(w.maxQty) : null;
  return { bulk: true, moq, maxQty: max, pack, minQty: Math.ceil(moq / pack) * pack };
}

/** Bulk lines follow the product's bulk rules; regular lines move one unit at a time. */
export function lineRules(product, bulk) {
  return bulk ? bulkRules(product) : bulkRules(null);
}

/** `productQty` is the total for the product across all its bulk lines in the cart. */
function validateWholesale(product, qty, productQty = qty, bulk = false) {
  if (!bulk) return;
  const rules = bulkRules(product);
  if (!rules.bulk) throw new AppError(400, "This product is not available for bulk buying", "NOT_BULK");
  if (qty < rules.moq) throw new AppError(400, `MOQ is ${rules.moq}`, "MOQ");
  if (rules.pack > 1 && qty % rules.pack !== 0) {
    throw new AppError(400, `Quantity must be a multiple of ${rules.pack}`, "PACK_MULTIPLE");
  }
  if (rules.maxQty != null && productQty > rules.maxQty) {
    throw new AppError(400, `Max qty is ${rules.maxQty} per order`, "MAX_QTY");
  }
}

function bulkQtyInCart(cart, productId, { excludeItemId, extra = 0 } = {}) {
  return (
    cart.items
      .filter(
        (i) =>
          i.bulk &&
          String(i.productId) === String(productId) &&
          String(i._id) !== String(excludeItemId || "")
      )
      .reduce((n, i) => n + i.qty, 0) + extra
  );
}

/** Bulk and regular lines of one variant draw on the same stock. */
function variantQtyInCart(cart, variantId, { excludeItemId } = {}) {
  return cart.items
    .filter((i) => String(i.variantId) === String(variantId) && String(i._id) !== String(excludeItemId || ""))
    .reduce((n, i) => n + i.qty, 0);
}

function sameLine(item, variantId, bulk) {
  return String(item.variantId) === String(variantId) && Boolean(item.bulk) === Boolean(bulk);
}

async function assertStock(tenantId, variant, qty) {
  const stock = await pickWarehouseForVariant(tenantId, variant._id, null, qty);
  if (!stock || stock.available < qty) {
    const left = stock?.available || 0;
    throw new AppError(409, left ? `Only ${left} in stock` : "Out of stock", "INSUFFICIENT_STOCK");
  }
}

export async function addItem(userId, guestKey, { variantId, qty, fulfillmentMode, bulk = false }) {
  const variant = await ProductVariant.findById(variantId);
  if (!variant || variant.status !== "active") throw new AppError(404, "Variant not found", "NOT_FOUND");
  const product = await Product.findById(variant.productId);
  if (!product || product.status !== "published") {
    throw new AppError(400, "Product is not available", "UNAVAILABLE");
  }
  const isBulk = Boolean(bulk);
  const rules = lineRules(product, isBulk);
  const cart = await getOrCreateCart(userId, guestKey);
  const existing = cart.items.find((i) => sameLine(i, variantId, isBulk));
  let nextQty = existing ? existing.qty + qty : qty;
  if (!existing && rules.bulk && nextQty < rules.minQty) nextQty = rules.minQty;
  const others = bulkQtyInCart(cart, product._id, { excludeItemId: existing?._id });
  validateWholesale(product, nextQty, others + nextQty, isBulk);
  await assertStock(
    product.tenantId,
    variant,
    nextQty + variantQtyInCart(cart, variant._id, { excludeItemId: existing?._id })
  );
  const mode = resolveFulfillment(product, fulfillmentMode);

  if (existing) {
    existing.qty = nextQty;
    existing.fulfillmentMode = mode;
  } else {
    cart.items.push({
      tenantId: product.tenantId,
      productId: product._id,
      variantId: variant._id,
      qty: nextQty,
      bulk: isBulk,
      fulfillmentMode: mode,
    });
  }
  await cart.save();
  return quoteCart(cart, userId);
}

export async function removeItem(userId, guestKey, itemId) {
  const cart = await getOrCreateCart(userId, guestKey);
  cart.items = cart.items.filter((i) => String(i._id) !== String(itemId));
  await cart.save();
  return quoteCart(cart, userId);
}

export async function updateQty(userId, guestKey, itemId, qty) {
  const cart = await getOrCreateCart(userId, guestKey);
  const item = cart.items.id(itemId);
  if (!item) throw new AppError(404, "Cart item not found", "NOT_FOUND");
  const [product, variant] = await Promise.all([
    Product.findById(item.productId),
    ProductVariant.findById(item.variantId),
  ]);
  if (!product || !variant || product.status !== "published" || variant.status !== "active") {
    throw new AppError(400, "Product is not available", "UNAVAILABLE");
  }
  const others = bulkQtyInCart(cart, product._id, { excludeItemId: item._id });
  validateWholesale(product, qty, others + qty, item.bulk);
  await assertStock(item.tenantId, variant, qty + variantQtyInCart(cart, variant._id, { excludeItemId: item._id }));
  item.qty = qty;
  await cart.save();
  return quoteCart(cart, userId);
}

export async function applyCartCoupon(userId, guestKey, code) {
  const cart = await getOrCreateCart(userId, guestKey);
  cart.couponCode = code ? String(code).toUpperCase() : "";
  const quote = await quoteCart(cart, userId, null, { strictCoupon: Boolean(cart.couponCode) });
  await cart.save();
  return quote;
}

function issueLine(item, product, variant, issue, code) {
  return {
    cartItemId: item._id,
    tenantId: item.tenantId,
    productId: item.productId,
    variantId: item.variantId,
    sku: variant?.sku || "",
    slug: String(product?.sku || "").toLowerCase(),
    name: product?.name || "Unavailable item",
    image: product?.images?.[0] || "",
    pack: variant?.attributes?.packSize || variant?.attributes?.size || "",
    qty: item.qty,
    bulk: Boolean(item.bulk),
    wholesale: product?.wholesale?.toObject?.() || product?.wholesale || {},
    issue,
    issueCode: code,
  };
}

/**
 * Prices the cart. Lines that can no longer be bought (unpublished, rule violation, no stock)
 * are returned in `unavailable` instead of throwing, so the buyer can always fix the cart.
 */
export async function quoteCart(cart, buyerId, address = null, { strictCoupon = false, deliveryPartnerId } = {}) {
  const lines = [];
  const unavailable = [];
  const offersByTenant = new Map();
  /** Slab prices as charged (capped at selling price, offers applied), same as the catalog shows. */
  async function chargedSlabs(variant, product, tenantId) {
    const key = String(tenantId);
    if (!offersByTenant.has(key)) offersByTenant.set(key, await loadActiveOffers([tenantId]));
    return applyOffersToVariants([variant], offersByTenant.get(key), product, buyerId)[0]?.tierPrices || [];
  }
  for (const item of cart.items) {
    const variant = await ProductVariant.findById(item.variantId);
    const product = await Product.findById(item.productId).populate("brandId", "name");
    if (!variant || !product || product.status !== "published" || variant.status !== "active") {
      unavailable.push(issueLine(item, product, variant, "No longer available", "UNAVAILABLE"));
      continue;
    }
    try {
      validateWholesale(product, item.qty, bulkQtyInCart(cart, product._id), item.bulk);
    } catch (err) {
      unavailable.push(issueLine(item, product, variant, err.message, err.code));
      continue;
    }
    const variantQty = variantQtyInCart(cart, variant._id);
    const stock = await pickWarehouseForVariant(item.tenantId, variant._id, address?.postalCode, variantQty);
    if (!stock || stock.available < variantQty) {
      const left = stock?.available || 0;
      unavailable.push(
        issueLine(item, product, variant, left ? `Only ${left} in stock` : "Out of stock", "INSUFFICIENT_STOCK")
      );
      continue;
    }
    const priced = await calculateLinePrice({
      variant,
      product,
      qty: item.qty,
      buyerId,
      tenantId: item.tenantId,
      bulk: Boolean(item.bulk),
    });
    lines.push({
      cartItemId: item._id,
      tenantId: item.tenantId,
      productId: product._id,
      variantId: variant._id,
      sku: variant.sku,
      slug: String(product.sku || "").toLowerCase(),
      name: product.name,
      brand: product.brandId?.name || "",
      image: product.images?.[0] || "",
      pack: variant.attributes?.packSize || variant.attributes?.size || "",
      attributes: variant.attributes,
      hsn: product.hsn || "",
      warehouseId: stock.warehouseId?._id || stock.warehouseId,
      wholesale: product.wholesale?.toObject?.() || product.wholesale || {},
      bulk: Boolean(item.bulk),
      tierPrices: item.bulk && isBulkProduct(product) ? await chargedSlabs(variant, product, item.tenantId) : [],
      qty: item.qty,
      fulfillmentMode: resolveFulfillment(product, item.fulfillmentMode),
      easyReturn: Boolean(product.easyReturn),
      deliveryModes: product.deliveryModes?.length ? product.deliveryModes : ["delivery_partner"],
      ...priced,
    });
  }

  const byTenant = new Map();
  for (const line of lines) {
    const key = String(line.tenantId);
    if (!byTenant.has(key)) byTenant.set(key, []);
    byTenant.get(key).push(line);
  }

  const groups = [];
  let groupIndex = 0;
  let couponApplied = false;
  let couponError = null;
  for (const [tenantId, items] of byTenant) {
    const subtotal = round2(items.reduce((s, i) => s + i.lineSubtotal, 0));
    let couponDiscount = 0;
    let coupon = null;
    if (cart.couponCode) {
      try {
        const applied = await applyCoupon({
          tenantId,
          code: cart.couponCode,
          buyerId,
          subtotal,
          items,
        });
        coupon = applied.coupon;
        couponDiscount = applied.discount;
        couponApplied = true;
      } catch (err) {
        // Coupons belong to one seller; other sellers' groups simply don't get the discount.
        if (!couponError || couponError.code === "INVALID_COUPON") couponError = err;
        coupon = null;
        couponDiscount = 0;
      }
    }
    allocateCoupon(items, couponDiscount, coupon);
    const tax = round2(items.reduce((s, i) => s + i.tax, 0));
    const taxableValue = round2(items.reduce((s, i) => s + i.taxableValue, 0));

    const hasDelivery = items.some((item) => item.fulfillmentMode === "delivery_partner");
    let deliveryFee = 0;
    let serviceability = { serviceable: true };
    let eta = null;
    if (address && hasDelivery) {
      serviceability = await checkServiceability({
        tenantId,
        postalCode: address.postalCode,
        latitude: address.latitude,
        longitude: address.longitude,
      });
      if (!serviceability.serviceable) {
        throw new AppError(400, "Delivery not available for this address", "NOT_SERVICEABLE");
      }
      deliveryFee = round2(serviceability.zone?.deliveryFee || 0);
      const lead = Math.max(...items.map((i) => (i.bulk ? i.wholesale?.leadTimeDays || 0 : 0)));
      eta = etaWindow(serviceability.zone, lead);
    }

    const commerce = await getCommerceSettings(tenantId);
    const partner = hasDelivery
      ? pickPartner(commerce.deliveryPartners, deliveryPartnerId, commerce.deliveryPartnerChoiceEnabled)
      : null;
    const platformFee = computePlatformFee(commerce, Math.max(0, subtotal - couponDiscount), {
      includeFlat: groupIndex === 0,
    });
    const partnerFee = hasDelivery && partner ? round2(partner.fee) : 0;
    const total = round2(subtotal - couponDiscount + deliveryFee + platformFee + partnerFee);
    groups.push({
      tenantId,
      items,
      subtotal,
      couponCode: coupon?.code || "",
      couponDiscount,
      taxableValue,
      tax,
      hasDelivery,
      deliveryFee,
      platformFee,
      partnerFee,
      deliveryPartner: partner,
      deliveryPartnerMatched: !deliveryPartnerId || !partner || partner.id === deliveryPartnerId,
      deliveryPartnerChoiceEnabled: commerce.deliveryPartnerChoiceEnabled,
      deliveryPartners: commerce.deliveryPartners,
      platformFeeEnabled: commerce.feeEnabled,
      total,
      serviceability,
      eta,
    });
    groupIndex += 1;
  }
  if (strictCoupon && cart.couponCode && groups.length && !couponApplied && couponError) throw couponError;

  const itemCount = lines.reduce((n, i) => n + i.qty, 0);
  const subtotal = round2(groups.reduce((s, g) => s + g.subtotal, 0));
  const tax = round2(groups.reduce((s, g) => s + g.tax, 0));
  const deliveryFee = round2(groups.reduce((s, g) => s + g.deliveryFee, 0));
  const platformFee = round2(groups.reduce((s, g) => s + g.platformFee, 0));
  const partnerFee = round2(groups.reduce((s, g) => s + g.partnerFee, 0));
  const couponDiscount = round2(groups.reduce((s, g) => s + g.couponDiscount, 0));
  const deliveryGroup = groups.find((g) => g.hasDelivery) || groups[0];
  return {
    cartId: cart._id,
    couponCode: couponDiscount ? groups.find((g) => g.couponCode)?.couponCode || cart.couponCode : "",
    groups,
    unavailable,
    itemCount,
    subtotal,
    tax,
    taxInclusive: true,
    hasDelivery: groups.some((g) => g.hasDelivery),
    deliveryFee,
    platformFee,
    partnerFee,
    deliveryPartner: deliveryGroup?.deliveryPartner || null,
    deliveryPartnerChoiceEnabled: Boolean(deliveryGroup?.deliveryPartnerChoiceEnabled),
    deliveryPartners: deliveryGroup?.deliveryPartners || [],
    platformFeeEnabled: groups.some((g) => g.platformFeeEnabled),
    couponDiscount,
    grandTotal: round2(groups.reduce((s, g) => s + g.total, 0)),
    hasBulk: lines.some((line) => line.bulk),
  };
}

/**
 * Merge a guest cart into the user's cart, clamping each line to bulk rules and stock.
 * Lines that cannot be made valid are dropped rather than breaking the user's cart.
 */
export async function mergeGuestCart(userId, guestKey) {
  const userCart = await getOrCreateCart(userId);
  if (!guestKey) return quoteCart(userCart, userId);
  const guest = await Cart.findOne({ guestKey });
  if (!guest || !guest.items.length || String(guest._id) === String(userCart._id)) {
    return quoteCart(userCart, userId);
  }
  for (const item of guest.items) {
    const [product, variant] = await Promise.all([
      Product.findById(item.productId),
      ProductVariant.findById(item.variantId),
    ]);
    if (!product || !variant || product.status !== "published" || variant.status !== "active") continue;
    const isBulk = Boolean(item.bulk);
    if (isBulk && !isBulkProduct(product)) continue;
    const rules = lineRules(product, isBulk);
    const existing = userCart.items.find((i) => sameLine(i, item.variantId, isBulk));
    let qty = (existing?.qty || 0) + item.qty;
    if (rules.bulk && rules.maxQty != null) {
      const others = bulkQtyInCart(userCart, product._id, { excludeItemId: existing?._id });
      qty = Math.min(qty, Math.max(0, rules.maxQty - others));
    }
    const otherLines = variantQtyInCart(userCart, variant._id, { excludeItemId: existing?._id });
    const stock = await pickWarehouseForVariant(item.tenantId, variant._id, null, qty + otherLines);
    qty = Math.min(qty, Math.max(0, (stock?.available || 0) - otherLines));
    if (rules.bulk) {
      qty = Math.floor(qty / rules.pack) * rules.pack;
      if (qty < rules.moq) qty = 0;
    }
    if (qty <= 0) continue;
    if (existing) existing.qty = qty;
    else {
      userCart.items.push({
        tenantId: item.tenantId,
        productId: item.productId,
        variantId: item.variantId,
        qty,
        bulk: isBulk,
        fulfillmentMode: item.fulfillmentMode,
      });
    }
  }
  if (guest.couponCode && !userCart.couponCode) userCart.couponCode = guest.couponCode;
  await userCart.save();
  await Cart.deleteOne({ _id: guest._id });
  return quoteCart(userCart, userId);
}

export async function listCartCoupons(userId, guestKey) {
  const cart = await getOrCreateCart(userId, guestKey);
  const quote = await quoteCart(cart, userId);
  const tenantIds = [...new Set((quote.groups || []).map((g) => g.tenantId))];
  if (!tenantIds.length) return { coupons: [], best: null };

  const docs = await Coupon.find({ tenantId: { $in: tenantIds }, status: "active" }).lean();
  const coupons = [];
  for (const doc of docs) {
    const group = quote.groups.find((g) => String(g.tenantId) === String(doc.tenantId)) || quote.groups[0];
    const preview = await previewCoupon({
      tenantId: doc.tenantId,
      code: doc.code,
      buyerId: userId,
      subtotal: group.subtotal,
      items: group.items,
    });
    coupons.push({
      code: doc.code,
      name: doc.name,
      type: doc.type,
      value: doc.value,
      minCartValue: doc.minCartValue || 0,
      savings: preview.discount,
      eligible: preview.eligible,
      reason: preview.reason,
      best: false,
    });
  }

  coupons.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.savings - a.savings);
  const best = coupons.find((c) => c.eligible) || null;
  if (best) {
    for (const row of coupons) row.best = row.code === best.code;
  }
  return { coupons, best };
}
