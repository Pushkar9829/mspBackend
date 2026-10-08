import mongoose from "mongoose";

/** Guest carts (with or without items) are deleted this long after their last change. */
export const GUEST_CART_TTL_DAYS = 30;

const cartItemSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    qty: { type: Number, required: true, min: 1 },
    /** Bulk lines get MOQ/pack/max rules and slab prices; the same variant can also sit in a regular line. */
    bulk: { type: Boolean, default: false },
    fulfillmentMode: { type: String, enum: ["store_pickup", "delivery_partner"], default: "delivery_partner" },
    /** The StockReservation this line owns (owner = { type: "cart", id: line _id }). */
    reservationId: { type: mongoose.Schema.Types.ObjectId, ref: "StockReservation", default: null },
    /** Display copies of the hold (the reservation document is the source of truth). */
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    reservedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const cartSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    guestKey: { type: String, default: "" },
    items: [cartItemSchema],
    couponCode: { type: String, default: "" },
    /** Only set on guest carts; a TTL index removes abandoned guest carts. */
    expiresAt: { type: Date, default: null },
  },
  // optimisticConcurrency: every save bumps __v; checkout claims the cart by its __v.
  { timestamps: true, optimisticConcurrency: true }
);

cartSchema.pre("save", function setGuestExpiry() {
  if (!this.userId) {
    this.expiresAt = new Date(Date.now() + GUEST_CART_TTL_DAYS * 24 * 60 * 60 * 1000);
  } else if (this.expiresAt) {
    this.expiresAt = null;
  }
});

cartSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } }
);
cartSchema.index(
  { guestKey: 1 },
  { unique: true, partialFilterExpression: { guestKey: { $type: "string", $gt: "" } } }
);
cartSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "guest_cart_ttl" });

export const Cart = mongoose.model("Cart", cartSchema);
