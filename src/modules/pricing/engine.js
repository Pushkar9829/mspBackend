import { PriceList } from "./priceList.model.js";
import { Offer } from "./offer.model.js";
import { Coupon } from "./coupon.model.js";
import { CouponUsage } from "./couponUsage.model.js";
import { Product } from "../catalog/product.model.js";
import { AppError } from "../../utils/AppError.js";

function applyTier(sellingPrice, tiers, qty) {
  if (!tiers?.length) return sellingPrice;
  const match = tiers.find((t) => qty >= t.minQty && (t.maxQty == null || qty <= t.maxQty));
  return match ? match.unitPrice : sellingPrice;
}

function nowInWindow(startsAt, endsAt) {
  const now = Date.now();
  if (startsAt && new Date(startsAt).getTime() > now) return false;
  if (endsAt && new Date(endsAt).getTime() < now) return false;
  return true;
}

export async function calculateLinePrice({ variant, product, qty, buyerId, tenantId }) {
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

  unitPrice = applyTier(unitPrice, variant.tierPrices, qty);
  breakdown.push({ step: "tier", amount: unitPrice, qty });

  const offers = await Offer.find({
    tenantId,
    status: "active",
    startsAt: { $lte: new Date() },
    endsAt: { $gte: new Date() },
  });

  const productId = product?._id || variant.productId;
  const categoryId = product?.categoryId;
  let offerDiscount = 0;
  for (const offer of offers) {
    const productMatch = !offer.productIds?.length || offer.productIds.some((id) => String(id) === String(productId));
    const categoryMatch =
      !offer.categoryIds?.length ||
      (categoryId && offer.categoryIds.some((id) => String(id) === String(categoryId)));
    const customerMatch =
      !offer.customerIds?.length || (buyerId && offer.customerIds.some((id) => String(id) === String(buyerId)));
    if (!productMatch || !categoryMatch || !customerMatch) continue;
    if (offer.inventoryCap != null && offer.inventoryUsed >= offer.inventoryCap) continue;

    const discount =
      offer.type === "percent" ? (unitPrice * offer.value) / 100 : Math.min(offer.value, unitPrice);
    if (discount > offerDiscount) {
      offerDiscount = discount;
      breakdown.push({ step: "offer", amount: unitPrice - discount, offerId: offer._id });
    }
  }
  unitPrice = Math.max(0, unitPrice - offerDiscount);

  const lineSubtotal = round2(unitPrice * qty);
  const taxRate = product?.taxClass?.rate || 0;
  const tax = round2((lineSubtotal * taxRate) / 100);

  return {
    listPrice,
    unitPrice: round2(unitPrice),
    qty,
    lineSubtotal,
    taxRate,
    tax,
    lineTotal: round2(lineSubtotal + tax),
    breakdown,
  };
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
