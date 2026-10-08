import mongoose from "mongoose";

/** Per-user read receipt for broadcast notifications (audience tenant/staff/role/all). */
const notificationReadSchema = new mongoose.Schema(
  {
    notificationId: { type: mongoose.Schema.Types.ObjectId, ref: "Notification", required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    readAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);

notificationReadSchema.index({ userId: 1, notificationId: 1 }, { unique: true });
notificationReadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const NotificationRead = mongoose.model("NotificationRead", notificationReadSchema);
