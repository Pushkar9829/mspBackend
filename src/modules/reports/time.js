import * as constants from "../../config/constants.js";
import { AppError } from "../../utils/AppError.js";

/** Business timezone for all day bucketing (reports, analytics rollups, date filters). */
export const BUSINESS_TZ = constants.BUSINESS_TZ || "Asia/Kolkata";

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** "YYYY-MM-DD" of `date` in the business timezone. */
export function dayKey(date = new Date()) {
  return dayFmt.format(date);
}

/** Offset (minutes) of the business timezone from UTC at `date`. */
function offsetMinutes(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** UTC instant of 00:00 business time on calendar day "YYYY-MM-DD". */
export function startOfDay(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - offsetMinutes(guess) * 60000);
}

/** UTC instant of 23:59:59.999 business time on "YYYY-MM-DD". */
export function endOfDay(day) {
  return new Date(startOfDay(addDays(day, 1)).getTime() - 1);
}

export function addDays(day, n) {
  const [y, m, d] = String(day).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** Start of the business day `n` days before today (n = 0 → today 00:00 IST). */
export function startOfDaysAgo(n, now = new Date()) {
  return startOfDay(addDays(dayKey(now), -n));
}

/** Every business-day key from `from` to `to` inclusive. */
export function dayList(from, to) {
  const days = [];
  let cur = dayKey(from);
  const end = dayKey(to);
  let guard = 0;
  while (cur <= end && guard < 3700) {
    days.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return days;
}

/**
 * Parse a from/to bound. "YYYY-MM-DD" is a business-timezone calendar day (start or end of day);
 * anything else must be an ISO timestamp. Invalid → 400.
 */
export function parseBound(value, isEnd = false) {
  if (value === undefined || value === null || value === "") return null;
  const v = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = isEnd ? endOfDay(v) : startOfDay(v);
    if (Number.isNaN(d.getTime())) throw new AppError(400, "Invalid date", "VALIDATION_ERROR");
    return d;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError(400, "Invalid date", "VALIDATION_ERROR");
  return d;
}

/** MongoDB `$dateToString` stage fragment bucketing `$field` by business day. */
export function mongoDay(field = "$createdAt") {
  return { $dateToString: { format: "%Y-%m-%d", date: field, timezone: BUSINESS_TZ } };
}
