const base = process.env.API_URL || "http://localhost:5000";

async function req(path, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status} ${data.message || data.code || ""}`);
  }
  return data;
}

const admin = await req("/api/v1/auth/login", {
  method: "POST",
  body: { email: "admin@msp.local", password: "ChangeMe123!" },
});
const buyer = await req("/api/v1/auth/login", {
  method: "POST",
  body: { email: "buyer@acme.local", password: "Buyer123!" },
});
const vendor = await req("/api/v1/auth/login", {
  method: "POST",
  body: { email: "vendor@acme.local", password: "Vendor123!" },
});

const catalog = await req("/api/v1/products/search");
const variantId = catalog.data[0].variants[0]._id;
const tenantId = catalog.data[0].tenantId;

const addr = await req("/api/v1/addresses", {
  method: "POST",
  token: buyer.accessToken,
  body: {
    contactName: "Demo Buyer",
    phone: "9999999999",
    addressLine1: "1 MG Road",
    city: "Delhi",
    state: "DL",
    postalCode: "110001",
    isDefault: true,
  },
});

await req("/api/v1/cart/items", {
  method: "POST",
  token: buyer.accessToken,
  body: { variantId, qty: 10 },
});
await req("/api/v1/cart/coupon", {
  method: "POST",
  token: buyer.accessToken,
  body: { code: "WELCOME10" },
});

const checkout = await req("/api/v1/checkout", {
  method: "POST",
  token: buyer.accessToken,
  headers: { "Idempotency-Key": `smoke-${Date.now()}` },
  body: { addressId: addr._id, paymentMethod: "purchase_order", poNumber: "PO-SMOKE" },
});

const confirmed = await req(`/api/v1/orders/${checkout.orders[0]._id}/status`, {
  method: "POST",
  token: vendor.accessToken,
  body: { status: "confirmed" },
});

const overview = await req("/api/v1/reports/overview", { token: admin.accessToken });
const page = await req("/api/v1/cms/admin", {
  method: "POST",
  token: vendor.accessToken,
  body: { title: "Home", slug: `home-${Date.now()}`, type: "home", sections: [{ kind: "hero" }] },
});
await req(`/api/v1/cms/admin/${page._id}/publish`, { method: "POST", token: vendor.accessToken });
await req("/api/v1/chat", {
  method: "POST",
  token: buyer.accessToken,
  body: {
    tenantId,
    type: "order_support",
    subject: "Need ETA",
    message: "When will it ship?",
    orderId: checkout.orders[0]._id,
  },
});

console.log({
  order: confirmed.orderNumber || checkout.orders[0].orderNumber,
  status: confirmed.status,
  gmv: overview.gmv,
  cms: page.slug,
});
