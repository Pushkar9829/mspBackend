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
  markReturnPickupFailed,
  returnToOrigin,
  markRtoInTransit,
  liveForwardShipment,
} from "./lifecycle.js";
import {
  ORDER_STATUS_LIST,
  ALLOWED_TRANSITIONS,
  BUYER_CANCELLABLE_STATUSES,
  CANCELLABLE_STATUSES,
  RTO_STATUS,
  RTO_FROM_STATUSES,
  RTO_IN_TRANSIT,
  RTO_IN_TRANSIT_FROM,
  STATUS_LABELS,
  RETURN_REASONS,
} from "./statuses.js";
import { returnableLines, activeReturn, normalizeDestination, maskDestination } from "./returns.js";
import { delhiveryWebhookSecret } from "../shipping/delhivery.js";
import { shiprocketWebhookToken } from "../shipping/shiprocket.js";
import { withTransaction } from "../../utils/transaction.js";
import { getInvoiceForOrder, creditNotesForOrder, INVOICEABLE } from "../invoices/service.js";
import { orderTotals } from "./totals.js";
import { orderSla, phase6Sla } from "./sla.js";
import { PrivateFile } from "../files/privateFile.model.js";
import { ONLINE_PAYMENT_METHODS } from "../checkout/razorpayApi.js";
import { renderTaxDocumentPdf } from "../invoices/pdf.js";
import { addItem, getOrCreateCart, quoteCart } from "../cart/service.js";
import { Product } from "../catalog/product.model.js";
import { ProductVariant } from "../catalog/variant.model.js";
import { variantStockMap } from "../catalog/service.js";
import { qtyRules } from "../pricing/engine.js";
import { getCommerceSettings } from "../settings/commerce.js";
import { delhiveryConfigured, trackShipment, mapDelhiveryStatus } from "../shipping/delhivery.js";
import { shiprocketConfigured, trackShipment as trackShiprocket, mapShiprocketStatus } from "../shipping/shiprocket.js";
import { parseBound } from "../reports/time.js";
import { asObjectId } from "../../middleware/tenantScope.js";
import { PAYMENT_METHODS, PAYMENT_STATUSES, FULFILLMENT_MODES } from "../../config/constants.js";
import { retryFailedRefund, setRefundDestination as setDestination, markPayoutPaid } from "../checkout/refunds.js";

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

const pdfName = (n) => `${String(n).replace(/[^A-Za-z0-9-]+/g, "_")}.pdf`;

/**
 * Every tax document of the order (phase 4 split invoicing): the seller's invoice (goods + own
 * delivery; `feeLayout: "combined"` on older orders, which also carry the platform fees) and the
 * platform's invoice for platform / courier-partner fees, each with its credit notes and PDF link.
 * Empty before the order is confirmed.
 */
export async function getInvoices(req, id) {
  const order = await getOrder(req, id);
  const platform = await import("../invoices/platform.js");
  const { Invoice } = await import("../invoices/invoice.model.js");
  let seller = await Invoice.findOne({ orderId: order._id });
  if (!seller && INVOICEABLE.includes(order.status)) seller = await getInvoiceForOrder(order);
  if (!seller) return [];
  let plat = await platform.platformInvoiceForOrder(order);
  if (!plat && seller.feeLayout === "split" && platform.hasPlatformFees(order)) plat = await platform.issuePlatformInvoice(order, { sellerInvoice: seller });
  const base = `/api/v1/orders/${order._id}`;
  const notes = await creditNotesForOrder(order);
  const out = [
    {
      type: "seller",
      ...seller.toObject(),
      id: seller._id,
      number: seller.invoiceNumber,
      feeLayout: seller.feeLayout || "combined",
      pdf: `${base}/invoice.pdf`,
      creditNotes: notes.map((n) => ({ ...n.toObject(), id: n._id, number: n.creditNoteNumber, pdf: `${base}/credit-notes/${n._id}.pdf` })),
    },
  ];
  if (plat) {
    const pnotes = await platform.platformCreditNotesForOrder(order);
    out.push({
      type: "platform",
      ...plat.toObject(),
      id: plat._id,
      number: plat.invoiceNumber,
      supplier: plat.seller,
      pdf: `${base}/platform-invoice.pdf`,
      creditNotes: pnotes.map((n) => ({ ...n.toObject(), id: n._id, number: n.creditNoteNumber, supplier: n.seller, pdf: `${base}/platform-credit-notes/${n._id}.pdf` })),
    });
  }
  return out;
}

/** The platform's invoice of the order (404 NO_INVOICE when there is none: no platform fees / old order). */
export async function getPlatformInvoice(req, id) {
  const docs = await getInvoices(req, id);
  const plat = docs.find((d) => d.type === "platform");
  if (!plat) throw new AppError(404, "This order has no platform invoice", "NO_INVOICE");
  return plat;
}

export async function getPlatformInvoicePdf(req, id) {
  const plat = await getPlatformInvoice(req, id);
  return {
    filename: pdfName(plat.invoiceNumber),
    buffer: renderTaxDocumentPdf(plat, { title: "TAX INVOICE", number: plat.invoiceNumber, supplierLabel: "Supplier (marketplace)", footer: `Platform services for order ${plat.orderNumber || ""}. Goods are invoiced separately by the seller${plat.sellerInvoiceNumber ? ` (${plat.sellerInvoiceNumber})` : ""}.` }),
  };
}

export async function getPlatformCreditNotePdf(req, id, noteId) {
  const order = await getOrder(req, id);
  const platform = await import("../invoices/platform.js");
  const key = String(noteId || "");
  const note = (await platform.platformCreditNotesForOrder(order)).find((n) => String(n._id) === key || n.creditNoteNumber === key);
  if (!note) throw new AppError(404, "Credit note not found", "NOT_FOUND");
  return {
    filename: pdfName(note.creditNoteNumber),
    buffer: renderTaxDocumentPdf(note, { title: "CREDIT NOTE", number: note.creditNoteNumber, supplierLabel: "Supplier (marketplace)" }),
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

const REFUND_STATUSES = ["pending", "processing", "processed", "failed", "pending_payout"];
const REFUND_METHODS = ["razorpay", "cod", "ledger_credit"];
const RETURN_STATUSES = ["requested", "approved", "rejected", "received"];
/** The returns work queue: requested (decide), approved (awaiting goods), returned (awaiting refund). */
export const RETURN_QUEUE_STATUSES = ["return_requested", "return_approved", "returned"];
/** Parcels coming back from the carrier (seller must mark them received). */
export const RTO_QUEUE_STATUSES = [RTO_IN_TRANSIT];
const QUEUES = { returns: RETURN_QUEUE_STATUSES, rto: RTO_QUEUE_STATUSES };
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
    const queue = QUEUES[String(query.queue)];
    if (!queue) throw new AppError(400, `queue must be one of: ${Object.keys(QUEUES).join(", ")}`, "VALIDATION_ERROR");
    and.push({ status: { $in: queue } });
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
  const [commerce, sla] = await Promise.all([getCommerceSettings(), orderSla()]);
  const rows = data.map((order) => ({
    ...presentOrder(req, order),
    returnUntil: returnDeadline(order, commerce),
    allowedActions: allowedActions(req, order, commerce),
    sla: sla.forOrder(order),
  }));
  return paginated(rows, total, { page, limit });
}

/**
 * Order as returned by the API: adds `statusLabel`; bank account numbers in refund / return
 * destinations are masked for everyone but the buyer and platform admins.
 */
export function presentOrder(req, order) {
  const plain = typeof order?.toObject === "function" ? order.toObject() : { ...order };
  plain.statusLabel = STATUS_LABELS[plain.status] || plain.status;
  // Seller payout bookkeeping (p4-payouts) is for the seller / platform only.
  if (req.isBuyer === true && req.isPlatformAdmin !== true) delete plain.payout;
  const full = req.isPlatformAdmin === true || isBuyerOf(req, plain);
  if (!full) {
    plain.refunds = (plain.refunds || []).map((r) => (r.destination ? { ...r, destination: maskDestination(r.destination) } : r));
    plain.returns = (plain.returns || []).map((r) => (r.refundDestination ? { ...r, refundDestination: maskDestination(r.refundDestination) } : r));
  }
  return plain;
}

/**
 * Refund intents of the store's orders, one row per refund (default status=failed), newest first.
 * Rows: { orderId, orderNumber, tenantId, tenantName, buyerId, buyer, orderStatus, paymentStatus, paymentMethod, total, refund }.
 */
export async function listRefunds(req) {
  const { page, limit, skip } = paginate(req.query);
  const statuses = listParam(req.query.status || "failed", REFUND_STATUSES, "status");
  const methods = listParam(req.query.method, REFUND_METHODS, "method");
  const rowMatch = { "refunds.status": { $in: statuses } };
  if (methods.length) {
    rowMatch["refunds.method"] = methods.includes("razorpay") ? { $in: [...methods, null] } : { $in: methods };
  }
  const [result] = await Order.aggregate([
    { $match: { ...tenantFilter(req), "refunds.status": { $in: statuses } } },
    { $unwind: "$refunds" },
    { $match: rowMatch },
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
  const rows = (result?.data || []).map((row) =>
    req.isPlatformAdmin === true ? row : { ...row, refund: { ...row.refund, destination: maskDestination(row.refund?.destination) } }
  );
  return paginated(rows, result?.total?.[0]?.n || 0, { page, limit });
}

/**
 * Buyer tells the platform where a pending COD refund should be paid:
 * { type: "upi", upiId } | { type: "bank", accountName, accountNumber, ifsc } | { type: "store_credit" }.
 * store_credit is settled at once (credit on the buyer's account with this store).
 */
export async function setRefundDestination(req, id, key, body = {}) {
  const order = await getOrder(req, id);
  if (!isBuyerOf(req, order) && req.isPlatformAdmin !== true) {
    throw new AppError(403, "Only the buyer can set where the refund is paid", "FORBIDDEN");
  }
  const destination = normalizeDestination(body);
  if (!destination) throw new AppError(400, "Choose upi, bank or store_credit", "VALIDATION_ERROR");
  await withTransaction((session) => setDestination(order._id, key, destination, { session }));
  return presentOrder(req, await Order.findById(order._id));
}

/** Platform admin records an offline (COD) refund as paid, with the payout reference (UTR). */
export async function markRefundPaid(req, id, key, { reference, note } = {}) {
  if (req.isPlatformAdmin !== true) {
    throw new AppError(403, "Only the platform pays out refunds", "FORBIDDEN");
  }
  const order = await getOrder(req, id);
  await withTransaction((session) => markPayoutPaid(order._id, key, { reference, actorId: req.user._id, session }));
  if (note) {
    await Order.updateOne(
      { _id: order._id },
      { $push: { statusHistory: { status: order.status, actorId: req.user._id, note: `Refund ${key} paid: ${String(note).slice(0, 300)}`, at: new Date() } } }
    );
  }
  return presentOrder(req, await Order.findById(order._id));
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
    return cancelOrder(order, req.user._id, note, staffCancelOptions(req));
  }
  if (["return_requested", "return_approved", "returned"].includes(status) || (order.status === "return_requested" && status === "delivered")) {
    throw new AppError(400, "Use the return endpoints for this change", "INVALID_STATE");
  }
  if (!hasPerm(req, "orders.update")) throw new AppError(403, "Missing permission orders.update", "FORBIDDEN");
  if (status === "confirmed") return confirmOrder(order, req.user._id);
  if (status === RTO_IN_TRANSIT) return markRtoInTransit(order, req.user._id, note);
  if (status === RTO_STATUS) return returnToOrigin(order, req.user._id, note, { damaged: damagedMap(order, extra.items) });
  // Own fleet (phase 5): only the rider moves the order out for delivery / delivered (buyer OTP).
  if ((status === "delivered" || status === "out_for_delivery") && riderManagedDelivery(order)) {
    if (req.isPlatformAdmin !== true) {
      throw new AppError(409, "Delivered only by the rider with the buyer's OTP", "RIDER_MANAGED");
    }
    if (!String(note || "").trim()) {
      throw new AppError(400, "Add a note with the proof of delivery to override the rider flow", "VALIDATION_ERROR");
    }
  }
  if (status === "delivered") {
    const managedBy = carrierManagedDelivery(order);
    if (managedBy && req.isPlatformAdmin !== true) {
      throw new AppError(
        409,
        `${managedBy} is delivering this order. It is marked delivered automatically when ${managedBy} confirms delivery.`,
        "CARRIER_MANAGED"
      );
    }
    if (managedBy && !String(note || "").trim()) {
      throw new AppError(400, "Add a note with the proof of delivery to override the carrier", "VALIDATION_ERROR");
    }
  }
  return advanceOrder(order, status, {
    actorId: req.user._id,
    note,
    trackingNumber: extra.trackingNumber,
    carrier: extra.carrier,
  });
}

/**
 * Couriers we receive delivery webhooks from. When one of them carries the order (live forward
 * shipment with its tracking number and the webhook is configured), only its webhook may mark
 * the order delivered (proof of delivery). Seller-delivered and store-pickup orders (no courier
 * shipment) and couriers without a webhook stay manual. Returns the carrier name or null.
 */
export function carrierManagedDelivery(order) {
  const shipment = liveForwardShipment(order);
  if (!shipment) return null;
  if (/delhivery/i.test(shipment.carrier) && delhiveryWebhookSecret()) return shipment.carrier;
  if (/shiprocket/i.test(shipment.carrier) && shiprocketWebhookToken()) return shipment.carrier;
  return null;
}

/** Own-fleet orders (phase 5) are delivered by the store's rider with the buyer's OTP only. */
export function riderManagedDelivery(order) {
  return order?.deliveryMethod === "own_fleet";
}

/** RTO / return receive input [{ itemId, damagedQty }] -> { itemId: damagedQty }, validated against the order. */
function damagedMap(order, items = []) {
  const damaged = {};
  for (const row of items || []) {
    const line = order.items.id(row.itemId);
    if (!line) throw new AppError(400, `Unknown order item ${row.itemId}`, "VALIDATION_ERROR");
    if (row.damagedQty > line.qty) throw new AppError(400, `Damaged qty exceeds ordered qty for ${line.name}`, "VALIDATION_ERROR");
    damaged[String(line._id)] = row.damagedQty;
  }
  return damaged;
}

/** Staff cancel: a store's staff cancel as the seller; platform admins as admin (cause: system). */
function staffCancelOptions(req) {
  return req.isPlatformAdmin === true
    ? { cancelledBy: "admin", cancelCause: "system", reasonCode: "admin_cancel" }
    : { cancelledBy: "seller", cancelCause: "seller", reasonCode: "seller_cancel" };
}

async function cancelForBuyer(req, order, note) {
  if (!isBuyerOf(req, order)) throw new AppError(403, "You can only cancel your own orders", "FORBIDDEN");
  if (!BUYER_CANCELLABLE_STATUSES.includes(order.status)) {
    throw new AppError(400, "This order has shipped and can no longer be cancelled. Request a return after delivery.", "INVALID_STATE");
  }
  return cancelOrder(order, req.user._id, note || "Cancelled by buyer", {
    from: BUYER_CANCELLABLE_STATUSES,
    cancelledBy: "buyer",
    cancelCause: "buyer",
    reasonCode: "buyer_request",
  });
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
  return cancelOrder(order, req.user._id, note, staffCancelOptions(req));
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

const TRACKABLE_STATUSES = ["shipped", "out_for_delivery", "delivered", "return_requested", "return_approved", "returned", RTO_IN_TRANSIT, RTO_STATUS];

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
  const returnable = order.status === "delivered" ? returnableLines(order) : [];
  const ret = Boolean(
    buyer && commerce.returnsEnabled && order.status === "delivered" && !activeReturn(order) && returnable.length && deadline && Date.now() <= deadline.getTime()
  );
  if (!ret && buyer) {
    if (!commerce.returnsEnabled) reasons.return = "Returns are not available right now";
    else if (activeReturn(order) || ["return_requested", "return_approved"].includes(order.status)) reasons.return = "A return is already in progress";
    else if (order.status !== "delivered") reasons.return = "Returns open after delivery";
    else if (!deadline) reasons.return = "None of the items can be returned";
    else if (!returnable.length) reasons.return = order.returnRequest?.status ? "A return was already requested" : "Nothing left to return";
    else reasons.return = `The ${commerce.returnWindowDays}-day return window has ended`;
  }
  // Staff: may this caller mark the order delivered by hand? (couriers with webhooks deliver it)
  let markDelivered = false;
  if (!ownOnly && (ALLOWED_TRANSITIONS[order.status] || []).includes("delivered") && hasPerm(req, "orders.update")) {
    const managedBy = carrierManagedDelivery(order);
    markDelivered = !managedBy || req.isPlatformAdmin === true;
    if (managedBy) reasons.markDelivered = `${managedBy} marks this order delivered when it confirms delivery`;
    if (riderManagedDelivery(order)) {
      markDelivered = req.isPlatformAdmin === true;
      reasons.markDelivered = "Delivered only by the rider with the buyer's OTP";
    }
  }
  // Own fleet: "Out for delivery" is the rider's step too.
  const riderManaged = !ownOnly && riderManagedDelivery(order);
  const markOutForDelivery =
    !ownOnly &&
    (ALLOWED_TRANSITIONS[order.status] || []).includes("out_for_delivery") &&
    hasPerm(req, "orders.update") &&
    (!riderManaged || req.isPlatformAdmin === true);
  if (riderManaged && (ALLOWED_TRANSITIONS[order.status] || []).includes("out_for_delivery")) {
    reasons.markOutForDelivery = "The rider starts the delivery from the rider app";
  }
  const openReturn = activeReturn(order);
  const returnPickupFailed = Boolean(!buyer && openReturn?.status === "approved" && (!openReturn.reopenedFrom || req.isPlatformAdmin === true));
  if (openReturn?.status === "approved" && openReturn.reopenedFrom && !req.isPlatformAdmin) reasons.returnPickupFailed = REOPENED_PICKUP_REASON;
  const pendingPayout = (order.refunds || []).find((r) => r.method === "cod" && r.status === "pending_payout" && !r.destination?.type);
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
  return {
    cancel,
    return: ret,
    reorder,
    invoice,
    track,
    pay,
    markDelivered,
    /** Phase 6: staff may close the active return as "pickup failed" (not when the platform reopened it). */
    returnPickupFailed,
    /** Phase 5: staff may mark the order out for delivery by hand (false for own-fleet orders). */
    markOutForDelivery,
    /** Phase 5: the store's own rider delivers this order (RIDER_MANAGED). */
    riderManaged,
    /** Buyer must tell us where to pay a COD refund (POST /orders/:id/refunds/:key/destination). */
    refundDestination: Boolean(buyer && pendingPayout),
    refundDestinationKey: buyer && pendingPayout ? pendingPayout.key : null,
    returnableItems: buyer ? returnable.map((l) => ({ itemId: l.itemId, name: l.name, returnableQty: l.returnableQty })) : [],
    returnUntil: deadline,
    reasons,
  };
}

export { orderTotals };

export { RETURN_REASONS };

/**
 * POST /orders/:id/return { reason, note?, items?: [{ itemId, qty }], refundDestination? }.
 * Without `items` every returnable unit is returned (old clients). Only "easy return" lines,
 * qty <= delivered − already returned / requested / rejected. One active return at a time.
 */
export async function requestReturn(req, id, { reason, note, items = null, refundDestination = null } = {}) {
  const order = await getOrder(req, id);
  if (!isBuyerOf(req, order)) throw new AppError(403, "Only the buyer can request a return", "FORBIDDEN");
  const commerce = await getCommerceSettings();
  if (!commerce.returnsEnabled) throw new AppError(400, "Returns are not available right now", "RETURNS_DISABLED");
  if (activeReturn(order) || ["return_requested", "return_approved"].includes(order.status)) {
    throw new AppError(400, "A return is already in progress for this order", "INVALID_STATE");
  }
  if (order.status !== "delivered") throw new AppError(400, "Returns can be requested only after delivery", "INVALID_STATE");
  if (!returnableLines(order).length) {
    throw new AppError(400, order.returnRequest?.status ? "A return was already requested for this order" : "Nothing left to return on this order", "INVALID_STATE");
  }
  const deadline = returnDeadline(order, commerce);
  if (!deadline) throw new AppError(400, "None of the items in this order can be returned", "NOT_RETURNABLE");
  if (Date.now() > deadline.getTime()) {
    throw new AppError(400, `The ${commerce.returnWindowDays}-day return window has ended`, "RETURN_WINDOW_OVER");
  }
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) throw new AppError(400, "Choose a reason for the return", "VALIDATION_ERROR");
  const destination = refundDestination ? normalizeDestination(refundDestination) : null;
  return lifecycleRequestReturn(order, {
    actorId: req.user._id,
    reason: cleanReason,
    note,
    items: items && items.length ? items : null,
    refundDestination: destination,
    strict: true,
  });
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

/**
 * `items`: [{ itemId, damagedQty?, rejectedQty?, rejectReason? }] — damaged units of the returned
 * lines are booked as damaged, the rest restocked. Only lines of the active return;
 * damagedQty + rejectedQty <= returned qty of that line.
 * Phase 6 quality check: `rejectedQty` units failed the seller's inspection (no refund, not
 * restocked); a reason (rejectReason or qcNote) and at least one photo (`qcPhotos`: private file
 * ids of the store, folder disputes / delivery) are required; `qcDisposition` = return_to_buyer
 * (default) | hold.
 */
export async function receiveReturn(req, id, { note, items = [], qcNote = "", qcPhotos = [], qcDisposition = "" } = {}) {
  sellerOnly(req, "receive a return");
  const order = await getOrder(req, id);
  const current = activeReturn(order);
  // Own fleet (phase 5): without explicit lines, use the rider's item check from the pickup.
  if ((!items || !items.length) && current?._id && riderManagedDelivery(order)) {
    const { returnItemCheckDamage } = await import("../fleet/service.js");
    items = (await returnItemCheckDamage(order._id, current._id)) || [];
  }
  const damaged = damagedMap(order, (items || []).map((r) => ({ ...r, damagedQty: Number(r.damagedQty) || 0 })));
  const rejected = {};
  if (current) {
    for (const [lineId, qty] of Object.entries(damaged)) {
      const row = (current.items || []).find((it) => String(it.itemId) === lineId);
      if (!row && qty > 0) throw new AppError(400, "That item is not part of this return", "VALIDATION_ERROR");
      if (row && qty > row.qty) throw new AppError(400, `Damaged qty exceeds returned qty for ${row.name || "this item"}`, "VALIDATION_ERROR");
    }
    for (const r of items || []) {
      const qty = Number(r.rejectedQty) || 0;
      if (qty <= 0) continue;
      const row = (current.items || []).find((it) => String(it.itemId) === String(r.itemId));
      if (!row) throw new AppError(400, "That item is not part of this return", "VALIDATION_ERROR");
      const prev = rejected[String(r.itemId)]?.qty || 0;
      if (qty + prev + (damaged[String(r.itemId)] || 0) > row.qty) {
        throw new AppError(400, `Damaged + rejected qty exceeds returned qty for ${row.name || "this item"}`, "VALIDATION_ERROR");
      }
      const reason = String(r.rejectReason || qcNote || "").trim();
      if (!reason) throw new AppError(400, `Tell the buyer why ${row.name || "the item"} was rejected`, "VALIDATION_ERROR");
      rejected[String(r.itemId)] = { qty: qty + prev, reason };
    }
  }
  let qc = null;
  if (Object.keys(rejected).length) {
    const ids = [...new Set((qcPhotos || []).map(String))];
    if (!ids.length) throw new AppError(400, "Add at least one photo of the rejected items", "QC_PHOTOS_REQUIRED");
    const files = await PrivateFile.find({ _id: { $in: ids }, tenantId: order.tenantId?._id || order.tenantId, folder: { $in: ["disputes", "delivery"] } })
      .select("_id")
      .lean();
    if (files.length !== ids.length) throw new AppError(400, "Unknown photo: upload it to /files/private (folder disputes) first", "VALIDATION_ERROR");
    qc = { note: String(qcNote || "").trim(), photos: ids, disposition: qcDisposition || "return_to_buyer" };
  }
  return lifecycleReceiveReturn(order, { actorId: req.user._id, note, damaged, rejected, qc });
}

const REOPENED_PICKUP_REASON = "The marketplace reopened this return after a dispute; only a failed pickup attempt by the courier or rider can close it";

/**
 * Phase 6: the seller records that the return could not be picked up (e.g. a self-arranged pickup
 * the buyer missed). Closes the active approved return as pickup_failed; the buyer can dispute.
 */
export async function returnPickupFailed(req, id, { note } = {}) {
  sellerOnly(req, "record a failed return pickup");
  const reason = String(note || "").trim();
  if (!reason) throw new AppError(400, "Say why the pickup failed", "VALIDATION_ERROR");
  const order = await getOrder(req, id);
  if (activeReturn(order)?.reopenedFrom && !req.isPlatformAdmin) {
    throw new AppError(409, REOPENED_PICKUP_REASON, "RETURN_REOPENED_BY_PLATFORM");
  }
  return markReturnPickupFailed(order, { actorId: req.user._id, reason, source: "seller" });
}

/** Return-pickup scan text that means the courier could not pick it up / gave up (phase 6). */
const RETURN_PICKUP_FAILED_RX = /(pick ?-?up)[^a-z]*(fail|exception|unsuccess|not done|attempt)|not picked|unable to pick|could not (be )?pick|customer (refused|not available|unavailable)|refused|not ready/i;
export function returnPickupOutcome(status, statusType = "") {
  const text = String(status || "").trim();
  const type = String(statusType || "").trim().toUpperCase();
  if (type === "CN" || /cancel/i.test(text)) return "cancelled";
  if (RETURN_PICKUP_FAILED_RX.test(text)) return "failed";
  return null;
}

/**
 * Courier scan on a return (reverse pickup) shipment. Failed pickup attempts are counted on the
 * fulfillment (a repeated identical scan is ignored); at `returns.maxPickupAttempts` — or when the
 * courier cancels the pickup — the return is closed as pickup_failed.
 */
async function applyReturnPickupScan(order, fulfillment, { status, statusType, at, label }) {
  const outcome = returnPickupOutcome(status, statusType);
  if (!outcome || order.status !== "return_approved") return { recorded: true };
  const when = at ? new Date(at).getTime() : null;
  const dup = (fulfillment.events || []).some((e) => e.status === String(status || "") && when && e.at && new Date(e.at).getTime() === when);
  if (dup) return { recorded: true, duplicate: true };
  let attempts = fulfillment.failedAttempts || 0;
  if (outcome === "failed") {
    const upd = await Order.findOneAndUpdate(
      { _id: order._id, "fulfillments._id": fulfillment._id },
      { $inc: { "fulfillments.$.failedAttempts": 1 } },
      { new: true }
    );
    attempts = upd?.fulfillments?.id(fulfillment._id)?.failedAttempts || attempts + 1;
    const sla = await phase6Sla(order.tenantId);
    if (attempts < sla.maxPickupAttempts) return { recorded: true, pickupAttempts: attempts };
  }
  try {
    await markReturnPickupFailed(order, {
      reason: outcome === "cancelled" ? `${label} cancelled the pickup (${status})` : `${label} could not pick it up after ${attempts} attempt(s) (${status})`,
      source: "carrier",
    });
    return { recorded: true, returnStatus: "pickup_failed", pickupAttempts: attempts };
  } catch (err) {
    if (err.code === "INVALID_STATE") return { recorded: true, skipped: err.message };
    throw err;
  }
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
    } else if (f.trackingNumber && /shiprocket/i.test(f.carrier || "") && shiprocketConfigured() && !f.cancelledAt) {
      try {
        row.live = await trackShiprocket(f.trackingNumber);
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
export async function applyCarrierUpdate({ waybill, status, statusType, location, at, carrier = "delhivery", externalOrderId = "" }) {
  const carrierRe = carrier === "shiprocket" ? /^shiprocket$/i : /^delhivery$/i;
  const label = carrier === "shiprocket" ? "Shiprocket" : "Delhivery";
  if (!waybill && !externalOrderId) return { ignored: true, reason: "no waybill" };
  const clauses = [];
  if (waybill) clauses.push({ trackingNumber: String(waybill) });
  if (externalOrderId) clauses.push({ externalOrderId: String(externalOrderId) });
  const match = { carrier: carrierRe, cancelledAt: null, ...(clauses.length > 1 ? { $or: clauses } : clauses[0]) };
  const order = await Order.findOne({ fulfillments: { $elemMatch: match } });
  if (!order) return { ignored: true, reason: "unknown waybill" };
  const fulfillment = order.fulfillments.find(
    (f) =>
      !f.cancelledAt &&
      carrierRe.test(f.carrier || "") &&
      ((waybill && f.trackingNumber === String(waybill)) || (externalOrderId && f.externalOrderId === String(externalOrderId)))
  );
  if (!fulfillment) return { ignored: true, reason: "unknown waybill" };
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
  if (fulfillment.kind === "return") return applyReturnPickupScan(order, fulfillment, { status, statusType, at, label });
  const target = carrier === "shiprocket" ? mapShiprocketStatus(status, statusType) : mapDelhiveryStatus(status, statusType);
  if (!target || target === order.status) return { recorded: true };
  try {
    if (target === RTO_IN_TRANSIT || target === RTO_STATUS) {
      let current = order;
      // A parcel can only come back after it left: book the ship step first if it was skipped.
      if (current.status === "ready_to_ship") {
        current = await advanceOrder(current, "shipped", { note: `${label}: ${status}`, source: "carrier" });
      }
      if (target === RTO_IN_TRANSIT) {
        // First RTO scan: on its way back. Nothing is restocked or refunded yet.
        if (!RTO_IN_TRANSIT_FROM.includes(current.status)) return { recorded: true, status: current.status };
        current = await markRtoInTransit(current, null, `${label}: ${status}`, { source: "carrier" });
        return { recorded: true, status: current.status };
      }
      // "RTO delivered": the parcel reached the seller -> restock + refund + credit note.
      if (!RTO_FROM_STATUSES.includes(current.status)) return { recorded: true, status: current.status };
      current = await returnToOrigin(current, null, `${label}: ${status}`, { source: "carrier" });
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
      current = await advanceOrder(current, step, { note: `${label}: ${status}`, source: "carrier" });
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
