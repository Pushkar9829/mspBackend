import mongoose from "mongoose";

const variantSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    sku: { type: String, required: true, trim: true },
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
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

variantSchema.index({ tenantId: 1, sku: 1 }, { unique: true });

export const ProductVariant = mongoose.model("ProductVariant", variantSchema);
