import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Warehouse } from "../modules/inventory/warehouse.model.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Invoice } from "../modules/invoices/invoice.model.js";
import { Coupon } from "../modules/pricing/coupon.model.js";
import { Category } from "../modules/catalog/category.model.js";

const base = process.env.API_URL || "http://localhost:5000";

async function call(path, { method = "GET", token, body, headers = {} } = {}) {
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
  return { ok: res.ok, status: res.status, data };
}

async function req(path, opts) {
  const res = await call(path, opts);
  if (!res.ok) {
    throw new Error(`${opts?.method || "GET"} ${path} ${res.status} ${res.data.message || res.data.code || ""}`);
  }
  return res.data;
}

async function expectFail(label, path, opts, { status, code } = {}) {
  const res = await call(path, opts);
  if (res.ok) throw new Error(`${label}: expected failure, got ${res.status}`);
  if (status && res.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${res.status} ${res.data.code} ${res.data.message}`);
  }
  if (code && res.data.code !== code) {
    throw new Error(`${label}: expected code ${code}, got ${res.data.code} (${res.data.message})`);
  }
  pass(`${label} → ${res.status} ${res.data.code}`);
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.02;
const passes = [];
function pass(msg) {
  passes.push(msg);
  console.log(`  ✓ ${msg}`);
}
function check(cond, msg, detail) {
  if (!cond) throw new Error(`FAIL: ${msg}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`);
  pass(msg);
}

function findLine(quote, variantId, bulk) {
  for (const g of quote.groups || []) {
    const line = g.items.find(
      (i) => String(i.variantId) === String(variantId) && (bulk == null || Boolean(i.bulk) === bulk)
    );
    if (line) return { line, group: g };
  }
  return {};
}

function priceBeforeTier(line) {
  const steps = (line.breakdown || []).filter((s) => s.step !== "tier" && s.step !== "offer" && s.step !== "list");
  return steps[steps.length - 1]?.amount;
}

function checkGroupMath(quote) {
  for (const g of quote.groups) {
    const expected = round2(g.subtotal - g.couponDiscount + g.deliveryFee + g.platformFee + g.partnerFee);
    if (!near(g.total, expected)) throw new Error(`FAIL: group total ${g.total} != ${expected}`);
    const lineTax = round2(g.items.reduce((s, i) => s + i.tax, 0));
    if (!near(g.tax, lineTax)) throw new Error(`FAIL: group tax ${g.tax} != line tax ${lineTax}`);
    const shares = round2(g.items.reduce((s, i) => s + (i.couponShare || 0), 0));
    if (!near(shares, g.couponDiscount)) throw new Error(`FAIL: coupon shares ${shares} != ${g.couponDiscount}`);
    for (const i of g.items) {
      if (!near(i.lineSubtotal, i.unitPrice * i.qty)) throw new Error(`FAIL: line amount ${i.sku}`);
      if (!near(i.taxableValue + i.tax, i.lineSubtotal - (i.couponShare || 0))) {
        throw new Error(`FAIL: inclusive GST split for ${i.sku}`);
      }
    }
  }
  pass("group totals = subtotal − coupon + fees (GST included, not added); coupon spread across lines");
}

// This script writes to the database directly. Refuse anything that isn't a throwaway test DB.
{
  const dbName = String(process.env.MONGODB_URI || "").split("/").pop().split("?")[0];
  if (!dbName.includes("msp_test") && process.env.SMOKE_ALLOW_ANY_DB !== "true") {
    console.error(`Refusing to run against database "${dbName}". Set MONGODB_URI to a *msp_test* database.`);
    process.exit(1);
  }
}
await connectDb();

const restore = [];
let smoke = null;

try {
  const acme = await Tenant.findOne({ slug: "acme-wholesale" });
  const products = await Product.find({ tenantId: acme._id, status: "published" }).sort({ sku: 1 }).limit(3);
  if (products.length < 3) throw new Error("Seed first: need 3 published Acme products");
  const [pBulk, pNormal, pRules] = products;
  const variantOf = async (p) => ProductVariant.findOne({ productId: p._id, status: "active" }).sort({ createdAt: 1 });
  const [vBulk, vNormal, vRules] = await Promise.all([variantOf(pBulk), variantOf(pNormal), variantOf(pRules)]);

  for (const p of [pBulk, pNormal, pRules]) restore.push({ id: p._id, wholesale: p.wholesale.toObject() });
  await Product.updateOne({ _id: pBulk._id }, { $set: { "wholesale.bulkEligible": true, "wholesale.moq": 1, "wholesale.packMultiple": 1, "wholesale.maxQty": 8000 } });
  // Non-bulk product with bulk-style fields set: they must be ignored.
  await Product.updateOne({ _id: pNormal._id }, { $set: { "wholesale.bulkEligible": false, "wholesale.moq": 10, "wholesale.packMultiple": 5, "wholesale.maxQty": 3 } });
  await Product.updateOne({ _id: pRules._id }, { $set: { "wholesale.bulkEligible": true, "wholesale.moq": 10, "wholesale.packMultiple": 6, "wholesale.maxQty": 60 } });
  await Inventory.updateMany({ tenantId: acme._id, variantId: { $in: [vBulk._id, vNormal._id, vRules._id] } }, { $max: { available: 5000 } });

  const feeKeys = { "platform.feeEnabled": true, "platform.feeAmount": 10, "platform.feePercent": 0 };
  for (const [key, value] of Object.entries(feeKeys)) {
    const prev = await Settings.findOne({ scope: "platform", tenantId: null, key });
    restore.push({ setting: key, value: prev ? prev.value : undefined });
    await Settings.findOneAndUpdate({ scope: "platform", tenantId: null, key }, { $set: { value } }, { upsert: true });
  }

  // Second seller in another state, pickup-only, to test multi-seller fees and IGST.
  const stamp = Date.now();
  const tenant2 = await Tenant.create({
    name: "Smoke Mumbai Traders",
    slug: `smoke-mumbai-${stamp}`,
    status: "active",
    businessProfile: { legalName: "Smoke Mumbai Traders LLP", gstin: "27AAACS0000A1Z1" },
    pickupAddress: { addressLine1: "5 Fort Road", city: "Mumbai", state: "MH", postalCode: "400001" },
  });
  const wh2 = await Warehouse.create({ tenantId: tenant2._id, name: "Mumbai", code: "MUM", city: "Mumbai", state: "MH", postalCode: "400001" });
  const p2 = await Product.create({
    tenantId: tenant2._id,
    name: "Smoke Basmati Rice 5kg",
    sku: `SMOKE-RICE-${stamp}`,
    status: "published",
    taxClass: { name: "GST5", rate: 5 },
    hsn: "1006",
    deliveryModes: ["store_pickup"],
    categoryId: pBulk.categoryId,
    brandId: pBulk.brandId,
  });
  const v2 = await ProductVariant.create({
    tenantId: tenant2._id,
    productId: p2._id,
    sku: `SMOKE-RICE-${stamp}-5KG`,
    attributes: { packSize: "5 kg" },
    listPrice: 700,
    sellingPrice: 630,
  });
  await Inventory.create({ tenantId: tenant2._id, warehouseId: wh2._id, variantId: v2._id, sku: v2.sku, available: 100 });
  smoke = { tenant2, wh2, p2, v2 };

  const buyer = await req("/api/v1/auth/login", { method: "POST", body: { email: "buyer@acme.local", password: "Buyer123!" } });
  const vendor = await req("/api/v1/auth/login", { method: "POST", body: { email: "vendor@acme.local", password: "Vendor123!" } });
  const admin = await req("/api/v1/auth/login", { method: "POST", body: { email: process.env.SUPER_ADMIN_EMAIL, password: process.env.SUPER_ADMIN_PASSWORD } });
  const B = buyer.accessToken;

  const resetCart = async () => {
    const cart = await req("/api/v1/cart", { token: B });
    for (const line of [...cart.groups.flatMap((g) => g.items), ...(cart.unavailable || [])]) {
      await req(`/api/v1/cart/items/${line.cartItemId}`, { method: "DELETE", token: B });
    }
    await req("/api/v1/cart/coupon", { method: "POST", token: B, body: { code: "" } });
  };
  await resetCart();

  console.log("Normal add-to-cart");
  let quote = await req("/api/v1/cart/items", { method: "POST", token: B, body: { variantId: vNormal._id, qty: 1 } });
  let { line } = findLine(quote, vNormal._id);
  check(line?.qty === 1, "normal product adds qty 1 (MOQ/pack ignored when not bulk)", line?.qty);
  check(!(line.breakdown || []).some((s) => s.step === "tier"), "no slab applied to a normal product");
  check(near(line.lineTotal, line.unitPrice) && near(line.taxableValue + line.tax, line.lineTotal), "GST is backed out of the inclusive price");
  quote = await req(`/api/v1/cart/items/${line.cartItemId}`, { method: "PATCH", token: B, body: { qty: 7 } });
  check(findLine(quote, vNormal._id).line.qty === 7, "normal product accepts qty 7 (no pack/max rules)");

  console.log("Bulk slabs");
  const tiers = [...(vBulk.tierPrices || [])].sort((a, b) => a.minQty - b.minQty);
  quote = await req("/api/v1/cart/items", { method: "POST", token: B, body: { variantId: vBulk._id, qty: 50, bulk: true } });
  ({ line } = findLine(quote, vBulk._id, true));
  const tier50 = tiers.filter((t) => 50 >= t.minQty && (t.maxQty == null || 50 <= t.maxQty)).pop();
  if (tier50) {
    const tierStep = line.breakdown.find((s) => s.step === "tier");
    const expected = Math.min(priceBeforeTier(line), tier50.unitPrice);
    check(tierStep ? near(tierStep.amount, expected) : near(priceBeforeTier(line), expected), `slab at 50 units = ₹${expected}`, line.breakdown);
  }
  quote = await req(`/api/v1/cart/items/${line.cartItemId}`, { method: "PATCH", token: B, body: { qty: 200 } });
  ({ line } = findLine(quote, vBulk._id, true));
  const tier200 = tiers.filter((t) => 200 >= t.minQty && (t.maxQty == null || 200 <= t.maxQty)).pop();
  if (tier200) {
    const tierStep = line.breakdown.find((s) => s.step === "tier");
    const expected = Math.min(priceBeforeTier(line), tier200.unitPrice);
    check(tierStep ? near(tierStep.amount, expected) : near(priceBeforeTier(line), expected), `slab at 200 units = ₹${expected}`, line.breakdown);
  }

  console.log("Bulk rules (MOQ 10, pack 6, max 60)");
  quote = await req("/api/v1/cart/items", { method: "POST", token: B, body: { variantId: vRules._id, qty: 1, bulk: true } });
  ({ line } = findLine(quote, vRules._id, true));
  check(line?.qty === 12, "first add bumps to MOQ rounded up to the pack multiple (12)", line?.qty);

  console.log("One line per variant (bulk is derived from the quantity)");
  await expectFail(
    "adding 1 more to the 12-unit bulk line breaks the pack multiple",
    "/api/v1/cart/items",
    { method: "POST", token: B, body: { variantId: vRules._id, qty: 1 } },
    { status: 400, code: "PACK_MULTIPLE" }
  );
  quote = await req(`/api/v1/cart/items/${line.cartItemId}`, { method: "PATCH", token: B, body: { qty: 3 } });
  const single = findLine(quote, vRules._id).line;
  check(single?.qty === 3 && single.bulk === false, "below the bulk range the same line is a regular purchase (qty 3)", single);
  check(!(single?.breakdown || []).some((s) => s.step === "tier"), "regular-range qty gets no slab price");
  quote = await req(`/api/v1/cart/items/${line.cartItemId}`, { method: "PATCH", token: B, body: { qty: 12 } });
  check(findLine(quote, vRules._id, true).line?.qty === 12, "back to 12: bulk again");
  await expectFail(
    "bulk add of a non-bulk product rejected",
    "/api/v1/cart/items",
    { method: "POST", token: B, body: { variantId: vNormal._id, qty: 10, bulk: true } },
    { status: 400, code: "NOT_BULK" }
  );
  await expectFail("qty 15 rejected", `/api/v1/cart/items/${line.cartItemId}`, { method: "PATCH", token: B, body: { qty: 15 } }, { status: 400, code: "PACK_MULTIPLE" });
  await expectFail("qty 66 rejected", `/api/v1/cart/items/${line.cartItemId}`, { method: "PATCH", token: B, body: { qty: 66 } }, { status: 400, code: "MAX_QTY" });
  quote = await req("/api/v1/cart", { token: B });
  check(findLine(quote, vRules._id, true).line.qty === 12, "rejected updates leave the cart unchanged");
  {
    const bulkLine = findLine(quote, vRules._id, true).line;
    const modes = bulkLine.deliveryModes || [];
    if (modes.includes("store_pickup") && modes.includes("delivery_partner")) {
      let q = await req(`/api/v1/cart/items/${bulkLine.cartItemId}`, { method: "PATCH", token: B, body: { fulfillmentMode: "store_pickup" } });
      check(findLine(q, vRules._id, true).line.fulfillmentMode === "store_pickup", "bulk line switches to store pickup");
      q = await req(`/api/v1/cart/items/${bulkLine.cartItemId}`, { method: "PATCH", token: B, body: { fulfillmentMode: "delivery_partner" } });
      check(findLine(q, vRules._id, true).line.fulfillmentMode === "delivery_partner", "bulk line switches back to delivery");
    } else {
      const other = modes.includes("store_pickup") ? "delivery_partner" : "store_pickup";
      await expectFail(
        "unsupported delivery option rejected",
        `/api/v1/cart/items/${bulkLine.cartItemId}`,
        { method: "PATCH", token: B, body: { fulfillmentMode: other } },
        { status: 400, code: "MODE_UNAVAILABLE" }
      );
    }
  }
  await req(`/api/v1/cart/items/${line.cartItemId}`, { method: "DELETE", token: B });

  console.log("Coupon, multi-seller and pickup fees");
  await req("/api/v1/cart/items", { method: "POST", token: B, body: { variantId: v2._id, qty: 2 } });
  quote = await req("/api/v1/cart/coupon", { method: "POST", token: B, body: { code: "WELCOME10" } });
  check(quote.couponDiscount > 0, `WELCOME10 applies to the Acme group (−₹${quote.couponDiscount})`);
  check(quote.groups.length === 2, "cart has two seller groups");

  const addr = await req("/api/v1/addresses", {
    method: "POST",
    token: B,
    body: { contactName: "Demo Buyer", phone: "9999999999", addressLine1: "1 MG Road", city: "Delhi", state: "DL", postalCode: "110001", isDefault: true },
  });
  const preview = await req("/api/v1/checkout/preview", { method: "POST", token: B, body: { addressId: addr._id, deliveryPartnerId: "delhivery" } });
  checkGroupMath(preview);
  const gAcme = preview.groups.find((g) => String(g.tenantId) === String(acme._id));
  const gSmoke = preview.groups.find((g) => String(g.tenantId) === String(tenant2._id));
  check(gSmoke.deliveryFee === 0 && gSmoke.partnerFee === 0, "pickup-only seller pays no delivery or partner fee");
  check(gAcme.partnerFee === 40, "delivery seller pays the chosen partner fee (Delhivery ₹40)", gAcme.partnerFee);
  check(near(preview.platformFee, 10), "flat platform fee charged once per checkout (₹10)", preview.platformFee);

  console.log("Promotions");
  const freeKey = { scope: "tenant", tenantId: acme._id, key: "delivery.freeAbove" };
  await Settings.findOneAndUpdate(freeKey, { $set: { value: 1 } }, { upsert: true });
  try {
    const freePreview = await req("/api/v1/checkout/preview", { method: "POST", token: B, body: { addressId: addr._id, deliveryPartnerId: "delhivery" } });
    const gFree = freePreview.groups.find((g) => String(g.tenantId) === String(acme._id));
    check(gFree.freeDelivery && gFree.deliveryFee === 0 && gFree.partnerFee === 0, "free-delivery threshold waives delivery + partner fee");
  } finally {
    await Settings.deleteOne(freeKey);
  }

  const couponCodes = [`BULK${stamp}`, `FIRST${stamp}`];
  smoke.couponCodes = couponCodes;
  await req("/api/v1/coupons", {
    method: "POST",
    token: vendor.accessToken,
    body: { code: couponCodes[0], name: "Bulk only 5%", type: "percent", value: 5, appliesTo: "bulk" },
  });
  await req("/api/v1/coupons", {
    method: "POST",
    token: vendor.accessToken,
    body: { code: couponCodes[1], name: "First order 5%", type: "percent", value: 5, firstOrderOnly: true },
  });
  const cartNow = await req("/api/v1/cart", { token: B });
  const acmeItems = cartNow.groups.find((g) => String(g.tenantId) === String(acme._id)).items;
  const bulkBase = acmeItems.filter((i) => i.bulk).reduce((s, i) => s + i.lineSubtotal, 0);
  const { coupons } = await req("/api/v1/cart/coupons", { token: B });
  const bulkCoupon = coupons.find((c) => c.code === couponCodes[0]);
  check(near(bulkCoupon.savings, round2(bulkBase * 0.05)), "bulk-only coupon discounts only bulk lines", [bulkCoupon.savings, bulkBase]);
  const hadOrder = await Order.exists({ tenantId: acme._id, buyerId: buyer.user?._id || buyer.user?.id, status: { $ne: "cancelled" } });
  const firstCoupon = coupons.find((c) => c.code === couponCodes[1]);
  check(firstCoupon.eligible === !hadOrder, `first-order coupon ${hadOrder ? "blocked for a returning buyer" : "open to a new buyer"}`, firstCoupon);

  console.log("Checkout safety");
  await expectFail("PO number required", "/api/v1/checkout", {
    method: "POST", token: B, headers: { "Idempotency-Key": `smoke-nopo-${stamp}` },
    body: { addressId: addr._id, paymentMethod: "purchase_order", deliveryPartnerId: "delhivery" },
  }, { status: 400, code: "PO_REQUIRED" });
  await expectFail("stale total rejected", "/api/v1/checkout", {
    method: "POST", token: B, headers: { "Idempotency-Key": `smoke-stale-${stamp}` },
    body: { addressId: addr._id, paymentMethod: "purchase_order", poNumber: "PO-SMOKE", deliveryPartnerId: "delhivery", expectedGrandTotal: preview.grandTotal + 5 },
  }, { status: 409, code: "PRICE_CHANGED" });

  const key = `smoke-${stamp}`;
  const body = { addressId: addr._id, paymentMethod: "purchase_order", poNumber: "PO-SMOKE", deliveryPartnerId: "delhivery", expectedGrandTotal: preview.grandTotal };
  const placed = await req("/api/v1/checkout", { method: "POST", token: B, headers: { "Idempotency-Key": key }, body });
  check(placed.orders.length === 2, "one order per seller");
  const orderSum = round2(placed.orders.reduce((s, o) => s + o.total, 0));
  check(near(orderSum, preview.grandTotal), `order totals (₹${orderSum}) = preview grand total`);
  const replay = await call("/api/v1/checkout", { method: "POST", token: B, headers: { "Idempotency-Key": key }, body });
  check(replay.data.idempotent === true && replay.data.orders?.length === 2, "same Idempotency-Key replays the same orders", replay.data);

  const oAcme = placed.orders.find((o) => String(o.tenantId) === String(acme._id));
  const oSmoke = placed.orders.find((o) => String(o.tenantId) === String(tenant2._id));

  console.log("Order permissions and invoices");
  await expectFail("buyer cannot confirm", `/api/v1/orders/${oAcme._id}/status`, { method: "POST", token: B, body: { status: "confirmed" } }, { status: 403 });
  await expectFail("invoice not issued before confirm", `/api/v1/orders/${oAcme._id}/invoice`, { token: B }, { status: 404 });
  const confirmed = await req(`/api/v1/orders/${oAcme._id}/status`, { method: "POST", token: vendor.accessToken, body: { status: "confirmed" } });
  check(confirmed.status === "confirmed", "seller confirms the order");
  await expectFail("double confirm rejected", `/api/v1/orders/${oAcme._id}/status`, { method: "POST", token: vendor.accessToken, body: { status: "confirmed" } }, { status: 400 });

  const invA = await req(`/api/v1/orders/${oAcme._id}/invoice`, { token: B });
  check(/^INV\/ACMEWHOLESALE\/\d{4}-\d{2}\/\d{6}$/.test(invA.invoiceNumber), `invoice number ${invA.invoiceNumber}`);
  check(near(invA.totals.grandTotal, oAcme.total), "invoice total = order total (Acme)", [invA.totals.grandTotal, oAcme.total]);
  check(invA.supplyType === "intra" && invA.totals.igst === 0 && near(invA.totals.cgst + invA.totals.sgst, invA.totals.tax), "DL seller → DL buyer: CGST + SGST");
  check(invA.lines.some((l) => l.kind === "fee" && l.description === "Platform fee"), "platform fee appears as an invoice fee line");
  check(invA.buyer.gstin === "07AAFCR4321K1ZD" && invA.seller.gstin === "07AABCA1234A1ZL", "buyer and seller GSTINs on the invoice", [invA.buyer.gstin, invA.seller.gstin]);

  await req(`/api/v1/orders/${oSmoke._id}/status`, { method: "POST", token: admin.accessToken, body: { status: "confirmed" } });
  const invS = await req(`/api/v1/orders/${oSmoke._id}/invoice`, { token: admin.accessToken });
  check(near(invS.totals.grandTotal, oSmoke.total), "invoice total = order total (Mumbai seller)");
  check(invS.supplyType === "inter" && invS.totals.cgst === 0 && near(invS.totals.igst, invS.totals.tax), "MH seller → DL buyer: IGST");

  const cancelled = await req(`/api/v1/orders/${oSmoke._id}/status`, { method: "POST", token: B, body: { status: "cancelled", note: "smoke" } });
  check(cancelled.status === "cancelled", "buyer can cancel a confirmed order");
  const invAfter = await Invoice.findOne({ orderId: oSmoke._id });
  check(invAfter.status === "cancelled", "cancelling marks the invoice cancelled");
  await expectFail("buyer cannot ship", `/api/v1/orders/${oAcme._id}/status`, { method: "POST", token: B, body: { status: "processing" } }, { status: 403 });

  console.log("Returns");
  await expectFail("no return before delivery", `/api/v1/orders/${oAcme._id}/return`, { method: "POST", token: B, body: { reason: "Damaged" } }, { status: 400 });
  for (const status of ["processing", "ready_to_ship", "shipped", "out_for_delivery", "delivered"]) {
    await req(`/api/v1/orders/${oAcme._id}/status`, { method: "POST", token: vendor.accessToken, body: { status } });
  }
  await Order.updateOne({ _id: oAcme._id }, { $set: { "items.$[].easyReturn": true } });
  const delivered = await req(`/api/v1/orders/${oAcme._id}`, { token: B });
  check(delivered.deliveredAt && delivered.returnUntil, "delivered order shows a return deadline", delivered.returnUntil);
  const requested = await req(`/api/v1/orders/${oAcme._id}/return`, { method: "POST", token: B, body: { reason: "Damaged or defective item" } });
  check(requested.status === "return_requested" && requested.returnRequest.status === "requested", "buyer requests a return");
  await expectFail("buyer cannot reject a return", `/api/v1/orders/${oAcme._id}/return/reject`, { method: "POST", token: B, body: { note: "no" } }, { status: 403 });
  const rejected = await req(`/api/v1/orders/${oAcme._id}/return/reject`, { method: "POST", token: vendor.accessToken, body: { note: "Seal intact" } });
  check(rejected.status === "delivered" && rejected.returnRequest.status === "rejected", "seller rejects; order back to delivered");
  await expectFail("only one return request per order", `/api/v1/orders/${oAcme._id}/return`, { method: "POST", token: B, body: { reason: "Other" } }, { status: 400 });

  console.log("Per-store categories");
  const ownCat = await req("/api/v1/categories", { method: "POST", token: vendor.accessToken, body: { name: `Smoke Cat ${stamp}` } });
  smoke.categoryId = ownCat._id;
  check(String(ownCat.tenantId) === String(acme._id) && ownCat.slug.endsWith(acme.slug), "store category belongs to the store", ownCat);
  const shared = await Category.findOne({ tenantId: null });
  if (shared) {
    await expectFail("store cannot rename a shared category", `/api/v1/categories/${shared._id}`, { method: "PATCH", token: vendor.accessToken, body: { name: "Hacked" } }, { status: 403 });
  }
  const storeCats = await req("/api/v1/categories", { token: vendor.accessToken });
  check(storeCats.some((c) => c._id === ownCat._id), "store sees its own category");
  await expectFail(
    "another store's category can't be used",
    `/api/v1/products/${p2._id}`,
    { method: "PATCH", token: admin.accessToken, headers: { "X-Tenant-Id": String(tenant2._id) }, body: { categoryId: ownCat._id } },
    { status: 400 }
  );
  await req(`/api/v1/categories/${ownCat._id}`, { method: "DELETE", token: vendor.accessToken });
  smoke.categoryId = null;
  pass("store deletes its own category");

  console.log(`\nPASS: ${passes.length} checks`);
} finally {
  for (const r of restore) {
    if (r.id) await Product.updateOne({ _id: r.id }, { $set: { wholesale: r.wholesale } });
    if (r.setting) {
      if (r.value === undefined) await Settings.deleteOne({ scope: "platform", tenantId: null, key: r.setting });
      else await Settings.updateOne({ scope: "platform", tenantId: null, key: r.setting }, { $set: { value: r.value } });
    }
  }
  if (smoke) {
    if (smoke.couponCodes) await Coupon.deleteMany({ code: { $in: smoke.couponCodes } });
    if (smoke.categoryId) await Category.deleteOne({ _id: smoke.categoryId });
    const orderIds = (await Order.find({ tenantId: smoke.tenant2._id }).select("_id")).map((o) => o._id);
    await Invoice.deleteMany({ orderId: { $in: orderIds } });
    await Order.deleteMany({ tenantId: smoke.tenant2._id });
    await Inventory.deleteMany({ tenantId: smoke.tenant2._id });
    await ProductVariant.deleteMany({ tenantId: smoke.tenant2._id });
    await Product.deleteMany({ tenantId: smoke.tenant2._id });
    await Warehouse.deleteMany({ tenantId: smoke.tenant2._id });
    await Tenant.deleteOne({ _id: smoke.tenant2._id });
  }
  await mongoose.disconnect();
}
