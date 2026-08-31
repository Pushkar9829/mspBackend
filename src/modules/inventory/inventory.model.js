import mongoose from "mongoose";

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
    lastLowStockAlertAt: { type: Date, default: null },
  },
  { timestamps: true }
);

inventorySchema.index({ tenantId: 1, warehouseId: 1, variantId: 1 }, { unique: true });
inventorySchema.index({ variantId: 1, available: 1 });

export const Inventory = mongoose.model("Inventory", inventorySchema);
