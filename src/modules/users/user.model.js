import mongoose from "mongoose";
import { USER_STATUSES } from "../../config/constants.js";

/**
 * Tenancy model:
 * - Staff (tenant_admin, support_agent, custom tenant roles) have `tenantId` = their store.
 * - Marketplace buyers have `tenantId: null`. The store they signed up through (tenantSlug) is
 *   recorded as `homeTenantId` (storefront affinity only — grants no access to tenant routes).
 * - Platform admins have `tenantId: null` and the system platform role.
 */
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "", trim: true },
    passwordHash: { type: String, required: true, select: false },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    homeTenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
    roleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role", required: true, index: true },
    status: { type: String, enum: USER_STATUSES, default: "pending", index: true },
    /** Bumped to revoke every access/refresh token issued before (logout-all, password/role/status change). */
    tokenVersion: { type: Number, default: 0 },
    failedLoginAttempts: { type: Number, default: 0 },
    lastFailedLoginAt: { type: Date, default: null },
    /** Temporary, per-account login delay. Does not change `status` and does not end existing sessions. */
    lockedUntil: { type: Date, default: null },
    /** Legacy single-session refresh hash (pre RefreshSession). Kept for schema compatibility; unused. */
    refreshTokenHash: { type: String, default: "", select: false },
    passwordResetTokenHash: { type: String, default: "", select: false },
    passwordResetExpires: { type: Date, default: null, select: false },
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    emailVerifyTokenHash: { type: String, default: "", select: false },
    emailVerifyExpires: { type: Date, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    profile: {
      company: { type: String, default: "" },
      gstin: { type: String, default: "" },
      /** kirana | horeca | distributor | institution | other ("" = not given). */
      businessType: { type: String, default: "" },
      addressLine1: { type: String, default: "" },
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
userSchema.index(
  { passwordResetTokenHash: 1 },
  { partialFilterExpression: { passwordResetTokenHash: { $type: "string", $gt: "" } } }
);
userSchema.index(
  { emailVerifyTokenHash: 1 },
  { partialFilterExpression: { emailVerifyTokenHash: { $type: "string", $gt: "" } } }
);

export const User = mongoose.model("User", userSchema);
