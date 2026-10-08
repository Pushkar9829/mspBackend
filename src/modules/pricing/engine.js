import { PriceList } from "./priceList.model.js";
import { Offer } from "./offer.model.js";
import { Coupon } from "./coupon.model.js";
import { CouponUsage, CouponCustomerUse } from "./couponUsage.model.js";
import { Product } from "../catalog/product.model.js";
import { Order } from "../orders/order.model.js";
import { AppError } from "../../utils/AppError.js";

export function matchTier(tiers, qty) {
  if (!tiers?.length) return null;
  const sorted = [...tiers].sort((a, b) => Number(b.minQty) - Number(a.minQty));
  return (
    sorted.find((t) => qty >= Number(t.minQty) && (t.maxQty == null || qty <= Number(t.maxQty))) || null
  );
}

/** Slab price never raises the price the buyer would otherwise pay. */
function applyTier(price, tiers, qty) {
  const match = matchTier(tiers, qty);
  if (!match) return price;
  return Math.min(price, Number(match.unitPrice));
}

/** Prices are GST-inclusive: split a gross amount into taxable value and tax. */
export function splitInclusive(gross, rate) {
  const amount = round2(gross);
  const r = Number(rate) || 0;
  if (!r) return { taxableValue: amount, tax: 0 };
  const taxableValue = round2((amount * 100) / (100 + r));
  return { taxableValue, tax: round2(amount - taxableValue) };
}

export function isBulkProduct(product) {
  return Boolean(product?.wholesale?.bulkEligible);
}

/**
 * Quantity rules for one cart line (one line per variant; the "bulk" flag is derived).
 * - Not bulk-eligible: any qty >= 1, never bulk.
 * - Bulk-eligible: the bulk range starts at `bulkFrom` = MOQ rounded up to the pack multiple
 *   (1 when MOQ and pack are 1, i.e. every quantity is bulk). Inside the bulk range the pack
 *   multiple and the per-order max apply; below it the line is a regular purchase.
 * `min/step/max` describe the range `qty` is in (regular range: 1/1/null); `bulk` is the bulk range.
 * Slab (tier) prices are chosen from the line quantity for every bulk-eligible product.
 */
export function qtyRules(product, _variant = null, qty = null) {
  if (!isBulkProduct(product)) {
    return { bulkEligible: false, bulkFrom: null, moq: 1, pack: 1, maxQty: null, min: 1, step: 1, max: null, bulk: null };
  }
  const w = product.wholesale || {};
  const pack = Math.max(1, Number(w.packMultiple) || 1);
  const moq = Math.max(1, Number(w.moq) || 1);
  const maxQty = Number(w.maxQty) > 0 ? Number(w.maxQty) : null;
  const bulkFrom = Math.ceil(moq / pack) * pack;
  const bulkRange = { min: bulkFrom, step: pack, max: maxQty };
  const inBulk = qty != null && Number(qty) >= bulkFrom;
  const current = inBulk || bulkFrom <= 1 ? bulkRange : { min: 1, step: 1, max: null };
  return { bulkEligible: true, bulkFrom, moq, pack, maxQty, ...current, bulk: bulkRange };
}

/** Whether a line of `qty` units is a bulk purchase (bulk-eligible product, qty in the bulk range). */
export function isBulkQty(product, qty, variant = null) {
  const rules = qtyRules(product, variant);
  return rules.bulkEligible && Number(qty) >= rules.bulkFrom;
}

const UNIT_ALIASES = {
  kg: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"],
  g: ["g", "gm", "gms", "gram", "grams", "gr"],
  l: ["l", "lt", "ltr", "ltrs", "litre", "litres", "liter", "liters"],
  ml: ["ml", "mls", "millilitre", "milliliter"],
  pc: ["pc", "pcs", "piece", "pieces", "nos", "no", "unit", "units", "pack", "packs"],
  m: ["m", "mtr", "meter", "metre", "meters", "metres"],
};

/** Parse "500 g", "1kg", "2 x 500 ml", "12 pcs" into { qty, unit } in base units (kg, L, pc, m). */
export function parsePackSize(packSize) {
  const raw = String(packSize || "").toLowerCase().replace(/,/g, "").trim();
  if (!raw) return null;
  const m = raw.match(/^(?:(\d+(?:\.\d+)?)\s*[x×*]\s*)?(\d+(?:\.\d+)?)\s*([a-z]+)\.?$/);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const amount = Number(m[2]) * count;
  const unit = Object.keys(UNIT_ALIASES).find((key) => UNIT_ALIASES[key].includes(m[3]));
  if (!unit || !(amount > 0)) return null;
  if (unit === "g") return { qty: amount / 1000, unit: "kg" };
  if (unit === "ml") return { qty: amount / 1000, unit: "L" };
  if (unit === "l") return { qty: amount, unit: "L" };
  return { qty: amount, unit };
}

export function packOf(variant) {
  return variant?.attributes?.packSize || variant?.attributes?.size || "";
}

/** Price per base unit (₹/kg, ₹/L, ₹/pc, ₹/m) for a pack price, or null when the pack size is not parseable. */
export function pricePerBaseUnit(unitPrice, packSize) {
  const parsed = parsePackSize(packSize);
  if (!parsed || !Number.isFinite(Number(unitPrice))) return null;
  const amount = round2(Number(unitPrice) / parsed.qty);
  return { amount, unit: parsed.unit, label: `₹${amount}/${parsed.unit}` };
}

/** Applied and next slab for `qty` over charged slabs ([{ minQty, maxQty, unitPrice }]). */
export function slabProgress(slabs, qty, currentUnitPrice) {
  const sorted = [...(slabs || [])].sort((a, b) => Number(a.minQty) - Number(b.minQty));
  const applied = matchTier(sorted, qty);
  const next = sorted.find((t) => Number(t.minQty) > Number(qty) && Number(t.unitPrice) < Number(currentUnitPrice));
  return {
    appliedSlab: applied ? { minQty: applied.minQty, maxQty: applied.maxQty ?? null, unitPrice: applied.unitPrice } : null,
    nextSlab: next
      ? {
          minQty: next.minQty,
          unitPrice: next.unitPrice,
          saveEach: round2(Number(currentUnitPrice) - Number(next.unitPrice)),
          addQty: Number(next.minQty) - Number(qty),
        }
      : null,
  };
}

function nowInWindow(startsAt, endsAt) {
  const now = Date.now();
  if (startsAt && new Date(startsAt).getTime() > now) return false;
  if (endsAt && new Date(endsAt).getTime() < now) return false;
  return true;
}

function categoryRef(product) {
  const cat = product?.categoryId;
  return cat?._id || cat || null;
}

export function offerApplies(offer, { productId, categoryId, buyerId }) {
  const productMatch =
    !offer.productIds?.length || offer.productIds.some((id) => String(id) === String(productId));
  const categoryMatch =
    !offer.categoryIds?.length ||
    (categoryId && offer.categoryIds.some((id) => String(id) === String(categoryId)));
  const customerMatch =
    !offer.customerIds?.length || (buyerId && offer.customerIds.some((id) => String(id) === String(buyerId)));
  return productMatch && categoryMatch && customerMatch;
}

export function offerDiscountAmount(offer, unitPrice) {
  if (offer.type === "percent") return (Number(unitPrice) * offer.value) / 100;
  return Math.min(offer.value, Number(unitPrice) || 0);
}

export function serializeOffer(offer) {
  if (!offer) return null;
  return {
    id: String(offer._id),
    name: offer.name,
    type: offer.type,
    value: offer.value,
    badge: offer.type === "flash" ? "price-drop" : "offer",
    endsAt: offer.endsAt,
  };
}

/** Whether an offer/coupon aimed at all, single (regular) or bulk purchases covers this line. */
export function coversPurchase(appliesTo, bulk) {
  if (appliesTo === "bulk") return Boolean(bulk);
  if (appliesTo === "regular") return !bulk;
  return true;
}

/** Pass `{ bulk }` to keep only offers for that kind of purchase; omit it to get every matching offer. */
export function matchingOffers(offers, product, buyerId, { bulk, qty } = {}) {
  const tenantId = String(product.tenantId?._id || product.tenantId || "");
  const ctx = {
    productId: product._id,
    categoryId: categoryRef(product),
    buyerId,
  };
  return (offers || []).filter((offer) => {
    if (tenantId && String(offer.tenantId) !== tenantId) return false;
    if (bulk !== undefined && !coversPurchase(offer.appliesTo, bulk)) return false;
    if (offer.inventoryCap != null) {
      const need = qty == null ? 1 : Number(qty);
      if ((Number(offer.inventoryUsed) || 0) + need > offer.inventoryCap) return false;
    }
    return offerApplies(offer, ctx);
  });
}

export function bestOfferForPrice(offers, unitPrice) {
  let best = null;
  let bestDiscount = 0;
  for (const offer of offers || []) {
    const discount = offerDiscountAmount(offer, unitPrice);
    if (discount > bestDiscount) {
      bestDiscount = discount;
      best = offer;
    }
  }
  return { offer: best, discount: bestDiscount };
}

/** Customer list wins over the store default, matching cart line pricing. */
export function listsForBuyer(lists, buyerId) {
  const mine = lists || [];
  if (buyerId) {
    const customer = mine.find((list) => list.customerId && String(list.customerId) === String(buyerId));
    if (customer) return customer;
  }
  return mine.find((list) => list.isDefault) || null;
}

export function listedUnit(list, variant, fallbackPrice) {
  const variantId = variant?._id || variant;
  const item = list?.items?.find((row) => String(row.variantId) === String(variantId));
  if (!item) return { unitPrice: Number(fallbackPrice), priceListId: null };
  return { unitPrice: Number(item.unitPrice), priceListId: list._id };
}

export async function loadBuyerPriceLists(tenantIds, buyerId) {
  const ids = [...new Set((tenantIds || []).filter(Boolean).map((id) => String(id._id || id)))];
  const map = new Map();
  if (!ids.length) return map;
  const or = [{ isDefault: true }];
  if (buyerId) or.push({ customerId: buyerId });
  const lists = await PriceList.find({
    tenantId: { $in: ids },
    status: "active",
    $or: or,
  }).lean();
  for (const id of ids) {
    map.set(
      id,
      lists.filter((list) => String(list.tenantId) === id)
    );
  }
  return map;
}

/** GST included in delivery, platform, and partner fees. Same split the invoice uses. */
export const FEE_TAX_RATE = 18;

export function feeTaxParts(deliveryFee = 0, platformFee = 0, partnerFee = 0) {
  const parts = [
    ["delivery", deliveryFee],
    ["platform", platformFee],
    ["partner", partnerFee],
  ].map(([key, gross]) => {
    const amount = round2(Math.max(0, Number(gross) || 0));
    const split = splitInclusive(amount, FEE_TAX_RATE);
    return { key, gross: amount, ...split };
  });
  return {
    parts,
    feeTax: round2(parts.reduce((sum, part) => sum + part.tax, 0)),
    feeTaxable: round2(parts.reduce((sum, part) => sum + (part.gross > 0 ? part.taxableValue : 0), 0)),
  };
}

export function applyOffersToVariants(variants, offers, product, buyerId, priceLists = []) {
  const matched = matchingOffers(offers, product, buyerId, { bulk: false });
  const matchedBulk = matchingOffers(offers, product, buyerId, { bulk: true });
  const list = listsForBuyer(priceLists, buyerId);
  return (variants || []).map((v) => {
    const raw = typeof v.toObject === "function" ? v.toObject() : { ...v };
    const base = listedUnit(list, raw, raw.sellingPrice).unitPrice;
    const { offer, discount } = bestOfferForPrice(matched, base);
    // Slab prices as the cart charges them: capped at the account price, then the offer.
    const tierPrices = isBulkProduct(product)
      ? [...(raw.tierPrices || [])]
          .sort((a, b) => Number(a.minQty) - Number(b.minQty))
          .map((t) => {
            const slab = Math.min(base, Number(t.unitPrice));
            const off = bestOfferForPrice(matchedBulk, slab).discount;
            const unitPrice = round2(Math.max(0, slab - off));
            return {
              minQty: t.minQty,
              maxQty: t.maxQty ?? null,
              catalogUnitPrice: t.unitPrice,
              unitPrice,
              unitPricePerBaseUnit: pricePerBaseUnit(unitPrice, packOf(raw)),
            };
          })
      : [];
    const sellingPrice = round2(Math.max(0, base - discount));
    return {
      ...raw,
      tierPrices,
      catalogSellingPrice: raw.sellingPrice,
      sellingPrice,
      unitPricePerBaseUnit: pricePerBaseUnit(sellingPrice, packOf(raw)),
      rules: qtyRules(product, raw),
      offer: serializeOffer(offer),
    };
  });
}

export async function loadActiveOffers(tenantIds) {
  const ids = [...new Set((tenantIds || []).filter(Boolean).map((id) => String(id._id || id)))];
  if (!ids.length) return [];
  return Offer.find({
    tenantId: { $in: ids },
    status: "active",
    startsAt: { $lte: new Date() },
    endsAt: { $gte: new Date() },
  }).lean();
}

/**
 * `bulk` = the line is a bulk purchase (offer/coupon `appliesTo` scope). `applySlabs` (default
 * `bulk`) = choose the slab price from `qty`; the cart passes true for every bulk-eligible product.
 */
export async function calculateLinePrice({ variant, product, qty, buyerId, tenantId, bulk = false, priceLists, applySlabs }) {
  const listPrice = variant.listPrice;
  let unitPrice = variant.sellingPrice;
  const breakdown = [{ step: "list", amount: listPrice }, { step: "selling", amount: unitPrice }];

  const lists =
    priceLists !== undefined
      ? priceLists
      : (await loadBuyerPriceLists([tenantId], buyerId)).get(String(tenantId)) || [];
  const listed = listedUnit(listsForBuyer(lists, buyerId), variant, unitPrice);
  if (listed.priceListId) {
    unitPrice = listed.unitPrice;
    breakdown.push({ step: "price_list", amount: unitPrice, priceListId: listed.priceListId });
  }

  const preTier = unitPrice;
  if ((applySlabs ?? bulk) && isBulkProduct(product)) {
    const tiered = applyTier(unitPrice, variant.tierPrices, qty);
    if (tiered !== unitPrice) breakdown.push({ step: "tier", amount: tiered, qty });
    unitPrice = tiered;
  }

  const offers = await Offer.find({
    tenantId,
    status: "active",
    startsAt: { $lte: new Date() },
    endsAt: { $gte: new Date() },
  });

  const matched = matchingOffers(offers, product || { _id: variant.productId, tenantId }, buyerId, {
    bulk: Boolean(bulk),
    qty,
  });
  const tierInput = unitPrice;
  const { offer, discount: offerDiscount } = bestOfferForPrice(matched, unitPrice);
  if (offer) breakdown.push({ step: "offer", amount: unitPrice - offerDiscount, offerId: offer._id });
  unitPrice = Math.max(0, unitPrice - offerDiscount);

  unitPrice = round2(unitPrice);
  /** What one unit would cost without the bulk slab, so the slab saving can be shown on its own. */
  const baseUnitPrice =
    preTier === tierInput
      ? unitPrice
      : round2(Math.max(unitPrice, preTier - bestOfferForPrice(matched, preTier).discount));
  const lineSubtotal = round2(unitPrice * qty);
  const taxRate = product?.taxClass?.rate || 0;
  const { taxableValue, tax } = splitInclusive(lineSubtotal, taxRate);

  return {
    listPrice,
    baseUnitPrice,
    unitPrice,
    qty,
    lineSubtotal,
    couponShare: 0,
    taxRate,
    taxableValue,
    tax,
    lineTotal: lineSubtotal,
    breakdown,
  };
}

/**
 * Spread a group coupon across eligible lines (by line amount) and recompute each line's
 * GST on the discounted amount. Mutates and returns the lines.
 */
export function allocateCoupon(lines, discount, coupon) {
  const eligible = lines.filter((l) => couponCoversLine(coupon, l));
  for (const line of lines) {
    line.couponShare = 0;
  }
  // Integer paise, largest remainder: shares sum exactly to the discount (capped at the eligible
  // subtotal) and no line's share exceeds its own subtotal.
  const caps = eligible.map((l) => Math.max(0, Math.round(l.lineSubtotal * 100)));
  const baseP = caps.reduce((s, c) => s + c, 0);
  const totalP = Math.min(Math.max(0, Math.round((Number(discount) || 0) * 100)), baseP);
  if (totalP > 0 && baseP > 0) {
    // BigInt: totalP * cap can exceed Number.MAX_SAFE_INTEGER on large carts.
    const parts = caps.map((cap, idx) => {
      const product = BigInt(totalP) * BigInt(cap);
      return { idx, share: Number(product / BigInt(baseP)), rem: product % BigInt(baseP) };
    });
    const shares = parts.map((p) => p.share);
    let left = totalP - shares.reduce((s, x) => s + x, 0);
    const order = [...parts].sort((x, y) => (y.rem > x.rem ? 1 : y.rem < x.rem ? -1 : x.idx - y.idx));
    for (const { idx } of order) {
      if (left <= 0) break;
      if (shares[idx] < caps[idx]) {
        shares[idx] += 1;
        left -= 1;
      }
    }
    eligible.forEach((line, idx) => {
      line.couponShare = shares[idx] / 100;
    });
  }
  for (const line of lines) {
    const net = round2(line.lineSubtotal - line.couponShare);
    const { taxableValue, tax } = splitInclusive(net, line.taxRate);
    line.taxableValue = taxableValue;
    line.tax = tax;
    line.lineTotal = net;
  }
  return lines;
}

function couponCoversLine(coupon, line) {
  if (coupon?.excludedProductIds?.some((id) => String(id) === String(line.productId))) return false;
  return coversPurchase(coupon?.appliesTo, line.bulk);
}

function eligibleSubtotal(coupon, items) {
  return items.filter((item) => couponCoversLine(coupon, item)).reduce((sum, item) => sum + item.lineSubtotal, 0);
}

async function assertCouponRules(coupon, buyerId, subtotal, items) {
  if (!nowInWindow(coupon.startsAt, coupon.endsAt)) {
    throw new AppError(400, "Coupon is not active", "INVALID_COUPON");
  }
  if (coupon.customerIds?.length && !(buyerId && coupon.customerIds.some((id) => String(id) === String(buyerId)))) {
    throw new AppError(400, buyerId ? "This coupon is not available for your account" : "Log in to use this coupon", "COUPON_NOT_ELIGIBLE");
  }
  if (subtotal < coupon.minCartValue) {
    throw new AppError(400, `Minimum cart value is ${coupon.minCartValue}`, "COUPON_MIN");
  }
  if (coupon.maxRedemptions != null && coupon.redemptionCount >= coupon.maxRedemptions) {
    throw new AppError(400, "Coupon usage limit reached", "COUPON_LIMIT");
  }
  if (buyerId) {
    const [counter, legacy] = await Promise.all([
      CouponCustomerUse.findOne({ couponId: coupon._id, userId: buyerId }).lean(),
      CouponUsage.countDocuments({ couponId: coupon._id, userId: buyerId }),
    ]);
    const used = Math.max(counter?.count || 0, legacy);
    if (used >= (coupon.perCustomerLimit || 1)) {
      throw new AppError(400, "Coupon already used", "COUPON_LIMIT");
    }
  }
  if (coupon.firstOrderOnly) {
    if (!buyerId) throw new AppError(400, "Log in to use this first-order coupon", "COUPON_FIRST_ORDER");
    const previous = await Order.exists({ tenantId: coupon.tenantId, buyerId, status: { $ne: "cancelled" } });
    if (previous) throw new AppError(400, "This coupon is only for your first order with this store", "COUPON_FIRST_ORDER");
  }
  const covered = eligibleSubtotal(coupon, items);
  if (covered <= 0 && coupon.appliesTo && coupon.appliesTo !== "all") {
    throw new AppError(
      400,
      coupon.appliesTo === "bulk" ? "This coupon is only for bulk purchases" : "This coupon is only for single (non-bulk) purchases",
      "COUPON_SCOPE"
    );
  }
  return covered;
}

function discountForItems(coupon, items) {
  const covered = eligibleSubtotal(coupon, items);
  if (coupon.type === "percent") return round2((covered * coupon.value) / 100);
  return Math.min(coupon.value, covered);
}

export async function applyCoupon({ tenantId, code, buyerId, subtotal, items }) {
  if (!code) return { coupon: null, discount: 0 };
  const coupon = await Coupon.findOne({
    tenantId,
    code: String(code).toUpperCase(),
    status: "active",
  });
  if (!coupon) throw new AppError(400, "Invalid coupon", "INVALID_COUPON");
  await assertCouponRules(coupon, buyerId, subtotal, items);
  return { coupon, discount: discountForItems(coupon, items) };
}

/**
 * A coupon belongs to one store and only discounts that store's lines. When several stores in
 * the bag issued the same code, each store's own coupon applies to its own group.
 * Returns { byTenant: Map(tenantId -> { coupon, discount }), total, coupon }.
 */
export async function priceBagCoupon({ code, tenantIds, buyerId, groups }) {
  const coupons = await Coupon.find({
    code: String(code).toUpperCase(),
    status: "active",
    tenantId: { $in: tenantIds },
  });
  if (!coupons.length) throw new AppError(400, "Invalid coupon", "INVALID_COUPON");
  const byTenant = new Map();
  let lastError = null;
  for (const coupon of coupons) {
    const key = String(coupon.tenantId);
    const group = groups.find((g) => String(g.tenantId) === key);
    if (!group || byTenant.has(key)) continue;
    try {
      const subtotal = round2(group.items.reduce((sum, item) => sum + item.lineSubtotal, 0));
      await assertCouponRules(coupon, buyerId, subtotal, group.items);
      const discount = round2(discountForItems(coupon, group.items));
      if (discount > 0) byTenant.set(key, { coupon, discount });
    } catch (err) {
      lastError = err;
    }
  }
  if (!byTenant.size) {
    throw lastError || new AppError(400, "This coupon does not cover the items in your bag", "COUPON_SCOPE");
  }
  const total = round2([...byTenant.values()].reduce((sum, row) => sum + row.discount, 0));
  return { byTenant, total, coupon: [...byTenant.values()][0].coupon };
}

/** Re-check a coupon inside the checkout transaction (status/window may have changed since the quote). */
export function assertCouponStillValid(coupon, tenantId) {
  if (!coupon || coupon.status !== "active" || String(coupon.tenantId) !== String(tenantId)) {
    throw new AppError(400, "Coupon is no longer active", "INVALID_COUPON");
  }
  if (!nowInWindow(coupon.startsAt, coupon.endsAt)) {
    throw new AppError(400, "Coupon is not active", "INVALID_COUPON");
  }
}

export async function previewCoupon(args) {
  try {
    const applied = await applyCoupon(args);
    return { coupon: applied.coupon, discount: applied.discount, eligible: true, reason: "" };
  } catch (err) {
    return { coupon: null, discount: 0, eligible: false, reason: err.message || "Not applicable" };
  }
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export { Product };
