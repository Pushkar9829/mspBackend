import mongoose from "mongoose";

/** Outbox of failed durable event listeners (see utils/events.js `onDurable`). */
const eventFailureSchema = new mongoose.Schema(
  {
    event: { type: String, required: true },
    listener: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    error: { type: String, default: "" },
    attempts: { type: Number, default: 1 },
    status: { type: String, enum: ["pending", "processing", "done", "dead"], default: "pending" },
    nextAttemptAt: { type: Date, default: Date.now },
    claimedAt: { type: Date, default: null },
    doneAt: { type: Date, default: null },
  },
  { timestamps: true }
);

eventFailureSchema.index({ status: 1, nextAttemptAt: 1 });
// Keep the outbox small: everything older than 30 days is removed.
eventFailureSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 });

export const EventFailure = mongoose.model("EventFailure", eventFailureSchema);
