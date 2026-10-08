import mongoose from "mongoose";

/**
 * Keyed by (userId, productId). `slug` is the product's public slug, kept for display/links;
 * `snapshot` is built server-side from the DB (never from client input).
 * Legacy rows (pre-migration) only have `slug` (= lower-cased SKU); ensureProductSlugs() migrates them.
 */
const wishlistSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
    variantId: { type: mongoose.Schema.Types.ObjectId, ref: "ProductVariant", default: null },
    slug: { type: String, required: true, trim: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

wishlistSchema.index(
  { userId: 1, productId: 1 },
  { unique: true, partialFilterExpression: { productId: { $type: "objectId" } } }
);
wishlistSchema.index({ userId: 1, slug: 1 });
wishlistSchema.index({ userId: 1, updatedAt: -1 });

export const WishlistItem = mongoose.model("WishlistItem", wishlistSchema);
