/**
 * The single revenue definition used by every report and dashboard.
 *
 * An order counts as revenue when:
 *   - its status is not cancelled / refunded (a pending return request stays revenue until the
 *     refund happens), and
 *   - it is not an online-payment order that has not been paid (pending / unpaid / failed).
 *     COD, purchase-order and credit-terms orders count when placed (they are collected later).
 *
 * Amounts:
 *   gmv       = sum of order `total` (what the buyer is charged, incl. fees and tax)
 *   fees      = delivery + platform + partner fees, reported separately
 *   netSales  = gmv - fees (merchandise value incl. product tax)
 *
 * Item-level returns: every received return (`returns[].status === "received"`) has already been
 * refunded (the refund is queued on receive), so its value is taken off the order:
 *   gmv      -= returns[].refundAmount  (items + any fee share refunded)
 *   netSales -= returns[].itemsAmount   (merchandise part only)
 * Fee totals stay as charged (fee shares refunded on seller-fault returns are small and only
 * reduce gmv). A fully returned order (`returned`) therefore only keeps its non-refunded fees.
 */
// Returned to origin: the goods came back to the seller and the order is reversed (stock, ledger, refund).
// rto_in_transit: the parcel is on its way back and will be reversed on arrival; not revenue either.
export const NON_REVENUE_STATUSES = ["cancelled", "refunded", "rto_in_transit", "returned_to_origin"];
export const ONLINE_METHODS = ["upi", "card", "netbanking"];

export function revenueMatch(extra = {}) {
  return {
    ...extra,
    status: { $nin: NON_REVENUE_STATUSES },
    $nor: [{ paymentMethod: { $in: ONLINE_METHODS }, paymentStatus: { $ne: "paid" } }],
  };
}

/** `$group` accumulator fields for revenue (use inside a $group stage). */
/** Sum of `field` over the order's received (refunded) returns, as an aggregation expression. */
function receivedReturns(field) {
  return {
    $reduce: {
      input: { $filter: { input: { $ifNull: ["$returns", []] }, as: "r", cond: { $eq: ["$$r.status", "received"] } } },
      initialValue: 0,
      in: { $add: ["$$value", { $ifNull: [`$$this.${field}`, 0] }] },
    },
  };
}

export function revenueGroupFields() {
  const fees = {
    $add: [{ $ifNull: ["$deliveryFee", 0] }, { $ifNull: ["$platformFee", 0] }, { $ifNull: ["$partnerFee", 0] }],
  };
  return {
    count: { $sum: 1 },
    gmv: { $sum: { $subtract: [{ $ifNull: ["$total", 0] }, receivedReturns("refundAmount")] } },
    deliveryFees: { $sum: { $ifNull: ["$deliveryFee", 0] } },
    platformFees: { $sum: { $ifNull: ["$platformFee", 0] } },
    partnerFees: { $sum: { $ifNull: ["$partnerFee", 0] } },
    netSales: { $sum: { $subtract: [{ $subtract: [{ $ifNull: ["$total", 0] }, fees] }, receivedReturns("itemsAmount")] } },
  };
}


const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Normalise one aggregated revenue row into the public shape. */
export function revenueSummary(row) {
  const count = row?.count || 0;
  const gmv = r2(row?.gmv);
  return {
    count,
    gmv,
    netSales: r2(row?.netSales),
    fees: {
      delivery: r2(row?.deliveryFees),
      platform: r2(row?.platformFees),
      partner: r2(row?.partnerFees),
      total: r2((row?.deliveryFees || 0) + (row?.platformFees || 0) + (row?.partnerFees || 0)),
    },
    aov: count ? r2(gmv / count) : 0,
  };
}

/** JS predicate equivalent of revenueMatch (for in-memory rows). */
export function isRevenueOrder(order) {
  if (!order || NON_REVENUE_STATUSES.includes(order.status)) return false;
  if (ONLINE_METHODS.includes(order.paymentMethod) && order.paymentStatus !== "paid") return false;
  return true;
}
