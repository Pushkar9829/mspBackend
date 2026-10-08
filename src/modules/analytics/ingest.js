import { AnalyticsEvent } from "./event.model.js";
import { AnalyticsDaily } from "./daily.model.js";
import { IMPORTANT_EVENTS } from "./events.catalog.js";
import { dayKey } from "../reports/time.js";

const SECRET_KEYS = new Set(["password", "passwordHash", "token", "refreshToken", "accessToken"]);

function idString(v) {
  if (!v) return v;
  if (typeof v === "object") return String(v._id || v.id || v);
  return v;
}

function compactPayload(payload = {}) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (SECRET_KEYS.has(k)) continue;
    if (k === "order" && v && typeof v === "object") {
      // New-style `{ order }` payloads: keep only the identifying/summary fields.
      out.order = {
        _id: idString(v._id),
        orderNumber: v.orderNumber,
        status: v.status,
        total: v.grandTotal ?? v.total,
      };
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = String(v._id || v.id || v);
      continue;
    }
    if (typeof v === "string" && v.length > 500) {
      out[k] = v.slice(0, 500);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Flatten `{ order }` payloads so both payload styles are recorded the same way. */
function normalize(payload = {}) {
  const o = payload.order;
  if (!o || typeof o !== "object") return payload;
  return {
    ...payload,
    orderId: payload.orderId || o._id,
    tenantId: payload.tenantId || o.tenantId,
    buyerId: payload.buyerId || o.buyerId,
    userId: payload.userId || o.buyerId,
    orderNumber: payload.orderNumber || o.orderNumber,
    total: payload.total ?? o.grandTotal ?? o.total,
    resource: payload.resource || "order",
    resourceId: payload.resourceId || o._id,
  };
}

export async function recordAnalytics(event, rawPayload = {}) {
  const payload = normalize(rawPayload || {});
  const meta = IMPORTANT_EVENTS[event] || { category: "account", importance: "normal" };
  const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date();
  const day = dayKey(Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt);
  const tenantId = payload.tenantId?._id || payload.tenantId || null;
  const amount = Number(payload.total ?? payload.amount ?? 0) || 0;

  const doc = {
    event,
    category: meta.category,
    importance: meta.importance,
    tenantId,
    userId: payload.userId?._id || payload.userId || payload.buyerId?._id || payload.buyerId || null,
    actorId: payload.actorId || payload.userId || null,
    resource: payload.resource || meta.category,
    resourceId: idString(payload.resourceId || payload.orderId || payload.productId) || null,
    amount,
    payload: compactPayload(rawPayload || {}),
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
  try {
    recordAnalytics(event, payload).catch((err) => console.error("analytics write failed", event, err.message));
  } catch (err) {
    console.error("analytics write failed", event, err.message);
  }
}

/**
 * Make existing databases match the schema's index set: drops the ~10 legacy AnalyticsEvent
 * indexes no query uses and creates the retention TTL (ANALYTICS_RETENTION_DAYS).
 * Only touches the two analytics collections (owned by this module).
 */
export async function ensureAnalyticsRetention() {
  await AnalyticsEvent.syncIndexes();
  await AnalyticsDaily.syncIndexes();
}
