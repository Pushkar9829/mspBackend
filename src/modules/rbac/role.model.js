import mongoose from "mongoose";

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    permissions: [{ type: String }],
    isSystem: { type: Boolean, default: false },
    scope: { type: String, enum: ["platform", "tenant"], default: "tenant" },
    description: { type: String, default: "" },
  },
  { timestamps: true }
);

roleSchema.index({ slug: 1, tenantId: 1 }, { unique: true });

export const Role = mongoose.model("Role", roleSchema);
