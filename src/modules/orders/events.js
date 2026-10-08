import { Order } from "./order.model.js";
import { bus } from "../../utils/events.js";
import { afterCommit } from "../../utils/transaction.js";

/**
 * ORDER_UPDATED: one lightweight event after commit for every order state change (status,
 * payment status, refund status). Payload: `{ order: { _id, tenantId, buyerId, orderNumber,
 * status, paymentStatus, paymentMethod, grandTotal, fulfillmentMode } }` (fulfillmentMode is the
 * lines' common mode or "mixed"). The order is re-read after commit, so the payload always reflects
 * the committed state even when several updates ran in the same transaction.
 *
 * Emitted on the bus directly (not through emitDomain) so it is not recorded as an analytics
 * event: it duplicates the specific ORDER_* events, which are.
 */
export const ORDER_UPDATED = "ORDER_UPDATED";

const FIELDS = "_id tenantId buyerId orderNumber status paymentStatus paymentMethod total items.fulfillmentMode";

/** The order's fulfilment mode: the lines' common mode, "mixed" when they differ, null when unknown. */
function fulfillmentModeOf(items) {
  const modes = [...new Set((items || []).map((i) => i?.fulfillmentMode).filter(Boolean))];
  if (!modes.length) return null;
  return modes.length === 1 ? modes[0] : "mixed";
}

export function orderUpdatedPayload(order) {
  const o = typeof order?.toObject === "function" ? order.toObject() : order || {};
  return {
    order: {
      _id: o._id,
      tenantId: o.tenantId?._id || o.tenantId || null,
      buyerId: o.buyerId?._id || o.buyerId || null,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      paymentMethod: o.paymentMethod,
      grandTotal: o.total,
      fulfillmentMode: fulfillmentModeOf(o.items),
    },
  };
}

function idOf(value) {
  return value?._id || value;
}

/** Re-read the orders and emit ORDER_UPDATED for each. Never throws. */
export async function emitOrderUpdated(orders) {
  const ids = (Array.isArray(orders) ? orders : [orders]).map(idOf).filter(Boolean);
  if (!ids.length) return 0;
  try {
    const rows = await Order.find({ _id: { $in: ids } }).select(FIELDS).lean();
    for (const row of rows) {
      const payload = orderUpdatedPayload(row);
      bus.emit(ORDER_UPDATED, payload);
      bus.emit("*", { event: ORDER_UPDATED, payload });
    }
    return rows.length;
  } catch (err) {
    console.error("ORDER_UPDATED emit failed", err?.message);
    return 0;
  }
}

/**
 * Schedule ORDER_UPDATED for after the transaction commits (once per order per transaction).
 * Without a session the event fires on the next tick.
 */
export function orderUpdatedAfterCommit(session, order) {
  const id = idOf(order);
  if (!id) return;
  if (session) {
    const seen = (session.__orderUpdated ||= new Set());
    if (seen.has(String(id))) return;
    seen.add(String(id));
  }
  afterCommit(session, () => emitOrderUpdated([id]));
}
