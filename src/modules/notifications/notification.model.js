import mongoose from "mongoose";

export const NOTIFICATION_TTL_DAYS = Math.max(1, Number(process.env.NOTIFICATION_TTL_DAYS) || 90);
export const AUDIENCE_TYPES = ["user", "tenant", "staff", "role", "all"];
export const NOTIFICATION_CATEGORIES = ["order", "chat", "inventory", "marketing", "account"];

export function defaultExpiry(from = new Date()) {
  return new Date(from.getTime() + NOTIFICATION_TTL_DAYS * 86400000);
}

/**
 * One document per *personal* notification (userId set, own readAt), or one document per
 * *broadcast* (userId null; audience tenant/staff/role/all) whose per-user read state lives in
 * NotificationRead. Each user therefore sees exactly one copy of a broadcast.
 */
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    audience: {
      type: { type: String, enum: AUDIENCE_TYPES, default: "user" },
      roleSlug: { type: String, default: "" },
    },
    event: { type: String, required: true },
    category: { type: String, enum: NOTIFICATION_CATEGORIES, default: "account" },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, default: "", maxlength: 4000 },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    priority: { type: String, enum: ["low", "normal", "high"], default: "normal" },
    status: { type: String, enum: ["scheduled", "published", "cancelled"], default: "published" },
    scheduledAt: { type: Date, default: null },
    publishedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: () => defaultExpiry() },
    readAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    /** Extra channels for announcements (sent when the notification is published). */
    channels: {
      email: { type: Boolean, default: false },
    },
    /** Broadcast email progress (channels.email on a broadcast): pending → sending → done | failed. */
    emailDelivery: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

// Inbox, personal branch: { userId } sorted by publishedAt; unread count: { userId, readAt: null }.
notificationSchema.index({ userId: 1, publishedAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
// Inbox, broadcast branches: { audience.type, tenantId[, audience.roleSlug] } sorted by publishedAt.
notificationSchema.index({ "audience.type": 1, tenantId: 1, publishedAt: -1 });
// Scheduler claim.
notificationSchema.index({ status: 1, scheduledAt: 1 }, { partialFilterExpression: { status: "scheduled" } });
// Sent-announcements list for admins.
notificationSchema.index({ createdBy: 1, createdAt: -1 });
// Retention.
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Notification = mongoose.model("Notification", notificationSchema);
