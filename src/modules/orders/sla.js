import { getCachedSetting } from "../settings/service.js";
import { SETTINGS_REGISTRY } from "../settings/registry.js";

/** Defaults for the order SLA settings (platform settings `orders.confirmWithinHours` / `orders.shipWithinHours`). */
export const DEFAULT_CONFIRM_WITHIN_HOURS = 48;
export const DEFAULT_SHIP_WITHIN_HOURS = 72;

/** Offline orders (no online payment to time out) that the seller must confirm in time. */
export const OFFLINE_PAYMENT_METHODS = ["cod", "credit_terms", "purchase_order"];

const HOUR = 60 * 60 * 1000;

function hours(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function confirmedAt(order) {
  const entry = (order.statusHistory || []).find((h) => h.status === "confirmed");
  return entry?.at ? new Date(entry.at) : null;
}

const NOT_SHIPPED = ["confirmed", "processing", "ready_to_ship"];

/**
 * Order SLA settings plus a per-order view:
 *   { confirmWithinHours, shipWithinHours, forOrder(order) -> { confirmBy, confirmOverdue, shipBy, shipOverdue } }.
 * Confirm: pending offline orders not confirmed by `confirmBy` are auto-cancelled (job
 * `order-sla`). Ship (phase 6): orders not shipped by `shipBy` are auto-cancelled by the same job
 * (`orders.shipSlaAutoCancel`, cancelReason `ship_timeout`), except packed orders already booked
 * with a courier (flagged late only).
 */
export async function orderSla() {
  const [confirmRaw, shipRaw, warnRaw] = await Promise.all([
    getCachedSetting("platform", null, "orders.confirmWithinHours", DEFAULT_CONFIRM_WITHIN_HOURS),
    getCachedSetting("platform", null, "orders.shipWithinHours", DEFAULT_SHIP_WITHIN_HOURS),
    getCachedSetting("platform", null, "notifications.deadlineWarningHours", 2),
  ]);
  const confirmWithinHours = hours(confirmRaw, DEFAULT_CONFIRM_WITHIN_HOURS);
  const shipWithinHours = hours(shipRaw, DEFAULT_SHIP_WITHIN_HOURS);
  const warningHours = hours(warnRaw, 2);
  const now = Date.now();
  const soon = (date) => Boolean(date && date.getTime() > now && date.getTime() - now <= warningHours * HOUR);
  return {
    confirmWithinHours,
    shipWithinHours,
    warningHours,
    /**
     * { confirmBy, confirmOverdue, shipBy, shipOverdue } plus (phase 6) warningHours,
     * confirmDueSoon, shipDueSoon, returnDecideBy (active requested return), returnDecideDueSoon,
     * returnDecideOverdue — "due soon" = deadline within warningHours (badges / reminders).
     */
    forOrder(order) {
      const created = new Date(order.createdAt || now).getTime();
      const confirmBy = OFFLINE_PAYMENT_METHODS.includes(order.paymentMethod) ? new Date(created + confirmWithinHours * HOUR) : null;
      const from = confirmedAt(order)?.getTime() || created;
      const shipBy = order.status === "pending" || NOT_SHIPPED.includes(order.status) ? new Date(from + shipWithinHours * HOUR) : null;
      const requested = (order.returns || []).find((r) => r.status === "requested");
      const returnDecideBy = requested?.decideBy ? new Date(requested.decideBy) : null;
      const pendingConfirm = order.status === "pending" ? confirmBy : null;
      return {
        confirmBy: pendingConfirm,
        confirmOverdue: Boolean(order.status === "pending" && confirmBy && now > confirmBy.getTime()),
        shipBy,
        shipOverdue: Boolean(shipBy && NOT_SHIPPED.includes(order.status) && now > shipBy.getTime()),
        warningHours,
        confirmDueSoon: soon(pendingConfirm),
        shipDueSoon: Boolean(NOT_SHIPPED.includes(order.status) && soon(shipBy)),
        returnDecideBy,
        returnDecideDueSoon: soon(returnDecideBy),
        returnDecideOverdue: Boolean(returnDecideBy && now > returnDecideBy.getTime()),
      };
    },
  };
}

/* ------------------------------------------------------------------ phase 6 */

/** Machine cancel reasons of deadline auto-cancels (seller's fault, ORDER_AUTO_CANCELLED). */
export const SLA_CANCEL_REASONS = ["seller_timeout", "ship_timeout"];
export const NOT_SHIPPED_STATUSES = NOT_SHIPPED;

/**
 * Effective value of a setting: store override (only for keys with a tenant scope) -> platform
 * value -> registry default. Cached reads (60 s, cleared on writes).
 */
export async function effectiveSetting(tenantId, key) {
  const def = SETTINGS_REGISTRY[key];
  if (tenantId && def?.scopes.includes("tenant")) {
    const own = await getCachedSetting("tenant", String(tenantId?._id || tenantId), key, undefined);
    if (own !== undefined && own !== null) return own;
  }
  const platform = await getCachedSetting("platform", null, key, undefined);
  return platform !== undefined && platform !== null ? platform : def?.default;
}

/** Phase 6 deadline settings (hours / days, validated + defaulted). `tenantId` applies store overrides. */
export async function phase6Sla(tenantId = null) {
  const [decide, refund, pickups, windowDays, sellerHours, warn, autoCancel] = await Promise.all([
    effectiveSetting(tenantId, "returns.decideWithinHours"),
    effectiveSetting(tenantId, "returns.refundWithinHours"),
    effectiveSetting(tenantId, "returns.maxPickupAttempts"),
    effectiveSetting(null, "disputes.windowDays"),
    effectiveSetting(null, "disputes.sellerResponseHours"),
    effectiveSetting(null, "notifications.deadlineWarningHours"),
    effectiveSetting(null, "orders.shipSlaAutoCancel"),
  ]);
  return {
    decideWithinHours: hours(decide, 48),
    refundWithinHours: hours(refund, 48),
    maxPickupAttempts: Math.max(1, Math.min(5, Math.round(hours(pickups, 3)))),
    disputeWindowDays: hours(windowDays, 7),
    sellerResponseHours: hours(sellerHours, 48),
    warningHours: hours(warn, 2),
    shipSlaAutoCancel: autoCancel !== false,
  };
}

/** When the seller must decide a return requested at `requestedAt`. */
export function decideByFor(requestedAt, decideWithinHours) {
  return new Date(new Date(requestedAt || Date.now()).getTime() + decideWithinHours * HOUR);
}

export { HOUR };
