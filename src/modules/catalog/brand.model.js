import mongoose from "mongoose";
import { trackCatalogChanges } from "../search/catalogVersion.js";

const brandSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true },
    logo: { type: String, default: "" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true }
);

brandSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
brandSchema.index({ status: 1, name: 1 });

trackCatalogChanges(brandSchema);

export const Brand = mongoose.model("Brand", brandSchema);
