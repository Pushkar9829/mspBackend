import mongoose from "mongoose";

const searchTermSchema = new mongoose.Schema(
  {
    term: { type: String, required: true, unique: true, lowercase: true, trim: true },
    display: { type: String, required: true, trim: true },
    count: { type: Number, default: 0, index: true },
    lastSearchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

searchTermSchema.index({ count: -1, lastSearchedAt: -1 });

export const SearchTerm = mongoose.model("SearchTerm", searchTermSchema);
