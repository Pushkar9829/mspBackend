import mongoose from "mongoose";

/**
 * Back-in-stock subscription.
 * - Logged-in subscriptions: `userId` set, `email` "" and `confirmed` true.
 * - Guest subscriptions: `email` set, `userId` null, `confirmed` false until the emailed
 *   double-opt-in token is redeemed.
 * `variantId` null = notify when any variant of the product comes back.
 */
const restockAlertSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    email: { type: String, default: "", lowercase: true, trim: true },
    confirmed: { type: Boolean, default: false },
    confirmTokenHash: { type: String, default: null },
    confirmSentAt: { type: Date, default: null },
    notifiedAt: { type: Date, default: null },
    /** TTL: unconfirmed requests expire after 2 days, notified ones after 90 days. */
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

restockAlertSchema.index(
  { productId: 1, variantId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } }
);
restockAlertSchema.index(
  { productId: 1, variantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $gt: "" } } }
);
restockAlertSchema.index({ productId: 1, notifiedAt: 1, confirmed: 1 });
restockAlertSchema.index({ confirmTokenHash: 1 }, { partialFilterExpression: { confirmTokenHash: { $type: "string" } } });
restockAlertSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RestockAlert = mongoose.model("RestockAlert", restockAlertSchema);
