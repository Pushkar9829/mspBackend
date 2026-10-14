import mongoose from "mongoose";

/**
 * Platform admin acting inside a store (X-Tenant-Id / ?tenantId=): one row per cross-tenant write
 * and (de-duplicated) read. No TTL: this is the seller-visible long-term access record
 * (GET /tenants/me/access-log).
 */
const adminAccessLogSchema = new mongoose.Schema(
  {
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    adminName: { type: String, default: "" },
    adminEmail: { type: String, default: "" },
    kind: { type: String, enum: ["read", "write"], required: true },
    method: { type: String, default: "GET" },
    path: { type: String, default: "" },
    reason: { type: String, default: "" },
    statusCode: { type: Number, default: null },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    requestId: { type: String, default: "" },
    /** Set on the write that triggered the (debounced) store-admin notification. */
    notifiedAt: { type: Date, default: null },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

adminAccessLogSchema.index({ tenantId: 1, at: -1 });
adminAccessLogSchema.index({ tenantId: 1, adminId: 1, notifiedAt: -1 }, { partialFilterExpression: { notifiedAt: { $type: "date" } } });

export const AdminAccessLog = mongoose.models.AdminAccessLog || mongoose.model("AdminAccessLog", adminAccessLogSchema);
