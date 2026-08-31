import mongoose from "mongoose";

const brandSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true },
    logo: { type: String, default: "" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

brandSchema.index({ tenantId: 1, slug: 1 }, { unique: true });

export const Brand = mongoose.model("Brand", brandSchema);
