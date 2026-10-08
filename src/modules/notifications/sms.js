import { env } from "../../config/env.js";

/**
 * SMS via MSG91 Flow API (v5). Indian carriers require DLT-registered templates, so every SMS
 * kind maps to a template id from the environment. A kind without a template id is not sent.
 *
 *   MSG91_AUTH_KEY                      – required to send anything
 *   MSG91_TEMPLATE_ORDER_PLACED         – order placed
 *   MSG91_TEMPLATE_ORDER_CONFIRMED      – order confirmed
 *   MSG91_TEMPLATE_ORDER_STATUS         – generic status update (processing / ready / shipped /
 *                                         out for delivery / delivered); per-status overrides:
 *   MSG91_TEMPLATE_ORDER_SHIPPED, MSG91_TEMPLATE_ORDER_OUT_FOR_DELIVERY, MSG91_TEMPLATE_ORDER_DELIVERED
 *   MSG91_TEMPLATE_ORDER_CANCELLED      – order cancelled
 *   MSG91_TEMPLATE_ORDER_REFUNDED       – refund issued
 *   MSG91_TEMPLATE_PAYMENT_RECEIVED     – payment received
 *   MSG91_TEMPLATE_ACCOUNT_ALERT        – account / store alerts (e.g. store suspended)
 *
 * Template variables sent with every message: name, order, amount, status, message
 * (also var1=order, var2=amount, var3=status for templates using positional names).
 */
export const SMS_TEMPLATE_ENV = {
  ORDER_PLACED: "MSG91_TEMPLATE_ORDER_PLACED",
  ORDER_CONFIRMED: "MSG91_TEMPLATE_ORDER_CONFIRMED",
  ORDER_STATUS: "MSG91_TEMPLATE_ORDER_STATUS",
  ORDER_SHIPPED: "MSG91_TEMPLATE_ORDER_SHIPPED",
  ORDER_OUT_FOR_DELIVERY: "MSG91_TEMPLATE_ORDER_OUT_FOR_DELIVERY",
  ORDER_DELIVERED: "MSG91_TEMPLATE_ORDER_DELIVERED",
  ORDER_CANCELLED: "MSG91_TEMPLATE_ORDER_CANCELLED",
  ORDER_REFUNDED: "MSG91_TEMPLATE_ORDER_REFUNDED",
  PAYMENT_RECEIVED: "MSG91_TEMPLATE_PAYMENT_RECEIVED",
  ACCOUNT_ALERT: "MSG91_TEMPLATE_ACCOUNT_ALERT",
};

const FALLBACK = {
  ORDER_SHIPPED: "ORDER_STATUS",
  ORDER_OUT_FOR_DELIVERY: "ORDER_STATUS",
  ORDER_DELIVERED: "ORDER_STATUS",
  ORDER_PROCESSING: "ORDER_STATUS",
  ORDER_READY: "ORDER_STATUS",
};

export function templateIdFor(kind) {
  const envName = SMS_TEMPLATE_ENV[kind];
  const direct = envName ? process.env[envName] : "";
  if (direct) return direct;
  const fb = FALLBACK[kind];
  return fb ? process.env[SMS_TEMPLATE_ENV[fb]] || "" : "";
}

export function smsConfigured() {
  return Boolean(env.msg91AuthKey);
}

export function normalizeIndianMobile(phone) {
  const raw = String(phone || "").replace(/\D/g, "");
  if (raw.length === 10) return `91${raw}`;
  if (raw.length === 12 && raw.startsWith("91")) return raw;
  if (raw.length === 11 && raw.startsWith("0")) return `91${raw.slice(1)}`;
  return "";
}

const warnedKinds = new Set();

/**
 * Send a templated SMS. `vars` are the template variables. Never throws for "not configured";
 * throws only on transport errors so callers can log them.
 */
export async function sendSms({ phone, kind, vars = {}, message = "" }) {
  const mobile = normalizeIndianMobile(phone);
  if (!mobile) return { sent: false, skipped: "invalid-phone" };
  const templateId = templateIdFor(kind);
  if (!smsConfigured() || !templateId) {
    if (!env.isProd) {
      console.log(`SMS (${kind}) to ${mobile}: ${message || JSON.stringify(vars)}`);
    } else if (smsConfigured() && !warnedKinds.has(kind)) {
      warnedKinds.add(kind);
      console.warn(`[sms] no DLT template configured for ${kind} (${SMS_TEMPLATE_ENV[kind] || "unknown kind"}); SMS not sent`);
    }
    return { sent: false, skipped: !smsConfigured() ? "not-configured" : "no-template" };
  }
  const recipient = {
    mobiles: mobile,
    name: String(vars.name || "").slice(0, 30),
    order: String(vars.order || ""),
    amount: String(vars.amount ?? ""),
    status: String(vars.status || ""),
    message: String(vars.message || message || "").slice(0, 30),
    var1: String(vars.order || ""),
    var2: String(vars.amount ?? ""),
    var3: String(vars.status || ""),
  };
  const response = await fetch("https://control.msg91.com/api/v5/flow/", {
    method: "POST",
    headers: {
      authkey: env.msg91AuthKey,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ template_id: templateId, short_url: "0", recipients: [recipient] }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.type === "error") {
    throw new Error(`MSG91 flow failed: ${data?.message || response.status}`);
  }
  return { sent: true };
}
