import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null, index: true },
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

export const Category = mongoose.model("Category", categorySchema);
