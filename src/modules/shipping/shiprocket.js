import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";
import { logger } from "../../utils/logger.js";
import { Tenant } from "../tenants/tenant.model.js";

/**
 * Shiprocket Quick client.
 *
 * One platform account. Each store is its own pickup location (nickname = store slug),
 * so a bag of three stores is three pickups. Home-delivery quotes and bookings go through
 * Shiprocket; the buyer does not choose a courier.
 *
 * Auth is an API user (Settings → API), not the panel password. The JWT is cached until
 * shortly before `exp`. Webhooks POST to /api/v1/shipping/events with header `x-api-key`
 * (the path must not contain "shiprocket" — Shiprocket rejects those URLs).
 */

const LOCAL_COURIER = /shadowfax|borzo|ola|quick|dunzo|loadshare|flash|porter/i;
const serviceableCache = new Map();
const SERVICEABLE_TTL_MS = 60 * 1000;

let cachedToken = null;
let loginFlight = null;

export function shiprocketConfigured() {
  return Boolean(env.shiprocketEmail && env.shiprocketPassword);
}

export function shiprocketWebhookToken() {
  return env.shiprocketWebhookToken || "";
}

function assertConfigured() {
  if (!shiprocketConfigured()) {
    throw new AppError(503, "Shiprocket is not configured. Add the API user email and password.", "SHIPMENT_UNAVAILABLE");
  }
}

function base() {
  return String(env.shiprocketBaseUrl || "https://apiv2.shiprocket.in").replace(/\/$/, "");
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString());
    return Number(payload.exp || 0) * 1000;
  } catch {
    return Date.now() + 24 * 60 * 60 * 1000;
  }
}

function clearToken() {
  cachedToken = null;
}

async function login() {
  assertConfigured();
  const response = await fetch(`${base()}/v1/external/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: env.shiprocketEmail, password: env.shiprocketPassword }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    throw new AppError(502, "Shiprocket login failed. Check the API user email and password.", "SHIPMENT_UNAVAILABLE");
  }
  cachedToken = { token: data.token, exp: tokenExpiry(data.token) };
  return data.token;
}

async function authToken() {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  if (!loginFlight) {
    loginFlight = login().finally(() => {
      loginFlight = null;
    });
  }
  return loginFlight;
}

async function call(path, { method = "GET", json = null, retry = true } = {}) {
  const token = await authToken();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  let body;
  if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const response = await fetch(`${base()}${path}`, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && retry) {
    clearToken();
    return call(path, { method, json, retry: false });
  }
  if (response.status === 429) {
    throw new AppError(503, "Shiprocket is busy. Try again in a moment.", "SHIPMENT_UNAVAILABLE");
  }
  if (!response.ok || data?.status === 0) {
    const raw = data?.message || data?.error || data?.errors || response.statusText || "Shiprocket request failed";
    const message = typeof raw === "string" ? raw : JSON.stringify(raw);
    throw new AppError(response.status >= 500 ? 502 : 400, message.slice(0, 300), "SHIPMENT_FAILED");
  }
  return data;
}

/** Alphanumeric, max 36 — Shiprocket's pickup nickname rule. Stable per store. */
export function pickupNickname(tenant) {
  const raw = String(tenant?.slug || tenant?._id || "store").replace(/[^a-zA-Z0-9]/g, "");
  return (raw || "store").slice(0, 36);
}

function splitName(full) {
  const parts = String(full || "Customer").trim().split(/\s+/).filter(Boolean);
  return { first: (parts[0] || "Customer").slice(0, 50), last: (parts.slice(1).join(" ") || ".").slice(0, 50) };
}

export function packageMetrics(order) {
  let grams = 0;
  let l = 0;
  let w = 0;
  let h = 0;
  for (const item of order?.items || []) {
    const qty = Number(item.qty) || 1;
    grams += (Number(item.weightGrams) || 0) * qty;
    const d = item.dimensionsCm || {};
    l = Math.max(l, Number(d.l) || 0);
    w = Math.max(w, Number(d.w) || 0);
    h += (Number(d.h) || 0) * qty;
  }
  return {
    weightKg: Math.max(0.5, Math.round((grams || 500) / 100) / 10),
    length: Math.max(1, Math.round(l || 10)),
    width: Math.max(1, Math.round(w || 10)),
    height: Math.max(1, Math.min(Math.round(h || 10), 200)),
  };
}

function orderItems(order) {
  const items = (order.items || []).map((item) => ({
    name: String(item.name || "Item").slice(0, 100),
    sku: String(item.sku || item.variantId || "item").slice(0, 50),
    units: Number(item.qty) || 1,
    selling_price: Number(item.unitPrice) || 0,
  }));
  return items.length ? items : [{ name: "Order", sku: "order", units: 1, selling_price: Number(order.total) || 0 }];
}

function formatStamp(value) {
  const d = value ? new Date(value) : new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function pickCourier(list) {
  const rows = (list || []).filter((row) => row && row.courier_company_id != null);
  if (!rows.length) return null;
  const local = rows.filter((row) => LOCAL_COURIER.test(row.courier_name || ""));
  const pool = local.length ? local : rows;
  pool.sort((a, b) => Number(a.rate ?? a.freight_charge ?? 0) - Number(b.rate ?? b.freight_charge ?? 0));
  return pool[0];
}

/**
 * Whether Shiprocket can ride from the store PIN to the buyer PIN.
 * Returns { serviceable, rate, etaDays, courierId, courierName }.
 * Results are cached for a minute per PIN pair.
 */
export async function quoteDelivery({ pickupPostcode, deliveryPostcode, weightKg = 0.5, cod = false }) {
  assertConfigured();
  const from = digits(pickupPostcode);
  const to = digits(deliveryPostcode);
  if (from.length !== 6 || to.length !== 6) {
    return { serviceable: false, rate: 0, etaDays: null, courierId: null, courierName: "" };
  }
  const key = `${from}:${to}:${cod ? 1 : 0}:${weightKg}`;
  const hit = serviceableCache.get(key);
  if (hit && hit.at > Date.now() - SERVICEABLE_TTL_MS) return hit.value;
  const query = new URLSearchParams({
    pickup_postcode: from,
    delivery_postcode: to,
    weight: String(weightKg),
    cod: cod ? "1" : "0",
  });
  const data = await call(`/v1/external/courier/serviceability/?${query}`);
  const companies = data?.data?.available_courier_companies || data?.available_courier_companies || [];
  const courier = pickCourier(companies);
  const etaDays = courier ? Number(courier.estimated_delivery_days) || null : null;
  const value = {
    serviceable: Boolean(courier),
    rate: courier ? Math.max(0, Number(courier.rate ?? courier.freight_charge ?? 0) || 0) : 0,
    etaDays: Number.isFinite(etaDays) && etaDays > 0 ? etaDays : null,
    courierId: courier ? Number(courier.courier_company_id) : null,
    courierName: courier?.courier_name || "",
  };
  serviceableCache.set(key, { at: Date.now(), value });
  if (serviceableCache.size > 500) serviceableCache.delete(serviceableCache.keys().next().value);
  return value;
}

/** Register this store as a Shiprocket pickup once. The nickname is saved on the tenant. */
export async function ensurePickupLocation(tenant) {
  assertConfigured();
  const nick = pickupNickname(tenant);
  if (tenant.shiprocketPickup === nick) return nick;
  const addr = tenant.pickupAddress || {};
  const pin = digits(addr.postalCode);
  const phone = digits(addr.phone || tenant.businessProfile?.phone).slice(-10);
  const email = String(tenant.businessProfile?.email || "").trim();
  if (pin.length !== 6) {
    throw new AppError(400, "Set the store pickup PIN before Shiprocket can collect the order", "SHIPMENT_ADDRESS");
  }
  if (phone.length !== 10) {
    throw new AppError(400, "Set a 10-digit phone on the store pickup address", "SHIPMENT_ADDRESS");
  }
  if (!email.includes("@")) {
    throw new AppError(400, "Set the store email before Shiprocket can collect the order", "SHIPMENT_ADDRESS");
  }
  try {
    await call("/v1/external/settings/company/addpickup", {
      method: "POST",
      json: {
        pickup_location: nick,
        name: String(addr.contactName || tenant.name || "Store").slice(0, 50),
        email,
        phone,
        address: String(addr.addressLine1 || addr.formatted || tenant.name || "Store").slice(0, 180),
        address_2: "",
        city: addr.city || "NA",
        state: addr.state || "NA",
        country: "India",
        pin_code: pin,
      },
    });
  } catch (err) {
    const msg = String(err.message || "").toLowerCase();
    if (!msg.includes("exist") && !msg.includes("already")) throw err;
  }
  await Tenant.updateOne({ _id: tenant._id }, { $set: { shiprocketPickup: nick } });
  return nick;
}

function readShipment(data) {
  const payload = data?.payload || data?.response?.data || data?.data || data || {};
  return {
    awb: String(payload.awb_code || payload.awb || data?.awb_code || ""),
    orderId: String(payload.order_id || data?.order_id || ""),
    shipmentId: String(payload.shipment_id || data?.shipment_id || ""),
    courierName: payload.courier_name || "Shiprocket Quick",
  };
}

export async function createForwardShipment(order) {
  assertConfigured();
  const tenant = await Tenant.findById(order.tenantId).lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  const pickup = await ensurePickupLocation(tenant);
  const metrics = packageMetrics(order);
  const address = order.addressSnapshot || {};
  const buyer = order.buyerSnapshot || {};
  const name = splitName(address.contactName || buyer.name);
  const phone = digits(address.phone || buyer.phone).slice(-10);
  const pin = digits(address.postalCode);
  if (pin.length !== 6 || phone.length !== 10) {
    throw new AppError(400, "The delivery address needs a 6-digit PIN and a 10-digit phone", "SHIPMENT_ADDRESS");
  }
  const quote = await quoteDelivery({
    pickupPostcode: tenant.pickupAddress?.postalCode,
    deliveryPostcode: pin,
    weightKg: metrics.weightKg,
    cod: order.paymentMethod === "cod",
  });
  if (!quote.serviceable) {
    throw new AppError(400, "Shiprocket cannot deliver from this store to that PIN", "NOT_SERVICEABLE");
  }
  const data = await call("/v1/external/shipments/create/forward-shipment", {
    method: "POST",
    json: {
      order_id: String(order.orderNumber).slice(0, 50),
      order_date: formatStamp(order.createdAt),
      pickup_location: pickup,
      billing_customer_name: name.first,
      billing_last_name: name.last,
      billing_address: String(address.addressLine1 || address.formatted || "Address").slice(0, 180),
      billing_address_2: String(address.addressLine2 || "").slice(0, 180),
      billing_city: address.city || "NA",
      billing_pincode: pin,
      billing_state: address.state || "NA",
      billing_country: "India",
      billing_email: buyer.email || tenant.businessProfile?.email,
      billing_phone: Number(phone),
      shipping_is_billing: true,
      order_items: orderItems(order),
      payment_method: order.paymentMethod === "cod" ? "COD" : "Prepaid",
      sub_total: Number(order.total) || 0,
      length: metrics.length,
      breadth: metrics.width,
      height: metrics.height,
      weight: metrics.weightKg,
      courier_id: quote.courierId || undefined,
      request_pickup: true,
    },
  });
  const shipment = readShipment(data);
  if (!shipment.awb && !shipment.orderId) {
    throw new AppError(502, "Shiprocket could not create the shipment", "SHIPMENT_FAILED");
  }
  logger.info("shiprocket shipment created", { order: order.orderNumber, awb: shipment.awb, courier: shipment.courierName });
  return shipment;
}

/** Reverse pickup: rider collects from the buyer and returns the parcel to the store. */
export async function createReturnShipment(order) {
  assertConfigured();
  const tenant = await Tenant.findById(order.tenantId).lean();
  if (!tenant) throw new AppError(404, "Store not found", "NOT_FOUND");
  await ensurePickupLocation(tenant);
  const addr = tenant.pickupAddress || {};
  const buyerAddr = order.addressSnapshot || {};
  const buyer = order.buyerSnapshot || {};
  const buyerName = splitName(buyerAddr.contactName || buyer.name);
  const storePhone = digits(addr.phone || tenant.businessProfile?.phone).slice(-10);
  const buyerPhone = digits(buyerAddr.phone || buyer.phone).slice(-10);
  const metrics = packageMetrics(order);
  const data = await call("/v1/external/orders/create/return", {
    method: "POST",
    json: {
      order_id: `${String(order.orderNumber).slice(0, 46)}-R`,
      order_date: formatStamp(new Date()),
      pickup_customer_name: buyerName.first,
      pickup_last_name: buyerName.last,
      pickup_address: String(buyerAddr.addressLine1 || buyerAddr.formatted || "Address").slice(0, 180),
      pickup_city: buyerAddr.city || "NA",
      pickup_state: buyerAddr.state || "NA",
      pickup_country: "India",
      pickup_pincode: digits(buyerAddr.postalCode),
      pickup_email: buyer.email || tenant.businessProfile?.email,
      pickup_phone: buyerPhone,
      shipping_customer_name: String(tenant.name || "Store").slice(0, 50),
      shipping_address: String(addr.addressLine1 || addr.formatted || tenant.name).slice(0, 180),
      shipping_city: addr.city || "NA",
      shipping_state: addr.state || "NA",
      shipping_country: "India",
      shipping_pincode: digits(addr.postalCode),
      shipping_email: tenant.businessProfile?.email,
      shipping_phone: storePhone,
      order_items: orderItems(order),
      payment_method: "Prepaid",
      sub_total: Number(order.total) || 0,
      length: metrics.length,
      breadth: metrics.width,
      height: metrics.height,
      weight: metrics.weightKg,
    },
  });
  const shipment = readShipment(data);
  if (shipment.shipmentId && !shipment.awb) {
    try {
      const assigned = await call("/v1/external/courier/assign/awb", {
        method: "POST",
        json: { shipment_id: Number(shipment.shipmentId) },
      });
      const awb = assigned?.response?.data?.awb_code || assigned?.awb_code || "";
      if (awb) shipment.awb = String(awb);
    } catch (err) {
      logger.warn("shiprocket return awb assign failed", { order: order.orderNumber, err: err.message });
    }
  }
  return shipment;
}

export async function cancelShiprocketOrder(externalOrderId) {
  if (!shiprocketConfigured() || !externalOrderId) return { cancelled: false };
  const id = Number(externalOrderId);
  if (!Number.isFinite(id)) return { cancelled: false };
  await call("/v1/external/orders/cancel", { method: "POST", json: { ids: [id] } });
  return { cancelled: true };
}

export async function trackShipment(awb) {
  assertConfigured();
  const data = await call(`/v1/external/courier/track/awb/${encodeURIComponent(String(awb))}`);
  const track = data?.tracking_data || data || {};
  const shipment = track.shipment_track?.[0] || {};
  return {
    waybill: String(awb),
    status: shipment.current_status || track.shipment_status || "",
    location: shipment.location || "",
    expectedDelivery: shipment.edd || track.etd || null,
    mappedStatus: mapShiprocketStatus(shipment.current_status || track.shipment_status, shipment.shipment_status_id),
  };
}

/**
 * Map a Shiprocket scan onto our order status. null means record the scan and do not move the order.
 * RTO never maps to delivered.
 */
export function mapShiprocketStatus(label, statusId) {
  const id = Number(statusId);
  const text = String(label || "").trim().toLowerCase().replace(/\s+/g, " ");
  // 10 = RTO Delivered: the parcel reached the seller (restock + refund happen now).
  if (id === 10 || /rto delivered|returned to origin|rto_delivered/.test(text)) return "returned_to_origin";
  // 9 RTO initiated, 14 RTO acknowledged, 40 RTO NDR, 41 RTO OFD, 46 RTO in transit: on its way back.
  if ([9, 14, 40, 41, 46].includes(id) || text.includes("rto") || text.includes("return to origin")) {
    return "rto_in_transit";
  }
  if (id === 7 || text === "delivered") return "delivered";
  if (id === 17 || text.includes("out for delivery")) return "out_for_delivery";
  if (
    [6, 18, 20, 42, 51, 52].includes(id) ||
    text.includes("picked up") ||
    text.includes("in transit") ||
    text === "shipped"
  ) {
    return "shipped";
  }
  return null;
}

/** Shiprocket sends "23 05 2023 11:43:52" as well as ISO timestamps. */
export function parseShiprocketTime(value) {
  if (!value) return new Date();
  const match = String(value).match(/^(\d{2}) (\d{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (match) return new Date(`${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6]}`);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}
