import mongoose from "mongoose";
import { nanoid } from "nanoid";
import { Order, orderEventPayload } from "../orders/order.model.js";
import { Coupon } from "../pricing/coupon.model.js";
import { CouponUsage, CouponCustomerUse } from "../pricing/couponUsage.model.js";
import { Offer } from "../pricing/offer.model.js";
import { assertCouponStillValid } from "../pricing/engine.js";
import { Cart } from "../cart/cart.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { storeCards } from "../tenants/storeCard.js";
import { User } from "../users/user.model.js";
import { getOrCreateCart, quoteCart, resolveFulfillment, transferLineHoldToOrder, touchCartHolds } from "../cart/service.js";
import { releaseCartHold } from "../inventory/service.js";
import { getAddressForUser } from "../location/address.service.js";
import { withTransaction, afterCommit } from "../../utils/transaction.js";
import { AppError } from "../../utils/AppError.js";
import { emitDomain } from "../../utils/events.js";
import { orderUpdatedAfterCommit } from "../orders/events.js";
import { PAYMENT_METHODS } from "../../config/constants.js";
import * as ledger from "../ledger/service.js";
import { ONLINE_PAYMENT_METHODS, toPaise, razorpayConfigured } from "./razorpayApi.js";
import { checkoutGroups } from "../orders/totals.js";
import { round2 } from "../pricing/engine.js";
import {
  razorpayCheckoutPayload,
  verifyRazorpayPayment,
  resumeRazorpayPayment,
  presentPayment,
  payableOrders,
} from "./razorpay.js";
import {
  confirmOrder,
  cancelOrder,
  refundOrder,
  offerUsageFromItems,
} from "../orders/lifecycle.js";
import { CANCELLABLE_STATUSES, BUYER_CANCELLABLE_STATUSES, REFUNDABLE_STATUSES } from "../orders/statuses.js";

export { verifyRazorpayPayment, resumeRazorpayPayment, confirmOrder, cancelOrder, refundOrder };
export { CANCELLABLE_STATUSES, BUYER_CANCELLABLE_STATUSES, REFUNDABLE_STATUSES };

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
      postalCode: t.pickupAddress?.postalCode || "",
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
  // The buyer is on the checkout page: keep their existing holds alive (nothing new is reserved).
  await touchCartHolds(cart);
  return quoteCart(cart, user._id, address, { deliveryPartnerId });
}

const METHOD_LABELS = {
  upi: "UPI",
  card: "Card",
  netbanking: "Net banking",
  cod: "Cash on delivery",
  purchase_order: "Purchase order",
  credit_terms: "Credit terms",
};

/**
 * Which payment methods each store group of the buyer's cart allows, with the reason when one is
 * not. One checkout uses one method for every store group, so `methods` is the intersection.
 * `addressId` is optional; with it the totals include delivery fees (as at checkout).
 */
export async function paymentOptions({ user, addressId }) {
  const cart = await getOrCreateCart(user._id);
  const address = addressId ? await getAddressForUser(user._id, addressId) : null;
  const quote = await quoteCart(cart, user._id, address);
  const online = razorpayConfigured();
  const tenantIds = quote.groups.map((g) => g.tenantId);
  const ledgers = await Promise.all(tenantIds.map((tenantId) => ledger.findLedger(user._id, tenantId)));
  const groups = quote.groups.map((group, index) => {
    const account = ledgers[index];
    const terms = account?.buyerTerms || {};
    const spendable = account ? ledger.spendablePaise(account) : 0;
    const needed = toPaise(group.total);
    const figures = ledger.presentLedger(account);
    const methods = PAYMENT_METHODS.map((method) => {
      let enabled = true;
      let reason = "";
      let code = null;
      if (ONLINE_PAYMENT_METHODS.includes(method) && !online) {
        enabled = false;
        reason = "Online payment is not available right now";
        code = "PAYMENT_UNAVAILABLE";
      } else if (method === "cod" && !group.codEnabled) {
        enabled = false;
        reason = "This store does not offer cash on delivery";
        code = "COD_DISABLED";
      } else if (ledger.LEDGER_PAYMENT_METHODS.includes(method)) {
        const allowed = method === "credit_terms" ? terms.creditEnabled : terms.purchaseOrderEnabled;
        if (!allowed) {
          enabled = false;
          reason =
            method === "credit_terms"
              ? "This store has not enabled credit terms for your account"
              : "This store has not enabled purchase orders for your account";
          code = "TERMS_NOT_ENABLED";
        } else if (spendable < needed) {
          enabled = false;
          reason = `Credit limit exceeded. Available balance is ₹${(spendable / 100).toFixed(2)}.`;
          code = "INSUFFICIENT_CREDIT";
        }
      }
      return { method, label: METHOD_LABELS[method], enabled, reason, code, requiresPoNumber: method === "purchase_order" };
    });
    return {
      tenantId: group.tenantId,
      store: group.store || null, // { id, name, displayName, slug, city, logo } from the cart quote
      total: group.total,
      grandTotal: group.total,
      credit: figures
        ? {
            creditEnabled: Boolean(terms.creditEnabled),
            purchaseOrderEnabled: Boolean(terms.purchaseOrderEnabled),
            paymentDays: terms.paymentDays ?? null,
            spendable: figures.spendable,
            available: figures.available,
            advance: figures.advance,
            outstanding: figures.outstanding,
            creditLimit: figures.creditLimit,
          }
        : null,
      methods,
    };
  });
  const methods = PAYMENT_METHODS.map((method) => {
    const blocked = groups
      .map((g) => ({ g, row: g.methods.find((m) => m.method === method) }))
      .filter(({ row }) => !row.enabled);
    const first = blocked[0];
    return {
      method,
      label: METHOD_LABELS[method],
      enabled: groups.length > 0 && blocked.length === 0,
      reason: !groups.length
        ? "Cart is empty"
        : first
          ? groups.length > 1
            ? `${first.g.store?.name || "A store"}: ${first.row.reason}`
            : first.row.reason
          : "",
      code: !groups.length ? "EMPTY_CART" : first?.row.code || null,
      requiresPoNumber: method === "purchase_order",
    };
  });
  return {
    addressId: addressId || null,
    grandTotal: quote.grandTotal,
    hasIssues: quote.unavailable.length > 0,
    groups,
    methods,
    defaultMethod: methods.find((m) => m.enabled)?.method || null,
  };
}

async function existingOrders(buyerId, idempotencyKey) {
  return Order.find({ buyerId, idempotencyKey }).sort({ createdAt: 1 });
}

/** Coupon: global cap, per-customer cap (guarded upsert) and usage row on this store's order. */
export async function redeemCoupon({ group, order, userId, session }) {
  const coupon = await Coupon.findById(group.couponId).session(session);
  assertCouponStillValid(coupon, group.tenantId);
  const cap = coupon.maxRedemptions;
  const bumped = await Coupon.findOneAndUpdate(
    { _id: coupon._id, status: "active", ...(cap != null ? { redemptionCount: { $lt: cap } } : {}) },
    { $inc: { redemptionCount: 1 } },
    { new: true, session }
  );
  if (!bumped) throw new AppError(400, "Coupon usage limit reached", "COUPON_LIMIT");
  const limit = Math.max(1, Number(coupon.perCustomerLimit) || 1);
  try {
    await CouponCustomerUse.findOneAndUpdate(
      { couponId: coupon._id, userId, count: { $lt: limit } },
      { $inc: { count: 1 }, $setOnInsert: { tenantId: coupon.tenantId } },
      { upsert: true, new: true, session }
    );
  } catch (err) {
    if (err?.code === 11000) throw new AppError(400, "You have already used this coupon", "COUPON_LIMIT");
    throw err;
  }
  if (coupon.firstOrderOnly) {
    const previous = await Order.exists({
      tenantId: coupon.tenantId,
      buyerId: userId,
      status: { $ne: "cancelled" },
      _id: { $ne: order._id },
    }).session(session);
    if (previous) throw new AppError(400, "This coupon is only for your first order with this store", "COUPON_FIRST_ORDER");
  }
  await CouponUsage.create([{ tenantId: coupon.tenantId, couponId: coupon._id, userId, orderId: order._id }], { session });
}

function orderItemFromQuote(i) {
  const attrs = i.attributes?.toObject?.() || i.attributes || {};
  const dims = attrs.dimensions || {};
  return {
    _id: new mongoose.Types.ObjectId(),
    tenantId: i.tenantId,
    productId: i.productId,
    variantId: i.variantId,
    sku: i.sku,
    name: i.name,
    image: i.image || "",
    slug: i.slug || "",
    hsn: i.hsn || "",
    attributes: attrs,
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
    weightGrams: Number(attrs.weight) || 0,
    dimensionsCm: { l: Number(dims.l) || 0, w: Number(dims.w) || 0, h: Number(dims.h) || 0 },
  };
}

/**
 * Place the order(s) for the buyer's cart. Everything happens in ONE transaction:
 * claim the cart by its version (so a double click / second tab gets 409 instead of a second
 * order), create one order per store, re-own each cart hold to its order line (or reserve fresh
 * stock), redeem coupons/offers on the issuing store's order, debit credit/PO ledgers, and
 * clear the cart. Any failure rolls all of it back.
 */
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
  const key = String(idempotencyKey || "").trim();
  if (!key || key.length > 200) throw new AppError(400, "Idempotency-Key header required", "IDEMPOTENCY");
  if (!PAYMENT_METHODS.includes(paymentMethod)) {
    throw new AppError(400, "Choose a payment method", "VALIDATION_ERROR");
  }
  if (paymentMethod === "purchase_order" && !String(poNumber || "").trim()) {
    throw new AppError(400, "PO number is required for purchase orders", "PO_REQUIRED");
  }
  if (expectedGrandTotal == null || !Number.isFinite(Number(expectedGrandTotal))) {
    throw new AppError(400, "expectedGrandTotal is required", "VALIDATION_ERROR");
  }

  const existing = await existingOrders(user._id, key);
  if (existing.length) return presentCheckout(existing, true);

  const cart = await getOrCreateCart(user._id);
  if (!cart.items.length) throw new AppError(400, "Cart is empty", "EMPTY_CART");
  const cartVersion = cart.__v;
  const address = await getAddressForUser(user._id, addressId);
  const quote = await quoteCart(cart, user._id, address, { deliveryPartnerId, strictCoupon: true });
  assertCheckoutable(quote);
  if (paymentMethod === "cod" && !quote.codEnabled) {
    throw new AppError(400, "Cash on delivery is not available for this order", "COD_DISABLED");
  }
  if (Math.abs(Number(expectedGrandTotal) - quote.grandTotal) > 0.01) {
    throw new AppError(
      409,
      `Your total changed from ₹${Number(expectedGrandTotal).toFixed(2)} to ₹${quote.grandTotal.toFixed(2)}. Please review and place the order again.`,
      "PRICE_CHANGED"
    );
  }
  if (ledger.LEDGER_PAYMENT_METHODS.includes(paymentMethod)) {
    for (const group of quote.groups) {
      const account = await ledger.assertTermsAllowed({ userId: user._id, tenantId: group.tenantId, paymentMethod });
      // Spending power = unused credit + advance (overpayment) held for this buyer.
      const available = ledger.spendablePaise(account);
      if (available < toPaise(group.total)) {
        throw new AppError(402, `Credit limit exceeded. Available balance is ₹${(available / 100).toFixed(2)}.`, "INSUFFICIENT_CREDIT");
      }
    }
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
  const online = ONLINE_PAYMENT_METHODS.includes(paymentMethod);
  const addressPlain = address.toObject ? address.toObject() : address;

  let createdOrders;
  try {
    createdOrders = await withTransaction(async (session) => {
      // 1. Claim the cart: only the version we priced, and only once.
      const claimed = await Cart.findOneAndUpdate(
        { _id: cart._id, __v: cartVersion, "items.0": { $exists: true } },
        { $set: { items: [], couponCode: "" }, $inc: { __v: 1 } },
        { new: false, session }
      );
      if (!claimed) {
        throw new AppError(409, "Your cart changed (or this order was already placed). Refresh and try again.", "CART_CHANGED");
      }
      const created = [];
      for (const group of quote.groups) {
        const orderId = new mongoose.Types.ObjectId();
        const items = group.items.map(orderItemFromQuote);
        const payload = {
          _id: orderId,
          orderNumber: `ORD-${nanoid(10).toUpperCase()}`,
          tenantId: group.tenantId,
          buyerId: user._id,
          status: "pending",
          items,
          addressSnapshot: addressPlain,
          buyerSnapshot,
          sellerSnapshot: sellers.get(String(group.tenantId)) || {},
          couponCode: group.couponCode,
          couponDiscount: group.couponDiscount,
          subtotal: group.subtotal,
          taxableValue: group.taxableValue,
          tax: group.tax,
          feeTax: group.feeTax || 0,
          taxInclusive: true,
          deliveryFee: group.deliveryFee,
          platformFee: group.platformFee || 0,
          partnerFee: group.partnerFee || 0,
          deliveryPartner: group.deliveryPartner
            ? { id: group.deliveryPartner.id, name: group.deliveryPartner.name, fee: group.deliveryPartner.fee }
            : undefined,
          total: group.total,
          paymentMethod,
          paymentStatus: online ? "pending" : "unpaid",
          poNumber: String(poNumber || "").trim(),
          buyerNotes: buyerNotes || "",
          ledgerDebit: 0,
          idempotencyKey: key,
          etaFrom: group.eta?.etaFrom,
          etaTo: group.eta?.etaTo,
          statusHistory: [{ status: "pending", actorId: user._id, note: "Order created" }],
        };
        const [order] = await Order.create([payload], { session });

        // 2. Stock: re-own the cart hold (atomic claim) or reserve fresh for this order line.
        for (const [index, item] of group.items.entries()) {
          const cartItem = claimed.items.find((row) => String(row._id) === String(item.cartItemId));
          await transferLineHoldToOrder({
            cartItem,
            orderId,
            orderItemId: items[index]._id,
            tenantId: group.tenantId,
            warehouseId: item.warehouseId,
            variantId: item.variantId,
            qty: item.qty,
            reference: order.orderNumber,
            session,
          });
        }

        // 3. Promotions, scoped to this store's order.
        if (group.couponId && group.couponDiscount > 0) {
          await redeemCoupon({ group, order, userId: user._id, session });
        }
        for (const [offerId, qty] of offerUsageFromItems(group.items)) {
          if (qty <= 0) continue;
          const updated = await Offer.findOneAndUpdate(
            {
              _id: offerId,
              tenantId: group.tenantId,
              status: "active",
              $or: [
                { inventoryCap: null },
                { inventoryCap: { $exists: false } },
                { $expr: { $lte: [{ $add: ["$inventoryUsed", qty] }, "$inventoryCap"] } },
              ],
            },
            { $inc: { inventoryUsed: qty } },
            { new: true, session }
          );
          if (!updated) throw new AppError(409, "This offer has reached its quantity limit", "OFFER_LIMIT");
        }

        // 4. Credit / PO: debit inside the same transaction; failure aborts the checkout.
        await ledger.debitOrder(order, { session });
        created.push(order);
      }
      // Release cart holds that no order line used (none in the normal case).
      for (const line of claimed.items) {
        if (!line.reservationId) continue;
        await releaseCartHold(line.reservationId, { session, note: "unused at checkout" });
      }
      for (const order of created) {
        afterCommit(session, () => emitDomain("ORDER_CREATED", orderEventPayload(order)));
        orderUpdatedAfterCommit(session, order);
      }
      return created;
    });
  } catch (err) {
    const dupKey = err?.code === 11000 && /idempotency/i.test(String(err.message || ""));
    if (dupKey || err?.code === "CART_CHANGED") {
      const replay = await existingOrders(user._id, key);
      if (replay.length) return presentCheckout(replay, true);
    }
    throw err;
  }

  return presentCheckout(createdOrders, false);
}

/** Replays only offer payment for orders that can still be paid. */
async function presentCheckout(orders, idempotent) {
  const online = ONLINE_PAYMENT_METHODS.includes(orders[0]?.paymentMethod);
  let razorpay = null;
  let current = orders;
  if (online) {
    const fresh = await Order.find({ _id: { $in: orders.map((o) => o._id) } }).sort({ createdAt: 1 });
    current = fresh;
    const payable = payableOrders(fresh);
    if (payable.length) {
      let result = { orders: [], razorpay: null };
      try {
        result = await presentPayment(payable);
      } catch (err) {
        if (err.code !== "PAYMENT_UNAVAILABLE" && err.code !== "PAYMENT_PROVIDER_ERROR") throw err;
        // Orders are placed; the buyer can retry payment via POST /checkout/pay.
        console.error("razorpay order creation failed", err.message);
      }
      razorpay = result.razorpay;
      if (result.orders?.length) {
        const byId = new Map(result.orders.map((o) => [String(o._id), o]));
        current = fresh.map((o) => byId.get(String(o._id)) || o);
      }
    }
  }
  const cards = await storeCards(current.map((o) => o.tenantId?._id || o.tenantId));
  const groups = checkoutGroups(current).map((g) => ({ ...g, store: cards.get(String(g.tenantId)) || null }));
  return {
    orders: current,
    idempotent,
    razorpay,
    payableOrderIds: payableOrders(current).map((o) => o._id),
    groups,
    grandTotal: round2(groups.reduce((sum, g) => sum + g.grandTotal, 0)),
  };
}

export { razorpayCheckoutPayload };
