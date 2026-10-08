import { env } from "../../config/env.js";
import { AppError } from "../../utils/AppError.js";

/**
 * Delhivery B2C API client. Package weight/dimensions come from the order lines (copied from
 * the variant at checkout) with configurable fallbacks:
 *   DELHIVERY_DEFAULT_WEIGHT_GRAMS (500), DELHIVERY_DEFAULT_DIMENSIONS_CM ("10x10x10"),
 *   DELHIVERY_WEBHOOK_SECRET (shared secret expected in the x-delhivery-secret header).
 */

const DEFAULT_WEIGHT = Number(process.env.DELHIVERY_DEFAULT_WEIGHT_GRAMS) || 500;
const DEFAULT_DIMS = String(process.env.DELHIVERY_DEFAULT_DIMENSIONS_CM || "10x10x10")
  .split("x")
  .map((n) => Number(n) || 10);

export function delhiveryConfigured() {
  return Boolean(env.delhiveryToken && env.delhiveryPickupName);
}

export function delhiveryWebhookSecret() {
  return process.env.DELHIVERY_WEBHOOK_SECRET || "";
}

function base() {
  return String(env.delhiveryBaseUrl || "").replace(/\/$/, "");
}

function clean(value) {
  return String(value || "")
    .replace(/[&%#;\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function assertConfigured() {
  if (!delhiveryConfigured()) {
    throw new AppError(503, "Delhivery is not configured. Add the token and pickup warehouse name.", "SHIPMENT_UNAVAILABLE");
  }
}

async function call(path, { method = "GET", form = null, json = null } = {}) {
  assertConfigured();
  const headers = { Authorization: `Token ${env.delhiveryToken}`, Accept: "application/json" };
  let body;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = form;
  } else if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const response = await fetch(`${base()}${path}`, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

/** Total weight (grams) and a box that fits the largest line, from order line metadata. */
export function packageMetrics(order) {
  let weight = 0;
  let l = 0;
  let w = 0;
  let h = 0;
  for (const item of order.items || []) {
    const unit = Number(item.weightGrams) || 0;
    weight += unit * (Number(item.qty) || 1);
    const d = item.dimensionsCm || {};
    l = Math.max(l, Number(d.l) || 0);
    w = Math.max(w, Number(d.w) || 0);
    h += (Number(d.h) || 0) * (Number(item.qty) || 1);
  }
  return {
    weight: Math.max(1, Math.round(weight || DEFAULT_WEIGHT)),
    length: l || DEFAULT_DIMS[0],
    width: w || DEFAULT_DIMS[1],
    height: Math.min(h || DEFAULT_DIMS[2], 200),
  };
}

function shipmentPayload(order, { isReturn = false, invoiceNumber = "" } = {}) {
  const address = order.addressSnapshot || {};
  const pin = Number(String(address.postalCode || "").replace(/\D/g, ""));
  if (!pin) throw new AppError(400, "The delivery address needs a pincode before Delhivery can ship it", "SHIPMENT_ADDRESS");
  const phone = String(address.phone || "").replace(/\s/g, "");
  if (!phone) throw new AppError(400, "The delivery address needs a phone number before Delhivery can ship it", "SHIPMENT_ADDRESS");
  const m = packageMetrics(order);
  const seller = order.sellerSnapshot || {};
  const createdAt = new Date(order.createdAt || Date.now());
  return {
    name: clean(address.contactName || "Customer").slice(0, 80),
    order: clean(isReturn ? `${order.orderNumber}-R` : order.orderNumber).slice(0, 49),
    phone,
    add: clean([address.addressLine1, address.addressLine2, address.city].filter(Boolean).join(", ")).slice(0, 200),
    pin,
    city: clean(address.city),
    state: clean(address.state),
    country: "India",
    payment_mode: isReturn ? "Pickup" : order.paymentMethod === "cod" ? "COD" : "Prepaid",
    cod_amount: !isReturn && order.paymentMethod === "cod" ? Number(order.total) || 0 : 0,
    total_amount: Number(order.total) || 0,
    products_desc: clean((order.items || []).map((item) => item.name).filter(Boolean).join(", ")).slice(0, 200),
    quantity: String((order.items || []).reduce((sum, item) => sum + (item.qty || 0), 0) || 1),
    weight: m.weight,
    shipment_width: m.width,
    shipment_height: m.height,
    shipment_length: m.length,
    shipping_mode: "Surface",
    address_type: "home",
    seller_name: clean(seller.legalName || seller.name || ""),
    seller_add: clean(seller.address || ""),
    seller_gst_tin: clean(seller.gstin || ""),
    hsn_code: clean((order.items || []).map((item) => item.hsn).filter(Boolean).join(",")),
    seller_inv: clean(invoiceNumber || order.invoiceNumber || ""),
    seller_inv_date: createdAt.toISOString().slice(0, 10),
    order_date: createdAt.toISOString().replace("T", " ").slice(0, 19),
    waybill: "",
    return_name: clean(seller.name || ""),
    return_add: clean(seller.address || ""),
    return_pin: String(seller.postalCode || ""),
    return_state: clean(seller.state || ""),
    return_phone: String(seller.phone || ""),
    return_country: "India",
    fragile_shipment: false,
    dangerous_good: false,
    plastic_packaging: false,
    ewbn: "",
  };
}

async function createPackage(order, opts) {
  const payload = { pickup_location: { name: env.delhiveryPickupName }, shipments: [shipmentPayload(order, opts)] };
  const { ok, data } = await call("/api/cmu/create.json", {
    method: "POST",
    form: `format=json&data=${encodeURIComponent(JSON.stringify(payload))}`,
  });
  const pkg = Array.isArray(data.packages) ? data.packages[0] : null;
  const remark = pkg?.remarks?.filter?.(Boolean).join(", ") || data.rmk || "";
  if (!ok || data.success === false || !pkg?.waybill || String(pkg.status || "").toLowerCase() === "fail") {
    throw new AppError(502, remark || "Delhivery could not create the shipment", "SHIPMENT_FAILED");
  }
  return { waybill: String(pkg.waybill), sortCode: pkg.sort_code || "" };
}

export async function createForwardShipment(order, { invoiceNumber = "" } = {}) {
  assertConfigured();
  return createPackage(order, { isReturn: false, invoiceNumber });
}

/** Reverse pickup from the buyer's address back to the store. */
export async function createReturnShipment(order) {
  assertConfigured();
  return createPackage(order, { isReturn: true });
}

export async function cancelShipment(waybill) {
  assertConfigured();
  const { ok, data } = await call("/api/p/edit", { method: "POST", json: { waybill: String(waybill), cancellation: "true" } });
  if (!ok || data?.status === false) {
    throw new AppError(502, data?.remark || data?.error || "Delhivery could not cancel the shipment", "SHIPMENT_CANCEL_FAILED");
  }
  return { cancelled: true, remark: data?.remark || "" };
}

/**
 * Map a Delhivery scan status to an order status (null = informational only).
 * StatusType: UD = forward (undelivered / in transit), DL = final (Delivered, or RTO / DTO when
 * the parcel went back), RT = return to origin in progress, PU = reverse pickup, CN = cancelled.
 * Any RTO / DTO / RT scan means the parcel is going (or went) back to the store, never "delivered".
 * Only UD / DL scans (or scans without a type) move an order forward.
 */
export function mapDelhiveryStatus(status, statusType = "") {
  const s = String(status || "").trim().toLowerCase().replace(/\s+/g, " ");
  const t = String(statusType || "").trim().toUpperCase();
  if (t === "RT" || s.startsWith("rto") || s.startsWith("dto") || s === "returned") return "returned_to_origin";
  if (t && t !== "UD" && t !== "DL") return null;
  if (s === "delivered" || (t === "DL" && !s)) return "delivered";
  if (t === "DL") return null;
  if (s === "dispatched" || s.includes("out for delivery")) return "out_for_delivery";
  if (s === "in transit" || s === "pending" || s === "picked up") return "shipped";
  return null;
}

export async function trackShipment(waybill) {
  assertConfigured();
  const { ok, data } = await call(`/api/v1/packages/json/?waybill=${encodeURIComponent(String(waybill))}`);
  const shipment = data?.ShipmentData?.[0]?.Shipment;
  if (!ok || !shipment) throw new AppError(502, "Delhivery tracking is unavailable", "TRACKING_FAILED");
  const scans = (shipment.Scans || []).map((row) => {
    const scan = row.ScanDetail || {};
    return { status: scan.Scan || scan.Instructions || "", location: scan.ScannedLocation || "", at: scan.ScanDateTime || null, note: scan.Instructions || "" };
  });
  return {
    waybill: String(waybill),
    status: shipment.Status?.Status || "",
    statusType: shipment.Status?.StatusType || "",
    statusAt: shipment.Status?.StatusDateTime || null,
    location: shipment.Status?.StatusLocation || "",
    expectedDelivery: shipment.ExpectedDeliveryDate || null,
    mappedStatus: mapDelhiveryStatus(shipment.Status?.Status, shipment.Status?.StatusType),
    scans,
  };
}

export async function checkServiceability(pin) {
  assertConfigured();
  const code = String(pin || "").replace(/\D/g, "");
  if (code.length !== 6) throw new AppError(400, "Enter a 6-digit pincode", "VALIDATION_ERROR");
  const { ok, data } = await call(`/c/api/pin-codes/json/?filter_codes=${code}`);
  if (!ok) throw new AppError(502, "Delhivery serviceability check failed", "SERVICEABILITY_FAILED");
  const row = data?.delivery_codes?.[0]?.postal_code;
  return {
    pin: code,
    serviceable: Boolean(row),
    cod: row ? String(row.cod).toUpperCase() === "Y" : false,
    prepaid: row ? String(row.pre_paid).toUpperCase() === "Y" : false,
    pickup: row ? String(row.pickup).toUpperCase() === "Y" : false,
    city: row?.city || "",
    state: row?.state_code || "",
  };
}
