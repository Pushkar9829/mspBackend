import mongoose from "mongoose";

const mediaSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    key: { type: String, required: true },
    url: { type: String, required: true },
    filename: { type: String, default: "" },
    mimeType: { type: String, default: "" },
    size: { type: Number, default: 0 },
    folder: { type: String, default: "general" },
    tags: [{ type: String }],
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

mediaSchema.index({ tenantId: 1, folder: 1 });

export const Media = mongoose.model("Media", mediaSchema);
