/**
 * Phase 3 (p3-limits): plan entitlements — features + limits + usage, enforcement at every
 * creation / activation call site, downgrade semantics (existing items stay, new ones blocked),
 * bulk import batch check, scheduled publish, credit terms at checkout, platform admin bypass,
 * legacy / no-subscription = unlimited, GET /billing/me/entitlements.
 *
 * Throwaway local replica set only (the database is dropped):
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p3l?replicaSet=rs0" node src/tests/phase3Limits.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { setup, teardown, makeStore, makeBuyer } from "./commerceFixtures.js";
import { requestId } from "../middleware/requestId.js";
import { notFound, errorHandler } from "../middleware/error.js";
import { signAccessToken } from "../utils/tokens.js";
import { ensureSystemRoles } from "../seeds/index.js";
import v1 from "../routes/v1.js";
import entitlementsRouter from "../modules/billing/entitlements.routes.js";
import { getEntitlements, invalidateEntitlements, assertWithinLimit, __resetEntitlementsCache } from "../modules/billing/entitlements.js";
import { Plan, snapshotOf } from "../modules/billing/plan.model.js";
import { TenantSubscription } from "../modules/billing/subscription.model.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { publishScheduledProducts, invalidateActiveTenants } from "../modules/catalog/service.js";
import { addItem, getOrCreateCart, quoteCart } from "../modules/cart/service.js";
import { paymentOptions, checkout } from "../modules/checkout/service.js";
import * as ledger from "../modules/ledger/service.js";

if (!/127\.0\.0\.1:27027\/msp_test_p3l(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p3l database");
  process.exit(2);
}

await setup();
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));
__resetEntitlementsCache();

const app = express();
app.use(requestId);
app.use(express.json());
app.use("/api/v1/billing", entitlementsRouter);
app.use("/api/v1", v1);
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, { token, json, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + "/api/v1" + url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}\n     ${err.stack}`);
    process.exitCode = 1;
  }
}

const roles = await ensureSystemRoles();
const tokenFor = async (user) => {
  const fresh = await User.findById(user._id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};
let seq = 0;
async function mkStore(name, status = "active") {
  seq += 1;
  const tenant = await Tenant.create({ name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${seq}`, status });
  const admin = await User.create({
    name: `${name} admin`,
    email: `admin${seq}@p3l.test`,
    passwordHash: "x",
    roleId: roles.tenant_admin._id,
    tenantId: tenant._id,
    status: "active",
    emailVerified: true,
  });
  return { tenant, admin, token: await tokenFor(admin) };
}
const platform = await User.create({ name: "Platform", email: "pa@p3l.test", passwordHash: "x", roleId: roles.super_admin._id, status: "active", emailVerified: true });
const PA = await tokenFor(platform);
const asAdmin = (tenantId) => ({ "X-Tenant-Id": String(tenantId), "X-Admin-Reason": "plan limit test" });

const NONE = { coupons: false, offers: false, creditTerms: false, reports: false, exports: false, analytics: false, featuredPlacement: false, customRoles: false };
const ALL = Object.fromEntries(Object.keys(NONE).map((k) => [k, true]));
const starter = await Plan.create({
  code: "starter",
  name: "Starter",
  priceInr: 499,
  interval: "monthly",
  limits: { products: 2, staff: 2, riders: 0, warehouses: 1, coupons: 1, offers: 1, priceLists: 1 },
  features: { ...NONE, coupons: true },
});
const pro = await Plan.create({
  code: "pro",
  name: "Pro",
  priceInr: 1999,
  interval: "monthly",
  limits: { products: -1, staff: -1, riders: -1, warehouses: -1, coupons: -1, offers: -1, priceLists: -1 },
  features: ALL,
});

async function subscribe(tenantId, plan, status = "active", extra = {}) {
  await TenantSubscription.findOneAndUpdate(
    { tenantId },
    { $set: { planId: plan?._id || null, planSnapshot: plan ? snapshotOf(plan) : {}, status, ...extra } },
    { upsert: true, new: true }
  );
  invalidateEntitlements(tenantId);
}
/** Change the snapshot limits of a store's subscription (simulates a plan change / downgrade). */
async function setLimits(tenantId, limits) {
  const sub = await TenantSubscription.findOne({ tenantId });
  for (const [k, v] of Object.entries(limits)) sub.planSnapshot.limits[k] = v;
  sub.markModified("planSnapshot");
  await sub.save();
  invalidateEntitlements(tenantId);
}
const productBody = (sku, extra = {}) => ({ name: `Product ${sku}`, sku, sellingPrice: 100, listPrice: 120, ...extra });

/* ------------------------------------------------------------------ no subscription / legacy */

const free = await mkStore("Free Co");
await check("no subscription -> unlimited + all features", async () => {
  const e = await getEntitlements(free.tenant._id);
  assert.equal(e.source, "none");
  assert.equal(e.unlimited, true);
  assert.equal(e.limits.products, -1);
  assert.equal(e.features.customRoles, true);
  for (let i = 0; i < 4; i += 1) {
    const r = await call("POST", "/products", { token: free.token, json: productBody(`FREE-${i}`) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  const role = await call("POST", "/roles", { token: free.token, json: { name: "Packer" } });
  assert.equal(role.status, 201, JSON.stringify(role.data));
});

const legacy = await mkStore("Legacy Co");
await subscribe(legacy.tenant._id, starter, "legacy");
await check("legacy status -> unlimited even with a limited snapshot", async () => {
  const e = await getEntitlements(legacy.tenant._id);
  assert.equal(e.status, "legacy");
  assert.equal(e.unlimited, true);
  for (let i = 0; i < 3; i += 1) {
    const r = await call("POST", "/products", { token: legacy.token, json: productBody(`LEG-${i}`) });
    assert.equal(r.status, 201);
  }
});

/* ------------------------------------------------------------------ starter plan */

const S = await mkStore("Starter Co");
await subscribe(S.tenant._id, starter, "active");

await check("GET /billing/me/entitlements returns plan, features, limits, usage", async () => {
  const r = await call("GET", "/billing/me/entitlements", { token: S.token });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.plan, { code: "starter", name: "Starter" });
  assert.equal(r.data.status, "active");
  assert.equal(r.data.limits.products, 2);
  assert.equal(r.data.features.coupons, true);
  assert.equal(r.data.features.customRoles, false);
  assert.equal(r.data.usage.staff, 1);
  assert.equal(r.data.usage.products, 0);
  assert.equal(r.data.usage.riders, 0);
  assert.equal(r.data.remaining.products, 2);
  const pa = await call("GET", "/billing/me/entitlements", { token: PA, headers: { "X-Tenant-Id": String(S.tenant._id) } });
  assert.equal(pa.status, 200);
  assert.equal(pa.data.plan.code, "starter");
});

let draftId;
let publishedId;
await check("product create: within limit ok, over limit -> 403 LIMIT_REACHED", async () => {
  const a = await call("POST", "/products", { token: S.token, json: productBody("S-1", { status: "published" }) });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  publishedId = a.data._id;
  const b = await call("POST", "/products", { token: S.token, json: productBody("S-2") });
  assert.equal(b.status, 201);
  draftId = b.data._id;
  const c = await call("POST", "/products", { token: S.token, json: productBody("S-3") });
  assert.equal(c.status, 403);
  assert.equal(c.data.code, "LIMIT_REACHED");
  assert.equal(c.data.kind, "products");
  assert.equal(c.data.limit, 2);
  assert.equal(c.data.usage, 2);
  assert.match(c.data.message, /Starter/);
  assert.equal(await Product.countDocuments({ tenantId: S.tenant._id }), 2);
});

await check("platform admin bypasses limits (and features)", async () => {
  const r = await call("POST", "/products", { token: PA, headers: asAdmin(S.tenant._id), json: productBody("S-PA") });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const role = await call("POST", "/roles", { token: PA, headers: asAdmin(S.tenant._id), json: { name: "Admin made", tenantId: String(S.tenant._id) } });
  assert.equal(role.status, 201, JSON.stringify(role.data));
  // Store is now over its products limit (3 / 2), like after a downgrade.
});

await check("over limit (downgrade): publish draft / new variant blocked; published stays published", async () => {
  const pub = await call("POST", `/products/${draftId}/publish`, { token: S.token });
  assert.equal(pub.status, 403);
  assert.equal(pub.data.code, "LIMIT_REACHED");
  assert.equal(pub.data.adding, 0);
  const viaPatch = await call("PATCH", `/products/${draftId}`, { token: S.token, json: { status: "published" } });
  assert.equal(viaPatch.status, 403);
  const variant = await call("POST", "/variants", { token: S.token, json: { productId: publishedId, sku: "S-1-B", listPrice: 10, sellingPrice: 10 } });
  assert.equal(variant.status, 403);
  assert.equal(variant.data.code, "LIMIT_REACHED");
  assert.equal((await Product.findById(publishedId).lean()).status, "published");
  // Re-publishing an already published product is not blocked; editing still works.
  const again = await call("POST", `/products/${publishedId}/publish`, { token: S.token });
  assert.equal(again.status, 200);
  const edit = await call("PATCH", `/products/${publishedId}`, { token: S.token, json: { description: "still editable" } });
  assert.equal(edit.status, 200);
});

await check("scheduled publish job: over limit -> back to draft with a plan reason", async () => {
  await Product.updateOne({ _id: draftId }, { $set: { status: "scheduled", scheduledAt: new Date(Date.now() - 1000), scheduledBy: S.admin._id } });
  invalidateActiveTenants();
  const res = await publishScheduledProducts();
  assert.equal(res.rejected, 1, JSON.stringify(res));
  const p = await Product.findById(draftId).lean();
  assert.equal(p.status, "draft");
  assert.match(p.scheduleError, /Plan limit reached/);
});

await check("archiving frees a slot: then publish + variant work", async () => {
  const del = await call("DELETE", `/products/${draftId}`, { token: S.token });
  assert.equal(del.status, 200);
  const extra = await Product.findOne({ tenantId: S.tenant._id, sku: "S-PA" }).lean();
  const pub = await call("POST", `/products/${extra._id}/publish`, { token: S.token });
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  const variant = await call("POST", "/variants", { token: S.token, json: { productId: publishedId, sku: "S-1-B", listPrice: 10, sellingPrice: 10 } });
  assert.equal(variant.status, 201, JSON.stringify(variant.data));
  // Restoring the archived one would exceed the limit.
  const restore = await call("PATCH", `/products/${draftId}`, { token: S.token, json: { status: "draft" } });
  assert.equal(restore.status, 403);
  assert.equal(restore.data.code, "LIMIT_REACHED");
});

await check("bulk import: batch rejected when new rows don't fit (dry run reports it)", async () => {
  await setLimits(S.tenant._id, { products: 4 }); // usage 2 -> 2 more fit
  const items = [productBody("B-1"), productBody("B-2"), productBody("B-3")];
  const dry = await call("POST", "/products/bulk-upload?dryRun=true", { token: S.token, json: { items } });
  assert.equal(dry.status, 200);
  assert.equal(dry.data.ok, false);
  assert.equal(dry.data.planLimit.ok, false);
  assert.equal(dry.data.planLimit.available, 2);
  assert.equal(dry.data.planLimit.adding, 3);
  const real = await call("POST", "/products/bulk-upload", { token: S.token, json: { items } });
  assert.equal(real.status, 403);
  assert.equal(real.data.code, "LIMIT_REACHED");
  assert.equal(real.data.available, 2);
  assert.match(real.data.message, /only 2 more can be added/);
  assert.equal(await Product.countDocuments({ tenantId: S.tenant._id, sku: /^B-/ }), 0);
  // CSV goes through the same check.
  const csv = "name,sku,sellingPrice\nC one,C-1,10\nC two,C-2,10\nC three,C-3,10\n";
  const res = await fetch(`${base}/api/v1/products/bulk-upload`, { method: "POST", headers: { Authorization: `Bearer ${S.token}`, "Content-Type": "text/csv" }, body: csv });
  assert.equal(res.status, 403);
  // Updates of existing SKUs don't count; 2 new rows fit.
  const ok = await call("POST", "/products/bulk-upload", { token: S.token, json: { items: [productBody("S-1", { name: "Renamed" }), productBody("B-1"), productBody("B-2"), productBody("B-2")] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.created.length, 2);
  assert.equal(ok.data.updated.length, 2); // S-1 + the repeated B-2 row
  const okDry = await call("POST", "/products/bulk-upload?dryRun=true", { token: S.token, json: { items: [productBody("S-1")] } });
  assert.equal(okDry.data.planLimit.ok, true);
});

await check("staff limit: create / re-activate blocked at the limit", async () => {
  const body = (n) => ({ name: `Staff ${n}`, email: `staff${n}@p3l.test`, password: "Str0ng!Passw0rd", roleId: String(roles.support_agent._id) });
  const a = await call("POST", "/users", { token: S.token, json: body(1) });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await call("POST", "/users", { token: S.token, json: body(2) });
  assert.equal(b.status, 403);
  assert.equal(b.data.code, "LIMIT_REACHED");
  assert.equal(b.data.kind, "staff");
  // A suspended member frees the slot; re-activating is then blocked once the slot is reused.
  const staffId = a.data.id || a.data._id;
  const off = await call("PATCH", `/users/${staffId}`, { token: S.token, json: { status: "suspended" } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const c = await call("POST", "/users", { token: S.token, json: body(3) });
  assert.equal(c.status, 201);
  const on = await call("PATCH", `/users/${staffId}`, { token: S.token, json: { status: "active" } });
  assert.equal(on.status, 403);
  assert.equal(on.data.code, "LIMIT_REACHED");
});

await check("custom roles need the customRoles feature", async () => {
  const r = await call("POST", "/roles", { token: S.token, json: { name: "Picker" } });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "PLAN_FEATURE_REQUIRED");
  assert.equal(r.data.feature, "customRoles");
  assert.deepEqual(r.data.plan, { code: "starter", name: "Starter" });
});

await check("warehouses: active limit on create and re-activation", async () => {
  const a = await call("POST", "/warehouses", { token: S.token, json: { name: "Main", code: "W1" } });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await call("POST", "/warehouses", { token: S.token, json: { name: "Second", code: "W2" } });
  assert.equal(b.status, 403);
  assert.equal(b.data.kind, "warehouses");
  const c = await call("POST", "/warehouses", { token: S.token, json: { name: "Spare", code: "W3", status: "inactive" } });
  assert.equal(c.status, 201);
  const d = await call("PATCH", `/warehouses/${c.data._id}`, { token: S.token, json: { status: "active" } });
  assert.equal(d.status, 403);
});

await check("coupons: active limit on create / enable; disabled ones don't count", async () => {
  const body = (code) => ({ code, name: code, type: "percent", value: 10 });
  const a = await call("POST", "/coupons", { token: S.token, json: body("ONE") });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await call("POST", "/coupons", { token: S.token, json: body("TWO") });
  assert.equal(b.status, 403);
  assert.equal(b.data.kind, "coupons");
  const expired = await call("POST", "/coupons", { token: S.token, json: { ...body("OLD"), startsAt: "2020-01-01", endsAt: "2020-02-01" } });
  assert.equal(expired.status, 201, "an already-expired coupon doesn't count");
  const extend = await call("PATCH", `/coupons/${expired.data._id}`, { token: S.token, json: { endsAt: "2099-01-01" } });
  assert.equal(extend.status, 403, "re-opening an expired coupon counts");
  assert.equal((await call("POST", `/coupons/${a.data._id}/disable`, { token: S.token })).status, 200);
  const c = await call("POST", "/coupons", { token: S.token, json: body("THREE") });
  assert.equal(c.status, 201);
  const enable = await call("POST", `/coupons/${a.data._id}/enable`, { token: S.token });
  assert.equal(enable.status, 403);
});

await check("offers need the offers feature", async () => {
  const r = await call("POST", "/offers", {
    token: S.token,
    json: { name: "Sale", type: "percent", value: 5, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 864e5).toISOString() },
  });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, "PLAN_FEATURE_REQUIRED");
  assert.equal(r.data.feature, "offers");
});

await check("price lists: active limit on create / approve", async () => {
  const a = await call("POST", "/pricing", { token: S.token, json: { name: "VIP" } });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const b = await call("POST", "/pricing", { token: S.token, json: { name: "VIP 2" } });
  assert.equal(b.status, 403);
  assert.equal(b.data.kind, "priceLists");
  const draft = await call("POST", "/pricing", { token: S.token, json: { name: "Later", status: "draft" } });
  assert.equal(draft.status, 201);
  const approve = await call("POST", `/pricing/${draft.data._id}/approve`, { token: S.token });
  assert.equal(approve.status, 403);
});

await check("reports / exports / analytics need their features", async () => {
  for (const url of ["/reports/overview", "/reports/sales", "/reports/export/orders", "/products/export", "/analytics/overview"]) {
    const r = await call("GET", url, { token: S.token });
    assert.equal(r.status, 403, `${url} -> ${r.status}`);
    assert.equal(r.data.code, "PLAN_FEATURE_REQUIRED", url);
  }
  const customers = await call("GET", "/reports/customers", { token: S.token });
  assert.equal(customers.status, 200, "customer management is not plan-gated");
});

/* ------------------------------------------------------------------ credit terms */

const store = await makeStore({ stock: 20, price: 100 });
const owner = await User.create({ name: "CT admin", email: "ct@p3l.test", passwordHash: "x", roleId: roles.tenant_admin._id, tenantId: store.tenant._id, status: "active", emailVerified: true });
const CT = await tokenFor(owner);
const buyer = await makeBuyer();
await ledger.setBuyerTerms({ tenantId: store.tenant._id, user: { _id: owner._id } }, buyer.user._id, { creditEnabled: true, purchaseOrderEnabled: true, creditLimit: 5000 });
await subscribe(store.tenant._id, starter, "active");

await check("credit terms: enabling needs the feature, switching off doesn't", async () => {
  const on = await call("PUT", `/ledger/accounts/${buyer.user._id}/terms`, { token: CT, json: { creditEnabled: true } });
  assert.equal(on.status, 403);
  assert.equal(on.data.feature, "creditTerms");
  const off = await call("PUT", `/ledger/accounts/${buyer.user._id}/terms`, { token: CT, json: { purchaseOrderEnabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  await ledger.setBuyerTerms({ tenantId: store.tenant._id, user: { _id: owner._id } }, buyer.user._id, { purchaseOrderEnabled: true });
});

await check("checkout: credit / PO unavailable for a seller whose plan lacks creditTerms", async () => {
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  const opts = await paymentOptions({ user: buyer.user, addressId: buyer.address._id });
  for (const m of ["credit_terms", "purchase_order"]) {
    const row = opts.methods.find((x) => x.method === m);
    assert.equal(row.enabled, false, m);
    assert.equal(row.code, "PLAN_FEATURE_REQUIRED");
    assert.match(row.reason, /plan/);
  }
  const quote = await quoteCart(await getOrCreateCart(buyer.user._id), buyer.user._id, buyer.address);
  const placed = await checkout({ user: buyer.user, addressId: buyer.address._id, paymentMethod: "credit_terms", idempotencyKey: "p3l-1", expectedGrandTotal: quote.grandTotal }).catch((e) => e);
  assert.equal(placed.status, 403);
  assert.equal(placed.code, "PLAN_FEATURE_REQUIRED");
});

await check("plan change + invalidateEntitlements: pro unlocks credit, reports, roles at once", async () => {
  await subscribe(store.tenant._id, pro, "active");
  const opts = await paymentOptions({ user: buyer.user, addressId: buyer.address._id });
  assert.equal(opts.methods.find((x) => x.method === "credit_terms").enabled, true);
  const quote = await quoteCart(await getOrCreateCart(buyer.user._id), buyer.user._id, buyer.address);
  const placed = await checkout({ user: buyer.user, addressId: buyer.address._id, paymentMethod: "credit_terms", idempotencyKey: "p3l-2", expectedGrandTotal: quote.grandTotal });
  assert.equal(placed.orders.length, 1);
  await subscribe(S.tenant._id, pro, "active");
  const role = await call("POST", "/roles", { token: S.token, json: { name: "Picker" } });
  assert.equal(role.status, 201);
  const rep = await call("GET", "/reports/overview", { token: S.token });
  assert.notEqual(rep.status, 403);
  const an = await call("GET", "/analytics/overview", { token: S.token });
  assert.notEqual(an.status, 403);
  const exp = await call("GET", "/products/export", { token: S.token });
  assert.equal(exp.status, 200);
});

/* ------------------------------------------------------------------ statuses */

await check("awaiting_payment / paused / past_due keep the plan's limits", async () => {
  for (const status of ["awaiting_payment", "paused", "past_due", "cancelled"]) {
    const st = await mkStore(`St ${status}`);
    await subscribe(st.tenant._id, starter, status);
    const e = await getEntitlements(st.tenant._id);
    assert.equal(e.status, status);
    assert.equal(e.limits.products, 2, status);
    assert.equal(e.features.customRoles, false, status);
  }
});

await check("empty snapshot falls back to the plan; cache is per tenant and invalidated", async () => {
  const st = await mkStore("Snapless");
  await TenantSubscription.create({ tenantId: st.tenant._id, planId: starter._id, status: "active" });
  invalidateEntitlements(st.tenant._id);
  let e = await getEntitlements(st.tenant._id);
  assert.equal(e.plan.code, "starter");
  await TenantSubscription.updateOne({ tenantId: st.tenant._id }, { $set: { planSnapshot: snapshotOf(pro) } });
  e = await getEntitlements(st.tenant._id);
  assert.equal(e.plan.code, "starter", "cached until invalidated");
  invalidateEntitlements(st.tenant._id);
  e = await getEntitlements(st.tenant._id);
  assert.equal(e.plan.code, "pro");
  await assertWithinLimit(st.tenant._id, "products", { adding: 1000 });
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
await teardown();
process.exit(process.exitCode || 0);
