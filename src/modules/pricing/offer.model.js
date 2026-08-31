import mongoose from "mongoose";

const offerSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["percent", "fixed", "flash"], default: "percent" },
    value: { type: Number, required: true },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
    categoryIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Category" }],
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    inventoryCap: { type: Number, default: null },
    inventoryUsed: { type: Number, default: 0 },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    status: { type: String, enum: ["draft", "active", "inactive", "pending_approval"], default: "draft" },
  },
  { timestamps: true }
);

offerSchema.index({ tenantId: 1, status: 1, startsAt: 1, endsAt: 1 });

export const Offer = mongoose.model("Offer", offerSchema);
