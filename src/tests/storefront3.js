/**
 * Storefront support, part 3: typo-tolerant search (synonyms + fuzzy), public store directory,
 * wishlist buyer pricing, order item slug/image snapshots (+ backfill), settings-templated CMS
 * defaults with seed hashes and the returns ↔ refunds alias, tolerant reorder, allowedActions on
 * order list rows, register businessType / GSTIN, credit-note PDF, paginated ledger entries and
 * address state normalisation. Mounts the real /api/v1 router on a mini app.
 *
 * Throwaway local replica set only (the database is dropped):
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_sf3?replicaSet=rs0" node src/tests/storefront3.js
 */
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { setup, teardown, makeStore, makeBuyer, check, finish } from "./commerceFixtures.js";
import { signAccessToken } from "../utils/tokens.js";
import { errorHandler, notFound } from "../middleware/error.js";
import { ensureSystemRoles } from "../seeds/index.js";
import { runStorefrontMigrations, backfillOrderItemSnapshots } from "../seeds/migrations.js";
import { ensureDefaultCmsPages, upsertSeedPage, cmsContentHash, LEGACY_DEMO_GLOBAL, DEFAULT_CMS_PAGES } from "../seeds/cmsDefaults.js";
import v1 from "../routes/v1.js";
import { Role } from "../modules/rbac/role.model.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Brand } from "../modules/catalog/brand.model.js";
import { CmsPage } from "../modules/cms/cmsPage.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Order } from "../modules/orders/order.model.js";
import { PriceList } from "../modules/pricing/priceList.model.js";
import { LedgerEntry } from "../modules/ledger/ledger.model.js";
import { CreditNote } from "../modules/invoices/invoice.model.js";
import { Address } from "../modules/location/address.model.js";
import { setAvailableQty } from "../modules/inventory/service.js";
import { invalidateActiveTenants } from "../modules/catalog/service.js";
import { invalidateSettingCache } from "../modules/settings/service.js";
import { invalidatePlatformEta } from "../modules/settings/commerce.js";
import { invalidateSearchDictionary, editDistance, tokenize, correctToken, getDictionary } from "../modules/search/fuzzy.js";
import { catalogVersion } from "../modules/search/catalogVersion.js";
import { reorderQty } from "../modules/orders/service.js";
import { qtyRules } from "../modules/pricing/engine.js";
import { normalizeIndianState } from "../modules/location/pincode.js";
import { normalizeAddressStates } from "../modules/location/address.service.js";
import { isValidGstin } from "../utils/gstin.js";

if (!/127\.0\.0\.1:27027\/msp_test_[a-z0-9_]+(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at a local msp_test_* database");
  process.exit(2);
}

const PORT = 4314;
const base = `http://127.0.0.1:${PORT}/api/v1`;

async function call(method, path, { token, json, raw = false } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
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

async function asBuyer(buyerRole, buyer) {
  await User.updateOne({ _id: buyer.user._id }, { $set: { roleId: buyerRole._id, status: "active", emailVerified: true } });
  const user = await User.findById(buyer.user._id);
  return { ...buyer, doc: user, token: tokenFor(user) };
}

let orderSeq = 0;
function orderDoc(store, buyer, items, extra = {}) {
  orderSeq += 1;
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  return {
    orderNumber: `SF3-${Date.now()}-${orderSeq}`,
    tenantId: store.tenant._id,
    buyerId: buyer.user._id,
    status: "delivered",
    items,
    addressSnapshot: { city: "Mumbai", state: "Maharashtra", postalCode: "400001" },
    subtotal,
    tax: 0,
    total: subtotal,
    paymentMethod: "cod",
    ...extra,
  };
}
function lineOf(store, product, variant, qty, price = 100, extra = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    tenantId: store.tenant._id,
    productId: product._id,
    variantId: variant._id,
    sku: variant.sku,
    name: product.name,
    qty,
    unitPrice: price,
    lineSubtotal: price * qty,
    lineTotal: price * qty,
    fulfillmentMode: "delivery_partner",
    attributes: {},
    ...extra,
  };
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
  const a = await makeStore({ stock: 50, price: 200 });
  const b = await makeStore({ stock: 20, price: 100 });
  const s = await makeStore({ stock: 5, price: 50 });
  await Tenant.updateOne(
    { _id: a.tenant._id },
    { $set: { name: "Alpha Traders", slug: "alpha-traders", status: "active", "pickupAddress.city": "Pune", "branding.logo": "/uploads/alpha.png", "orderRules.minOrderValue": 500 } }
  );
  await Tenant.updateOne({ _id: b.tenant._id }, { $set: { name: "Beta Mart", slug: "beta-mart", status: "trial", "pickupAddress.city": "Mumbai" } });
  await Tenant.updateOne({ _id: s.tenant._id }, { $set: { name: "Suspended Co", slug: "suspended-co", status: "suspended" } });
  invalidateActiveTenants();
  await Settings.create({ scope: "tenant", tenantId: a.tenant._id, key: "store.displayName", value: "Alpha Wholesale" });

  const brand = await Brand.create({ name: "Aashirvaad", slug: `aashirvaad-${Date.now()}` });
  const mk = (name, extra = {}) =>
    Product.create({ tenantId: a.tenant._id, name, sku: `S3-${name.replace(/\W+/g, "").toUpperCase()}-${Date.now()}`, status: "published", ...extra });
  const atta = await mk("Chakki Atta");
  const flour = await mk("Whole Wheat Flour", { brandId: brand._id });
  const rice = await mk("Basmati Rice");
  const turmeric = await mk("Turmeric Powder");
  await mk("Masala Chai");
  await Product.updateOne({ _id: a.product._id }, { $set: { name: "Sunflower Refined", ratingAvg: 4, ratingCount: 2, deliveryModes: ["store_pickup", "delivery_partner"] } });
  await Product.updateOne({ _id: rice._id }, { $set: { ratingAvg: 5, ratingCount: 2 } });
  invalidateSearchDictionary();

  /* ------------------------------------------------------------------ 1. typo-tolerant search */
  console.log("\n# search: text / synonym / fuzzy");
  check(editDistance("basmatti", "basmati") === 1 && editDistance("tea", "eat", 1) === 2 && editDistance("ab", "ba") === 1, "editDistance: insertions / transpositions");
  check(tokenize("Chakki-Atta 5KG").join(",") === "chakki,atta,5kg", "tokenize lower-cases and splits");
  const dict = await getDictionary();
  check(dict.df.get("atta") === 1 && dict.df.has("aashirvaad") && dict.df.has("powder"), "dictionary has product, brand and category words");
  check(correctToken(dict, "turmric")?.term === "turmeric" && correctToken(dict, "atta") === null && correctToken(dict, "5kgs") === null, "correctToken: corrects unknown words only");

  const search = (q, extra = "") => call("GET", `/products/search?q=${encodeURIComponent(q)}${extra}`);
  let res = await search("sunflower");
  check(res.status === 200 && res.data.meta.matchedBy === "text" && res.data.meta.didYouMean === null && res.data.data.length === 1, "exact word, nothing to expand: matchedBy text");
  res = await search("atta");
  check(
    res.data.meta.matchedBy === "synonym" && res.data.meta.didYouMean === null && res.data.data[0]?.name === "Chakki Atta" && res.data.data.some((p) => String(p._id) === String(flour._id)),
    "few exact hits: synonyms widen (flour), exact match ranks first, nothing to correct"
  );
  res = await search("aata");
  check(res.data.meta.matchedBy === "synonym" && res.data.meta.didYouMean === "atta" && res.data.data.some((p) => String(p._id) === String(atta._id)), `aata → synonym atta (${res.data.meta.matchedBy}/${res.data.meta.didYouMean})`);
  res = await search("chawal");
  check(res.data.meta.matchedBy === "synonym" && res.data.meta.didYouMean === "rice" && res.data.data[0]?.name === "Basmati Rice", "chawal → rice");
  res = await search("haldi");
  check(res.data.meta.matchedBy === "synonym" && res.data.data.some((p) => String(p._id) === String(turmeric._id)), "haldi → turmeric");
  res = await search("chai");
  check(res.data.meta.matchedBy === "text" && res.data.data.length === 1, "chai found by text when the catalogue uses the word (no fallback needed)");
  res = await search("basmatti");
  check(res.data.meta.matchedBy === "fuzzy" && res.data.meta.didYouMean === "basmati" && res.data.data[0]?.name === "Basmati Rice", `basmatti → fuzzy basmati (${res.data.meta.didYouMean})`);
  res = await search("turmric powdr");
  check(res.data.meta.matchedBy === "fuzzy" && res.data.meta.didYouMean === "turmeric powder" && res.data.data[0]?.name === "Turmeric Powder", `multi-word correction (${res.data.meta.didYouMean})`);
  res = await search("aashirvad");
  check(res.data.meta.matchedBy === "fuzzy" && res.data.data.some((p) => String(p._id) === String(flour._id)), "brand typo → products of the brand (regex on brand names)");
  res = await search("chawl");
  check(["synonym", "fuzzy"].includes(res.data.meta.matchedBy) && res.data.data.some((p) => p.name === "Basmati Rice"), "transliteration variant chawl → rice");
  res = await search("zqxwvy");
  check(res.data.data.length === 0 && res.data.meta.matchedBy === "text" && res.data.meta.didYouMean === null, "nonsense: no results, no suggestion");
  res = await call("GET", "/products/search");
  check(res.data.meta.matchedBy === null && res.data.meta.didYouMean === null, "no q: matchedBy null");
  res = await search("aata", "&category=does-not-exist");
  check(res.data.meta.matchedBy === null && res.data.data.length === 0, "early empty result still has the meta fields");
  const v0 = catalogVersion();
  await Product.updateOne({ _id: rice._id }, { $set: { tags: ["long-grain"] } });
  check(catalogVersion() > v0, "product writes bump the catalog version (dictionary refresh)");

  /* ------------------------------------------------------------------ 2. public store directory */
  console.log("\n# GET /tenants/public");
  res = await call("GET", "/tenants/public");
  const alpha = res.data.data?.find((t) => t.slug === "alpha-traders");
  check(res.status === 200 && res.data.meta.total === 2 && !res.data.data.some((t) => t.slug === "suspended-co"), "active + trial stores only");
  check(
    alpha &&
      alpha.displayName === "Alpha Wholesale" &&
      alpha.city === "Pune" &&
      alpha.logo === "/uploads/alpha.png" &&
      alpha.productCount === 6 &&
      alpha.rating === 4.5 &&
      alpha.ratingCount === 4 &&
      alpha.minOrderValue === 500 &&
      alpha.deliveryModes.join(",") === "store_pickup,delivery_partner",
    `store row shape ${JSON.stringify(alpha)}`
  );
  check(res.headers.get("ratelimit") || res.headers.get("ratelimit-policy"), "rate-limit headers present");
  res = await call("GET", "/tenants/public?sort=products&limit=1");
  check(res.data.data.length === 1 && res.data.data[0].slug === "alpha-traders" && res.data.meta.pages === 2, "sort=products + pagination");
  res = await call("GET", "/tenants/public?q=beta");
  check(res.data.data.length === 1 && res.data.data[0].slug === "beta-mart" && res.data.data[0].productCount === 1, "q filter");
  res = await call("GET", "/tenants/public?city=mumbai");
  check(res.data.data.length === 1 && res.data.data[0].city === "Mumbai", "city filter (case-insensitive)");
  res = await call("GET", "/tenants/public/alpha-traders");
  check(res.status === 200, "GET /tenants/public/:slug still resolves");

  /* ------------------------------------------------------------------ 3. wishlist pricing */
  console.log("\n# wishlist pricing");
  const w = await asBuyer(buyerRole, await makeBuyer());
  await PriceList.create({ tenantId: a.tenant._id, name: "W", customerId: w.user._id, items: [{ variantId: a.variant._id, unitPrice: 150 }] });
  res = await call("PUT", "/wishlist", { token: w.token, json: { productId: String(a.product._id) } });
  check(res.status === 201 && res.data.price === 150, `PUT /wishlist answers with the buyer price (${res.data.price})`);
  res = await call("GET", "/wishlist", { token: w.token });
  const wrow = res.data[0];
  check(wrow?.price === 150 && wrow.catalogPrice === 200 && wrow.listPrice === 200 && wrow.discountPct === 25, `GET /wishlist applies the buyer price list ${JSON.stringify(wrow)}`);
  res = await call("GET", `/products/search?q=sunflower`, { token: w.token });
  check(res.data.data[0]?.minPrice === wrow.price, "wishlist price matches the search listing");
  res = await call("GET", "/wishlist?page=1&limit=10", { token: w.token });
  check(res.data.data[0]?.price === 150 && res.data.meta.total === 1, "paged wishlist priced too");
  res = await call("GET", "/wishlist", { token: (await asBuyer(buyerRole, await makeBuyer())).token });
  check(Array.isArray(res.data) && res.data.length === 0, "other buyer: empty");

  /* ------------------------------------------------------------------ 4. order item snapshots */
  console.log("\n# order item slug / image");
  const ob = await asBuyer(buyerRole, await makeBuyer());
  await Product.updateOne({ _id: a.product._id }, { $set: { images: ["/uploads/sun.png"] } });
  const legacyId = new mongoose.Types.ObjectId();
  const gone = { _id: new mongoose.Types.ObjectId(), name: "Gone" };
  const legacyItems = [
    lineOf(a, a.product, a.variant, 2, 100, { slug: a.variant.sku.toLowerCase() }),
    lineOf(a, gone, { _id: new mongoose.Types.ObjectId(), sku: "GONE-1" }, 1),
  ];
  delete legacyItems[1].image;
  await Order.collection.insertOne({ _id: legacyId, ...orderDoc(a, ob, legacyItems), createdAt: new Date(), updatedAt: new Date() });
  const fresh = await Order.create(orderDoc(a, ob, [lineOf(a, rice, a.variant, 1, 100, { slug: rice.slug, image: "/x.png" })]));
  let bf = await backfillOrderItemSnapshots();
  const legacy = await Order.collection.findOne({ _id: legacyId });
  const freshAfter = await Order.collection.findOne({ _id: fresh._id });
  const sunflower = await Product.findById(a.product._id).lean();
  check(bf.orders === 1 && bf.items === 2 && bf.unresolved === 1, `backfill touches only the legacy order (${JSON.stringify(bf)})`);
  check(legacy.items[0].slug === sunflower.slug && legacy.items[0].image === "/uploads/sun.png", "legacy SKU slug replaced by the product slug, image copied");
  check(legacy.items[1].slug === null && legacy.items[1].image === "", "deleted product: slug null, empty image");
  check(freshAfter.items[0].slug === rice.slug && freshAfter.items[0].image === "/x.png", "orders with snapshots untouched");
  bf = await backfillOrderItemSnapshots();
  check(bf.orders === 0 && bf.items === 0, "backfill is idempotent");
  res = await call("GET", `/orders/${legacyId}`, { token: ob.token });
  check(res.status === 200 && res.data.items[0].slug === sunflower.slug && res.data.items[0].image === "/uploads/sun.png", "GET /orders/:id items carry slug + image");
  res = await call("GET", "/orders?limit=10", { token: ob.token });
  const listRow = res.data.data?.find((o) => String(o._id) === String(legacyId));
  check(listRow?.items[0].slug === sunflower.slug, "GET /orders rows carry item slug");
  check(
    listRow && typeof listRow.allowedActions === "object" && listRow.allowedActions.reorder === true && listRow.allowedActions.cancel === false && "returnUntil" in listRow,
    `GET /orders rows carry allowedActions ${JSON.stringify(listRow?.allowedActions)}`
  );
  res = await call("GET", `/orders/${legacyId}`, { token: ob.token });
  check(JSON.stringify(res.data.allowedActions) === JSON.stringify(listRow.allowedActions), "list allowedActions == detail allowedActions");

  /* ------------------------------------------------------------------ 5. tolerant reorder */
  console.log("\n# reorder");
  check(reorderQty({ bulkEligible: true, bulkFrom: 5, pack: 5, maxQty: 20 }, { desired: 7 }).total === 10, "reorderQty rounds up to the pack");
  check(reorderQty({ bulkEligible: true, bulkFrom: 5, pack: 5, maxQty: 20 }, { desired: 23 }).total === 20, "reorderQty caps at max");
  check(reorderQty({ bulkEligible: true, bulkFrom: 5, pack: 5, maxQty: null }, { desired: 7, stock: 8 }).total === 5, "reorderQty: stock cap rounds down to the pack");
  check(reorderQty({ bulkEligible: true, bulkFrom: 5, pack: 5, maxQty: null }, { desired: 7, stock: 3 }).total === 3, "reorderQty: below the bulk range is a regular qty");
  check(reorderQty(qtyRules({}), { desired: 7 }).reason === null, "reorderQty: plain product unchanged");

  const bulkP = await Product.create({
    tenantId: a.tenant._id,
    name: "Bulk Sugar",
    sku: `S3-BULK-${Date.now()}`,
    status: "published",
    wholesale: { bulkEligible: true, moq: 5, packMultiple: 5, maxQty: 20 },
  });
  const bulkV = await ProductVariant.create({ tenantId: a.tenant._id, productId: bulkP._id, sku: `S3-BV-${Date.now()}`, listPrice: 40, sellingPrice: 40 });
  await setAvailableQty({ tenantId: a.tenant._id, variantId: bulkV._id, warehouseId: a.warehouse._id, qty: 100 });
  const lowP = await Product.create({ tenantId: a.tenant._id, name: "Low Stock Salt", sku: `S3-LOW-${Date.now()}`, status: "published" });
  const lowV = await ProductVariant.create({ tenantId: a.tenant._id, productId: lowP._id, sku: `S3-LV-${Date.now()}`, listPrice: 20, sellingPrice: 20 });
  await setAvailableQty({ tenantId: a.tenant._id, variantId: lowV._id, warehouseId: a.warehouse._id, qty: 3 });
  const deadP = await Product.create({ tenantId: a.tenant._id, name: "Archived Item", sku: `S3-DEAD-${Date.now()}`, status: "archived" });
  const deadV = await ProductVariant.create({ tenantId: a.tenant._id, productId: deadP._id, sku: `S3-DV-${Date.now()}`, listPrice: 20, sellingPrice: 20 });
  const rb = await asBuyer(buyerRole, await makeBuyer());
  const reOrder = await Order.create(
    orderDoc(a, rb, [lineOf(a, bulkP, bulkV, 7, 40, { bulk: true }), lineOf(a, lowP, lowV, 8, 20), lineOf(a, deadP, deadV, 1, 20)])
  );
  res = await call("POST", `/orders/${reOrder._id}/reorder`, { token: rb.token });
  const addedBulk = res.data.added?.find((x) => String(x.variantId) === String(bulkV._id));
  const adjBulk = res.data.adjusted?.find((x) => String(x.variantId) === String(bulkV._id));
  const adjLow = res.data.adjusted?.find((x) => String(x.variantId) === String(lowV._id));
  check(res.status === 200 && res.data.added.length === 2 && res.data.skipped.length === 1, `partial reorder succeeds (${res.status} ${res.data.message || ""})`);
  check(addedBulk?.qty === 10 && adjBulk?.orderedQty === 7 && adjBulk.qty === 10 && /multiple of 5/.test(adjBulk.reason), `pack rule: 7 → 10 ${JSON.stringify(adjBulk)}`);
  check(adjLow?.orderedQty === 8 && adjLow.qty === 3 && /Only 3 in stock/.test(adjLow.reason), `stock cap: 8 → 3 ${JSON.stringify(adjLow)}`);
  check(res.data.skipped[0]?.code === "UNAVAILABLE" && String(res.data.skipped[0].variantId) === String(deadV._id), "unavailable line skipped with a reason");
  const cartLines = res.data.groups?.flatMap((g) => g.items) || [];
  check(cartLines.find((l) => String(l.variantId) === String(bulkV._id))?.qty === 10, "cart holds the adjusted quantity");
  res = await call("POST", `/orders/${reOrder._id}/reorder`, { token: rb.token });
  const again = res.data.added?.find((x) => String(x.variantId) === String(bulkV._id));
  check(res.status === 200 && again?.cartQty === 20 && res.data.skipped.some((x) => String(x.variantId) === String(lowV._id)), "second reorder: bulk line grows to the max; out-of-stock line skipped");
  const deadOrder = await Order.create(orderDoc(a, rb, [lineOf(a, deadP, deadV, 1, 20)]));
  res = await call("POST", `/orders/${deadOrder._id}/reorder`, { token: rb.token });
  check(res.status === 409 && res.data.code === "REORDER_UNAVAILABLE" && res.data.skipped?.length === 1, "nothing addable → 409 with skipped");

  /* ------------------------------------------------------------------ 6. credit-note PDF */
  console.log("\n# credit-note PDF");
  const note = await CreditNote.create({
    creditNoteNumber: "CN/26-27/0001",
    tenantId: a.tenant._id,
    orderId: legacyId,
    invoiceId: new mongoose.Types.ObjectId(),
    invoiceNumber: "INV/26-27/0001",
    orderNumber: legacy.orderNumber,
    buyerId: ob.user._id,
    refundKey: `${legacyId}:refund`,
    financialYear: "26-27",
    sequence: 1,
    lines: [],
    totals: { grandTotal: 200 },
  });
  res = await call("GET", `/orders/${legacyId}/credit-notes/${note._id}.pdf`, { token: ob.token, raw: true });
  check(
    res.status === 200 && res.headers.get("content-type") === "application/pdf" && res.buffer.slice(0, 4).toString() === "%PDF" && /CN_26-27_0001\.pdf/.test(res.headers.get("content-disposition")),
    "GET /orders/:id/credit-notes/:noteId.pdf"
  );
  res = await call("GET", `/orders/${legacyId}/credit-notes/${new mongoose.Types.ObjectId()}.pdf`, { token: ob.token });
  check(res.status === 404, "unknown credit note → 404");
  res = await call("GET", `/orders/${legacyId}/credit-notes/${note._id}.pdf`, { token: rb.token });
  check(res.status === 404, "another buyer's order → 404");

  /* ------------------------------------------------------------------ 7. ledger entries paging */
  console.log("\n# ledger entries");
  const t0 = Date.now();
  await LedgerEntry.collection.insertMany(
    Array.from({ length: 25 }, (_, i) => ({ userId: ob.user._id, tenantId: a.tenant._id, type: "debit", amount: i + 1, balanceAfter: 0, createdAt: new Date(t0 - i * 1000) }))
  );
  res = await call("GET", "/ledger/me", { token: ob.token });
  check(res.status === 200 && res.data.entries.length === 20 && res.data.entriesMeta.total === 25 && res.data.entriesMeta.hasMore === true, "default: 20 entries + meta");
  res = await call("GET", "/ledger/me?page=2&limit=10", { token: ob.token });
  check(res.data.entries.length === 10 && res.data.entries[0].amount === 11 && res.data.entriesMeta.pages === 3, "page 2 of 10");
  const cursor = res.data.entriesMeta.nextBefore;
  res = await call("GET", `/ledger/me?before=${cursor}&limit=10`, { token: ob.token });
  check(res.data.entries.length === 5 && res.data.entries[0].amount === 21 && res.data.entriesMeta.hasMore === false && res.data.entriesMeta.nextBefore === null, "before cursor continues after page 2");
  res = await call("GET", "/ledger/me?before=nonsense", { token: ob.token });
  check(res.status === 400, "bad cursor → 400");

  /* ------------------------------------------------------------------ 8. register / profile */
  console.log("\n# register businessType / GSTIN");
  check(isValidGstin("27AAPFU0939F1ZV") && !isValidGstin("27AAPFU0939F1ZX") && !isValidGstin("99AAPFU0939F1ZV"), "GSTIN check digit + state code");
  res = await call("POST", "/auth/register", { json: { name: "Kirana One", email: "k1@sf3.test", password: "password123", businessType: "Retailer", gstin: "27aapfu0939f1zv" } });
  const k1 = await User.findOne({ email: "k1@sf3.test" }).lean();
  check(res.status === 201 && k1?.profile.businessType === "kirana" && k1.profile.gstin === "27AAPFU0939F1ZV", "register stores businessType (alias normalised) and GSTIN");
  res = await call("POST", "/auth/register", { json: { name: "Bad Gst", email: "k2@sf3.test", password: "password123", gstin: "27AAPFU0939F1ZX" } });
  check(res.status === 400 && res.data.fields?.gstin, "invalid GSTIN check digit → 400 fields.gstin");
  res = await call("POST", "/auth/register", { json: { name: "Bad Type", email: "k3@sf3.test", password: "password123", businessType: "spaceship" } });
  check(res.status === 400 && res.data.fields?.businessType, "unknown businessType → 400");
  res = await call("PATCH", "/auth/me", { token: ob.token, json: { businessType: "restaurant", gstin: "29AAGCB7383J1Z4" } });
  check(res.status === 200 && res.data.businessType === "horeca" && res.data.gstin === "29AAGCB7383J1Z4" && res.data.profile.businessType === "horeca", "PATCH /auth/me sets and returns them");
  res = await call("PATCH", "/auth/me", { token: ob.token, json: { profile: { gstin: "" } } });
  check(res.status === 200 && res.data.gstin === "" && res.data.businessType === "horeca", "GSTIN can be cleared via profile");

  /* ------------------------------------------------------------------ 9. addresses */
  console.log("\n# address state normalisation");
  check(normalizeIndianState("dl").state === "Delhi" && normalizeIndianState("New Delhi").stateCode === "DL" && normalizeIndianState("Orissa").state === "Odisha" && normalizeIndianState("TS").stateCode === "TG", "normalizeIndianState: codes, aliases, old names");
  check(normalizeIndianState("Atlantis").stateCode === null && normalizeIndianState("Atlantis").state === "Atlantis", "unknown state kept, code null");
  res = await call("POST", "/addresses", { token: ob.token, json: { contactName: "A", phone: "9999999999", addressLine1: "1 Rd", city: "Delhi", state: "DL", postalCode: "110001" } });
  check(res.status === 201 && res.data.state === "Delhi" && res.data.stateCode === "DL", `POST /addresses normalises "DL" (${res.status} ${res.data.state}/${res.data.stateCode})`);
  res = await call("PATCH", `/addresses/${res.data._id}`, { token: ob.token, json: { state: "karnataka" } });
  check(res.status === 200 && res.data.state === "Karnataka" && res.data.stateCode === "KA", "PATCH normalises too");
  const rawAddr = await Address.collection.insertOne({ userId: ob.user._id, contactName: "B", phone: "1", addressLine1: "x", city: "Chennai", state: "tamilnadu", postalCode: "600001" });
  const oddAddr = await Address.collection.insertOne({ userId: ob.user._id, contactName: "C", phone: "1", addressLine1: "x", city: "?", state: "Atlantis", postalCode: "600001" });
  let n = await normalizeAddressStates();
  const fixed = await Address.collection.findOne({ _id: rawAddr.insertedId });
  const odd = await Address.collection.findOne({ _id: oddAddr.insertedId });
  check(n >= 2 && fixed.state === "Tamil Nadu" && fixed.stateCode === "TN" && odd.stateCode === null && odd.state === "Atlantis", "migration normalises existing addresses");
  n = await normalizeAddressStates();
  check(n === 0, "address migration is idempotent");

  /* ------------------------------------------------------------------ 10. CMS defaults */
  console.log("\n# CMS defaults: templated, seed-hashed, returns alias");
  await Settings.create({ scope: "platform", tenantId: null, key: "platform.supportEmail", value: "help@shop.test" });
  await Settings.create({ scope: "platform", tenantId: null, key: "delivery.etaDays", value: { etaDaysMin: 2, etaDaysMax: 4 } });
  await Settings.create({ scope: "platform", tenantId: null, key: "returns.windowDays", value: 10 });
  invalidateSettingCache();
  invalidatePlatformEta();
  await CmsPage.deleteMany({ tenantId: null });
  const legacyPage = (slug, content, type = "custom") =>
    CmsPage.create({ tenantId: null, slug, type, status: "published", ...content });
  await legacyPage("help", LEGACY_DEMO_GLOBAL.help[0], "faq");
  await legacyPage("returns", LEGACY_DEMO_GLOBAL.returns[0]);
  await legacyPage("shipping", { title: "Shipping", sections: [{ kind: "html", html: "<p>Our own words</p>" }] }, "shipping");
  let out = await ensureDefaultCmsPages({ details: true });
  check(out.updated.sort().join(",") === "help,returns" && out.created.includes("refunds") && !out.created.includes("returns"), `old demo help/returns updated, refunds created (${JSON.stringify(out)})`);
  const shipping = await CmsPage.findOne({ tenantId: null, slug: "shipping" }).lean();
  check(shipping.sections[0].html === "<p>Our own words</p>" && !shipping.seedHash, "admin-authored page kept");
  const helpRaw = await CmsPage.findOne({ tenantId: null, slug: "help" }).lean();
  check(JSON.stringify(helpRaw.sections).includes("{{supportEmail}}") && helpRaw.seedSource === "defaults" && helpRaw.version === 1, "stored content keeps tokens; version bumped");

  res = await call("GET", "/cms/pages/help");
  let body = JSON.stringify(res.data);
  check(res.status === 200 && body.includes("help@shop.test") && body.includes("2–4 days") && body.includes("within 10 days") && !body.includes("{{"), "public help page filled from settings");
  check(!body.includes("msrmarket") && !body.includes("1–3") && !/Refunds go to the original payment method/.test(body), "no hard-coded email / 1–3 days / blanket refund claim");
  check(!("seedHash" in res.data), "seed fields not exposed publicly");
  res = await call("GET", "/cms/pages/refunds");
  body = JSON.stringify(res.data);
  check(body.includes("original payment method") && body.includes("credited back to your account") && body.includes("Cash on delivery") && body.includes("help@shop.test"), "refund destinations per payment method");
  res = await call("GET", `/cms/pages/shipping?tenantId=${a.tenant._id}`);
  check(res.status === 200 && res.data.sections[0].html === "<p>Our own words</p>", "store context falls back to global page");
  await Tenant.updateOne({ _id: a.tenant._id }, { $set: { deliveryZones: [{ name: "Pune", pincodes: ["411001"], etaDaysMin: 1, etaDaysMax: 2 }] } });
  res = await call("GET", `/cms/pages/help?tenantId=${a.tenant._id}`);
  check(JSON.stringify(res.data).includes("1–2 days"), "with a store, {{etaDays}} uses its delivery zones");

  // returns ↔ refunds alias
  res = await call("GET", "/cms/pages/returns");
  check(res.status === 200 && res.data.slug === "returns" && !res.data.aliasOf, "an existing returns page is served as is");
  await CmsPage.deleteOne({ tenantId: null, slug: "returns" });
  res = await call("GET", "/cms/pages/returns");
  check(res.status === 200 && res.data.slug === "refunds" && res.data.aliasOf === "refunds" && res.data.requestedSlug === "returns", "returns resolves to refunds (aliasOf)");
  out = await ensureDefaultCmsPages({ details: true });
  check(!(await CmsPage.exists({ tenantId: null, slug: "returns" })) && out.created.length === 0 && out.updated.length === 0, "returns is never created; second run is a no-op");

  // seed hash: an unedited page from an older seed version is updated, an edited one is not
  const older = { title: "Returns & refunds", sections: [{ kind: "html", html: "<p>Old seed v1</p>" }] };
  await CmsPage.updateOne({ tenantId: null, slug: "refunds" }, { $set: { ...older, seedHash: cmsContentHash(older), seedSource: "defaults" } });
  out = await ensureDefaultCmsPages({ details: true });
  let refunds = await CmsPage.findOne({ tenantId: null, slug: "refunds" }).lean();
  check(out.updated.includes("refunds") && refunds.sections[0].html.includes("{{returnWindowDays}}"), "unedited older seed content updated");
  await CmsPage.updateOne({ tenantId: null, slug: "refunds" }, { $set: { sections: [{ kind: "html", html: "<p>Edited by admin</p>" }] } });
  out = await ensureDefaultCmsPages({ details: true });
  refunds = await CmsPage.findOne({ tenantId: null, slug: "refunds" }).lean();
  check(!out.updated.includes("refunds") && refunds.sections[0].html === "<p>Edited by admin</p>", "edited page (hash ≠ seedHash) never overwritten");

  // demo seed takes over unedited defaults pages; defaults then leave them alone (no flip-flop)
  const about = DEFAULT_CMS_PAGES.find((p) => p.slug === "about");
  let r = await upsertSeedPage({ tenantId: null, slug: "about" }, { title: "About MS₹", type: "custom", html: "<p>Demo about</p>" }, { source: "demo", takeOver: ["defaults"] });
  check(r === "updated", "demo seed takes over an unedited default page");
  out = await ensureDefaultCmsPages({ details: true });
  const aboutNow = await CmsPage.findOne({ tenantId: null, slug: "about" }).lean();
  check(aboutNow.title === "About MS₹" && aboutNow.seedSource === "demo" && !out.updated.includes("about"), "defaults do not revert the demo page");
  r = await upsertSeedPage({ tenantId: null, slug: "shipping" }, { title: "Shipping", type: "shipping", html: "<p>demo</p>" }, { source: "demo", takeOver: ["defaults"] });
  check(r === "kept", "demo never overwrites an admin-authored page");
  check(Boolean(about), "about is a default page");

  // migration wiring
  // (orders created above with Order.create and no slug / image get backfilled here)
  let mig = await runStorefrontMigrations();
  check(Array.isArray(mig.cmsCreated) && Array.isArray(mig.cmsUpdated) && mig.orderItemsBackfilled > 0 && mig.addressesNormalized === 0, "runStorefrontMigrations runs the backfill");
  mig = await runStorefrontMigrations();
  check(mig.cmsCreated.length === 0 && mig.cmsUpdated.length === 0 && mig.orderItemsBackfilled === 0 && mig.addressesNormalized === 0, `second run is a no-op ${JSON.stringify(mig)}`);
  const bulkOrder = await Order.findById(reOrder._id).lean();
  check(bulkOrder.items[0].slug === bulkP.slug && bulkOrder.items[2].slug === deadP.slug, "backfill also covers archived products (slug kept for history)");

  server.close();
  await teardown();
  finish("storefront3");
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
});
