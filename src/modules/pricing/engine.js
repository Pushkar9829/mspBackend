import { PriceList } from "./priceList.model.js";
import { Offer } from "./offer.model.js";
import { Coupon } from "./coupon.model.js";
import { CouponUsage } from "./couponUsage.model.js";
import { Product } from "../catalog/product.model.js";
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

export function matchingOffers(offers, product, buyerId) {
  const tenantId = String(product.tenantId?._id || product.tenantId || "");
  const ctx = {
    productId: product._id,
    categoryId: categoryRef(product),
    buyerId,
  };
  return (offers || []).filter((offer) => {
    if (tenantId && String(offer.tenantId) !== tenantId) return false;
    if (offer.inventoryCap != null && offer.inventoryUsed >= offer.inventoryCap) return false;
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

export function applyOffersToVariants(variants, offers, product, buyerId) {
  const matched = matchingOffers(offers, product, buyerId);
  return (variants || []).map((v) => {
    const raw = typeof v.toObject === "function" ? v.toObject() : { ...v };
    const { offer, discount } = bestOfferForPrice(matched, raw.sellingPrice);
    // Slab prices as the cart charges them: capped at the selling price, then the offer.
    const tierPrices = isBulkProduct(product)
      ? [...(raw.tierPrices || [])]
          .sort((a, b) => Number(a.minQty) - Number(b.minQty))
          .map((t) => {
            const slab = Math.min(Number(raw.sellingPrice), Number(t.unitPrice));
            const off = bestOfferForPrice(matched, slab).discount;
            return {
              minQty: t.minQty,
              maxQty: t.maxQty ?? null,
              catalogUnitPrice: t.unitPrice,
              unitPrice: round2(Math.max(0, slab - off)),
            };
          })
      : [];
    return {
      ...raw,
      tierPrices,
      catalogSellingPrice: raw.sellingPrice,
      sellingPrice: round2(Math.max(0, Number(raw.sellingPrice) - discount)),
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

export async function calculateLinePrice({ variant, product, qty, buyerId, tenantId, bulk = false }) {
  const listPrice = variant.listPrice;
  let unitPrice = variant.sellingPrice;
  const breakdown = [{ step: "list", amount: listPrice }, { step: "selling", amount: unitPrice }];

  const priceList =
    (buyerId &&
      (await PriceList.findOne({
        tenantId,
        customerId: buyerId,
        status: "active",
      }))) ||
    (await PriceList.findOne({ tenantId, isDefault: true, status: "active" }));

  if (priceList) {
    const item = priceList.items.find((i) => String(i.variantId) === String(variant._id));
    if (item) {
      unitPrice = item.unitPrice;
      breakdown.push({ step: "price_list", amount: unitPrice, priceListId: priceList._id });
    }
  }

  const preTier = unitPrice;
  if (bulk && isBulkProduct(product)) {
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

  const matched = matchingOffers(offers, product || { _id: variant.productId, tenantId }, buyerId);
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
  const excluded = new Set((coupon?.excludedProductIds || []).map((id) => String(id)));
  const eligible = lines.filter((l) => !excluded.has(String(l.productId)));
  const base = eligible.reduce((s, l) => s + l.lineSubtotal, 0);
  let remaining = round2(discount || 0);
  for (const line of lines) {
    line.couponShare = 0;
  }
  if (remaining > 0 && base > 0) {
    eligible.forEach((line, idx) => {
      const share =
        idx === eligible.length - 1 ? remaining : round2((discount * line.lineSubtotal) / base);
      line.couponShare = Math.min(line.lineSubtotal, Math.max(0, share));
      remaining = round2(remaining - line.couponShare);
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

export async function applyCoupon({ tenantId, code, buyerId, subtotal, items }) {
  if (!code) return { coupon: null, discount: 0 };
  const coupon = await Coupon.findOne({
    tenantId,
    code: String(code).toUpperCase(),
    status: "active",
  });
  if (!coupon) throw new AppError(400, "Invalid coupon", "INVALID_COUPON");
  if (!nowInWindow(coupon.startsAt, coupon.endsAt)) {
    throw new AppError(400, "Coupon is not active", "INVALID_COUPON");
  }
  if (subtotal < coupon.minCartValue) {
    throw new AppError(400, `Minimum cart value is ${coupon.minCartValue}`, "COUPON_MIN");
  }
  if (coupon.maxRedemptions != null && coupon.redemptionCount >= coupon.maxRedemptions) {
    throw new AppError(400, "Coupon usage limit reached", "COUPON_LIMIT");
  }
  if (buyerId) {
    const used = await CouponUsage.countDocuments({ couponId: coupon._id, userId: buyerId });
    if (used >= coupon.perCustomerLimit) {
      throw new AppError(400, "Coupon already used", "COUPON_LIMIT");
    }
  }

  const eligibleSubtotal = items
    .filter((i) => !coupon.excludedProductIds?.some((id) => String(id) === String(i.productId)))
    .reduce((s, i) => s + i.lineSubtotal, 0);

  const discount =
    coupon.type === "percent"
      ? round2((eligibleSubtotal * coupon.value) / 100)
      : Math.min(coupon.value, eligibleSubtotal);

  return { coupon, discount };
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
