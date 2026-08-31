import { Notification } from "./notification.model.js";
import { User } from "../users/user.model.js";
import { emitToUser, emitToTenant } from "../../utils/io.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { bus } from "../../utils/events.js";

const TITLES = {
  ORDER_CREATED: "Order placed",
  ORDER_CONFIRMED: "Order confirmed",
  ORDER_SHIPPED: "Order shipped",
  ORDER_DELIVERED: "Order delivered",
  ORDER_CANCELLED: "Order cancelled",
  LOW_STOCK: "Low stock alert",
  OUT_OF_STOCK: "Out of stock",
  PRICE_DROP: "New offer",
  COUPON_CREATED: "New coupon",
  CHAT_MESSAGE: "New chat message",
  CHAT_ASSIGNED: "Chat assigned",
  CHAT_ESCALATED: "Chat escalated",
  GLOBAL_ANNOUNCEMENT: "Announcement",
  ACCOUNT_LOGIN: "New login",
};

export async function persistAndPush({ userId, tenantId, event, title, body, data, audience }) {
  const doc = await Notification.create({
    userId: userId || null,
    tenantId: tenantId || null,
    audience: audience || { type: userId ? "user" : tenantId ? "tenant" : "all" },
    event,
    title: title || TITLES[event] || event,
    body: body || "",
    data: data || {},
  });
  if (userId) emitToUser(userId, "notification", doc);
  if (tenantId) emitToTenant(tenantId, "notification", doc);
  return doc;
}

export function registerNotificationListeners() {
  bus.on("ORDER_CREATED", (p) =>
    persistAndPush({
      userId: p.buyerId,
      tenantId: p.tenantId,
      event: "ORDER_CREATED",
      body: `Order ${p.orderNumber} placed`,
      data: p,
    })
  );
  bus.on("ORDER_CONFIRMED", (p) =>
    persistAndPush({
      userId: p.buyerId,
      tenantId: p.tenantId,
      event: "ORDER_CONFIRMED",
      body: `Order ${p.orderNumber} confirmed`,
      data: p,
    })
  );
  bus.on("ORDER_SHIPPED", (p) =>
    persistAndPush({
      userId: p.buyerId,
      tenantId: p.tenantId,
      event: "ORDER_SHIPPED",
      body: `Order ${p.orderNumber} shipped`,
      data: p,
    })
  );
  bus.on("ORDER_DELIVERED", (p) =>
    persistAndPush({
      userId: p.buyerId,
      tenantId: p.tenantId,
      event: "ORDER_DELIVERED",
      body: `Order ${p.orderNumber} delivered`,
      data: p,
    })
  );
  bus.on("ORDER_CANCELLED", (p) =>
    persistAndPush({
      userId: p.buyerId,
      tenantId: p.tenantId,
      event: "ORDER_CANCELLED",
      body: `Order ${p.orderNumber} cancelled`,
      data: p,
    })
  );
  bus.on("LOW_STOCK", (p) =>
    persistAndPush({
      tenantId: p.tenantId,
      event: "LOW_STOCK",
      body: `${p.sku} is low (${p.available})`,
      data: p,
      audience: { type: "tenant" },
    })
  );
  bus.on("CHAT_MESSAGE", (p) => {
    const target = String(p.senderId) === String(p.buyerId) ? p.assigneeId : p.buyerId;
    if (target) {
      persistAndPush({
        userId: target,
        tenantId: p.tenantId,
        event: "CHAT_MESSAGE",
        body: p.preview,
        data: p,
      });
    }
  });
  bus.on("COUPON_CREATED", (p) =>
    persistAndPush({
      tenantId: p.tenantId,
      event: "COUPON_CREATED",
      body: `Coupon ${p.code} created`,
      data: p,
      audience: { type: "tenant" },
    })
  );
  bus.on("PRICE_DROP", (p) =>
    persistAndPush({
      tenantId: p.tenantId,
      event: "PRICE_DROP",
      body: p.name || "New offer",
      data: p,
      audience: { type: "tenant" },
    })
  );
}

export async function listMine(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = {
    $or: [
      { userId: req.user._id },
      ...(req.tenantId ? [{ tenantId: req.tenantId, "audience.type": "tenant" }] : []),
      { "audience.type": "all" },
    ],
    $and: [
      {
        $or: [{ scheduledAt: null }, { scheduledAt: { $lte: new Date() } }],
      },
      {
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      },
    ],
  };
  const [data, total] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function markRead(req, id) {
  const doc = await Notification.findOne({ _id: id, userId: req.user._id });
  if (!doc) return { ok: true };
  doc.readAt = new Date();
  await doc.save();
  return doc;
}

export async function createAnnouncement(req, body) {
  const audienceType = body.audienceType || "all";
  if (audienceType === "user" && body.userIds?.length) {
    const created = [];
    for (const userId of body.userIds) {
      created.push(
        await persistAndPush({
          userId,
          tenantId: body.tenantId || req.tenantId,
          event: "GLOBAL_ANNOUNCEMENT",
          title: body.title,
          body: body.body,
          data: body.data,
          audience: { type: "user" },
        })
      );
    }
    return created;
  }
  if (audienceType === "tenant") {
    const tenantId = body.tenantId || req.tenantId;
    const users = await User.find({ tenantId, status: "active" }).select("_id");
    for (const u of users) {
      await persistAndPush({
        userId: u._id,
        tenantId,
        event: "GLOBAL_ANNOUNCEMENT",
        title: body.title,
        body: body.body,
        audience: { type: "tenant" },
      });
    }
    return { ok: true, count: users.length };
  }
  return persistAndPush({
    event: "GLOBAL_ANNOUNCEMENT",
    title: body.title,
    body: body.body,
    audience: { type: "all" },
    tenantId: null,
  });
}

export async function publishScheduled() {
  const due = await Notification.find({
    scheduledAt: { $lte: new Date() },
    readAt: null,
    userId: { $ne: null },
  }).limit(100);
  for (const n of due) {
    emitToUser(n.userId, "notification", n);
  }
}
