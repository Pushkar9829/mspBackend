import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    audience: {
      type: { type: String, enum: ["user", "tenant", "role", "all"], default: "user" },
      roleSlug: { type: String, default: "" },
    },
    event: { type: String, required: true, index: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    priority: { type: String, enum: ["low", "normal", "high"], default: "normal" },
    scheduledAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ scheduledAt: 1, readAt: 1 });

export const Notification = mongoose.model("Notification", notificationSchema);
