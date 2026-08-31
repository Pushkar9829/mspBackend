import { AnalyticsEvent } from "./event.model.js";
import { AnalyticsDaily } from "./daily.model.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { AppError } from "../../utils/AppError.js";

function range(query) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError(400, "Invalid from/to date", "VALIDATION_ERROR");
  }
  if (from > to) throw new AppError(400, "from must be before to", "VALIDATION_ERROR");
  return { from, to };
}

function tenantScope(req) {
  if (req.isPlatformAdmin && !req.tenantId) return {};
  return { tenantId: req.tenantId || req.user?.tenantId || null };
}

function dayList(from, to) {
  const days = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

export async function overview(req) {
  const { from, to } = range(req.query);
  const days = dayList(from, to);
  const filter = { day: { $in: days }, ...tenantScope(req) };
  if (req.query.event) filter.event = req.query.event;

  const rows = await AnalyticsDaily.find(filter).lean();
  let events = 0;
  let amount = 0;
  const byImportanceSeed = { critical: 0, high: 0, normal: 0, low: 0 };
  const byCategory = {};
  const byEvent = {};

  for (const row of rows) {
    events += row.count;
    amount += row.amount || 0;
    byEvent[row.event] = (byEvent[row.event] || 0) + row.count;
    if (row.category) byCategory[row.category] = (byCategory[row.category] || 0) + row.count;
  }

  const importance = await AnalyticsEvent.aggregate([
    {
      $match: {
        occurredAt: { $gte: from, $lte: to },
        ...tenantScope(req),
      },
    },
    { $group: { _id: "$importance", count: { $sum: 1 } } },
  ]);
  for (const row of importance) {
    byImportanceSeed[row._id] = row.count;
  }

  const important = await AnalyticsEvent.find({
    occurredAt: { $gte: from, $lte: to },
    importance: { $in: ["critical", "high"] },
    ...tenantScope(req),
  })
    .sort({ occurredAt: -1 })
    .limit(20)
    .lean();

  return {
    from,
    to,
    totals: { events, amount, days: days.length },
    byEvent,
    byCategory,
    byImportance: byImportanceSeed,
    important,
  };
}

export async function byDate(req) {
  const { from, to } = range(req.query);
  const days = dayList(from, to);
  const filter = { day: { $in: days }, ...tenantScope(req) };
  if (req.query.event) filter.event = req.query.event;
  const rows = await AnalyticsDaily.find(filter).lean();
  const map = new Map(days.map((d) => [d, { day: d, count: 0, amount: 0 }]));
  for (const row of rows) {
    const cur = map.get(row.day) || { day: row.day, count: 0, amount: 0 };
    cur.count += row.count;
    cur.amount += row.amount || 0;
    map.set(row.day, cur);
  }
  return { from, to, event: req.query.event || "all", series: [...map.values()] };
}

export async function byEvent(req) {
  const { from, to } = range(req.query);
  const days = dayList(from, to);
  const filter = { day: { $in: days }, ...tenantScope(req) };
  if (req.query.category) filter.category = req.query.category;
  const rows = await AnalyticsDaily.aggregate([
    { $match: filter },
    {
      $group: {
        _id: "$event",
        count: { $sum: "$count" },
        amount: { $sum: "$amount" },
        category: { $first: "$category" },
      },
    },
    { $sort: { count: -1 } },
  ]);
  return {
    from,
    to,
    events: rows.map((r) => ({
      event: r._id,
      category: r.category,
      count: r.count,
      amount: r.amount,
    })),
  };
}

export async function important(req) {
  const { from, to } = range(req.query);
  const { page, limit, skip } = paginate({ ...req.query, limit: req.query.limit || 50 });
  const filter = {
    occurredAt: { $gte: from, $lte: to },
    importance: { $in: ["critical", "high"] },
    ...tenantScope(req),
  };
  if (req.query.event) filter.event = req.query.event;
  if (req.query.importance) filter.importance = req.query.importance;
  const [data, total] = await Promise.all([
    AnalyticsEvent.find(filter).sort({ occurredAt: -1 }).skip(skip).limit(limit).lean(),
    AnalyticsEvent.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function feed(req) {
  const { from, to } = range(req.query);
  const { page, limit, skip } = paginate(req.query);
  const filter = {
    occurredAt: { $gte: from, $lte: to },
    ...tenantScope(req),
  };
  if (req.query.event) filter.event = req.query.event;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.importance) filter.importance = req.query.importance;
  if (req.query.userId) filter.userId = req.query.userId;
  const [data, total] = await Promise.all([
    AnalyticsEvent.find(filter).sort({ occurredAt: -1 }).skip(skip).limit(limit).lean(),
    AnalyticsEvent.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}
