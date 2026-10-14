/**
 * Phase 1 (platform agent): inactive stores can't sell, platform-only fee settings, seller identity
 * (GSTIN checksum + lock) and private uploads.
 *
 * Throwaway local replica set only (the database is dropped):
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p1p?replicaSet=rs0" node src/tests/phase1Platform.js
 */
import assert from "assert/strict";
import express from "express";
import fs from "fs/promises";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { requestId } from "../middleware/requestId.js";
import { notFound, errorHandler } from "../middleware/error.js";
import { signAccessToken } from "../utils/tokens.js";
import { ensureSystemRoles } from "../seeds/index.js";
import tenantRoutes from "../modules/tenants/routes.js";
import chatRoutes from "../modules/chat/routes.js";
import settingsRoutes, { settingsPublicRouter } from "../modules/settings/routes.js";
import privateFilesRouter from "../modules/files/routes.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Warehouse } from "../modules/inventory/warehouse.model.js";
import { setAvailableQty } from "../modules/inventory/service.js";
import { invalidateActiveTenants } from "../modules/catalog/service.js";
import { addItem, getOrCreateCart, quoteCart } from "../modules/cart/service.js";
import { getCommerceSettings } from "../modules/settings/commerce.js";
import { cleanPlatformOnlyOverrides, invalidateSettingCache } from "../modules/settings/service.js";
import { storage, uploadRoot, privateUploadRoot } from "../utils/storage.js";
import { PrivateFile } from "../modules/files/privateFile.model.js";

if (!/127\.0\.0\.1:27027\/msp_test_p1p(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p1p database");
  process.exit(2);
}

await mongoose.connect(env.mongoUri);
await mongoose.connection.db.dropDatabase();
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));
await storage.ensure();

const app = express();
app.use(requestId);
app.use(express.json());
app.use("/api/v1/tenants", tenantRoutes);
app.use("/api/v1/chat", chatRoutes);
app.use("/api/v1/settings", settingsPublicRouter);
app.use("/api/v1/settings", settingsRoutes);
app.use("/api/v1/files", privateFilesRouter);
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, url, { token, json, body, raw = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + (url.startsWith("/api/") || url.startsWith("/uploads") ? url : "/api/v1" + url), {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  if (raw) return res;
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
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
const VALID_GSTIN = "27AAPFU0939F1ZV";
const OTHER_VALID_GSTIN = "07AABCA1234A1ZL";
const BAD_CHECKSUM_GSTIN = "27AAPFU0939F1ZX";

const A = await Tenant.create({ name: "Alpha", slug: "alpha", status: "active", pickupAddress: { state: "Maharashtra", postalCode: "400001" } });
const S = await Tenant.create({ name: "Sleepy", slug: "sleepy", status: "suspended", pickupAddress: { state: "Maharashtra", postalCode: "400001" } });
const B = await Tenant.create({ name: "Beta", slug: "beta", status: "active" });

async function mkUser(name, email, role, { tenantId = null } = {}) {
  return User.create({ name, email, passwordHash: "x", roleId: role._id, tenantId, status: "active", emailVerified: true });
}
const tokenFor = async (user) => {
  const fresh = await User.findById(user._id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};
const platform = await mkUser("Platform", "pa@p1p.test", roles.super_admin);
const adminA = await mkUser("Admin A", "a@p1p.test", roles.tenant_admin, { tenantId: A._id });
const adminB = await mkUser("Admin B", "b@p1p.test", roles.tenant_admin, { tenantId: B._id });
const buyer = await mkUser("Buyer", "buyer@p1p.test", roles.buyer);
const T = { platform: await tokenFor(platform), adminA: await tokenFor(adminA), adminB: await tokenFor(adminB), buyer: await tokenFor(buyer) };

async function makeProduct(tenant, tag, extra = {}) {
  const product = await Product.create({
    tenantId: tenant._id,
    name: `Product ${tag}`,
    sku: `P-${tag}`,
    status: "published",
    taxClass: { name: "GST18", rate: 18 },
    ...extra,
  });
  const variant = await ProductVariant.create({ tenantId: tenant._id, productId: product._id, sku: `V-${tag}`, listPrice: 100, sellingPrice: 100 });
  const warehouse = await Warehouse.create({ tenantId: tenant._id, name: `W ${tag}`, code: `W${tag}`, state: "Maharashtra", postalCode: "400001" });
  await setAvailableQty({ tenantId: tenant._id, variantId: variant._id, warehouseId: warehouse._id, qty: 50 });
  return { product, variant };
}

/* ------------------------------------------------------------------ 1. inactive stores */

await check("cart: add-to-cart from a suspended store → 400 STORE_INACTIVE", async () => {
  const { variant } = await makeProduct(S, "s1");
  await assert.rejects(() => addItem(buyer._id, null, { variantId: variant._id, qty: 1 }), (err) => err.code === "STORE_INACTIVE");
});

await check("cart: disabled product → 400 UNAVAILABLE", async () => {
  const { variant } = await makeProduct(A, "d1", { enabled: false });
  await assert.rejects(() => addItem(buyer._id, null, { variantId: variant._id, qty: 1 }), (err) => err.code === "UNAVAILABLE");
});

await check("cart: a line whose store got suspended is listed as unavailable (STORE_INACTIVE)", async () => {
  const { variant } = await makeProduct(A, "a1");
  const ok = await addItem(buyer._id, null, { variantId: variant._id, qty: 2 });
  assert.equal(ok.groups.length, 1);
  await Tenant.updateOne({ _id: A._id }, { $set: { status: "suspended" } });
  invalidateActiveTenants();
  const quote = await quoteCart(await getOrCreateCart(buyer._id), buyer._id);
  assert.equal(quote.groups.length, 0);
  assert.equal(quote.unavailable.length, 1);
  assert.equal(quote.unavailable[0].issueCode, "STORE_INACTIVE");
  await Tenant.updateOne({ _id: A._id }, { $set: { status: "active" } });
  const back = await quoteCart(await getOrCreateCart(buyer._id), buyer._id);
  assert.equal(back.groups.length, 1, "active again: sells (trial retired in phase 2)");
  invalidateActiveTenants();
});

await check("chat: buyer can't open a new chat with a suspended store", async () => {
  const res = await call("POST", "/chat", { token: T.buyer, json: { tenantId: String(S._id), message: "hi" } });
  assert.equal(res.status, 400, JSON.stringify(res.data));
  assert.equal(res.data.code, "STORE_INACTIVE");
  const ok = await call("POST", "/chat", { token: T.buyer, json: { tenantId: String(A._id), message: "hi" } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
});

/* ------------------------------------------------------------------ 5. platform-only fee settings */

await check("settings: fee / partner keys are platform-only; legacy store overrides ignored + cleaned", async () => {
  for (const key of ["platform.feeEnabled", "platform.feeAmount", "platform.feePercent", "platform.deliveryPartners", "platform.deliveryPartnerChoiceEnabled", "platform.feeBasis", "platform.feeRefundable"]) {
    const value = key === "platform.deliveryPartners" ? [{ id: "x", name: "X", fee: 1 }] : key === "platform.feeBasis" ? "per_seller_order" : key === "platform.feeRefundable" ? "always" : key.endsWith("Enabled") ? true : 5;
    const res = await call("PUT", `/settings/${key}`, { token: T.adminA, json: { value } });
    assert.equal(res.status, 404, `${key}: ${JSON.stringify(res.data)}`);
  }
  assert.equal((await call("PUT", "/settings/platform.feeAmount", { token: T.platform, json: { value: 12 } })).status, 200);
  assert.equal((await call("PUT", "/settings/platform.feeEnabled", { token: T.platform, json: { value: true } })).status, 200);
  // A legacy override written before the rule:
  await Settings.create({ scope: "tenant", tenantId: A._id, key: "platform.feeAmount", value: 99 });
  await Settings.create({ scope: "tenant", tenantId: A._id, key: "platform.deliveryPartners", value: [{ id: "cheap", name: "Cheap", fee: 0 }] });
  invalidateSettingCache();
  const commerce = await getCommerceSettings(A._id);
  assert.equal(commerce.feeAmount, 12);
  assert.ok(!commerce.deliveryPartners.some((p) => p.id === "cheap"));
  const listed = await call("GET", "/settings", { token: T.adminA });
  assert.ok(!listed.data.some((row) => row.key === "platform.feeAmount"), "tenant list hides legacy fee overrides");
  const first = await cleanPlatformOnlyOverrides();
  assert.equal(first.removed, 2);
  assert.equal((await cleanPlatformOnlyOverrides()).removed, 0, "idempotent");
});

await check("settings: feeBasis / feeRefundable defaults, validation and exposure", async () => {
  let c = await getCommerceSettings(null);
  assert.equal(c.feeBasis, "per_checkout");
  assert.equal(c.feeRefundable, "before_shipping");
  assert.equal((await call("PUT", "/settings/platform.feeBasis", { token: T.platform, json: { value: "bogus" } })).status, 400);
  assert.equal((await call("PUT", "/settings/platform.feeBasis", { token: T.platform, json: { value: "per_seller_order" } })).status, 200);
  assert.equal((await call("PUT", "/settings/platform.feeRefundable", { token: T.platform, json: { value: "never" } })).status, 200);
  c = await getCommerceSettings(A._id);
  assert.equal(c.feeBasis, "per_seller_order");
  assert.equal(c.feeRefundable, "never");
  const pub = await call("GET", "/settings/public");
  assert.equal(pub.data.platformFeeBasis, "per_seller_order");
  assert.equal(pub.data.platformFeeRefundable, "never");
});

/* ------------------------------------------------------------------ 6. seller identity */

await check("tenants: admin create requires a checksum-valid GSTIN", async () => {
  const none = await call("POST", "/tenants", { token: T.platform, json: { name: "No Gst" } });
  assert.equal(none.status, 400);
  const bad = await call("POST", "/tenants", { token: T.platform, json: { name: "Bad Gst", businessProfile: { gstin: BAD_CHECKSUM_GSTIN } } });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fields["businessProfile.gstin"], JSON.stringify(bad.data));
  const ok = await call("POST", "/tenants", {
    token: T.platform,
    json: { name: "Good Gst", businessProfile: { legalName: "Good Gst Pvt Ltd", gstin: VALID_GSTIN.toLowerCase() } },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.businessProfile.gstin, VALID_GSTIN);
  assert.equal(ok.data.kycIncomplete, false);
  assert.equal(ok.data.identityLocked, true);
});

await check("tenants: approving a pending store without GSTIN → 400 GSTIN_REQUIRED; legacy active store keeps working", async () => {
  const pending = await Tenant.create({ name: "Pend", slug: "pend", status: "pending" });
  const res = await call("PATCH", `/tenants/${pending._id}`, { token: T.platform, json: { status: "active" } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, "GSTIN_REQUIRED");
  const ok = await call("PATCH", `/tenants/${pending._id}`, { token: T.platform, json: { status: "active", businessProfile: { gstin: VALID_GSTIN } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const mine = await call("GET", "/tenants/me", { token: T.adminB });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.kycIncomplete, true, "Beta has no GSTIN → flagged, still active");
  assert.equal(mine.data.identityLocked, false);
});

await check("tenants: seller GSTIN is checksum-validated and locked once legal name + GSTIN are set", async () => {
  const bad = await call("PATCH", "/tenants/me", { token: T.adminB, json: { businessProfile: { gstin: BAD_CHECKSUM_GSTIN } } });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  const set = await call("PATCH", "/tenants/me", { token: T.adminB, json: { businessProfile: { legalName: "Beta Traders", gstin: OTHER_VALID_GSTIN } } });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.data.identityLocked, true);
  assert.equal(set.data.kycIncomplete, false);
  // Re-sending the same values (whole-form save) is fine; other fields still editable.
  const same = await call("PATCH", "/tenants/me", {
    token: T.adminB,
    json: { name: "Beta", businessProfile: { legalName: "Beta Traders", gstin: OTHER_VALID_GSTIN, phone: "9999999999" } },
  });
  assert.equal(same.status, 200, JSON.stringify(same.data));
  for (const json of [{ name: "Beta 2" }, { businessProfile: { legalName: "Other" } }, { businessProfile: { gstin: VALID_GSTIN } }]) {
    const locked = await call("PATCH", "/tenants/me", { token: T.adminB, json });
    assert.equal(locked.status, 403, JSON.stringify(locked.data));
    assert.equal(locked.data.code, "IDENTITY_LOCKED");
  }
  // QA R4: a locked identity is read-only for the platform admin too; the store name is not.
  const adminGstin = await call("PATCH", `/tenants/${B._id}`, { token: T.platform, json: { businessProfile: { gstin: VALID_GSTIN } } });
  assert.equal(adminGstin.status, 409, JSON.stringify(adminGstin.data));
  assert.equal(adminGstin.data.code, "IDENTITY_LOCKED");
  const admin = await call("PATCH", `/tenants/${B._id}`, { token: T.platform, json: { name: "Beta Renamed", businessProfile: { gstin: OTHER_VALID_GSTIN } } });
  assert.equal(admin.status, 200, JSON.stringify(admin.data));
  assert.equal(admin.data.name, "Beta Renamed");
});

/* ------------------------------------------------------------------ 7. private uploads */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1]);
function form(folder = "kyc") {
  const fd = new FormData();
  fd.append("folder", folder);
  fd.append("purpose", "gst_certificate");
  fd.append("file", new Blob([PNG], { type: "image/png" }), "gst.png");
  return fd;
}

await check("files: KYC upload is stored privately and only the owner tenant / platform admin can read it", async () => {
  const up = await call("POST", "/files/private", { token: T.adminA, body: form() });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.private, true);
  assert.match(up.data.url, /^\/api\/v1\/files\/private\/[a-f\d]{24}$/);
  const row = await PrivateFile.findById(up.data.id).lean();
  const full = storage.privatePath(row.key);
  assert.ok(full.startsWith(privateUploadRoot));
  assert.ok(!full.startsWith(uploadRoot + "\\") && !full.startsWith(uploadRoot + "/"));
  await fs.access(full);

  const own = await call("GET", up.data.url, { token: T.adminA, raw: true });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("cache-control"), "private, no-store");
  assert.equal(Buffer.from(await own.arrayBuffer()).length, PNG.length);
  assert.equal((await call("GET", up.data.url, { token: T.platform, raw: true })).status, 200);
  assert.equal((await call("GET", up.data.url, { token: T.adminB })).status, 404, "other tenant");
  assert.equal((await call("GET", up.data.url, { token: T.buyer })).status, 403, "buyer");
  assert.equal((await call("GET", up.data.url)).status, 401, "anonymous");

  const link = await call("GET", `${up.data.url}/link`, { token: T.adminA });
  assert.equal(link.status, 200);
  assert.equal((await call("GET", link.data.url, { raw: true })).status, 200, "signed link works without auth");
  assert.equal((await call("GET", link.data.url.replace(/sig=[^&]+/, "sig=forged"))).status, 403);
  assert.equal((await call("GET", `${up.data.url}?exp=1&sig=x`)).status, 403);

  const listB = await call("GET", "/files/private", { token: T.adminB });
  assert.equal(listB.data.data.length, 0);
  assert.equal((await call("DELETE", up.data.url, { token: T.adminB })).status, 404);
  assert.equal((await call("DELETE", up.data.url, { token: T.adminA })).status, 200);
  await assert.rejects(() => fs.access(full));
});

await check("storage: the kyc folder always goes private even via storage.save()", async () => {
  const saved = await storage.save({ buffer: PNG, folder: "kyc" });
  assert.equal(saved.private, true);
  assert.equal(saved.url, null);
  await fs.access(storage.privatePath(saved.key));
  await storage.remove(saved.key, { isPrivate: true });
  const pub = await storage.save({ buffer: PNG, folder: "products" });
  assert.equal(pub.private, false);
  assert.match(pub.url, /^\/uploads\/products\//);
  await storage.remove(pub.key);
});

console.log(`\n${passed} phase-1 platform checks passed${process.exitCode ? " (with failures)" : ""}`);
await new Promise((r) => setTimeout(r, 200));
server.close();
await mongoose.disconnect();
