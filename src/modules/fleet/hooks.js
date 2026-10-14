import { DeliveryTask, TERMINAL_TASK_STATUSES } from "./models.js";
import { Tenant } from "../tenants/tenant.model.js";
import { matchZone } from "../location/service.js";
import { dayKey } from "../reports/time.js";
import { withSession, afterCommit } from "../../utils/transaction.js";
import { logger } from "../../utils/logger.js";
import { fleetSettings } from "./settings.js";

/**
 * Order-lifecycle hooks of the own delivery fleet (called from orders/lifecycle.js inside the
 * order transaction). Kept free of order / service imports so lifecycle can import it safely.
 */

const idOf = (v) => v?._id || v || null;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function isOwnFleet(order) {
  return order?.deliveryMethod === "own_fleet";
}

function dropoffOf(order) {
  const a = order.addressSnapshot || {};
  const address = [a.addressLine1, a.addressLine2, a.landmark, a.city, a.state, a.postalCode].filter(Boolean).join(", ");
  const lat = Number.isFinite(Number(a.latitude)) && a.latitude !== null && a.latitude !== undefined && !a.geoApproximate ? Number(a.latitude) : null;
  const lng = Number.isFinite(Number(a.longitude)) && a.longitude !== null && a.longitude !== undefined && !a.geoApproximate ? Number(a.longitude) : null;
  return { address, lat, lng, pincode: String(a.postalCode || "") };
}

function buyerOf(order) {
  const a = order.addressSnapshot || {};
  const b = order.buyerSnapshot || {};
  return { name: a.contactName || b.name || "", phone: a.phone || b.phone || "" };
}

/** Area used to group deliveries into runs: the matched delivery zone, else the PIN code. */
export async function areaFor(tenantId, order, session = null) {
  const a = order.addressSnapshot || {};
  const tenant = await Tenant.findById(tenantId, "deliveryZones", withSession(session)).lean();
  const match = matchZone(tenant?.deliveryZones || [], {
    postalCode: a.postalCode,
    latitude: a.latitude,
    longitude: a.longitude,
    approximate: a.geoApproximate !== false,
  });
  const name = match?.zone?.name && match.zone.name !== "default" ? match.zone.name : "";
  return name || String(a.postalCode || "") || "Other";
}

/**
 * An own-fleet order reached ready_to_ship: open its delivery task (unassigned). Idempotent per
 * order (unique index). With `fleet.autoAssign` on, auto-assignment runs after commit.
 */
export async function ensureDeliveryTask(order, session = null) {
  if (!isOwnFleet(order)) return null;
  const tenantId = idOf(order.tenantId);
  const settings = await fleetSettings(tenantId);
  const now = new Date();
  const res = await DeliveryTask.findOneAndUpdate(
    { orderId: order._id, kind: "delivery", returnId: null },
    {
      $setOnInsert: {
        tenantId,
        orderId: order._id,
        orderNumber: order.orderNumber || "",
        kind: "delivery",
        returnId: null,
        status: "unassigned",
        area: await areaFor(tenantId, order, session),
        dueDate: dayKey(now),
        maxAttempts: settings.maxAttempts,
        cod: { amount: order.paymentMethod === "cod" ? round2(order.total) : 0, method: null },
        dropoff: dropoffOf(order),
        buyer: buyerOf(order),
        history: [{ at: now, from: "", to: "unassigned", note: "Order ready to ship" }],
      },
    },
    withSession(session, { upsert: true, new: true, includeResultMetadata: true })
  );
  const task = res?.value || res;
  const created = Boolean(res?.lastErrorObject?.upserted);
  if (created && settings.autoAssign) {
    afterCommit(session, async () => {
      try {
        const { autoAssignTenant } = await import("./service.js");
        await autoAssignTenant(tenantId, { date: dayKey(now), actorId: null });
      } catch (err) {
        logger.error("fleet auto-assign failed", { orderId: String(order._id), err: err.message });
      }
    });
  }
  return task;
}

function historyRow(to, note, by = null) {
  return { at: new Date(), from: "", to, by, note };
}

/** Order cancelled before shipping: its open delivery tasks are cancelled. */
export async function cancelTasksForOrder(orderId, session = null, note = "Order cancelled") {
  await DeliveryTask.updateMany(
    { orderId: idOf(orderId), status: { $nin: TERMINAL_TASK_STATUSES } },
    { $set: { status: "cancelled", completedAt: new Date() }, $push: { history: historyRow("cancelled", note) } },
    withSession(session)
  );
}

/** Order returned to the store (RTO, by the rider or the seller): close its delivery task. */
export async function closeTasksOnRto(orderId, session = null, note = "Returned to the store") {
  await DeliveryTask.updateMany(
    { orderId: idOf(orderId), kind: "delivery", status: { $nin: TERMINAL_TASK_STATUSES } },
    { $set: { status: "returned_to_store", completedAt: new Date() }, $push: { history: historyRow("returned_to_store", note) } },
    withSession(session)
  );
}

/** Delivered outside the rider flow (platform admin override): close the delivery task. */
export async function markTasksDelivered(orderId, session = null, { actorId = null, note = "Marked delivered by the platform" } = {}) {
  await DeliveryTask.updateMany(
    { orderId: idOf(orderId), kind: "delivery", status: { $nin: TERMINAL_TASK_STATUSES } },
    { $set: { status: "delivered", completedAt: new Date() }, $push: { history: historyRow("delivered", note, actorId) } },
    withSession(session)
  );
}

/** Return received by the store: close the return's pickup task. */
export async function closeReturnPickup(orderId, returnId, session = null) {
  const filter = { orderId: idOf(orderId), kind: "return_pickup", returnId, status: { $nin: TERMINAL_TASK_STATUSES } };
  await DeliveryTask.updateMany(
    { ...filter, status: "picked_up" },
    { $set: { status: "returned_to_store", completedAt: new Date() }, $push: { history: historyRow("returned_to_store", "Return received by the store") } },
    withSession(session)
  );
  await DeliveryTask.updateMany(
    filter,
    { $set: { status: "cancelled", completedAt: new Date() }, $push: { history: historyRow("cancelled", "Return received by the store") } },
    withSession(session)
  );
}

/** Phase 6: the return's pickup failed for good (closed as pickup_failed): cancel its open pickup task. */
export async function cancelReturnPickupTask(orderId, returnId, session = null, note = "Return pickup failed") {
  await DeliveryTask.updateMany(
    { orderId: idOf(orderId), kind: "return_pickup", returnId, status: { $nin: TERMINAL_TASK_STATUSES } },
    { $set: { status: "cancelled", completedAt: new Date() }, $push: { history: historyRow("cancelled", note) } },
    withSession(session)
  );
}

/** Seller approved a return of an own-fleet order: open a return-pickup task (idempotent per return). */
export async function createReturnPickupTask(order, ret) {
  if (!isOwnFleet(order) || !ret?._id) return null;
  const tenantId = idOf(order.tenantId);
  const settings = await fleetSettings(tenantId);
  const now = new Date();
  const lines = (ret.items || []).map((it) => {
    const line = (order.items || []).find((i) => String(i._id) === String(it.itemId));
    return { lineId: it.itemId, name: it.name || line?.name || "", qty: it.qty, okQty: 0, damagedQty: 0, note: "" };
  });
  return DeliveryTask.findOneAndUpdate(
    { orderId: order._id, kind: "return_pickup", returnId: ret._id },
    {
      $setOnInsert: {
        tenantId,
        orderId: order._id,
        orderNumber: order.orderNumber || "",
        kind: "return_pickup",
        returnId: ret._id,
        status: "unassigned",
        area: await areaFor(tenantId, order),
        dueDate: dayKey(now),
        maxAttempts: settings.maxAttempts,
        cod: { amount: 0, method: null },
        itemCheck: lines,
        dropoff: dropoffOf(order),
        buyer: buyerOf(order),
        history: [{ at: now, from: "", to: "unassigned", note: "Return approved: pickup by the store's rider" }],
      },
    },
    { upsert: true, new: true }
  );
}
