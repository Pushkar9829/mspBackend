import mongoose from "mongoose";

const channelSchema = new mongoose.Schema(
  {
    inApp: { type: Boolean },
    email: { type: Boolean },
    sms: { type: Boolean },
    push: { type: Boolean },
  },
  { _id: false }
);

/** Per-user channel preferences per category. Missing values fall back to DEFAULT_PREFERENCES. */
const notificationPreferenceSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    categories: {
      order: { type: channelSchema, default: () => ({}) },
      chat: { type: channelSchema, default: () => ({}) },
      inventory: { type: channelSchema, default: () => ({}) },
      marketing: { type: channelSchema, default: () => ({}) },
      account: { type: channelSchema, default: () => ({}) },
    },
  },
  { timestamps: true }
);

export const DEFAULT_PREFERENCES = {
  order: { inApp: true, email: true, sms: true, push: true },
  chat: { inApp: true, email: false, sms: false, push: true },
  inventory: { inApp: true, email: true, sms: false, push: false },
  marketing: { inApp: true, email: true, sms: false, push: false },
  account: { inApp: true, email: true, sms: true, push: true },
};

/** Channels that cannot be switched off (security / legal notices). */
export const LOCKED_CHANNELS = { account: ["email"] };

export const NotificationPreference = mongoose.model("NotificationPreference", notificationPreferenceSchema);
