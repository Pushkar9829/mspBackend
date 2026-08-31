import mongoose from "mongoose";
import { USER_STATUSES } from "../../config/constants.js";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "", trim: true },
    passwordHash: { type: String, required: true, select: false },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role", required: true, index: true },
    status: { type: String, enum: USER_STATUSES, default: "pending", index: true },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    refreshTokenHash: { type: String, default: "", select: false },
    passwordResetTokenHash: { type: String, default: "", select: false },
    passwordResetExpires: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    profile: {
      company: { type: String, default: "" },
      preferredSizes: [{ type: String }],
      location: {
        city: String,
        state: String,
        postalCode: String,
        country: { type: String, default: "IN" },
        latitude: Number,
        longitude: Number,
      },
    },
  },
  { timestamps: true }
);

userSchema.index({ tenantId: 1, email: 1 });
userSchema.index({ tenantId: 1, status: 1 });

export const User = mongoose.model("User", userSchema);
