import mongoose from "mongoose";

const couponUsageSchema = new mongoose.Schema(
  {
    /** Tenant of the coupon (and of the order it was redeemed on). */
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  },
  { timestamps: true }
);

couponUsageSchema.index({ couponId: 1, userId: 1 });
couponUsageSchema.index({ orderId: 1 });
couponUsageSchema.index(
  { couponId: 1, orderId: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: "objectId" } } }
);

export const CouponUsage = mongoose.model("CouponUsage", couponUsageSchema);

/**
 * Per-customer redemption counter. Checkout bumps it with a guarded upsert inside the order
 * transaction ({ count: { $lt: limit } } + unique key), so two parallel checkouts cannot both
 * pass a per-customer limit of 1.
 */
const couponCustomerUseSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    couponId: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);
couponCustomerUseSchema.index({ couponId: 1, userId: 1 }, { unique: true });

export const CouponCustomerUse = mongoose.model("CouponCustomerUse", couponCustomerUseSchema);
