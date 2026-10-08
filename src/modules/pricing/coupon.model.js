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
    appliesTo: { type: String, enum: ["all", "regular", "bulk"], default: "all" },
    /** Only for a buyer's first order with this store. */
    firstOrderOnly: { type: Boolean, default: false },
    /** "public" coupons are listed to buyers (GET /cart/coupons); "private" codes are only applied when typed. */
    visibility: { type: String, enum: ["public", "private"], default: "public" },
    /** Non-empty = only these buyers may use it (and only they see it in the listing). */
    customerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    /** Optional buyer-facing text shown in the coupon listing. */
    description: { type: String, default: "" },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
  },
  { timestamps: true }
);

couponSchema.index({ tenantId: 1, code: 1 }, { unique: true });

export const Coupon = mongoose.model("Coupon", couponSchema);
