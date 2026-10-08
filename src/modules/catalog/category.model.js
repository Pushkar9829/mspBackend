import mongoose from "mongoose";
import { trackCatalogChanges } from "../search/catalogVersion.js";

const categorySchema = new mongoose.Schema(
  {
    /** null = shared platform category (super-admin only); set = a store's own category. */
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    sortOrder: { type: Number, default: 0 },
    image: { type: String, default: "" },
    icon: { type: String, default: "" },
    seo: {
      title: { type: String, default: "" },
      description: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

categorySchema.index({ parentId: 1, sortOrder: 1 });
categorySchema.index({ tenantId: 1, sortOrder: 1 });

trackCatalogChanges(categorySchema);

export const Category = mongoose.model("Category", categorySchema);
