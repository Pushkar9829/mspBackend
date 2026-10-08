import mongoose from "mongoose";

/**
 * Folders a client may upload into. Never build a filesystem path from anything else.
 * "products" is used by the demo seed (seeds/demo.js) for product gallery images.
 */
export const MEDIA_FOLDERS = ["catalog", "products", "brands", "categories", "cms", "avatars"];

const mediaSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    key: { type: String, required: true },
    url: { type: String, required: true },
    filename: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    size: { type: Number, default: 0 },
    folder: { type: String, enum: MEDIA_FOLDERS, default: "catalog" },
    tags: [{ type: String }],
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

mediaSchema.index({ tenantId: 1, key: 1 }, { unique: true });
mediaSchema.index({ tenantId: 1, folder: 1, createdAt: -1 });
mediaSchema.index({ tenantId: 1, createdAt: -1 });

export const Media = mongoose.model("Media", mediaSchema);
