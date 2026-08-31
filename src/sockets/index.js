import { Server } from "socket.io";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../utils/tokens.js";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { setIo } from "../utils/io.js";

export function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.corsOrigin, credentials: true },
  });
  setIo(io);

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error("unauthorized"));
      const payload = verifyAccessToken(token);
      const user = await User.findById(payload.sub).populate("roleId");
      if (!user) return next(new Error("unauthorized"));
      socket.user = user;
      socket.role = user.roleId instanceof Role ? user.roleId : null;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.join(`user:${socket.user._id}`);
    if (socket.user.tenantId) socket.join(`tenant:${socket.user.tenantId}`);

    socket.on("chat:join", (conversationId) => {
      if (conversationId) socket.join(`conversation:${conversationId}`);
    });
    socket.on("chat:leave", (conversationId) => {
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    });
    socket.on("chat:typing", ({ conversationId, typing }) => {
      socket.to(`conversation:${conversationId}`).emit("chat:typing", {
        userId: socket.user._id,
        typing: Boolean(typing),
      });
    });
    socket.on("presence:ping", () => {
      socket.emit("presence:pong", { ok: true, at: Date.now() });
    });
  });

  return io;
}
