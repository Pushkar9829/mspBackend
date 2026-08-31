import mongoose from "mongoose";

export async function withTransaction(fn, { retries = 3 } = {}) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (err) {
    try {
      await session.abortTransaction();
    } catch {
      /* already aborted or not supported */
    }
    const msg = String(err.message || "");
    const noReplica =
      msg.includes("Transaction numbers") ||
      msg.includes("replica set") ||
      msg.includes("IllegalOperation");
    if (noReplica) {
      return fn(null);
    }
    const transient =
      err.errorLabels?.includes("TransientTransactionError") ||
      err.hasErrorLabel?.("TransientTransactionError") ||
      msg.includes("WriteConflict");
    if (transient && retries > 0) {
      return withTransaction(fn, { retries: retries - 1 });
    }
    throw err;
  } finally {
    session.endSession();
  }
}
