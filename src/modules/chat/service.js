import mongoose from "mongoose";
import { Conversation } from "./conversation.model.js";
import { Message } from "./message.model.js";
import { ChatMacro, MAX_MACROS_PER_TENANT } from "./macro.model.js";
import { User } from "../users/user.model.js";
import { Role } from "../rbac/role.model.js";
import { Order } from "../orders/order.model.js";
import { Product } from "../catalog/product.model.js";
import { Tenant } from "../tenants/tenant.model.js";
import { Settings } from "../settings/settings.model.js";
import { AppError } from "../../utils/AppError.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { emitDomain } from "../../utils/events.js";
import { getIo, emitToUser } from "../../utils/io.js";
import { CONVERSATION_TYPES } from "../../config/constants.js";
import { effectivePermissions, isBuyerRole } from "../../middleware/authenticate.js";

/**
 * Access context: anything with `{ user, permissions, isPlatformAdmin, tenantId }`.
 * HTTP handlers pass `req`; the socket layer builds the same shape (see sockets/index.js).
 */
export function isBuyer(ctx) {
  // Classified by who the principal is, not by which chat permissions they hold: store staff with
  // only chat.view/chat.reply are staff, never buyers.
  if (ctx.isPlatformAdmin || ctx.role?.scope === "platform") return false;
  if (ctx.isBuyer) return true;
  // Non-buyer roles: staff when they are a member of a store.
  return !refId(ctx.user?.tenantId);
}

export function isAgent(ctx) {
  return !isBuyer(ctx);
}

function refId(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value._id || value.id || value);
  return String(value);
}

/** Boolean version of the conversation access rule (used by sockets). */
export function canAccessConversation(ctx, convo) {
  if (!ctx?.user || !convo) return false;
  if (ctx.isPlatformAdmin) return true;
  // The buyer who opened the conversation can always see it (also covers staff who opened one).
  if (refId(convo.buyerId) === String(ctx.user._id)) return true;
  if (isBuyer(ctx)) return false;
  // Staff: only conversations of their own tenant. Escalation does NOT widen access –
  // escalated conversations are visible cross-tenant to platform admins only.
  const staffTenant = refId(ctx.tenantId || ctx.user.tenantId);
  if (!staffTenant) return false;
  return refId(convo.tenantId) === staffTenant;
}

export function assertAccess(ctx, convo) {
  if (!canAccessConversation(ctx, convo)) {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }
}

/** True when ctx may see internal agent notes of this conversation. */
export function canSeeInternal(ctx, convo) {
  if (!canAccessConversation(ctx, convo)) return false;
  if (ctx.isPlatformAdmin) return true;
  return isAgent(ctx) && refId(convo.buyerId) !== String(ctx.user._id);
}

function tenantOf(req) {
  return req.tenantId || req.user?.tenantId?._id || req.user?.tenantId || null;
}

/* ----------------------------- macros ----------------------------- */

async function migrateLegacyMacros(tenantId) {
  const legacy = await Settings.findOne({ scope: "tenant", tenantId, key: "chat.macros" });
  if (!legacy || !Array.isArray(legacy.value) || !legacy.value.length) return;
  const rows = legacy.value
    .filter((m) => m && m.title && m.body)
    .slice(-MAX_MACROS_PER_TENANT)
    .map((m) => ({
      tenantId,
      title: String(m.title).slice(0, 120),
      body: String(m.body).slice(0, 4000),
      createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
    }));
  // Delete first so two concurrent requests cannot both import.
  const removed = await Settings.deleteOne({ _id: legacy._id });
  if (removed.deletedCount && rows.length) await ChatMacro.insertMany(rows);
}

export async function listMacros(req) {
  const tenantId = tenantOf(req);
  if (!tenantId) return [];
  let macros = await ChatMacro.find({ tenantId }).sort({ createdAt: 1 }).limit(MAX_MACROS_PER_TENANT).lean();
  if (!macros.length) {
    await migrateLegacyMacros(tenantId);
    macros = await ChatMacro.find({ tenantId }).sort({ createdAt: 1 }).limit(MAX_MACROS_PER_TENANT).lean();
  }
  return macros;
}

export async function saveMacro(req, { title, body }) {
  const tenantId = tenantOf(req);
  if (!tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const count = await ChatMacro.countDocuments({ tenantId });
  if (count >= MAX_MACROS_PER_TENANT) {
    throw new AppError(400, `At most ${MAX_MACROS_PER_TENANT} macros per store`, "LIMIT_REACHED");
  }
  await ChatMacro.create({ tenantId, title, body, createdBy: req.user._id });
  return listMacros(req);
}

export async function deleteMacro(req, macroId) {
  const tenantId = tenantOf(req);
  const res = await ChatMacro.deleteOne({ _id: macroId, ...(req.isPlatformAdmin && !req.tenantId ? {} : { tenantId }) });
  if (!res.deletedCount) throw new AppError(404, "Macro not found", "NOT_FOUND");
  return { ok: true, id: macroId };
}

/* -------------------------- conversations ------------------------- */

export async function startConversation(req, body) {
  let tenantId = null;
  let orderId = null;
  let productId = body.productId || null;

  if (isBuyer(req)) {
    tenantId = body.tenantId || null;
  } else if (req.isPlatformAdmin) {
    tenantId = body.tenantId || req.tenantId || null;
  } else {
    tenantId = tenantOf(req);
  }

  if (body.orderId) {
    const order = await Order.findOne({
      _id: body.orderId,
      ...(isBuyer(req) ? { buyerId: req.user._id } : req.isPlatformAdmin ? {} : { tenantId }),
    }).select("_id tenantId");
    if (!order) throw new AppError(404, "Order not found", "NOT_FOUND");
    tenantId = order.tenantId;
    orderId = order._id;
  } else if (productId) {
    const product = await Product.findById(productId).select("_id tenantId");
    if (!product) throw new AppError(404, "Product not found", "NOT_FOUND");
    if (!tenantId) tenantId = product.tenantId;
    productId = product._id;
  }

  if (tenantId) {
    const tenant = await Tenant.findById(tenantId).select("_id status");
    if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
    tenantId = tenant._id;
  } else if (!req.isPlatformAdmin && !isBuyer(req)) {
    throw new AppError(400, "tenantId required", "VALIDATION_ERROR");
  }

  const convo = await Conversation.create({
    tenantId,
    buyerId: req.user._id,
    type: CONVERSATION_TYPES.includes(body.type) ? body.type : "general_support",
    status: "unassigned",
    subject: body.subject || "",
    orderId,
    productId,
  });
  if (body.message && body.message.trim()) {
    await postMessage(req, convo._id, { body: body.message });
    return Conversation.findById(convo._id);
  }
  return convo;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function listConversations(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (isBuyer(req)) {
    filter.buyerId = req.user._id;
    if (req.query.status) filter.status = req.query.status;
  } else {
    Object.assign(filter, tenantFilter(req));
    if (!req.isPlatformAdmin && !filter.tenantId) {
      throw new AppError(403, "Tenant context required", "FORBIDDEN");
    }
    if (req.query.queue === "unassigned") filter.status = "unassigned";
    if (req.query.queue === "mine") filter.assigneeId = req.user._id;
    if (req.query.queue === "waiting") filter.status = "waiting_customer";
    if (req.query.queue === "escalated") filter.escalated = true;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
  }
  if (req.query.q && String(req.query.q).trim()) {
    const rx = new RegExp(escapeRegex(String(req.query.q).trim()), "i");
    const or = [{ subject: rx }];
    if (!isBuyer(req)) {
      const buyers = await User.find({ $or: [{ name: rx }, { email: rx }] })
        .select("_id")
        .limit(25);
      if (buyers.length) or.push({ buyerId: { $in: buyers.map((u) => u._id) } });
    }
    filter.$or = or;
  }
  const [data, total] = await Promise.all([
    Conversation.find(filter)
      .populate("buyerId", "name email")
      .populate("assigneeId", "name email")
      .populate("tenantId", "name slug")
      .sort({ lastMessageAt: -1 })
      .skip(skip)
      .limit(limit),
    Conversation.countDocuments(filter),
  ]);
  return paginated(data, total, { page, limit });
}

export async function loadConversation(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return Conversation.findById(id);
}

export async function getConversation(req, id) {
  const convo = await Conversation.findById(id)
    .populate("buyerId", "name email")
    .populate("assigneeId", "name email")
    .populate("tenantId", "name slug");
  if (!convo) throw new AppError(404, "Conversation not found", "NOT_FOUND");
  assertAccess(req, convo);
  return convo;
}

/**
 * Returns up to `limit` messages (ascending) older than `before` (ISO date or message id).
 * The response stays an array for frontend compatibility; `meta.nextBefore` is returned so the
 * route can expose it as a header.
 */
export async function listMessages(req, conversationId, { before, limit } = {}) {
  const convo = await getConversation(req, conversationId);
  const max = Math.min(200, Math.max(1, Number(limit) || 100));
  const filter = { conversationId: convo._id };
  if (!canSeeInternal(req, convo)) filter.internal = false;
  if (before) {
    let at = null;
    if (mongoose.isValidObjectId(before)) {
      const ref = await Message.findOne({ _id: before, conversationId: convo._id }).select("createdAt");
      at = ref?.createdAt || null;
    } else {
      const d = new Date(before);
      if (!Number.isNaN(d.getTime())) at = d;
    }
    if (!at) throw new AppError(400, "Invalid before cursor", "VALIDATION_ERROR");
    filter.createdAt = { $lt: at };
  }
  const rows = await Message.find(filter)
    .populate("senderId", "name email")
    .sort({ createdAt: -1, _id: -1 })
    .limit(max + 1);
  const hasMore = rows.length > max;
  const page = rows.slice(0, max).reverse();
  return { data: page, meta: { hasMore, nextBefore: hasMore && page.length ? page[0].createdAt.toISOString() : null } };
}

function emitMessage(convo, msg) {
  const io = getIo();
  if (!io) return;
  if (msg.internal) {
    io.to(`conversation:${convo._id}:agents`).emit("chat:message", msg);
  } else {
    io.to(`conversation:${convo._id}`).emit("chat:message", msg);
  }
}

export async function postMessage(req, conversationId, body) {
  const current = await getConversation(req, conversationId);
  if (current.status === "closed") throw new AppError(400, "Conversation is closed", "INVALID_STATE");
  const asAgent = canSeeInternal(req, current);
  const internal = Boolean(body.internal) && asAgent;
  const now = new Date();

  let update;
  if (asAgent) {
    update = internal
      ? { $set: { lastMessageAt: now } }
      : { $set: { lastMessageAt: now, status: "waiting_customer" }, $inc: { unreadBuyer: 1 } };
  } else {
    update = [
      {
        $set: {
          lastMessageAt: now,
          unreadAgent: { $add: [{ $ifNull: ["$unreadAgent", 0] }, 1] },
          status: { $cond: [{ $ifNull: ["$assigneeId", false] }, "assigned", "unassigned"] },
        },
      },
    ];
  }
  const convo = await Conversation.findOneAndUpdate(
    { _id: current._id, status: { $ne: "closed" } },
    update,
    { new: true }
  );
  if (!convo) throw new AppError(400, "Conversation is closed", "INVALID_STATE");

  const msg = await Message.create({
    conversationId: convo._id,
    senderId: req.user._id,
    body: body.body || "",
    attachments: body.attachments || [],
    internal,
    readBy: [req.user._id],
  });
  await msg.populate("senderId", "name email");
  emitMessage(convo, msg);
  emitDomain("CHAT_MESSAGE", {
    conversationId: convo._id,
    tenantId: convo.tenantId,
    buyerId: convo.buyerId,
    assigneeId: convo.assigneeId,
    senderId: req.user._id,
    preview: internal ? "" : msg.body.slice(0, 120),
    internal: msg.internal,
  });
  return msg;
}

async function assertAssignable(req, convo, assigneeId) {
  const user = await User.findById(assigneeId).select("_id tenantId status roleId");
  if (!user || user.status !== "active") throw new AppError(400, "Assignee not found or inactive", "VALIDATION_ERROR");
  const role = await Role.findById(user.roleId).select("permissions slug scope tenantId isSystem");
  const perms = role ? effectivePermissions(role) : [];
  const platformStaff = role?.scope === "platform" && !role?.tenantId;
  const canHandle = perms.includes("*") || (perms.includes("chat.view") && perms.includes("chat.reply"));
  if (isBuyerRole(role) || (!platformStaff && !canHandle)) {
    throw new AppError(400, "Assignee cannot handle chats", "VALIDATION_ERROR");
  }
  if (!platformStaff && refId(user.tenantId) !== refId(convo.tenantId)) {
    throw new AppError(400, "Assignee belongs to another store", "VALIDATION_ERROR");
  }
  return user._id;
}

export async function assignConversation(req, id, assigneeId) {
  const current = await getConversation(req, id);
  const target = assigneeId ? await assertAssignable(req, current, assigneeId) : req.user._id;
  const convo = await Conversation.findOneAndUpdate(
    { _id: current._id, status: { $ne: "closed" } },
    { $set: { assigneeId: target, status: "assigned" } },
    { new: true }
  );
  if (!convo) throw new AppError(400, "Conversation is closed", "INVALID_STATE");
  emitDomain("CHAT_ASSIGNED", {
    conversationId: convo._id,
    tenantId: convo.tenantId,
    buyerId: convo.buyerId,
    assigneeId: convo.assigneeId,
    actorId: req.user._id,
  });
  return convo;
}

export async function closeConversation(req, id) {
  const current = await getConversation(req, id);
  return Conversation.findByIdAndUpdate(current._id, { $set: { status: "closed" } }, { new: true });
}

export async function escalateConversation(req, id) {
  const current = await getConversation(req, id);
  const convo = await Conversation.findOneAndUpdate(
    { _id: current._id, status: { $ne: "closed" } },
    { $set: { escalated: true, status: "unassigned", assigneeId: null } },
    { new: true }
  );
  if (!convo) throw new AppError(400, "Conversation is closed", "INVALID_STATE");
  emitDomain("CHAT_ESCALATED", {
    conversationId: convo._id,
    tenantId: convo.tenantId,
    buyerId: convo.buyerId,
    actorId: req.user._id,
  });
  return convo;
}

export async function markRead(req, id) {
  const current = await getConversation(req, id);
  const asAgent = canSeeInternal(req, current);
  const convo = await Conversation.findByIdAndUpdate(
    current._id,
    { $set: asAgent ? { unreadAgent: 0 } : { unreadBuyer: 0 } },
    { new: true }
  );
  await Message.updateMany(
    { conversationId: current._id, readBy: { $ne: req.user._id }, ...(asAgent ? {} : { internal: false }) },
    { $addToSet: { readBy: req.user._id } }
  );
  emitToUser(req.user._id, "chat:read", { conversationId: current._id });
  return convo;
}
