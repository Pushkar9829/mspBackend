import mongoose from "mongoose";

const searchHistorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    guestKey: { type: String, default: "" },
    term: { type: String, required: true, lowercase: true, trim: true },
    display: { type: String, required: true, trim: true },
    searchedAt: { type: Date, default: Date.now },
    /** Guest rows expire (TTL); signed-in history has expiresAt null and is trimmed to the latest N. */
    expiresAt: { type: Date, default: null },
  },
  { timestamps: false }
);

searchHistorySchema.index({ userId: 1, searchedAt: -1 });
searchHistorySchema.index({ guestKey: 1, searchedAt: -1 });
searchHistorySchema.index({ userId: 1, term: 1 });
searchHistorySchema.index({ guestKey: 1, term: 1 });
searchHistorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SearchHistory = mongoose.model("SearchHistory", searchHistorySchema);
