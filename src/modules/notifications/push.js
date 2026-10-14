import crypto from "crypto";
import fs from "fs";
import { DeviceToken } from "./device.model.js";
import { allowed } from "./preferences.js";

/**
 * Mobile push (phase 6) through Firebase Cloud Messaging HTTP v1.
 *
 *   FCM_SERVICE_ACCOUNT_JSON  the service-account JSON (raw JSON or base64 of it), or
 *   FCM_SERVICE_ACCOUNT_PATH  path to the service-account JSON file.
 * Neither set -> push is skipped silently (in-app / email / SMS still work).
 *
 * Every push carries `data` (string values only): { notificationId, event, category, title, body,
 * deepLink, orderId?, disputeId?, taskId? }. Deep links: msp://order/<orderId>,
 * msp://dispute/<disputeId>, msp://rider/task/<taskId>, else msp://notifications.
 * Tokens FCM reports as unregistered / invalid are deleted.
 *
 * Tests: setPushSender(fn) replaces the FCM call; fn({ token, title, body, data, platform, app })
 * -> { ok: true } | { ok: false, invalidToken?: boolean, error?: string }.
 */

let customSender = null;
export function setPushSender(fn) {
  customSender = typeof fn === "function" ? fn : null;
}

let account;
let accountError = "";
function serviceAccount() {
  if (account !== undefined) return account;
  account = null;
  try {
    let raw = String(process.env.FCM_SERVICE_ACCOUNT_JSON || "").trim();
    if (!raw && process.env.FCM_SERVICE_ACCOUNT_PATH) raw = fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_PATH, "utf8");
    if (raw && !raw.startsWith("{")) raw = Buffer.from(raw, "base64").toString("utf8");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.client_email && parsed.private_key && parsed.project_id) account = parsed;
      else accountError = "service account JSON is missing client_email / private_key / project_id";
    }
  } catch (err) {
    accountError = err.message;
  }
  if (accountError) console.warn(`[push] FCM disabled: ${accountError}`);
  return account;
}

/** Test hook: forget the parsed service account (env changed). */
export function __resetPushConfig() {
  account = undefined;
  accountError = "";
  cachedToken = null;
}

export function pushConfigured() {
  return Boolean(customSender || serviceAccount());
}

let cachedToken = null;
async function accessToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.value;
  const sa = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`FCM auth failed: ${data.error_description || data.error || res.status}`);
  cachedToken = { value: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return cachedToken.value;
}

async function fcmSend({ token, title, body, data }) {
  const sa = serviceAccount();
  const auth = await accessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        token,
        notification: { title, body },
        data,
        android: { priority: "high", notification: { channel_id: "default", click_action: "OPEN_DEEP_LINK" } },
        apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
      },
    }),
  });
  if (res.ok) return { ok: true };
  const err = await res.json().catch(() => ({}));
  const status = err?.error?.status || "";
  const code = (err?.error?.details || []).map((d) => d.errorCode).find(Boolean) || "";
  const invalidToken = res.status === 404 || code === "UNREGISTERED" || (status === "INVALID_ARGUMENT" && /token/i.test(err?.error?.message || ""));
  return { ok: false, invalidToken, error: `${res.status} ${code || status} ${err?.error?.message || ""}`.trim() };
}

/** App deep link for a notification's data. */
export function deepLinkFor(event, data = {}) {
  const id = (v) => String(v?._id || v || "");
  if (data.disputeId) return `msp://dispute/${id(data.disputeId)}`;
  if (data.taskId && /^RIDER_/.test(String(event || ""))) return `msp://rider/task/${id(data.taskId)}`;
  if (data.orderId) return `msp://order/${id(data.orderId)}`;
  return "msp://notifications";
}

/** FCM data payload (all values strings). */
export function pushData(doc) {
  const d = doc.data || {};
  const out = {
    notificationId: String(doc._id || ""),
    event: String(doc.event || ""),
    category: String(doc.category || ""),
    title: String(doc.title || ""),
    body: String(doc.body || "").slice(0, 1000),
    deepLink: deepLinkFor(doc.event, d),
  };
  for (const key of ["orderId", "orderNumber", "disputeId", "taskId", "returnId"]) {
    if (d[key] != null && d[key] !== "") out[key] = String(d[key]?._id || d[key]);
  }
  return out;
}

/**
 * Push one personal notification to every registered device of its user (if the user allows
 * push for the category). Never throws. Returns { sent, failed, pruned, skipped? }.
 */
export async function pushNotification(doc) {
  const result = { sent: 0, failed: 0, pruned: 0 };
  try {
    if (!doc?.userId) return { ...result, skipped: "no-user" };
    if (!pushConfigured()) return { ...result, skipped: "not-configured" };
    if (!(await allowed(doc.userId, doc.category || "account", "push"))) return { ...result, skipped: "preference" };
    const devices = await DeviceToken.find({ userId: doc.userId }).sort({ lastSeenAt: -1 }).limit(10).lean();
    if (!devices.length) return { ...result, skipped: "no-devices" };
    const data = pushData(doc);
    const title = String(doc.title || "").slice(0, 200);
    const body = String(doc.body || "").slice(0, 500);
    for (const dev of devices) {
      let r;
      try {
        r = customSender
          ? await customSender({ token: dev.token, title, body, data, platform: dev.platform, app: dev.app })
          : await fcmSend({ token: dev.token, title, body, data });
      } catch (err) {
        r = { ok: false, error: err.message };
      }
      if (r?.ok) {
        result.sent += 1;
        await DeviceToken.updateOne({ _id: dev._id }, { $set: { lastPushAt: new Date(), failures: 0, lastError: "" } });
      } else if (r?.invalidToken) {
        result.pruned += 1;
        await DeviceToken.deleteOne({ _id: dev._id });
      } else {
        result.failed += 1;
        await DeviceToken.updateOne({ _id: dev._id }, { $inc: { failures: 1 }, $set: { lastError: String(r?.error || "send failed").slice(0, 300) } });
      }
    }
  } catch (err) {
    console.error("[push] failed", err.message);
  }
  return result;
}
