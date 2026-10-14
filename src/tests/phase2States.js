/**
 * Phase 2 (p2-states): store states (pending / active / paused / suspended / archived, trial
 * retired), status changes with reasons + history, paused/pending staff allowlists, scheduled
 * publish deferral, FSSAI (category flag, buyer display, expiry job, renewal), platform-admin
 * impersonation reason + access log, createTenantFromApplication, audit masking.
 *
 * Throwaway local replica set only (the database is dropped):
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_p2s?replicaSet=rs0" node src/tests/phase2States.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { requestId } from "../middleware/requestId.js";
import { notFound, errorHandler } from "../middleware/error.js";
import { signAccessToken } from "../utils/tokens.js";
import { bus } from "../utils/events.js";
import { ensureSystemRoles } from "../seeds/index.js";
import tenantRoutes from "../modules/tenants/routes.js";
import { categoryRouter, productRouter } from "../modules/catalog/routes.js";
import notificationRoutes from "../modules/notifications/routes.js";
import settingsRoutes from "../modules/settings/routes.js";
import userRoutes from "../modules/users/routes.js";
import { roleRouter } from "../modules/rbac/routes.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { AdminAccessLog } from "../modules/tenants/adminAccessLog.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Category } from "../modules/catalog/category.model.js";
import { invalidateActiveTenants, lookupBySlug, publishScheduledProducts, updateCategory } from "../modules/catalog/service.js";
import { runFssaiCompliance, invalidateFoodCategories } from "../modules/catalog/compliance.js";
import { setTenantStatus, createTenantFromApplication, listPublicStores, getPublicStore } from "../modules/tenants/service.js";
import { runTenantMigrations } from "../seeds/migrations.js";
import { summarize } from "../middleware/audit.js";
import { __resetAdminAccessDedupe, decodeAdminReason } from "../middleware/tenantScope.js";
import privateFilesRouter from "../modules/files/routes.js";
import { PrivateFile } from "../modules/files/privateFile.model.js";
import { TENANT_STATUSES } from "../config/constants.js";

if (!/127\.0\.0\.1:27027\/msp_test_p2s(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_p2s database");
  process.exit(2);
}

await mongoose.connect(env.mongoUri);
await mongoose.connection.db.dropDatabase();
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));

const app = express();
app.use(requestId);
app.use(express.json());
app.use("/api/v1/tenants", tenantRoutes);
app.use("/api/v1/categories", categoryRouter);
app.use("/api/v1/products", productRouter);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/settings", settingsRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/roles", roleRouter);
app.use("/api/v1/files", privateFilesRouter);
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

const events = [];
for (const e of ["TENANT_APPROVED", "TENANT_PAUSED", "TENANT_RESUMED", "TENANT_SUSPENDED", "TENANT_REACTIVATED", "TENANT_ARCHIVED", "FSSAI_EXPIRING", "FSSAI_EXPIRED", "FSSAI_RENEWED", "TENANT_ADMIN_ACCESS"]) {
  bus.on(e, (p) => events.push({ e, p }));
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const eventsOf = (e, tenantId) => events.filter((x) => x.e === e && (!tenantId || String(x.p.tenantId) === String(tenantId)));

const roles = await ensureSystemRoles();
const GSTIN = "27AAPFU0939F1ZV";
const A = await Tenant.create({ name: "Alpha", slug: "alpha", status: "active", businessProfile: { legalName: "Alpha LLP", gstin: GSTIN } });
const B = await Tenant.create({ name: "Beta", slug: "beta", status: "active" });
const P = await Tenant.create({ name: "Pending Co", slug: "pending-co", status: "pending" });

async function mkUser(name, email, role, { tenantId = null } = {}) {
  return User.create({ name, email, passwordHash: "x", roleId: role._id, tenantId, status: "active", emailVerified: true });
}
const tokenFor = async (user) => {
  const fresh = await User.findById(user._id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};
const platform = await mkUser("Platform", "pa@p2s.test", roles.super_admin);
const adminA = await mkUser("Admin A", "a@p2s.test", roles.tenant_admin, { tenantId: A._id });
const adminB = await mkUser("Admin B", "b@p2s.test", roles.tenant_admin, { tenantId: B._id });
const adminP = await mkUser("Admin P", "p@p2s.test", roles.tenant_admin, { tenantId: P._id });
const T = { platform: await tokenFor(platform), adminA: await tokenFor(adminA), adminB: await tokenFor(adminB), adminP: await tokenFor(adminP) };

async function makeProduct(tenant, tag, extra = {}) {
  const product = await Product.create({ tenantId: tenant._id, name: `Product ${tag}`, sku: `P-${tag}`, status: "published", ...extra });
  await ProductVariant.create({ tenantId: tenant._id, productId: product._id, sku: `P-${tag}`, listPrice: 100, sellingPrice: 90, attributes: { packSize: "1 pc" } });
  return product;
}

/* ------------------------------------------------------------------ statuses + migration */

await check("statuses: trial retired; migration trial -> active is idempotent and recorded", async () => {
  assert.deepEqual(TENANT_STATUSES, ["pending", "active", "paused", "suspended", "archived"]);
  const { insertedId } = await Tenant.collection.insertOne({ name: "Old Trial", slug: "old-trial", status: "trial", statusHistory: [] });
  const first = await runTenantMigrations();
  assert.equal(first.trialToActive, 1);
  const t = await Tenant.findById(insertedId).lean();
  assert.equal(t.status, "active");
  assert.equal(t.statusHistory.at(-1).from, "trial");
  assert.equal((await runTenantMigrations()).trialToActive, 0);
});

await check("setTenantStatus: reason required except -> active; history + events", async () => {
  await assert.rejects(setTenantStatus(B._id, "paused", {}), (e) => e.code === "REASON_REQUIRED");
  await setTenantStatus(B._id, "paused", { reason: "Subscription past due", by: platform._id });
  await setTenantStatus(B._id, "active", { by: platform._id });
  await tick();
  const t = await Tenant.findById(B._id).lean();
  assert.deepEqual(t.statusHistory.map((h) => `${h.from}>${h.to}`), ["active>paused", "paused>active"]);
  assert.equal(t.statusHistory[0].reason, "Subscription past due");
  assert.equal(String(t.statusHistory[0].by), String(platform._id));
  assert.equal(eventsOf("TENANT_PAUSED", B._id).length, 1);
  assert.equal(eventsOf("TENANT_PAUSED", B._id)[0].p.reason, "Subscription past due");
  assert.equal(eventsOf("TENANT_RESUMED", B._id).length, 1);
});

await check("PATCH /tenants/:id status needs a reason (400 REASON_REQUIRED); POST /:id/status works", async () => {
  const bad = await call("PATCH", `/tenants/${B._id}`, { token: T.platform, json: { status: "suspended" } });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.equal(bad.data.code, "REASON_REQUIRED");
  const ok = await call("PATCH", `/tenants/${B._id}`, { token: T.platform, json: { status: "suspended", reason: "Fraud review" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "suspended");
  assert.equal(ok.data.statusReason, "Fraud review");
  const back = await call("POST", `/tenants/${B._id}/status`, { token: T.platform, json: { status: "active" } });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.status, "active");
  await tick();
  assert.equal(eventsOf("TENANT_SUSPENDED", B._id).length, 1);
  assert.equal(eventsOf("TENANT_REACTIVATED", B._id).length, 1);
  const seller = await call("POST", `/tenants/${B._id}/status`, { token: T.adminB, json: { status: "active" } });
  assert.equal(seller.status, 403);
});

/* ------------------------------------------------------------------ paused / pending staff */

await check("paused store: staff allowlist (tenant read, notifications, settings read) else 403 STORE_PAUSED", async () => {
  await setTenantStatus(A._id, "paused", { reason: "Admin pause for test" });
  const me = await call("GET", "/tenants/me", { token: T.adminA });
  assert.equal(me.status, 200, JSON.stringify(me.data));
  assert.equal(me.data.status, "paused");
  assert.equal((await call("GET", "/notifications", { token: T.adminA })).status, 200);
  assert.equal((await call("GET", "/settings", { token: T.adminA })).status, 200);
  const patch = await call("PATCH", "/tenants/me", { token: T.adminA, json: { branding: { primaryColor: "#000000" } } });
  assert.equal(patch.status, 403);
  assert.equal(patch.data.code, "STORE_PAUSED");
  const create = await call("POST", "/products", { token: T.adminA, json: { name: "Nope", sku: "NOPE-1" } });
  assert.equal(create.status, 403);
  assert.equal(create.data.code, "STORE_PAUSED");
  assert.equal(create.data.reason, "Admin pause for test");
  const list = await call("GET", "/products", { token: T.adminA });
  assert.equal(list.status, 403);
});

await check("paused store is hidden from buyers (directory, store page, product lookup)", async () => {
  await makeProduct(A, "paused-1", { slug: "paused-product-1" });
  invalidateActiveTenants();
  const dir = await listPublicStores({});
  assert.ok(!dir.data.some((s) => s.slug === "alpha"));
  await assert.rejects(getPublicStore("alpha"), (e) => e.status === 404);
  await assert.rejects(lookupBySlug("paused-product-1", null, {}), (e) => e.status === 404);
  await setTenantStatus(A._id, "active", {});
  invalidateActiveTenants();
  const card = await getPublicStore("alpha");
  assert.equal(card.slug, "alpha");
});

await check("pending store staff: onboarding only (403 STORE_PENDING), tenant read allowed", async () => {
  const me = await call("GET", "/tenants/me", { token: T.adminP });
  assert.equal(me.status, 200);
  const prods = await call("GET", "/products", { token: T.adminP });
  assert.equal(prods.status, 403);
  assert.equal(prods.data.code, "STORE_PENDING");
  const settings = await call("GET", "/settings", { token: T.adminP });
  assert.equal(settings.data.code, "STORE_PENDING");
});

/* ------------------------------------------------------------------ scheduled publish */

await check("scheduled publish: non-active store defers (stays scheduled), publishes once active", async () => {
  const prod = await makeProduct(B, "sched-1", { status: "scheduled", scheduledAt: new Date(Date.now() - 60000), scheduledBy: adminB._id });
  await setTenantStatus(B._id, "paused", { reason: "Past due" });
  const r1 = await publishScheduledProducts({ now: new Date() });
  assert.equal(r1.deferred, 1);
  let doc = await Product.findById(prod._id).lean();
  assert.equal(doc.status, "scheduled");
  assert.match(doc.scheduleError, /Deferred/);
  const r2 = await publishScheduledProducts({ now: new Date() });
  assert.equal(r2.deferred, 0, "claim kept: not retried within the claim window");
  await setTenantStatus(B._id, "active", {});
  await Product.updateOne({ _id: prod._id }, { $set: { scheduleClaimedAt: new Date(Date.now() - 11 * 60 * 1000) } });
  const r3 = await publishScheduledProducts({ now: new Date() });
  assert.equal(r3.published, 1);
  doc = await Product.findById(prod._id).lean();
  assert.equal(doc.status, "published");
  assert.equal(doc.scheduleError, "");
});

/* ------------------------------------------------------------------ FSSAI */

const food = await Category.create({ name: "Food", slug: "food" });
const snacks = await Category.create({ name: "Snacks", slug: "snacks", parentId: food._id });
const tools = await Category.create({ name: "Tools", slug: "tools" });

await check("FSSAI: requiresFssai is admin-only on categories", async () => {
  const seller = await call("PATCH", `/categories/${food._id}`, { token: T.adminA, json: { requiresFssai: true } });
  assert.equal(seller.status, 403, "shared category is platform-managed");
  await updateCategory({ isPlatformAdmin: false, user: adminA, permissions: ["categories.edit"] }, food._id, { requiresFssai: true }).catch(() => {});
  assert.equal((await Category.findById(food._id).lean()).requiresFssai, false);
  const res = await call("PATCH", `/categories/${food._id}`, { token: T.platform, json: { requiresFssai: true } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.requiresFssai, true);
  invalidateFoodCategories();
});

let chips;
let hammer;
await check("FSSAI: PDP + store expose seller fssai number only for food products", async () => {
  await Tenant.updateOne({ _id: A._id }, { $set: { "kyc.sellsFood": true, "kyc.fssai": { number: "12345678901234", expiresAt: new Date(Date.now() + 90 * 86400000) } } });
  chips = await makeProduct(A, "chips", { slug: "chips-1", categoryId: snacks._id });
  hammer = await makeProduct(A, "hammer", { slug: "hammer-1", categoryId: tools._id });
  invalidateActiveTenants();
  const pdp = await lookupBySlug("chips-1", null, {});
  assert.deepEqual(pdp.fssai, { number: "12345678901234" });
  assert.deepEqual(pdp.store.fssai, { number: "12345678901234" });
  const tool = await lookupBySlug("hammer-1", null, {});
  assert.equal(tool.fssai, null);
  const store = await getPublicStore("alpha");
  assert.deepEqual(store.fssai, { number: "12345678901234" });
});

await check("FSSAI job: one reminder per threshold; expiry hides food products; renewal restores", async () => {
  await Tenant.updateOne({ _id: A._id }, { $set: { "kyc.fssai.expiresAt": new Date(Date.now() + 5 * 86400000) } });
  const r1 = await runFssaiCompliance();
  assert.equal(r1.reminders, 1);
  await tick();
  const exp = eventsOf("FSSAI_EXPIRING", A._id);
  assert.equal(exp.length, 1);
  assert.equal(exp[0].p.daysLeft, 5);
  assert.equal((await runFssaiCompliance()).reminders, 0, "same threshold not resent");

  await Tenant.updateOne({ _id: A._id }, { $set: { "kyc.fssai.expiresAt": new Date(Date.now() - 1000) } });
  const r2 = await runFssaiCompliance();
  assert.equal(r2.held, 1);
  assert.equal(r2.productsHidden, 1);
  const c = await Product.findById(chips._id).lean();
  assert.equal(c.enabled, false);
  assert.equal(c.complianceHold, "fssai_expired");
  assert.equal((await Product.findById(hammer._id).lean()).enabled, true, "non-food untouched");
  await tick();
  assert.equal(eventsOf("FSSAI_EXPIRED", A._id).length, 1);

  const reEnable = await call("PATCH", `/products/${chips._id}`, { token: T.adminA, json: { enabled: true } });
  assert.equal(reEnable.status, 409, JSON.stringify(reEnable.data));
  assert.equal(reEnable.data.code, "FSSAI_EXPIRED");
  const newFood = await call("POST", "/products", { token: T.adminA, json: { name: "Namkeen", sku: "NAMKEEN-1", categoryId: String(snacks._id), sellingPrice: 10 } });
  assert.equal(newFood.status, 201, JSON.stringify(newFood.data));
  assert.equal(newFood.data.enabled, false);
  assert.equal(newFood.data.complianceHold, "fssai_expired");

  const renew = await call("PATCH", `/tenants/${A._id}`, {
    token: T.platform,
    json: { kyc: { fssai: { number: "12345678909999", expiresAt: new Date(Date.now() + 365 * 86400000).toISOString() } } },
  });
  assert.equal(renew.status, 200, JSON.stringify(renew.data));
  assert.equal(renew.data.fssaiExpired, false);
  const after = await Product.findById(chips._id).lean();
  assert.equal(after.enabled, true);
  assert.equal(after.complianceHold, "");
  assert.equal((await Product.findById(newFood.data._id).lean()).enabled, true);
  assert.equal((await Tenant.findById(A._id).lean()).compliance.fssaiHoldAt, null);
});

/* ------------------------------------------------------------------ admin impersonation */

await check("admin in a store: writes need X-Admin-Reason; reads + writes logged; seller sees log; notify debounced", async () => {
  __resetAdminAccessDedupe();
  const h = { "X-Tenant-Id": String(B._id) };
  const noReason = await call("POST", "/products", { token: T.platform, headers: h, json: { name: "Admin made", sku: "ADM-1" } });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.code, "REASON_REQUIRED");
  const short = await call("POST", "/products", { token: T.platform, headers: { ...h, "X-Admin-Reason": "abc" }, json: { name: "Admin made", sku: "ADM-1" } });
  assert.equal(short.data.code, "REASON_REQUIRED");
  const w1 = await call("POST", "/products", { token: T.platform, headers: { ...h, "X-Admin-Reason": "Fix listing for ticket 42" }, json: { name: "Admin made", sku: "ADM-1" } });
  assert.equal(w1.status, 201, JSON.stringify(w1.data));
  const w2 = await call("POST", "/products", { token: T.platform, headers: { ...h, "X-Admin-Reason": "Fix listing for ticket 42" }, json: { name: "Admin made 2", sku: "ADM-2" } });
  assert.equal(w2.status, 201);
  const r1 = await call("GET", "/products", { token: T.platform, headers: h });
  assert.equal(r1.status, 200);
  await call("GET", "/products", { token: T.platform, headers: h }); // deduped
  const noHeader = await call("GET", "/products", { token: T.platform });
  assert.equal(noHeader.status, 200);
  await tick(150);
  const rows = await AdminAccessLog.find({ tenantId: B._id }).lean();
  assert.equal(rows.filter((r) => r.kind === "write").length, 2);
  assert.equal(rows.filter((r) => r.kind === "read").length, 1);
  assert.equal(rows.find((r) => r.kind === "write").reason, "Fix listing for ticket 42");
  assert.equal(eventsOf("TENANT_ADMIN_ACCESS", B._id).length, 1, "debounced");
  const log = await call("GET", "/tenants/me/access-log", { token: T.adminB });
  assert.equal(log.status, 200, JSON.stringify(log.data));
  assert.equal(log.data.data.length, 3);
  assert.equal(log.data.data[0].adminName, "Platform");
  const other = await call("GET", "/tenants/me/access-log", { token: T.adminA });
  assert.equal(other.data.data.length, 0);
});

/* ------------------------------------------------------------------ approval */

await check("createTenantFromApplication: active store, KYC copied, applicant -> tenant_admin, idempotent", async () => {
  const applicant = await User.create({ name: "New Seller", email: "new@p2s.test", passwordHash: "x", roleId: roles.buyer._id, status: "active", emailVerified: true });
  const application = {
    _id: new mongoose.Types.ObjectId(),
    userId: applicant._id,
    email: "new@p2s.test",
    phone: "9999999999",
    business: { legalName: "Fresh Foods Pvt Ltd", tradeName: "Fresh Foods", businessType: "private_limited", gstin: "07AABCA1234A1ZL", pan: "aabca1234a" },
    registeredAddress: { addressLine1: "1 Main Rd", city: "Delhi", state: "DL", postalCode: "110001" },
    pickupAddress: { addressLine1: "2 Godown Rd", city: "Delhi", state: "Delhi", postalCode: "110002" },
    bank: { holderName: "Fresh Foods", accountNumberEnc: "enc:xyz", accountLast4: "4321", accountHash: "hash-4321", ifsc: "hdfc0001234" },
    fssai: { number: "11111111111111", expiresAt: new Date(Date.now() + 200 * 86400000) },
    sellsFood: true,
    categories: [food._id],
    documents: [{ type: "gst_certificate", fileId: new mongoose.Types.ObjectId() }, { type: "fssai", fileId: new mongoose.Types.ObjectId() }],
    termsVersion: "2026-10",
    termsAcceptedAt: new Date(),
    termsAcceptedIp: "10.1.2.3",
  };
  const tenant = await createTenantFromApplication(application, { by: platform._id });
  assert.equal(tenant.status, "active");
  assert.equal(tenant.name, "Fresh Foods");
  assert.equal(tenant.kyc.pan, "AABCA1234A");
  assert.equal(tenant.kyc.bank.accountLast4, "4321");
  assert.equal(tenant.kyc.bank.ifsc, "HDFC0001234");
  assert.equal(tenant.kyc.fssai.number, "11111111111111");
  assert.ok(tenant.kyc.fssai.fileId, "fssai document linked");
  assert.equal(tenant.kyc.documents.length, 2);
  assert.equal(tenant.termsAcceptance[0].version, "2026-10");
  assert.equal(tenant.termsAcceptance[0].ip, "10.1.2.3");
  assert.equal(tenant.kyc.bank.accountHash, "hash-4321");
  assert.equal(tenant.statusHistory[0].to, "active");
  assert.equal(String(tenant.applicationId), String(application._id));
  const user = await User.findById(applicant._id).lean();
  assert.equal(String(user.tenantId), String(tenant._id));
  assert.equal(String(user.roleId), String(roles.tenant_admin._id));
  const again = await createTenantFromApplication(application, { by: platform._id });
  assert.equal(String(again._id), String(tenant._id));
  await tick();
  assert.equal(eventsOf("TENANT_APPROVED", tenant._id).length, 1);
  const me = await call("GET", "/tenants/me", { token: await tokenFor(applicant) });
  assert.equal(me.status, 200);
  assert.equal(me.data.identityLocked, true);
  assert.equal(me.data.kyc.bank.accountNumberEnc, undefined, "encrypted account number never returned");
  assert.equal(me.data.kyc.bank.accountHash, undefined, "account hash never returned");
  assert.equal(me.data.kyc.bank.hasAccountNumber, true);
});

await check("rbac: store staff cannot list, view or assign the seller_applicant role", async () => {
  const applicantRole = roles.seller_applicant;
  assert.ok(applicantRole, "seller_applicant system role seeded");
  for (const qs of ["?limit=100", "?limit=100&scope=staff", "?limit=100&scope=tenant"]) {
    const r = await call("GET", `/roles${qs}`, { token: T.adminA });
    assert.equal(r.status, 200);
    const slugs = r.data.data.map((x) => x.slug);
    assert.ok(slugs.includes("tenant_admin"), `staff sees system tenant roles (${qs})`);
    assert.ok(!slugs.includes("seller_applicant"), `seller_applicant hidden from staff (${qs})`);
  }
  assert.equal((await call("GET", `/roles/${applicantRole._id}`, { token: T.adminA })).status, 404);
  const all = await call("GET", "/roles?limit=100", { token: T.platform });
  assert.equal(all.status, 200);
  assert.ok(all.data.data.some((x) => x.slug === "seller_applicant"), "platform admin still sees it");
  const created = await call("POST", "/users", {
    token: T.adminA,
    json: { name: "Sneaky", email: "sneaky@p2s.test", password: "Passw0rd!x", roleId: String(applicantRole._id) },
  });
  assert.equal(created.status, 403);
  assert.equal(await User.countDocuments({ email: "sneaky@p2s.test" }), 0);
  const staff = await mkUser("Staff A", "staff-a@p2s.test", roles.support_agent, { tenantId: A._id });
  const patched = await call("PATCH", `/users/${staff._id}`, { token: T.adminA, json: { roleId: String(applicantRole._id) } });
  assert.equal(patched.status, 403);
  assert.equal(String((await User.findById(staff._id).lean()).roleId), String(roles.support_agent._id));
  await tick(); // let the audit middleware's async writes for the denied requests flush
});

await check("audit snapshots mask pan / bank / accountNumber / ifsc", async () => {
  const out = summarize({ kyc: { pan: "AABCA1234A", bank: { holderName: "Fresh Foods", accountNumber: "123456789012", ifsc: "HDFC0001234", accountNumberEnc: "enc" } }, accountNumber: "9876543210" });
  assert.equal(out.kyc.pan, "XXXX234A");
  assert.equal(out.kyc.bank.accountNumber, "XXXX9012");
  assert.equal(out.kyc.bank.ifsc, "XXXX1234");
  assert.equal(out.kyc.bank.accountNumberEnc, undefined);
  assert.equal(out.accountNumber, "XXXX3210");
});

/* ------------------------------------------------------------------ web-UI follow-ups */

await check("X-Admin-Reason: percent-encoded (non-Latin-1) reasons are decoded; invalid encoding kept raw", async () => {
  assert.equal(decodeAdminReason("100% sure"), "100% sure");
  assert.equal(decodeAdminReason(encodeURIComponent("सूची ठीक करें")), "सूची ठीक करें");
  assert.equal(decodeAdminReason("  plain reason  "), "plain reason");
  __resetAdminAccessDedupe();
  const reason = "सूची ठीक करें (ticket 7)";
  const w = await call("POST", "/products", {
    token: T.platform,
    headers: { "X-Tenant-Id": String(A._id), "X-Admin-Reason": encodeURIComponent(reason) },
    json: { name: "Encoded reason", sku: "ENC-1" },
  });
  assert.equal(w.status, 201, JSON.stringify(w.data));
  await tick(150);
  const row = await AdminAccessLog.findOne({ tenantId: A._id, kind: "write", path: "/api/v1/products" }).sort({ at: -1 }).lean();
  assert.equal(row.reason, reason);
  // Too short once decoded -> still REASON_REQUIRED.
  const short = await call("POST", "/products", { token: T.platform, headers: { "X-Tenant-Id": String(A._id), "X-Admin-Reason": "%E0%A4%B8" }, json: { name: "x", sku: "ENC-2" } });
  assert.equal(short.data.code, "REASON_REQUIRED");
});

await check("tenant admin views: statusHistory[].by resolved to { id, name, email }", async () => {
  const one = await call("GET", `/tenants/${B._id}`, { token: T.platform });
  assert.equal(one.status, 200);
  const h = one.data.statusHistory.find((x) => x.to === "paused");
  assert.equal(h.by.email, "pa@p2s.test");
  assert.equal(h.by.name, "Platform");
  assert.equal(String(h.by.id), String(platform._id));
  const list = await call("GET", "/tenants?limit=100", { token: T.platform });
  const row = list.data.data.find((t) => String(t.id) === String(B._id));
  assert.equal(row.statusHistory.find((x) => x.to === "paused").by.email, "pa@p2s.test");
  const st = await call("POST", `/tenants/${B._id}/status`, { token: T.platform, json: { status: "paused", reason: "Check who" } });
  assert.equal(st.data.statusHistory.at(-1).by.email, "pa@p2s.test");
  await call("POST", `/tenants/${B._id}/status`, { token: T.platform, json: { status: "active" } });
  // Seller-facing /tenants/me keeps the raw id.
  const mine = await call("GET", "/tenants/me", { token: T.adminB });
  assert.equal(typeof mine.data.statusHistory[0].by, "string");
});

await check("approval attaches applicant KYC files to the store; admin gets signed links (detail + /files link)", async () => {
  const applicant = await User.create({ name: "Doc Seller", email: "docs@p2s.test", passwordHash: "x", roleId: roles.buyer._id, status: "active", emailVerified: true });
  const mkFile = (purpose, uploadedBy = applicant._id) =>
    PrivateFile.create({ tenantId: null, uploadedBy, key: `kyc/${purpose}-${new mongoose.Types.ObjectId()}.png`, filename: `${purpose}.png`, originalName: `${purpose}.png`, mimeType: "image/png", size: 10, folder: "kyc", purpose });
  const gst = await mkFile("gst_certificate");
  const pan = await mkFile("pan_card");
  const stranger = await mkFile("other", platform._id);
  const tenant = await createTenantFromApplication(
    {
      _id: new mongoose.Types.ObjectId(),
      userId: applicant._id,
      email: "docs@p2s.test",
      business: { legalName: "Docs Traders", gstin: GSTIN, pan: "AAPFU0939F" },
      bank: { holderName: "Docs", accountLast4: "1111" },
      documents: [{ type: "gst_certificate", fileId: gst._id }, { type: "pan_card", fileId: pan._id }, { type: "other", fileId: stranger._id }],
    },
    { by: platform._id }
  );
  assert.equal(String((await PrivateFile.findById(gst._id).lean()).tenantId), String(tenant._id));
  assert.equal(String((await PrivateFile.findById(pan._id).lean()).tenantId), String(tenant._id));
  assert.equal((await PrivateFile.findById(stranger._id).lean()).tenantId, null, "only the applicant's own uploads move");
  const detail = await call("GET", `/tenants/${tenant._id}`, { token: T.platform });
  assert.equal(detail.status, 200);
  const gDoc = detail.data.kyc.documents.find((d) => d.type === "gst_certificate");
  assert.match(gDoc.url, /sig=/);
  assert.equal(gDoc.originalName, "gst_certificate.png");
  const link = await call("GET", `/files/private/${pan._id}/link`, { token: T.platform });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  assert.match(link.data.url, /sig=/);
  const sellerLink = await call("GET", `/files/private/${pan._id}/link`, { token: await tokenFor(applicant) });
  assert.equal(sellerLink.status, 200, "new store staff can open its KYC files");
  const otherStore = await call("GET", `/files/private/${pan._id}/link`, { token: T.adminA });
  assert.equal(otherStore.status, 404);
});

server.close();
await mongoose.disconnect();
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
