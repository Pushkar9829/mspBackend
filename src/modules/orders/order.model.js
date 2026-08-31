import mongoose from "mongoose";
import { ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES } from "../../config/constants.js";

const orderItemSchema = new mongoose.Schema({
  tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    sku: String,
    name: String,
    image: String,
    slug: String,
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
  qty: Number,
  listPrice: Number,
  unitPrice: Number,
  lineSubtotal: Number,
  taxRate: Number,
  tax: Number,
  lineTotal: Number,
  warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse" },
  breakdown: { type: mongoose.Schema.Types.Mixed, default: [] },
});

const orderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ORDER_STATUSES, default: "pending", index: true },
    items: [orderItemSchema],
    addressSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    couponCode: { type: String, default: "" },
    couponDiscount: { type: Number, default: 0 },
    subtotal: { type: Number, required: true },
    tax: { type: Number, required: true },
    deliveryFee: { type: Number, default: 0 },
    total: { type: Number, required: true },
    paymentMethod: { type: String, enum: PAYMENT_METHODS, default: "purchase_order" },
    paymentStatus: { type: String, enum: PAYMENT_STATUSES, default: "unpaid" },
    poNumber: { type: String, default: "" },
    buyerNotes: { type: String, default: "" },
    sellerNotes: { type: String, default: "" },
    idempotencyKey: { type: String, default: "", index: true },
    etaFrom: Date,
    etaTo: Date,
    statusHistory: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        note: String,
      },
    ],
    fulfillments: [
      {
        carrier: String,
        trackingNumber: String,
        shippedAt: Date,
      },
    ],
  },
  { timestamps: true }
);

orderSchema.index({ tenantId: 1, createdAt: -1 });
orderSchema.index({ buyerId: 1, createdAt: -1 });
orderSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, sparse: true }
);

export const Order = mongoose.model("Order", orderSchema);
