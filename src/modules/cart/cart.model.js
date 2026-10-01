import mongoose from "mongoose";

const cartItemSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    qty: { type: Number, required: true, min: 1 },
    /** Bulk lines get MOQ/pack/max rules and slab prices; the same variant can also sit in a regular line. */
    bulk: { type: Boolean, default: false },
    fulfillmentMode: { type: String, enum: ["store_pickup", "delivery_partner"], default: "delivery_partner" },
  },
  { _id: true }
);

const cartSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    guestKey: { type: String, default: "", index: true },
    items: [cartItemSchema],
    couponCode: { type: String, default: "" },
  },
  { timestamps: true }
);

export const Cart = mongoose.model("Cart", cartSchema);
