import crypto from "crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { links } from "../../utils/links.js";
import { NotificationPreference, DEFAULT_PREFERENCES, LOCKED_CHANNELS } from "./preference.model.js";
import { NOTIFICATION_CATEGORIES } from "./notification.model.js";

export const CHANNELS = ["inApp", "email", "sms"];

export const EVENT_CATEGORY = {
  ORDER_CREATED: "order",
  ORDER_CONFIRMED: "order",
  ORDER_PAID: "order",
  ORDER_PROCESSING: "order",
  ORDER_READY: "order",
  ORDER_SHIPPED: "order",
  ORDER_OUT_FOR_DELIVERY: "order",
  ORDER_DELIVERED: "order",
  ORDER_CANCELLED: "order",
  ORDER_RETURN_REQUESTED: "order",
  ORDER_REFUNDED: "order",
  ORDER_TIMEOUT: "order",
  NEW_ORDER: "order",
  LOW_STOCK: "inventory",
  OUT_OF_STOCK: "inventory",
  CHAT_MESSAGE: "chat",
  CHAT_ASSIGNED: "chat",
  CHAT_ESCALATED: "chat",
  PRICE_DROP: "marketing",
  COUPON_CREATED: "marketing",
  RESTOCK_AVAILABLE: "marketing",
  GLOBAL_ANNOUNCEMENT: "marketing",
  ACCOUNT_LOGIN: "account",
  TENANT_SUSPENDED: "account",
};

export function categoryFor(event) {
  return EVENT_CATEGORY[event] || "account";
}

function merge(doc) {
  const out = {};
  for (const cat of NOTIFICATION_CATEGORIES) {
    const stored = doc?.categories?.[cat] || {};
    out[cat] = {};
    for (const ch of CHANNELS) {
      const v = stored[ch];
      out[cat][ch] = typeof v === "boolean" ? v : DEFAULT_PREFERENCES[cat][ch];
    }
    for (const ch of LOCKED_CHANNELS[cat] || []) out[cat][ch] = true;
  }
  return out;
}

export async function getPreferences(userId) {
  const doc = await NotificationPreference.findOne({ userId }).lean();
  return merge(doc);
}

export async function allowed(userId, category, channel) {
  const prefs = await getPreferences(userId);
  return Boolean(prefs[category]?.[channel]);
}

/** `patch` = { [category]: { inApp?, email?, sms? } } (already validated). */
export async function updatePreferences(userId, patch) {
  const $set = {};
  for (const [cat, channels] of Object.entries(patch || {})) {
    if (!NOTIFICATION_CATEGORIES.includes(cat)) continue;
    for (const [ch, value] of Object.entries(channels || {})) {
      if (!CHANNELS.includes(ch) || typeof value !== "boolean") continue;
      if ((LOCKED_CHANNELS[cat] || []).includes(ch) && value === false) {
        throw new AppError(400, `${cat} ${ch} notifications cannot be turned off`, "VALIDATION_ERROR");
      }
      $set[`categories.${cat}.${ch}`] = value;
    }
  }
  if (Object.keys($set).length) {
    await NotificationPreference.updateOne({ userId }, { $set }, { upsert: true });
  }
  return getPreferences(userId);
}

/* ---------------------- signed unsubscribe links --------------------- */

function secret() {
  return env.notificationUnsubscribeSecret || env.jwtAccessSecret;
}

function sign(data) {
  return crypto.createHmac("sha256", secret()).update(data).digest("base64url");
}

export function unsubscribeToken(userId, category, channel = "email") {
  const data = Buffer.from(JSON.stringify({ u: String(userId), c: category, ch: channel })).toString("base64url");
  return `${data}.${sign(data)}`;
}

export function unsubscribeUrl(userId, category, channel = "email") {
  return links.unsubscribe(unsubscribeToken(userId, category, channel));
}

export async function unsubscribeWithToken(token) {
  const [data, sig] = String(token || "").split(".");
  if (!data || !sig) throw new AppError(400, "Invalid unsubscribe link", "VALIDATION_ERROR");
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(data));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AppError(400, "Invalid unsubscribe link", "VALIDATION_ERROR");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    throw new AppError(400, "Invalid unsubscribe link", "VALIDATION_ERROR");
  }
  if (!NOTIFICATION_CATEGORIES.includes(parsed.c) || !CHANNELS.includes(parsed.ch) || !/^[a-f\d]{24}$/i.test(parsed.u)) {
    throw new AppError(400, "Invalid unsubscribe link", "VALIDATION_ERROR");
  }
  if ((LOCKED_CHANNELS[parsed.c] || []).includes(parsed.ch)) {
    return { ok: true, category: parsed.c, channel: parsed.ch, locked: true };
  }
  await NotificationPreference.updateOne(
    { userId: parsed.u },
    { $set: { [`categories.${parsed.c}.${parsed.ch}`]: false } },
    { upsert: true }
  );
  return { ok: true, category: parsed.c, channel: parsed.ch };
}
