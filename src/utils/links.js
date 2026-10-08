import { env } from "../config/env.js";

/**
 * Every link the backend puts in an email / notification points at the storefront
 * (FRONTEND_URL, first entry when it is a comma list). Paths can be overridden per deployment:
 *   FRONTEND_ORDER_PATH        buyer order detail   (default /account/orders  -> /account/orders/:id)
 *   FRONTEND_STAFF_ORDER_PATH  store order detail   (default /tenant/orders   -> /tenant/orders/:id)
 *   FRONTEND_PRODUCT_PATH      product page         (default /product         -> /product/:slug)
 * Fixed storefront routes: /verify-email?token=, /reset-password?token=, /unsubscribe?token=,
 * /restock/confirm?token=.
 */
export function frontendBase() {
  const first = String(env.frontendUrl || "").split(",")[0].trim();
  return (first || "http://localhost:5173").replace(/\/+$/, "");
}

function cleanPath(value, fallback) {
  const raw = String(value || fallback).trim();
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.replace(/\/+$/, "") || fallback;
}

/** `path` must start with "/"; `query` values are URL-encoded. */
export function frontendLink(path = "/", query = null) {
  const url = `${frontendBase()}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return url;
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `${url}?${qs}` : url;
}

export const links = {
  verifyEmail: (token) => frontendLink("/verify-email", { token }),
  resetPassword: (token) => frontendLink("/reset-password", { token }),
  unsubscribe: (token) => frontendLink("/unsubscribe", { token }),
  restockConfirm: (token) => frontendLink("/restock/confirm", { token }),
  /** Buyer order page; falls back to the orders list without an id. */
  order: (orderId) =>
    orderId
      ? frontendLink(`${cleanPath(process.env.FRONTEND_ORDER_PATH, "/account/orders")}/${encodeURIComponent(String(orderId))}`)
      : frontendLink(cleanPath(process.env.FRONTEND_ORDER_PATH, "/account/orders")),
  /** Store staff order page (seller panel). */
  staffOrder: (orderId) =>
    orderId
      ? frontendLink(`${cleanPath(process.env.FRONTEND_STAFF_ORDER_PATH, "/tenant/orders")}/${encodeURIComponent(String(orderId))}`)
      : frontendLink(cleanPath(process.env.FRONTEND_STAFF_ORDER_PATH, "/tenant/orders")),
  product: (slug) => frontendLink(`${cleanPath(process.env.FRONTEND_PRODUCT_PATH, "/product")}/${encodeURIComponent(String(slug || ""))}`),
};
