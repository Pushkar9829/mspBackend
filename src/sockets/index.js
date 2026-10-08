import { Server } from "socket.io";
import { isOriginAllowed } from "../config/env.js";
import { loadAuthUser, assertUserActive } from "../middleware/authenticate.js";
import { User } from "../modules/users/user.model.js";
import { setIo, getIo } from "../utils/io.js";
import { bus } from "../utils/events.js";
import { loadConversation, canAccessConversation, canSeeInternal } from "../modules/chat/service.js";

/** Token from the socket.io `auth` payload or an `Authorization: Bearer` header. Never the query string. */
export function socketToken(handshake = {}) {
  const fromAuth = handshake.auth?.token;
  if (typeof fromAuth === "string" && fromAuth) return fromAuth.replace(/^Bearer\s+/i, "");
  const header = handshake.headers?.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return null;
}

function tenantIdOf(user) {
  const t = user?.tenantId;
  if (!t) return null;
  return String(t._id || t);
}

/** Build the same access context shape the HTTP layer uses (see chat/service.js). */
export function socketContext(auth) {
  return {
    user: auth.user,
    role: auth.role,
    permissions: auth.permissions || [],
    isPlatformAdmin: Boolean(auth.isPlatformAdmin),
    isBuyer: Boolean(auth.isBuyer),
    tenantId: tenantIdOf(auth.user),
  };
}

/** Tenant room membership is for store staff only, never buyers. */
export function isTenantStaff(ctx) {
  return Boolean(ctx.tenantId) && !ctx.isBuyer && !ctx.isPlatformAdmin;
}

/**
 * Authorise a chat:join request. Returns the list of rooms the socket may join for this
 * conversation (empty when access is denied).
 */
export async function roomsForConversation(ctx, conversationId) {
  const convo = await loadConversation(conversationId);
  if (!convo || !canAccessConversation(ctx, convo)) return [];
  const rooms = [`conversation:${convo._id}`];
  if (canSeeInternal(ctx, convo)) rooms.push(`conversation:${convo._id}:agents`);
  return rooms;
}

function idString(value) {
  if (!value) return null;
  if (typeof value === "object" && value._id) return String(value._id);
  return String(value);
}

/**
 * Socket payload + rooms for the ORDER_UPDATED domain event (`{ order }`).
 * Rooms: tenant:<tenantId> (store staff), user:<buyerId> (the buyer), platform:admins.
 * The payload is a summary; clients refetch GET /orders/:id for full detail.
 */
export function orderUpdatedMessage(payload = {}) {
  const raw = payload.order || payload;
  const order = raw && typeof raw.toObject === "function" ? raw.toObject() : raw || {};
  const id = idString(order._id || payload.orderId);
  if (!id) return null;
  const tenantId = idString(order.tenantId || payload.tenantId);
  const buyerId = idString(order.buyerId || payload.buyerId);
  const summary = {
    id,
    _id: id,
    orderNumber: order.orderNumber || "",
    tenantId,
    buyerId,
    status: order.status || payload.status || "",
    paymentStatus: order.paymentStatus || "",
    paymentMethod: order.paymentMethod || "",
    fulfillmentMode: order.fulfillmentMode || order.fulfillment?.mode || undefined,
    grandTotal: order.grandTotal ?? null,
    itemsCount: Array.isArray(order.items) ? order.items.length : undefined,
    updatedAt: order.updatedAt || new Date(),
  };
  const rooms = ["platform:admins"];
  if (tenantId) rooms.push(`tenant:${tenantId}`);
  if (buyerId) rooms.push(`user:${buyerId}`);
  return { event: "order:updated", rooms, data: { order: summary, orderId: id, status: summary.status } };
}

/** Disconnect every live socket of a user (call after revoking their tokens). */
export function disconnectUserSockets(userId) {
  if (!userId) return;
  getIo()?.in(`user:${userId}`).disconnectSockets(true);
}

/** Disconnect every store-staff socket of a tenant (call when the tenant is suspended/archived). */
export function disconnectTenantSockets(tenantId) {
  if (!tenantId) return;
  getIo()?.in(`tenant:${tenantId}`).disconnectSockets(true);
}

let tenantRevocationRegistered = false;
/** Tenant suspension (TENANT_SUSPENDED, emitted by tenants/service updateTenant) drops staff sockets. */
export function registerTenantSocketRevocation() {
  if (tenantRevocationRegistered) return;
  tenantRevocationRegistered = true;
  bus.on("TENANT_SUSPENDED", function disconnectSuspendedTenant(payload) {
    disconnectTenantSockets(idString(payload?.tenantId));
  });
}

/**
 * Re-validate a connected socket's principal (status, tokenVersion, tenant suspension) against the DB.
 * Returns false when the token the socket was authorised with is no longer valid.
 */
export async function socketStillAuthorised(socket) {
  try {
    const user = await User.findById(socket.ctx?.user?._id).populate("roleId").populate("tenantId");
    assertUserActive(user, user?.roleId, { tokenVersion: socket.tokenVersion ?? 0 });
    return true;
  } catch {
    return false;
  }
}

let orderForwarderRegistered = false;
/** Forward ORDER_UPDATED domain events to sockets as `order:updated` (registered once). */
export function registerOrderSocketForwarding() {
  if (orderForwarderRegistered) return;
  orderForwarderRegistered = true;
  bus.on("ORDER_UPDATED", function forwardOrderUpdated(payload) {
    const io = getIo();
    if (!io) return;
    const msg = orderUpdatedMessage(payload);
    if (!msg) return;
    io.to(msg.rooms).emit(msg.event, msg.data);
  });
}

export function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin(origin, callback) {
        if (isOriginAllowed(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
    },
  });
  setIo(io);
  registerOrderSocketForwarding();
  registerTenantSocketRevocation();

  io.use(async (socket, next) => {
    try {
      const token = socketToken(socket.handshake);
      if (!token) return next(new Error("unauthorized"));
      // loadAuthUser verifies the JWT, user status, tokenVersion and tenant suspension.
      const auth = await loadAuthUser(token);
      socket.ctx = socketContext(auth);
      socket.user = auth.user;
      socket.role = auth.role;
      socket.tokenVersion = auth.payload?.tv ?? 0;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const ctx = socket.ctx;
    socket.join(`user:${ctx.user._id}`);
    if (isTenantStaff(ctx)) socket.join(`tenant:${ctx.tenantId}`);
    if (ctx.isPlatformAdmin) socket.join("platform:admins");

    const joined = new Set();

    socket.on("chat:join", async (conversationId, ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      try {
        if (typeof conversationId !== "string") return reply({ ok: false, error: "invalid" });
        if (!(await socketStillAuthorised(socket))) {
          reply({ ok: false, error: "unauthorized" });
          return socket.disconnect(true);
        }
        const rooms = await roomsForConversation(ctx, conversationId);
        if (!rooms.length) return reply({ ok: false, error: "forbidden" });
        for (const room of rooms) socket.join(room);
        joined.add(conversationId);
        reply({ ok: true });
      } catch (err) {
        console.error("chat:join failed", err.message);
        reply({ ok: false, error: "error" });
      }
    });

    socket.on("chat:leave", (conversationId) => {
      if (typeof conversationId !== "string") return;
      socket.leave(`conversation:${conversationId}`);
      socket.leave(`conversation:${conversationId}:agents`);
      joined.delete(conversationId);
    });

    socket.on("chat:typing", async (payload) => {
      try {
        const conversationId = payload?.conversationId;
        if (typeof conversationId !== "string") return;
        // Only sockets that passed the chat:join authorisation may broadcast typing.
        if (!joined.has(conversationId)) {
          const rooms = await roomsForConversation(ctx, conversationId);
          if (!rooms.length) return;
        }
        socket.to(`conversation:${conversationId}`).emit("chat:typing", {
          conversationId,
          userId: ctx.user._id,
          typing: Boolean(payload?.typing),
        });
      } catch (err) {
        console.error("chat:typing failed", err.message);
      }
    });

    socket.on("presence:ping", () => {
      socket.emit("presence:pong", { ok: true, at: Date.now() });
    });
  });

  return io;
}
