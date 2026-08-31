import { Cart } from "./cart.model.js";
import { Product } from "../catalog/product.model.js";
import { ProductVariant } from "../catalog/variant.model.js";
import { AppError } from "../../utils/AppError.js";
import { Coupon } from "../pricing/coupon.model.js";
import { calculateLinePrice, applyCoupon, previewCoupon, round2 } from "../pricing/engine.js";
import { pickWarehouseForVariant, availableForVariant } from "../inventory/service.js";
import { checkServiceability, etaWindow } from "../location/service.js";

export async function getOrCreateCart(userId, guestKey) {
  const filter = userId ? { userId } : { guestKey };
  let cart = await Cart.findOne(filter);
  if (!cart) cart = await Cart.create(filter);
  return cart;
}

function validateWholesale(product, qty) {
  const w = product.wholesale || {};
  const moq = w.moq || 1;
  const pack = w.packMultiple || 1;
  if (qty < moq) throw new AppError(400, `MOQ is ${moq}`, "MOQ");
  if (w.maxQty && qty > w.maxQty) throw new AppError(400, `Max qty is ${w.maxQty}`, "MAX_QTY");
  if (pack > 1 && qty % pack !== 0) {
    throw new AppError(400, `Quantity must be a multiple of ${pack}`, "PACK_MULTIPLE");
  }
}

export async function addItem(userId, guestKey, { variantId, qty }) {
  const variant = await ProductVariant.findById(variantId);
  if (!variant || variant.status !== "active") throw new AppError(404, "Variant not found", "NOT_FOUND");
  const product = await Product.findById(variant.productId);
  if (!product || product.status !== "published") {
    throw new AppError(400, "Product is not available", "UNAVAILABLE");
  }
  const moq = product.wholesale?.moq || 1;
  const cart = await getOrCreateCart(userId, guestKey);
  const existing = cart.items.find((i) => String(i.variantId) === String(variantId));
  const nextQty = existing ? existing.qty + qty : Math.max(qty, moq);
  validateWholesale(product, nextQty);
  const stock = await availableForVariant(variant._id);
  if (stock.available < nextQty) throw new AppError(409, "Insufficient stock", "INSUFFICIENT_STOCK");

  if (existing) {
    existing.qty = nextQty;
  } else {
    cart.items.push({
      tenantId: product.tenantId,
      productId: product._id,
      variantId: variant._id,
      qty: nextQty,
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
  const product = await Product.findById(item.productId);
  validateWholesale(product, qty);
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

export async function quoteCart(cart, buyerId, address = null, { strictCoupon = false } = {}) {
  const lines = [];
  for (const item of cart.items) {
    const variant = await ProductVariant.findById(item.variantId);
    const product = await Product.findById(item.productId);
    if (!variant || !product || product.status !== "published") {
      throw new AppError(400, "A cart item is no longer available", "UNAVAILABLE");
    }
    validateWholesale(product, item.qty);
    const priced = await calculateLinePrice({
      variant,
      product,
      qty: item.qty,
      buyerId,
      tenantId: item.tenantId,
    });
    const stock = await pickWarehouseForVariant(item.tenantId, variant._id, address?.postalCode);
    if (!stock || stock.available < item.qty) {
      throw new AppError(409, `Insufficient stock for ${variant.sku}`, "INSUFFICIENT_STOCK");
    }
    lines.push({
      cartItemId: item._id,
      tenantId: item.tenantId,
      productId: product._id,
      variantId: variant._id,
      sku: variant.sku,
      slug: String(product.sku || "").toLowerCase(),
      name: product.name,
      image: product.images?.[0] || "",
      pack: variant.attributes?.packSize || variant.attributes?.size || "",
      attributes: variant.attributes,
      warehouseId: stock.warehouseId?._id || stock.warehouseId,
      wholesale: product.wholesale,
      qty: item.qty,
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
  for (const [tenantId, items] of byTenant) {
    let subtotal = round2(items.reduce((s, i) => s + i.lineSubtotal, 0));
    let tax = round2(items.reduce((s, i) => s + i.tax, 0));
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
      } catch (err) {
        if (strictCoupon) throw err;
        coupon = null;
        couponDiscount = 0;
      }
    }

    let deliveryFee = 0;
    let serviceability = { serviceable: true };
    let eta = null;
    if (address) {
      serviceability = await checkServiceability({
        tenantId,
        postalCode: address.postalCode,
        latitude: address.latitude,
        longitude: address.longitude,
      });
      if (!serviceability.serviceable) {
        throw new AppError(400, "Delivery not available for this address", "NOT_SERVICEABLE");
      }
      deliveryFee = serviceability.zone?.deliveryFee || 0;
      const lead = Math.max(...items.map((i) => i.wholesale?.leadTimeDays || 0));
      eta = etaWindow(serviceability.zone, lead);
    }

    const total = round2(subtotal - couponDiscount + tax + deliveryFee);
    groups.push({
      tenantId,
      items,
      subtotal,
      couponCode: coupon?.code || "",
      couponDiscount,
      tax,
      deliveryFee,
      total,
      serviceability,
      eta,
    });
  }

  const itemCount = lines.reduce((n, i) => n + i.qty, 0);
  const subtotal = round2(groups.reduce((s, g) => s + g.subtotal, 0));
  const tax = round2(groups.reduce((s, g) => s + g.tax, 0));
  const deliveryFee = round2(groups.reduce((s, g) => s + g.deliveryFee, 0));
  const couponDiscount = round2(groups.reduce((s, g) => s + g.couponDiscount, 0));
  return {
    cartId: cart._id,
    couponCode: couponDiscount ? groups.find((g) => g.couponCode)?.couponCode || cart.couponCode : "",
    groups,
    itemCount,
    subtotal,
    tax,
    deliveryFee,
    couponDiscount,
    grandTotal: round2(groups.reduce((s, g) => s + g.total, 0)),
  };
}

export async function mergeGuestCart(userId, guestKey) {
  const userCart = await getOrCreateCart(userId);
  if (!guestKey) return quoteCart(userCart, userId);
  const guest = await Cart.findOne({ guestKey });
  if (!guest || !guest.items.length || String(guest._id) === String(userCart._id)) {
    return quoteCart(userCart, userId);
  }
  for (const item of guest.items) {
    const existing = userCart.items.find((i) => String(i.variantId) === String(item.variantId));
    if (existing) existing.qty += item.qty;
    else {
      userCart.items.push({
        tenantId: item.tenantId,
        productId: item.productId,
        variantId: item.variantId,
        qty: item.qty,
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
