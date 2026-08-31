import mongoose from "mongoose";
import { PRODUCT_STATUSES } from "../../config/constants.js";

const productSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    barcode: { type: String, default: "" },
    description: { type: String, default: "" },
    specifications: { type: mongoose.Schema.Types.Mixed, default: {} },
    images: [{ type: String }],
    videos: [{ type: String }],
    documents: [{ type: String }],
    tags: [{ type: String }],
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", index: true },
    brandId: { type: mongoose.Schema.Types.ObjectId, ref: "Brand", index: true },
    taxClass: {
      name: { type: String, default: "GST0" },
      rate: { type: Number, default: 0 },
    },
    status: { type: String, enum: PRODUCT_STATUSES, default: "draft", index: true },
    scheduledAt: { type: Date, default: null },
    wholesale: {
      moq: { type: Number, default: 1 },
      maxQty: { type: Number, default: null },
      packMultiple: { type: Number, default: 1 },
      caseQty: { type: Number, default: 1 },
      leadTimeDays: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

productSchema.index({ tenantId: 1, sku: 1 }, { unique: true });
productSchema.index({ tenantId: 1, status: 1 });
productSchema.index({ name: "text", description: "text", sku: "text", tags: "text" });

export const Product = mongoose.model("Product", productSchema);
