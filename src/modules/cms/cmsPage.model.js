import mongoose from "mongoose";
import { CMS_STATUSES } from "../../config/constants.js";

const cmsPageSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    slug: { type: String, required: true, lowercase: true },
    title: { type: String, required: true },
    type: {
      type: String,
      enum: ["home", "landing", "faq", "policy", "terms", "privacy", "shipping", "custom"],
      default: "custom",
    },
    status: { type: String, enum: CMS_STATUSES, default: "draft", index: true },
    sections: [{ type: mongoose.Schema.Types.Mixed }],
    seo: {
      title: String,
      description: String,
      canonical: String,
    },
    scheduledAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    versions: [
      {
        at: { type: Date, default: Date.now },
        actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        snapshot: { type: mongoose.Schema.Types.Mixed },
      },
    ],
  },
  { timestamps: true }
);

cmsPageSchema.index({ tenantId: 1, slug: 1 }, { unique: true });

export const CmsPage = mongoose.model("CmsPage", cmsPageSchema);
