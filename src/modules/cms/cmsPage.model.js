import mongoose from "mongoose";
import { CMS_STATUSES } from "../../config/constants.js";

export const CMS_PAGE_TYPES = ["home", "landing", "faq", "policy", "terms", "privacy", "shipping", "custom"];

const cmsPageSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    slug: { type: String, required: true, lowercase: true },
    title: { type: String, required: true },
    type: { type: String, enum: CMS_PAGE_TYPES, default: "custom" },
    status: { type: String, enum: CMS_STATUSES, default: "draft" },
    sections: [{ type: mongoose.Schema.Types.Mixed }],
    seo: {
      title: String,
      description: String,
      canonical: String,
    },
    scheduledAt: { type: Date, default: null },
    /** Who scheduled the publish; re-checked for cms.publish when the schedule fires. */
    scheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** Why the last scheduled publish was rejected (empty when none). */
    scheduleError: { type: String, default: "" },
    publishedAt: { type: Date, default: null },
    /** Incremented on each edit; snapshots live in CmsPageVersion (last 20 kept). */
    version: { type: Number, default: 0 },
    /**
     * Seeded pages only: hash of the content ({ title, sections }) the seed last wrote, and which
     * seed wrote it ("defaults" | "demo"). A page whose current content still hashes to seedHash
     * was not edited, so a newer seed may update it; edited pages are never overwritten.
     */
    seedHash: { type: String, default: null },
    seedSource: { type: String, default: null },
  },
  { timestamps: true }
);

cmsPageSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
cmsPageSchema.index({ tenantId: 1, updatedAt: -1 });
cmsPageSchema.index({ status: 1, tenantId: 1, slug: 1 });
cmsPageSchema.index({ scheduledAt: 1 }, { partialFilterExpression: { scheduledAt: { $type: "date" } } });

export const CmsPage = mongoose.model("CmsPage", cmsPageSchema);
