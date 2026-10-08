import mongoose from "mongoose";
import { AuditLog } from "./auditLog.model.js";
import { User } from "../users/user.model.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { AppError } from "../../utils/AppError.js";

export const AUDIT_RETENTION_DAYS = Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS) || 365);
const BUSINESS_OFFSET = "+05:30"; // Asia/Kolkata (no DST)

/**
 * Retention: TTL index on createdAt (AuditLog model is owned by another module, so the index is
 * created here). If a TTL index already exists with a different lifetime it is updated via collMod.
 */
export async function ensureAuditRetention() {
  const seconds = AUDIT_RETENTION_DAYS * 86400;
  const coll = AuditLog.collection;
  const indexes = await coll.indexes().catch(() => []);
  const existing = indexes.find((i) => i.name === "audit_retention_ttl");
  if (existing && existing.expireAfterSeconds === seconds) return;
  if (existing) {
    await AuditLog.db.db.command({
      collMod: coll.collectionName,
      index: { name: "audit_retention_ttl", expireAfterSeconds: seconds },
    });
    return;
  }
  await coll.createIndex({ createdAt: 1 }, { name: "audit_retention_ttl", expireAfterSeconds: seconds });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** YYYY-MM-DD is interpreted as a business-timezone (IST) calendar day. */
function parseDate(value, endOfDay = false) {
  if (!value) return null;
  const v = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}${BUSINESS_OFFSET}`);
    if (Number.isNaN(d.getTime())) throw new AppError(400, "Invalid date", "VALIDATION_ERROR");
    return d;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError(400, "Invalid date", "VALIDATION_ERROR");
  return d;
}

const ID_RX = /^[a-f\d]{24}$/i;

export async function listAudit(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);

  const csv = (v) => String(v).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20);
  if (req.query.action) {
    const actions = csv(req.query.action);
    filter.action = actions.length > 1 ? { $in: actions } : actions[0];
  }
  if (req.query.resource) {
    const resources = csv(req.query.resource);
    filter.resource = resources.length > 1 ? { $in: resources } : resources[0];
  }
  if (req.query.outcome) {
    const outcome = String(req.query.outcome);
    if (!["success", "failure"].includes(outcome)) throw new AppError(400, "outcome must be success or failure", "VALIDATION_ERROR");
    // Legacy rows (before outcome was recorded) were successes.
    filter.outcome = outcome === "failure" ? "failure" : { $ne: "failure" };
  }
  if (req.query.statusCode && /^\d{3}$/.test(String(req.query.statusCode))) {
    filter["metadata.statusCode"] = Number(req.query.statusCode);
  }
  if (req.query.actorId) {
    if (!ID_RX.test(String(req.query.actorId))) throw new AppError(400, "Invalid actorId", "VALIDATION_ERROR");
    filter.actorId = req.query.actorId;
  }
  if (req.query.resourceId) {
    const rid = String(req.query.resourceId);
    // resourceId is stored as a string (older rows may hold an ObjectId).
    filter.resourceId = ID_RX.test(rid) ? { $in: [rid, new mongoose.Types.ObjectId(rid)] } : rid;
  }
  if (req.query.requestId) filter.requestId = String(req.query.requestId);
  if (req.query.ip) filter.ip = String(req.query.ip);
  if (req.query.method) {
    const methods = csv(String(req.query.method).toUpperCase());
    filter["metadata.method"] = methods.length > 1 ? { $in: methods } : methods[0];
  }

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to, true);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  if (req.query.q && String(req.query.q).trim()) {
    const rx = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 100)), "i");
    const or = [
      { action: rx },
      { resource: rx },
      { requestId: rx },
      { ip: rx },
      { "metadata.path": rx },
      { "metadata.method": rx },
    ];
    const raw = String(req.query.q).trim();
    if (/^[a-f\d]{24}$/i.test(raw)) {
      or.push({ actorId: raw }, { tenantId: raw }, { resourceId: raw });
    } else {
      or.push({ resourceId: rx });
    }
    const actors = await User.find({ $or: [{ email: rx }, { name: rx }] })
      .select("_id")
      .limit(25);
    if (actors.length) or.push({ actorId: { $in: actors.map((u) => u._id) } });
    filter.$or = or;
  }

  const sortDir = String(req.query.order || "").toLowerCase() === "asc" ? 1 : -1;
  const [data, total] = await Promise.all([
    AuditLog.find(filter)
      .populate("actorId", "name email")
      .populate("tenantId", "name slug")
      .sort({ createdAt: sortDir, _id: sortDir })
      .skip(skip)
      .limit(limit),
    AuditLog.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

/** One audit entry (tenant-scoped for non-platform actors). */
export async function getAudit(req, id) {
  if (!ID_RX.test(String(id))) throw new AppError(400, "Invalid id", "INVALID_ID");
  const row = await AuditLog.findOne({ _id: id, ...tenantFilter(req) })
    .populate("actorId", "name email")
    .populate("tenantId", "name slug");
  if (!row) throw new AppError(404, "Audit entry not found", "NOT_FOUND");
  return row;
}
