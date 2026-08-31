import { nanoid } from "nanoid";
import { Order } from "../orders/order.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { CouponUsage } from "../pricing/couponUsage.model.js";
import { Offer } from "../pricing/offer.model.js";
import { getOrCreateCart, quoteCart } from "../cart/service.js";
import { getAddressForUser } from "../location/address.service.js";
import {
  reserveStock,
  releaseReservation,
  commitReservation,
  restoreCommitted,
} from "../inventory/service.js";
import { withTransaction } from "../../utils/transaction.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { PAYMENT_METHODS } from "../../config/constants.js";

function offerIdsFromItems(items) {
  const ids = new Set();
  for (const item of items) {
    for (const step of item.breakdown || []) {
      if (step.offerId) ids.add(String(step.offerId));
    }
  }
  return [...ids];
}

export async function previewCheckout({ user, addressId }) {
  const cart = await getOrCreateCart(user._id);
  if (!cart.items.length) throw new AppError(400, "Cart is empty", "EMPTY_CART");
  const address = await getAddressForUser(user._id, addressId);
  return quoteCart(cart, user._id, address);
}

export async function checkout({ user, addressId, paymentMethod, poNumber, buyerNotes, idempotencyKey }) {
  if (!idempotencyKey) throw new AppError(400, "Idempotency-Key header required", "IDEMPOTENCY");
  if (!PAYMENT_METHODS.includes(paymentMethod || "purchase_order")) {
    throw new AppError(400, "Invalid payment method", "VALIDATION_ERROR");
  }

  const existing = await Order.find({ buyerId: user._id, idempotencyKey });
  if (existing.length) {
    return { orders: existing, idempotent: true };
  }

  const cart = await getOrCreateCart(user._id);
  if (!cart.items.length) throw new AppError(400, "Cart is empty", "EMPTY_CART");
  const address = await getAddressForUser(user._id, addressId);
  const quote = await quoteCart(cart, user._id, address);

  const reserved = [];
  let createdOrders = [];

  try {
    createdOrders = await withTransaction(async (session) => {
      const created = [];
      for (const group of quote.groups) {
        for (const item of group.items) {
          await reserveStock({
            tenantId: group.tenantId,
            warehouseId: item.warehouseId,
            variantId: item.variantId,
            qty: item.qty,
            reference: idempotencyKey,
            session,
          });
          reserved.push({
            tenantId: group.tenantId,
            warehouseId: item.warehouseId,
            variantId: item.variantId,
            qty: item.qty,
          });
        }

        const orderNumber = `ORD-${nanoid(10).toUpperCase()}`;
        const payload = {
          orderNumber,
          tenantId: group.tenantId,
          buyerId: user._id,
          status: "pending",
          items: group.items.map((i) => ({
            tenantId: i.tenantId,
            productId: i.productId,
            variantId: i.variantId,
            sku: i.sku,
            name: i.name,
            image: i.image || "",
            slug: i.slug || "",
            attributes: i.attributes,
            qty: i.qty,
            listPrice: i.listPrice,
            unitPrice: i.unitPrice,
            lineSubtotal: i.lineSubtotal,
            taxRate: i.taxRate,
            tax: i.tax,
            lineTotal: i.lineTotal,
            warehouseId: i.warehouseId,
            breakdown: i.breakdown,
          })),
          addressSnapshot: address.toObject ? address.toObject() : address,
          couponCode: group.couponCode,
          couponDiscount: group.couponDiscount,
          subtotal: group.subtotal,
          tax: group.tax,
          deliveryFee: group.deliveryFee,
          total: group.total,
          paymentMethod: paymentMethod || "purchase_order",
          paymentStatus: "unpaid",
          poNumber: poNumber || "",
          buyerNotes: buyerNotes || "",
          idempotencyKey,
          etaFrom: group.eta?.etaFrom,
          etaTo: group.eta?.etaTo,
          statusHistory: [{ status: "pending", actorId: user._id, note: "Order created" }],
        };

        const [order] = session
          ? await Order.create([payload], { session })
          : [await Order.create(payload)];

        if (group.couponCode) {
          const couponFilter = { tenantId: group.tenantId, code: group.couponCode, status: "active" };
          let couponQuery = Coupon.findOne(couponFilter);
          if (session) couponQuery = couponQuery.session(session);
          const coupon = await couponQuery;
          if (coupon) {
            const cap = coupon.maxRedemptions;
            const couponOpts = { new: true };
            if (session) couponOpts.session = session;
            const updated = await Coupon.findOneAndUpdate(
              {
                _id: coupon._id,
                ...(cap != null ? { redemptionCount: { $lt: cap } } : {}),
              },
              { $inc: { redemptionCount: 1 } },
              couponOpts
            );
            if (!updated) throw new AppError(400, "Coupon usage limit reached", "COUPON_LIMIT");
            const usage = {
              tenantId: group.tenantId,
              couponId: coupon._id,
              userId: user._id,
              orderId: order._id,
            };
            if (session) await CouponUsage.create([usage], { session });
            else await CouponUsage.create(usage);
          }
        }

        for (const offerId of offerIdsFromItems(group.items)) {
          const offerOpts = {};
          if (session) offerOpts.session = session;
          await Offer.updateOne(
            { _id: offerId, tenantId: group.tenantId },
            { $inc: { inventoryUsed: 1 } },
            offerOpts
          );
        }

        created.push(order);
      }
      return created;
    });
  } catch (err) {
    if (!createdOrders.length) {
      for (const r of reserved) {
        await releaseReservation({ ...r, reference: idempotencyKey }).catch(() => {});
      }
    }
    throw err;
  }

  try {
    cart.items = [];
    cart.couponCode = "";
    await cart.save();
  } catch (err) {
    console.error("cart clear after checkout failed", err.message);
  }

  for (const order of createdOrders) {
    emitDomain("ORDER_CREATED", {
      orderId: order._id,
      tenantId: order.tenantId,
      buyerId: order.buyerId,
      userId: order.buyerId,
      orderNumber: order.orderNumber,
      total: order.total,
      resource: "order",
      resourceId: order._id,
    });
  }
  return { orders: createdOrders, idempotent: false };
}

export async function confirmOrder(order, actorId) {
  if (order.status !== "pending") {
    throw new AppError(400, "Only pending orders can be confirmed", "INVALID_STATE");
  }
  for (const item of order.items) {
    await commitReservation({
      tenantId: order.tenantId,
      warehouseId: item.warehouseId,
      variantId: item.variantId,
      qty: item.qty,
      reference: order.orderNumber,
    });
  }
  order.status = "confirmed";
  order.statusHistory.push({ status: "confirmed", actorId, note: "Confirmed" });
  await order.save();
  emitDomain("ORDER_CONFIRMED", {
    orderId: order._id,
    tenantId: order.tenantId,
    buyerId: order.buyerId,
    userId: order.buyerId,
    actorId,
    orderNumber: order.orderNumber,
    total: order.total,
    resource: "order",
    resourceId: order._id,
  });
  return order;
}

async function restoreStock(order, actorId, note) {
  const pending = order.status === "pending";
  for (const item of order.items) {
    if (pending) {
      await releaseReservation({
        tenantId: order.tenantId,
        warehouseId: item.warehouseId,
        variantId: item.variantId,
        qty: item.qty,
        reference: order.orderNumber,
      });
    } else {
      await restoreCommitted({
        tenantId: order.tenantId,
        warehouseId: item.warehouseId,
        variantId: item.variantId,
        qty: item.qty,
        reference: order.orderNumber,
      });
    }
  }
}

export async function cancelOrder(order, actorId, note, { timeout = false } = {}) {
  if (["delivered", "cancelled", "refunded"].includes(order.status)) {
    throw new AppError(400, "Order cannot be cancelled", "INVALID_STATE");
  }
  await restoreStock(order, actorId, note);
  order.status = "cancelled";
  order.statusHistory.push({
    status: "cancelled",
    actorId,
    note: note || (timeout ? "Reservation timeout" : "Cancelled"),
  });
  await order.save();
  emitDomain(timeout ? "ORDER_TIMEOUT" : "ORDER_CANCELLED", {
    orderId: order._id,
    tenantId: order.tenantId,
    buyerId: order.buyerId,
    userId: order.buyerId,
    actorId,
    orderNumber: order.orderNumber,
    total: order.total,
    resource: "order",
    resourceId: order._id,
  });
  return order;
}

export async function refundOrder(order, actorId, note) {
  if (!["delivered", "return_requested"].includes(order.status)) {
    throw new AppError(400, "Only delivered/return-requested orders can be refunded", "INVALID_STATE");
  }
  await restoreStock(order, actorId, note);
  order.status = "refunded";
  order.paymentStatus = "refunded";
  order.statusHistory.push({ status: "refunded", actorId, note: note || "Refunded" });
  await order.save();
  emitDomain("ORDER_REFUNDED", {
    orderId: order._id,
    tenantId: order.tenantId,
    buyerId: order.buyerId,
    userId: order.buyerId,
    actorId,
    orderNumber: order.orderNumber,
    total: order.total,
    resource: "order",
    resourceId: order._id,
  });
  return order;
}
