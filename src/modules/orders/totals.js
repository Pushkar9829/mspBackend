import { feeTaxParts, round2 } from "../pricing/engine.js";

/**
 * Per-order money breakdown, same shape as a checkout quote group, so the client never computes
 * GST: { subtotal, couponDiscount, taxableValue, productTax, feeTax, tax,
 *        fees: { delivery, platform, partner, total, taxableValue, tax, parts }, grandTotal, taxInclusive }.
 */
export function orderTotals(order) {
  const tax = round2(order?.tax || 0);
  const feeTax = round2(order?.feeTax || 0);
  const deliveryFee = round2(order?.deliveryFee || 0);
  const platformFee = round2(order?.platformFee || 0);
  const partnerFee = round2(order?.partnerFee || 0);
  const fees = feeTaxParts(deliveryFee, platformFee, partnerFee);
  return {
    subtotal: round2(order?.subtotal || 0),
    couponDiscount: round2(order?.couponDiscount || 0),
    taxableValue: round2(order?.taxableValue || 0),
    productTax: round2(tax - feeTax),
    feeTax,
    tax,
    fees: {
      delivery: deliveryFee,
      platform: platformFee,
      partner: partnerFee,
      total: round2(deliveryFee + platformFee + partnerFee),
      taxableValue: fees.feeTaxable,
      tax: feeTax,
      parts: fees.parts,
    },
    grandTotal: round2(order?.total || 0),
    taxInclusive: order?.taxInclusive !== false,
  };
}

/** One summary row per placed order (= per store group of the checkout). */
export function checkoutGroups(orders) {
  return (orders || []).map((order) => ({
    orderId: order._id,
    orderNumber: order.orderNumber,
    tenantId: order.tenantId?._id || order.tenantId,
    paymentMethod: order.paymentMethod,
    ...orderTotals(order),
  }));
}
