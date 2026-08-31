import { Order } from "./order.model.js";
import { AppError } from "../../utils/AppError.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { ORDER_STATUSES } from "../../config/constants.js";
import { emitDomain } from "../../utils/events.js";
import { confirmOrder, cancelOrder, refundOrder } from "../checkout/service.js";
import { addItem, getOrCreateCart } from "../cart/service.js";

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
  delivered: ["return_requested"],
  return_requested: ["refunded"],
};

export async function listOrders(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = ownOrdersOnly(req) ? { buyerId: req.user._id } : tenantFilter(req);
  if (req.query.status) filter.status = req.query.status;
  if (req.query.q) filter.orderNumber = new RegExp(req.query.q, "i");
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
  const order = await Order.findOne(filter);
  if (!order) throw new AppError(404, "Order not found", "NOT_FOUND");
  return order;
}

export async function updateStatus(req, id, status, note) {
  if (!ORDER_STATUSES.includes(status)) {
    throw new AppError(400, "Invalid status", "VALIDATION_ERROR");
  }
  const order = await getOrder(req, id);
  if (status === "confirmed") return confirmOrder(order, req.user._id);
  if (status === "cancelled") return cancelOrder(order, req.user._id, note);
  if (status === "refunded") return refundOrder(order, req.user._id, note);

  const allowed = ALLOWED[order.status] || [];
  if (!allowed.includes(status)) {
    throw new AppError(400, `Cannot move from ${order.status} to ${status}`, "INVALID_STATE");
  }
  order.status = status;
  order.statusHistory.push({ status, actorId: req.user._id, note: note || "" });
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

export async function reorder(req, id) {
  const order = await getOrder(req, id);
  let quote;
  for (const item of order.items) {
    quote = await addItem(req.user._id, null, { variantId: item.variantId, qty: item.qty });
  }
  return quote || (await getOrCreateCart(req.user._id));
}
