import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: ["platform", "tenant"], default: "platform" },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    key: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

settingsSchema.index({ scope: 1, tenantId: 1, key: 1 }, { unique: true });

export const Settings = mongoose.model("Settings", settingsSchema);
