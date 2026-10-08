import { Order } from "./order.model.js";
import { User } from "../users/user.model.js";
import { AppError } from "../../utils/AppError.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import {
  confirmOrder,
  cancelOrder,
  refundOrder,
  advanceOrder,
  requestReturn as lifecycleRequestReturn,
  rejectReturn as lifecycleRejectReturn,
  approveReturn as lifecycleApproveReturn,
  receiveReturn as lifecycleReceiveReturn,
  returnToOrigin,
} from "./lifecycle.js";
import {
  ORDER_STATUS_LIST,
  ALLOWED_TRANSITIONS,
  BUYER_CANCELLABLE_STATUSES,
  CANCELLABLE_STATUSES,
  RTO_STATUS,
  RTO_FROM_STATUSES,
} from "./statuses.js";
import { getInvoiceForOrder, creditNotesForOrder, INVOICEABLE } from "../invoices/service.js";
import { orderTotals } from "./totals.js";
import { ONLINE_PAYMENT_METHODS } from "../checkout/razorpayApi.js";
import { renderTaxDocumentPdf } from "../invoices/pdf.js";
import { addItem, getOrCreateCart, quoteCart } from "../cart/service.js";
import { Product } from "../catalog/product.model.js";
import { ProductVariant } from "../catalog/variant.model.js";
import { variantStockMap } from "../catalog/service.js";
import { qtyRules } from "../pricing/engine.js";
import { getCommerceSettings } from "../settings/commerce.js";
import { delhiveryConfigured, trackShipment, mapDelhiveryStatus } from "../shipping/delhivery.js";
import { parseBound } from "../reports/time.js";
import { asObjectId } from "../../middleware/tenantScope.js";
import { PAYMENT_METHODS, PAYMENT_STATUSES, FULFILLMENT_MODES } from "../../config/constants.js";
import { retryFailedRefund } from "../checkout/refunds.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasPerm(req, perm) {
  const perms = req.permissions || [];
  return req.isPlatformAdmin === true || perms.includes("*") || perms.includes(perm);
}

/**
 * Buyers are identified by their (system buyer) role, never by a missing permission: staff with
 * only `orders.view` see their store's orders, buyers only their own.
 */
export function ownOrdersOnly(req) {
  return !req.isPlatformAdmin && Boolean(req.isBuyer);
}

function isBuyerOf(req, order) {
  return String(order.buyerId?._id || order.buyerId) === String(req.user._id);
}

export async function getInvoice(req, id) {
  const order = await getOrder(req, id);
  return getInvoiceForOrder(order);
}

export async function getInvoicePdf(req, id) {
  const order = await getOrder(req, id);
  const invoice = await getInvoiceForOrder(order);
  return {
    filename: `${String(invoice.invoiceNumber).replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`,
    buffer: renderTaxDocumentPdf(invoice, { title: "TAX INVOICE", number: invoice.invoiceNumber }),
  };
}

export async function getCreditNotes(req, id) {
  const order = await getOrder(req, id);
  return creditNotesForOrder(order);
}

/** One credit note of the order as a PDF (same generator as the invoice). `noteId` = id or credit note number. */
export async function getCreditNotePdf(req, id, noteId) {
  const order = await getOrder(req, id);
  const key = String(noteId || "");
  const notes = await creditNotesForOrder(order);
  const note = notes.find((n) => String(n._id) === key || n.creditNoteNumber === key);
  if (!note) throw new AppError(404, "Credit note not found", "NOT_FOUND");
  return {
    filename: `${String(note.creditNoteNumber).replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`,
    buffer: renderTaxDocumentPdf(note, { title: "CREDIT NOTE", number: note.creditNoteNumber }),
  };
}

const REFUND_STATUSES = ["pending", "processing", "processed", "failed"];
const RETURN_STATUSES = ["requested", "approved", "rejected", "received"];
/** The returns work queue: requested (decide), approved (awaiting goods), returned (awaiting refund). */
export const RETURN_QUEUE_STATUSES = ["return_requested", "return_approved", "returned"];
const SORT_FIELDS = { createdAt: "createdAt", grandTotal: "total", total: "total", status: "status", orderNumber: "orderNumber" };

function listParam(value, allowed, name) {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const out = raw.map((v) => String(v).trim()).filter(Boolean);
  const bad = out.find((v) => !allowed.includes(v));
  if (bad) throw new AppError(400, `Invalid ${name} "${bad}". Use one of: ${allowed.join(", ")}`, "VALIDATION_ERROR");
  return out;
}

function inOrEq(values) {
  return values.length === 1 ? values[0] : { $in: values };
}

/**
 * Shared order filter for GET /orders and GET /reports/export/orders. Query params:
 *   status, paymentStatus, paymentMethod, fulfillmentMode, refundStatus, returnStatus
 *   (each a single value or a comma list), queue=returns, buyerId (staff only),
 *   from/to ("YYYY-MM-DD" = IST calendar day, or ISO timestamps), q (order number, PO number,
 *   tracking number; for staff also buyer name / email / phone / company).
 */
export async function buildOrderFilter(req, query = req.query || {}) {
  const and = [];
  const filter = ownOrdersOnly(req) ? { buyerId: req.user._id } : tenantFilter(req);

  const statuses = listParam(query.status, ORDER_STATUS_LIST, "status");
  if (statuses.length) filter.status = inOrEq(statuses);
  const payStatuses = listParam(query.paymentStatus, PAYMENT_STATUSES, "paymentStatus");
  if (payStatuses.length) filter.paymentStatus = inOrEq(payStatuses);
  const methods = listParam(query.paymentMethod, PAYMENT_METHODS, "paymentMethod");
  if (methods.length) filter.paymentMethod = inOrEq(methods);
  const modes = listParam(query.fulfillmentMode, FULFILLMENT_MODES, "fulfillmentMode");
  if (modes.length) filter["items.fulfillmentMode"] = inOrEq(modes);
  const refundStatuses = listParam(query.refundStatus, REFUND_STATUSES, "refundStatus");
  if (refundStatuses.length) filter["refunds.status"] = inOrEq(refundStatuses);
  const returnStatuses = listParam(query.returnStatus, RETURN_STATUSES, "returnStatus");
  if (returnStatuses.length) filter["returnRequest.status"] = inOrEq(returnStatuses);
  if (query.queue !== undefined && query.queue !== "") {
    if (String(query.queue) !== "returns") throw new AppError(400, "queue must be: returns", "VALIDATION_ERROR");
    and.push({ status: { $in: RETURN_QUEUE_STATUSES } });
  }
  if (query.buyerId && !ownOrdersOnly(req)) {
    const buyerId = asObjectId(query.buyerId);
    if (!buyerId) throw new AppError(400, "Invalid buyerId", "INVALID_ID");
    filter.buyerId = buyerId;
  }
  const from = parseBound(query.from);
  const to = parseBound(query.to, true);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  const q = String(query.q || "").trim();
  if (q) {
    const rx = new RegExp(escapeRegex(q.slice(0, 100)), "i");
    const or = [{ orderNumber: rx }, { poNumber: rx }, { "fulfillments.trackingNumber": rx }];
    if (!ownOrdersOnly(req)) {
      or.push({ "buyerSnapshot.name": rx }, { "buyerSnapshot.email": rx }, { "buyerSnapshot.phone": rx }, { "buyerSnapshot.company": rx });
      const buyers = await User.find({ $or: [{ email: rx }, { name: rx }, { phone: rx }] }).select("_id").limit(50);
      if (buyers.length) or.push({ buyerId: { $in: buyers.map((u) => u._id) } });
    }
    and.push({ $or: or });
  }
  if (and.length) filter.$and = and;
  return filter;
}

/** sort = createdAt | grandTotal (alias total) | status | orderNumber; order = asc | desc. Default createdAt desc. */
export function orderSort(query = {}) {
  const key = SORT_FIELDS[String(query.sort || "createdAt")];
  if (!key) throw new AppError(400, `sort must be one of: ${Object.keys(SORT_FIELDS).join(", ")}`, "VALIDATION_ERROR");
  const dir = String(query.order || "desc").toLowerCase() === "asc" ? 1 : -1;
  return key === "createdAt" ? { createdAt: dir, _id: dir } : { [key]: dir, createdAt: -1, _id: -1 };
}

export async function listOrders(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = await buildOrderFilter(req);
  const [data, total] = await Promise.all([
    Order.find(filter)
      .populate("tenantId", "name slug")
      .populate("buyerId", "name email phone")
      .sort(orderSort(req.query))
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);
  // Every row carries the same allowedActions (and returnUntil) as GET /orders/:id, so list views
  // need no detail fetch per row. One commerce-settings read per page.
  const commerce = await getCommerceSettings();
  const rows = data.map((order) => ({
    ...order.toObject(),
    returnUntil: returnDeadline(order, commerce),
    allowedActions: allowedActions(req, order, commerce),
  }));
  return paginated(rows, total, { page, limit });
}

/**
 * Refund intents of the store's orders, one row per refund (default status=failed), newest first.
 * Rows: { orderId, orderNumber, tenantId, tenantName, buyerId, buyer, orderStatus, paymentStatus, paymentMethod, total, refund }.
 */
export async function listRefunds(req) {
  const { page, limit, skip } = paginate(req.query);
  const statuses = listParam(req.query.status || "failed", REFUND_STATUSES, "status");
  const [result] = await Order.aggregate([
    { $match: { ...tenantFilter(req), "refunds.status": { $in: statuses } } },
    { $unwind: "$refunds" },
    { $match: { "refunds.status": { $in: statuses } } },
    { $sort: { "refunds.updatedAt": -1, _id: -1 } },
    {
      $facet: {
        data: [
          { $skip: skip },
          { $limit: limit },
          { $lookup: { from: "tenants", localField: "tenantId", foreignField: "_id", as: "tenantRow" } },
          {
            $project: {
              _id: 0,
              orderId: "$_id",
              orderNumber: 1,
              tenantId: 1,
              tenantName: { $ifNull: [{ $arrayElemAt: ["$tenantRow.name", 0] }, ""] },
              buyerId: 1,
              buyer: "$buyerSnapshot",
              orderStatus: "$status",
              paymentStatus: 1,
              paymentMethod: 1,
              total: 1,
              refund: "$refunds",
            },
          },
        ],
        total: [{ $count: "n" }],
      },
    },
  ]);
  return paginated(result?.data || [], result?.total?.[0]?.n || 0, { page, limit });
}

/** Re-run one failed refund intent (resets its attempt counter). */
export async function retryRefund(req, id, key) {
  if (!hasPerm(req, "orders.refund")) throw new AppError(403, "Missing permission orders.refund", "FORBIDDEN");
  const order = await getOrder(req, id);
  const row = (order.refunds || []).find((r) => r.key === key);
  if (!row) throw new AppError(404, "Refund not found", "NOT_FOUND");
  if (row.status !== "failed") throw new AppError(409, `Refund is ${row.status}; only failed refunds can be retried`, "INVALID_STATE");
  const result = await retryFailedRefund(order._id, key);
  if (!result) throw new AppError(409, "Refund changed while retrying. Refresh and try again.", "INVALID_STATE");
  return result;
}

export async function getOrder(req, id) {
  const isOid = /^[a-f\d]{24}$/i.test(id);
  const filter = isOid ? { _id: id } : { orderNumber: String(id) };
  if (ownOrdersOnly(req)) filter.buyerId = req.user._id;
  else Object.assign(filter, tenantFilter(req));
  const order = await Order.findOne(filter)
    .populate("tenantId", "name slug")
    .populate("buyerId", "name email phone profile");
  if (!order) throw new AppError(404, "Order not found", "NOT_FOUND");
  return order;
}

export async function updateNotes(req, id, { sellerNotes } = {}) {
  const order = await getOrder(req, id);
  return Order.findOneAndUpdate(
    { _id: order._id },
    { $set: { sellerNotes: String(sellerNotes || "").slice(0, 2000) } },
    { new: true }
  );
}

/** Generic status endpoint; every branch is an atomic conditional transition. */
export async function updateStatus(req, id, status, note, extra = {}) {
  if (!ORDER_STATUS_LIST.includes(status)) {
    throw new AppError(400, "Invalid status", "VALIDATION_ERROR");
  }
  const order = await getOrder(req, id);
  const allowed = ALLOWED_TRANSITIONS[order.status] || [];
  if (!allowed.includes(status)) {
    throw new AppError(400, `Cannot move from ${order.status} to ${status}`, "INVALID_STATE");
  }
  if (ownOrdersOnly(req)) {
    if (status !== "cancelled" || !hasPerm(req, "orders.cancel")) {
      throw new AppError(403, "You can only cancel your own orders", "FORBIDDEN");
    }
    return cancelForBuyer(req, order, note);
  }
  if (status === "refunded") {
    if (!hasPerm(req, "orders.refund")) throw new AppError(403, "Missing permission orders.refund", "FORBIDDEN");
    return refundOrder(order, req.user._id, note);
  }
  if (status === "cancelled") {
    if (!hasPerm(req, "orders.cancel") && !hasPerm(req, "orders.update")) {
      throw new AppError(403, "Missing permission orders.cancel", "FORBIDDEN");
    }
    return cancelOrder(order, req.user._id, note);
  }
  if (["return_requested", "return_approved", "returned"].includes(status) || (order.status === "return_requested" && status === "delivered")) {
    throw new AppError(400, "Use the return endpoints for this change", "INVALID_STATE");
  }
  if (!hasPerm(req, "orders.update")) throw new AppError(403, "Missing permission orders.update", "FORBIDDEN");
  if (status === "confirmed") return confirmOrder(order, req.user._id);
  if (status === RTO_STATUS) return returnToOrigin(order, req.user._id, note);
  return advanceOrder(order, status, {
    actorId: req.user._id,
    note,
    trackingNumber: extra.trackingNumber,
    carrier: extra.carrier,
  });
}

async function cancelForBuyer(req, order, note) {
  if (!isBuyerOf(req, order)) throw new AppError(403, "You can only cancel your own orders", "FORBIDDEN");
  if (!BUYER_CANCELLABLE_STATUSES.includes(order.status)) {
    throw new AppError(400, "This order has shipped and can no longer be cancelled. Request a return after delivery.", "INVALID_STATE");
  }
  return cancelOrder(order, req.user._id, note || "Cancelled by buyer", { from: BUYER_CANCELLABLE_STATUSES });
}

/** POST /orders/:id/cancel — buyer (own order, before shipping) or seller with orders.cancel. */
export async function cancel(req, id, note) {
  const order = await getOrder(req, id);
  if (isBuyerOf(req, order) && ownOrdersOnly(req)) return cancelForBuyer(req, order, note);
  if (!hasPerm(req, "orders.cancel") && !hasPerm(req, "orders.update")) {
    throw new AppError(403, "Missing permission orders.cancel", "FORBIDDEN");
  }
  if (!CANCELLABLE_STATUSES.includes(order.status)) {
    throw new AppError(400, "Order cannot be cancelled once it has shipped", "INVALID_STATE");
  }
  return cancelOrder(order, req.user._id, note);
}

export async function refund(req, id, note) {
  if (ownOrdersOnly(req) || !hasPerm(req, "orders.refund")) throw new AppError(403, "Missing permission orders.refund", "FORBIDDEN");
  const order = await getOrder(req, id);
  return refundOrder(order, req.user._id, note);
}

function deliveredAt(order) {
  if (order.deliveredAt) return new Date(order.deliveredAt);
  const entry = [...(order.statusHistory || [])].reverse().find((h) => h.status === "delivered");
  return entry?.at ? new Date(entry.at) : new Date(order.updatedAt);
}

/** Last moment a return can be requested, or null when the order has nothing returnable. */
export function returnDeadline(order, commerce) {
  if (!commerce.returnsEnabled || order.status !== "delivered") return null;
  if (!(order.items || []).some((item) => item.easyReturn)) return null;
  return new Date(deliveredAt(order).getTime() + commerce.returnWindowDays * 24 * 60 * 60 * 1000);
}

const TRACKABLE_STATUSES = ["shipped", "out_for_delivery", "delivered", "return_requested", "return_approved", "returned", RTO_STATUS];

/**
 * What the caller may do with this order right now, computed with the same rules the action
 * endpoints enforce: { cancel, return, reorder, invoice, track, pay } (booleans) plus
 * `reasons` (why an action is unavailable, for the ones a buyer could expect).
 */
export function allowedActions(req, order, commerce) {
  const buyer = isBuyerOf(req, order);
  const ownOnly = ownOrdersOnly(req);
  const reasons = {};
  let cancel;
  if (buyer && ownOnly) {
    cancel = BUYER_CANCELLABLE_STATUSES.includes(order.status) && (hasPerm(req, "orders.cancel") || hasPerm(req, "orders.update"));
    if (!cancel) reasons.cancel = BUYER_CANCELLABLE_STATUSES.includes(order.status) ? "Not permitted" : "The order has shipped or is closed";
  } else {
    cancel = CANCELLABLE_STATUSES.includes(order.status) && (hasPerm(req, "orders.cancel") || hasPerm(req, "orders.update"));
  }
  const deadline = returnDeadline(order, commerce);
  const ret = Boolean(
    buyer && commerce.returnsEnabled && order.status === "delivered" && !order.returnRequest?.status && deadline && Date.now() <= deadline.getTime()
  );
  if (!ret && buyer) {
    if (!commerce.returnsEnabled) reasons.return = "Returns are not available right now";
    else if (order.returnRequest?.status) reasons.return = "A return was already requested";
    else if (order.status !== "delivered") reasons.return = "Returns open after delivery";
    else if (!deadline) reasons.return = "None of the items can be returned";
    else reasons.return = `The ${commerce.returnWindowDays}-day return window has ended`;
  }
  const reorder = buyer && hasPerm(req, "orders.create");
  const invoice = Boolean(order.invoiceId) || INVOICEABLE.includes(order.status);
  if (!invoice) reasons.invoice = "The invoice is issued once the seller confirms the order";
  const track =
    (order.fulfillments || []).some((f) => f.trackingNumber && !f.cancelledAt) || TRACKABLE_STATUSES.includes(order.status);
  const pay =
    buyer &&
    ONLINE_PAYMENT_METHODS.includes(order.paymentMethod) &&
    order.status === "pending" &&
    order.paymentStatus !== "paid";
  return { cancel, return: ret, reorder, invoice, track, pay, returnUntil: deadline, reasons };
}

export { orderTotals };

export async function requestReturn(req, id, { reason, note } = {}) {
  const order = await getOrder(req, id);
  if (!isBuyerOf(req, order)) throw new AppError(403, "Only the buyer can request a return", "FORBIDDEN");
  const commerce = await getCommerceSettings();
  if (!commerce.returnsEnabled) throw new AppError(400, "Returns are not available right now", "RETURNS_DISABLED");
  if (order.returnRequest?.status) throw new AppError(400, "A return was already requested for this order", "INVALID_STATE");
  if (order.status !== "delivered") throw new AppError(400, "Returns can be requested only after delivery", "INVALID_STATE");
  const deadline = returnDeadline(order, commerce);
  if (!deadline) throw new AppError(400, "None of the items in this order can be returned", "NOT_RETURNABLE");
  if (Date.now() > deadline.getTime()) {
    throw new AppError(400, `The ${commerce.returnWindowDays}-day return window has ended`, "RETURN_WINDOW_OVER");
  }
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) throw new AppError(400, "Choose a reason for the return", "VALIDATION_ERROR");
  return lifecycleRequestReturn(order, { actorId: req.user._id, reason: cleanReason, note });
}

function sellerOnly(req, what) {
  if (ownOrdersOnly(req)) throw new AppError(403, `Only the store can ${what}`, "FORBIDDEN");
}

export async function rejectReturn(req, id, note) {
  sellerOnly(req, "reject a return");
  const reason = String(note || "").trim();
  if (!reason) throw new AppError(400, "Tell the buyer why the return was rejected", "VALIDATION_ERROR");
  const order = await getOrder(req, id);
  return lifecycleRejectReturn(order, { actorId: req.user._id, note: reason });
}

export async function approveReturn(req, id, note) {
  sellerOnly(req, "approve a return");
  const order = await getOrder(req, id);
  return lifecycleApproveReturn(order, { actorId: req.user._id, note: note || "" });
}

/** `items`: [{ itemId, damagedQty }] — damaged units are booked as damaged, the rest restocked. */
export async function receiveReturn(req, id, { note, items = [] } = {}) {
  sellerOnly(req, "receive a return");
  const order = await getOrder(req, id);
  const damaged = {};
  for (const row of items) {
    const line = order.items.id(row.itemId);
    if (!line) throw new AppError(400, `Unknown order item ${row.itemId}`, "VALIDATION_ERROR");
    if (row.damagedQty > line.qty) throw new AppError(400, `Damaged qty exceeds ordered qty for ${line.name}`, "VALIDATION_ERROR");
    damaged[String(line._id)] = row.damagedQty;
  }
  return lifecycleReceiveReturn(order, { actorId: req.user._id, note, damaged });
}

export async function getTracking(req, id) {
  const order = await getOrder(req, id);
  const shipments = [];
  for (const f of order.fulfillments || []) {
    const row = {
      kind: f.kind || "forward",
      carrier: f.carrier,
      trackingNumber: f.trackingNumber,
      shippedAt: f.shippedAt,
      status: f.status,
      cancelledAt: f.cancelledAt,
      events: f.events || [],
      live: null,
    };
    if (f.trackingNumber && /delhivery/i.test(f.carrier || "") && delhiveryConfigured() && !f.cancelledAt) {
      try {
        row.live = await trackShipment(f.trackingNumber);
      } catch (err) {
        row.liveError = err.message;
      }
    }
    shipments.push(row);
  }
  return { orderNumber: order.orderNumber, status: order.status, shipments };
}

/**
 * Carrier webhook (Delhivery push). Records the scan and moves the order forward through the
 * same guarded transitions as manual updates; out-of-order or duplicate scans are ignored.
 * Only live (not cancelled) Delhivery fulfillments match the waybill. RTO / DTO scans move a
 * shipped order to returned_to_origin (never to delivered).
 */
export async function applyCarrierUpdate({ waybill, status, statusType, location, at }) {
  if (!waybill) return { ignored: true, reason: "no waybill" };
  const match = { trackingNumber: String(waybill), carrier: /^delhivery$/i, cancelledAt: null };
  const order = await Order.findOne({ fulfillments: { $elemMatch: match } });
  if (!order) return { ignored: true, reason: "unknown waybill" };
  const fulfillment = order.fulfillments.find(
    (f) => f.trackingNumber === String(waybill) && /^delhivery$/i.test(f.carrier || "") && !f.cancelledAt
  );
  await Order.updateOne(
    { _id: order._id, fulfillments: { $elemMatch: match } },
    {
      $set: { "fulfillments.$.status": String(status || ""), "fulfillments.$.lastScanAt": at ? new Date(at) : new Date() },
      $push: {
        "fulfillments.$.events": {
          $each: [{ status: String(status || ""), location: String(location || ""), at: at ? new Date(at) : new Date() }],
          $slice: -50,
        },
      },
    }
  );
  if (fulfillment.kind === "return") return { recorded: true };
  const target = mapDelhiveryStatus(status, statusType);
  if (!target || target === order.status) return { recorded: true };
  try {
    if (target === RTO_STATUS) {
      let current = order;
      // A parcel can only come back after it left: book the ship step first if it was skipped.
      if (current.status === "ready_to_ship") {
        current = await advanceOrder(current, "shipped", { note: `Delhivery: ${status}`, source: "carrier" });
      }
      if (!RTO_FROM_STATUSES.includes(current.status)) return { recorded: true, status: current.status };
      current = await returnToOrigin(current, null, `Delhivery: ${status}`, { source: "carrier" });
      return { recorded: true, status: current.status };
    }
    const order2 = ["shipped", "out_for_delivery", "delivered"];
    if (order2.indexOf(target) <= order2.indexOf(order.status) && order2.includes(order.status)) return { recorded: true };
    // ready_to_ship -> shipped -> out_for_delivery -> delivered, one guarded step at a time.
    const path = order2;
    let current = order;
    for (const step of path) {
      if (path.indexOf(step) > path.indexOf(target)) break;
      if (!(ALLOWED_TRANSITIONS[current.status] || []).includes(step)) continue;
      current = await advanceOrder(current, step, { note: `Delhivery: ${status}`, source: "carrier" });
      if (current.status === target) break;
    }
    return { recorded: true, status: current.status };
  } catch (err) {
    if (err.code === "INVALID_STATE") return { recorded: true, skipped: err.message };
    throw err;
  }
}

/**
 * Quantity to put in the cart for a reorder line under the CURRENT rules (they may have changed
 * since the order): `desired` = units already in the cart line + the ordered qty. In the bulk range
 * the qty is rounded UP to the pack multiple and capped at the per-order max (minus the product's
 * other bulk lines); then it is capped by free stock (`existing + stock`) and rounded DOWN to a
 * valid qty. Returns { total, reason } (reason = why it differs from `desired`, or null).
 */
export function reorderQty(rules, { desired, existing = 0, otherBulk = 0, stock = Infinity }) {
  const reasons = [];
  const inBulk = (q) => rules.bulkEligible && q >= rules.bulkFrom;
  const maxCap = rules.bulkEligible && rules.maxQty != null ? Math.max(0, rules.maxQty - otherBulk) : Infinity;
  const down = (q) => {
    if (!inBulk(q)) return q;
    let v = Math.min(q, maxCap);
    v = Math.floor(v / rules.pack) * rules.pack;
    return v >= rules.bulkFrom ? v : Math.min(q, rules.bulkFrom - 1);
  };
  let total = desired;
  if (inBulk(total) && rules.pack > 1 && total % rules.pack !== 0) {
    total = Math.ceil(total / rules.pack) * rules.pack;
    reasons.push(`Rounded to a multiple of ${rules.pack}`);
  }
  if (inBulk(total) && total > maxCap) {
    total = down(total);
    reasons.push(`Capped at the maximum of ${rules.maxQty} per order`);
  }
  if (total - existing > stock) {
    total = down(existing + Math.max(0, stock));
    reasons.push(stock > 0 ? `Only ${stock} in stock` : "Out of stock");
  }
  return { total, reason: total !== desired ? reasons.join("; ") || "Adjusted to the current quantity rules" : null };
}

/**
 * Add an order's lines to the buyer's cart again. Each line is fitted to the current quantity
 * rules and stock (reorderQty) instead of failing on an old quantity; lines that cannot be added
 * are skipped with a reason. Errors (409 REORDER_UNAVAILABLE, with `skipped`) only when nothing at
 * all could be added. Returns the cart quote plus
 * added: [{ itemId, productId, variantId, name, slug, qty, cartQty }],
 * adjusted: [{ itemId, productId, variantId, name, orderedQty, qty, reason }],
 * skipped: [{ itemId, productId, variantId, name, qty, reason, code }].
 */
export async function reorder(req, id) {
  const order = await getOrder(req, id);
  if (!isBuyerOf(req, order)) throw new AppError(403, "Only the buyer can reorder", "FORBIDDEN");
  const added = [];
  const adjusted = [];
  const skipped = [];
  const ids = (item) => ({ itemId: item._id, productId: item.productId, variantId: item.variantId, name: item.name });
  for (const item of order.items) {
    const skip = (reason, code) => skipped.push({ ...ids(item), qty: item.qty, reason, code });
    const [variant, product] = await Promise.all([
      ProductVariant.findById(item.variantId).lean(),
      Product.findById(item.productId).lean(),
    ]);
    if (!variant || variant.status !== "active" || !product || product.status !== "published" || product.enabled === false) {
      skip("This product is no longer available", "UNAVAILABLE");
      continue;
    }
    const cart = await getOrCreateCart(req.user._id);
    const line = cart.items.find((row) => String(row.variantId) === String(item.variantId));
    const existing = line?.qty || 0;
    const rules = qtyRules(product);
    const otherBulk = rules.bulkEligible
      ? cart.items
          .filter((row) => String(row.productId) === String(product._id) && String(row.variantId) !== String(item.variantId) && row.qty >= rules.bulkFrom)
          .reduce((sum, row) => sum + row.qty, 0)
      : 0;
    const stock = (await variantStockMap([item.variantId])).get(String(item.variantId))?.available || 0;
    const { total, reason } = reorderQty(rules, { desired: existing + item.qty, existing, otherBulk, stock });
    const qty = total - existing;
    if (qty <= 0) {
      skip(stock <= 0 ? "Out of stock" : reason || "Already at the maximum quantity in your cart", stock <= 0 ? "OUT_OF_STOCK" : "MAX_QTY");
      continue;
    }
    try {
      await addItem(req.user._id, null, { variantId: item.variantId, qty, bulk: false, fulfillmentMode: item.fulfillmentMode });
      added.push({ ...ids(item), slug: product.slug || item.slug || null, qty, cartQty: total });
      if (qty !== item.qty) adjusted.push({ ...ids(item), orderedQty: item.qty, qty, reason });
    } catch (err) {
      skip(err.message || "Unavailable", err.code || "UNAVAILABLE");
    }
  }
  if (!added.length) {
    throw new AppError(409, skipped[0]?.reason || "Items are out of stock. Notify when restocked.", "REORDER_UNAVAILABLE", { added, adjusted, skipped });
  }
  const cart = await getOrCreateCart(req.user._id);
  const quote = await quoteCart(cart, req.user._id);
  return { ...quote, added, adjusted, skipped };
}
