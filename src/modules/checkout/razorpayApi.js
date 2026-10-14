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
  // Route linked accounts live under /v2 (p4-payouts); everything else is /v1.
  const url = path.startsWith("/v2/") ? `https://api.razorpay.com${path}` : `https://api.razorpay.com/v1${path}`;
  const response = await fetch(url, {
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
  /** The payment as Razorpay recorded it. This, not the browser, decides captured amount and status. */
  fetchPayment: (paymentId) => request("GET", `/payments/${encodeURIComponent(paymentId)}`),
  fetchOrder: (orderId) => request("GET", `/orders/${encodeURIComponent(orderId)}`),
  /** Manual-capture accounts: the server captures the exact paise on the Razorpay order. */
  capturePayment: (paymentId, amount) =>
    request("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, { amount, currency: "INR" }),
  createRefund: (paymentId, { amount, notes, receipt }) =>
    request("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, speed: "normal", notes, receipt }),
  listRefunds: (paymentId) => request("GET", `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`),
  fetchRefund: (paymentId, refundId) =>
    request("GET", `/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`),
  // Seller subscription billing (p3-billing): Razorpay Plans / Subscriptions / Payment Links.
  createPlan: ({ period, interval = 1, item, notes }) => request("POST", "/plans", { period, interval, item, notes }),
  createSubscription: (body) => request("POST", "/subscriptions", body),
  fetchSubscription: (id) => request("GET", `/subscriptions/${encodeURIComponent(id)}`),
  updateSubscription: (id, body) => request("PATCH", `/subscriptions/${encodeURIComponent(id)}`, body),
  cancelSubscription: (id, { cancelAtCycleEnd = false } = {}) =>
    request("POST", `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 }),
  createPaymentLink: (body) => request("POST", "/payment_links", { currency: "INR", ...body }),
  // Reconciliation (p4-tax): settlement recon rows of one day (payments, refunds, transfers, adjustments...).
  fetchSettlementRecon: ({ year, month, day, count = 1000, skip = 0 }) =>
    request("GET", `/settlements/recon/combined?year=${Number(year)}&month=${Number(month)}${day ? `&day=${Number(day)}` : ""}&count=${count}&skip=${skip}`),
  listSettlements: ({ from, to, count = 100, skip = 0 } = {}) =>
    request("GET", `/settlements?count=${count}&skip=${skip}${from ? `&from=${Number(from)}` : ""}${to ? `&to=${Number(to)}` : ""}`),
  // Route (p4-payouts): linked accounts (v2) and transfers.
  createLinkedAccount: (body) => request("POST", "/v2/accounts", body),
  fetchLinkedAccount: (accountId) => request("GET", `/v2/accounts/${encodeURIComponent(accountId)}`),
  createStakeholder: (accountId, body) => request("POST", `/v2/accounts/${encodeURIComponent(accountId)}/stakeholders`, body),
  requestRouteProduct: (accountId, body) =>
    request("POST", `/v2/accounts/${encodeURIComponent(accountId)}/products`, { product_name: "route", tnc_accepted: true, ...body }),
  updateRouteProduct: (accountId, productId, body) =>
    request("PATCH", `/v2/accounts/${encodeURIComponent(accountId)}/products/${encodeURIComponent(productId)}`, body),
  fetchRouteProduct: (accountId, productId) =>
    request("GET", `/v2/accounts/${encodeURIComponent(accountId)}/products/${encodeURIComponent(productId)}`),
  createPaymentTransfers: (paymentId, transfers) =>
    request("POST", `/payments/${encodeURIComponent(paymentId)}/transfers`, { transfers }),
  fetchPaymentTransfers: (paymentId) => request("GET", `/payments/${encodeURIComponent(paymentId)}/transfers`),
  updateTransfer: (id, body) => request("PATCH", `/transfers/${encodeURIComponent(id)}`, body),
  reverseTransfer: (id, body) => request("POST", `/transfers/${encodeURIComponent(id)}/reversals`, body),
  createDirectTransfer: (body) => request("POST", "/transfers", { currency: "INR", ...body }),
  fetchTransfer: (id) => request("GET", `/transfers/${encodeURIComponent(id)}`),
  // Own-fleet COD by UPI QR (phase 5): single-use, fixed-amount QR codes on the platform account.
  createQrCode: (body) => request("POST", "/payments/qr_codes", body),
  closeQrCode: (id) => request("POST", `/payments/qr_codes/${encodeURIComponent(id)}/close`),
  fetchQrPayments: (id) => request("GET", `/payments/qr_codes/${encodeURIComponent(id)}/payments`),
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

export async function fetchPayment(paymentId) {
  return client.fetchPayment(paymentId);
}

export async function capturePayment(paymentId, amountPaise) {
  return client.capturePayment(paymentId, amountPaise);
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

/* ------------------------------------------------ subscription billing (p3-billing) */

/** Razorpay plan: { period: "monthly"|"yearly", interval: 1, item: { name, amount (paise), currency } }. */
export async function createRazorpayPlan(args) {
  return client.createPlan(args);
}

/** { plan_id, total_count, quantity?, start_at?, customer_notify?, notes? } -> { id, status, short_url, ... } */
export async function createRazorpaySubscription(body) {
  return client.createSubscription(body);
}

export async function fetchRazorpaySubscription(id) {
  return client.fetchSubscription(id);
}

/** { plan_id, schedule_change_at: "now" | "cycle_end", quantity?, customer_notify? } */
export async function updateRazorpaySubscription(id, body) {
  return client.updateSubscription(id, body);
}

export async function cancelRazorpaySubscription(id, opts = {}) {
  return client.cancelSubscription(id, opts);
}

/** { amount (paise), description, reference_id, notes, callback_url?, customer? } -> { id, short_url, status } */
export async function createRazorpayPaymentLink(body) {
  return client.createPaymentLink(body);
}

/* ------------------------------------------------ reconciliation (p4-tax) */

/**
 * Every settlement recon row of one day (pages through Razorpay's 1000-row limit). Rows look like
 * { entity_id, type: payment|refund|transfer|reversal|adjustment, amount, fee, tax, debit, credit,
 *   order_id, payment_id, settlement_id, settled_at, ... } (amounts in paise).
 */
export async function fetchSettlementRecon({ year, month, day }) {
  const out = [];
  for (let skip = 0; skip < 50_000; skip += 1000) {
    const page = await client.fetchSettlementRecon({ year, month, day, count: 1000, skip });
    const items = Array.isArray(page?.items) ? page.items : [];
    out.push(...items);
    if (items.length < 1000) break;
  }
  return out;
}

/** Settlements (payouts from Razorpay to the platform account) in a unix-seconds window. */
export async function listSettlements({ from, to } = {}) {
  const page = await client.listSettlements({ from, to, count: 100 });
  return Array.isArray(page?.items) ? page.items : [];
}

/* ------------------------------------------------ Route payouts (p4-payouts) */

/** POST /v2/accounts { email, phone, type: "route", reference_id, legal_business_name, business_type, contact_name, profile, legal_info } -> { id: "acc_..." } */
export async function createLinkedAccount(body) {
  return client.createLinkedAccount(body);
}

export async function fetchLinkedAccount(accountId) {
  return client.fetchLinkedAccount(accountId);
}

/** POST /v2/accounts/:id/stakeholders { name, email, ... } -> { id: "sth_..." } */
export async function createStakeholder(accountId, body) {
  return client.createStakeholder(accountId, body);
}

/** Request the Route product (tnc_accepted) -> { id: "acc_prd_...", activation_status, requirements } */
export async function requestRouteProduct(accountId, body = {}) {
  return client.requestRouteProduct(accountId, body);
}

/** PATCH the product, e.g. { settlements: { account_number, ifsc_code, beneficiary_name }, tnc_accepted: true } */
export async function updateRouteProduct(accountId, productId, body) {
  return client.updateRouteProduct(accountId, productId, body);
}

export async function fetchRouteProduct(accountId, productId) {
  return client.fetchRouteProduct(accountId, productId);
}

/** transfers = [{ account, amount (paise), currency: "INR", notes, on_hold: true|1 }] -> { items: [transfer] } (or { entity:"collection", items }) */
export async function createPaymentTransfers(paymentId, transfers) {
  return client.createPaymentTransfers(paymentId, transfers);
}

export async function fetchPaymentTransfers(paymentId) {
  return client.fetchPaymentTransfers(paymentId);
}

/** PATCH /transfers/:id, e.g. { on_hold: false } to release a held transfer. */
export async function updateTransfer(id, body) {
  return client.updateTransfer(id, body);
}

/** Partial / full reversal of a transfer back to the platform account. */
export async function reverseTransfer(id, amountPaise, notes = {}) {
  return client.reverseTransfer(id, { amount: amountPaise, notes });
}

/** Direct transfer from the platform balance: { account, amount (paise), notes } */
export async function createDirectTransfer(body) {
  return client.createDirectTransfer(body);
}

export async function fetchTransfer(id) {
  return client.fetchTransfer(id);
}

/* ------------------------------------------------ own-fleet COD by UPI QR (phase 5) */

/**
 * { type: "upi_qr", name, usage: "single_use", fixed_amount: true, payment_amount (paise),
 *   description, close_by (unix s), notes } -> { id: "qr_...", image_url, status, payment_amount, ... }
 */
export async function createQrCode(body) {
  return client.createQrCode(body);
}

export async function closeQrCode(id) {
  return client.closeQrCode(id);
}

/** Payments made on a QR code -> { items: [payment] } */
export async function fetchQrPayments(id) {
  return client.fetchQrPayments(id);
}
