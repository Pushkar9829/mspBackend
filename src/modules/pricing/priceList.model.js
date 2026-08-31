import mongoose from "mongoose";

const priceListSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    isDefault: { type: Boolean, default: false },
    status: { type: String, enum: ["draft", "active", "inactive", "pending_approval"], default: "active" },
    items: [
      {
        variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", required: true },
        unitPrice: { type: Number, required: true },
      },
    ],
  },
  { timestamps: true }
);

priceListSchema.index({ tenantId: 1, name: 1 });

export const PriceList = mongoose.model("PriceList", priceListSchema);
