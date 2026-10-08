import mongoose from "mongoose";

/**
 * One owned stock hold. The Inventory row counters (reserved / committed) are only a fast
 * aggregate of these documents; every stock move flips one reservation's status with a
 * conditional update and adjusts the counters by exactly that reservation's qty, in the same
 * transaction. A repeated release/commit therefore matches nothing and is a no-op.
 *
 *   held      -> committed (order confirmed) | released (cart/order dropped) | re-owned cart->order
 *   committed -> consumed (goods shipped)    | restored (cancelled before shipping)
 *   consumed  -> restored (return received back into stock / damaged)
 */
export const RESERVATION_STATUSES = ["held", "committed", "released", "consumed", "restored"];
export const ACTIVE_RESERVATION_STATUSES = ["held", "committed"];

const ownerSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["cart", "order"], required: true },
    /** Cart line id for cart holds, order id for order holds. */
    id: { type: mongoose.Schema.Types.ObjectId, required: true },
    /** Order item id for order holds (an order can carry the same variant twice: bulk + regular). */
    line: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** Cart id for cart holds (lets the expiry job clear the cart line pointer). */
    cartId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: false }
);

const reservationSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
    qty: { type: Number, required: true, min: 1 },
    owner: { type: ownerSchema, required: true },
    status: { type: String, enum: RESERVATION_STATUSES, default: "held", index: true },
    /** Mirrors status in ACTIVE_RESERVATION_STATUSES; partial unique indexes need a plain equality. */
    active: { type: Boolean, default: true },
    /** Cart holds expire; the release job (not a TTL index) releases them so counters stay right. */
    expiresAt: { type: Date, default: null },
    reference: { type: String, default: "" },
    /** For restored returns: units that came back damaged instead of sellable. */
    damagedQty: { type: Number, default: 0 },
    history: [
      {
        _id: false,
        from: String,
        to: String,
        at: { type: Date, default: Date.now },
        note: String,
      },
    ],
  },
  { timestamps: true }
);

reservationSchema.index(
  { "owner.type": 1, "owner.id": 1, "owner.line": 1, variantId: 1, warehouseId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: "one_active_hold_per_owner_line" }
);
reservationSchema.index({ status: 1, expiresAt: 1 });
reservationSchema.index({ "owner.type": 1, "owner.id": 1 });
reservationSchema.index({ tenantId: 1, variantId: 1, warehouseId: 1, status: 1 });

export const StockReservation = mongoose.model("StockReservation", reservationSchema);
