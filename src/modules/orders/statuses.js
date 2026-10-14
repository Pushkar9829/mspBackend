import { ORDER_STATUSES } from "../../config/constants.js";

/**
 * Order statuses used by the commerce core. The shared list lives in config/constants.js; the
 * return flow uses `return_requested` -> `return_approved` -> `returned` (all lines back) or back
 * to `delivered` (some lines returned, others kept).
 */
export const RETURN_FLOW_STATUSES = ["return_requested", "return_approved", "returned"];
/**
 * Return to origin (RTO), two steps:
 *  - `rto_in_transit`: the carrier could not deliver and is bringing the parcel back. Nothing
 *    moves yet (no restock, no refund, no credit note).
 *  - `returned_to_origin`: the parcel physically reached the seller (seller marks it with per-line
 *    damaged qty, or the carrier's "RTO delivered" scan). Terminal, like `cancelled`: stock
 *    restored (damaged units to damaged stock), ledger debit reversed, paid online orders
 *    refunded, credit note issued; COD was never collected.
 */
export const RTO_IN_TRANSIT = "rto_in_transit";
export const RTO_STATUS = "returned_to_origin";
/** Statuses an order can be marked returned_to_origin from. */
export const RTO_FROM_STATUSES = ["shipped", "out_for_delivery", RTO_IN_TRANSIT];
/** Statuses an order can be marked rto_in_transit from. */
export const RTO_IN_TRANSIT_FROM = ["shipped", "out_for_delivery"];
export const ORDER_STATUS_LIST = [...new Set([...ORDER_STATUSES, ...RETURN_FLOW_STATUSES, "refunded", RTO_IN_TRANSIT, RTO_STATUS])];

export const CANCELLABLE_STATUSES = ["pending", "confirmed", "processing", "ready_to_ship"];
/** Buyers can cancel any time before the order ships. */
export const BUYER_CANCELLABLE_STATUSES = CANCELLABLE_STATUSES;
/** Refund without a return (goods stay with the buyer) or after the return was received. */
export const REFUNDABLE_STATUSES = ["delivered", "returned"];

/** Allowed manual transitions (the lifecycle functions enforce them atomically). */
export const ALLOWED_TRANSITIONS = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["ready_to_ship", "cancelled"],
  ready_to_ship: ["shipped", "cancelled"],
  shipped: ["out_for_delivery", "delivered", RTO_IN_TRANSIT, RTO_STATUS],
  out_for_delivery: ["delivered", RTO_IN_TRANSIT, RTO_STATUS],
  [RTO_IN_TRANSIT]: [RTO_STATUS],
  delivered: ["return_requested", "refunded"],
  return_requested: ["return_approved", "delivered"],
  return_approved: ["returned"],
  returned: ["refunded"],
};

export function previousStatusesFor(status) {
  return Object.entries(ALLOWED_TRANSITIONS)
    .filter(([, next]) => next.includes(status))
    .map(([from]) => from);
}

/** Human labels (API `statusLabel`, notifications, PDFs). */
export const STATUS_LABELS = {
  pending: "Pending",
  confirmed: "Confirmed",
  processing: "Processing",
  ready_to_ship: "Ready to ship",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  return_requested: "Return requested",
  return_approved: "Return approved",
  returned: "Returned",
  refunded: "Refunded",
  [RTO_IN_TRANSIT]: "Returning to seller",
  [RTO_STATUS]: "Returned to seller",
};

export const EVENT_MAP = {
  confirmed: "ORDER_CONFIRMED",
  processing: "ORDER_PROCESSING",
  ready_to_ship: "ORDER_READY",
  shipped: "ORDER_SHIPPED",
  out_for_delivery: "ORDER_OUT_FOR_DELIVERY",
  delivered: "ORDER_DELIVERED",
  cancelled: "ORDER_CANCELLED",
  return_requested: "ORDER_RETURN_REQUESTED",
  return_approved: "ORDER_RETURN_APPROVED",
  returned: "ORDER_RETURNED",
  refunded: "ORDER_REFUNDED",
  [RTO_IN_TRANSIT]: "ORDER_RTO_IN_TRANSIT",
  [RTO_STATUS]: "ORDER_RETURNED_TO_ORIGIN",
};

/**
 * Return reasons. `sellerFault` reasons refund the returned lines' value plus their proportional
 * share of the fees (delivery / partner / platform); buyer-choice reasons refund item value only.
 * Free-text reasons from older clients are classified by keyword (sellerFaultReason).
 */
export const RETURN_REASONS = [
  { code: "damaged", label: "Damaged or defective item", sellerFault: true },
  { code: "wrong_item", label: "Wrong item received", sellerFault: true },
  { code: "missing_item", label: "Item or parts missing", sellerFault: true },
  { code: "expired", label: "Expired or near expiry", sellerFault: true },
  { code: "not_as_described", label: "Not as described", sellerFault: true },
  { code: "changed_mind", label: "Changed my mind", sellerFault: false },
  { code: "ordered_by_mistake", label: "Ordered by mistake", sellerFault: false },
  { code: "better_price", label: "Found a better price", sellerFault: false },
  { code: "other", label: "Other", sellerFault: false },
];

const SELLER_FAULT_RX = /(damag|defect|broken|wrong|missing|expir|not as described|leak|torn|spoil|fake|counterfeit)/i;

/** { code, label, sellerFault } for a reason code or free-text reason. */
export function classifyReason(reason) {
  const text = String(reason || "").trim();
  const byCode = RETURN_REASONS.find((r) => r.code === text.toLowerCase() || r.label.toLowerCase() === text.toLowerCase());
  if (byCode) return { ...byCode };
  return { code: "other", label: text || "Other", sellerFault: SELLER_FAULT_RX.test(text) };
}
