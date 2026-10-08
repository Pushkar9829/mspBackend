import mongoose from "mongoose";

/**
 * Per-warehouse stock row. `available` is sellable stock. `reserved` / `committed` are a fast
 * aggregate of StockReservation documents (held / committed) and are only ever changed together
 * with a reservation status flip (see service.js). `isLow` is kept in sync by every counter
 * update so low-stock queries can use an index instead of `$expr`.
 */
const inventorySchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true, index: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true, index: true },
    sku: { type: String, required: true },
    available: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    committed: { type: Number, default: 0, min: 0 },
    damaged: { type: Number, default: 0, min: 0 },
    incoming: { type: Number, default: 0, min: 0 },
    lowStockThreshold: { type: Number, default: 0 },
    /** available <= lowStockThreshold (threshold > 0) or available === 0. */
    isLow: { type: Boolean, default: false },
    lastLowStockAlertAt: { type: Date, default: null },
    /** Set when the variant is deleted; archived rows are never picked for new reservations. */
    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

inventorySchema.index({ tenantId: 1, warehouseId: 1, variantId: 1 }, { unique: true });
inventorySchema.index({ variantId: 1, available: 1 });
inventorySchema.index(
  { tenantId: 1, lastLowStockAlertAt: 1 },
  { partialFilterExpression: { isLow: true }, name: "low_stock_rows" }
);

export const Inventory = mongoose.model("Inventory", inventorySchema);
