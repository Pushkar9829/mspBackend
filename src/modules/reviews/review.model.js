import mongoose from "mongoose";

export const REVIEW_STATUSES = ["published", "hidden"];

const reviewSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    authorName: { type: String, default: "" },
    rating: { type: Number, required: true, min: 1, max: 5 },
    body: { type: String, default: "", maxlength: 1000 },
    verifiedPurchase: { type: Boolean, default: false },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    status: { type: String, enum: REVIEW_STATUSES, default: "published" },
    moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    moderatedAt: { type: Date, default: null },
    moderationNote: { type: String, default: "" },
  },
  { timestamps: true }
);

reviewSchema.index({ productId: 1, userId: 1 }, { unique: true });
reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ productId: 1, createdAt: -1 });
reviewSchema.index({ tenantId: 1, createdAt: -1 });

export const Review = mongoose.model("Review", reviewSchema);
