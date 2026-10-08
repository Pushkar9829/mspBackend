import mongoose from "mongoose";

/**
 * One document per login (device/browser). The refresh token carries `sid` = _id.
 * Rotation: each refresh atomically swaps `tokenHash` and remembers the previous hash for a short
 * grace window (concurrent tabs). Presenting any other (older) token of the session = reuse →
 * the whole session is revoked.
 */
const refreshSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    tokenHash: { type: String, required: true },
    prevTokenHash: { type: String, default: "" },
    rotatedAt: { type: Date, default: null },
    tokenVersion: { type: Number, default: 0 },
    client: { type: String, enum: ["web", "mobile"], default: "web" },
    userAgent: { type: String, default: "" },
    ip: { type: String, default: "" },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

refreshSessionSchema.index({ userId: 1, revokedAt: 1 });
refreshSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshSession = mongoose.model("RefreshSession", refreshSessionSchema);
