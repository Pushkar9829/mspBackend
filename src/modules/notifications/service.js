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
import { pushNotification } from "./push.js";
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
  ORDER_REFUNDED: "Refund initiated",
  ORDER_REFUND_PROCESSED: "Refund completed",
  ORDER_RETURN_REQUESTED: "Return requested",
  ORDER_RETURN_APPROVED: "Return approved",
  ORDER_RETURN_REJECTED: "Return rejected",
  ORDER_RETURNED: "Return received",
  ORDER_RTO_IN_TRANSIT: "Order returning to seller",
  ORDER_RETURNED_TO_ORIGIN: "Order returned to seller",
  ORDER_AUTO_CANCELLED: "Order cancelled",
  PAYMENT_FAILED: "Payment failed",
  PAYMENT_MISMATCH: "Payment amount mismatch",
  REFUND_FAILED: "Refund failed",
  NEW_ORDER: "New order",
  LOW_STOCK: "Low stock alert",
  OUT_OF_STOCK: "Out of stock",
  PRICE_DROP: "New offer",
  OFFER_REJECTED: "Offer not approved",
  COUPON_CREATED: "New coupon",
  CHAT_MESSAGE: "New chat message",
  CHAT_ASSIGNED: "Chat assigned",
  CHAT_ESCALATED: "Chat escalated",
  GLOBAL_ANNOUNCEMENT: "Announcement",
  ACCOUNT_LOGIN: "New login",
  RESTOCK_AVAILABLE: "Back in stock",
  TENANT_SUSPENDED: "Store suspended",
  RIDER_ASSIGNED: "New delivery assigned",
  RIDER_REJECTED_TASK: "Rider rejected a delivery",
  DELIVERY_ATTEMPT_FAILED: "Delivery attempt failed",
  DELIVERY_METHOD_CHANGED: "Delivery update",
  ORDER_RETURN_PICKUP_SCHEDULED: "Return pickup booked",
  ORDER_RETURN_PICKUP_FAILED: "Return pickup failed",
  ORDER_RETURN_QC_REJECTED: "Returned items not accepted",
  SELLER_DEADLINE_SOON: "Deadline approaching",
  REFUND_OVERDUE: "Refund overdue",
  DISPUTE_OPENED: "Dispute opened",
  DISPUTE_MESSAGE: "New message on a dispute",
  DISPUTE_INFO_REQUESTED: "More information needed",
  DISPUTE_UNDER_REVIEW: "Dispute awaiting review",
  DISPUTE_DECIDED: "Dispute decided",
  DISPUTE_WITHDRAWN: "Dispute withdrawn",
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
  // Phase 6: personal notifications also go to the user's phones (FCM; preference `push`).
  if (doc.userId) await pushNotification(doc);
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
  // Delivery riders (phase 5) belong to a store but do not get staff broadcasts.
  const rider = req.role?.isSystem === true && req.role?.slug === "rider";
  return Boolean(viewerTenantId(req)) && !req.isBuyer && !req.isPlatformAdmin && !rider;
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

/** How a refund reaches the buyer, for notification text. Never claims the money arrived. */
function refundRoute(p = {}) {
  if (p.refundMethod === "cod" || p.method === "cod") {
    if (p.refundDestinationType === "store_credit" || p.destinationType === "store_credit") return "as store credit on your account with the seller";
    return "to your UPI id or bank account (add your refund details on the order page if you have not yet)";
  }
  if (p.refundMethod === "ledger_credit" || p.method === "ledger_credit") return "as a credit on your account with the seller";
  return "to your original payment method";
}

function moneyOf(p, o) {
  const value = p.refundAmount ?? p.amount ?? o.total;
  return value != null ? formatInr(value) : "the amount";
}

const BUYER_ORDER_EVENTS = {
  ORDER_CREATED: { line: (o) => `Your order ${o.orderNumber} has been placed.`, sms: "ORDER_PLACED", status: "placed" },
  ORDER_CONFIRMED: { line: (o) => `Your order ${o.orderNumber} has been confirmed by the seller.`, sms: "ORDER_CONFIRMED", status: "confirmed" },
  ORDER_PAID: { line: (o) => `We received your payment of ${formatInr(o.total)} for order ${o.orderNumber}.`, sms: "PAYMENT_RECEIVED", status: "paid" },
  ORDER_PROCESSING: { line: (o) => `Your order ${o.orderNumber} is being prepared.`, sms: "ORDER_PROCESSING", status: "processing" },
  ORDER_READY: { line: (o) => `Your order ${o.orderNumber} is packed and ready to ship.`, sms: "ORDER_READY", status: "ready to ship" },
  ORDER_SHIPPED: { line: (o) => `Your order ${o.orderNumber} has been shipped.`, sms: "ORDER_SHIPPED", status: "shipped" },
  ORDER_OUT_FOR_DELIVERY: {
    // Phase 5: own-rider deliveries carry the rider; the buyer's code is on the order page (and by SMS).
    line: (o, p = {}) =>
      p.rider?.name
        ? `Your order ${o.orderNumber} is out for delivery with ${p.rider.name}${p.rider.phone ? ` (${p.rider.phone})` : ""}. Share the delivery code shown on your order page with the rider to receive it.`
        : `Your order ${o.orderNumber} is out for delivery.`,
    sms: "ORDER_OUT_FOR_DELIVERY",
    status: "out for delivery",
  },
  ORDER_DELIVERED: { line: (o) => `Your order ${o.orderNumber} has been delivered.`, sms: "ORDER_DELIVERED", status: "delivered" },
  ORDER_CANCELLED: {
    line: (o) => `Your order ${o.orderNumber} has been cancelled.`,
    sms: "ORDER_CANCELLED",
    status: "cancelled",
    // Auto-cancel (seller did not confirm / ship) has its own message (ORDER_AUTO_CANCELLED).
    skip: (p) => SLA_REASONS.includes(p.cancelReason),
  },
  ORDER_AUTO_CANCELLED: {
    line: (o, p = {}) =>
      `Your order ${o.orderNumber} was cancelled because the seller did not ${p.cancelReason === "ship_timeout" ? "ship" : "confirm"} it in time. Any stock, credit or payment held for it has been released${
        p.cancelReason === "ship_timeout" && ["upi", "card", "netbanking"].includes(p.order?.paymentMethod) && p.order?.paymentStatus === "paid" ? " and a full refund has been initiated" : ""
      }.`,
    sms: "ORDER_CANCELLED",
    status: "cancelled",
  },
  ORDER_TIMEOUT: { line: (o) => `Your order ${o.orderNumber} was cancelled because payment was not completed in time.`, sms: "ORDER_CANCELLED", status: "cancelled" },
  ORDER_REFUNDED: {
    line: (o, p) =>
      p.refundAmount === 0
        ? `Order ${o.orderNumber} is closed. Its refund was already initiated with your return.`
        : `A refund of ${moneyOf(p, o)} for order ${o.orderNumber} has been initiated. It will be paid ${refundRoute(p)}; we will tell you once it is done.`,
    sms: "ORDER_STATUS",
    status: "refund initiated",
  },
  ORDER_REFUND_PROCESSED: {
    line: (o, p) => `Your refund of ${moneyOf(p, o)} for order ${o.orderNumber} has been paid ${refundRoute(p)}${p.payoutReference ? ` (reference ${p.payoutReference})` : ""}.`,
    sms: "ORDER_REFUNDED",
    status: "refunded",
  },
  ORDER_RETURN_REQUESTED: {
    line: (o, p) =>
      `Your return request for order ${o.orderNumber} was sent to the seller.${p.decideBy ? ` They have until ${dateTimeText(p.decideBy)} to respond; if they don't, it is approved automatically.` : ""}`,
    sms: "ORDER_STATUS",
    status: "return requested",
    email: false,
    smsOff: true,
  },
  ORDER_RETURN_APPROVED: {
    line: (o, p = {}) =>
      p.reopened
        ? `Your return for order ${o.orderNumber} has been reopened after your dispute. Please keep the items packed for pickup.`
        : p.autoApproved
          ? `Your return for order ${o.orderNumber} has been approved automatically because the seller did not respond in time. Please keep the items packed for pickup.`
          : `Your return for order ${o.orderNumber} has been approved. Please keep the items packed for pickup or hand them back to the seller.`,
    sms: "ORDER_STATUS",
    status: "return approved",
  },
  ORDER_RETURN_REJECTED: {
    line: (o, p) =>
      `Your return request for order ${o.orderNumber} was not accepted by the seller.${p.reason ? ` Reason: ${p.reason}` : ""} If you disagree, you can open a dispute from the order page.`,
    sms: "ORDER_STATUS",
    status: "return rejected",
  },
  ORDER_RETURN_PICKUP_SCHEDULED: {
    line: (o, p = {}) =>
      p.pickupMethod === "own_fleet"
        ? `A pickup has been arranged for your return of order ${o.orderNumber}; the seller's delivery rider will collect it. Please keep the items packed.`
        : `A pickup has been booked for your return of order ${o.orderNumber}${p.carrier ? ` with ${p.carrier}` : ""}${p.trackingNumber ? ` (AWB ${p.trackingNumber})` : ""}. Please keep the items packed.`,
    sms: "ORDER_STATUS",
    status: "return pickup booked",
  },
  ORDER_RETURN_PICKUP_FAILED: {
    line: (o, p = {}) =>
      `We could not pick up your return for order ${o.orderNumber}${p.reason ? ` (${p.reason})` : ""}, so the return was closed. If you still want to return the items, open a dispute from the order page.`,
    sms: "ORDER_STATUS",
    status: "return pickup failed",
  },
  ORDER_RETURN_QC_REJECTED: {
    line: (o, p = {}) =>
      `The seller inspected your returned items for order ${o.orderNumber} and did not accept ${p.rejectedQty || "some"} unit(s)${p.reason ? `: ${p.reason}` : "."}${
        p.partial ? " The accepted items are being refunded." : " No refund was issued."
      }${p.disposition === "return_to_buyer" ? " The rejected items will be sent back to you." : ""} If you disagree, you can open a dispute from the order page.`,
    sms: "ORDER_STATUS",
    status: "return items not accepted",
  },
  ORDER_RETURNED: {
    line: (o, p) =>
      p.refundAmount > 0
        ? `The seller received your returned items for order ${o.orderNumber}. A refund of ${moneyOf(p, o)} has been initiated and will be paid ${refundRoute(p)}.`
        : `The seller received your returned items for order ${o.orderNumber}.`,
    sms: "ORDER_STATUS",
    status: "return received",
  },
  ORDER_RTO_IN_TRANSIT: {
    line: (o) => `The courier could not deliver order ${o.orderNumber} and is returning it to the seller.`,
    sms: "ORDER_STATUS",
    status: "returning to seller",
  },
  ORDER_RETURNED_TO_ORIGIN: {
    line: (o, p) =>
      !(["upi", "card", "netbanking"].includes(p.order?.paymentMethod) && p.order?.paymentStatus === "paid")
        ? `Order ${o.orderNumber} was returned to the seller and has been closed.`
        : `Order ${o.orderNumber} was returned to the seller. A refund of ${formatInr(o.total)} has been initiated to your original payment method.`,
    sms: "ORDER_STATUS",
    status: "returned to seller",
  },
};

/** Deadline auto-cancels (orders/sla.js SLA_CANCEL_REASONS). */
const SLA_REASONS = ["seller_timeout", "ship_timeout"];

function dateTimeText(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

const STAFF_ORDER_EVENTS = {
  ORDER_CREATED: { title: "New order", line: (o) => `New order ${o.orderNumber} (${formatInr(o.total)}).`, priority: "high" },
  ORDER_CANCELLED: {
    title: "Order cancelled",
    line: (o, p) => `Order ${o.orderNumber} was cancelled${p.cancelledBy === "buyer" ? " by the buyer" : ""}.`,
    skip: (p) => SLA_REASONS.includes(p.cancelReason),
  },
  ORDER_AUTO_CANCELLED: {
    title: "Order auto-cancelled",
    line: (o, p = {}) =>
      `Order ${o.orderNumber} was cancelled automatically because it was not ${p.cancelReason === "ship_timeout" ? "shipped" : "confirmed"} in time. Stock has been released; this counts against your seller scorecard.`,
    priority: "high",
    email: true,
  },
  ORDER_RETURN_APPROVED: {
    title: "Return auto-approved",
    line: (o) => `The return request for order ${o.orderNumber} was approved automatically because it was not decided in time. This counts against your seller scorecard.`,
    priority: "high",
    email: true,
    skip: (p) => !p.autoApproved,
  },
  ORDER_RETURN_PICKUP_FAILED: {
    title: "Return pickup failed",
    line: (o, p) => `The return pickup for order ${o.orderNumber} failed${p.reason ? ` (${p.reason})` : ""}; the return was closed. The buyer may open a dispute.`,
  },
  ORDER_RTO_IN_TRANSIT: {
    title: "Parcel returning",
    line: (o) => `The courier could not deliver order ${o.orderNumber} and is bringing it back. Mark it returned once it reaches you.`,
    priority: "high",
  },
  ORDER_RETURNED_TO_ORIGIN: {
    title: "Returned to you",
    line: (o) => `Order ${o.orderNumber} is back with you; stock was restored.`,
  },
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
      if (!o.buyerId || spec.skip?.(p)) return;
      const body = spec.line(o, p);
      const data = { ...orderData(o), ...(p.returnId ? { returnId: p.returnId } : {}), ...(p.disputeId ? { disputeId: p.disputeId } : {}) };
      await persistAndPush({ userId: o.buyerId, tenantId: o.tenantId, event, body, data, category: "order" });
      await deliverToUser(o.buyerId, {
        category: "order",
        email:
          spec.email === false
            ? null
            : { subject: `${TITLES[event]} – ${o.orderNumber}`, heading: TITLES[event], lines: [body], cta: { label: "View order", url: orderUrl(o.orderId) } },
        sms: spec.smsOff ? null : { kind: spec.sms, vars: { order: o.orderNumber, amount: o.total ?? "", status: spec.status } },
      });
    });
  }

  for (const [event, spec] of Object.entries(STAFF_ORDER_EVENTS)) {
    onDurable(event, `notify.staff.${event}`, async (p) => {
      const o = orderFromPayload(p);
      if (!o.tenantId || spec.skip?.(p)) return;
      const body = spec.line(o, p);
      await persistAndPush({
        tenantId: o.tenantId,
        event: event === "ORDER_CREATED" ? "NEW_ORDER" : event,
        title: spec.title,
        body,
        data: orderData(o),
        audience: { type: "staff" },
        priority: spec.priority || "normal",
        category: "order",
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

  // Payment failed: Razorpay payment.failed marks pending orders paymentStatus "failed" and emits
  // PAYMENT_FAILED. One notice per order per 30 minutes.
  const notifyPaymentFailed = async (p) => {
    const o = orderFromPayload(p);
    if (!o.buyerId || !o.orderId) return;
    const recent = await Notification.exists({
      userId: o.buyerId,
      event: "PAYMENT_FAILED",
      "data.orderId": o.orderId,
      createdAt: { $gt: new Date(Date.now() - 30 * 60 * 1000) },
    });
    if (recent) return;
    const body = `The payment for order ${o.orderNumber} did not go through. No money was taken; you can retry the payment from the order page before the order expires.`;
    await persistAndPush({ userId: o.buyerId, tenantId: o.tenantId, event: "PAYMENT_FAILED", body, data: orderData(o), category: "order", priority: "high" });
    await deliverToUser(o.buyerId, {
      category: "order",
      email: { subject: `Payment failed – ${o.orderNumber}`, heading: "Payment failed", lines: [body], cta: { label: "Retry payment", url: orderUrl(o.orderId) } },
    });
  };
  // Razorpay payment.failed emits PAYMENT_FAILED explicitly (checkout/razorpay.js), so there is no
  // ORDER_UPDATED fallback here: two listeners racing on the dedupe check could double-notify.
  onDurable("PAYMENT_FAILED", "notify.buyer.PAYMENT_FAILED", notifyPaymentFailed);

  // Platform alerts (super admins): money that needs a human.
  onDurable("REFUND_FAILED", "notify.admin.REFUND_FAILED", (p) =>
    persistAndPush({
      tenantId: null,
      event: "REFUND_FAILED",
      body: `Refund of ${formatInr(p.amount)} for order ${p.orderNumber || ""} failed after ${p.attempts || "several"} attempts${p.error ? `: ${p.error}` : ""}. Retry it from the refunds list.`,
      data: { orderId: p.orderId, orderNumber: p.orderNumber, key: p.key, tenantId: p.tenantId },
      audience: { type: "role", roleSlug: "super_admin" },
      priority: "high",
      category: "order",
    })
  );
  onDurable("PAYMENT_MISMATCH", "notify.admin.PAYMENT_MISMATCH", (p) =>
    persistAndPush({
      tenantId: null,
      event: "PAYMENT_MISMATCH",
      body: `Razorpay payment ${p.razorpayPaymentId || ""} captured ${formatInr((Number(p.amountPaise) || 0) / 100)} but ${formatInr((Number(p.expected) || 0) / 100)} was expected (Razorpay order ${p.razorpayOrderId || ""}). A refund was queued automatically; please check it.`,
      data: { razorpayOrderId: p.razorpayOrderId, razorpayPaymentId: p.razorpayPaymentId, amountPaise: p.amountPaise, expected: p.expected },
      audience: { type: "role", roleSlug: "super_admin" },
      priority: "high",
      category: "order",
    })
  );

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

  // QA R3: the platform turned an offer down. In-app to store staff + email to offer managers.
  onDurable("OFFER_REJECTED", "notify.staff.OFFER_REJECTED", async (p) => {
    const tenantId = idOf(p.tenantId);
    if (!tenantId) return;
    const title = "Offer not approved";
    const body = `Your offer "${p.name || "Offer"}" was not approved.${p.reason ? `\nReason: ${p.reason}` : ""}`;
    await persistAndPush({
      tenantId,
      event: "OFFER_REJECTED",
      title,
      body,
      data: { offerId: p.offerId || p.resourceId, name: p.name, reason: p.reason || "" },
      audience: { type: "staff" },
      priority: "high",
      category: "account",
    });
    const staff = await tenantUsersWith(tenantId, ["offers.create", "offers.edit"]);
    for (const u of staff) {
      await deliverToUser(u._id, {
        category: "account",
        email: {
          subject: `${title}: ${p.name || "Offer"}`,
          heading: title,
          lines: [body, "Edit the offer and request approval again, or leave it as it is."],
          cta: { label: "Open offers", url: frontendLink("/tenant/offers") },
        },
      });
    }
  });

  registerTenantStateListeners();
  // Seller onboarding (SELLER_APPLIED / SUBMITTED / MORE_INFO / APPROVED / REJECTED): applicant + admin alerts.
  registerSellerApplicationListeners();
  // Seller subscription billing (SUBSCRIPTION_*): store admins.
  registerSubscriptionListeners();
  // Seller payouts (PAYOUT_*, LINKED_ACCOUNT_*, PAYOUTS_HELD): store admins / payouts.view staff (+ admins on failure).
  registerPayoutListeners();
  // Own delivery fleet (phase 5): rider assignments, rejections, failed attempts.
  registerFleetListeners();
  // Phase 6: deadlines, refund alerts, disputes.
  registerPhase6Listeners();

  runStartupTasks().catch((err) => console.error("[notify] startup tasks failed", err.message));
}

/* ------------- tenant state / FSSAI / admin access (p2-states) ------------- */

const TENANT_STATE_TEXT = {
  TENANT_PAUSED: {
    title: "Store paused",
    subject: "Your store has been paused",
    line: "Your store is paused and hidden from buyers. You can still manage existing orders, returns and support.",
    status: "paused",
  },
  TENANT_RESUMED: {
    title: "Store resumed",
    subject: "Your store is live again",
    line: "Your store has been resumed and is visible to buyers again.",
    status: "active",
  },
  TENANT_SUSPENDED: {
    title: "Store suspended",
    subject: "Your store has been suspended",
    line: "Your store has been suspended by the platform. Contact support for details.",
    status: "suspended",
  },
  TENANT_REACTIVATED: {
    title: "Store reactivated",
    subject: "Your store has been reactivated",
    line: "Your store has been reactivated and is visible to buyers again.",
    status: "active",
  },
  TENANT_ARCHIVED: {
    title: "Store closed",
    subject: "Your store has been closed",
    line: "Your store has been archived (closed) by the platform. Contact support for details.",
    status: "archived",
  },
};

function dateText(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

/** In-app + email (+ account SMS) to every store admin (incl. suspended members: they can't log in). */
async function notifyStoreAdmins(tenantId, { event, title, body, lines = [], subject, priority = "high", data = {}, sms = null }) {
  const admins = await tenantUsersWith(tenantId, ["settings.edit"], { includeSuspended: true });
  for (const u of admins) {
    await persistAndPush({ userId: u._id, tenantId, event, title, body, priority, category: "account", data });
    await deliverToUser(u._id, {
      category: "account",
      email: { subject, heading: title, lines: [body, ...lines].filter(Boolean) },
      sms,
    });
  }
}

function registerTenantStateListeners() {
  for (const [event, text] of Object.entries(TENANT_STATE_TEXT)) {
    onDurable(event, `notify.${event}`, async (p) => {
      const tenantId = idOf(p.tenantId);
      if (!tenantId) return;
      // Billing-driven pause/resume: the SUBSCRIPTION_* notice already tells the seller (no duplicate).
      if (p.source === "billing" && (event === "TENANT_PAUSED" || event === "TENANT_RESUMED")) return;
      await notifyStoreAdmins(tenantId, {
        event,
        title: text.title,
        subject: text.subject,
        body: p.reason ? `${text.line} Reason: ${p.reason}` : text.line,
        data: { status: p.to || p.status, from: p.from, reason: p.reason || "" },
        priority: event === "TENANT_RESUMED" || event === "TENANT_REACTIVATED" ? "normal" : "high",
        sms: { kind: "ACCOUNT_ALERT", vars: { status: text.status, message: text.title } },
      });
    });
  }

  onDurable("TENANT_IDENTITY_CORRECTED", "notify.TENANT_IDENTITY_CORRECTED", async (p) => {
    const tenantId = idOf(p.tenantId);
    if (!tenantId) return;
    const lines = [];
    if (p.from?.legalName !== p.to?.legalName) lines.push(`Legal name: ${p.from?.legalName || "—"} → ${p.to?.legalName || "—"}`);
    if (p.from?.gstin !== p.to?.gstin) lines.push(`GSTIN: ${p.from?.gstin || "—"} → ${p.to?.gstin || "—"}`);
    lines.push(`Reason: ${p.reason || "—"}`);
    await notifyStoreAdmins(tenantId, {
      event: "TENANT_IDENTITY_CORRECTED",
      title: "Store identity corrected",
      subject: "The marketplace corrected your store's legal details",
      body: `The marketplace team corrected your store's legal details. ${lines.join(" · ")}. New invoices use the corrected details; contact support if this looks wrong.`,
      lines,
      data: { from: p.from, to: p.to },
    });
  });

  onDurable("FSSAI_EXPIRING", "notify.FSSAI_EXPIRING", async (p) => {
    const tenantId = idOf(p.tenantId);
    if (!tenantId) return;
    const days = Number(p.daysLeft) || 0;
    await notifyStoreAdmins(tenantId, {
      event: "FSSAI_EXPIRING",
      title: "FSSAI licence expiring",
      subject: `Your FSSAI licence expires in ${days} day${days === 1 ? "" : "s"}`,
      body: `Your FSSAI licence ${p.number || ""} expires on ${dateText(p.expiresAt)}. Renew it and send the new licence to the platform team, or your food products will be hidden.`,
      data: { daysLeft: days, expiresAt: p.expiresAt },
      priority: days <= 7 ? "high" : "normal",
    });
  });

  onDurable("FSSAI_EXPIRED", "notify.FSSAI_EXPIRED", async (p) => {
    const tenantId = idOf(p.tenantId);
    if (!tenantId) return;
    await notifyStoreAdmins(tenantId, {
      event: "FSSAI_EXPIRED",
      title: "FSSAI licence expired",
      subject: "Your FSSAI licence has expired: food products hidden",
      body: `Your FSSAI licence ${p.number || ""} expired on ${dateText(p.expiresAt)}. Your food products are hidden from buyers until the renewed licence is recorded.`,
      data: { expiresAt: p.expiresAt },
    });
  });

  onDurable("FSSAI_RENEWED", "notify.FSSAI_RENEWED", async (p) => {
    const tenantId = idOf(p.tenantId);
    if (!tenantId) return;
    await notifyStoreAdmins(tenantId, {
      event: "FSSAI_RENEWED",
      title: "FSSAI licence renewed",
      subject: "Your food products are visible again",
      body: `Your renewed FSSAI licence (valid until ${dateText(p.expiresAt)}) is on file. Your food products are visible to buyers again.`,
      data: { expiresAt: p.expiresAt },
      priority: "normal",
    });
  });

  // Debounced at the source (tenantScope: one per admin per store per 30 min).
  onDurable("TENANT_ADMIN_ACCESS", "notify.TENANT_ADMIN_ACCESS", async (p) => {
    const tenantId = idOf(p.tenantId);
    if (!tenantId) return;
    await notifyStoreAdmins(tenantId, {
      event: "TENANT_ADMIN_ACCESS",
      title: "Platform admin made changes",
      subject: "A platform admin made changes in your store",
      body: `${p.adminName || "A platform admin"} made changes in your store. Reason: ${p.reason || "-"}`,
      lines: ["You can review every platform-admin access in Settings > Access log."],
      data: { adminId: p.adminId, method: p.method, path: p.path, reason: p.reason || "" },
      priority: "normal",
    });
  });
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

/* ===================================================================================== */
/* Seller onboarding notifications (phase 2, p2-onboarding). Kept separate on purpose.     */
/* ===================================================================================== */
import { SELLER_EVENTS } from "../../config/constants.js";
import { frontendLink } from "../../utils/links.js";

function sellerApplicationUrl() {
  const raw = String(process.env.FRONTEND_SELLER_APPLICATION_PATH || "/seller/application").trim();
  return frontendLink(raw.startsWith("/") ? raw : `/${raw}`);
}

function sellerDate(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }) : "";
}

/** In-app + email to the applicant (category "account": email cannot be switched off). */
async function notifySellerApplicant(p, event, { title, body, lines = [], cta = null, priority = "normal" }) {
  if (!p?.userId) return;
  await persistAndPush({
    userId: p.userId,
    event,
    title,
    // The reviewer's message / reject reason belongs in the in-app text too, not only the email.
    body: [body, ...lines].filter(Boolean).join("\n"),
    data: { applicationId: p.applicationId, tenantId: p.tenantId || null },
    priority,
    category: "account",
  });
  await deliverToUser(p.userId, { category: "account", email: { subject: title, heading: title, lines: [body, ...lines].filter(Boolean), cta } });
}

export function registerSellerApplicationListeners() {
  onDurable(SELLER_EVENTS.APPLIED, "notify.seller.APPLIED", (p) =>
    notifySellerApplicant(p, SELLER_EVENTS.APPLIED, {
      title: "Welcome to MS₹ selling",
      body: "Your seller account is ready. Verify your email (we sent you a link), then complete your application: business and GST details, PAN, bank account, pickup address and KYC documents.",
      cta: { label: "Continue application", url: sellerApplicationUrl() },
    })
  );

  onDurable(SELLER_EVENTS.SUBMITTED, "notify.seller.SUBMITTED", (p) =>
    notifySellerApplicant(p, SELLER_EVENTS.SUBMITTED, {
      title: p.resubmitted ? "Application resubmitted" : "Application submitted",
      body: "Thanks! We have received your seller application. Our team will review it and get back to you, usually within 2-3 working days.",
      cta: { label: "View application", url: sellerApplicationUrl() },
    })
  );

  onDurable(SELLER_EVENTS.SUBMITTED, "notify.admin.SELLER_SUBMITTED", async (p) => {
    const body = `${p.businessName || p.email || "A seller"} ${p.resubmitted ? "resubmitted" : "submitted"} a seller application${p.duplicates ? ` (${p.duplicates} possible duplicate${p.duplicates === 1 ? "" : "s"} flagged)` : ""}.`;
    const title = "New seller application";
    await persistAndPush({
      tenantId: null,
      event: SELLER_EVENTS.SUBMITTED,
      title,
      body,
      data: { applicationId: p.applicationId },
      audience: { type: "role", roleSlug: "super_admin" },
      priority: "high",
      category: "account",
    });
    const roles = await Role.find({ isSystem: true, scope: "platform" }).select("_id").lean();
    const admins = roles.length
      ? await User.find({ roleId: { $in: roles.map((r) => r._id) }, status: "active" }).select("_id").limit(50).lean()
      : [];
    for (const u of admins) {
      await deliverToUser(u._id, { category: "account", email: { subject: title, heading: title, lines: [body, "Review it in the admin panel under Seller applications."] } });
    }
  });

  onDurable(SELLER_EVENTS.MORE_INFO, "notify.seller.MORE_INFO", (p) =>
    notifySellerApplicant(p, SELLER_EVENTS.MORE_INFO, {
      title: "More information needed",
      body: "Our team needs a few changes before approving your seller application.",
      lines: [p.message ? `Request: ${p.message}` : "", "Update your application and submit it again."],
      cta: { label: "Update application", url: sellerApplicationUrl() },
      priority: "high",
    })
  );

  onDurable(SELLER_EVENTS.APPROVED, "notify.seller.APPROVED", async (p) => {
    // Phase 3 billing: an approved store waits for its first subscription payment (store paused).
    const { TenantSubscription } = await import("../billing/subscription.model.js");
    const sub = p.tenantId ? await TenantSubscription.findOne({ tenantId: idOf(p.tenantId) }).select("status planSnapshot").lean() : null;
    const awaiting = sub?.status === "awaiting_payment";
    return notifySellerApplicant(p, SELLER_EVENTS.APPROVED, {
      title: "Your seller account is approved",
      body: `Welcome aboard! ${p.businessName ? `${p.businessName} is` : "Your store is"} now set up on MS₹. Sign in to add products, set up warehouses and start selling.`,
      lines: awaiting
        ? [
            `Next step: pay your first subscription invoice${sub.planSnapshot?.name ? ` (${sub.planSnapshot.name} plan)` : ""} under Billing in the seller panel. Your store stays paused (hidden from buyers) until it is paid.`,
          ]
        : [],
      cta: { label: "Sign in", url: frontendLink("/login") },
      priority: "high",
    });
  });

  onDurable(SELLER_EVENTS.REJECTED, "notify.seller.REJECTED", (p) =>
    notifySellerApplicant(p, SELLER_EVENTS.REJECTED, {
      title: "Seller application not approved",
      body: "We could not approve your seller application.",
      lines: [p.reason ? `Reason: ${p.reason}` : "", p.reapplyAfter ? `You can apply again from ${sellerDate(p.reapplyAfter)}.` : ""],
      cta: { label: "View details", url: sellerApplicationUrl() },
      priority: "high",
    })
  );
}

/* ===================================================================================== */
/* Seller subscription billing (p3-billing): SUBSCRIPTION_* -> store admins (in-app + email). */
/* ===================================================================================== */

function billingUrl() {
  const raw = String(process.env.FRONTEND_SELLER_BILLING_PATH || "/tenant/billing").trim();
  return frontendLink(raw.startsWith("/") ? raw : `/${raw}`);
}

async function notifyBilling(p, event, { title, body, lines = [], priority = "normal", data = {} }) {
  const tenantId = idOf(p?.tenantId);
  if (!tenantId) return;
  const admins = await tenantUsersWith(tenantId, ["settings.edit"], { includeSuspended: true });
  const cta = { label: "Open billing", url: billingUrl() };
  for (const u of admins) {
    await persistAndPush({ userId: u._id, tenantId, event, title, body, priority, category: "account", data });
    await deliverToUser(u._id, { category: "account", email: { subject: title, heading: title, lines: [body, ...lines].filter(Boolean), cta } });
  }
}

export function registerSubscriptionListeners() {
  onDurable("SUBSCRIPTION_INVOICE_ISSUED", "notify.SUBSCRIPTION_INVOICE_ISSUED", (p) =>
    notifyBilling(p, "SUBSCRIPTION_INVOICE_ISSUED", {
      title: `Subscription invoice ${p.number || ""}`.trim(),
      body: `Invoice ${p.number || ""} for ${formatInr(p.total)} (incl. GST) is due on ${sellerDate(p.dueAt)}.`,
      lines: [p.kind === "first" ? "Your store goes live as soon as this invoice is paid." : "Pay online from Billing, or by bank transfer quoting the invoice number."],
      data: { invoiceId: p.invoiceId, number: p.number, total: p.total, dueAt: p.dueAt, kind: p.kind },
    })
  );
  onDurable("SUBSCRIPTION_PAYMENT_RECEIVED", "notify.SUBSCRIPTION_PAYMENT_RECEIVED", (p) =>
    notifyBilling(p, "SUBSCRIPTION_PAYMENT_RECEIVED", {
      title: "Subscription payment received",
      body: `We received ${formatInr(p.total)} for invoice ${p.number || ""}. Thank you!`,
      lines: ["The GST invoice is available under Billing."],
      data: { invoiceId: p.invoiceId, number: p.number, total: p.total, method: p.method },
    })
  );
  onDurable("SUBSCRIPTION_PAYMENT_FAILED", "notify.SUBSCRIPTION_PAYMENT_FAILED", (p) =>
    notifyBilling(p, "SUBSCRIPTION_PAYMENT_FAILED", {
      title: "Subscription payment failed",
      body: p.reason || "Your subscription payment did not go through.",
      priority: "high",
      data: { final: Boolean(p.final) },
    })
  );
  onDurable("SUBSCRIPTION_PAST_DUE", "notify.SUBSCRIPTION_PAST_DUE", (p) => {
    const day = Number(p.day) || 0;
    const needsPlan = Boolean(p.needsPlan);
    return notifyBilling(p, "SUBSCRIPTION_PAST_DUE", {
      title: day === 0 ? "Subscription payment due" : `Reminder: subscription payment overdue (${day} days)`,
      body: needsPlan
        ? `Your free legacy plan has ended. Choose a plan and pay by ${sellerDate(p.graceEndsAt)} to keep your store live.`
        : `Your subscription renewal${p.amount ? ` of ${formatInr(p.amount)}` : ""} is unpaid. Pay by ${sellerDate(p.graceEndsAt)} or your store will be paused.`,
      priority: "high",
      data: { day, graceEndsAt: p.graceEndsAt, amount: p.amount || 0, needsPlan },
    });
  });
  onDurable("SUBSCRIPTION_PAUSED", "notify.SUBSCRIPTION_PAUSED", (p) =>
    notifyBilling(p, "SUBSCRIPTION_PAUSED", {
      title: "Store paused: subscription unpaid",
      body: `Your store is paused because the subscription payment is overdue${p.amount ? ` (${formatInr(p.amount)} outstanding)` : ""}. Pay the open invoice to go live again right away.`,
      priority: "high",
      data: { reason: p.reason || "", amount: p.amount || 0 },
    })
  );
  onDurable("SUBSCRIPTION_RESUMED", "notify.SUBSCRIPTION_RESUMED", (p) =>
    notifyBilling(p, "SUBSCRIPTION_RESUMED", {
      title: "Subscription active again",
      body: p.storeResumed ? "Thanks for your payment. Your subscription is active and your store is live again." : "Your subscription is active again.",
      data: { storeResumed: Boolean(p.storeResumed) },
    })
  );
  onDurable("SUBSCRIPTION_PLAN_CHANGED", "notify.SUBSCRIPTION_PLAN_CHANGED", (p) =>
    notifyBilling(p, "SUBSCRIPTION_PLAN_CHANGED", {
      title: "Subscription plan changed",
      body:
        p.effective === "renewal"
          ? `Your plan changes from ${p.from || "-"} to ${p.to || "-"} at your next renewal${p.at ? ` (${sellerDate(p.at)})` : ""}.`
          : `Your plan is now ${p.to || "-"} (was ${p.from || "-"}).`,
      data: { from: p.from || "", to: p.to || "", effective: p.effective || "now" },
    })
  );
  onDurable("SUBSCRIPTION_LEGACY_ENDING", "notify.SUBSCRIPTION_LEGACY_ENDING", (p) =>
    notifyBilling(p, "SUBSCRIPTION_LEGACY_ENDING", {
      title: "Your free legacy plan ends soon",
      body: `Your free legacy plan ends on ${sellerDate(p.legacyUntil)} (${p.daysLeft} day${Number(p.daysLeft) === 1 ? "" : "s"} left). Choose a subscription plan to keep selling without interruption.`,
      priority: Number(p.daysLeft) <= 3 ? "high" : "normal",
      data: { legacyUntil: p.legacyUntil, daysLeft: p.daysLeft },
    })
  );
}

/* ------------------------------------------------------------- seller payouts (p4-payouts) */

function payoutsUrl() {
  const raw = String(process.env.FRONTEND_SELLER_PAYOUTS_PATH || "/tenant/payouts").trim();
  return frontendLink(raw.startsWith("/") ? raw : `/${raw}`);
}

async function notifyPayouts(p, event, { title, body, lines = [], priority = "normal", data = {} }) {
  const tenantId = idOf(p?.tenantId);
  if (!tenantId) return;
  const staff = await tenantUsersWith(tenantId, ["payouts.view"], { includeSuspended: false });
  const cta = { label: "Open payouts", url: payoutsUrl() };
  for (const u of staff) {
    await persistAndPush({ userId: u._id, tenantId, event, title, body, priority, category: "account", data });
    await deliverToUser(u._id, { category: "account", email: { subject: title, heading: title, lines: [body, ...lines].filter(Boolean), cta } });
  }
}

const paise = (v) => formatInr((Number(v) || 0) / 100);

export function registerPayoutListeners() {
  onDurable("PAYOUT_PAID", "notify.PAYOUT_PAID", (p) =>
    notifyPayouts(p, "PAYOUT_PAID", {
      title: `Payout ${p.number || ""} sent`.trim(),
      body: `${paise(p.amountPaise)} was paid to your bank account${p.reference ? ` (reference ${p.reference})` : ""}.`,
      lines: ["The statement under Payouts lists every order, fee and deduction in this payout."],
      data: { payoutId: p.payoutId, number: p.number, amountPaise: p.amountPaise, reference: p.reference || "" },
    })
  );
  onDurable("PAYOUT_FAILED", "notify.seller.PAYOUT_FAILED", (p) =>
    notifyPayouts(p, "PAYOUT_FAILED", {
      title: `Payout ${p.number || ""} failed`.trim(),
      body: `Your payout of ${paise(p.amountPaise)} could not be completed. ${p.recredited ? "The amount is back in your balance and will be paid in the next run." : "Our team is looking into it."}`,
      priority: "high",
      data: { payoutId: p.payoutId, number: p.number, amountPaise: p.amountPaise },
    })
  );
  onDurable("PAYOUT_FAILED", "notify.admin.PAYOUT_FAILED", (p) =>
    persistAndPush({
      tenantId: null,
      event: "PAYOUT_FAILED",
      title: "Seller payout failed",
      body: `Payout ${p.number || ""} of ${paise(p.amountPaise)} failed${p.reason ? `: ${p.reason}` : ""}. Retry, mark paid or cancel it under Payouts.`,
      data: { payoutId: p.payoutId, number: p.number, tenantId: p.tenantId, amountPaise: p.amountPaise },
      audience: { type: "role", roleSlug: "super_admin" },
      priority: "high",
      category: "account",
    })
  );
  onDurable("LINKED_ACCOUNT_ACTIVATED", "notify.LINKED_ACCOUNT_ACTIVATED", (p) =>
    notifyPayouts(p, "LINKED_ACCOUNT_ACTIVATED", {
      title: "Payout account activated",
      body: "Your Razorpay payout account is active. Payouts for completed orders now go straight to your bank account.",
      data: { accountId: p.accountId || "" },
    })
  );
  onDurable("LINKED_ACCOUNT_NEEDS_CLARIFICATION", "notify.LINKED_ACCOUNT_NEEDS_CLARIFICATION", (p) =>
    notifyPayouts(p, "LINKED_ACCOUNT_NEEDS_CLARIFICATION", {
      title: "Payout account needs more details",
      body: "Razorpay needs more information before your payout account can be activated. Please contact platform support with the details requested.",
      priority: "high",
      data: { accountId: p.accountId || "", requirements: (p.requirements || []).slice(0, 20) },
    })
  );
  onDurable("PAYOUTS_HELD", "notify.PAYOUTS_HELD", (p) =>
    notifyPayouts(p, "PAYOUTS_HELD", {
      title: "Payouts on hold",
      body: `The platform has put your payouts on hold${p.reason ? `: ${p.reason}` : ""}. Your balance is kept and paid once the hold is lifted.`,
      priority: "high",
      data: { reason: p.reason || "" },
    })
  );
}

/* ------------------------------- own delivery fleet (phase 5) ------------------------------- */

function registerFleetListeners() {
  // The rider's in-app inbox (the rider app polls; push comes in phase 6).
  onDurable("RIDER_ASSIGNED", "notify.rider.RIDER_ASSIGNED", async (p) => {
    if (!p.riderUserId) return;
    const what = p.kind === "return_pickup" ? "return pickup" : "delivery";
    await persistAndPush({
      userId: p.riderUserId,
      tenantId: p.tenantId,
      event: "RIDER_ASSIGNED",
      body: `New ${what} assigned to you: order ${p.orderNumber || ""}. Open the app to accept it.`,
      data: { taskId: p.taskId, orderId: p.orderId, orderNumber: p.orderNumber, kind: p.kind },
      category: "order",
      priority: "high",
    });
  });
  onDurable("RIDER_REJECTED_TASK", "notify.staff.RIDER_REJECTED_TASK", async (p) => {
    if (!p.tenantId) return;
    await persistAndPush({
      tenantId: p.tenantId,
      event: "RIDER_REJECTED_TASK",
      body: `${p.riderName || "A rider"} rejected the delivery of order ${p.orderNumber || ""}${p.reason ? ` (${p.reason})` : ""}. Assign it to another rider.`,
      data: { taskId: p.taskId, orderId: p.orderId, orderNumber: p.orderNumber },
      audience: { type: "staff" },
      priority: "high",
      category: "order",
    });
  });
  onDurable("DELIVERY_METHOD_CHANGED", "notify.buyer.DELIVERY_METHOD_CHANGED", async (p) => {
    const o = orderFromPayload(p);
    if (!o.buyerId) return;
    const body = `Order ${o.orderNumber} will now be delivered by the seller's courier instead of their own rider. You don't need to do anything; you'll get tracking details once it ships.`;
    await persistAndPush({ userId: o.buyerId, tenantId: o.tenantId, event: "DELIVERY_METHOD_CHANGED", body, data: orderData(o), category: "order" });
    await deliverToUser(o.buyerId, {
      category: "order",
      email: { subject: `${TITLES.DELIVERY_METHOD_CHANGED} – ${o.orderNumber}`, heading: TITLES.DELIVERY_METHOD_CHANGED, lines: [body], cta: { label: "View order", url: orderUrl(o.orderId) } },
    });
  });
  onDurable("DELIVERY_ATTEMPT_FAILED", "notify.buyer.DELIVERY_ATTEMPT_FAILED", async (p) => {
    const o = orderFromPayload(p);
    if (!o.buyerId) return;
    const body = p.final
      ? `We could not deliver order ${o.orderNumber} (${p.reasonLabel || "delivery failed"}) after ${p.attempt} attempts. It is going back to the seller.`
      : `We could not deliver order ${o.orderNumber} today (${p.reasonLabel || "delivery failed"}). We will try again${p.rescheduledFor ? ` on ${p.rescheduledFor}` : " tomorrow"}; there is no extra delivery charge.`;
    await persistAndPush({ userId: o.buyerId, tenantId: o.tenantId, event: "DELIVERY_ATTEMPT_FAILED", body, data: { ...orderData(o), attempt: p.attempt, final: Boolean(p.final) }, category: "order", priority: "high" });
    await deliverToUser(o.buyerId, {
      category: "order",
      email: { subject: `${TITLES.DELIVERY_ATTEMPT_FAILED} – ${o.orderNumber}`, heading: TITLES.DELIVERY_ATTEMPT_FAILED, lines: [body], cta: { label: "View order", url: orderUrl(o.orderId) } },
      sms: { kind: "ORDER_STATUS", vars: { order: o.orderNumber, amount: o.total ?? "", status: "delivery attempt failed" } },
    });
    if (p.final && o.tenantId) {
      await persistAndPush({
        tenantId: o.tenantId,
        event: "DELIVERY_ATTEMPT_FAILED",
        title: "Delivery failed",
        body: `Order ${o.orderNumber} could not be delivered after ${p.attempt} attempts; the rider is bringing it back.`,
        data: orderData(o),
        audience: { type: "staff" },
        priority: "high",
        category: "order",
      });
    }
  });
}

/* ------------------------------- phase 6: deadlines, refunds, disputes ------------------------------- */

function disputeUrl(id, { staff = false, admin = false } = {}) {
  if (admin) return frontendLink(`/admin/disputes/${id}`);
  return frontendLink(staff ? `/tenant/disputes/${id}` : `/account/disputes/${id}`);
}

function disputeData(p) {
  return { disputeId: p.disputeId, orderId: p.orderId, orderNumber: p.orderNumber, returnId: p.returnId, status: p.status };
}

async function notifyDisputeBuyer(p, event, body, { title, sms = false, priority = "normal" } = {}) {
  if (!p.buyerId) return;
  await persistAndPush({ userId: p.buyerId, tenantId: p.tenantId, event, title, body, data: disputeData(p), category: "order", priority });
  await deliverToUser(p.buyerId, {
    category: "order",
    email: { subject: `${title || TITLES[event]} – ${p.number || p.orderNumber || ""}`, heading: title || TITLES[event], lines: [body], cta: { label: "View dispute", url: disputeUrl(p.disputeId) } },
    sms: sms ? { kind: "ORDER_STATUS", vars: { order: p.orderNumber || "", amount: p.amount ?? "", status: String(sms) } } : null,
  });
}

async function notifyDisputeStaff(p, event, body, { title, email = false, priority = "normal" } = {}) {
  if (!p.tenantId) return;
  await persistAndPush({
    tenantId: p.tenantId,
    event,
    title: title || TITLES[event],
    body,
    data: disputeData(p),
    audience: { type: "staff" },
    priority,
    category: "order",
  });
  if (!email) return;
  const staff = await tenantUsersWith(p.tenantId, ["returns.manage", "orders.refund"]);
  for (const u of staff) {
    await deliverToUser(u._id, {
      category: "order",
      email: { subject: `${title || TITLES[event]} – ${p.number || ""}`, heading: title || TITLES[event], lines: [body], cta: { label: "Open dispute", url: disputeUrl(p.disputeId, { staff: true }) } },
    });
  }
}

function adminAlert(event, body, data, priority = "high") {
  return persistAndPush({ tenantId: null, event, body, data, audience: { type: "role", roleSlug: "super_admin" }, priority, category: "order" });
}

const DEADLINE_TEXT = {
  confirm: (p) => `Order ${p.orderNumber} must be confirmed by ${dateTimeText(p.dueAt)} or it is cancelled automatically.`,
  ship: (p) => `Order ${p.orderNumber} must be shipped by ${dateTimeText(p.dueAt)} or it is cancelled automatically.`,
  return_decision: (p) => `The return request on order ${p.orderNumber} must be approved or rejected by ${dateTimeText(p.dueAt)}, otherwise it is approved automatically.`,
};

function registerPhase6Listeners() {
  // Buyer: a refund that keeps failing (admins get REFUND_FAILED too).
  onDurable("REFUND_FAILED", "notify.buyer.REFUND_FAILED", async (p) => {
    if (!p.buyerId) return;
    const body = `We are having trouble sending your refund of ${formatInr(p.amount)} for order ${p.orderNumber || ""}. Our team has been alerted and will complete it; you don't need to do anything.`;
    await persistAndPush({ userId: p.buyerId, tenantId: p.tenantId, event: "REFUND_FAILED", title: "Refund delayed", body, data: { orderId: p.orderId, orderNumber: p.orderNumber }, category: "order", priority: "high" });
    await deliverToUser(p.buyerId, {
      category: "order",
      email: { subject: `Refund delayed – ${p.orderNumber || ""}`, heading: "Refund delayed", lines: [body], cta: { label: "View order", url: orderUrl(p.orderId) } },
    });
  });

  onDurable("SELLER_DEADLINE_SOON", "notify.staff.SELLER_DEADLINE_SOON", async (p) => {
    if (!p.tenantId) return;
    const body = (DEADLINE_TEXT[p.kind] || DEADLINE_TEXT.confirm)(p);
    await persistAndPush({
      tenantId: p.tenantId,
      event: "SELLER_DEADLINE_SOON",
      title: p.kind === "return_decision" ? "Return decision due soon" : p.kind === "ship" ? "Shipment due soon" : "Confirmation due soon",
      body,
      data: { orderId: p.orderId, orderNumber: p.orderNumber, kind: p.kind, dueAt: p.dueAt, returnId: p.returnId || null },
      audience: { type: "staff" },
      priority: "high",
      category: "order",
    });
    const staff = await tenantUsersWith(p.tenantId, p.kind === "return_decision" ? ["returns.manage"] : ["orders.update"]);
    for (const u of staff) {
      await deliverToUser(u._id, { category: "order", email: { subject: `Due soon – ${p.orderNumber}`, heading: "Deadline approaching", lines: [body], cta: { label: "Open order", url: staffOrderUrl(p.orderId) } } });
    }
  });

  onDurable("REFUND_OVERDUE", "notify.admin.REFUND_OVERDUE", (p) =>
    adminAlert(
      "REFUND_OVERDUE",
      `The refund of ${formatInr(p.amount)} for the return on order ${p.orderNumber || ""} is still ${p.refundStatus || "not completed"} ${p.hours || ""} hours after the goods were received${p.refundStatus === "pending_payout" ? " (COD payout to the buyer)" : ""}. Please check it.`,
      { orderId: p.orderId, orderNumber: p.orderNumber, tenantId: p.tenantId, key: p.key, returnId: p.returnId }
    )
  );

  onDurable("DISPUTE_OPENED", "notify.DISPUTE_OPENED", async (p) => {
    const due = p.respondBy ? ` Reply by ${dateTimeText(p.respondBy)}; after that the platform reviews it without your reply.` : "";
    await notifyDisputeStaff(p, "DISPUTE_OPENED", `The buyer opened dispute ${p.number} about the return on order ${p.orderNumber}.${due}`, { email: true, priority: "high" });
    await persistAndPush({
      userId: p.buyerId,
      tenantId: p.tenantId,
      event: "DISPUTE_OPENED",
      body: `Your dispute ${p.number} for order ${p.orderNumber} was sent to the seller. The platform team decides it if you can't agree.`,
      data: disputeData(p),
      category: "order",
    });
  });

  onDurable("DISPUTE_MESSAGE", "notify.DISPUTE_MESSAGE", async (p) => {
    const preview = p.preview ? `: "${String(p.preview).slice(0, 140)}"` : "";
    if (p.from === "buyer" || p.from === "admin") {
      await notifyDisputeStaff(p, "DISPUTE_MESSAGE", `${p.from === "admin" ? "The platform" : "The buyer"} wrote on dispute ${p.number} (order ${p.orderNumber})${preview}`);
    }
    if (p.from === "seller" || p.from === "admin") {
      await persistAndPush({
        userId: p.buyerId,
        tenantId: p.tenantId,
        event: "DISPUTE_MESSAGE",
        body: `${p.from === "admin" ? "The platform team" : "The seller"} replied on your dispute ${p.number} (order ${p.orderNumber})${preview}`,
        data: disputeData(p),
        category: "order",
      });
    }
  });

  onDurable("DISPUTE_INFO_REQUESTED", "notify.DISPUTE_INFO_REQUESTED", async (p) => {
    const due = p.respondBy ? ` Please reply by ${dateTimeText(p.respondBy)}.` : "";
    const ask = p.preview ? ` "${String(p.preview).slice(0, 200)}"` : "";
    if (p.to === "buyer") {
      await notifyDisputeBuyer(p, "DISPUTE_INFO_REQUESTED", `The platform team needs more information about your dispute ${p.number} (order ${p.orderNumber}).${ask}${due}`, { priority: "high" });
    } else {
      await notifyDisputeStaff(p, "DISPUTE_INFO_REQUESTED", `The platform team needs more information about dispute ${p.number} (order ${p.orderNumber}).${ask}${due}`, { email: true, priority: "high" });
    }
  });

  onDurable("DISPUTE_UNDER_REVIEW", "notify.admin.DISPUTE_UNDER_REVIEW", (p) =>
    adminAlert(
      "DISPUTE_UNDER_REVIEW",
      `Dispute ${p.number} (order ${p.orderNumber}) is waiting for a decision${p.timedOut ? ` — the ${p.who || "seller"} did not reply in time` : ""}.`,
      { disputeId: p.disputeId, orderId: p.orderId, orderNumber: p.orderNumber, tenantId: p.tenantId }
    )
  );

  onDurable("DISPUTE_DECIDED", "notify.DISPUTE_DECIDED", async (p) => {
    const buyerText = {
      refund: `Your dispute ${p.number} was decided in your favour: a refund of ${formatInr(p.amount)} for order ${p.orderNumber} has been initiated.`,
      reopen: `Your dispute ${p.number} was decided in your favour: the return for order ${p.orderNumber} has been reopened and will be picked up again.`,
      reject: `Your dispute ${p.number} for order ${p.orderNumber} was not upheld.`,
    }[p.action];
    const sellerText = {
      refund: `Dispute ${p.number} (order ${p.orderNumber}) was decided for the buyer: a refund of ${formatInr(p.amount)} was issued and debited from your payouts.`,
      reopen: `Dispute ${p.number} (order ${p.orderNumber}) was decided for the buyer: the return was reopened (approved). Receive it once it is back.`,
      reject: `Dispute ${p.number} (order ${p.orderNumber}) was decided in your favour.`,
    }[p.action];
    const reason = p.reason ? ` Reason: ${p.reason}` : "";
    await notifyDisputeBuyer(p, "DISPUTE_DECIDED", `${buyerText}${reason}`, { sms: "dispute decided", priority: "high" });
    await notifyDisputeStaff(p, "DISPUTE_DECIDED", `${sellerText}${reason}`, { email: true });
  });

  onDurable("DISPUTE_WITHDRAWN", "notify.staff.DISPUTE_WITHDRAWN", (p) =>
    notifyDisputeStaff(p, "DISPUTE_WITHDRAWN", `The buyer withdrew dispute ${p.number} (order ${p.orderNumber}).`)
  );
}
