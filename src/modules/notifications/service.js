import mongoose from "mongoose";
import { Notification, defaultExpiry, NOTIFICATION_TTL_DAYS } from "./notification.model.js";
import { NotificationRead } from "./notificationRead.model.js";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { Order } from "../orders/order.model.js";
import { AppError } from "../../utils/AppError.js";
import { env } from "../../config/env.js";
import { getIo, emitToUser, emitToTenant } from "../../utils/io.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { onDurable } from "../../utils/events.js";
import { deliverToUser } from "./channels.js";
import { categoryFor, allowed } from "./preferences.js";
import { mailConfigured } from "./mailer.js";
import { smsConfigured, SMS_TEMPLATE_ENV } from "./sms.js";
import { formatInr, orderUrl, staffOrderUrl } from "./templates.js";

const TITLES = {
  ORDER_CREATED: "Order placed",
  ORDER_CONFIRMED: "Order confirmed",
  ORDER_PAID: "Payment received",
  ORDER_PROCESSING: "Order is being prepared",
  ORDER_READY: "Order ready to ship",
  ORDER_SHIPPED: "Order shipped",
  ORDER_OUT_FOR_DELIVERY: "Out for delivery",
  ORDER_DELIVERED: "Order delivered",
  ORDER_CANCELLED: "Order cancelled",
  ORDER_TIMEOUT: "Order cancelled",
  ORDER_REFUNDED: "Refund issued",
  ORDER_RETURN_REQUESTED: "Return requested",
  NEW_ORDER: "New order",
  LOW_STOCK: "Low stock alert",
  OUT_OF_STOCK: "Out of stock",
  PRICE_DROP: "New offer",
  COUPON_CREATED: "New coupon",
  CHAT_MESSAGE: "New chat message",
  CHAT_ASSIGNED: "Chat assigned",
  CHAT_ESCALATED: "Chat escalated",
  GLOBAL_ANNOUNCEMENT: "Announcement",
  ACCOUNT_LOGIN: "New login",
  RESTOCK_AVAILABLE: "Back in stock",
  TENANT_SUSPENDED: "Store suspended",
};

const BROADCAST_TYPES = ["tenant", "staff", "role", "all"];

function idOf(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (typeof value === "object" && value._id) return idOf(value._id);
  return mongoose.isValidObjectId(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null;
}

function plain(doc) {
  return doc?.toObject ? doc.toObject() : doc;
}

/* ------------------------------ push ------------------------------ */

function pushToSockets(doc) {
  const n = plain(doc);
  if (n.userId) {
    emitToUser(n.userId, "notification", n);
    return;
  }
  const type = n.audience?.type;
  if ((type === "tenant" || type === "staff") && n.tenantId) {
    // tenant:<id> room only contains store staff (see sockets/index.js).
    emitToTenant(n.tenantId, "notification", n);
  } else if (type === "all") {
    getIo()?.emit("notification", n);
  } else if (type === "role" && n.audience?.roleSlug === "super_admin") {
    getIo()?.to("platform:admins").emit("notification", n);
  } else if (type === "role" && getIo()) {
    // Role rooms do not exist: push to every holder's personal room (capped).
    broadcastRecipients(n, { limit: MAX_BROADCAST_RECIPIENTS })
      .then((users) => {
        for (const u of users) emitToUser(u._id, "notification", n);
      })
      .catch((err) => console.error("[notify] role push failed", err.message));
  }
}

/* --------------------------- broadcast email ---------------------- */

export const MAX_BROADCAST_RECIPIENTS = Math.max(1, Number(process.env.BROADCAST_EMAIL_MAX) || 5000);
const EMAIL_BATCH_SIZE = Math.max(1, Number(process.env.BROADCAST_EMAIL_BATCH) || 25);
const EMAIL_BATCH_PAUSE_MS = Math.max(0, Number(process.env.BROADCAST_EMAIL_PAUSE_MS ?? 1000));

/** Role ids matching a broadcast's roleSlug (system role or the store's / any store's custom role). */
async function roleIdsFor(roleSlug, tenantId) {
  const filter = { slug: String(roleSlug || "").toLowerCase() };
  if (tenantId) filter.$or = [{ tenantId }, { tenantId: null }];
  const roles = await Role.find(filter).select("_id").lean();
  return roles.map((r) => r._id);
}

/**
 * Users a broadcast reaches (mirrors the in-app inbox rules): tenant/staff = members of the store,
 * role = holders of the role (in the store, or across all stores when tenantId is null),
 * all = every active user. Only active accounts.
 */
export async function broadcastRecipients(n, { limit = MAX_BROADCAST_RECIPIENTS } = {}) {
  const type = n.audience?.type;
  const base = { status: "active" };
  let filter = null;
  if ((type === "tenant" || type === "staff") && n.tenantId) filter = { ...base, tenantId: n.tenantId };
  else if (type === "all") filter = base;
  else if (type === "role" && n.audience?.roleSlug) {
    const roleIds = await roleIdsFor(n.audience.roleSlug, n.tenantId);
    if (!roleIds.length) return [];
    filter = { ...base, roleId: { $in: roleIds } };
    if (n.tenantId) filter.$or = [{ tenantId: n.tenantId }, { tenantId: null, homeTenantId: n.tenantId }];
  }
  if (!filter) return [];
  return User.find(filter).select("_id").sort({ _id: 1 }).limit(limit).lean();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Email a published broadcast to its audience: batched (EMAIL_BATCH_SIZE per batch, a pause
 * between batches), each recipient through deliverToUser (honours the per-category email
 * preference and adds the signed unsubscribe link). Progress is stored on the notification
 * (`emailDelivery`). Claimed atomically so a broadcast is emailed once.
 */
export async function sendBroadcastEmails(notificationId, { pauseMs = EMAIL_BATCH_PAUSE_MS, batchSize = EMAIL_BATCH_SIZE } = {}) {
  const doc = await Notification.findOneAndUpdate(
    { _id: notificationId, userId: null, "channels.email": true, "emailDelivery.status": { $in: [null, "pending"] } },
    { $set: { "emailDelivery.status": "sending", "emailDelivery.startedAt": new Date() } },
    { new: true }
  ).lean();
  if (!doc) return null;
  const stats = { recipients: 0, sent: 0, skipped: 0, failed: 0 };
  try {
    const users = await broadcastRecipients(doc);
    stats.recipients = users.length;
    for (let i = 0; i < users.length; i += batchSize) {
      const batch = users.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((u) =>
          deliverToUser(u._id, {
            category: doc.category || "marketing",
            email: { subject: doc.title, heading: doc.title, lines: [doc.body].filter(Boolean) },
          })
        )
      );
      for (const r of results) {
        if (r.status === "rejected") stats.failed += 1;
        else if (r.value?.email) stats.sent += 1;
        else stats.skipped += 1;
      }
      await Notification.updateOne({ _id: doc._id }, { $set: { "emailDelivery.sent": stats.sent, "emailDelivery.skipped": stats.skipped } });
      if (pauseMs && i + batchSize < users.length) await sleep(pauseMs);
    }
    await Notification.updateOne(
      { _id: doc._id },
      { $set: { emailDelivery: { status: "done", ...stats, startedAt: new Date(doc.emailDelivery?.startedAt || Date.now()), finishedAt: new Date() } } }
    );
  } catch (err) {
    console.error("[notify] broadcast email failed", String(doc._id), err.message);
    await Notification.updateOne({ _id: doc._id }, { $set: { "emailDelivery.status": "failed", "emailDelivery.error": String(err.message).slice(0, 500), ...Object.fromEntries(Object.entries(stats).map(([k, v]) => [`emailDelivery.${k}`, v])) } });
  }
  return stats;
}

/**
 * Persist an in-app notification and push it over sockets.
 * - With `userId`: personal notification (honours the user's in-app preference; returns null when off).
 * - Without `userId`: one broadcast document (`audience.type` tenant/staff/role/all).
 */
export async function persistAndPush({
  userId = null,
  tenantId = null,
  event,
  title,
  body,
  data,
  audience,
  priority = "normal",
  category,
  createdBy = null,
  scheduledAt = null,
  expiresAt = null,
  channels = null,
}) {
  const cat = category || categoryFor(event);
  if (userId && !(await allowed(userId, cat, "inApp"))) return null;
  const now = new Date();
  const scheduled = scheduledAt && new Date(scheduledAt) > now;
  const doc = await Notification.create({
    userId: userId || null,
    tenantId: tenantId || null,
    audience: audience || { type: userId ? "user" : tenantId ? "staff" : "all" },
    event,
    category: cat,
    title: title || TITLES[event] || event,
    body: body || "",
    data: data || {},
    priority,
    status: scheduled ? "scheduled" : "published",
    scheduledAt: scheduled ? new Date(scheduledAt) : null,
    publishedAt: scheduled ? new Date(scheduledAt) : now,
    expiresAt: expiresAt ? new Date(expiresAt) : defaultExpiry(scheduled ? new Date(scheduledAt) : now),
    createdBy,
    channels: channels || { email: false },
    ...(!userId && channels?.email ? { emailDelivery: { status: "pending" } } : {}),
  });
  if (!scheduled) await afterPublish(doc);
  return doc;
}

async function afterPublish(doc) {
  pushToSockets(doc);
  if (doc.userId && doc.channels?.email) {
    await deliverToUser(doc.userId, {
      category: doc.category,
      email: { subject: doc.title, lines: [doc.body] },
    });
  } else if (!doc.userId && doc.channels?.email) {
    // Broadcast emails run in the background (batched + rate limited).
    sendBroadcastEmails(doc._id).catch((err) => console.error("[notify] broadcast email failed", err.message));
  }
}

/* --------------------------- inbox query -------------------------- */

function viewerTenantId(req) {
  // The user's own (member) tenant — never the buyer's storefront affinity.
  return idOf(req.user?.tenantId);
}

function isStaffViewer(req) {
  return Boolean(viewerTenantId(req)) && !req.isBuyer && !req.isPlatformAdmin;
}

/** $or branches of broadcast notifications visible to the viewer. Each branch is index-backed. */
function broadcastBranches(req) {
  const branches = [{ "audience.type": "all", userId: null }];
  const tenantId = viewerTenantId(req);
  if (tenantId) {
    branches.push({
      "audience.type": isStaffViewer(req) ? { $in: ["tenant", "staff"] } : "tenant",
      tenantId,
      userId: null,
    });
  }
  const roleSlug = req.role?.slug;
  if (roleSlug) {
    // Store role broadcasts (tenantId = own store) and platform-wide role broadcasts (tenantId null).
    branches.push({
      "audience.type": "role",
      tenantId: tenantId ? { $in: [tenantId, null] } : null,
      "audience.roleSlug": roleSlug,
      userId: null,
    });
  }
  return branches;
}

function liveFilter(now = new Date()) {
  return { status: { $nin: ["scheduled", "cancelled"] }, expiresAt: { $not: { $lte: now } } };
}

function inboxFilter(req, extra = {}) {
  return { $or: [{ userId: req.user._id }, ...broadcastBranches(req)], ...liveFilter(), ...extra };
}

function broadcastFilter(req) {
  return { $or: broadcastBranches(req), ...liveFilter() };
}

async function attachReadState(req, docs) {
  const broadcastIds = docs.filter((d) => !d.userId).map((d) => d._id);
  const reads = broadcastIds.length
    ? await NotificationRead.find({ userId: req.user._id, notificationId: { $in: broadcastIds } }).lean()
    : [];
  const readMap = new Map(reads.map((r) => [String(r.notificationId), r.readAt]));
  return docs.map((d) => (d.userId ? d : { ...d, readAt: readMap.get(String(d._id)) || null }));
}

export async function listMine(req) {
  const { page, limit, skip } = paginate(req.query);
  const extra = {};
  if (req.query.category) extra.category = String(req.query.category);
  const filter = inboxFilter(req, extra);
  const [rows, total] = await Promise.all([
    Notification.find(filter).sort({ publishedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
  ]);
  const data = await attachReadState(req, rows);
  return paginated(data, total, { page, limit });
}

async function unreadBroadcastIds(req) {
  const ids = (await Notification.find(broadcastFilter(req)).select("_id").sort({ publishedAt: -1 }).limit(1000).lean()).map(
    (d) => d._id
  );
  if (!ids.length) return [];
  const read = await NotificationRead.find({ userId: req.user._id, notificationId: { $in: ids } })
    .select("notificationId")
    .lean();
  const readSet = new Set(read.map((r) => String(r.notificationId)));
  return ids.filter((id) => !readSet.has(String(id)));
}

export async function unreadCount(req) {
  const [personal, broadcast] = await Promise.all([
    Notification.countDocuments({ userId: req.user._id, readAt: null, ...liveFilter() }),
    unreadBroadcastIds(req),
  ]);
  return { unread: personal + broadcast.length, personal, broadcast: broadcast.length };
}

export async function markRead(req, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(404, "Notification not found", "NOT_FOUND");
  const doc = await Notification.findOne(inboxFilter(req, { _id: id })).lean();
  if (!doc) throw new AppError(404, "Notification not found", "NOT_FOUND");
  if (doc.userId) {
    const updated = await Notification.findOneAndUpdate(
      { _id: doc._id, userId: req.user._id },
      [{ $set: { readAt: { $ifNull: ["$readAt", "$$NOW"] } } }],
      { new: true }
    ).lean();
    return updated;
  }
  const read = await NotificationRead.findOneAndUpdate(
    { userId: req.user._id, notificationId: doc._id },
    { $setOnInsert: { readAt: new Date(), expiresAt: doc.expiresAt || defaultExpiry() } },
    { upsert: true, new: true }
  ).lean();
  return { ...doc, readAt: read.readAt };
}

export async function markAllRead(req) {
  const now = new Date();
  const personal = await Notification.updateMany(
    { userId: req.user._id, readAt: null, ...liveFilter(now) },
    { $set: { readAt: now } }
  );
  const ids = await unreadBroadcastIds(req);
  if (ids.length) {
    const expiry = defaultExpiry(now);
    await NotificationRead.bulkWrite(
      ids.map((notificationId) => ({
        updateOne: {
          filter: { userId: req.user._id, notificationId },
          update: { $setOnInsert: { readAt: now, expiresAt: expiry } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }
  return { ok: true, personal: personal.modifiedCount, broadcast: ids.length };
}

/* -------------------------- announcements ------------------------- */

async function assertRecipientsInTenant(userIds, tenantId) {
  const members = await User.find({ _id: { $in: userIds }, tenantId }).select("_id").lean();
  const ok = new Set(members.map((u) => String(u._id)));
  const missing = userIds.filter((id) => !ok.has(String(id)));
  if (!missing.length) return;
  // Customers of this store (bought from it) are also allowed recipients.
  const customers = await Order.distinct("buyerId", { tenantId, buyerId: { $in: missing } });
  const custSet = new Set(customers.map(String));
  if (missing.some((id) => !custSet.has(String(id)))) {
    throw new AppError(403, "Some recipients do not belong to your store", "FORBIDDEN");
  }
}

export async function createAnnouncement(req, body) {
  const platform = Boolean(req.isPlatformAdmin);
  const ownTenant = viewerTenantId(req) || idOf(req.tenantId);
  const audienceType = body.audienceType || (platform ? "all" : "tenant");

  let tenantId;
  if (platform) {
    // The audience comes from the body only: the X-Tenant-Id header / ?tenantId= (admin context)
    // never narrows or widens who receives an announcement.
    tenantId = idOf(body.tenantId) || null;
  } else {
    if (!ownTenant) throw new AppError(403, "Tenant context required", "FORBIDDEN");
    if (audienceType === "all") throw new AppError(403, "Only platform admins can notify everyone", "FORBIDDEN");
    if (body.tenantId && String(body.tenantId) !== String(ownTenant)) {
      throw new AppError(403, "Cross-tenant announcements are not allowed", "FORBIDDEN");
    }
    if (audienceType === "role" && !body.roleSlug) throw new AppError(400, "roleSlug required", "VALIDATION_ERROR");
    tenantId = ownTenant;
  }
  if ((audienceType === "tenant" || audienceType === "staff") && !tenantId) {
    throw new AppError(400, "tenantId required for a store announcement", "VALIDATION_ERROR");
  }

  const common = {
    event: "GLOBAL_ANNOUNCEMENT",
    category: "marketing",
    title: body.title,
    body: body.body || "",
    data: body.data || {},
    priority: body.priority || "normal",
    createdBy: req.user._id,
    scheduledAt: body.scheduledAt || null,
    expiresAt: body.expiresAt || null,
    channels: { email: Boolean(body.channels?.email) },
  };

  if (audienceType === "user") {
    const userIds = [...new Set((body.userIds || []).map(String))];
    if (!userIds.length) throw new AppError(400, "userIds required", "VALIDATION_ERROR");
    if (!platform) await assertRecipientsInTenant(userIds, tenantId);
    const created = [];
    for (const userId of userIds) {
      const doc = await persistAndPush({
        ...common,
        userId,
        tenantId,
        audience: { type: "user" },
      });
      if (doc) created.push(doc);
    }
    return { ok: true, count: created.length, scheduled: created.some((d) => d.status === "scheduled"), ids: created.map((d) => d._id) };
  }

  const doc = await persistAndPush({
    ...common,
    tenantId: audienceType === "all" ? null : audienceType === "role" ? tenantId || null : tenantId,
    audience: { type: audienceType, roleSlug: audienceType === "role" ? String(body.roleSlug).toLowerCase() : "" },
  });
  return doc;
}

/**
 * Sent announcements. Platform admins see all (or one store's with a tenant filter, which still
 * includes platform-wide "all" announcements unless includeGlobal=false). Store staff see their
 * store's (plus "all" ones with includeGlobal=true). Rows carry `scope`: "all" | "store" | "role"
 * | "user" and `global` (true for platform-wide announcements).
 */
export async function listSent(req) {
  const { page, limit, skip } = paginate(req.query);
  const base = { event: "GLOBAL_ANNOUNCEMENT" };
  const includeGlobal = req.query.includeGlobal;
  let scopeTenant = null;
  if (!req.isPlatformAdmin) scopeTenant = viewerTenantId(req) || idOf(req.tenantId);
  else if (req.tenantId) scopeTenant = req.tenantId;
  const withGlobal = scopeTenant && (req.isPlatformAdmin ? includeGlobal !== "false" : includeGlobal === "true");
  const and = [base];
  if (scopeTenant) {
    and.push(withGlobal ? { $or: [{ tenantId: scopeTenant }, { "audience.type": "all" }] } : { tenantId: scopeTenant });
  }
  if (req.query.status) and.push({ status: String(req.query.status) });
  if (req.query.audienceType) and.push({ "audience.type": String(req.query.audienceType) });
  const filter = and.length > 1 ? { $and: and } : base;
  const [rows, total] = await Promise.all([
    Notification.find(filter)
      .populate("createdBy", "name email")
      .populate("tenantId", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    Notification.countDocuments(filter),
  ]);
  const data = rows.map((n) => {
    const type = n.audience?.type || (n.userId ? "user" : "all");
    return {
      ...n,
      tenant: n.tenantId && typeof n.tenantId === "object" ? { id: n.tenantId._id, name: n.tenantId.name, slug: n.tenantId.slug } : null,
      tenantId: n.tenantId?._id || n.tenantId || null,
      scope: type === "all" ? "all" : type === "role" ? "role" : type === "user" ? "user" : "store",
      global: type === "all" || (type === "role" && !n.tenantId),
    };
  });
  return paginated(data, total, { page, limit });
}

export async function cancelScheduled(req, id) {
  const filter = { _id: id, status: "scheduled", event: "GLOBAL_ANNOUNCEMENT" };
  if (!req.isPlatformAdmin) filter.tenantId = viewerTenantId(req) || idOf(req.tenantId);
  const doc = await Notification.findOneAndUpdate(filter, { $set: { status: "cancelled" } }, { new: true });
  if (!doc) throw new AppError(404, "Scheduled notification not found", "NOT_FOUND");
  return doc;
}

/**
 * Publish due scheduled notifications. Each one is claimed atomically (status scheduled →
 * published), so concurrent runners / multiple instances publish every notification exactly once.
 */
export async function publishScheduled({ batch = 200 } = {}) {
  let published = 0;
  for (let i = 0; i < batch; i += 1) {
    const now = new Date();
    const doc = await Notification.findOneAndUpdate(
      { status: "scheduled", scheduledAt: { $lte: now } },
      { $set: { status: "published", publishedAt: now } },
      { new: true, sort: { scheduledAt: 1 } }
    );
    if (!doc) break;
    published += 1;
    try {
      await afterPublish(doc);
    } catch (err) {
      console.error("[notify] publish side effects failed", String(doc._id), err.message);
    }
  }
  return published;
}

/* ---------------------------- recipients -------------------------- */

/** Active-ish users of a store whose role is tenant_admin or carries one of `permissions`. */
async function tenantUsersWith(tenantId, permissions = [], { includeSuspended = false } = {}) {
  if (!tenantId) return [];
  const roles = await Role.find({
    $or: [
      { slug: "tenant_admin" },
      ...(permissions.length ? [{ permissions: { $in: permissions } }] : []),
    ],
    $and: [{ $or: [{ tenantId }, { tenantId: null }] }],
    scope: { $ne: "platform" },
  })
    .select("_id")
    .lean();
  if (!roles.length) return [];
  return User.find({
    tenantId,
    roleId: { $in: roles.map((r) => r._id) },
    status: includeSuspended ? { $nin: ["deleted"] } : "active",
  })
    .select("_id")
    .limit(200)
    .lean();
}

/* ----------------------------- listeners -------------------------- */

/** Accepts the legacy flat payload and the new `{ order }` payload. */
export function orderFromPayload(p = {}) {
  const o = p.order || {};
  return {
    orderId: idOf(o._id || p.orderId),
    tenantId: idOf(o.tenantId || p.tenantId),
    buyerId: idOf(o.buyerId || p.buyerId || p.userId),
    orderNumber: o.orderNumber || p.orderNumber || "",
    total: o.grandTotal ?? o.total ?? p.grandTotal ?? p.total ?? null,
    status: o.status || p.status || "",
  };
}

const BUYER_ORDER_EVENTS = {
  ORDER_CREATED: { line: (o) => `Your order ${o.orderNumber} has been placed.`, sms: "ORDER_PLACED", status: "placed" },
  ORDER_CONFIRMED: { line: (o) => `Your order ${o.orderNumber} has been confirmed by the seller.`, sms: "ORDER_CONFIRMED", status: "confirmed" },
  ORDER_PAID: { line: (o) => `We received your payment of ${formatInr(o.total)} for order ${o.orderNumber}.`, sms: "PAYMENT_RECEIVED", status: "paid" },
  ORDER_PROCESSING: { line: (o) => `Your order ${o.orderNumber} is being prepared.`, sms: "ORDER_PROCESSING", status: "processing" },
  ORDER_READY: { line: (o) => `Your order ${o.orderNumber} is packed and ready to ship.`, sms: "ORDER_READY", status: "ready to ship" },
  ORDER_SHIPPED: { line: (o) => `Your order ${o.orderNumber} has been shipped.`, sms: "ORDER_SHIPPED", status: "shipped" },
  ORDER_OUT_FOR_DELIVERY: { line: (o) => `Your order ${o.orderNumber} is out for delivery.`, sms: "ORDER_OUT_FOR_DELIVERY", status: "out for delivery" },
  ORDER_DELIVERED: { line: (o) => `Your order ${o.orderNumber} has been delivered.`, sms: "ORDER_DELIVERED", status: "delivered" },
  ORDER_CANCELLED: { line: (o) => `Your order ${o.orderNumber} has been cancelled.`, sms: "ORDER_CANCELLED", status: "cancelled" },
  ORDER_TIMEOUT: { line: (o) => `Your order ${o.orderNumber} was cancelled because payment was not completed in time.`, sms: "ORDER_CANCELLED", status: "cancelled" },
  ORDER_REFUNDED: { line: (o) => `A refund of ${formatInr(o.total)} for order ${o.orderNumber} has been issued.`, sms: "ORDER_REFUNDED", status: "refunded" },
};

const STAFF_ORDER_EVENTS = {
  ORDER_CREATED: { title: "New order", line: (o) => `New order ${o.orderNumber} (${formatInr(o.total)}).`, priority: "high" },
  ORDER_CANCELLED: { title: "Order cancelled", line: (o) => `Order ${o.orderNumber} was cancelled.` },
  ORDER_RETURN_REQUESTED: {
    title: "Return requested",
    line: (o) => `The buyer requested a return for order ${o.orderNumber}.`,
    priority: "high",
    email: true,
  },
};

function orderData(o) {
  return { orderId: o.orderId, orderNumber: o.orderNumber, total: o.total, status: o.status };
}

let listenersRegistered = false;

export function registerNotificationListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  for (const [event, spec] of Object.entries(BUYER_ORDER_EVENTS)) {
    onDurable(event, `notify.buyer.${event}`, async (p) => {
      const o = orderFromPayload(p);
      if (!o.buyerId) return;
      const body = spec.line(o);
      await persistAndPush({ userId: o.buyerId, tenantId: o.tenantId, event, body, data: orderData(o) });
      await deliverToUser(o.buyerId, {
        category: "order",
        email: { subject: `${TITLES[event]} – ${o.orderNumber}`, heading: TITLES[event], lines: [body], cta: { label: "View order", url: orderUrl(o.orderId) } },
        sms: { kind: spec.sms, vars: { order: o.orderNumber, amount: o.total ?? "", status: spec.status } },
      });
    });
  }

  for (const [event, spec] of Object.entries(STAFF_ORDER_EVENTS)) {
    onDurable(event, `notify.staff.${event}`, async (p) => {
      const o = orderFromPayload(p);
      if (!o.tenantId) return;
      const body = spec.line(o);
      await persistAndPush({
        tenantId: o.tenantId,
        event: event === "ORDER_CREATED" ? "NEW_ORDER" : event,
        title: spec.title,
        body,
        data: orderData(o),
        audience: { type: "staff" },
        priority: spec.priority || "normal",
      });
      if (spec.email) {
        const staff = await tenantUsersWith(o.tenantId, ["orders.update", "orders.refund"]);
        for (const u of staff) {
          await deliverToUser(u._id, {
            category: "order",
            email: { subject: `${spec.title} – ${o.orderNumber}`, lines: [body, p.reason ? `Reason: ${p.reason}` : ""], cta: { label: "Open order", url: staffOrderUrl(o.orderId) } },
          });
        }
      }
    });
  }

  onDurable("LOW_STOCK", "notify.staff.LOW_STOCK", (p) =>
    persistAndPush({
      tenantId: p.tenantId,
      event: "LOW_STOCK",
      body: `${p.sku} is low (${p.available})`,
      data: { variantId: p.variantId, sku: p.sku, available: p.available, warehouseId: p.warehouseId },
      audience: { type: "staff" },
    })
  );

  onDurable("OUT_OF_STOCK", "notify.staff.OUT_OF_STOCK", async (p) => {
    if (!p.tenantId) return;
    const body = `${p.sku || "A product"} is out of stock`;
    await persistAndPush({
      tenantId: p.tenantId,
      event: "OUT_OF_STOCK",
      body,
      data: { variantId: p.variantId, sku: p.sku, warehouseId: p.warehouseId },
      audience: { type: "staff" },
      priority: "high",
    });
    const staff = await tenantUsersWith(p.tenantId, ["inventory.adjust"]);
    for (const u of staff) {
      await deliverToUser(u._id, { category: "inventory", email: { subject: `Out of stock: ${p.sku || ""}`, lines: [body] } });
    }
  });

  onDurable("CHAT_MESSAGE", "notify.CHAT_MESSAGE", async (p) => {
    if (p.internal) return; // internal agent notes are never sent to the buyer
    const fromBuyer = String(p.senderId) === String(p.buyerId);
    const target = fromBuyer ? p.assigneeId : p.buyerId;
    if (!target || String(target) === String(p.senderId)) return;
    await persistAndPush({
      userId: target,
      tenantId: p.tenantId,
      event: "CHAT_MESSAGE",
      body: p.preview,
      data: { conversationId: p.conversationId },
    });
  });

  onDurable("CHAT_ASSIGNED", "notify.CHAT_ASSIGNED", async (p) => {
    if (!p.assigneeId || String(p.assigneeId) === String(p.actorId)) return;
    await persistAndPush({
      userId: p.assigneeId,
      tenantId: p.tenantId,
      event: "CHAT_ASSIGNED",
      body: "A conversation was assigned to you.",
      data: { conversationId: p.conversationId },
    });
  });

  onDurable("CHAT_ESCALATED", "notify.CHAT_ESCALATED", (p) =>
    persistAndPush({
      tenantId: null,
      event: "CHAT_ESCALATED",
      body: "A conversation was escalated to the platform team.",
      data: { conversationId: p.conversationId, tenantId: p.tenantId },
      audience: { type: "role", roleSlug: "super_admin" },
      priority: "high",
    })
  );

  onDurable("COUPON_CREATED", "notify.staff.COUPON_CREATED", (p) =>
    persistAndPush({
      tenantId: p.tenantId,
      event: "COUPON_CREATED",
      body: `Coupon ${p.code} created`,
      data: { couponId: p.couponId || p.resourceId, code: p.code },
      audience: { type: "staff" },
    })
  );

  onDurable("PRICE_DROP", "notify.staff.PRICE_DROP", (p) =>
    persistAndPush({
      tenantId: p.tenantId,
      event: "PRICE_DROP",
      body: p.name || "New offer",
      data: { offerId: p.offerId || p.resourceId, name: p.name },
      audience: { type: "staff" },
    })
  );

  onDurable("TENANT_SUSPENDED", "notify.TENANT_SUSPENDED", async (p) => {
    const tenantId = idOf(p.tenantId);
    if (!tenantId) return;
    const admins = await tenantUsersWith(tenantId, ["settings.edit"], { includeSuspended: true });
    const body = "Your store has been suspended by the platform. Contact support for details.";
    for (const u of admins) {
      await persistAndPush({ userId: u._id, tenantId, event: "TENANT_SUSPENDED", body, priority: "high", category: "account" });
      await deliverToUser(u._id, {
        category: "account",
        email: { subject: "Your store has been suspended", lines: [body, p.reason ? `Reason: ${p.reason}` : ""] },
        sms: { kind: "ACCOUNT_ALERT", vars: { status: "suspended", message: "Store suspended" } },
      });
    }
  });

  runStartupTasks().catch((err) => console.error("[notify] startup tasks failed", err.message));
}

/* ----------------------------- startup ---------------------------- */

let providerWarningShown = false;
function warnMissingProviders() {
  if (providerWarningShown || !env.isProd) return;
  providerWarningShown = true;
  if (!mailConfigured()) console.warn("[notify] SMTP_HOST is not set: transactional emails will NOT be sent in production.");
  if (!smsConfigured()) {
    console.warn("[notify] MSG91_AUTH_KEY is not set: SMS will NOT be sent in production.");
  } else {
    const missing = Object.values(SMS_TEMPLATE_ENV).filter((name) => !process.env[name]);
    if (missing.length) console.warn(`[notify] MSG91 DLT templates missing (those SMS are skipped): ${missing.join(", ")}`);
  }
}

/** One-off upgrades of legacy notification documents (idempotent, cheap when nothing to do). */
export async function migrateLegacyNotifications() {
  const ttlMs = NOTIFICATION_TTL_DAYS * 86400000;
  await Notification.updateMany({ publishedAt: { $exists: false } }, [{ $set: { publishedAt: "$createdAt" } }]);
  await Notification.updateMany({ status: { $exists: false } }, { $set: { status: "published" } });
  await Notification.updateMany({ $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }] }, [
    { $set: { expiresAt: { $add: [{ $ifNull: ["$createdAt", "$$NOW"] }, ttlMs] } } },
  ]);
}

async function runStartupTasks() {
  warnMissingProviders();
  if (mongoose.connection.readyState !== 1) return;
  await migrateLegacyNotifications();
  const [{ ensureAuditRetention }, { ensureAnalyticsRetention }, { ensureAddressIndexes }] = await Promise.all([
    import("../audit/service.js"),
    import("../analytics/ingest.js"),
    import("../location/address.service.js"),
  ]);
  const results = await Promise.allSettled([ensureAuditRetention(), ensureAnalyticsRetention(), ensureAddressIndexes()]);
  for (const r of results) if (r.status === "rejected") console.error("[startup] index/retention task failed", r.reason?.message);
}

export { BROADCAST_TYPES };
