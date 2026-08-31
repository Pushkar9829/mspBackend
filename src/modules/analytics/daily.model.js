import mongoose from "mongoose";

const analyticsDailySchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    event: { type: String, required: true },
    category: { type: String, default: "" },
    count: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

analyticsDailySchema.index({ day: 1, tenantId: 1, event: 1 }, { unique: true });
analyticsDailySchema.index({ day: 1, event: 1 });
analyticsDailySchema.index({ tenantId: 1, day: 1 });

export const AnalyticsDaily = mongoose.model("AnalyticsDaily", analyticsDailySchema);
