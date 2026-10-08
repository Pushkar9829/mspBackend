/**
 * Agent C catalog fix checks. Run ONLY against a throwaway DB:
 *   MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_c?replicaSet=rs0" node src/tests/catalogFixes.js
 */
import assert from "assert/strict";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { detectTransactionSupport } from "../utils/transaction.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Warehouse } from "../modules/inventory/warehouse.model.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { RestockAlert } from "../modules/catalog/restockAlert.model.js";
import { Category } from "../modules/catalog/category.model.js";
import { Review } from "../modules/reviews/review.model.js";
import { WishlistItem } from "../modules/wishlist/wishlist.model.js";
import { SearchHistory } from "../modules/search/searchHistory.model.js";
import { SearchTerm } from "../modules/search/searchTerm.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Notification } from "../modules/notifications/notification.model.js";
import * as catalog from "../modules/catalog/service.js";
import * as restock from "../modules/catalog/restock.js";
import * as reviews from "../modules/reviews/service.js";
import * as search from "../modules/search/service.js";
import { parseCsv } from "../modules/catalog/csv.js";
import {
  createVariantSchema,
  mediaUploadSchema,
  createProductSchema,
  updateProductSchema,
} from "../modules/catalog/validators.js";
import { runCatalogMigration } from "../modules/catalog/migrate.js";

if (!/127\.0\.0\.1:27027\/msp_test_(c|be2|sf|sf2|sf3)(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_c database");
  process.exit(1);
}

await mongoose.connect(env.mongoUri);
await detectTransactionSupport();
await mongoose.connection.db.dropDatabase();
// init() is cached from the connect-time autoIndex, which can race the drop above; syncIndexes()
// rebuilds every index (incl. the product text index) on the fresh database.
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init().catch(() => {})));
await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).syncIndexes().catch(() => {})));

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
async function rejects(promise, status) {
  try {
    await promise;
  } catch (err) {
    if (status) assert.equal(err.status, status, err.message);
    return err;
  }
  throw new Error("expected rejection");
}

const t1 = await Tenant.create({ name: "Store One", slug: "store-one", status: "active" });
const t2 = await Tenant.create({ name: "Store Two", slug: "store-two", status: "active" });
const tSusp = await Tenant.create({ name: "Bad Store", slug: "bad-store", status: "suspended" });
const wh1 = await Warehouse.create({ tenantId: t1._id, name: "Main", code: "W1", status: "active" });
await Warehouse.create({ tenantId: t2._id, name: "Main", code: "W2", status: "active" });
await Warehouse.create({ tenantId: tSusp._id, name: "Main", code: "W3", status: "active" });
const seller = (tenant, extra = []) => ({
  tenantId: tenant._id,
  user: { _id: new mongoose.Types.ObjectId(), tenantId: tenant._id },
  permissions: ["products.create", "products.edit", ...extra],
  isPlatformAdmin: false,
  query: {},
});
const s1 = seller(t1, ["products.publish"]);
const s2 = seller(t2, ["products.publish"]);
const sNoPub = seller(t1);

let p1;
await check("create product: slug generated, SKU uppercased, stock via setAvailableQty", async () => {
  p1 = await catalog.createProduct(s1, {
    name: "Organic Basmati Rice",
    sku: "  rice-001 ",
    sellingPrice: 99.999,
    listPrice: 120,
    availableQty: 7,
  });
  assert.match(p1.slug, /^organic-basmati-rice-[a-z0-9]{6}$/);
  assert.equal(p1.sku, "RICE-001");
  const v = await ProductVariant.findOne({ productId: p1._id });
  assert.equal(v.sku, "RICE-001");
  assert.equal(v.sellingPrice, 100);
  const inv = await Inventory.find({ variantId: v._id });
  assert.equal(inv.reduce((s, r) => s + r.available, 0), 7);
});

await check("publish gated on products.publish", async () => {
  await rejects(catalog.createProduct(sNoPub, { name: "X", sku: "X1", sellingPrice: 1, status: "published" }), 403);
  await rejects(catalog.updateProduct(sNoPub, p1._id, { status: "published" }), 403);
  const pub = await catalog.updateProduct(s1, p1._id, { status: "published" });
  assert.equal(pub.status, "published");
});

await check("rename keeps slug stable", async () => {
  const before = p1.slug;
  const after = await catalog.updateProduct(s1, p1._id, { name: "Premium Basmati" });
  assert.equal(after.slug, before);
});

let p2;
await check("lookup: slug first, legacy SKU only when unambiguous", async () => {
  const bySlug = await catalog.lookupBySlug(p1.slug, null, {});
  assert.equal(String(bySlug.product._id), String(p1._id));
  assert.equal(bySlug.slug, p1.slug);
  const bySku = await catalog.lookupBySlug("rice-001", null, {});
  assert.equal(String(bySku.product._id), String(p1._id));
  p2 = await catalog.createProduct(s2, { name: "Other Rice", sku: "RICE-001", sellingPrice: 50, status: "published" });
  await rejects(catalog.lookupBySlug("rice-001", null, {}), 404);
  const ok = await catalog.lookupBySlug(p2.slug, null, {});
  assert.equal(String(ok.product._id), String(p2._id));
});

await check("suspended tenant products hidden from storefront", async () => {
  const sp = await catalog.createProduct(seller(tSusp, ["products.publish"]), {
    name: "Hidden Rice",
    sku: "HID-1",
    sellingPrice: 5,
    status: "published",
  });
  catalog.invalidateActiveTenants();
  await rejects(catalog.lookupBySlug(sp.slug, null, {}), 404);
  const res = await catalog.searchCatalog({ query: { q: "rice" } });
  assert.ok(res.data.every((p) => String(p.tenantId) !== String(tSusp._id)));
  assert.ok(res.data.length >= 2);
  const scoped = await catalog.searchCatalog({ query: { tenantId: String(tSusp._id) } });
  assert.equal(scoped.meta.total, 0);
});

await check("search: ReDoS payload is escaped; text index + prefix fallback", async () => {
  const evil = await catalog.searchCatalog({ query: { q: "(a+)+$" + "a".repeat(200) } });
  assert.equal(evil.meta.total, 0);
  const text = await catalog.searchCatalog({ query: { q: "basmati" } });
  assert.equal(text.meta.total, 1);
  const prefix = await catalog.searchCatalog({ query: { q: "pr" } });
  assert.equal(prefix.meta.total, 1);
  const partial = await catalog.searchCatalog({ query: { q: "asmat" } }); // not a whole word → regex fallback
  assert.equal(partial.meta.total, 1);
  const arr = await catalog.searchCatalog({ query: { q: ["rice", "x"] } });
  assert.ok(arr.meta.total >= 2);
});

await check("variant attributes keep custom keys; strict validators", async () => {
  const parsed = createVariantSchema.safeParse({
    body: {
      productId: String(p1._id),
      sku: "rice-002",
      listPrice: 10,
      sellingPrice: 9,
      attributes: { size: "5kg", flavor: "Smoky", custom: { origin: "Punjab" } },
    },
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.deepEqual(parsed.data.body.attributes.custom, { origin: "Punjab", flavor: "Smoky" });
  const v = await catalog.createVariant(s1, parsed.data.body);
  assert.equal(v.sku, "RICE-002");
  assert.equal(v.attributes.custom.get("flavor"), "Smoky");
  const upd = await catalog.updateVariant(s1, v._id, { sku: "rice-002b", attributes: { color: "white" } });
  assert.equal(upd.sku, "RICE-002B");
  assert.equal(upd.attributes.size, "5kg");
  assert.equal(upd.attributes.color, "white");
  assert.equal(createProductSchema.safeParse({ body: { name: "a", sku: "b", tenantId: "x" } }).success, false);
  assert.equal(updateProductSchema.safeParse({ params: { id: String(p1._id) }, body: { ratingAvg: 5 } }).success, false);
  assert.equal(createProductSchema.safeParse({ body: undefined }).success, false);
});

await check("variant delete is soft + inventory zeroed + last-active guard", async () => {
  const v2 = await ProductVariant.findOne({ productId: p1._id, sku: "RICE-002B" });
  const res = await catalog.deleteVariant(s1, v2._id);
  assert.equal(res.status, "archived");
  const doc = await ProductVariant.findById(v2._id);
  assert.equal(doc.status, "archived");
  assert.ok(doc.deletedAt);
  const listed = await catalog.listVariants({ ...s1, query: { productId: String(p1._id) } });
  assert.ok(listed.every((x) => x.status !== "archived"));
  const primary = await ProductVariant.findOne({ productId: p1._id, status: "active" });
  await rejects(catalog.deleteVariant(s1, primary._id), 409);
});

await check("category delete blocks live products, detaches archived ones", async () => {
  const cat = await Category.create({ name: "Grains", slug: "grains", tenantId: t1._id });
  const p = await catalog.createProduct(s1, { name: "Millet", sku: "MIL-1", sellingPrice: 3, categoryId: String(cat._id) });
  const admin = { ...s1, isPlatformAdmin: true };
  await rejects(catalog.deleteCategory(admin, cat._id), 409);
  await catalog.deleteProduct(s1, p._id);
  const out = await catalog.deleteCategory(admin, cat._id);
  assert.equal(out.detachedArchivedProducts, 1);
  assert.equal((await Product.findById(p._id)).categoryId, null);
});

await check("CSV bulk import + export round trip", async () => {
  const csv =
    "﻿SKU,Name,Selling Price,listPrice,availableQty,tags,tierPrices,publish,description\r\n" +
    'oil-1,"Mustard Oil, 1L",150,170,12,oil;kitchen,10-49@140;50@130,true,"He said ""fresh"""\r\n' +
    "oil-2,Bad Row,abc,,,,,,\r\n" +
    "rice-001,Premium Basmati v2,101,,3,,,,\r\n";
  const items = catalog.csvToBulkItems(csv);
  assert.equal(items.length, 3);
  const res = await catalog.bulkUploadProducts(s1, items);
  assert.equal(res.created.length, 1, JSON.stringify(res));
  assert.equal(res.updated.length, 1);
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].sku, "oil-2");
  const oil = await Product.findOne({ tenantId: t1._id, sku: "OIL-1" });
  assert.equal(oil.status, "published");
  assert.equal(oil.description, 'He said "fresh"');
  const oilV = await ProductVariant.findOne({ productId: oil._id });
  assert.equal(oilV.tierPrices.length, 2);
  const noPub = await catalog.bulkUploadProducts(sNoPub, [{ name: "Z", sku: "Z1", sellingPrice: 1, publish: true }]);
  assert.equal(noPub.errors[0].code, "FORBIDDEN");
  const out = await catalog.exportProductsCsv({ ...s1, query: {} });
  const rows = parseCsv(out);
  const oilRow = rows.find((r) => r.sku === "OIL-1");
  assert.equal(oilRow.name, "Mustard Oil, 1L");
  assert.equal(oilRow.availableQty, "12");
  assert.equal(oilRow.tierPrices, "10-49@140;50@130");
  const back = catalog.csvToBulkItems(out);
  const again = await catalog.bulkUploadProducts(s1, back);
  assert.equal(again.errors.length, 0, JSON.stringify(again.errors));
  assert.throws(() => catalog.csvToBulkItems("sku,evil\nA,1\n"), /Unknown CSV column/);
});

await check("media folder whitelist", async () => {
  assert.equal(mediaUploadSchema.safeParse({ body: { folder: "../../src" } }).success, false);
  assert.equal(mediaUploadSchema.safeParse({ body: {} }).data.body.folder, "catalog");
  assert.equal(mediaUploadSchema.safeParse({ body: undefined }).data.body.folder, "catalog");
});

await check("restock: user + double-opt-in email, per-variant, atomic, no duplicates", async () => {
  const product = await Product.findById(p1._id);
  const variants = await ProductVariant.find({ productId: product._id, status: "active" });
  const v = variants[0];
  const other = await catalog.createVariant(s1, { productId: String(product._id), sku: "RICE-003", listPrice: 1, sellingPrice: 1 });
  const userA = new mongoose.Types.ObjectId();
  const userB = new mongoose.Types.ObjectId();
  const req = (u) => ({ user: u ? { _id: u } : undefined });
  await Promise.all([
    restock.subscribeRestock(req(userA), product.slug, { variantId: String(v._id) }),
    restock.subscribeRestock(req(userA), product.slug, { variantId: String(v._id) }),
  ]);
  await restock.subscribeRestock(req(userB), product.slug, { variantId: String(other._id) });
  const g = await restock.subscribeRestock(req(null), product.slug, { email: "Guest@Example.com" });
  assert.equal(g.pendingConfirmation, true);
  assert.equal(await RestockAlert.countDocuments({ userId: userA }), 1);
  const guest = await RestockAlert.findOne({ email: "guest@example.com" });
  assert.equal(guest.confirmed, false);

  const runs = await Promise.all([1, 2, 3].map(() => restock.notifyRestock({ tenantId: t1._id, variantId: v._id })));
  assert.equal(runs.reduce((s, r) => s + r.notified, 0), 1); // only userA: B is other variant, guest unconfirmed
  assert.ok(await RestockAlert.findOne({ userId: userB, notifiedAt: null }));
  assert.equal(await Notification.countDocuments({ userId: userA, event: "RESTOCK_AVAILABLE" }), 1);

  // confirm guest via token (simulate the emailed token by setting a known hash)
  const crypto = await import("crypto");
  const token = "a".repeat(64);
  await RestockAlert.updateOne(
    { _id: guest._id },
    { $set: { confirmTokenHash: crypto.createHash("sha256").update(token).digest("hex") } }
  );
  await restock.confirmRestock(token);
  await rejects(restock.confirmRestock(token), 400);
  const again = await restock.notifyRestock({ variantId: v._id });
  assert.equal(again.notified, 1); // product-level guest alert
  await rejects(restock.subscribeRestock(req(null), product.slug, {}), 400);
});

await check("reviews: verified buyers only, full aggregate, pagination, moderation", async () => {
  const product = await Product.findById(p1._id);
  const buyers = [1, 2, 3].map(() => ({ _id: new mongoose.Types.ObjectId(), name: "B" }));
  await rejects(reviews.upsertReview(product.slug, buyers[0], { rating: 5 }), 403);
  for (const b of buyers) {
    await Order.collection.insertOne({
      orderNumber: `REV-${b._id}`,
      buyerId: b._id,
      tenantId: t1._id,
      status: "delivered",
      idempotencyKey: `test-${b._id}`,
      items: [{ productId: product._id }],
      createdAt: new Date(),
    });
  }
  await reviews.upsertReview(product.slug, buyers[0], { rating: 5 });
  await reviews.upsertReview(product.slug, buyers[1], { rating: 4 });
  const r3 = await reviews.upsertReview(product.slug, buyers[2], { rating: 1, body: "bad" });
  assert.equal(r3.verifiedPurchase, true);
  const list = await reviews.listReviews(product.slug, { limit: 2 });
  assert.equal(list.reviews.length, 2);
  assert.equal(list.summary.count, 3);
  assert.equal(list.summary.rating, 3.3);
  assert.equal(list.meta.pages, 2);
  const mod = { ...s1, user: { _id: new mongoose.Types.ObjectId() }, query: {} };
  await reviews.moderateReview(mod, r3.id, { status: "hidden", note: "abuse" });
  const after = await reviews.listReviews(product.slug, {});
  assert.equal(after.summary.count, 2);
  assert.equal((await Product.findById(product._id)).ratingAvg, 4.5);
  await rejects(reviews.moderateReview({ ...s2, user: { _id: new mongoose.Types.ObjectId() } }, r3.id, { status: "published" }), 404);
  const queue = await reviews.listReviewsForModeration({ ...s1, query: { status: "hidden" } });
  assert.equal(queue.meta.total, 1);
  await reviews.deleteReview(mod, r3.id);
  assert.equal(await Review.countDocuments({ productId: product._id }), 2);
});

await check("search history: guests TTL + no popularity bump; users bump once per window", async () => {
  const guestReq = { headers: { "x-guest-key": "guest-key-123" } };
  await search.recordSearch(guestReq, "  Basmati   Rice ");
  const row = await SearchHistory.findOne({ guestKey: "guest-key-123" });
  assert.ok(row.expiresAt > new Date());
  assert.equal(await SearchTerm.countDocuments(), 0);
  const userReq = { user: { _id: new mongoose.Types.ObjectId() }, headers: {} };
  await search.recordSearch(userReq, "Basmati Rice");
  await search.recordSearch(userReq, "basmati rice");
  assert.equal((await SearchTerm.findOne({ term: "basmati rice" })).count, 1);
  assert.equal(await SearchHistory.countDocuments({ userId: userReq.user._id }), 1);
  await search.recordSearch({ headers: { "x-guest-key": "../$bad" } }, "foo");
  assert.equal(await SearchHistory.countDocuments({ guestKey: "../$bad" }), 0);
  const long = await search.recordSearch(userReq, "x".repeat(500));
  assert.equal(long.term.length, 80);
});

await check("migration: slug backfill + legacy wishlist + restock normalisation + indexes", async () => {
  const legacy = await Product.collection.insertOne({
    tenantId: t1._id,
    name: "Legacy Dal",
    sku: "dal-1",
    status: "published",
    enabled: true,
    createdAt: new Date(),
  });
  const userId = new mongoose.Types.ObjectId();
  await WishlistItem.collection.insertOne({ userId, slug: "dal-1", snapshot: { price: 1 } });
  await WishlistItem.collection.insertOne({ userId, slug: "rice-001", snapshot: {} }); // ambiguous → unresolved
  await RestockAlert.collection.insertOne({
    tenantId: t1._id,
    productId: p1._id,
    variantId: null,
    userId: null,
    email: "legacy@example.com",
    notifiedAt: null,
    createdAt: new Date(),
  });
  const out = await runCatalogMigration();
  assert.ok(out.slugs.slugged >= 1);
  const migrated = await Product.findById(legacy.insertedId);
  assert.equal(migrated.sku, "DAL-1");
  assert.match(migrated.slug, /^legacy-dal-/);
  const w = await WishlistItem.findOne({ userId, productId: legacy.insertedId });
  assert.equal(w.slug, migrated.slug);
  assert.equal(out.slugs.wishlistOrphans, 1);
  const la = await RestockAlert.findOne({ email: "legacy@example.com" });
  assert.equal(la.confirmed, false);
  const idx = await Product.collection.indexes();
  assert.ok(idx.some((i) => i.key.slug === 1 && i.unique));
  assert.ok(!idx.some((i) => Object.keys(i.key).join() === "status"));
  const midx = await mongoose.model("Media").collection.indexes();
  assert.ok(midx.some((i) => i.key.tenantId === 1 && i.key.key === 1 && i.unique));
});

console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}`);
await mongoose.disconnect();
