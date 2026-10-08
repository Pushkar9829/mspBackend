import mongoose from "mongoose";
import { INVENTORY_REASONS } from "../../config/constants.js";

/** Reasons beyond the shared list: shipping consumes committed units, returns restore them. */
export const STOCK_TX_REASONS = [
  ...new Set([...INVENTORY_REASONS, "consume", "restore", "set", "archive", "reown"]),
];

const txSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true, index: true },
    sku: { type: String, required: true },
    reason: { type: String, enum: STOCK_TX_REASONS, required: true },
    qty: { type: Number, required: true },
    availableAfter: { type: Number, required: true },
    reservedAfter: { type: Number, default: 0 },
    committedAfter: { type: Number, default: 0 },
    damagedAfter: { type: Number, default: 0 },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reservationId: { type: mongoose.Schema.Types.ObjectId, ref: "StockReservation", default: null },
    reference: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { timestamps: true }
);

txSchema.index({ tenantId: 1, createdAt: -1 });

export const InventoryTransaction = mongoose.model("InventoryTransaction", txSchema);
