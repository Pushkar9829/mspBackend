import mongoose from "mongoose";

const searchHistorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    guestKey: { type: String, default: "", index: true },
    term: { type: String, required: true, lowercase: true, trim: true },
    display: { type: String, required: true, trim: true },
    searchedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

searchHistorySchema.index({ userId: 1, searchedAt: -1 });
searchHistorySchema.index({ guestKey: 1, searchedAt: -1 });
searchHistorySchema.index({ userId: 1, term: 1 });
searchHistorySchema.index({ guestKey: 1, term: 1 });

export const SearchHistory = mongoose.model("SearchHistory", searchHistorySchema);
