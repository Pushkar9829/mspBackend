import mongoose from "mongoose";

const searchTermSchema = new mongoose.Schema(
  {
    term: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 80 },
    display: { type: String, required: true, trim: true, maxlength: 80 },
    count: { type: Number, default: 0 },
    lastSearchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

searchTermSchema.index({ count: -1, lastSearchedAt: -1 });

export const SearchTerm = mongoose.model("SearchTerm", searchTermSchema);
