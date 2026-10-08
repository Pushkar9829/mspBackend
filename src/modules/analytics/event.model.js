import mongoose from "mongoose";

/** Raw events are kept for ANALYTICS_RETENTION_DAYS (default 180); AnalyticsDaily rollups are kept forever. */
export const ANALYTICS_RETENTION_DAYS = Math.max(1, Number(process.env.ANALYTICS_RETENTION_DAYS) || 180);

const analyticsEventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    category: { type: String, default: "account" },
    importance: {
      type: String,
      enum: ["critical", "high", "normal", "low"],
      default: "normal",
    },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resource: { type: String, default: "" },
    resourceId: { type: mongoose.Schema.Types.Mixed, default: null },
    amount: { type: Number, default: 0 },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestId: { type: String, default: "" },
    /** Business-timezone (IST) day key, YYYY-MM-DD. */
    day: { type: String, required: true },
    occurredAt: { type: Date, required: true },
  },
  { timestamps: false }
);

// Only the indexes the analytics queries use (all filter on an occurredAt range, sort occurredAt desc):
//  - platform feed / overview           → occurredAt (also the retention TTL)
//  - tenant-scoped feed / overview      → tenantId + occurredAt
//  - event filter (platform)            → event + occurredAt
//  - important feed (platform)          → importance + occurredAt
analyticsEventSchema.index(
  { occurredAt: 1 },
  { name: "occurredAt_ttl", expireAfterSeconds: ANALYTICS_RETENTION_DAYS * 86400 }
);
analyticsEventSchema.index({ tenantId: 1, occurredAt: -1 });
analyticsEventSchema.index({ event: 1, occurredAt: -1 });
analyticsEventSchema.index({ importance: 1, occurredAt: -1 });

export const AnalyticsEvent = mongoose.model("AnalyticsEvent", analyticsEventSchema);
