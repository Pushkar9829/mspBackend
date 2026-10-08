import { Cart } from "./cart.model.js";
import { Product } from "../catalog/product.model.js";
import { ProductVariant } from "../catalog/variant.model.js";
import { AppError } from "../../utils/AppError.js";
import { Coupon } from "../pricing/coupon.model.js";
import { Order } from "../orders/order.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { storeCards } from "../tenants/storeCard.js";
import { activeTenantIds } from "../catalog/service.js";
import {
  calculateLinePrice,
  priceBagCoupon,
  previewCoupon,
  allocateCoupon,
  applyOffersToVariants,
  loadActiveOffers,
  loadBuyerPriceLists,
  feeTaxParts,
  isBulkProduct,
  isBulkQty,
  qtyRules,
  slabProgress,
  pricePerBaseUnit,
  packOf,
  round2,
} from "../pricing/engine.js";
import { StockReservation } from "../inventory/reservation.model.js";
import {
  pickWarehouseForVariant,
  reserve,
  releaseCartHold,
  reownReservation,
} from "../inventory/service.js";
import { checkServiceability, etaWindow } from "../location/service.js";
import { FULFILLMENT_MODES, CART_RESERVATION_MINUTES } from "../../config/constants.js";
import { computePlatformFee, getCommerceSettings, pickPartner } from "../settings/commerce.js";
import { withTransaction, withSession } from "../../utils/transaction.js";

export function resolveFulfillment(product, requested) {
  const modes = (product?.deliveryModes || []).filter((mode) => FULFILLMENT_MODES.includes(mode));
  const allowed = modes.length ? modes : ["delivery_partner"];
  if (requested && allowed.includes(requested)) return requested;
  if (allowed.includes("delivery_partner")) return "delivery_partner";
  return allowed[0];
}

function holdExpiry() {
  return new Date(Date.now() + CART_RESERVATION_MINUTES * 60 * 1000);
}

function cartFilter(userId, guestKey) {
  if (userId) return { userId };
  if (!guestKey) throw new AppError(400, "X-Guest-Key required for guest cart", "GUEST_KEY");
  return { guestKey: String(guestKey) };
}

/** Release every hold a cart's lines own (inside the caller's transaction). */
async function releaseLines(cart, session, note) {
  for (const item of cart.items) {
    if (item.reservationId) await releaseCartHold(item.reservationId, { session, note });
    item.reservationId = null;
    item.reservedQty = 0;
    item.warehouseId = null;
  }
}

/** Carts from before "one line per variant" get their duplicate lines merged on first read. */
async function normalizeLines(cart) {
  if (!hasDuplicateLines(cart)) return cart;
  try {
    await mergeDuplicateLines(cart._id);
  } catch (err) {
    throw cartBusy(err);
  }
  return (await Cart.findById(cart._id)) || cart;
}

export async function getOrCreateCart(userId, guestKey) {
  const filter = cartFilter(userId, guestKey);
  const existing = await Cart.find(filter).sort({ updatedAt: -1 });
  if (existing.length > 1) {
    existing.sort(
      (a, b) => (b.items?.length || 0) - (a.items?.length || 0) || new Date(b.updatedAt) - new Date(a.updatedAt)
    );
    const [keep, ...rest] = existing;
    for (const extra of rest) {
      await withTransaction(async (session) => {
        const doc = await Cart.findById(extra._id).session(session);
        if (!doc) return;
        await releaseLines(doc, session, `cart-dedupe:${doc._id}`);
        await Cart.deleteOne({ _id: doc._id }, { session });
      });
    }
    return normalizeLines(keep);
  }
  if (existing.length === 1) return normalizeLines(existing[0]);
  try {
    return await Cart.create(filter);
  } catch (err) {
    if (err?.code === 11000) {
      const again = await Cart.findOne(filter);
      if (again) return again;
    }
    throw err;
  }
}

/**
 * Quantity rules for a product (one cart line per variant). Kept for callers of the old helper:
 * `{ bulk, moq, maxQty, pack, minQty }` where `minQty` = start of the bulk range.
 */
export function bulkRules(product) {
  const r = qtyRules(product);
  if (!r.bulkEligible) return { bulk: false, moq: 1, maxQty: null, pack: 1, minQty: 1 };
  return { bulk: true, moq: r.moq, maxQty: r.maxQty, pack: r.pack, minQty: r.bulkFrom };
}

/** Derived: a line is a bulk purchase when the product is bulk-eligible and qty is in the bulk range. */
export function lineIsBulk(product, qty) {
  return isBulkQty(product, qty);
}

/**
 * Validate one line's quantity. Pack multiple and per-order max apply only in the bulk range;
 * `productBulkQty` is the product's total across its bulk-range lines (all variants) incl. this one.
 */
function validateQty(product, qty, productBulkQty = qty) {
  const rules = qtyRules(product);
  if (!rules.bulkEligible || qty < rules.bulkFrom) return;
  if (rules.pack > 1 && qty % rules.pack !== 0) {
    throw new AppError(400, `Quantity must be a multiple of ${rules.pack} (bulk from ${rules.bulkFrom})`, "PACK_MULTIPLE");
  }
  if (rules.maxQty != null && productBulkQty > rules.maxQty) {
    throw new AppError(400, `Max qty is ${rules.maxQty} per order`, "MAX_QTY");
  }
}

/** Units of `product` in bulk-range lines of this cart (other lines only; add the line's own qty). */
function bulkQtyInCart(cart, product, { excludeItemId } = {}) {
  return cart.items
    .filter(
      (i) =>
        String(i.productId) === String(product._id) &&
        String(i._id) !== String(excludeItemId || "") &&
        isBulkQty(product, i.qty)
    )
    .reduce((n, i) => n + i.qty, 0);
}

function productBulkTotal(cart, product, item, qty) {
  return bulkQtyInCart(cart, product, { excludeItemId: item?._id }) + (isBulkQty(product, qty) ? qty : 0);
}

/** One line per variant: other lines of the same variant (only present in carts from before the merge). */
function variantQtyInCart(cart, variantId, { excludeItemId } = {}) {
  return cart.items
    .filter((i) => String(i.variantId) === String(variantId) && String(i._id) !== String(excludeItemId || ""))
    .reduce((n, i) => n + i.qty, 0);
}

/**
 * Largest valid quantity <= qty: in the bulk range it is rounded down to the pack multiple and
 * capped by the per-order max (minus `otherBulk` units of other lines); when that falls below the
 * bulk range the line stays a regular purchase just under it.
 */
function clampQty(product, qty, otherBulk = 0) {
  const rules = qtyRules(product);
  if (!rules.bulkEligible || qty < rules.bulkFrom) return Math.max(0, qty);
  let next = qty;
  if (rules.maxQty != null) next = Math.min(next, rules.maxQty - otherBulk);
  next = Math.floor(next / rules.pack) * rules.pack;
  if (next >= rules.bulkFrom) return next;
  return Math.max(0, Math.min(qty, rules.bulkFrom - 1));
}

function sameLine(item, variantId) {
  return String(item.variantId) === String(variantId);
}

function hasDuplicateLines(cart) {
  const seen = new Set();
  for (const item of cart.items || []) {
    const key = String(item.variantId);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * Merge legacy duplicate lines (regular + bulk line of one variant) into one line per variant.
 * The first line keeps its id; the others' holds are released and the merged line takes one
 * hold for the total (kept without a hold when stock is short, so the quote shows the issue).
 */
async function mergeDuplicateLines(cartId) {
  await withTransaction(async (session) => {
    const cart = await Cart.findById(cartId).session(session);
    if (!cart || !hasDuplicateLines(cart)) return;
    const keep = new Map();
    const drop = [];
    for (const item of cart.items) {
      const key = String(item.variantId);
      const first = keep.get(key);
      if (!first) {
        keep.set(key, item);
        continue;
      }
      first.qty += item.qty;
      drop.push(item);
    }
    for (const item of drop) {
      if (item.reservationId) await releaseCartHold(item.reservationId, { session, note: "cart lines merged" });
    }
    const dropIds = new Set(drop.map((i) => String(i._id)));
    cart.items = cart.items.filter((i) => !dropIds.has(String(i._id)));
    for (const item of cart.items) {
      const product = await Product.findById(item.productId).session(session);
      item.bulk = product ? isBulkQty(product, item.qty) : false;
      if (item.reservedQty === item.qty && item.reservationId) continue;
      try {
        await syncLineHold(cart, item, item.qty, null, session);
      } catch (err) {
        if (err.code !== "INSUFFICIENT_STOCK") throw err;
      }
    }
    await cart.save({ session });
  });
}

/** Units this cart already holds per warehouse for a variant (display copies of its reservations). */
function holdMap(cart, variantId, { excludeItemId } = {}) {
  const map = new Map();
  for (const item of cart.items) {
    if (String(item.variantId) !== String(variantId) || !item.warehouseId || !item.reservedQty || !item.reservationId) continue;
    if (excludeItemId && String(item._id) === String(excludeItemId)) continue;
    const key = String(item.warehouseId);
    map.set(key, (map.get(key) || 0) + item.reservedQty);
  }
  return map;
}

function warehouseIdOf(stock) {
  return stock?.warehouseId?._id || stock?.warehouseId || null;
}

/**
 * Make this line own exactly one live hold of `desiredQty` (inside `session`). An existing hold
 * of the right size just gets its expiry refreshed; otherwise it is released and a new one is
 * taken (both in the same transaction, so a failed reserve rolls the release back).
 */
async function syncLineHold(cart, item, desiredQty, postal, session) {
  const owner = { type: "cart", id: item._id, cartId: cart._id };
  let current = null;
  if (item.reservationId) {
    current = await StockReservation.findOne(
      { _id: item.reservationId, status: "held", "owner.type": "cart", "owner.id": item._id },
      null,
      withSession(session)
    );
  }
  if (current && current.qty === desiredQty) {
    await StockReservation.updateOne({ _id: current._id, status: "held" }, { $set: { expiresAt: holdExpiry() } }, withSession(session));
    item.warehouseId = current.warehouseId;
    item.reservedQty = current.qty;
    return current;
  }
  const credit = new Map();
  if (current) credit.set(String(current.warehouseId), current.qty);
  const picked = await pickWarehouseForVariant(item.tenantId, item.variantId, postal, desiredQty, credit, session);
  const pickedId = warehouseIdOf(picked);
  const effective = (picked?.available || 0) + (credit.get(String(pickedId || "")) || 0);
  if (!picked || !pickedId || effective < desiredQty) {
    throw new AppError(409, effective > 0 ? `Only ${effective} in stock` : "Out of stock", "INSUFFICIENT_STOCK");
  }
  if (current) await releaseCartHold(current._id, { session, note: "cart line changed" });
  item.reservationId = null;
  item.reservedQty = 0;
  item.warehouseId = null;
  const hold = await reserve({
    tenantId: item.tenantId,
    warehouseId: pickedId,
    variantId: item.variantId,
    qty: desiredQty,
    owner,
    expiresAt: holdExpiry(),
    reference: `cart:${cart._id}`,
    session,
  });
  item.reservationId = hold._id;
  item.reservedQty = hold.qty;
  item.warehouseId = hold.warehouseId;
  return hold;
}

/** Keep a buyer's holds alive while they are on the checkout page (does not reserve anything new). */
export async function touchCartHolds(cart) {
  const ids = cart.items.map((item) => item.reservationId).filter(Boolean);
  if (!ids.length) return 0;
  const res = await StockReservation.updateMany(
    { _id: { $in: ids }, status: "held", "owner.type": "cart" },
    { $set: { expiresAt: holdExpiry() } }
  );
  return res.modifiedCount || 0;
}

/**
 * Checkout: hand this cart line's hold to an order line. If the hold expired, was taken, or no
 * longer matches the quote (qty/warehouse), it is released and fresh stock is reserved for the
 * order (409 INSUFFICIENT_STOCK when that is impossible). Must run inside the checkout transaction.
 */
export async function transferLineHoldToOrder({ cartItem, orderId, orderItemId, tenantId, warehouseId, variantId, qty, session, reference }) {
  const toOwner = { type: "order", id: orderId, line: orderItemId };
  if (cartItem?.reservationId) {
    const claimed = await reownReservation({
      reservationId: cartItem.reservationId,
      fromOwner: { type: "cart", id: cartItem._id },
      toOwner,
      expect: { qty, warehouseId, variantId },
      reference,
      session,
    });
    if (claimed) return claimed;
    await releaseCartHold(cartItem.reservationId, { session, note: "replaced at checkout" });
  }
  return reserve({ tenantId, warehouseId, variantId, qty, owner: toOwner, reference, session });
}

function cartBusy(err) {
  if (err?.name === "VersionError") {
    return new AppError(409, "Your cart changed in another tab. Refresh and try again.", "CART_CONFLICT");
  }
  return err;
}

/** Run a cart mutation inside a transaction on a freshly loaded cart document. */
async function mutateCart(userId, guestKey, fn) {
  const base = await getOrCreateCart(userId, guestKey);
  try {
    await withTransaction(async (session) => {
      const cart = await Cart.findById(base._id).session(session);
      if (!cart) throw new AppError(404, "Cart not found", "NOT_FOUND");
      await fn(cart, session);
      await cart.save({ session });
    });
  } catch (err) {
    throw cartBusy(err);
  }
  return Cart.findById(base._id);
}

export async function addItem(userId, guestKey, { variantId, qty, fulfillmentMode, bulk = false }) {
  const variant = await ProductVariant.findById(variantId);
  if (!variant || variant.status !== "active") throw new AppError(404, "Variant not found", "NOT_FOUND");
  const product = await Product.findById(variant.productId);
  if (!product || product.status !== "published") {
    throw new AppError(400, "Product is not available", "UNAVAILABLE");
  }
  // `bulk` is only a hint now (one line per variant; bulk is derived from the quantity):
  // asking for bulk on a product that is not bulk-eligible is still rejected, and a new line
  // added from the bulk page starts at the bulk range.
  const rules = qtyRules(product);
  if (bulk && !rules.bulkEligible) {
    throw new AppError(400, "This product is not available for bulk buying", "NOT_BULK");
  }
  const cart = await mutateCart(userId, guestKey, async (doc, session) => {
    let line = doc.items.find((i) => sameLine(i, variantId));
    let nextQty = line ? line.qty + qty : qty;
    if (!line && bulk && nextQty < rules.bulkFrom) nextQty = rules.bulkFrom;
    validateQty(product, nextQty, productBulkTotal(doc, product, line, nextQty));
    const mode = resolveFulfillment(product, fulfillmentMode || line?.fulfillmentMode);
    if (!line) {
      doc.items.push({
        tenantId: product.tenantId,
        productId: product._id,
        variantId: variant._id,
        qty: nextQty,
        bulk: isBulkQty(product, nextQty),
        fulfillmentMode: mode,
      });
      line = doc.items[doc.items.length - 1];
    }
    line.qty = nextQty;
    line.bulk = isBulkQty(product, nextQty);
    line.fulfillmentMode = mode;
    await syncLineHold(doc, line, nextQty, null, session);
  });
  return quoteCart(cart, userId);
}

export async function removeItem(userId, guestKey, itemId) {
  const cart = await mutateCart(userId, guestKey, async (doc, session) => {
    const item = doc.items.id(itemId);
    if (item?.reservationId) await releaseCartHold(item.reservationId, { session, note: "removed from cart" });
    doc.items = doc.items.filter((i) => String(i._id) !== String(itemId));
  });
  return quoteCart(cart, userId);
}

export async function updateQty(userId, guestKey, itemId, qty) {
  return updateItem(userId, guestKey, itemId, { qty });
}

/** Change a line's quantity and/or how it is fulfilled (delivery vs store pickup). */
export async function updateItem(userId, guestKey, itemId, { qty, fulfillmentMode } = {}) {
  const cart = await mutateCart(userId, guestKey, async (doc, session) => {
    const item = doc.items.id(itemId);
    if (!item) throw new AppError(404, "Cart item not found", "NOT_FOUND");
    const [product, variant] = await Promise.all([
      Product.findById(item.productId).session(session),
      ProductVariant.findById(item.variantId).session(session),
    ]);
    if (!product || !variant || product.status !== "published" || variant.status !== "active") {
      throw new AppError(400, "Product is not available", "UNAVAILABLE");
    }
    if (fulfillmentMode) {
      const mode = resolveFulfillment(product, fulfillmentMode);
      if (mode !== fulfillmentMode) {
        throw new AppError(400, "This product doesn’t offer that delivery option", "MODE_UNAVAILABLE");
      }
      item.fulfillmentMode = mode;
    }
    if (qty != null) {
      validateQty(product, qty, productBulkTotal(doc, product, item, qty));
      item.qty = qty;
      item.bulk = isBulkQty(product, qty);
      await syncLineHold(doc, item, qty, null, session);
    }
  });
  return quoteCart(cart, userId);
}

export async function applyCartCoupon(userId, guestKey, code) {
  const cart = await getOrCreateCart(userId, guestKey);
  const next = code ? String(code).toUpperCase() : "";
  const probe = Cart.hydrate(cart.toObject());
  probe.couponCode = next;
  const quote = await quoteCart(probe, userId, null, { strictCoupon: Boolean(next) });
  try {
    await Cart.updateOne({ _id: cart._id }, { $set: { couponCode: next }, $inc: { __v: 1 } });
  } catch (err) {
    throw cartBusy(err);
  }
  return quote;
}

/** Line quantity rules: { min, step, max } for the range qty is in, plus the bulk range. */
function lineQtyRules(product, qty) {
  const r = qtyRules(product, null, qty);
  return { min: r.min, step: r.step, max: r.max, bulkEligible: r.bulkEligible, bulkFrom: r.bulkFrom, bulk: r.bulk };
}

function issueLine(item, product, variant, issue, code) {
  return {
    cartItemId: item._id,
    tenantId: item.tenantId,
    productId: item.productId,
    variantId: item.variantId,
    sku: variant?.sku || "",
    slug: product?.slug || "",
    name: product?.name || "Unavailable item",
    image: product?.images?.[0] || "",
    pack: variant?.attributes?.packSize || variant?.attributes?.size || "",
    qty: item.qty,
    bulk: product ? isBulkQty(product, item.qty) : Boolean(item.bulk),
    rules: product ? lineQtyRules(product, item.qty) : null,
    hold: null,
    wholesale: product?.wholesale?.toObject?.() || product?.wholesale || {},
    issue,
    issueCode: code,
  };
}


/**
 * Prices the cart (read-only: never reserves or releases stock). Lines that can no longer be
 * bought (unpublished, rule violation, no stock) are returned in `unavailable` instead of
 * throwing, so the buyer can always fix the cart.
 */
export async function quoteCart(cart, buyerId, address = null, { strictCoupon = false, deliveryPartnerId } = {}) {
  const priceListsByTenant = await loadBuyerPriceLists(
    cart.items.map((item) => item.tenantId),
    buyerId
  );
  const lines = [];
  const unavailable = [];
  const offersByTenant = new Map();
  /** Slab prices as charged (capped at the account price, offers applied), same as the catalog shows. */
  async function chargedSlabs(variant, product, tenantId) {
    const key = String(tenantId);
    if (!offersByTenant.has(key)) offersByTenant.set(key, await loadActiveOffers([tenantId]));
    const lists = priceListsByTenant.get(key) || [];
    return applyOffersToVariants([variant], offersByTenant.get(key), product, buyerId, lists)[0]?.tierPrices || [];
  }
  // Hold expiry per line (one query for the whole cart).
  const holdIds = cart.items.map((item) => item.reservationId).filter(Boolean);
  const liveHolds = holdIds.length
    ? await StockReservation.find({ _id: { $in: holdIds }, status: "held" }).select("_id expiresAt").lean()
    : [];
  const holdExpiry = new Map(liveHolds.map((row) => [String(row._id), row.expiresAt || null]));
  for (const item of cart.items) {
    const variant = await ProductVariant.findById(item.variantId);
    const product = await Product.findById(item.productId).populate("brandId", "name");
    if (!variant || !product || product.status !== "published" || variant.status !== "active") {
      unavailable.push(issueLine(item, product, variant, "No longer available", "UNAVAILABLE"));
      continue;
    }
    const lineBulk = isBulkQty(product, item.qty);
    try {
      validateQty(product, item.qty, productBulkTotal(cart, product, item, item.qty));
    } catch (err) {
      unavailable.push(issueLine(item, product, variant, err.message, err.code));
      continue;
    }
    const variantQty = variantQtyInCart(cart, variant._id);
    const holds = holdMap(cart, variant._id);
    const fullyHeld = item.reservationId && item.warehouseId && item.reservedQty === item.qty;
    let lineWarehouseId = fullyHeld ? item.warehouseId : null;
    if (!lineWarehouseId) {
      const stock = await pickWarehouseForVariant(item.tenantId, variant._id, address?.postalCode, variantQty, holds);
      const stockId = String(warehouseIdOf(stock) || "");
      const effective = (stock?.available || 0) + (holds.get(stockId) || 0);
      if (!stock || effective < variantQty) {
        const left = Math.max(0, effective);
        unavailable.push(
          issueLine(item, product, variant, left ? `Only ${left} in stock` : "Out of stock", "INSUFFICIENT_STOCK")
        );
        continue;
      }
      lineWarehouseId = warehouseIdOf(stock);
    }
    const priced = await calculateLinePrice({
      variant,
      product,
      qty: item.qty,
      buyerId,
      tenantId: item.tenantId,
      bulk: lineBulk,
      applySlabs: isBulkProduct(product),
      priceLists: priceListsByTenant.get(String(item.tenantId)) || [],
    });
    const slabs = isBulkProduct(product) ? await chargedSlabs(variant, product, item.tenantId) : [];
    const progress = slabProgress(slabs, item.qty, priced.unitPrice);
    const expiresAt = item.reservationId ? holdExpiry.get(String(item.reservationId)) || null : null;
    lines.push({
      cartItemId: item._id,
      tenantId: item.tenantId,
      productId: product._id,
      variantId: variant._id,
      sku: variant.sku,
      slug: product.slug || "",
      name: product.name,
      brand: product.brandId?.name || "",
      image: product.images?.[0] || "",
      pack: variant.attributes?.packSize || variant.attributes?.size || "",
      attributes: variant.attributes,
      hsn: product.hsn || "",
      warehouseId: lineWarehouseId,
      wholesale: product.wholesale?.toObject?.() || product.wholesale || {},
      bulk: lineBulk,
      tierPrices: slabs,
      rules: lineQtyRules(product, item.qty),
      hold: expiresAt ? { expiresAt, reservedQty: item.reservedQty || 0 } : null,
      qty: item.qty,
      fulfillmentMode: resolveFulfillment(product, item.fulfillmentMode),
      easyReturn: Boolean(product.easyReturn),
      deliveryModes: product.deliveryModes?.length ? product.deliveryModes : ["delivery_partner"],
      ...priced,
      appliedSlab: progress.appliedSlab,
      nextSlab: progress.nextSlab,
      unitPricePerBaseUnit: pricePerBaseUnit(priced.unitPrice, packOf(variant)),
    });
  }

  const byTenant = new Map();
  for (const line of lines) {
    const key = String(line.tenantId);
    if (!byTenant.has(key)) byTenant.set(key, []);
    byTenant.get(key).push(line);
  }

  const groups = [];
  const cards = await storeCards([...byTenant.keys()]);
  let groupIndex = 0;
  let couponApplied = false;
  let couponError = null;
  let bagCoupon = null;
  if (cart.couponCode && byTenant.size) {
    try {
      bagCoupon = await priceBagCoupon({
        code: cart.couponCode,
        tenantIds: [...byTenant.keys()],
        buyerId,
        groups: [...byTenant.entries()].map(([tenantId, items]) => ({ tenantId, items })),
      });
    } catch (err) {
      couponError = err;
    }
  }
  for (const [tenantId, items] of byTenant) {
    const subtotal = round2(items.reduce((s, i) => s + i.lineSubtotal, 0));
    // A coupon only discounts lines of the store that issued it.
    const share = bagCoupon?.byTenant.get(String(tenantId));
    const couponDiscount = share?.discount || 0;
    const coupon = couponDiscount > 0 ? share.coupon : null;
    if (coupon) couponApplied = true;
    allocateCoupon(items, couponDiscount, coupon);
    const productTax = round2(items.reduce((s, i) => s + i.tax, 0));
    const productTaxable = round2(items.reduce((s, i) => s + i.taxableValue, 0));

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
        approximate: address.geoApproximate,
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
    let partnerFee = hasDelivery && partner ? round2(partner.fee) : 0;
    const payable = round2(subtotal - couponDiscount);
    const freeDeliveryAbove = hasDelivery ? commerce.freeDeliveryAbove : 0;
    const freeDelivery = freeDeliveryAbove > 0 && payable >= freeDeliveryAbove;
    if (freeDelivery) {
      deliveryFee = 0;
      partnerFee = 0;
    }
    const fees = feeTaxParts(deliveryFee, platformFee, partnerFee);
    const tax = round2(productTax + fees.feeTax);
    const taxableValue = round2(productTaxable + fees.feeTaxable);
    const total = round2(subtotal - couponDiscount + deliveryFee + platformFee + partnerFee);
    groups.push({
      tenantId,
      store: cards.get(String(tenantId)) || null,
      items,
      subtotal,
      couponCode: coupon?.code || "",
      couponId: coupon?._id || null,
      couponDiscount,
      taxableValue,
      tax,
      productTax,
      feeTax: fees.feeTax,
      hasDelivery,
      deliveryFee,
      platformFee,
      partnerFee,
      deliveryPartner: partner,
      deliveryPartnerMatched: !deliveryPartnerId || !partner || partner.id === deliveryPartnerId,
      deliveryPartnerChoiceEnabled: commerce.deliveryPartnerChoiceEnabled,
      deliveryPartners: commerce.deliveryPartners,
      platformFeeEnabled: commerce.feeEnabled,
      codEnabled: commerce.codEnabled,
      freeDeliveryAbove,
      freeDelivery,
      freeDeliveryRemaining: freeDeliveryAbove > 0 && !freeDelivery ? round2(freeDeliveryAbove - payable) : 0,
      fees: {
        delivery: deliveryFee,
        platform: platformFee,
        partner: partnerFee,
        total: round2(deliveryFee + platformFee + partnerFee),
        taxableValue: fees.feeTaxable,
        tax: fees.feeTax,
        parts: fees.parts,
      },
      total,
      grandTotal: total,
      serviceability,
      eta,
    });
    groupIndex += 1;
  }
  if (strictCoupon && cart.couponCode && groups.length && !couponApplied && couponError) throw couponError;

  const itemCount = lines.reduce((n, i) => n + i.qty, 0);
  const subtotal = round2(groups.reduce((s, g) => s + g.subtotal, 0));
  const tax = round2(groups.reduce((s, g) => s + g.tax, 0));
  const productTax = round2(groups.reduce((s, g) => s + (g.productTax || 0), 0));
  const feeTax = round2(groups.reduce((s, g) => s + (g.feeTax || 0), 0));
  const deliveryFee = round2(groups.reduce((s, g) => s + g.deliveryFee, 0));
  const platformFee = round2(groups.reduce((s, g) => s + g.platformFee, 0));
  const partnerFee = round2(groups.reduce((s, g) => s + g.partnerFee, 0));
  const couponDiscount = round2(groups.reduce((s, g) => s + g.couponDiscount, 0));
  const appliedGroups = groups.filter((group) => group.couponDiscount > 0);
  const couponNote =
    cart.couponCode && appliedGroups.length > 0 && appliedGroups.length < groups.length
      ? "Some items in the bag are outside this coupon, so those lines stay at full price."
      : "";
  const deliveryGroup = groups.find((g) => g.hasDelivery) || groups[0];
  return {
    cartId: cart._id,
    holdExpiresAt: lines.reduce((min, line) => {
      const at = line.hold?.expiresAt;
      return at && (!min || new Date(at) < new Date(min)) ? at : min;
    }, null),
    couponCode: couponDiscount ? groups.find((g) => g.couponCode)?.couponCode || cart.couponCode : "",
    couponNote,
    groups,
    unavailable,
    itemCount,
    subtotal,
    tax,
    productTax,
    feeTax,
    taxableValue: round2(groups.reduce((s, g) => s + (g.taxableValue || 0), 0)),
    fees: {
      delivery: deliveryFee,
      platform: platformFee,
      partner: partnerFee,
      total: round2(deliveryFee + platformFee + partnerFee),
      tax: feeTax,
    },
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
    codEnabled: groups.length > 0 && groups.every((g) => g.codEnabled),
  };
}

/**
 * Merge a guest cart into the user's cart, clamping each line to bulk rules and stock.
 * Lines that cannot be made valid are dropped rather than breaking the user's cart.
 * Guest holds are released and the merged lines take fresh holds, all in one transaction.
 */
export async function mergeGuestCart(userId, guestKey) {
  const userCart = await getOrCreateCart(userId);
  if (!guestKey) return quoteCart(userCart, userId);
  const guestProbe = await Cart.findOne({ guestKey: String(guestKey) });
  if (!guestProbe || !guestProbe.items.length || String(guestProbe._id) === String(userCart._id)) {
    return quoteCart(userCart, userId);
  }
  try {
    await withTransaction(async (session) => {
      const guest = await Cart.findById(guestProbe._id).session(session);
      const mine = await Cart.findById(userCart._id).session(session);
      if (!guest || !mine) return;
      await releaseLines(guest, session, "guest cart merged");
      for (const item of guest.items) {
        const [product, variant] = await Promise.all([
          Product.findById(item.productId).session(session),
          ProductVariant.findById(item.variantId).session(session),
        ]);
        if (!product || !variant || product.status !== "published" || variant.status !== "active") continue;
        let line = mine.items.find((i) => sameLine(i, item.variantId));
        let qty = (line?.qty || 0) + item.qty;
        const otherLines = variantQtyInCart(mine, variant._id, { excludeItemId: line?._id });
        const holds = holdMap(mine, variant._id);
        const stock = await pickWarehouseForVariant(item.tenantId, variant._id, null, qty + otherLines, holds, session);
        const effective = (stock?.available || 0) + (holds.get(String(warehouseIdOf(stock) || "")) || 0);
        qty = clampQty(product, Math.min(qty, Math.max(0, effective - otherLines)), bulkQtyInCart(mine, product, { excludeItemId: line?._id }));
        if (qty <= 0) continue;
        if (!line) {
          mine.items.push({
            tenantId: item.tenantId,
            productId: item.productId,
            variantId: item.variantId,
            qty,
            bulk: isBulkQty(product, qty),
            fulfillmentMode: item.fulfillmentMode,
          });
          line = mine.items[mine.items.length - 1];
        }
        line.qty = qty;
        line.bulk = isBulkQty(product, qty);
        try {
          await syncLineHold(mine, line, qty, null, session);
        } catch (err) {
          if (err.code !== "INSUFFICIENT_STOCK") throw err;
          // Keep the line without a hold; the cart shows it as short on stock.
        }
      }
      if (guest.couponCode && !mine.couponCode) mine.couponCode = guest.couponCode;
      await mine.save({ session });
      await Cart.deleteOne({ _id: guest._id }, { session });
    });
  } catch (err) {
    throw cartBusy(err);
  }
  return quoteCart(await Cart.findById(userCart._id), userId);
}

/**
 * Coupons a buyer can see (works with an empty cart). Stores considered: the stores in the cart,
 * plus for a signed-in buyer their home store and the stores they ordered from, plus the optional
 * `tenantId` being browsed (active/trial stores only). Listed: active, in-window coupons that are
 * public and not customer-targeted, plus coupons targeted at this buyer. Private codes and coupons
 * targeted at other buyers are never listed. Each row says whether it applies to the current cart.
 */
export async function listCartCoupons(userId, guestKey, { tenantId = null, homeTenantId = null } = {}) {
  const cart = await getOrCreateCart(userId, guestKey);
  const quote = await quoteCart(cart, userId);
  const cartTenants = (quote.groups || []).map((g) => String(g.tenantId));
  const candidates = new Set(cartTenants);
  if (tenantId) candidates.add(String(tenantId));
  if (userId) {
    if (homeTenantId) candidates.add(String(homeTenantId));
    const ordered = await Order.distinct("tenantId", { buyerId: userId });
    for (const id of ordered) candidates.add(String(id));
  }
  const active = new Set((await activeTenantIds()).map(String));
  const tenantIds = [...candidates].filter((id) => active.has(id));
  if (!tenantIds.length) return { coupons: [], best: null, cartEmpty: !quote.groups.length };

  const now = new Date();
  const audience = [{ visibility: { $ne: "private" }, $or: [{ customerIds: { $exists: false } }, { customerIds: { $size: 0 } }] }];
  if (userId) audience.push({ customerIds: userId });
  const [docs, tenants] = await Promise.all([
    Coupon.find({
      tenantId: { $in: tenantIds },
      status: "active",
      $and: [
        { $or: [{ startsAt: null }, { startsAt: { $exists: false } }, { startsAt: { $lte: now } }] },
        { $or: [{ endsAt: null }, { endsAt: { $exists: false } }, { endsAt: { $gte: now } }] },
        { $or: audience },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean(),
    Tenant.find({ _id: { $in: tenantIds } }).select("name slug").lean(),
  ]);
  const tenantById = new Map(tenants.map((t) => [String(t._id), t]));
  const coupons = [];
  for (const doc of docs) {
    const group = quote.groups.find((g) => String(g.tenantId) === String(doc.tenantId));
    const store = tenantById.get(String(doc.tenantId));
    let preview = { discount: 0, eligible: false, reason: "" };
    if (group) {
      preview = await previewCoupon({
        tenantId: doc.tenantId,
        code: doc.code,
        buyerId: userId,
        subtotal: group.subtotal,
        items: group.items || [],
      });
    } else {
      preview.reason = quote.groups.length
        ? `Add items from ${store?.name || "this store"} to use this coupon`
        : "Add items to your cart to use this coupon";
    }
    coupons.push({
      id: doc._id,
      code: doc.code,
      name: doc.name,
      description: doc.description || "",
      type: doc.type,
      value: doc.value,
      minCartValue: doc.minCartValue || 0,
      appliesTo: doc.appliesTo || "all",
      firstOrderOnly: Boolean(doc.firstOrderOnly),
      startsAt: doc.startsAt || null,
      endsAt: doc.endsAt || null,
      targeted: Boolean(doc.customerIds?.length),
      tenantId: doc.tenantId,
      store: store ? { id: store._id, name: store.name, slug: store.slug } : null,
      inCart: Boolean(group),
      appliesToCart: preview.eligible,
      eligible: preview.eligible,
      savings: preview.discount,
      reason: preview.reason,
      applied: Boolean(group && quote.couponCode && quote.couponCode === doc.code && group.couponCode === doc.code),
      best: false,
    });
  }

  coupons.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.savings - a.savings || Number(b.inCart) - Number(a.inCart));
  const best = coupons.find((c) => c.eligible) || null;
  if (best) {
    for (const row of coupons) row.best = row.id === best.id;
  }
  return { coupons, best, cartEmpty: !quote.groups.length };
}
