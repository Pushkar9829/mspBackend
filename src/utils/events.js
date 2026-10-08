import { EventEmitter } from "events";
import { recordAnalyticsSafe } from "../modules/analytics/ingest.js";

/**
 * In-process domain event bus.
 *
 * Listener safety: every listener registered through `bus.on/once/addListener/prependListener`
 * is wrapped so that a synchronous throw or a rejected promise is caught and logged instead of
 * propagating into the emitter (which would break the request) or becoming an unhandled
 * rejection (which crashes the process on Node >= 15).
 *
 * Durable listeners: `onDurable(event, name, fn)` registers a listener whose failures are written
 * to the `EventFailure` collection (a small outbox). `retryFailedEvents()` re-runs only the failed
 * listener with the stored payload (exponential backoff, max attempts) – call it from a cron job.
 */

const failureStats = { count: 0, lastAt: null, recent: [] };
const MAX_RECENT = 50;

function logFailure(event, listenerName, err) {
  failureStats.count += 1;
  failureStats.lastAt = new Date();
  failureStats.recent.unshift({
    event,
    listener: listenerName || "anonymous",
    message: err?.message || String(err),
    at: failureStats.lastAt,
  });
  if (failureStats.recent.length > MAX_RECENT) failureStats.recent.length = MAX_RECENT;
  console.error(`[events] listener "${listenerName || "anonymous"}" for ${event} failed:`, err?.stack || err?.message || err);
}

export function getEventFailureStats() {
  return { count: failureStats.count, lastAt: failureStats.lastAt, recent: [...failureStats.recent] };
}

function runSafely(event, listenerName, fn, args, onFailure) {
  const fail = (err) => {
    logFailure(event, listenerName, err);
    if (onFailure) {
      Promise.resolve()
        .then(() => onFailure(err))
        .catch((outboxErr) => console.error("[events] failed to record event failure", outboxErr?.message || outboxErr));
    }
  };
  try {
    const result = fn(...args);
    if (result && typeof result.then === "function") {
      result.then(undefined, fail);
    }
    return result;
  } catch (err) {
    fail(err);
    return undefined;
  }
}

class SafeEventEmitter extends EventEmitter {
  constructor() {
    super();
    this._wrapped = new WeakMap();
  }

  _wrap(event, listener) {
    if (event === "error" || typeof listener !== "function") return listener;
    let wrapped = this._wrapped.get(listener);
    if (!wrapped) {
      wrapped = (...args) => runSafely(String(event), listener.name, listener, args);
      wrapped.listener = listener;
      this._wrapped.set(listener, wrapped);
    }
    return wrapped;
  }

  on(event, listener) {
    return super.on(event, this._wrap(event, listener));
  }

  addListener(event, listener) {
    return super.addListener(event, this._wrap(event, listener));
  }

  prependListener(event, listener) {
    return super.prependListener(event, this._wrap(event, listener));
  }

  once(event, listener) {
    return super.once(event, this._wrap(event, listener));
  }

  off(event, listener) {
    return super.off(event, this._wrapped.get(listener) || listener);
  }

  removeListener(event, listener) {
    return super.removeListener(event, this._wrapped.get(listener) || listener);
  }
}

export const bus = new SafeEventEmitter();
bus.setMaxListeners(100);

/** name -> { event, fn } for durable listeners (used by retryFailedEvents). */
const durable = new Map();

async function failureModel() {
  const mod = await import("../modules/notifications/eventFailure.model.js");
  return mod.EventFailure;
}

function plainPayload(payload) {
  try {
    return JSON.parse(JSON.stringify(payload ?? {}));
  } catch {
    return {};
  }
}

/**
 * Register a listener whose failures are persisted and retried.
 * `name` must be unique and stable across deploys (it is stored with the failure).
 */
export function onDurable(event, name, fn) {
  if (durable.has(name)) return;
  durable.set(name, { event, fn });
  const listener = (payload) =>
    runSafely(event, name, fn, [payload], async (err) => {
      const EventFailure = await failureModel();
      await EventFailure.create({
        event,
        listener: name,
        payload: plainPayload(payload),
        error: String(err?.message || err).slice(0, 2000),
        attempts: 1,
        nextAttemptAt: new Date(Date.now() + 60 * 1000),
      });
    });
  // Bypass the generic wrapper: runSafely is already applied with outbox handling.
  EventEmitter.prototype.on.call(bus, event, listener);
}

const MAX_ATTEMPTS = 6;

/** Retry failed durable listeners. Safe to run concurrently (each row is claimed atomically). */
export async function retryFailedEvents({ batch = 50 } = {}) {
  const EventFailure = await failureModel();
  let retried = 0;
  let succeeded = 0;
  for (let i = 0; i < batch; i += 1) {
    const now = new Date();
    const row = await EventFailure.findOneAndUpdate(
      { status: "pending", nextAttemptAt: { $lte: now } },
      { $set: { status: "processing", claimedAt: now } },
      { new: true, sort: { nextAttemptAt: 1 } }
    );
    if (!row) break;
    retried += 1;
    const entry = durable.get(row.listener);
    if (!entry) {
      await EventFailure.updateOne({ _id: row._id }, { $set: { status: "dead", error: "listener not registered" } });
      continue;
    }
    try {
      await entry.fn(row.payload);
      await EventFailure.updateOne({ _id: row._id }, { $set: { status: "done", doneAt: new Date() } });
      succeeded += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      await EventFailure.updateOne(
        { _id: row._id },
        {
          $set: {
            status: attempts >= MAX_ATTEMPTS ? "dead" : "pending",
            attempts,
            error: String(err?.message || err).slice(0, 2000),
            nextAttemptAt: new Date(Date.now() + 60 * 1000 * 2 ** attempts),
          },
        }
      );
      logFailure(row.event, row.listener, err);
    }
  }
  // Rows stuck in "processing" (process died mid-retry) go back to pending after 10 minutes.
  await EventFailure.updateMany(
    { status: "processing", claimedAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
    { $set: { status: "pending" } }
  );
  return { retried, succeeded };
}

export function emitDomain(event, payload = {}) {
  try {
    recordAnalyticsSafe(event, payload);
  } catch (err) {
    logFailure(event, "analytics", err);
  }
  bus.emit(event, payload);
  bus.emit("*", { event, payload });
}

/** Alias kept for callers that use the older name. */
export const emitEvent = emitDomain;
