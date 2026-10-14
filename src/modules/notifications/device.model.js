import mongoose from "mongoose";

/**
 * Phase 6: a mobile device's FCM registration token (buyer or rider app). One row per token; a
 * token re-registered by another user moves to that user (shared phone / re-login). Tokens FCM
 * reports as invalid are deleted (push.js prune).
 */
const deviceTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["android", "ios"], required: true },
    app: { type: String, enum: ["buyer", "rider"], required: true },
    appVersion: { type: String, default: "" },
    lastSeenAt: { type: Date, default: Date.now },
    lastPushAt: { type: Date, default: null },
    failures: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
  },
  { timestamps: true }
);

export const DeviceToken = mongoose.models.DeviceToken || mongoose.model("DeviceToken", deviceTokenSchema);

/** Devices kept per user (oldest pruned on register). */
export const MAX_DEVICES_PER_USER = 10;
