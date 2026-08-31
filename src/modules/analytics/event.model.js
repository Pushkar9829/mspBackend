import mongoose from "mongoose";

const analyticsEventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, index: true },
    category: { type: String, default: "account", index: true },
    importance: {
      type: String,
      enum: ["critical", "high", "normal", "low"],
      default: "normal",
      index: true,
    },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resource: { type: String, default: "" },
    resourceId: { type: mongoose.Schema.Types.Mixed, default: null },
    amount: { type: Number, default: 0 },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestId: { type: String, default: "" },
    day: { type: String, required: true, index: true },
    occurredAt: { type: Date, required: true, index: true },
  },
  { timestamps: false }
);

analyticsEventSchema.index({ occurredAt: -1 });
analyticsEventSchema.index({ event: 1, occurredAt: -1 });
analyticsEventSchema.index({ tenantId: 1, occurredAt: -1 });
analyticsEventSchema.index({ tenantId: 1, event: 1, occurredAt: -1 });
analyticsEventSchema.index({ importance: 1, occurredAt: -1 });
analyticsEventSchema.index({ day: 1, event: 1 });
analyticsEventSchema.index({ day: 1, tenantId: 1, event: 1 });

export const AnalyticsEvent = mongoose.model("AnalyticsEvent", analyticsEventSchema);
