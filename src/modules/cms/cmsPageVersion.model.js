import mongoose from "mongoose";

export const MAX_CMS_VERSIONS = 20;

/** Snapshot of a CMS page before an edit. Only the latest MAX_CMS_VERSIONS per page are kept. */
const cmsPageVersionSchema = new mongoose.Schema(
  {
    pageId: { type: mongoose.Schema.Types.ObjectId, ref: "CmsPage", required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    version: { type: Number, default: 0 },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** edit | schedule | unschedule | review | publish | unpublish | draft */
    action: { type: String, default: "edit" },
    toStatus: { type: String, default: null },
    scheduledAt: { type: Date, default: null },
    scheduled: { type: Boolean, default: false },
    at: { type: Date, default: Date.now },
    snapshot: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: false }
);

cmsPageVersionSchema.index({ pageId: 1, at: -1 });

export const CmsPageVersion = mongoose.model("CmsPageVersion", cmsPageVersionSchema);
