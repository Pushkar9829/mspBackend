import { Order } from "./order.model.js";
import { User } from "../users/user.model.js";
import { AppError } from "../../utils/AppError.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { ORDER_STATUSES } from "../../config/constants.js";
import { emitDomain } from "../../utils/events.js";
import { confirmOrder, cancelOrder, refundOrder, BUYER_CANCELLABLE_STATUSES } from "../checkout/service.js";
import { getInvoiceForOrder } from "../invoices/service.js";
import { addItem, getOrCreateCart, quoteCart } from "../cart/service.js";
import { getCommerceSettings } from "../settings/commerce.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ownOrdersOnly(req) {
  const perms = req.permissions || [];
  return !perms.includes("*") && !perms.includes("orders.update");
}

const EVENT_MAP = {
  confirmed: "ORDER_CONFIRMED",
  processing: "ORDER_PROCESSING",
  ready_to_ship: "ORDER_READY",
  shipped: "ORDER_SHIPPED",
  out_for_delivery: "ORDER_OUT_FOR_DELIVERY",
  delivered: "ORDER_DELIVERED",
  cancelled: "ORDER_CANCELLED",
  return_requested: "ORDER_RETURN_REQUESTED",
  refunded: "ORDER_REFUNDED",
};

const ALLOWED = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["processing", "cancelled"],
  processing: ["ready_to_ship", "cancelled"],
  ready_to_ship: ["shipped", "cancelled"],
  shipped: ["out_for_delivery"],
  out_for_delivery: ["delivered"],
  delivered: ["return_requested", "refunded"],
  return_requested: ["refunded"],
};

export async function getInvoice(req, id) {
  const order = await getOrder(req, id);
  return getInvoiceForOrder(order);
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T23:59:59.999`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function listOrders(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = ownOrdersOnly(req) ? { buyerId: req.user._id } : tenantFilter(req);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to, true);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q.trim()), "i");
    const buyers = await User.find({ $or: [{ email: rx }, { name: rx }] }).select("_id").limit(25);
    filter.$or = [{ orderNumber: rx }, { poNumber: rx }];
    if (buyers.length) filter.$or.push({ buyerId: { $in: buyers.map((u) => u._id) } });
  }
  const [data, total] = await Promise.all([
    Order.find(filter)
      .populate("tenantId", "name slug")
      .populate("buyerId", "name email phone")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function getOrder(req, id) {
  const isOid = /^[a-f\d]{24}$/i.test(id);
  const filter = isOid ? { _id: id } : { orderNumber: id };
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
  if (sellerNotes !== undefined) order.sellerNotes = String(sellerNotes || "");
  await order.save();
  return order;
}

function hasPerm(req, perm) {
  const perms = req.permissions || [];
  return perms.includes("*") || perms.includes(perm);
}

export async function updateStatus(req, id, status, note) {
  if (!ORDER_STATUSES.includes(status)) {
    throw new AppError(400, "Invalid status", "VALIDATION_ERROR");
  }
  const order = await getOrder(req, id);

  const allowed = ALLOWED[order.status] || [];
  if (!allowed.includes(status)) {
    throw new AppError(400, `Cannot move from ${order.status} to ${status}`, "INVALID_STATE");
  }
  if (ownOrdersOnly(req)) {
    if (status !== "cancelled" || !hasPerm(req, "orders.cancel")) {
      throw new AppError(403, "You can only cancel your own orders", "FORBIDDEN");
    }
    if (!BUYER_CANCELLABLE_STATUSES.includes(order.status)) {
      throw new AppError(400, "This order can no longer be cancelled. Contact support.", "INVALID_STATE");
    }
  } else if (status === "refunded") {
    if (!hasPerm(req, "orders.refund")) throw new AppError(403, "Missing permission orders.refund", "FORBIDDEN");
  } else if (status === "cancelled") {
    if (!hasPerm(req, "orders.cancel") && !hasPerm(req, "orders.update")) {
      throw new AppError(403, "Missing permission orders.cancel", "FORBIDDEN");
    }
  } else if (!hasPerm(req, "orders.update")) {
    throw new AppError(403, "Missing permission orders.update", "FORBIDDEN");
  }

  if (status === "confirmed") return confirmOrder(order, req.user._id);
  if (status === "cancelled") return cancelOrder(order, req.user._id, note);
  if (status === "refunded") {
    const refunded = await refundOrder(order, req.user._id, note);
    if (order.returnRequest?.status === "requested") {
      return Order.findByIdAndUpdate(
        refunded._id,
        {
          "returnRequest.status": "approved",
          "returnRequest.decidedAt": new Date(),
          "returnRequest.decisionNote": note || "",
        },
        { new: true }
      );
    }
    return refunded;
  }
  order.status = status;
  order.statusHistory.push({ status, actorId: req.user._id, note: note || "" });
  if (status === "delivered") order.deliveredAt = new Date();
  if (status === "delivered" && order.paymentMethod === "cod") order.paymentStatus = "paid";
  if (status === "shipped" && req.body?.trackingNumber) {
    order.fulfillments.push({
      carrier: req.body.carrier || "",
      trackingNumber: req.body.trackingNumber,
      shippedAt: new Date(),
    });
  }
  await order.save();
  const event = EVENT_MAP[status];
  if (event) {
    emitDomain(event, {
      orderId: order._id,
      tenantId: order.tenantId,
      buyerId: order.buyerId,
      userId: order.buyerId,
      actorId: req.user._id,
      orderNumber: order.orderNumber,
      total: order.total,
      resource: "order",
      resourceId: order._id,
    });
  }
  return order;
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

export async function requestReturn(req, id, { reason, note } = {}) {
  const order = await getOrder(req, id);
  if (String(order.buyerId?._id || order.buyerId) !== String(req.user._id)) {
    throw new AppError(403, "Only the buyer can request a return", "FORBIDDEN");
  }
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

  order.returnRequest = {
    status: "requested",
    reason: cleanReason.slice(0, 120),
    note: String(note || "").trim().slice(0, 1000),
    requestedAt: new Date(),
  };
  order.status = "return_requested";
  order.statusHistory.push({ status: "return_requested", actorId: req.user._id, note: cleanReason });
  await order.save();
  emitDomain("ORDER_RETURN_REQUESTED", {
    orderId: order._id,
    tenantId: order.tenantId?._id || order.tenantId,
    buyerId: order.buyerId?._id || order.buyerId,
    userId: order.buyerId?._id || order.buyerId,
    actorId: req.user._id,
    orderNumber: order.orderNumber,
    total: order.total,
    resource: "order",
    resourceId: order._id,
  });
  return order;
}

/** Seller turns a return down; the order goes back to delivered. Approving is a refund. */
export async function rejectReturn(req, id, note) {
  if (ownOrdersOnly(req)) throw new AppError(403, "Only the store can reject a return", "FORBIDDEN");
  const order = await getOrder(req, id);
  if (order.status !== "return_requested" || order.returnRequest?.status !== "requested") {
    throw new AppError(400, "There is no open return request on this order", "INVALID_STATE");
  }
  const reason = String(note || "").trim();
  if (!reason) throw new AppError(400, "Tell the buyer why the return was rejected", "VALIDATION_ERROR");
  order.status = "delivered";
  order.returnRequest.status = "rejected";
  order.returnRequest.decidedAt = new Date();
  order.returnRequest.decisionNote = reason.slice(0, 1000);
  order.statusHistory.push({ status: "delivered", actorId: req.user._id, note: `Return rejected: ${reason}` });
  await order.save();
  return order;
}

export async function reorder(req, id) {
  const order = await getOrder(req, id);
  const added = [];
  const skipped = [];
  for (const item of order.items) {
    try {
      await addItem(req.user._id, null, {
        variantId: item.variantId,
        qty: item.qty,
        bulk: Boolean(item.bulk),
        fulfillmentMode: item.fulfillmentMode,
      });
      added.push({ name: item.name, qty: item.qty });
    } catch (err) {
      skipped.push({ name: item.name, reason: err.message || "Unavailable" });
    }
  }
  if (!added.length) {
    throw new AppError(409, skipped[0]?.reason || "Items are out of stock. Notify when restocked.", "REORDER_UNAVAILABLE");
  }
  const cart = await getOrCreateCart(req.user._id);
  const quote = await quoteCart(cart, req.user._id);
  return { ...quote, added, skipped };
}
