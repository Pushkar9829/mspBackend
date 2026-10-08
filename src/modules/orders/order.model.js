import mongoose from "mongoose";
import { FULFILLMENT_MODES, PAYMENT_METHODS, PAYMENT_STATUSES } from "../../config/constants.js";
import { ORDER_STATUS_LIST } from "./statuses.js";

const orderItemSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
  sku: String,
  name: String,
  image: String,
  slug: String,
  attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
  hsn: { type: String, default: "" },
  qty: { type: Number, required: true, min: 1 },
  bulk: { type: Boolean, default: false },
  listPrice: Number,
  unitPrice: { type: Number, required: true, min: 0 },
  lineSubtotal: { type: Number, required: true, min: 0 },
  couponShare: { type: Number, default: 0 },
  taxRate: Number,
  taxableValue: Number,
  tax: Number,
  lineTotal: { type: Number, required: true, min: 0 },
  warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse" },
  breakdown: { type: mongoose.Schema.Types.Mixed, default: [] },
  fulfillmentMode: { type: String, enum: FULFILLMENT_MODES, default: "delivery_partner" },
  easyReturn: { type: Boolean, default: false },
  /** Shipping metadata copied from the variant at checkout (grams / cm). */
  weightGrams: { type: Number, default: 0 },
  dimensionsCm: { l: Number, w: Number, h: Number },
});

const refundSchema = new mongoose.Schema(
  {
    /** Idempotency key for the provider call (one per refund intent). */
    key: { type: String, required: true },
    provider: { type: String, enum: ["razorpay", "ledger", "manual"], default: "razorpay" },
    paymentId: { type: String, default: "" },
    amount: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ["pending", "processing", "processed", "failed"], default: "pending" },
    providerRefundId: { type: String, default: "" },
    reason: { type: String, default: "" },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    lockedUntil: { type: Date, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const fulfillmentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["forward", "return"], default: "forward" },
    carrier: String,
    trackingNumber: String,
    shippedAt: Date,
    status: { type: String, default: "" },
    lastScanAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    events: {
      type: [{ _id: false, status: String, location: String, note: String, at: Date }],
      default: [],
    },
  },
  { _id: true }
);

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ORDER_STATUS_LIST, default: "pending", index: true },
    items: {
      type: [orderItemSchema],
      validate: { validator: (v) => Array.isArray(v) && v.length > 0, message: "An order needs at least one item" },
    },
    addressSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    couponCode: { type: String, default: "" },
    couponDiscount: { type: Number, default: 0 },
    subtotal: { type: Number, required: true },
    taxableValue: { type: Number, default: 0 },
    tax: { type: Number, required: true },
    /** Portion of `tax` that is GST inside delivery, platform, and partner fees. */
    feeTax: { type: Number, default: 0 },
    taxInclusive: { type: Boolean, default: true },
    buyerSnapshot: {
      name: { type: String, default: "" },
      company: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      gstin: { type: String, default: "" },
    },
    sellerSnapshot: {
      name: { type: String, default: "" },
      legalName: { type: String, default: "" },
      gstin: { type: String, default: "" },
      state: { type: String, default: "" },
      address: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      postalCode: { type: String, default: "" },
    },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    invoiceNumber: { type: String, default: "" },
    creditNoteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "CreditNote" }],
    deliveryFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    partnerFee: { type: Number, default: 0 },
    deliveryPartner: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
      fee: { type: Number, default: 0 },
    },
    total: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: "purchase_order" },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: "unpaid" },
    razorpayOrderId: { type: String, default: "", index: true },
    /** Amount (paise) of the Razorpay order this order is attached to (all sibling orders together). */
    razorpayAmountPaise: { type: Number, default: 0 },
    /** Razorpay orders this order was attached to before (late payments on them get refunded). */
    razorpayOrderHistory: { type: [String], default: [] },
    razorpayPaymentId: { type: String, default: "" },
    paidAt: { type: Date, default: null },
    refunds: { type: [refundSchema], default: [] },
    poNumber: { type: String, default: "" },
    buyerNotes: { type: String, default: "" },
    sellerNotes: { type: String, default: "" },
    ledgerDebit: { type: Number, default: 0 },
    /** Absent (not "") when no key, so the partial unique index ignores it. */
    idempotencyKey: { type: String },
    etaFrom: Date,
    etaTo: Date,
    deliveredAt: { type: Date, default: null },
    returnRequest: {
      status: { type: String, enum: ["requested", "approved", "rejected", "received", null], default: null },
      reason: { type: String, default: "" },
      note: { type: String, default: "" },
      requestedAt: Date,
      decidedAt: Date,
      receivedAt: Date,
      decisionNote: { type: String, default: "" },
    },
    statusHistory: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        note: String,
      },
    ],
    fulfillments: { type: [fulfillmentSchema], default: [] },
  },
  { timestamps: true }
);

orderSchema.index({ tenantId: 1, createdAt: -1 });
orderSchema.index({ buyerId: 1, createdAt: -1 });
orderSchema.index(
  { buyerId: 1, tenantId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
    name: "checkout_idempotency",
  }
);
orderSchema.index({ buyerId: 1, idempotencyKey: 1 });
orderSchema.index({ status: 1, paymentStatus: 1, createdAt: 1 });
orderSchema.index({ "refunds.status": 1 });
orderSchema.index({ "refunds.providerRefundId": 1 });
orderSchema.index({ razorpayOrderHistory: 1 });
orderSchema.index({ "fulfillments.trackingNumber": 1 });

export function orderEventPayload(order, extra = {}) {
  const plain = typeof order?.toObject === "function" ? order.toObject() : { ...(order || {}) };
  const tenantId = plain.tenantId?._id || plain.tenantId;
  const buyerId = plain.buyerId?._id || plain.buyerId;
  return {
    order: {
      _id: plain._id,
      tenantId,
      buyerId,
      orderNumber: plain.orderNumber,
      grandTotal: plain.total,
      total: plain.total,
      status: plain.status,
      paymentStatus: plain.paymentStatus,
      paymentMethod: plain.paymentMethod,
    },
    orderId: plain._id,
    tenantId,
    buyerId,
    userId: buyerId,
    orderNumber: plain.orderNumber,
    total: plain.total,
    resource: "order",
    resourceId: plain._id,
    ...extra,
  };
}

export const Order = mongoose.model("Order", orderSchema);
