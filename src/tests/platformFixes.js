/**
 * Platform fixes (backend agent 2): users, tenants, roles/permissions, reviews moderation,
 * catalog (specs, export, scheduling, variant attrs, bulk dry-run), settings, notifications,
 * sockets, audit, CMS, error middleware and chat envelopes.
 *
 * Throwaway local DB only:
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_be2?replicaSet=rs0" node src/tests/platformFixes.js
 *
 * Mounts only the platform routers on a mini app (same middleware as app.js).
 */
import assert from "assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { PERMISSIONS } from "../config/constants.js";
import { requestId } from "../middleware/requestId.js";
import { notFound, errorHandler, describeDuplicate } from "../middleware/error.js";
import { signAccessToken } from "../utils/tokens.js";
import { setIo } from "../utils/io.js";
import { emitDomain } from "../utils/events.js";
import { ensureSystemRoles } from "../seeds/index.js";
import authRoutes from "../modules/auth/routes.js";
import userRoutes from "../modules/users/routes.js";
import tenantRoutes from "../modules/tenants/routes.js";
import auditRoutes from "../modules/audit/routes.js";
import chatRoutes from "../modules/chat/routes.js";
import notificationRoutes from "../modules/notifications/routes.js";
import settingsRoutes, { settingsPublicRouter } from "../modules/settings/routes.js";
import { roleRouter, permissionRouter } from "../modules/rbac/routes.js";
import { cmsPublicRouter, cmsAdminRouter } from "../modules/cms/routes.js";
import { productRouter, variantRouter, mediaRouter } from "../modules/catalog/routes.js";
import { publishScheduledProducts, __setInventoryApiForTests } from "../modules/catalog/service.js";
import { sendBroadcastEmails } from "../modules/notifications/service.js";
import { updatePreferences } from "../modules/notifications/preferences.js";
import { orderUpdatedMessage, registerOrderSocketForwarding } from "../sockets/index.js";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { Category } from "../modules/catalog/category.model.js";
import { Review } from "../modules/reviews/review.model.js";
import { AuditLog } from "../modules/audit/auditLog.model.js";
import { Notification } from "../modules/notifications/notification.model.js";
import { CmsPageVersion } from "../modules/cms/cmsPageVersion.model.js";

if (!/127\.0\.0\.1:27027\/msp_test_(be2|sf|sf2|sf3)(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_be2 database");
  process.exit(2);
}

await mongoose.connect(env.mongoUri);
await mongoose.connection.db.dropDatabase();
// init() may have run before the drop: (re)build every declared index explicitly.
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).createIndexes().catch(() => {})));

/* ------------------------------------------------------------------ app */

const app = express();
app.set("trust proxy", 1);
app.use(requestId);
app.use(express.json());
app.use(cookieParser());
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/roles", roleRouter);
app.use("/api/v1/permissions", permissionRouter);
app.use("/api/v1/tenants", tenantRoutes);
app.use("/api/v1/audit", auditRoutes);
app.use("/api/v1/products", productRouter);
app.use("/api/v1/variants", variantRouter);
app.use("/api/v1/media", mediaRouter);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/cms", cmsPublicRouter);
app.use("/api/v1/cms/admin", cmsAdminRouter);
app.use("/api/v1/settings", settingsPublicRouter);
app.use("/api/v1/settings", settingsRoutes);
app.use("/api/v1/chat", chatRoutes);
// Raw E11000 from a compound unique index ({ scope, tenantId, key }).
app.post("/dup", async (_req, res) => {
  await Settings.create({ scope: "tenant", tenantId: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"), key: "dup.key" });
  await Settings.create({ scope: "tenant", tenantId: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"), key: "dup.key" });
  res.json({});
});
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

let ip = 1;
async function call(method, url, { token, json, body, headers = {}, cookie } = {}) {
  const h = { "X-Forwarded-For": `10.9.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  if (json !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + "/api/v1" + url, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { tries = 40, ms = 50 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const v = await fn();
    if (v) return v;
    await sleep(ms);
  }
  return fn();
}

/* ------------------------------------------------------------------ fixtures */

const roles = await ensureSystemRoles();
const A = await Tenant.create({ name: "Alpha Store", slug: "alpha", status: "active" });
const B = await Tenant.create({ name: "Beta Store", slug: "beta", status: "active" });
const C = await Tenant.create({ name: "Gamma Store", slug: "gamma", status: "pending" });

async function mkUser(name, email, role, { tenantId = null, homeTenantId = null, emailVerified = true, password = null } = {}) {
  const user = await User.create({
    name,
    email,
    passwordHash: password ? await bcrypt.hash(password, 4) : "x",
    roleId: role._id,
    tenantId,
    homeTenantId,
    status: "active",
    emailVerified,
  });
  return user;
}
const tokenFor = async (user) => {
  const fresh = await User.findById(user._id).lean();
  return signAccessToken({ sub: String(fresh._id), tenantId: fresh.tenantId ? String(fresh.tenantId) : null, tv: fresh.tokenVersion || 0 });
};

const platform = await mkUser("Platform Admin", "pa@test.local", roles.super_admin);
const adminA = await mkUser("Admin A", "admin.a@test.local", roles.tenant_admin, { tenantId: A._id });
const agentA = await mkUser("Agent A", "agent.a@test.local", roles.support_agent, { tenantId: A._id });
const adminB = await mkUser("Admin B", "admin.b@test.local", roles.tenant_admin, { tenantId: B._id });
const agentB = await mkUser("Agent B", "agent.b@test.local", roles.support_agent, { tenantId: B._id });
const buyer1 = await mkUser("Zed Buyer", "buyer1@test.local", roles.buyer, { homeTenantId: A._id, emailVerified: true });
const buyer2 = await mkUser("Amy Buyer", "buyer2@test.local", roles.buyer, { homeTenantId: B._id, emailVerified: false });

const T = {
  platform: await tokenFor(platform),
  adminA: await tokenFor(adminA),
  agentA: await tokenFor(agentA),
  adminB: await tokenFor(adminB),
  agentB: await tokenFor(agentB),
  buyer1: await tokenFor(buyer1),
};

/* ------------------------------------------------------------------ 10. errors */

await check("zod: every failing field in `fields`, first one in `message`", async () => {
  const res = await call("POST", "/users", { token: T.adminA, json: { name: "x", email: "bad", password: "1" } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, "VALIDATION_ERROR");
  for (const f of ["name", "email", "password", "roleId"]) assert.ok(res.data.fields[f], `missing ${f}: ${JSON.stringify(res.data)}`);
  assert.match(res.data.message, /^(name|email|password|roleId): /);
});

await check("E11000 on a compound index names the meaningful field (409 DUPLICATE)", async () => {
  // the /dup route is outside /api/v1
  const raw = await fetch(base + "/dup", { method: "POST" });
  const data = await raw.json();
  assert.equal(raw.status, 409);
  assert.equal(data.code, "DUPLICATE");
  assert.ok(data.fields.key, JSON.stringify(data));
  assert.ok(!("tenantId" in data.fields));
  assert.match(data.message, /^Key is already in use/);
  let err;
  try {
    await Role.create({ name: "X", slug: "tenant_admin", tenantId: null, isSystem: true });
  } catch (e) {
    err = e;
  }
  const d = describeDuplicate(err);
  assert.equal(d.field, "slug");
});

/* ------------------------------------------------------------------ 1. users */

await check("users: emailVerified / staff / homeTenantId filters, sort, homeTenant populated", async () => {
  const unverified = await call("GET", "/users?emailVerified=false", { token: T.platform });
  assert.equal(unverified.status, 200);
  const emails = unverified.data.data.map((u) => u.email);
  assert.ok(emails.includes("buyer2@test.local") && !emails.includes("buyer1@test.local"), JSON.stringify(emails));

  const buyers = await call("GET", "/users?staff=false&sort=name&order=asc", { token: T.platform });
  assert.deepEqual(buyers.data.data.map((u) => u.email), ["buyer2@test.local", "buyer1@test.local"]);
  const zed = buyers.data.data.find((u) => u.email === "buyer1@test.local");
  assert.equal(zed.homeTenant.name, "Alpha Store");
  assert.equal(String(zed.homeTenantId), String(A._id));

  const staff = await call("GET", "/users?staff=true", { token: T.platform });
  assert.ok(staff.data.data.every((u) => u.role.slug !== "buyer"));

  const home = await call("GET", `/users?homeTenantId=${A._id}`, { token: T.platform });
  assert.deepEqual(home.data.data.map((u) => u.email), ["buyer1@test.local"]);

  const byRole = await call("GET", `/users?roleId=${roles.support_agent._id}&sort=email&order=desc`, { token: T.platform });
  assert.deepEqual(byRole.data.data.map((u) => u.email), ["agent.b@test.local", "agent.a@test.local"]);

  const bad = await call("GET", "/users?sort=passwordHash", { token: T.platform });
  assert.equal(bad.status, 400);
  const badDate = await call("GET", "/users?from=notadate", { token: T.platform });
  assert.equal(badDate.status, 400);
});

await check("users: sign-out-everywhere (tenant admin own staff, platform anyone) + audited", async () => {
  const forbidden = await call("POST", `/users/${adminA._id}/sign-out-everywhere`, { token: T.agentA });
  assert.equal(forbidden.status, 403);
  const otherStore = await call("POST", `/users/${agentB._id}/sign-out-everywhere`, { token: T.adminA });
  assert.equal(otherStore.status, 404);
  const buyer = await call("POST", `/users/${buyer1._id}/sign-out-everywhere`, { token: T.adminA });
  assert.equal(buyer.status, 404);

  const ok = await call("POST", `/users/${agentA._id}/sign-out-everywhere`, { token: T.adminA });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.ok, true);
  const revoked = await call("GET", "/auth/me", { token: T.agentA });
  assert.equal(revoked.status, 401);
  assert.equal(revoked.data.code, "TOKEN_REVOKED");
  T.agentA = await tokenFor(agentA);

  const byPlatform = await call("POST", `/users/${buyer1._id}/sign-out-everywhere`, { token: T.platform });
  assert.equal(byPlatform.status, 200);
  T.buyer1 = await tokenFor(buyer1);

  const entry = await waitFor(() => AuditLog.findOne({ action: "sign_out_everywhere", resourceId: String(agentA._id) }).lean());
  assert.ok(entry, "audit entry");
  assert.equal(String(entry.actorId), String(adminA._id));
  assert.equal(entry.outcome, "success");
  assert.equal(entry.before.name, "Agent A");
  assert.ok(!("passwordHash" in entry.before) && !("tokenVersion" in entry.before));
});

/* ------------------------------------------------------------------ 2. tenants */

await check("tenants: sort / q / status + staffCount", async () => {
  const sorted = await call("GET", "/tenants?sort=name&order=asc", { token: T.platform });
  assert.equal(sorted.status, 200);
  assert.deepEqual(sorted.data.data.map((t) => t.name), ["Alpha Store", "Beta Store", "Gamma Store"]);
  assert.equal(sorted.data.data[0].staffCount, 2);
  assert.equal(sorted.data.data[2].staffCount, 0);
  const q = await call("GET", "/tenants?q=beta", { token: T.platform });
  assert.deepEqual(q.data.data.map((t) => t.slug), ["beta"]);
  const st = await call("GET", "/tenants?status=pending,suspended", { token: T.platform });
  assert.deepEqual(st.data.data.map((t) => t.slug), ["gamma"]);
  assert.equal((await call("GET", "/tenants?sort=bogus", { token: T.platform })).status, 400);
  assert.equal((await call("GET", "/tenants", { token: T.adminA })).status, 403);
});

/* ------------------------------------------------------------------ 3. roles & permissions */

await check("roles: no buyer role for staff, scope filter, usersCount", async () => {
  const mine = await call("GET", "/roles?limit=100", { token: T.adminA });
  assert.equal(mine.status, 200);
  const slugs = mine.data.data.map((r) => r.slug);
  assert.ok(!slugs.includes("buyer") && !slugs.includes("super_admin"), JSON.stringify(slugs));
  const agentRole = mine.data.data.find((r) => r.slug === "support_agent");
  assert.equal(agentRole.usersCount, 1, "holders counted within the store only");
  assert.equal((await call("GET", `/roles/${roles.buyer._id}`, { token: T.adminA })).status, 404);

  const buyerOnly = await call("GET", "/roles?scope=buyer", { token: T.platform });
  assert.deepEqual(buyerOnly.data.data.map((r) => r.slug), ["buyer"]);
  assert.equal(buyerOnly.data.data[0].usersCount, 2);
  const staffScope = await call("GET", "/roles?scope=staff&limit=100", { token: T.platform });
  assert.ok(!staffScope.data.data.some((r) => r.slug === "buyer"));
  const all = await call("GET", "/roles?limit=100", { token: T.platform });
  assert.equal(all.data.data.find((r) => r.slug === "support_agent").usersCount, 2);
  assert.equal((await call("GET", "/roles?scope=nope", { token: T.platform })).status, 400);
});

await check("permissions: human-readable label/description/group for every key", async () => {
  const res = await call("GET", "/permissions", { token: T.platform });
  assert.equal(res.status, 200);
  assert.equal(res.data.length, PERMISSIONS.length);
  for (const p of res.data) {
    assert.ok(p.description && p.description !== p.key, `description for ${p.key}`);
    assert.ok(p.label && p.group && p.group !== "Other", `label/group for ${p.key}`);
  }
  const tenant = await call("GET", "/permissions", { token: T.adminA });
  assert.ok(!tenant.data.some((p) => p.key.startsWith("tenants.")));
});

/* ------------------------------------------------------------------ 4. reviews */

const reviewProduct = await Product.create({ tenantId: A._id, name: "Assam Gold Tea", sku: "TEA-REV", status: "published" });
await Review.create([
  { productId: reviewProduct._id, tenantId: A._id, userId: buyer1._id, authorName: "Zed", rating: 5, body: "great tea" },
  { productId: reviewProduct._id, tenantId: A._id, userId: buyer2._id, authorName: "Amy", rating: 2, body: "meh" },
]);
const otherProduct = await Product.create({ tenantId: B._id, name: "Beta Rice", sku: "RICE-REV", status: "published" });
await Review.create({ productId: otherProduct._id, tenantId: B._id, userId: buyer1._id, authorName: "Zed", rating: 4, body: "ok rice" });

await check("reviews manage: tenant/buyer/product/moderation, q, rating, sort, pagination", async () => {
  const res = await call("GET", "/products/reviews/manage", { token: T.adminA });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.meta.total, 2);
  const row = res.data.data.find((r) => r.rating === 5);
  assert.equal(row.tenant.name, "Alpha Store");
  assert.equal(row.buyer.email, "buyer1@test.local");
  assert.equal(row.buyer.name, "Zed Buyer");
  assert.equal(row.product.slug, reviewProduct.slug);
  assert.equal(row.product.name, "Assam Gold Tea");
  assert.equal(row.moderation.status, "published");

  assert.equal((await call("GET", "/products/reviews/manage?rating=2", { token: T.adminA })).data.meta.total, 1);
  assert.equal((await call("GET", "/products/reviews/manage?q=great", { token: T.adminA })).data.meta.total, 1);
  assert.equal((await call("GET", "/products/reviews/manage?q=buyer2@test", { token: T.adminA })).data.meta.total, 1);
  assert.equal((await call("GET", "/products/reviews/manage?q=Assam", { token: T.adminA })).data.meta.total, 2);
  const asc = await call("GET", "/products/reviews/manage?sort=rating&order=asc&limit=1&page=1", { token: T.adminA });
  assert.equal(asc.data.data[0].rating, 2);
  assert.equal(asc.data.meta.pages, 2);
  assert.equal((await call("GET", "/products/reviews/manage?rating=9", { token: T.adminA })).status, 400);

  const mod = await call("PATCH", `/products/reviews/${row.id}`, { token: T.adminA, json: { status: "hidden", note: "spam" } });
  assert.equal(mod.status, 200);
  const after = await call("GET", "/products/reviews/manage?status=hidden", { token: T.adminA });
  assert.equal(after.data.data[0].moderation.moderatedBy.name, "Admin A");
  assert.equal(after.data.data[0].moderation.note, "spam");
  const platformView = await call("GET", "/products/reviews/manage", { token: T.platform });
  assert.equal(platformView.data.meta.total, 3);
});

/* ------------------------------------------------------------------ 5. catalog */

await Settings.create({ scope: "platform", tenantId: null, key: "platform.defaultTaxRate", value: 12 });
const publisherRole = await Role.create({
  name: "Publisher",
  slug: "publisher",
  tenantId: A._id,
  permissions: ["products.view", "products.create", "products.edit", "products.publish"],
});
const editorRole = await Role.create({
  name: "Editor",
  slug: "editor",
  tenantId: A._id,
  permissions: ["products.view", "products.create", "products.edit"],
});
const publisher = await mkUser("Pub", "pub@test.local", publisherRole, { tenantId: A._id });
const editor = await mkUser("Ed", "ed@test.local", editorRole, { tenantId: A._id });
T.publisher = await tokenFor(publisher);
T.editor = await tokenFor(editor);
const teaCat = await Category.create({ tenantId: A._id, name: "Tea", slug: "tea-a" });
const stockCalls = [];
__setInventoryApiForTests({
  setAvailableQty: async (args) => {
    stockCalls.push(args);
    return { ok: true };
  },
  deleteVariantInventory: async () => ({ ok: true }),
  syncInventorySku: async () => ({ ok: true }),
});

let specProduct;
await check("catalog: specifications accept seed shapes; default tax rate falls back to platform", async () => {
  const res = await call("POST", "/products", {
    token: T.adminA,
    json: {
      name: "Masala Chai",
      sku: "chai-1",
      sellingPrice: 100,
      categoryId: String(teaCat._id),
      specifications: {
        features: ["Strong aroma", "Sealed pack"],
        ingredients: "Tea leaves",
        nutrition: { energy: "0 kcal", sugar: null },
        table: [{ label: "Origin", value: "Assam" }],
        shelfLifeDays: 365,
      },
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  specProduct = res.data;
  assert.deepEqual(specProduct.specifications.features, ["Strong aroma", "Sealed pack"]);
  assert.equal(specProduct.taxClass.rate, 12);

  const rows = await call("PATCH", `/products/${specProduct._id}`, {
    token: T.adminA,
    json: { specifications: [{ label: "Origin", value: "Darjeeling" }, { key: "grade", value: "FTGFOP" }] },
  });
  assert.equal(rows.status, 200, JSON.stringify(rows.data));
  assert.deepEqual(rows.data.specifications, { Origin: "Darjeeling", grade: "FTGFOP" });

  const nested = await call("PATCH", `/products/${specProduct._id}`, { token: T.adminA, json: { specifications: { a: { b: { c: 1 } } } } });
  assert.equal(nested.status, 400);
  assert.ok(Object.keys(nested.data.fields).some((k) => k.startsWith("specifications")));
});

await check("catalog: scheduling needs products.publish + future scheduledAt", async () => {
  const id = specProduct._id;
  assert.equal((await call("PATCH", `/products/${id}`, { token: T.editor, json: { status: "scheduled", scheduledAt: new Date(Date.now() + 3600e3).toISOString() } })).status, 403);
  const missing = await call("PATCH", `/products/${id}`, { token: T.adminA, json: { status: "scheduled" } });
  assert.equal(missing.status, 400);
  assert.ok(missing.data.fields.scheduledAt);
  const past = await call("PATCH", `/products/${id}`, { token: T.adminA, json: { status: "scheduled", scheduledAt: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(past.status, 400);
  const ok = await call("PATCH", `/products/${id}`, { token: T.adminA, json: { status: "scheduled", scheduledAt: new Date(Date.now() + 3600e3).toISOString() } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, "scheduled");
  assert.equal(String(ok.data.scheduledBy), String(adminA._id));
  // An editor cannot move the publish time of a scheduled product.
  assert.equal((await call("PATCH", `/products/${id}`, { token: T.editor, json: { scheduledAt: new Date(Date.now() + 7200e3).toISOString() } })).status, 403);
  // Back to draft clears the schedule.
  const draft = await call("PATCH", `/products/${id}`, { token: T.adminA, json: { status: "draft" } });
  assert.equal(draft.data.status, "draft");
  assert.equal(draft.data.scheduledAt, null);
});

await check("catalog: scheduler re-checks products.publish of whoever scheduled", async () => {
  const future = new Date(Date.now() + 3600e3).toISOString();
  const okP = await call("POST", "/products", { token: T.publisher, json: { name: "Sched OK", sku: "sch-ok", sellingPrice: 5, status: "scheduled", scheduledAt: future } });
  const revokedP = await call("POST", "/products", { token: T.publisher, json: { name: "Sched Revoked", sku: "sch-rev", sellingPrice: 5, status: "scheduled", scheduledAt: future } });
  assert.equal(okP.status, 201, JSON.stringify(okP.data));
  assert.equal(revokedP.data.status, "scheduled");
  await Product.updateMany({ _id: { $in: [okP.data._id, revokedP.data._id] } }, { $set: { scheduledAt: new Date(Date.now() - 1000) } });
  await Product.updateOne({ _id: okP.data._id }, { $set: { scheduledBy: adminA._id } });
  await Role.updateOne({ _id: publisherRole._id }, { $pull: { permissions: "products.publish" } });
  const result = await publishScheduledProducts();
  assert.deepEqual(result, { published: 1, rejected: 1 });
  const [a, b] = await Promise.all([Product.findById(okP.data._id).lean(), Product.findById(revokedP.data._id).lean()]);
  assert.equal(a.status, "published");
  assert.equal(b.status, "draft");
  assert.match(b.scheduleError, /products\.publish/);
  assert.deepEqual(await publishScheduledProducts(), { published: 0, rejected: 0 });
});

await check("catalog: export honours q / categoryId / brandId / status", async () => {
  await call("POST", "/products", { token: T.adminA, json: { name: "Arabica Coffee", sku: "cof-1", sellingPrice: 300 } });
  const csvRows = async (qs) => {
    const res = await fetch(`${base}/api/v1/products/export${qs}`, { headers: { Authorization: `Bearer ${T.adminA}` } });
    assert.equal(res.status, 200);
    return (await res.text()).trim().split("\n").slice(1).map((l) => l.split(",")[0]);
  };
  assert.deepEqual(await csvRows("?q=coffee"), ["COF-1"]);
  assert.deepEqual(await csvRows(`?categoryId=${teaCat._id}`), ["CHAI-1"]);
  assert.deepEqual(await csvRows("?status=published&q=sched"), ["SCH-OK"]);
  assert.deepEqual(await csvRows(`?brandId=${new mongoose.Types.ObjectId()}`), []);
  const bad = await fetch(`${base}/api/v1/products/export?categoryId=nope`, { headers: { Authorization: `Bearer ${T.adminA}` } });
  assert.equal(bad.status, 400);
});

await check("catalog: variant custom attributes can be cleared with an empty object", async () => {
  const created = await call("POST", "/variants", {
    token: T.adminA,
    json: { productId: specProduct._id, sku: "chai-1-mint", listPrice: 10, sellingPrice: 9, attributes: { flavor: "mint", custom: { strength: "high" } } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual(created.data.attributes.custom, { strength: "high", flavor: "mint" });
  const cleared = await call("PATCH", `/variants/${created.data._id}`, { token: T.adminA, json: { attributes: { custom: {} } } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.data));
  assert.equal(cleared.data.attributes.custom, undefined);
  const replaced = await call("PATCH", `/variants/${created.data._id}`, { token: T.adminA, json: { attributes: { custom: { size: "x" }, color: "red" } } });
  assert.deepEqual(replaced.data.attributes.custom, { size: "x" });
  assert.equal(replaced.data.attributes.color, "red");
});

await check("catalog: bulk import dryRun reports per row and writes nothing; availableQtyMode", async () => {
  const before = await Product.countDocuments();
  const items = [
    { name: "New One", sku: "new-1", sellingPrice: 10, availableQty: 5 },
    { name: "Masala Chai v2", sku: "CHAI-1", sellingPrice: 120 },
    { sku: "bad-1", sellingPrice: 10 },
    { name: "Dup", sku: "new-1", sellingPrice: 10 },
    { name: "Bad cat", sku: "cat-1", sellingPrice: 10, categoryId: String(new mongoose.Types.ObjectId()) },
    { name: "Sched", sku: "sch-2", sellingPrice: 10, status: "scheduled" },
  ];
  const dry = await call("POST", "/products/bulk-upload?dryRun=true", { token: T.adminA, json: { items } });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.dryRun, true);
  assert.deepEqual(dry.data.summary, { total: 6, valid: 2, invalid: 4, create: 1, update: 1 });
  assert.equal(dry.data.rows[0].action, "create");
  assert.deepEqual(dry.data.rows[0].stock, { mode: "set", qty: 5 });
  assert.equal(dry.data.rows[1].action, "update");
  assert.ok(dry.data.rows[2].errors.name);
  assert.match(dry.data.rows[3].errors.sku, /Duplicate SKU in file/);
  assert.ok(dry.data.rows[4].errors.categoryId);
  assert.ok(dry.data.rows[5].errors.scheduledAt);
  assert.equal(await Product.countDocuments(), before);
  assert.equal(stockCalls.length, 0);

  const skip = await call("POST", "/products/bulk-upload?availableQtyMode=skip", { token: T.adminA, json: { items: [items[0]] } });
  assert.equal(skip.status, 201, JSON.stringify(skip.data));
  assert.equal(skip.data.created.length, 1);
  assert.equal(stockCalls.length, 0, "skip mode never touches stock");
  const set = await call("POST", "/products/bulk-upload", { token: T.adminA, json: { items: [{ ...items[0], availableQty: 7 }] } });
  assert.equal(set.data.updated.length, 1);
  assert.equal(stockCalls.length, 1);
  assert.equal(stockCalls[0].qty, 7, "availableQty is absolute (set)");
  assert.equal((await call("POST", "/products/bulk-upload?availableQtyMode=add", { token: T.adminA, json: { items } })).status, 400);
});

await check("media: seed folder 'products' is whitelisted", async () => {
  const res = await call("GET", "/media?folder=products", { token: T.adminA });
  assert.equal(res.status, 200, JSON.stringify(res.data));
});

/* ------------------------------------------------------------------ 6. settings */

await check("settings: /keys metadata", async () => {
  const res = await call("GET", "/settings/keys", { token: T.platform });
  assert.equal(res.status, 200);
  assert.ok(res.data.keys.includes("platform.name"));
  const name = res.data.definitions.find((d) => d.key === "platform.name");
  assert.equal(name.type, "string");
  assert.ok(name.label && name.description && name.group);
  assert.equal(name.max, 100);
  assert.equal(name.secret, false);
  const tax = res.data.definitions.find((d) => d.key === "platform.defaultTaxRate");
  assert.deepEqual([tax.min, tax.max, tax.default], [0, 28, 18]);
  const maps = res.data.definitions.find((d) => d.key === "platform.mapsProvider");
  assert.deepEqual(maps.enum, ["stub", "google"]);
  const fee = res.data.definitions.find((d) => d.key === "platform.feeAmount");
  assert.deepEqual(fee.scopes, ["platform", "tenant"]);
  assert.equal(fee.overridable, true);
  const tenantKeys = await call("GET", "/settings/keys", { token: T.adminA });
  assert.equal(tenantKeys.data.scope, "tenant");
  assert.ok(tenantKeys.data.definitions.some((d) => d.key === "store.displayName"));
});

await check("settings: DELETE tenant override falls back to the platform default", async () => {
  await call("PUT", "/settings/platform.feeAmount", { token: T.platform, json: { value: 15 } });
  const put = await call("PUT", "/settings/platform.feeAmount", { token: T.adminA, json: { value: 25 } });
  assert.equal(put.status, 200);
  assert.equal((await call("GET", "/settings/commerce", { token: T.adminA })).data.feeAmount, 25);
  assert.equal((await call("DELETE", "/settings/platform.feeAmount", { token: T.agentA })).status, 403);
  const del = await call("DELETE", "/settings/platform.feeAmount?scope=tenant", { token: T.adminA });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(del.data.removed, true);
  assert.equal(del.data.previous, 25);
  assert.equal(del.data.effective, 15);
  assert.equal((await call("GET", "/settings/commerce", { token: T.adminA })).data.feeAmount, 15);

  await call("PUT", "/settings/payments.codEnabled", { token: T.adminB, json: { value: false } });
  const byPlatform = await call("DELETE", `/settings/payments.codEnabled?scope=tenant&tenantId=${B._id}`, { token: T.platform });
  assert.equal(byPlatform.data.removed, true);
  assert.equal(await Settings.countDocuments({ scope: "tenant", tenantId: B._id, key: "payments.codEnabled" }), 0);
  assert.equal((await call("DELETE", "/settings/payments.codEnabled?scope=tenant", { token: T.platform })).status, 400);
  assert.equal((await call("DELETE", "/settings/platform.name?scope=tenant", { token: T.adminA })).status, 404);
  assert.equal((await call("DELETE", "/settings/platform.feeAmount?scope=platform", { token: T.platform })).status, 400);
  const audited = await waitFor(() => AuditLog.findOne({ action: "delete_override", outcome: "success", tenantId: A._id }).lean());
  assert.equal(audited.before.value, 25);
});

await check("settings: public endpoint exposes support email, currency, maps provider, store display name", async () => {
  assert.equal((await call("PUT", "/settings/platform.supportEmail", { token: T.platform, json: { value: "help@msp.test" } })).status, 200);
  assert.equal((await call("PUT", "/settings/store.displayName", { token: T.adminA, json: { value: "Alpha Mart" } })).status, 200);
  const pub = await call("GET", "/settings/public?tenantSlug=alpha");
  assert.equal(pub.status, 200);
  assert.equal(pub.data.supportEmail, "help@msp.test");
  assert.equal(pub.data.currency, "INR");
  assert.ok(["stub", "google"].includes(pub.data.mapsProvider));
  assert.equal(pub.data.store.displayName, "Alpha Mart");
  assert.equal(pub.data.store.name, "Alpha Store");
  const none = await call("GET", "/settings/public");
  assert.equal(none.data.store, null);
  const store = await call("GET", "/tenants/public/alpha");
  assert.equal(store.status, 200);
  assert.equal(store.data.displayName, "Alpha Mart");
  assert.equal((await call("GET", "/tenants/public/gamma")).status, 404, "pending store hidden");
});

/* ------------------------------------------------------------------ 7. notifications */

await check("notifications: X-Tenant-Id never leaks into the audience; role announcement reaches every store", async () => {
  const res = await call("POST", "/notifications", {
    token: T.platform,
    headers: { "X-Tenant-Id": String(A._id) },
    json: { title: "Agents update", audienceType: "role", roleSlug: "support_agent" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.tenantId, null);
  const allRes = await call("POST", "/notifications", {
    token: T.platform,
    headers: { "X-Tenant-Id": String(A._id) },
    json: { title: "Hello everyone", audienceType: "all" },
  });
  assert.equal(allRes.data.tenantId, null);
  const has = async (token, title) => (await call("GET", "/notifications", { token })).data.data.some((n) => n.title === title);
  assert.equal(await has(T.agentA, "Agents update"), true);
  assert.equal(await has(T.agentB, "Agents update"), true);
  assert.equal(await has(T.adminA, "Agents update"), false);
  assert.equal(await has(T.buyer1, "Hello everyone"), true);

  const scoped = await call("POST", "/notifications", { token: T.adminA, json: { title: "Agents of Alpha", audienceType: "role", roleSlug: "support_agent" } });
  assert.equal(String(scoped.data.tenantId), String(A._id));
  assert.equal(await has(T.agentA, "Agents of Alpha"), true);
  assert.equal(await has(T.agentB, "Agents of Alpha"), false);
});

await check("notifications: /sent with a tenant filter includes 'all' announcements, marked", async () => {
  await call("POST", "/notifications", { token: T.adminA, json: { title: "Store news", audienceType: "staff" } });
  const sent = await call("GET", `/notifications/sent?tenantId=${A._id}`, { token: T.platform });
  assert.equal(sent.status, 200);
  const titles = sent.data.data.map((n) => n.title);
  assert.ok(titles.includes("Store news") && titles.includes("Hello everyone"), JSON.stringify(titles));
  assert.ok(!titles.includes("Agents update"));
  assert.equal(sent.data.data.find((n) => n.title === "Hello everyone").global, true);
  assert.equal(sent.data.data.find((n) => n.title === "Hello everyone").scope, "all");
  assert.equal(sent.data.data.find((n) => n.title === "Store news").global, false);
  const noGlobal = await call("GET", `/notifications/sent?tenantId=${A._id}&includeGlobal=false`, { token: T.platform });
  assert.ok(!noGlobal.data.data.some((n) => n.title === "Hello everyone"));
  const staffView = await call("GET", "/notifications/sent", { token: T.adminA });
  assert.ok(!staffView.data.data.some((n) => n.title === "Hello everyone"));
  const audited = await waitFor(async () => (await AuditLog.countDocuments({ action: "announce", resource: "notification" })) >= 4);
  assert.ok(audited);
});

await check("notifications: broadcast channels.email is sent in batches, honouring preferences", async () => {
  await updatePreferences(agentA._id, { marketing: { email: false } });
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    lines.push(args.join(" "));
  };
  let stats;
  try {
    const res = await call("POST", "/notifications", { token: T.platform, json: { title: "Staff mail", audienceType: "staff", tenantId: String(A._id), channels: { email: true } } });
    assert.equal(res.status, 201);
    const doc = await waitFor(async () => {
      const d = await Notification.findById(res.data._id).lean();
      return d?.emailDelivery?.status === "done" ? d : null;
    }, { tries: 80 });
    stats = doc?.emailDelivery;
    // Re-running never sends twice.
    assert.equal(await sendBroadcastEmails(res.data._id, { pauseMs: 0 }), null);
  } finally {
    console.log = orig;
  }
  assert.ok(stats, "delivery finished");
  assert.equal(stats.recipients, 4, JSON.stringify(stats)); // active members of A: adminA, agentA, publisher, editor
  const mailed = lines.filter((l) => l.startsWith("Email to ")).map((l) => l.split(":")[0].slice(9));
  assert.ok(mailed.includes("admin.a@test.local"), JSON.stringify(mailed));
  assert.ok(!mailed.includes("agent.a@test.local"), "unsubscribed from marketing email");
  assert.ok(lines.some((l) => l.includes("Need help? Contact us at help@msp.test")), "support email footer");
});

await check("sockets: ORDER_UPDATED → order:updated to tenant, buyer and platform rooms", async () => {
  const msg = orderUpdatedMessage({ order: { _id: "6500000000000000000000aa", tenantId: A._id, buyerId: buyer1._id, status: "shipped", orderNumber: "O-1" } });
  assert.equal(msg.event, "order:updated");
  assert.deepEqual(msg.rooms.sort(), [`platform:admins`, `tenant:${A._id}`, `user:${buyer1._id}`].sort());
  assert.equal(msg.data.order.status, "shipped");
  const captured = [];
  setIo({ to: (rooms) => ({ emit: (event, data) => captured.push({ rooms, event, data }) }) });
  registerOrderSocketForwarding();
  registerOrderSocketForwarding(); // idempotent
  emitDomain("ORDER_UPDATED", { order: { _id: "6500000000000000000000ab", tenantId: B._id, buyerId: buyer2._id, status: "confirmed" } });
  setIo(null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, "order:updated");
  assert.ok(captured[0].rooms.includes(`tenant:${B._id}`) && captured[0].rooms.includes(`user:${buyer2._id}`));
});

/* ------------------------------------------------------------------ 8. audit */

await check("audit: before = previous document; failures recorded with outcome; GET /audit/:id; filters", async () => {
  const ok = await call("PATCH", `/users/${agentA._id}`, { token: T.adminA, json: { name: "Agent Alpha" } });
  assert.equal(ok.status, 200);
  const entry = await waitFor(() => AuditLog.findOne({ action: "update", resource: "user", resourceId: String(agentA._id), outcome: "success" }).lean());
  assert.equal(entry.before.name, "Agent A");
  assert.equal(entry.after.name, "Agent Alpha");
  assert.ok(!("passwordHash" in entry.before));

  const bad = await call("PATCH", `/users/${agentA._id}`, { token: T.adminA, json: { status: "bogus" } });
  assert.equal(bad.status, 400);
  const failed = await waitFor(() => AuditLog.findOne({ action: "update", resourceId: String(agentA._id), outcome: "failure" }).lean());
  assert.equal(failed.error.code, "VALIDATION_ERROR");
  assert.equal(failed.before, null);
  assert.equal(failed.metadata.statusCode, 400);

  const forbidden = await call("PATCH", `/users/${adminA._id}`, { token: T.agentA, json: { name: "Hacker" } });
  assert.equal(forbidden.status, 403);
  await waitFor(() => AuditLog.findOne({ resourceId: String(adminA._id), outcome: "failure", "error.code": "FORBIDDEN" }).lean());

  const one = await call("GET", `/audit/${entry._id}`, { token: T.adminA });
  assert.equal(one.status, 200);
  assert.equal(one.data.actorId.email, "admin.a@test.local");
  assert.equal((await call("GET", `/audit/${entry._id}`, { token: T.adminB })).status, 404);
  assert.equal((await call("GET", "/audit/nope", { token: T.adminA })).status, 400);

  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // business day (IST)
  const filtered = await call("GET", `/audit?outcome=failure&action=update&method=PATCH&resourceId=${agentA._id}&from=${today}&to=${today}`, { token: T.adminA });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.meta.total, 1);
  const successes = await call("GET", `/audit?outcome=success&actorId=${adminA._id}&resource=user`, { token: T.adminA });
  assert.ok(successes.data.data.every((r) => r.outcome === "success"));
  assert.equal((await call("GET", `/audit?requestId=${failed.requestId}`, { token: T.adminA })).data.meta.total, 1);
  assert.equal((await call("GET", "/audit?outcome=maybe", { token: T.adminA })).status, 400);
});

await check("audit: login / logout record the actor (success and failure)", async () => {
  const loginUser = await mkUser("Login User", "login@test.local", roles.buyer, { password: "Secret123!" });
  const wrong = await call("POST", "/auth/login", { json: { email: "login@test.local", password: "nope-nope" } });
  assert.equal(wrong.status, 401);
  const failure = await waitFor(() => AuditLog.findOne({ action: "login", outcome: "failure" }).lean());
  assert.equal(String(failure.actorId), String(loginUser._id));
  assert.ok(!JSON.stringify(failure).includes("nope-nope"), "password never stored");

  const ok = await call("POST", "/auth/login", { json: { email: "login@test.local", password: "Secret123!" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const success = await waitFor(() => AuditLog.findOne({ action: "login", outcome: "success" }).lean());
  assert.equal(String(success.actorId), String(loginUser._id));
  assert.ok(!JSON.stringify(success.after || {}).includes(ok.data.accessToken), "token never stored");

  const cookie = (ok.headers.get("set-cookie") || "").split(";")[0];
  const out = await call("POST", "/auth/logout", { cookie, json: {} });
  assert.equal(out.status, 200);
  const logout = await waitFor(() => AuditLog.findOne({ action: "logout" }).lean());
  assert.equal(String(logout.actorId), String(loginUser._id));
});

/* ------------------------------------------------------------------ 9. CMS */

await check("cms: If-Match / expectedVersion, no-op PATCH, transitions create versions", async () => {
  const created = await call("POST", "/cms/admin", { token: T.adminA, json: { title: "About", slug: "about" } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data._id;
  assert.equal(created.data.version, 0);

  const stale = await call("PATCH", `/cms/admin/${id}`, { token: T.adminA, headers: { "If-Match": '"5"' }, json: { title: "About us" } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "CONFLICT");
  assert.equal(stale.data.currentVersion, 0);
  const edited = await call("PATCH", `/cms/admin/${id}`, { token: T.adminA, headers: { "If-Match": "0" }, json: { title: "About us" } });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.version, 1);
  const noop = await call("PATCH", `/cms/admin/${id}`, { token: T.adminA, json: { title: "About us", expectedVersion: 1 } });
  assert.equal(noop.status, 200);
  assert.equal(noop.data.version, 1);
  assert.equal((await call("PATCH", `/cms/admin/${id}`, { token: T.adminA, json: { title: "X", expectedVersion: 0 } })).status, 409);

  const review = await call("POST", `/cms/admin/${id}/review`, { token: T.adminA, json: {} });
  assert.equal(review.data.version, 2);
  const pub = await call("POST", `/cms/admin/${id}/publish`, { token: T.adminA, json: { expectedVersion: 2 } });
  assert.equal(pub.status, 200, JSON.stringify(pub.data));
  assert.equal(pub.data.status, "published");
  assert.equal(pub.data.version, 3);
  const versions = await call("GET", `/cms/admin/${id}/versions`, { token: T.adminA });
  assert.deepEqual(versions.data.map((v) => v.action), ["publish", "review", "edit"]);
  assert.equal(await CmsPageVersion.countDocuments({ pageId: id }), 3);

  const sched = await call("POST", `/cms/admin/${id}/schedule`, { token: T.adminA, json: { scheduledAt: new Date(Date.now() + 3600e3).toISOString() } });
  assert.equal(sched.status, 409);
  assert.match(sched.data.message, /published page cannot be scheduled/);
  const unpub = await call("POST", `/cms/admin/${id}/unpublish`, { token: T.adminA, json: {} });
  assert.equal(unpub.data.status, "unpublished");
  const patchSched = await call("PATCH", `/cms/admin/${id}`, { token: T.adminA, json: { scheduledAt: new Date(Date.now() + 3600e3).toISOString() } });
  assert.equal(patchSched.status, 409);
  await call("POST", `/cms/admin/${id}/publish`, { token: T.adminA, json: {} });
});

await check("cms: scheduling needs a future date on a draft; versions record it", async () => {
  const draft = await call("POST", "/cms/admin", { token: T.adminA, json: { title: "Sale", slug: "sale" } });
  const id = draft.data._id;
  const past = await call("POST", `/cms/admin/${id}/schedule`, { token: T.adminA, json: { scheduledAt: new Date(Date.now() - 60e3).toISOString() } });
  assert.equal(past.status, 400);
  assert.ok(past.data.fields.scheduledAt);
  const pastCreate = await call("POST", "/cms/admin", { token: T.adminA, json: { title: "Old", scheduledAt: new Date(Date.now() - 60e3).toISOString() } });
  assert.equal(pastCreate.status, 400);
  const ok = await call("POST", `/cms/admin/${id}/schedule`, { token: T.adminA, json: { scheduledAt: new Date(Date.now() + 3600e3).toISOString() } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.scheduledAt);
  const versions = await call("GET", `/cms/admin/${id}/versions`, { token: T.adminA });
  assert.equal(versions.data[0].action, "schedule");
  const cancel = await call("POST", `/cms/admin/${id}/schedule`, { token: T.adminA, json: { scheduledAt: null } });
  assert.equal(cancel.data.scheduledAt, null);
});

await check("cms: admin list includeGlobal; public endpoint by tenantId or slug", async () => {
  const terms = await call("POST", "/cms/admin", { token: T.platform, json: { title: "Terms", slug: "terms", global: true } });
  assert.equal(terms.status, 201, JSON.stringify(terms.data));
  await call("POST", `/cms/admin/${terms.data._id}/publish`, { token: T.platform, json: {} });

  const own = await call("GET", "/cms/admin", { token: T.adminA });
  assert.ok(!own.data.data.some((p) => p.slug === "terms"));
  const withGlobal = await call("GET", "/cms/admin?includeGlobal=true", { token: T.adminA });
  const slugs = withGlobal.data.data.map((p) => `${p.slug}:${p.global}`);
  assert.ok(slugs.includes("terms:true") && slugs.includes("about:false"), JSON.stringify(slugs));
  const platformOne = await call("GET", `/cms/admin?tenantId=${A._id}&includeGlobal=true`, { token: T.platform });
  assert.ok(platformOne.data.data.some((p) => p.slug === "terms"));

  assert.equal((await call("GET", "/cms/pages/about?tenantSlug=alpha")).data.title, "About us");
  assert.equal((await call("GET", `/cms/pages/about?tenant=${A._id}`)).data.title, "About us");
  assert.equal((await call("GET", "/cms/pages/about?tenant=alpha")).data.title, "About us");
  assert.equal((await call("GET", "/cms/pages/about")).status, 404);
  assert.equal((await call("GET", "/cms/pages/terms?tenantSlug=alpha")).data.title, "Terms");
  assert.equal((await call("GET", "/cms/pages/terms?tenantSlug=nope")).status, 404);
  const list = await call("GET", "/cms/pages?tenantSlug=alpha");
  assert.ok(list.data.data.some((p) => p.slug === "about"));
});

/* ------------------------------------------------------------------ 11. chat */

await check("chat: messages endpoint keeps headers and supports ?envelope=1", async () => {
  const convo = await call("POST", "/chat", { token: T.buyer1, json: { tenantId: String(A._id), message: "Hello" } });
  assert.equal(convo.status, 201, JSON.stringify(convo.data));
  const plain = await call("GET", `/chat/${convo.data._id}/messages`, { token: T.buyer1 });
  assert.ok(Array.isArray(plain.data));
  assert.equal(plain.headers.get("x-has-more"), "false");
  const env1 = await call("GET", `/chat/${convo.data._id}/messages?envelope=1&limit=1`, { token: T.buyer1 });
  assert.equal(env1.status, 200);
  assert.equal(env1.data.data.length, 1);
  assert.equal(env1.data.hasMore, false);
  assert.equal(env1.data.nextBefore, null);
  assert.equal(env1.headers.get("x-has-more"), "false");
});

/* ------------------------------------------------------------------ done */

console.log(`\n${passed} platform checks passed${process.exitCode ? " (with failures)" : ""}`);
await sleep(200);
server.close();
await mongoose.disconnect();
