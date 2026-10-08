import mongoose from "mongoose";
import { customAlphabet } from "nanoid";
import { FULFILLMENT_MODES, PRODUCT_STATUSES } from "../../config/constants.js";
import { slugify } from "../../utils/slug.js";
import { trackCatalogChanges } from "../search/catalogVersion.js";

const shortId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 6);

/** Globally unique, URL-safe product slug: `<name>-<6 random chars>`. Stable once assigned. */
export function buildProductSlug(name) {
  const base = slugify(name).slice(0, 60).replace(/-+$/g, "") || "product";
  return `${base}-${shortId()}`;
}

const productSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    name: { type: String, required: true, trim: true },
    /** Public, globally unique identifier for storefront URLs. Never changes on rename. */
    slug: { type: String, trim: true, lowercase: true },
    sku: { type: String, required: true, trim: true, uppercase: true },
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
    hsn: { type: String, default: "", trim: true },
    status: { type: String, enum: PRODUCT_STATUSES, default: "draft" },
    enabled: { type: Boolean, default: true },
    scheduledAt: { type: Date, default: null },
    /** Who scheduled the publish; the scheduler re-checks that this user still holds products.publish. */
    scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** Why the last scheduled publish was not carried out (e.g. permission revoked). */
    scheduleError: { type: String, default: "" },
    /** Scheduler claim (atomic, so concurrent runners publish a product once). */
    scheduleClaimedAt: { type: Date, default: null },
    easyReturn: { type: Boolean, default: false },
    deliveryModes: {
      type: [{ type: String, enum: FULFILLMENT_MODES }],
      default: () => ["delivery_partner"],
    },
    wholesale: {
      /** When true, product appears on /bulk and wholesale rules (MOQ/max/slabs) apply in checkout. */
      bulkEligible: { type: Boolean, default: false },
      moq: { type: Number, default: 1 },
      maxQty: { type: Number, default: null },
      packMultiple: { type: Number, default: 1 },
      caseQty: { type: Number, default: 1 },
      leadTimeDays: { type: Number, default: 0 },
    },
    /** Cached review aggregate over published reviews (recomputed by reviews/service.js). */
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

productSchema.pre("validate", function assignSlug(next) {
  if (!this.slug) this.slug = buildProductSlug(this.name);
  next();
});

productSchema.index({ tenantId: 1, sku: 1 }, { unique: true });
productSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: "string" } } });
productSchema.index({ tenantId: 1, createdAt: -1 });
productSchema.index({ tenantId: 1, status: 1 });
productSchema.index({ status: 1, enabled: 1, createdAt: -1 });
productSchema.index({ status: 1, categoryId: 1, createdAt: -1 });
productSchema.index({ status: 1, scheduledAt: 1 }, { partialFilterExpression: { status: "scheduled" } });
productSchema.index({ name: "text", description: "text", sku: "text", tags: "text" });

// Search term dictionary (fuzzy / "did you mean") rebuilds when the catalog changes.
trackCatalogChanges(productSchema);

export const Product = mongoose.model("Product", productSchema);
