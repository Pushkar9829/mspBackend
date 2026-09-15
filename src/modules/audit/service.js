import { AuditLog } from "./auditLog.model.js";
import { User } from "../users/user.model.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { tenantFilter } from "../../middleware/tenantScope.js";

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDate(value, endOfDay = false) {
  if (!value) return null;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T23:59:59.999`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function listAudit(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = tenantFilter(req);

  if (req.query.action) filter.action = req.query.action;
  if (req.query.resource) filter.resource = req.query.resource;
  if (req.query.actorId) filter.actorId = req.query.actorId;
  if (req.query.resourceId) filter.resourceId = req.query.resourceId;
  if (req.query.requestId) filter.requestId = req.query.requestId;
  if (req.query.ip) filter.ip = req.query.ip;
  if (req.query.method) filter["metadata.method"] = String(req.query.method).toUpperCase();

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to, true);
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = from;
    if (to) filter.createdAt.$lte = to;
  }

  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q.trim()), "i");
    const or = [
      { action: rx },
      { resource: rx },
      { requestId: rx },
      { ip: rx },
      { "metadata.path": rx },
      { "metadata.method": rx },
    ];
    const raw = req.query.q.trim();
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

  const [data, total] = await Promise.all([
    AuditLog.find(filter)
      .populate("actorId", "name email")
      .populate("tenantId", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    AuditLog.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}
