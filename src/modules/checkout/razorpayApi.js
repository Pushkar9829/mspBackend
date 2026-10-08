import crypto from "crypto";
import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

/** Plain Razorpay HTTP client (no order logic here, so it can be imported from anywhere). */

export const ONLINE_PAYMENT_METHODS = ["upi", "card", "netbanking"];

export function toPaise(rupees) {
  return Math.round((Number(rupees) || 0) * 100 + 1e-7);
}

export function hmac(secret, payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

export function signaturesMatch(expected, actual) {
  const a = Buffer.from(String(expected || ""));
  const b = Buffer.from(String(actual || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function razorpayConfigured() {
  return Boolean(env.razorpayKeyId && env.razorpayKeySecret);
}

async function request(method, path, body) {
  if (!razorpayConfigured()) {
    throw new AppError(503, "Online payment is not configured. Add Razorpay keys.", "PAYMENT_UNAVAILABLE");
  }
  const auth = Buffer.from(`${env.razorpayKeyId}:${env.razorpayKeySecret}`).toString("base64");
  const response = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AppError(502, data?.error?.description || "Razorpay request failed", "PAYMENT_PROVIDER_ERROR");
  }
  return data;
}

const httpClient = {
  createOrder: ({ amount, receipt, notes }) => request("POST", "/orders", { amount, currency: "INR", receipt, notes }),
  createRefund: (paymentId, { amount, notes, receipt }) =>
    request("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, speed: "normal", notes, receipt }),
  listRefunds: (paymentId) => request("GET", `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`),
  fetchRefund: (paymentId, refundId) =>
    request("GET", `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`),
};

let client = httpClient;

/** Tests swap in a fake provider. */
export function setRazorpayClient(fake) {
  client = fake ? { ...httpClient, ...fake } : httpClient;
}

export function razorpayClient() {
  return client;
}

export async function createRazorpayOrder(args) {
  return client.createOrder(args);
}

/**
 * Refund `amountPaise` of a payment exactly once per `refundKey`: looks for an existing refund
 * carrying the key in its notes before creating a new one (safe to retry after a timeout).
 * Refunds Razorpay reported as failed are not reused: a new attempt is created with an
 * attempt-suffixed receipt. If the existing refunds cannot be listed we throw (the caller marks
 * the intent failed and retries later) rather than risk a duplicate refund.
 */
export async function createRefund({ paymentId, amountPaise, refundKey, reason = "" }) {
  const existing = await client.listRefunds(paymentId);
  const items = Array.isArray(existing?.items) ? existing.items : [];
  const mine = items.filter((row) => row?.notes?.refund_key === refundKey);
  const match = mine.find((row) => row?.status !== "failed");
  if (match) return match;
  const attempt = mine.length; // failed attempts so far
  const suffix = attempt ? `#${attempt + 1}` : "";
  return client.createRefund(paymentId, {
    amount: amountPaise,
    receipt: String(refundKey).slice(0, 40 - suffix.length) + suffix,
    notes: { refund_key: refundKey, refund_attempt: String(attempt + 1), reason: String(reason).slice(0, 200) },
  });
}

/** Current state of a refund at Razorpay (used to finalise refunds whose webhook never came). */
export async function fetchRefund(paymentId, refundId) {
  return client.fetchRefund(paymentId, refundId);
}
