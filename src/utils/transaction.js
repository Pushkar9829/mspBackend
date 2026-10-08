import mongoose from "mongoose";
import { AppError } from "./AppError.js";

/**
 * Multi-document transactions are mandatory: stock, orders, coupons, ledger and invoices are
 * written together and must commit or roll back together. On a standalone mongod there is no
 * fallback unless ALLOW_NO_TRANSACTIONS=true (local development only) is set explicitly.
 */

let support = null; // null = not checked yet, true/false once known
let warned = false;

export function allowNoTransactions() {
  return String(process.env.ALLOW_NO_TRANSACTIONS || "").toLowerCase() === "true";
}

export function setTransactionSupport(value) {
  support = Boolean(value);
}

export function transactionsSupported() {
  return support;
}

/** Ask the server whether it is a replica-set member or mongos (both support transactions). */
export async function detectTransactionSupport(connection = mongoose.connection) {
  try {
    const hello = await connection.db.admin().command({ hello: 1 });
    support = Boolean(hello.setName || hello.msg === "isdbgrid");
  } catch {
    support = false;
  }
  return support;
}

function warnOnce() {
  if (warned) return;
  warned = true;
  console.warn(
    "\n" +
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n" +
      "!! ALLOW_NO_TRANSACTIONS=true: MongoDB is not a replica set. Checkout, stock,  !!\n" +
      "!! coupon, ledger and invoice writes run WITHOUT transactions. Partial writes  !!\n" +
      "!! and oversell are possible. Never use this outside local development.       !!\n" +
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n"
  );
}

function hasLabel(err, label) {
  return Boolean(err?.errorLabels?.includes?.(label) || err?.hasErrorLabel?.(label) || err?.errorLabelSet?.has?.(label));
}

function isTransient(err) {
  const msg = String(err?.message || "");
  return hasLabel(err, "TransientTransactionError") || msg.includes("WriteConflict") || err?.code === 112;
}

function noReplicaError(err) {
  const msg = String(err?.message || "");
  return msg.includes("Transaction numbers are only allowed") || msg.includes("replica set member or mongos");
}

/**
 * Run `fn(session)` inside a transaction. Transient errors (write conflicts) re-run `fn` from
 * scratch, so `fn` must re-read whatever it needs through `session` and must not keep state
 * from a previous attempt. Do side effects (events, HTTP calls) after this returns.
 */
export async function withTransaction(fn, { retries = 5 } = {}) {
  if (support === null && mongoose.connection.readyState === 1) {
    await detectTransactionSupport();
  }
  if (support === false) {
    if (!allowNoTransactions()) {
      throw new AppError(
        500,
        "MongoDB transactions are unavailable (server is not a replica set). Run MongoDB as a replica set.",
        "TRANSACTIONS_UNAVAILABLE"
      );
    }
    warnOnce();
    return fn(null);
  }

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const session = await mongoose.startSession();
    try {
      session.startTransaction({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      const result = await fn(session);
      // Commit can fail with UnknownTransactionCommitResult; retrying the commit alone is safe.
      for (let commitTry = 0; ; commitTry += 1) {
        try {
          await session.commitTransaction();
          break;
        } catch (err) {
          if (hasLabel(err, "UnknownTransactionCommitResult") && commitTry < 3) continue;
          throw err;
        }
      }
      runHooks(session);
      return result;
    } catch (err) {
      try {
        if (session.inTransaction()) await session.abortTransaction();
      } catch {
        /* already aborted */
      }
      if (noReplicaError(err)) {
        support = false;
        if (allowNoTransactions()) {
          warnOnce();
          return fn(null);
        }
        throw new AppError(
          500,
          "MongoDB transactions are unavailable (server is not a replica set). Run MongoDB as a replica set.",
          "TRANSACTIONS_UNAVAILABLE"
        );
      }
      if (isTransient(err) && attempt < retries) {
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 20 * attempt)));
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

/**
 * Register work (events, notifications, HTTP calls) to run only after the transaction commits.
 * Hooks from an attempt that was retried or aborted are dropped with that attempt's session.
 */
export function afterCommit(session, fn) {
  if (!session) {
    setImmediate(() => Promise.resolve().then(fn).catch((err) => console.error("afterCommit", err?.message)));
    return;
  }
  (session.__afterCommit ||= []).push(fn);
}

function runHooks(session) {
  for (const fn of session.__afterCommit || []) {
    Promise.resolve().then(fn).catch((err) => console.error("afterCommit", err?.message));
  }
  session.__afterCommit = [];
}

/** Mongoose query options with the session attached only when there is one. */
export function withSession(session, extra = {}) {
  return session ? { ...extra, session } : { ...extra };
}
