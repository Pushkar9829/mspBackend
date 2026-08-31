import { Conversation } from "./conversation.model.js";
import { Message } from "./message.model.js";
import { AppError } from "../../utils/AppError.js";
import { tenantFilter } from "../../middleware/tenantScope.js";
import { paginate, paginated } from "../../utils/pagination.js";
import { emitDomain } from "../../utils/events.js";
import { emitToConversation, emitToUser } from "../../utils/io.js";
import { CONVERSATION_TYPES } from "../../config/constants.js";
import { getSetting, upsertSetting } from "../settings/service.js";

function isBuyer(req) {
  const perms = req.permissions || [];
  return !perms.includes("*") && !perms.includes("chat.assign");
}

export async function listMacros(req) {
  const tenantId = req.tenantId || req.user.tenantId;
  return (await getSetting("tenant", tenantId, "chat.macros", [])) || [];
}

export async function saveMacro(req, { title, body }) {
  if (!title || !body) throw new AppError(400, "title and body required", "VALIDATION_ERROR");
  const tenantId = req.tenantId || req.user.tenantId;
  if (!tenantId) throw new AppError(400, "Tenant context required", "TENANT_REQUIRED");
  const macros = [...((await getSetting("tenant", tenantId, "chat.macros", [])) || [])];
  macros.push({ title, body, createdAt: new Date() });
  await upsertSetting({ ...req, tenantId, isPlatformAdmin: false }, "chat.macros", macros);
  return macros;
}

export async function startConversation(req, body) {
  const tenantId = body.tenantId || req.tenantId || req.user.tenantId;
  if (!tenantId && !req.isPlatformAdmin) {
    throw new AppError(400, "tenantId required", "VALIDATION_ERROR");
  }
  const convo = await Conversation.create({
    tenantId,
    buyerId: req.user._id,
    type: CONVERSATION_TYPES.includes(body.type) ? body.type : "general_support",
    status: "unassigned",
    subject: body.subject || "",
    orderId: body.orderId || null,
    productId: body.productId || null,
  });
  if (body.message) {
    await postMessage(req, convo._id, { body: body.message });
  }
  return convo;
}

export async function listConversations(req) {
  const { page, limit, skip } = paginate(req.query);
  const filter = {};
  if (isBuyer(req)) {
    filter.buyerId = req.user._id;
  } else {
    Object.assign(filter, tenantFilter(req));
    if (req.query.queue === "unassigned") filter.status = "unassigned";
    if (req.query.queue === "mine") filter.assigneeId = req.user._id;
    if (req.query.queue === "waiting") filter.status = "waiting_customer";
    if (req.query.status) filter.status = req.query.status;
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

export async function getConversation(req, id) {
  const convo = await Conversation.findById(id);
  if (!convo) throw new AppError(404, "Conversation not found", "NOT_FOUND");
  assertAccess(req, convo);
  return convo;
}

function assertAccess(req, convo) {
  if (req.isPlatformAdmin) return;
  if (isBuyer(req) && String(convo.buyerId) !== String(req.user._id)) {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }
  if (
    !isBuyer(req) &&
    req.tenantId &&
    String(convo.tenantId) !== String(req.tenantId) &&
    !convo.escalated
  ) {
    throw new AppError(403, "Forbidden", "FORBIDDEN");
  }
}

export async function listMessages(req, conversationId) {
  const convo = await getConversation(req, conversationId);
  const filter = { conversationId: convo._id };
  if (isBuyer(req)) filter.internal = false;
  return Message.find(filter).sort({ createdAt: 1 }).limit(500);
}

export async function postMessage(req, conversationId, body) {
  const convo = await getConversation(req, conversationId);
  if (convo.status === "closed") throw new AppError(400, "Conversation is closed", "INVALID_STATE");
  const isAgent = !isBuyer(req);
  const msg = await Message.create({
    conversationId: convo._id,
    senderId: req.user._id,
    body: body.body || "",
    attachments: body.attachments || [],
    internal: Boolean(body.internal) && isAgent,
    readBy: [req.user._id],
  });
  convo.lastMessageAt = new Date();
  if (isAgent) {
    convo.unreadBuyer += msg.internal ? 0 : 1;
    convo.status = body.internal ? convo.status : "waiting_customer";
  } else {
    convo.unreadAgent += 1;
    convo.status = convo.assigneeId ? "assigned" : "unassigned";
  }
  await convo.save();
  emitToConversation(convo._id, "chat:message", msg);
  emitDomain("CHAT_MESSAGE", {
    conversationId: convo._id,
    tenantId: convo.tenantId,
    buyerId: convo.buyerId,
    assigneeId: convo.assigneeId,
    senderId: req.user._id,
    preview: msg.body.slice(0, 120),
    internal: msg.internal,
  });
  return msg;
}

export async function assignConversation(req, id, assigneeId) {
  const convo = await getConversation(req, id);
  convo.assigneeId = assigneeId || req.user._id;
  convo.status = "assigned";
  await convo.save();
  emitDomain("CHAT_ASSIGNED", {
    conversationId: convo._id,
    tenantId: convo.tenantId,
    buyerId: convo.buyerId,
    assigneeId: convo.assigneeId,
  });
  return convo;
}

export async function closeConversation(req, id) {
  const convo = await getConversation(req, id);
  convo.status = "closed";
  await convo.save();
  return convo;
}

export async function escalateConversation(req, id) {
  const convo = await getConversation(req, id);
  convo.escalated = true;
  convo.status = "assigned";
  convo.assigneeId = null;
  await convo.save();
  emitDomain("CHAT_ESCALATED", {
    conversationId: convo._id,
    tenantId: convo.tenantId,
    buyerId: convo.buyerId,
  });
  return convo;
}

export async function markRead(req, id) {
  const convo = await getConversation(req, id);
  if (isBuyer(req)) convo.unreadBuyer = 0;
  else convo.unreadAgent = 0;
  await convo.save();
  await Message.updateMany({ conversationId: convo._id }, { $addToSet: { readBy: req.user._id } });
  emitToUser(req.user._id, "chat:read", { conversationId: convo._id });
  return convo;
}
