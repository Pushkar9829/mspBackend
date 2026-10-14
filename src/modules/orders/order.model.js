import mongoose from "mongoose";
import {
  FULFILLMENT_MODES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  ORDER_CANCELLED_BY,
  ORDER_CANCEL_CAUSES,
  RETURN_STATUSES,
} from "../../config/constants.js";
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
  /** Units of this line received back through returns (cumulative). */
  returnedQty: { type: Number, default: 0, min: 0 },
});

const refundSchema = new mongoose.Schema(
  {
    /** Idempotency key for the provider call (one per refund intent). */
    key: { type: String, required: true },
    provider: { type: String, enum: ["razorpay", "ledger", "manual"], default: "razorpay" },
    /**
     * How the money goes back: razorpay (original online payment), cod (offline payout to the
     * buyer's UPI / bank, or store credit), ledger_credit (credit / PO account credit).
     * Absent on refunds recorded before this field existed (= razorpay).
     */
    method: { type: String, enum: ["razorpay", "cod", "ledger_credit"], default: "razorpay" },
    /** Payout destination for `cod` refunds (buyer-supplied). */
    destination: {
      type: { type: String, enum: ["", "upi", "bank", "store_credit"], default: "" },
      upiId: { type: String, default: "" },
      accountName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      ifsc: { type: String, default: "" },
    },
    /** Payout reference (UTR / txn id) recorded by the platform when an offline refund is paid. */
    payoutReference: { type: String, default: "" },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** Return request this refund belongs to (null for cancel / RTO / full refunds). */
    returnId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** Admin alert sent after the last automatic attempt failed. */
    alertedAt: { type: Date, default: null },
    paymentId: { type: String, default: "" },
    amount: { type: Number, required: true, min: 0 },
    /** pending_payout: offline (COD) refund waiting for the platform to pay it out. */
    status: { type: String, enum: ["pending", "processing", "processed", "failed", "pending_payout"], default: "pending" },
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
    /** Shiprocket order id, used to cancel and to match webhooks that arrive before the AWB. */
    externalOrderId: { type: String, default: "" },
    shipmentId: { type: String, default: "" },
    shippedAt: Date,
    status: { type: String, default: "" },
    lastScanAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    /** Phase 6: failed courier pickup attempts of a return shipment (kind "return"). */
    failedAttempts: { type: Number, default: 0 },
    events: {
      type: [{ _id: false, status: String, location: String, note: String, at: Date }],
      default: [],
    },
  },
  { _id: true }
);

const returnItemSchema = new mongoose.Schema(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, default: "" },
    qty: { type: Number, required: true, min: 1 },
    /** Set on receive: units that came back unsellable (booked to damaged stock). */
    damagedQty: { type: Number, default: 0, min: 0 },
    /** Refund value of these units (line value incl. GST, minus their coupon share). */
    amount: { type: Number, default: 0 },
    taxableValue: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
  },
  { _id: false }
);

/** One return request (item level). History is kept; at most one is active (requested/approved). */
const returnSchema = new mongoose.Schema(
  {
    status: { type: String, enum: RETURN_STATUSES, default: "requested" },
    reason: { type: String, default: "" },
    reasonCode: { type: String, default: "other" },
    /** Seller-fault reasons also refund the lines' proportional share of the fees. */
    sellerFault: { type: Boolean, default: false },
    note: { type: String, default: "" },
    items: { type: [returnItemSchema], default: [] },
    itemsAmount: { type: Number, default: 0 },
    feesAmount: { type: Number, default: 0 },
    refundAmount: { type: Number, default: 0 },
    /** Where an offline (COD) refund should be paid; optional at request time. */
    refundDestination: {
      type: { type: String, enum: ["", "upi", "bank", "store_credit"], default: "" },
      upiId: { type: String, default: "" },
      accountName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      ifsc: { type: String, default: "" },
    },
    requestedAt: { type: Date, default: Date.now },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    decisionNote: { type: String, default: "" },
    receivedAt: { type: Date, default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    receiveNote: { type: String, default: "" },
    refundKey: { type: String, default: "" },
    creditNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "CreditNote", default: null },
    /** Created from a pre-item-level returnRequest (whole order). */
    legacy: { type: Boolean, default: false },
    /* ---- phase 6 ---- */
    /** Seller must approve / reject by then (returns.decideWithinHours), else auto-approved. */
    decideBy: { type: Date, default: null },
    decideWarnedAt: { type: Date, default: null },
    /** Approved by the system because the seller missed decideBy (counted against the seller). */
    autoApproved: { type: Boolean, default: false },
    pickupScheduledAt: { type: Date, default: null },
    /** Pickup could not be done (courier / rider gave up, or the seller recorded it). */
    pickupFailedAt: { type: Date, default: null },
    pickupFailReason: { type: String, default: "" },
    /** Quality check at receive: units the seller rejected after inspection (no refund for them). */
    qc: {
      at: { type: Date, default: null },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      note: { type: String, default: "" },
      photos: { type: [mongoose.Schema.Types.ObjectId], default: [] },
      /** What happens to the rejected units: sent back to the buyer, or held by the seller. */
      disposition: { type: String, enum: ["", "return_to_buyer", "hold"], default: "" },
      items: {
        type: [
          {
            _id: false,
            itemId: mongoose.Schema.Types.ObjectId,
            name: { type: String, default: "" },
            qty: { type: Number, default: 0 },
            reason: { type: String, default: "" },
            amount: { type: Number, default: 0 },
          },
        ],
        default: [],
      },
      rejectedAmount: { type: Number, default: 0 },
    },
    /** Refund must be completed by then (returns.refundWithinHours); admins alerted after. */
    refundDueBy: { type: Date, default: null },
    refundAlertedAt: { type: Date, default: null },
    /** Dispute decided "reopen": the new return record created for the disputed units. */
    reopenedAs: { type: mongoose.Schema.Types.ObjectId, default: null },
    reopenedFrom: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** Dispute whose "reopen" decision created this return (phase 6). */
    reopenedByDisputeId: { type: mongoose.Schema.Types.ObjectId, ref: "Dispute", default: null },
    /** Buyer dispute about this return (one per return). disputeOpen holds seller payouts. */
    disputeId: { type: mongoose.Schema.Types.ObjectId, ref: "Dispute", default: null },
    disputeStatus: { type: String, default: "" },
    disputeOpen: { type: Boolean, default: false },
  },
  { _id: true, timestamps: true }
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
      /** FSSAI licence number (only when the order has food lines). */
      fssai: { type: String, default: "" },
    },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
    invoiceNumber: { type: String, default: "" },
    creditNoteIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "CreditNote" }],
    /** Platform's own invoice to the buyer for platform / courier-partner fees (split invoicing). */
    platformInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformOrderInvoice", default: null },
    platformInvoiceNumber: { type: String, default: "" },
    deliveryFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    partnerFee: { type: Number, default: 0 },
    /**
     * Phase 5: how the order reaches the buyer — own_fleet (the store's riders, chosen by the
     * buyer's delivery zone), partner (delivery partner / courier), pickup (store pickup only).
     * "" on orders placed before phase 5 (= partner / pickup as before).
     */
    deliveryMethod: { type: String, enum: ["own_fleet", "partner", "pickup", ""], default: "" },
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
    /** Method the buyer actually paid with in Razorpay (upi | card | netbanking | wallet | emi | paylater); may differ from paymentMethod. */
    paidVia: { type: String, default: "" },
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
    /**
     * Who collected the cash for a COD order on delivery (courier = remitted later by the carrier,
     * seller = seller-delivered / store pickup / own rider took cash, platform = own rider took a
     * UPI QR payment to the platform's Razorpay account). paymentStatus still flips to "paid" on delivery.
     */
    codCollection: {
      by: { type: String, enum: ["courier", "seller", "platform", null], default: null },
      /** platform (UPI QR) only: the Razorpay payment id. */
      paymentId: { type: String, default: "" },
      carrier: { type: String, default: "" },
      amount: { type: Number, default: 0 },
      at: { type: Date, default: null },
      remittedAt: { type: Date, default: null },
      remittanceReference: { type: String, default: "" },
    },
    /** Every cancel records who did it and whose fault it was. */
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, enum: [...ORDER_CANCELLED_BY, null], default: null },
    cancelCause: { type: String, enum: [...ORDER_CANCEL_CAUSES, null], default: null },
    /** Machine reason, e.g. seller_timeout, payment_timeout, buyer_request, seller_cancel. */
    cancelReason: { type: String, default: "" },
    /** Phase 6: seller deadline reminders already sent (SELLER_DEADLINE_SOON). */
    slaWarnings: {
      confirmAt: { type: Date, default: null },
      shipAt: { type: Date, default: null },
    },
    /** Item-level return requests (history). `returnRequest` mirrors the latest one. */
    returns: { type: [returnSchema], default: [] },
    returnRequest: {
      status: { type: String, enum: [...RETURN_STATUSES, null], default: null },
      reason: { type: String, default: "" },
      note: { type: String, default: "" },
      requestedAt: Date,
      decidedAt: Date,
      receivedAt: Date,
      decisionNote: { type: String, default: "" },
      /** _id of the order.returns[] record this mirrors. */
      returnId: { type: mongoose.Schema.Types.ObjectId, default: null },
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
    /**
     * Seller payout bookkeeping (p4-payouts): when this order went on the seller ledger, how
     * (`basis`), when it became final (held entries released), and its Razorpay Route transfer.
     */
    payout: {
      recordedAt: { type: Date, default: null },
      basis: { type: String, enum: ["online", "cod_courier", "cod_seller", "cod_platform", "credit", null], default: null },
      finalAt: { type: Date, default: null },
      transferId: { type: String, default: "" },
      /** pending (call in flight) | held | released | reversed (fully) | failed */
      transferStatus: { type: String, default: "" },
      transferAmountPaise: { type: Number, default: 0 },
      reversedPaise: { type: Number, default: 0 },
      reversals: {
        type: [
          {
            _id: false,
            key: String,
            amountPaise: Number,
            status: { type: String, enum: ["pending", "processed", "failed"], default: "pending" },
            reversalId: { type: String, default: "" },
            at: { type: Date, default: Date.now },
          },
        ],
        default: [],
      },
      releasedAt: { type: Date, default: null },
      payoutId: { type: mongoose.Schema.Types.ObjectId, ref: "Payout", default: null },
      lastError: { type: String, default: "" },
    },
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
orderSchema.index({ "returns.status": 1 });
orderSchema.index({ "returns.status": 1, "returns.decideBy": 1 });
orderSchema.index({ "payout.recordedAt": 1, "payout.finalAt": 1, status: 1 });
orderSchema.index({ "payout.transferId": 1 }, { partialFilterExpression: { "payout.transferId": { $type: "string", $gt: "" } } });

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
