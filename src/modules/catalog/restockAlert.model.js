import mongoose from "mongoose";

const restockAlertSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    email: { type: String, default: "", lowercase: true, trim: true },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

restockAlertSchema.index({ productId: 1, userId: 1, email: 1 });

export const RestockAlert = mongoose.model("RestockAlert", restockAlertSchema);
