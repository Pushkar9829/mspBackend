import mongoose from "mongoose";

const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: "Tenant", default: null },
    action: { type: String, required: true },
    resource: { type: String, required: true },
    resourceId: { type: mongoose.Schema.Types.Mixed, default: null },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    requestId: { type: String, default: "" },
    /** success | failure (failed mutating requests are recorded too). Legacy rows have none = success. */
    outcome: { type: String, enum: ["success", "failure"], default: "success" },
    /** For failures: { message, code, fields } of the error response. */
    error: { type: mongoose.Schema.Types.Mixed, default: null },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ tenantId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ resource: 1, createdAt: -1 });
auditLogSchema.index({ resourceId: 1, createdAt: -1 });
auditLogSchema.index({ outcome: 1, createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ requestId: 1 });

// Retention TTL (AUDIT_RETENTION_DAYS, default 365). Same name/lifetime as audit/service.js
// ensureAuditRetention(), declared here so syncIndexes() keeps it instead of dropping it.
const retentionDays = Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS) || 365);
auditLogSchema.index({ createdAt: 1 }, { name: "audit_retention_ttl", expireAfterSeconds: retentionDays * 86400 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
