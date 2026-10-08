import { ORDER_STATUSES } from "../../config/constants.js";

/**
 * Order statuses used by the commerce core. The shared list lives in config/constants.js
 * (Agent B); the return flow adds `return_approved` (seller accepted, goods on their way back)
 * and `returned` (goods received and inspected; stock restored) until B adds them there.
 */
export const RETURN_FLOW_STATUSES = ["return_requested", "return_approved", "returned"];
/**
 * `returned_to_origin` (RTO): the carrier could not deliver and brought the parcel back to the
 * store (Delhivery RTO / DTO). Terminal, like `cancelled`: stock restored, ledger debit reversed,
 * paid online orders refunded, COD never collected.
 */
export const RTO_STATUS = "returned_to_origin";
export const RTO_FROM_STATUSES = ["shipped", "out_for_delivery"];
export const ORDER_STATUS_LIST = [...new Set([...ORDER_STATUSES, ...RETURN_FLOW_STATUSES, "refunded", RTO_STATUS])];

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
  shipped: ["out_for_delivery", "delivered", RTO_STATUS],
  out_for_delivery: ["delivered", RTO_STATUS],
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
  [RTO_STATUS]: "ORDER_RETURNED_TO_ORIGIN",
};
