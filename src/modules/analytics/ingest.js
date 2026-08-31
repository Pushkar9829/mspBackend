import { AnalyticsEvent } from "./event.model.js";
import { AnalyticsDaily } from "./daily.model.js";
import { IMPORTANT_EVENTS } from "./events.catalog.js";

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function compactPayload(payload = {}) {
  const skip = new Set(["password", "passwordHash", "token", "refreshToken"]);
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (skip.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = String(v._id || v.id || v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

export async function recordAnalytics(event, payload = {}) {
  const meta = IMPORTANT_EVENTS[event] || { category: "account", importance: "normal" };
  const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();
  const day = dayKey(occurredAt);
  const tenantId = payload.tenantId?._id || payload.tenantId || null;
  const amount = Number(payload.total || payload.amount || 0) || 0;

  const doc = {
    event,
    category: meta.category,
    importance: meta.importance,
    tenantId,
    userId: payload.userId || payload.buyerId || null,
    actorId: payload.actorId || payload.userId || null,
    resource: payload.resource || meta.category,
    resourceId: payload.resourceId || payload.orderId || payload.productId || null,
    amount,
    payload: compactPayload(payload),
    requestId: payload.requestId || "",
    day,
    occurredAt,
  };

  await AnalyticsEvent.create(doc);
  await AnalyticsDaily.updateOne(
    { day, tenantId, event },
    {
      $inc: { count: 1, amount },
      $setOnInsert: { category: meta.category },
    },
    { upsert: true }
  );
}

export function recordAnalyticsSafe(event, payload) {
  recordAnalytics(event, payload).catch((err) =>
    console.error("analytics write failed", event, err.message)
  );
}
