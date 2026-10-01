import { nanoid } from "nanoid";
import { Order } from "../orders/order.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { CouponUsage } from "../pricing/couponUsage.model.js";
import { Offer } from "../pricing/offer.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { User } from "../users/user.model.js";
import { getOrCreateCart, quoteCart, resolveFulfillment } from "../cart/service.js";
import { getAddressForUser } from "../location/address.service.js";
import {
  reserveStock,
  releaseReservation,
  commitReservation,
  uncommitReservation,
  restoreCommitted,
} from "../inventory/service.js";
import { withTransaction } from "../../utils/transaction.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { PAYMENT_METHODS } from "../../config/constants.js";
import * as ledger from "../ledger/service.js";
import { generateInvoice, attachInvoice, cancelInvoice } from "../invoices/service.js";

export const CANCELLABLE_STATUSES = ["pending", "confirmed", "processing", "ready_to_ship"];
export const BUYER_CANCELLABLE_STATUSES = ["pending", "confirmed"];
export const REFUNDABLE_STATUSES = ["delivered", "return_requested"];

function offerIdsFromItems(items) {
  const ids = new Set();
  for (const item of items) {
    for (const step of item.breakdown || []) {
      if (step.offerId) ids.add(String(step.offerId));
    }
  }
  return [...ids];
}

function assertCheckoutable(quote) {
  if (quote.unavailable?.length) {
    const first = quote.unavailable[0];
    throw new AppError(
      409,
      `${first.name}: ${first.issue}. Update or remove it from your cart.`,
      first.issueCode || "CART_ISSUES"
    );
  }
  if (!quote.groups?.length) throw new AppError(400, "Cart is empty", "EMPTY_CART");
}

function formatAddress(a = {}) {
  return [a.addressLine1, a.addressLine2, a.city, a.state, a.postalCode].filter(Boolean).join(", ");
}

async function sellerSnapshots(tenantIds) {
  const tenants = await Tenant.find({ _id: { $in: tenantIds } }).lean();
  const map = new Map();
  for (const t of tenants) {
    map.set(String(t._id), {
      name: t.name || "",
      legalName: t.businessProfile?.legalName || t.name || "",
      gstin: t.businessProfile?.gstin || "",
      state: t.pickupAddress?.state || "",
      address: formatAddress(t.pickupAddress),
      email: t.businessProfile?.email || "",
      phone: t.businessProfile?.phone || "",
    });
  }
  return map;
}

export async function previewCheckout({ user, addressId, deliveryPartnerId }) {
  const cart = await getOrCreateCart(user._id);
  if (!cart.items.length) throw new AppError(400, "Cart is empty", "EMPTY_CART");
  const address = await getAddressForUser(user._id, addressId);
  return quoteCart(cart, user._id, address, { deliveryPartnerId });
}

async function existingOrders(buyerId, idempotencyKey) {
  return Order.find({ buyerId, idempotencyKey }).sort({ createdAt: 1 });
}

export async function checkout({
  user,
  addressId,
  paymentMethod,
  poNumber,
  buyerNotes,
  idempotencyKey,
  deliveryPartnerId,
  expectedGrandTotal,
}) {
  if (!idempotencyKey) throw new AppError(400, "Idempotency-Key header required", "IDEMPOTENCY");
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new AppError(400, "Choose a payment method", "VALIDATION_ERROR");
  }
  if (paymentMethod === "purchase_order" && !String(poNumber || "").trim()) {
    throw new AppError(400, "PO number is required for purchase orders", "PO_REQUIRED");
  }

  const existing = await existingOrders(user._id, idempotencyKey);
  if (existing.length) return { orders: existing, idempotent: true };

  const cart = await getOrCreateCart(user._id);
  if (!cart.items.length) throw new AppError(400, "Cart is empty", "EMPTY_CART");
  const address = await getAddressForUser(user._id, addressId);
  const quote = await quoteCart(cart, user._id, address, { deliveryPartnerId, strictCoupon: true });
  assertCheckoutable(quote);
  if (expectedGrandTotal != null && Math.abs(Number(expectedGrandTotal) - quote.grandTotal) > 0.01) {
    throw new AppError(
      409,
      `Your total changed from ₹${Number(expectedGrandTotal).toFixed(2)} to ₹${quote.grandTotal.toFixed(2)}. Please review and place the order again.`,
      "PRICE_CHANGED"
    );
  }

  const buyer = await User.findById(user._id).lean();
  const buyerSnapshot = {
    name: buyer?.name || address.contactName || "",
    company: buyer?.profile?.company || "",
    email: buyer?.email || "",
    phone: buyer?.phone || address.phone || "",
    gstin: buyer?.profile?.gstin || "",
  };
  const sellers = await sellerSnapshots(quote.groups.map((g) => g.tenantId));

  // Reservations made without a transaction (standalone Mongo) must be undone by hand on failure.
  let manual = { reserved: [], orderIds: [] };

  let createdOrders = [];
  try {
    createdOrders = await withTransaction(async (session) => {
      manual = { reserved: [], orderIds: [] };
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
          if (!session) {
            manual.reserved.push({
              tenantId: group.tenantId,
              warehouseId: item.warehouseId,
              variantId: item.variantId,
              qty: item.qty,
            });
          }
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
            hsn: i.hsn || "",
            attributes: i.attributes,
            qty: i.qty,
            bulk: Boolean(i.bulk),
            listPrice: i.listPrice,
            unitPrice: i.unitPrice,
            lineSubtotal: i.lineSubtotal,
            couponShare: i.couponShare || 0,
            taxRate: i.taxRate,
            taxableValue: i.taxableValue,
            tax: i.tax,
            lineTotal: i.lineTotal,
            warehouseId: i.warehouseId,
            breakdown: i.breakdown,
            fulfillmentMode: resolveFulfillment({ deliveryModes: i.deliveryModes }, i.fulfillmentMode),
            easyReturn: Boolean(i.easyReturn),
          })),
          addressSnapshot: address.toObject ? address.toObject() : address,
          buyerSnapshot,
          sellerSnapshot: sellers.get(String(group.tenantId)) || {},
          couponCode: group.couponCode,
          couponDiscount: group.couponDiscount,
          subtotal: group.subtotal,
          taxableValue: group.taxableValue,
          tax: group.tax,
          taxInclusive: true,
          deliveryFee: group.deliveryFee,
          platformFee: group.platformFee || 0,
          partnerFee: group.partnerFee || 0,
          deliveryPartner: group.deliveryPartner
            ? {
                id: group.deliveryPartner.id,
                name: group.deliveryPartner.name,
                fee: group.deliveryPartner.fee,
              }
            : undefined,
          total: group.total,
          paymentMethod,
          paymentStatus: "unpaid",
          poNumber: String(poNumber || "").trim(),
          buyerNotes: buyerNotes || "",
          ledgerDebit: 0,
          idempotencyKey,
          etaFrom: group.eta?.etaFrom,
          etaTo: group.eta?.etaTo,
          statusHistory: [{ status: "pending", actorId: user._id, note: "Order created" }],
        };

        const [order] = session
          ? await Order.create([payload], { session })
          : [await Order.create(payload)];
        if (!session) manual.orderIds.push(order._id);

        if (group.couponCode) {
          const couponFilter = { tenantId: group.tenantId, code: group.couponCode, status: "active" };
          let couponQuery = Coupon.findOne(couponFilter);
          if (session) couponQuery = couponQuery.session(session);
          const coupon = await couponQuery;
          if (!coupon) throw new AppError(400, "Coupon is no longer active", "INVALID_COUPON");
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
    for (const r of manual.reserved) {
      await releaseReservation({ ...r, reference: idempotencyKey }).catch(() => {});
    }
    if (manual.orderIds.length) {
      await Order.deleteMany({ _id: { $in: manual.orderIds } }).catch(() => {});
      await CouponUsage.deleteMany({ orderId: { $in: manual.orderIds } }).catch(() => {});
    }
    if (err?.code === 11000 && String(err.message || "").includes("idempotencyKey")) {
      const replay = await existingOrders(user._id, idempotencyKey);
      if (replay.length) return { orders: replay, idempotent: true };
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
    try {
      await ledger.debitOrder(order);
    } catch (err) {
      console.error("ledger debit failed", err.message);
    }
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

/** Atomically claims the pending order, commits its stock and issues the GST invoice. */
export async function confirmOrder(order, actorId) {
  if (order.status !== "pending") {
    throw new AppError(400, "Only pending orders can be confirmed", "INVALID_STATE");
  }
  let manualCommits = [];
  let claimedWithoutSession = false;
  let confirmed;
  try {
    confirmed = await withTransaction(async (session) => {
      manualCommits = [];
      claimedWithoutSession = false;
      const opts = { new: true };
      if (session) opts.session = session;
      const claimed = await Order.findOneAndUpdate(
        { _id: order._id, status: "pending" },
        {
          $set: { status: "confirmed" },
          $push: { statusHistory: { status: "confirmed", actorId, note: "Confirmed", at: new Date() } },
        },
        opts
      );
      if (!claimed) throw new AppError(409, "Order was already updated. Refresh and try again.", "INVALID_STATE");
      if (!session) claimedWithoutSession = true;
      for (const item of claimed.items) {
        const ref = {
          tenantId: claimed.tenantId,
          warehouseId: item.warehouseId,
          variantId: item.variantId,
          qty: item.qty,
        };
        await commitReservation({ ...ref, reference: claimed.orderNumber, session });
        if (!session) manualCommits.push(ref);
      }
      return claimed;
    });
  } catch (err) {
    for (const ref of manualCommits) await uncommitReservation(ref).catch(() => {});
    if (claimedWithoutSession) {
      await Order.updateOne(
        { _id: order._id, status: "confirmed" },
        { $set: { status: "pending" }, $pop: { statusHistory: 1 } }
      ).catch(() => {});
    }
    throw err;
  }

  try {
    const invoice = await generateInvoice(confirmed);
    await attachInvoice(confirmed, invoice);
  } catch (err) {
    console.error("invoice generation failed", confirmed.orderNumber, err.message);
  }

  emitDomain("ORDER_CONFIRMED", {
    orderId: confirmed._id,
    tenantId: confirmed.tenantId,
    buyerId: confirmed.buyerId,
    userId: confirmed.buyerId,
    actorId,
    orderNumber: confirmed.orderNumber,
    total: confirmed.total,
    resource: "order",
    resourceId: confirmed._id,
  });
  return confirmed;
}

async function restoreStock(order, wasPending) {
  for (const item of order.items) {
    const args = {
      tenantId: order.tenantId,
      warehouseId: item.warehouseId,
      variantId: item.variantId,
      qty: item.qty,
      reference: order.orderNumber,
    };
    if (wasPending) await releaseReservation(args);
    else await restoreCommitted(args);
  }
}

/** Atomically move the order from its current status, so concurrent updates cannot double-restore stock. */
async function claimStatus(order, fromStatuses, status, actorId, note) {
  const previous = await Order.findOneAndUpdate(
    { _id: order._id, status: { $in: fromStatuses } },
    {
      $set: { status, ...(status === "refunded" ? { paymentStatus: "refunded" } : {}) },
      $push: { statusHistory: { status, actorId, note, at: new Date() } },
    },
    { new: false }
  );
  if (!previous) {
    throw new AppError(409, `Order cannot be ${status} from its current status`, "INVALID_STATE");
  }
  const updated = await Order.findById(order._id);
  return { previous, updated };
}

export async function cancelOrder(order, actorId, note, { timeout = false } = {}) {
  if (!CANCELLABLE_STATUSES.includes(order.status)) {
    throw new AppError(400, "Order cannot be cancelled once it has shipped", "INVALID_STATE");
  }
  const { previous, updated } = await claimStatus(
    order,
    CANCELLABLE_STATUSES,
    "cancelled",
    actorId,
    note || (timeout ? "Reservation timeout" : "Cancelled")
  );
  await restoreStock(previous, previous.status === "pending");
  await cancelInvoice(updated._id).catch(() => {});
  try {
    await ledger.creditOrder(updated, note || "Order cancelled");
  } catch (err) {
    console.error("ledger credit failed", err.message);
  }
  emitDomain(timeout ? "ORDER_TIMEOUT" : "ORDER_CANCELLED", {
    orderId: updated._id,
    tenantId: updated.tenantId,
    buyerId: updated.buyerId,
    userId: updated.buyerId,
    actorId,
    orderNumber: updated.orderNumber,
    total: updated.total,
    resource: "order",
    resourceId: updated._id,
  });
  return updated;
}

export async function refundOrder(order, actorId, note) {
  if (!REFUNDABLE_STATUSES.includes(order.status)) {
    throw new AppError(400, "Only delivered/return-requested orders can be refunded", "INVALID_STATE");
  }
  const { previous, updated } = await claimStatus(order, REFUNDABLE_STATUSES, "refunded", actorId, note || "Refunded");
  await restoreStock(previous, false);
  try {
    await ledger.creditOrder(updated, note || "Order refunded");
  } catch (err) {
    console.error("ledger credit failed", err.message);
  }
  emitDomain("ORDER_REFUNDED", {
    orderId: updated._id,
    tenantId: updated.tenantId,
    buyerId: updated.buyerId,
    userId: updated.buyerId,
    actorId,
    orderNumber: updated.orderNumber,
    total: updated.total,
    resource: "order",
    resourceId: updated._id,
  });
  return updated;
}
