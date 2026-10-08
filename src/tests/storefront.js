/**
 * Storefront support (buyer-facing gaps): cart line shape + one line per variant, location and
 * product serviceability, review eligibility, buyer coupon listing, search filters/facets/stock,
 * product lookup, public settings, checkout totals, payment options, ledger/me, order
 * allowedActions and email links. Mounts the real /api/v1 router on a mini app.
 *
 * Throwaway local replica set only (the database is dropped):
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_sf?replicaSet=rs0" node src/tests/storefront.js
 */
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { setup, teardown, makeStore, makeBuyer, check, finish } from "./commerceFixtures.js";
import { signAccessToken } from "../utils/tokens.js";
import { errorHandler, notFound } from "../middleware/error.js";
import { ensureSystemRoles } from "../seeds/index.js";
import v1 from "../routes/v1.js";
import { Role } from "../modules/rbac/role.model.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Category } from "../modules/catalog/category.model.js";
import { Brand } from "../modules/catalog/brand.model.js";
import { Coupon } from "../modules/pricing/coupon.model.js";
import { PriceList } from "../modules/pricing/priceList.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Cart } from "../modules/cart/cart.model.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { StockReservation } from "../modules/inventory/reservation.model.js";
import { setAvailableQty } from "../modules/inventory/service.js";
import { invalidateActiveTenants } from "../modules/catalog/service.js";
import { confirmOrder, advanceOrder } from "../modules/orders/lifecycle.js";
import { Order } from "../modules/orders/order.model.js";
import { setBuyerTerms } from "../modules/ledger/service.js";
import { links } from "../utils/links.js";
import { orderUrl, staffOrderUrl } from "../modules/notifications/templates.js";
import { unsubscribeUrl } from "../modules/notifications/preferences.js";
import { parsePackSize, pricePerBaseUnit, qtyRules, slabProgress } from "../modules/pricing/engine.js";
import { razorpayConfigured } from "../modules/checkout/razorpayApi.js";

if (!/127\.0\.0\.1:27027\/msp_test_[a-z0-9_]+(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at a local msp_test_* database");
  process.exit(2);
}

const PORT = 4312;
const base = `http://127.0.0.1:${PORT}/api/v1`;

async function call(method, path, { token, json, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const tokenFor = (user) =>
  signAccessToken({ sub: String(user._id), tenantId: user.tenantId ? String(user.tenantId) : null, tv: user.tokenVersion || 0 });
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

async function asBuyer(buyerRole, buyer, extra = {}) {
  await User.updateOne({ _id: buyer.user._id }, { $set: { roleId: buyerRole._id, status: "active", emailVerified: true, ...extra } });
  const user = await User.findById(buyer.user._id);
  return { ...buyer, doc: user, token: tokenFor(user) };
}

async function main() {
  await setup();
  await ensureSystemRoles();
  const app = express();
  app.use(express.json());
  app.use("/api/v1", v1);
  app.use(notFound);
  app.use(errorHandler);
  const server = app.listen(PORT);

  const buyerRole = await Role.findOne({ slug: "buyer", isSystem: true });

  /* ------------------------------------------------------------------ fixtures */
  const a = await makeStore({ stock: 100, price: 200 });
  const b = await makeStore({ stock: 0, price: 50 });
  await Tenant.updateOne(
    { _id: a.tenant._id },
    {
      $set: {
        status: "active",
        "pickupAddress.city": "Pune",
        deliveryZones: [
          { name: "Local", pincodes: ["400001"], deliveryFee: 40, etaDaysMin: 1, etaDaysMax: 2 },
          { name: "Radius", radiusKm: 30, center: { latitude: 19, longitude: 73 }, deliveryFee: 60, etaDaysMin: 2, etaDaysMax: 3 },
        ],
      },
    }
  );
  await Tenant.updateOne({ _id: b.tenant._id }, { $set: { status: "active" } });
  invalidateActiveTenants();
  await Settings.create([
    { scope: "tenant", tenantId: a.tenant._id, key: "delivery.freeAbove", value: 5000 },
    { scope: "platform", tenantId: null, key: "returns.windowDays", value: 10 },
  ]);

  const parent = await Category.create({ name: "Staples", slug: `staples-${Date.now()}` });
  const child = await Category.create({ name: "Rice", slug: `rice-${Date.now()}`, parentId: parent._id });
  const brandX = await Brand.create({ name: "BrandX", slug: "brandx", tenantId: a.tenant._id });
  const brandY = await Brand.create({ name: "BrandY", slug: "brandy", tenantId: a.tenant._id });

  // Product A: bulk-eligible rice (MOQ 10, pack 5, max 100), 1 kg packs, slabs at 10 and 50.
  await Product.updateOne(
    { _id: a.product._id },
    {
      $set: {
        name: "Basmati Rice Premium",
        categoryId: child._id,
        brandId: brandX._id,
        ratingAvg: 4.5,
        ratingCount: 8,
        easyReturn: true,
        deliveryModes: ["delivery_partner", "store_pickup"],
        wholesale: { bulkEligible: true, moq: 10, packMultiple: 5, maxQty: 100, caseQty: 10, leadTimeDays: 2 },
      },
    }
  );
  await ProductVariant.updateOne(
    { _id: a.variant._id },
    {
      $set: {
        listPrice: 250,
        sellingPrice: 200,
        "attributes.packSize": "1 kg",
        tierPrices: [
          { minQty: 10, unitPrice: 180 },
          { minQty: 50, unitPrice: 160 },
        ],
      },
    }
  );
  // A second product in the same store (brand Y, parent category, low stock) for filters.
  const p2 = await Product.create({
    tenantId: a.tenant._id,
    name: "Toor Dal Classic",
    sku: `DAL-${Date.now()}`,
    status: "published",
    categoryId: parent._id,
    brandId: brandY._id,
    taxClass: { name: "GST5", rate: 5 },
    ratingAvg: 3.9,
    ratingCount: 2,
  });
  const v2 = await ProductVariant.create({
    tenantId: a.tenant._id,
    productId: p2._id,
    sku: `DALV-${Date.now()}`,
    listPrice: 120,
    sellingPrice: 110,
    attributes: { packSize: "500 g" },
  });
  await setAvailableQty({ tenantId: a.tenant._id, variantId: v2._id, warehouseId: a.warehouse._id, qty: 3 });
  // Store B product is out of stock.
  await Product.updateOne({ _id: b.product._id }, { $set: { name: "Sugar Crystal", categoryId: parent._id } });

  const alice = await asBuyer(buyerRole, await makeBuyer(), { homeTenantId: a.tenant._id });
  const bob = await asBuyer(buyerRole, await makeBuyer());
  const productA = await Product.findById(a.product._id);

  /* ------------------------------------------------------------------ pure helpers */
  console.log("\n# engine helpers");
  check(parsePackSize("500 g")?.qty === 0.5 && parsePackSize("500 g")?.unit === "kg", "parsePackSize 500 g -> 0.5 kg");
  check(parsePackSize("2 x 500 ml")?.qty === 1 && parsePackSize("2 x 500 ml")?.unit === "L", "parsePackSize 2 x 500 ml -> 1 L");
  check(parsePackSize("Family pack") === null, "unparseable pack size -> null");
  check(pricePerBaseUnit(110, "500 g")?.label === "₹220/kg", "per-unit price ₹220/kg");
  const rules = qtyRules(productA, null, 3);
  check(rules.bulkFrom === 10 && rules.step === 1 && rules.bulk.step === 5 && rules.bulk.max === 100, "qtyRules: regular range below bulkFrom, bulk range from 10 step 5");
  const prog = slabProgress([{ minQty: 10, unitPrice: 180 }, { minQty: 50, unitPrice: 160 }], 12, 180);
  check(prog.appliedSlab?.minQty === 10 && prog.nextSlab?.minQty === 50 && prog.nextSlab.saveEach === 20, "slabProgress applied 10, next 50 saves 20 each");

  /* ------------------------------------------------------------------ cart lines */
  console.log("\n# cart: one line per variant, slugs, holds, slabs");
  let res = await call("POST", "/cart/items", { token: alice.token, json: { variantId: String(a.variant._id), qty: 2 } });
  check(res.status === 200, `add regular qty 2 (${res.status} ${res.data?.message || ""})`);
  let line = res.data.groups?.[0]?.items?.[0];
  check(line?.slug === productA.slug && line.slug !== String(productA.sku).toLowerCase(), "cart line slug is the product slug, not the SKU");
  check(String(line?.productId) === String(a.product._id) && String(line?.variantId) === String(a.variant._id) && line?.sku === a.variant.sku, "line has productId, variantId, sku");
  check(line?.bulk === false && line.unitPrice === 200 && line.appliedSlab === null, "qty 2 is a regular purchase at the regular price");
  check(line?.nextSlab?.minQty === 10 && line.nextSlab.saveEach === 20 && line.nextSlab.unitPrice === 180, "nextSlab tells how to reach the 10-unit slab");
  check(line?.unitPricePerBaseUnit?.label === "₹200/kg", "unitPricePerBaseUnit from packSize");
  check(line?.rules?.min === 1 && line.rules.step === 1 && line.rules.bulkFrom === 10, "rules {min, step, max} for the regular range");
  check(line?.hold?.expiresAt && new Date(line.hold.expiresAt) > new Date(), "line hold.expiresAt exposed");
  check(res.data.holdExpiresAt && new Date(res.data.holdExpiresAt).getTime() === new Date(line.hold.expiresAt).getTime(), "cart-level holdExpiresAt = earliest hold");

  res = await call("POST", "/cart/items", { token: alice.token, json: { variantId: String(a.variant._id), qty: 8, mode: "bulk" } });
  const items = res.data.groups?.[0]?.items || [];
  check(items.length === 1 && items[0].qty === 10, "same variant (mode=bulk) merges into ONE line, qty 10");
  check(items[0]?.bulk === true && items[0].unitPrice === 180 && items[0].appliedSlab?.minQty === 10, "qty 10 enters the bulk range: slab price chosen automatically");
  check(items[0]?.rules?.min === 10 && items[0].rules.step === 5 && items[0].rules.max === 100, "bulk-range rules {min 10, step 5, max 100}");
  const held = await StockReservation.find({ variantId: a.variant._id, status: "held" }).lean();
  check(held.length === 1 && held[0].qty === 10, "one hold of 10 for the merged line");

  res = await call("PATCH", `/cart/items/${items[0].cartItemId}`, { token: alice.token, json: { qty: 12 } });
  check(res.status === 400 && res.data.code === "PACK_MULTIPLE", "bulk range enforces the pack multiple");
  res = await call("PATCH", `/cart/items/${items[0].cartItemId}`, { token: alice.token, json: { qty: 7 } });
  check(res.status === 200 && res.data.groups[0].items[0].bulk === false && res.data.groups[0].items[0].unitPrice === 200, "back below the bulk range: regular price, no pack rule");
  res = await call("POST", "/cart/items", { token: alice.token, json: { variantId: String(v2._id), qty: 1, bulk: true } });
  check(res.status === 400 && res.data.code === "NOT_BULK", "bulk hint on a non-bulk product is still rejected");

  // Legacy carts with two lines of one variant are merged on read.
  const cartDoc = await Cart.findOne({ userId: alice.user._id });
  await Cart.updateOne(
    { _id: cartDoc._id },
    { $push: { items: { tenantId: a.tenant._id, productId: a.product._id, variantId: a.variant._id, qty: 3, bulk: true } } }
  );
  res = await call("GET", "/cart", { token: alice.token });
  const merged = res.data.groups?.[0]?.items || [];
  check(merged.length === 1 && merged[0].qty === 10 && merged[0].bulk === true, "legacy duplicate lines merged on read (7 + 3 = 10)");
  check((await Cart.findById(cartDoc._id)).items.length === 1, "merge persisted");

  /* ------------------------------------------------------------------ previews / fees */
  console.log("\n# checkout preview + payment options");
  res = await call("POST", "/checkout/preview", { token: alice.token, json: { addressId: String(alice.address._id) } });
  const g = res.data.groups?.[0];
  check(res.status === 200 && g, `preview ok (${res.status} ${res.data?.message || ""})`);
  check(
    ["feeTax", "productTax", "taxableValue", "fees", "grandTotal"].every((k) => g?.[k] !== undefined) &&
      g.fees.delivery === 40 &&
      near(g.grandTotal, g.total) &&
      near(g.fees.total, g.deliveryFee + g.platformFee + g.partnerFee),
    "preview group has feeTax, productTax, taxableValue, fees{delivery..}, grandTotal"
  );
  check(near(g.productTax + g.feeTax, g.tax), "productTax + feeTax = tax");
  check(res.data.fees && res.data.taxableValue != null, "preview top level has fees + taxableValue");

  res = await call("GET", `/checkout/payment-options?addressId=${alice.address._id}`, { token: alice.token });
  const po = res.data;
  const method = (rows, m) => rows.find((r) => r.method === m);
  check(res.status === 200 && po.groups?.length === 1 && po.methods?.length === 6, "payment-options: groups + overall methods");
  check(method(po.methods, "cod").enabled === true, "COD allowed (store + platform enable it)");
  check(method(po.methods, "credit_terms").enabled === false && method(po.methods, "credit_terms").code === "TERMS_NOT_ENABLED", "credit terms disabled with reason");
  check(method(po.methods, "upi").enabled === razorpayConfigured(), "online methods follow Razorpay configuration");
  await setBuyerTerms({ tenantId: a.tenant._id, user: null }, alice.user._id, { creditEnabled: true, creditLimit: 100000 });
  res = await call("GET", `/checkout/payment-options?addressId=${alice.address._id}`, { token: alice.token });
  check(method(res.data.methods, "credit_terms").enabled === true && res.data.groups[0].credit?.creditEnabled === true, "credit terms enabled once the store grants them");
  check(method(res.data.methods, "purchase_order").enabled === false, "PO still disabled");

  res = await call("GET", "/ledger/me", { token: alice.token });
  const st = res.data.stores?.[0];
  check(
    res.status === 200 && st && st.creditEnabled === true && st.purchaseOrderEnabled === false && st.spendable === 100000 && st.store?.name && st.methods.includes("credit_terms"),
    "ledger/me stores[]: creditEnabled, purchaseOrderEnabled, spendable, store, methods"
  );
  check(res.data.ledgers?.[0]?.creditEnabled === true && typeof res.data.ledgers[0].tenantId === "object", "ledgers[] rows carry the enablement too (tenantId stays populated)");

  /* ------------------------------------------------------------------ checkout response */
  const preview = await call("POST", "/checkout/preview", { token: alice.token, json: { addressId: String(alice.address._id) } });
  res = await call("POST", "/checkout", {
    token: alice.token,
    headers: { "Idempotency-Key": `sf-${Date.now()}` },
    json: { addressId: String(alice.address._id), paymentMethod: "cod", expectedGrandTotal: preview.data.grandTotal },
  });
  check(res.status === 201, `checkout cod (${res.status} ${res.data?.message || ""})`);
  const cg = res.data.groups?.[0];
  check(
    cg && ["feeTax", "productTax", "taxableValue", "fees", "grandTotal"].every((k) => cg[k] !== undefined) && near(cg.grandTotal, preview.data.groups[0].grandTotal) && near(cg.productTax, preview.data.groups[0].productTax),
    "checkout response groups carry the same totals as the preview"
  );
  const order = res.data.orders[0];

  /* ------------------------------------------------------------------ order allowedActions */
  console.log("\n# order allowedActions");
  res = await call("GET", `/orders/${order._id}`, { token: alice.token });
  let acts = res.data.allowedActions;
  check(acts?.cancel === true && acts.return === false && acts.reorder === true && acts.invoice === false && acts.track === false && acts.pay === false, "pending COD order: cancel + reorder only");
  check(res.data.totals?.grandTotal === order.total && res.data.totals.fees, "order detail totals block");
  let o = await confirmOrder(await Order.findById(order._id), null);
  for (const step of ["processing", "ready_to_ship", "shipped", "delivered"]) o = await advanceOrder(o, step, {});
  res = await call("GET", `/orders/${order._id}`, { token: alice.token });
  acts = res.data.allowedActions;
  check(acts?.cancel === false && acts.return === true && acts.invoice === true && acts.track === true && acts.returnUntil, "delivered easy-return order: return, invoice, track; no cancel");

  /* ------------------------------------------------------------------ reviews */
  console.log("\n# review eligibility");
  res = await call("GET", `/products/${productA.slug}/reviews/eligibility`);
  check(res.status === 200 && res.data.canReview === false && res.data.reason === "LOGIN_REQUIRED", "anonymous -> LOGIN_REQUIRED");
  res = await call("GET", `/products/${productA.slug}/reviews/eligibility`, { token: bob.token });
  check(res.data.canReview === false && res.data.reason === "NOT_VERIFIED_BUYER" && res.data.existingReview === null, "no delivered order -> NOT_VERIFIED_BUYER");
  res = await call("GET", `/products/${productA.slug}/reviews/eligibility`, { token: alice.token });
  check(res.data.canReview === true && res.data.reason === null && String(res.data.orderId) === String(order._id), "delivered order -> canReview");
  await call("POST", `/products/${productA.slug}/reviews`, { token: alice.token, json: { rating: 4, body: "Good" } });
  res = await call("GET", `/products/${productA.slug}/reviews/eligibility`, { token: alice.token });
  check(res.data.canReview === true && res.data.existingReview?.rating === 4, "existing review returned");

  /* ------------------------------------------------------------------ coupons */
  console.log("\n# buyer coupon listing");
  const mk = (extra) => Coupon.create({ tenantId: a.tenant._id, name: extra.code, type: "percent", value: 5, ...extra });
  await mk({ code: "PUBLIC5" });
  await mk({ code: "BIGCART", minCartValue: 100000 });
  await mk({ code: "SECRET", visibility: "private" });
  await mk({ code: "FORBOB", customerIds: [bob.user._id] });
  await mk({ code: "FORALICE", customerIds: [alice.user._id] });
  await mk({ code: "EXPIRED", endsAt: new Date(Date.now() - 86400000) });
  await Coupon.create({ tenantId: b.tenant._id, code: "OTHERSTORE", name: "x", type: "fixed", value: 10 });
  res = await call("GET", "/cart/coupons", { token: alice.token });
  let codes = (res.data.coupons || []).map((c) => c.code).sort();
  check(res.status === 200 && res.data.cartEmpty === true, "works with an empty cart");
  check(JSON.stringify(codes) === JSON.stringify(["BIGCART", "FORALICE", "PUBLIC5"]), `alice sees public + her targeted coupons only (${codes.join(",")})`);
  check(res.data.coupons.every((c) => c.appliesToCart === false && c.store?.name), "empty cart: nothing applies yet, store info present");
  res = await call("GET", "/cart/coupons", { token: bob.token });
  codes = (res.data.coupons || []).map((c) => c.code);
  check(codes.length === 0, "bob (no home store, no orders, empty cart) sees nothing");
  res = await call("GET", `/cart/coupons?tenantId=${a.tenant._id}`, { token: bob.token });
  codes = (res.data.coupons || []).map((c) => c.code).sort();
  check(JSON.stringify(codes) === JSON.stringify(["BIGCART", "FORBOB", "PUBLIC5"]), `bob browsing store A sees public + his own (${codes.join(",")})`);
  await call("POST", "/cart/items", { token: bob.token, json: { variantId: String(a.variant._id), qty: 1 } });
  res = await call("GET", "/cart/coupons", { token: bob.token });
  const pub = res.data.coupons.find((c) => c.code === "PUBLIC5");
  const big = res.data.coupons.find((c) => c.code === "BIGCART");
  check(pub?.appliesToCart === true && pub.savings === 10 && big?.appliesToCart === false && /Minimum/.test(big.reason), "with a cart: each coupon marked applies / not (with reason)");
  check(res.data.best?.code === "PUBLIC5" || res.data.best?.code === "FORBOB", "best coupon picked");
  res = await call("POST", "/cart/coupon", { token: alice.token, json: { code: "FORBOB" } });
  check(res.status !== 200 || !res.data.couponDiscount, "a coupon targeted at bob does not apply to alice");

  /* ------------------------------------------------------------------ serviceability */
  console.log("\n# serviceability");
  res = await call("GET", `/location/serviceability?tenantId=${a.tenant._id}&postalCode=411001&latitude=19.01&longitude=73.01`);
  check(res.status === 200 && res.data.serviceable === true && res.data.zone?.name === "Radius", "exact coordinates match the radius zone");
  res = await call("GET", `/location/serviceability?tenantId=${a.tenant._id}&postalCode=411001&latitude=19.01&longitude=73.01&approximate=true`);
  check(res.status === 200 && res.data.serviceable === false, "approximate=true is forwarded: radius zones skipped");
  res = await call("GET", `/products/${productA.slug}/serviceability?pincode=400001`);
  check(
    res.status === 200 && res.data.deliverable === true && res.data.fee === 40 + res.data.partnerFee && res.data.etaDaysMin === 3 && res.data.etaDaysMax === 4 && res.data.reason === "",
    "product serviceability: deliverable, fee, ETA incl. bulk lead time"
  );
  check(res.headers.get("ratelimit") || res.headers.get("ratelimit-policy"), "product serviceability is rate limited (RateLimit headers)");
  res = await call("GET", `/products/${productA.slug}/serviceability?pincode=560001`);
  check(res.data.deliverable === false && res.data.reasonCode === "NOT_SERVICEABLE" && res.data.reason, "unserviceable PIN -> reason");
  res = await call("GET", `/products/${productA.slug}/serviceability?pincode=12`);
  check(res.status === 400, "invalid PIN -> 400");

  /* ------------------------------------------------------------------ search */
  console.log("\n# search");
  await PriceList.create({ tenantId: a.tenant._id, name: "Alice", customerId: alice.user._id, status: "active", items: [{ variantId: v2._id, unitPrice: 90 }] });
  // The review above recomputed product A's cached rating; checkout + bob's cart used stock.
  const fresh = await Product.findById(a.product._id).lean();
  const stockA = (await Inventory.findOne({ variantId: a.variant._id }).lean()).available;
  check(fresh.ratingAvg === 4 && fresh.ratingCount === 1 && stockA === 89, "fixture state: rating 4 (1 review), stock 100 - 10 sold - 1 held");
  res = await call("GET", "/products/search?limit=10");
  const rows = res.data.data || [];
  const rowA = rows.find((r) => String(r._id) === String(a.product._id));
  check(res.status === 200 && rows.length === 3 && res.data.meta?.total === 3, "search lists published products of active stores");
  check(rowA?.ratingAvg === 4 && rowA.ratingCount === 1, "ratingAvg / ratingCount returned");
  check(rowA?.variants?.[0]?.available === stockA && rowA.variants[0].inStock === true && rowA.variants[0].stockStatus === "in_stock", "per-variant availability");
  check(rowA?.variants?.[0]?.tierPrices?.length === 2 && rowA.variants[0].unitPricePerBaseUnit?.unit === "kg" && rowA.rules?.bulkFrom === 10, "slab table, per-unit price and rules on search rows");
  const rowB = rows.find((r) => String(r._id) === String(b.product._id));
  check(rowB?.inStock === false && rowB.variants[0].stockStatus === "out", "out-of-stock product flagged");
  const rowDal = rows.find((r) => String(r._id) === String(p2._id));
  check(rowDal?.variants?.[0]?.stockStatus === "low", "low stock flagged");
  res = await call("GET", `/products/search?category=${parent.slug}`);
  check(res.data.meta.total === 3, "category includes child categories");
  res = await call("GET", `/products/search?category=${child.slug}`);
  check(res.data.meta.total === 1, "child category alone");
  res = await call("GET", "/products/search?brand=brandx,BrandY");
  check(res.data.meta.total === 2, "multiple brands");
  res = await call("GET", `/products/search?brandId=${brandY._id}`);
  check(res.data.meta.total === 1 && String(res.data.data[0]._id) === String(p2._id), "brandId filter");
  res = await call("GET", "/products/search?minPrice=100&maxPrice=150");
  check(res.data.meta.total === 1 && String(res.data.data[0]._id) === String(p2._id), "price range");
  res = await call("GET", "/products/search?inStock=1");
  check(res.data.meta.total === 2 && !res.data.data.some((r) => String(r._id) === String(b.product._id)), "inStock filter");
  res = await call("GET", "/products/search?bulkEligible=true");
  check(res.data.meta.total === 1, "bulkEligible filter");
  res = await call("GET", "/products/search?sort=price-asc");
  check(res.data.data.map((r) => r.minPrice).join(",") === "50,110,200", "sort price-asc");
  res = await call("GET", "/products/search?sort=price-desc");
  check(res.data.data.map((r) => r.minPrice).join(",") === "200,110,50", "sort price-desc");
  res = await call("GET", "/products/search?sort=rating");
  check(String(res.data.data[0]._id) === String(a.product._id), "sort rating");
  res = await call("GET", "/products/search?sort=discount");
  check(String(res.data.data[0]._id) === String(a.product._id) && res.data.data[0].discountPct === 20, "sort discount");
  res = await call("GET", "/products/search?sort=newest&page=2&limit=2");
  check(res.data.meta.page === 2 && res.data.meta.limit === 2 && res.data.meta.pages === 2 && res.data.data.length === 1, "page/limit meta");
  res = await call("GET", "/products/search?facets=1");
  const fx = res.data.facets;
  check(fx?.brands?.length === 2 && fx.brands.every((x) => x.count === 1 && x.name) && fx.priceRange?.min === 50 && fx.priceRange.max === 200, "facets: brand counts + price range");
  res = await call("GET", "/products/search?facets=1&brand=brandx");
  check(res.data.meta.total === 1 && res.data.facets.brands.length === 2, "brand facet counts ignore the brand filter");
  res = await call("GET", "/products/search?q=dal", { token: alice.token });
  check(res.data.data[0]?.variants?.[0]?.sellingPrice === 90, "buyer price list applies when signed in");
  res = await call("GET", "/products/search?q=dal");
  check(res.data.data[0]?.variants?.[0]?.sellingPrice === 110, "anonymous gets the catalog price");

  /* ------------------------------------------------------------------ lookup */
  console.log("\n# lookup + public settings");
  res = await call("GET", `/products/lookup?slug=${productA.slug}`);
  const lk = res.data;
  check(res.status === 200 && lk.variants?.[0]?.stockStatus === "in_stock" && lk.variants[0].available === stockA, "lookup: per-variant stock");
  check(lk.variants?.[0]?.tierPrices?.length === 2 && lk.rules?.moq === 10 && lk.rules.packMultiple === 5 && lk.rules.maxQty === 100, "lookup: slabs + MOQ/pack rules");
  check(lk.store?.name && lk.store.slug === a.tenant.slug && lk.store.city === "Pune" && lk.store.rating === 3.9 && lk.store.ratingCount === 3, "lookup: store name, slug, city, rating");
  check(lk.returnWindowDays === 10 && lk.returns?.returnable === true, "lookup: returnWindowDays from settings");
  check(lk.delivery?.freeDeliveryAbove === 5000 && lk.delivery.etaDaysMin === 1 && lk.delivery.pickupAvailable === true && lk.delivery.leadTimeDays === 2, "lookup: delivery info");

  res = await call("GET", `/settings/public?tenantId=${a.tenant._id}`);
  check(res.data.freeDeliveryAbove === 5000 && res.data.delivery?.freeDeliveryAbove === 5000 && res.data.delivery.zoneFeeMin === 40 && res.data.feeTaxRate === 18, "settings/public: freeDeliveryAbove + delivery fee config");
  res = await call("GET", "/settings/public");
  check(res.data.delivery && res.data.delivery.defaultPartner, "settings/public without a store: platform delivery config");

  /* ------------------------------------------------------------------ links */
  console.log("\n# links");
  const front = String(env.frontendUrl).split(",")[0].trim().replace(/\/+$/, "");
  check(orderUrl("abc") === `${front}/account/orders/abc`, "buyer order link -> /account/orders/:id");
  check(staffOrderUrl("abc") === `${front}/tenant/orders/abc`, "staff order link -> /tenant/orders/:id");
  check(links.restockConfirm("t1") === `${front}/restock/confirm?token=t1`, "restock confirm -> /restock/confirm");
  check(links.verifyEmail("t") === `${front}/verify-email?token=t` && links.resetPassword("t") === `${front}/reset-password?token=t`, "verify / reset links");
  check(unsubscribeUrl(alice.user._id, "order").startsWith(`${front}/unsubscribe?token=`), "unsubscribe -> /unsubscribe");
  process.env.FRONTEND_ORDER_PATH = "/orders";
  check(orderUrl("abc") === `${front}/orders/abc`, "order path configurable (FRONTEND_ORDER_PATH)");
  delete process.env.FRONTEND_ORDER_PATH;

  server.close();
  await teardown();
  finish("storefront");
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
});
