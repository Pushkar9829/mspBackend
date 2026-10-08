import mongoose from "mongoose";

export const VARIANT_STATUSES = ["active", "inactive", "archived"];

const variantSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    sku: { type: String, required: true, trim: true, uppercase: true },
    barcode: { type: String, default: "" },
    attributes: {
      size: { type: String, default: "" },
      color: { type: String, default: "" },
      grade: { type: String, default: "" },
      material: { type: String, default: "" },
      packSize: { type: String, default: "" },
      unit: { type: String, default: "pc" },
      weight: { type: Number, default: 0 },
      dimensions: {
        l: Number,
        w: Number,
        h: Number,
      },
      /** Seller-defined attributes (flavor, voltage, ...). Keys validated in validators.js. */
      custom: { type: Map, of: String, default: undefined },
    },
    listPrice: { type: Number, required: true, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    tierPrices: [
      {
        minQty: { type: Number, required: true },
        maxQty: { type: Number, default: null },
        unitPrice: { type: Number, required: true },
      },
    ],
    /** "archived" = soft-deleted (kept so historical orders/inventory still resolve). */
    status: { type: String, enum: VARIANT_STATUSES, default: "active" },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

variantSchema.index({ tenantId: 1, sku: 1 }, { unique: true });

export const ProductVariant = mongoose.model("ProductVariant", variantSchema);
