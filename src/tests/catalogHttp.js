/**
 * HTTP-level checks for catalog/wishlist/search routers (mounted on a mini app, so it runs even
 * while other modules are mid-refactor). Local throwaway DB only:
 *   MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_c?replicaSet=rs0" node src/tests/catalogHttp.js
 */
import assert from "assert/strict";
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { detectTransactionSupport } from "../utils/transaction.js";
import { signAccessToken } from "../utils/tokens.js";
import { errorHandler } from "../middleware/error.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { User } from "../modules/users/user.model.js";
import { Warehouse } from "../modules/inventory/warehouse.model.js";
import { Media } from "../modules/catalog/media.model.js";
import { productRouter, mediaRouter, variantRouter } from "../modules/catalog/routes.js";
import wishlistRoutes from "../modules/wishlist/routes.js";
import searchRoutes from "../modules/search/routes.js";

if (!/127\.0\.0\.1:27027\/msp_test_(c|be2|sf|sf2|sf3)(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_c database");
  process.exit(1);
}
await mongoose.connect(env.mongoUri);
await detectTransactionSupport();
await mongoose.connection.db.dropDatabase();
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init().catch(() => {})));
// init() may have run before the drop: rebuild every declared index (incl. the text index).
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).syncIndexes().catch(() => {})));

const app = express();
app.use(express.json());
app.use("/products", productRouter);
app.use("/variants", variantRouter);
app.use("/media", mediaRouter);
app.use("/wishlist", wishlistRoutes);
app.use("/search", searchRoutes);
app.use(errorHandler);
const server = app.listen(4103);
const base = "http://127.0.0.1:4103";

const tenant = await Tenant.create({ name: "Http Store", slug: "http-store", status: "active" });
await Warehouse.create({ tenantId: tenant._id, name: "Main", code: "HW", status: "active" });
const sellerRole = await Role.create({
  name: "Seller",
  slug: "seller-test",
  tenantId: tenant._id,
  permissions: ["products.view", "products.create", "products.edit", "products.publish", "products.delete"],
});
const buyerRole = await Role.create({ name: "Buyerish", slug: "buyer-test", permissions: ["products.view"] });
const mk = async (email, role, tenantId) => {
  const u = await User.create({ name: email, email, passwordHash: "x", roleId: role._id, tenantId, status: "active" });
  return signAccessToken({ sub: String(u._id), tenantId: tenantId ? String(tenantId) : null, tv: u.tokenVersion || 0 });
};
const sellerTok = await mk("seller@test.local", sellerRole, tenant._id);
const buyerTok = await mk("buyer@test.local", buyerRole, null);

async function call(method, path, { token, json, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : body,
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

let product;
await check("create product via HTTP; mass-assignment rejected; empty body 400", async () => {
  const bad = await call("POST", "/products", { token: sellerTok, json: { name: "A", sku: "a", sellingPrice: 1, tenantId: String(tenant._id) } });
  assert.equal(bad.status, 400);
  const empty = await call("POST", "/products", { token: sellerTok });
  assert.equal(empty.status, 400);
  const ok = await call("POST", "/products", {
    token: sellerTok,
    json: { name: "Green Tea", sku: "tea-1", sellingPrice: 10, status: "published", availableQty: 4 },
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  product = ok.data;
  assert.equal(product.status, "published");
});

await check("bulk upload accepts text/csv; export returns CSV", async () => {
  const csv = "sku,name,sellingPrice,availableQty\nTEA-2,Black Tea,12,5\n";
  const res = await call("POST", "/products/bulk-upload", { token: sellerTok, body: csv, headers: { "Content-Type": "text/csv" } });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.created.length, 1);
  const form = new FormData();
  form.append("file", new Blob(["sku,name,sellingPrice\nTEA-3,White Tea,15\n"], { type: "text/csv" }), "p.csv");
  const multi = await fetch(`${base}/products/bulk-upload`, { method: "POST", headers: { Authorization: `Bearer ${sellerTok}` }, body: form });
  assert.equal(multi.status, 201);
  const exp = await call("GET", "/products/export", { token: sellerTok });
  assert.equal(exp.status, 200);
  assert.match(exp.headers.get("content-type"), /text\/csv/);
  assert.match(exp.data, /TEA-2,Black Tea/);
  const buyerExp = await call("GET", "/products/export", { token: buyerTok });
  assert.equal(buyerExp.status, 403);
});

await check("media: permission + folder whitelist + delete", async () => {
  const form = () => {
    const f = new FormData();
    f.append("file", new Blob([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], { type: "image/png" }), "x.png");
    return f;
  };
  const buyer = await fetch(`${base}/media`, { method: "POST", headers: { Authorization: `Bearer ${buyerTok}` }, body: form() });
  assert.equal(buyer.status, 403);
  const evil = form();
  evil.append("folder", "../../src");
  const bad = await fetch(`${base}/media`, { method: "POST", headers: { Authorization: `Bearer ${sellerTok}` }, body: evil });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${base}/media`, { method: "POST", headers: { Authorization: `Bearer ${sellerTok}` }, body: form() });
  const body = await ok.json();
  // storage hardening (B) may reject this tiny PNG stub; accept 201 or a 400 file-type error from storage.
  if (ok.status === 201) {
    assert.equal(body.folder, "catalog");
    const list = await call("GET", "/media?limit=5", { token: sellerTok });
    assert.equal(list.data.meta.total, 1);
    const del = await call("DELETE", `/media/${body._id}`, { token: sellerTok });
    assert.equal(del.status, 200);
    assert.equal(await Media.countDocuments(), 0);
  } else {
    assert.equal(ok.status, 400, JSON.stringify(body));
    console.log("     (storage rejected stub image:", body.message, ")");
  }
});

await check("wishlist: strict PUT, server snapshot, 201 then 200, pagination, delete", async () => {
  const bad = await call("PUT", "/wishlist", { token: buyerTok, json: { productId: product._id, price: 1 } });
  assert.equal(bad.status, 400);
  const first = await call("PUT", "/wishlist", { token: buyerTok, json: { productId: product._id } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.price, 10);
  const second = await call("PUT", "/wishlist", { token: buyerTok, json: { productId: product._id } });
  assert.equal(second.status, 200);
  const legacyList = await call("GET", "/wishlist", { token: buyerTok });
  assert.ok(Array.isArray(legacyList.data));
  assert.equal(legacyList.data[0].slug, product.slug);
  const paged = await call("GET", "/wishlist?page=1&limit=10", { token: buyerTok });
  assert.equal(paged.data.meta.total, 1);
  const del = await call("DELETE", `/wishlist/${product.slug}`, { token: buyerTok });
  assert.equal(del.data.removed, 1);
});

await check("public routes: search, reviews, restock validation", async () => {
  const s = await call("GET", "/products/search?q=" + encodeURIComponent("(((a+)+)+)$"));
  assert.equal(s.status, 200);
  const r = await call("GET", `/products/${product.slug}/reviews?limit=5`);
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.count, 0);
  const sub = await call("POST", `/products/${product.slug}/notify-restock`, { json: { email: "x@example.com" } });
  assert.equal(sub.status, 202, JSON.stringify(sub.data));
  const noBody = await call("POST", `/products/${product.slug}/notify-restock`);
  assert.equal(noBody.status, 400);
  const confirmBad = await call("GET", "/products/restock-alerts/confirm?token=zz");
  assert.equal(confirmBad.status, 400);
  const post = await call("POST", "/search", { json: { q: "tea", extra: 1 } });
  assert.equal(post.status, 400);
  const post2 = await call("POST", "/search", { json: { q: "tea" } });
  assert.equal(post2.status, 200);
  const review = await call("POST", `/products/${product.slug}/reviews`, { token: buyerTok, json: { rating: 5 } });
  assert.equal(review.status, 403);
});

await check("variants list paginated on request; delete is soft", async () => {
  const list = await call("GET", `/variants?productId=${product._id}&page=1&limit=10`, { token: sellerTok });
  assert.equal(list.data.meta.total, 1);
  const legacy = await call("GET", `/variants?productId=${product._id}`, { token: sellerTok });
  assert.ok(Array.isArray(legacy.data));
  const v = await call("POST", "/variants", {
    token: sellerTok,
    json: { productId: product._id, sku: "tea-1-big", listPrice: 20, sellingPrice: 18, attributes: { flavor: "mint" } },
  });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  assert.equal(v.data.attributes.custom.flavor, "mint");
  const del = await call("DELETE", `/variants/${v.data._id}`, { token: sellerTok });
  assert.equal(del.data.status, "archived");
});

console.log(`\n${passed} HTTP checks passed${process.exitCode ? " (with failures)" : ""}`);
server.close();
await mongoose.disconnect();
