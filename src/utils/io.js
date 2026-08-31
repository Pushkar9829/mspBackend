let io = null;

export function setIo(instance) {
  io = instance;
}

export function getIo() {
  return io;
}

export function emitToUser(userId, event, data) {
  io?.to(`user:${userId}`).emit(event, data);
}

export function emitToTenant(tenantId, event, data) {
  if (!tenantId) return;
  io?.to(`tenant:${tenantId}`).emit(event, data);
}

export function emitToConversation(conversationId, event, data) {
  io?.to(`conversation:${conversationId}`).emit(event, data);
}
