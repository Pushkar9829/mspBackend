import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["percent", "fixed"], required: true },
    value: { type: Number, required: true },
    minCartValue: { type: Number, default: 0 },
    maxRedemptions: { type: Number, default: null },
    redemptionCount: { type: Number, default: 0 },
    perCustomerLimit: { type: Number, default: 1 },
    excludedProductIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Product" }],
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
  },
  { timestamps: true }
);

couponSchema.index({ tenantId: 1, code: 1 }, { unique: true });

export const Coupon = mongoose.model("Coupon", couponSchema);
