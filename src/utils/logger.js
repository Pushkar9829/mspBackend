import { env } from "../config/env.js";

/**
 * Tiny structured logger (no dependency). JSON lines outside development so Render/Vercel log
 * search can filter on fields; human-readable lines in development.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[env.logLevel] ?? LEVELS.info;

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return { name: err.name, message: err.message, code: err.code, stack: err.stack };
}

function write(level, msg, fields = {}) {
  if ((LEVELS[level] ?? 0) < threshold) return;
  const data = {};
  for (const [k, v] of Object.entries(fields || {})) data[k] = v instanceof Error ? serializeError(v) : v;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (env.isDevLike) {
    const extra = Object.keys(data).length ? ` ${JSON.stringify(data)}` : "";
    out(`[${level}] ${msg}${extra}`);
  } else {
    out(JSON.stringify({ level, time: new Date().toISOString(), msg, ...data }));
  }
}

export const logger = {
  debug: (msg, fields) => write("debug", msg, fields),
  info: (msg, fields) => write("info", msg, fields),
  warn: (msg, fields) => write("warn", msg, fields),
  error: (msg, fields) => write("error", msg, fields),
};
