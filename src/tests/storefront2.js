/**
 * Storefront support, part 2: delivery-partner name mojibake repair, store cards on cart /
 * checkout groups, search seller / packSize / minDiscount filters + facets, platform delivery
 * estimate, PIN code lookup, default CMS policy pages and the buyer's restock-alert list.
 * Mounts the real /api/v1 router on a mini app.
 *
 * Throwaway local replica set only (the database is dropped):
 *   NODE_ENV=test MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_sf2?replicaSet=rs0" node src/tests/storefront2.js
 */
import express from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { setup, teardown, makeStore, makeBuyer, check, finish } from "./commerceFixtures.js";
import { signAccessToken } from "../utils/tokens.js";
import { errorHandler, notFound } from "../middleware/error.js";
import { ensureSystemRoles } from "../seeds/index.js";
import { runStorefrontMigrations } from "../seeds/migrations.js";
import { ensureDefaultCmsPages, DEFAULT_CMS_PAGES } from "../seeds/cmsDefaults.js";
import v1 from "../routes/v1.js";
import { Role } from "../modules/rbac/role.model.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Category } from "../modules/catalog/category.model.js";
import { RestockAlert } from "../modules/catalog/restockAlert.model.js";
import { CmsPage } from "../modules/cms/cmsPage.model.js";
import { Settings } from "../modules/settings/settings.model.js";
import { Order } from "../modules/orders/order.model.js";
import { setAvailableQty } from "../modules/inventory/service.js";
import { invalidateActiveTenants } from "../modules/catalog/service.js";
import { invalidateSettingCache } from "../modules/settings/service.js";
import { invalidatePlatformEta } from "../modules/settings/commerce.js";
import { settingDefinition } from "../modules/settings/registry.js";
import { DEFAULT_PARTNER_NAME } from "../modules/settings/defaults.js";
import { repairMojibake, hasMojibake } from "../utils/mojibake.js";
import { lookupPincodeOffline } from "../modules/location/pincode.js";

if (!/127\.0\.0\.1:27027\/msp_test_[a-z0-9_]+(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at a local msp_test_* database");
  process.exit(2);
}

const PORT = 4313;
const base = `http://127.0.0.1:${PORT}/api/v1`;

async function call(method, path, { token, json } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
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
  return { status: res.status, data };
}

const tokenFor = (user) =>
  signAccessToken({ sub: String(user._id), tenantId: user.tenantId ? String(user.tenantId) : null, tv: user.tokenVersion || 0 });

async function asBuyer(buyerRole, buyer, extra = {}) {
  await User.updateOne({ _id: buyer.user._id }, { $set: { roleId: buyerRole._id, status: "active", emailVerified: true, ...extra } });
  const user = await User.findById(buyer.user._id);
  return { ...buyer, doc: user, token: tokenFor(user) };
}

const RUPEE = String.fromCharCode(0x20b9);
const GARBLED = `MS${String.fromCharCode(0xe2, 0x201a, 0xb9)} Delivery`; // "MS₹" decoded as cp1252

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
  const c = await makeStore({ stock: 0, price: 80 });
  await Tenant.updateOne(
    { _id: a.tenant._id },
    { $set: { name: "Alpha Traders", slug: "alpha-traders", status: "active", "pickupAddress.city": "Pune", "branding.logo": "/uploads/alpha.png" } }
  );
  await Tenant.updateOne({ _id: b.tenant._id }, { $set: { name: "Beta Mart", slug: "beta-mart", status: "active", "pickupAddress.city": "Mumbai" } });
  await Tenant.updateOne({ _id: c.tenant._id }, { $set: { name: "Gamma Store", slug: "gamma-store", status: "active" } });
  invalidateActiveTenants();
  await Settings.create({ scope: "tenant", tenantId: a.tenant._id, key: "store.displayName", value: "Alpha Wholesale" });

  const cat = await Category.create({ name: "Grains", slug: `grains-${Date.now()}` });
  const cat2 = await Category.create({ name: "Oils", slug: `oils-${Date.now()}` });
  // Store A: 1 kg + 5 kg packs, 20% off on the 1 kg pack.
  await Product.updateOne({ _id: a.product._id }, { $set: { name: "Wheat Atta", categoryId: cat._id } });
  await ProductVariant.updateOne({ _id: a.variant._id }, { $set: { listPrice: 250, sellingPrice: 200, "attributes.packSize": "1 kg" } });
  const a5 = await ProductVariant.create({
    tenantId: a.tenant._id,
    productId: a.product._id,
    sku: `A5-${Date.now()}`,
    listPrice: 900,
    sellingPrice: 880,
    attributes: { packSize: "5 KG" },
  });
  await setAvailableQty({ tenantId: a.tenant._id, variantId: a5._id, warehouseId: a.warehouse._id, qty: 5 });
  // Store B: 5 kg pack, 5% off.
  await Product.updateOne({ _id: b.product._id }, { $set: { name: "Rice Sona", categoryId: cat._id } });
  await ProductVariant.updateOne({ _id: b.variant._id }, { $set: { listPrice: 105, sellingPrice: 100, "attributes.packSize": "5kg" } });
  // Store C: 1 litre, 50% off, out of stock.
  await Product.updateOne({ _id: c.product._id }, { $set: { name: "Mustard Oil", categoryId: cat2._id } });
  await ProductVariant.updateOne({ _id: c.variant._id }, { $set: { listPrice: 160, sellingPrice: 80, "attributes.packSize": "1 L" } });

  const alice = await asBuyer(buyerRole, await makeBuyer());
  const bob = await asBuyer(buyerRole, await makeBuyer());
  const productA = await Product.findById(a.product._id);

  /* ------------------------------------------------------------------ 1. mojibake */
  console.log("\n# delivery partner name (mojibake)");
  check(DEFAULT_PARTNER_NAME === `MS${RUPEE} Delivery`, "default partner name is MS₹ Delivery (U+20B9)");
  check(hasMojibake(GARBLED) && repairMojibake(GARBLED) === DEFAULT_PARTNER_NAME, "repairMojibake: MSâ‚¹ Delivery -> MS₹ Delivery");
  check(repairMojibake("भाव भी भरोसा भी") === "भाव भी भरोसा भी" && repairMojibake("Café") === "Café" && repairMojibake(`${RUPEE}180/kg`) === `${RUPEE}180/kg`, "valid text is never changed");
  let res = await call("GET", "/settings/public");
  check(res.data.deliveryPartners?.[0]?.name === DEFAULT_PARTNER_NAME && res.data.delivery?.defaultPartner?.name === DEFAULT_PARTNER_NAME, "public settings: default partner name (registry default)");

  await Settings.create({
    scope: "platform",
    tenantId: null,
    key: "platform.deliveryPartners",
    value: [
      { id: "msp", name: GARBLED, fee: 0, isDefault: true },
      { id: "delhivery", name: "Delhivery", fee: 40, isDefault: false },
    ],
  });
  await Settings.create({ scope: "platform", tenantId: null, key: "platform.slogan", value: "भाव भी भरोसा भी" });
  const garbledOrderId = new mongoose.Types.ObjectId();
  await Order.collection.insertOne({ _id: garbledOrderId, orderNumber: "ORD-MOJIBAKE1", deliveryPartner: { id: "msp", name: GARBLED, fee: 0 } });
  invalidateSettingCache();
  res = await call("GET", "/settings/public");
  check(res.data.deliveryPartners?.[0]?.name === DEFAULT_PARTNER_NAME, "public settings repair a stored garbled name at read time");
  res = await call("GET", `/products/lookup?slug=${productA.slug}`);
  check(res.data.delivery?.defaultPartner?.name === DEFAULT_PARTNER_NAME, "product lookup: default partner name repaired");

  let mig = await runStorefrontMigrations();
  const stored = await Settings.findOne({ scope: "platform", key: "platform.deliveryPartners" }).lean();
  check(mig.settingsFixed === 1 && stored.value[0].name === DEFAULT_PARTNER_NAME && stored.value[1].name === "Delhivery", "migration rewrites the stored setting (other rows untouched)");
  check((await Settings.findOne({ key: "platform.slogan" }).lean()).value === "भाव भी भरोसा भी", "migration leaves valid Hindi text alone");
  check(mig.ordersFixed === 1 && (await Order.collection.findOne({ _id: garbledOrderId })).deliveryPartner.name === DEFAULT_PARTNER_NAME, "migration repairs order delivery-partner snapshots");
  mig = await runStorefrontMigrations();
  check(mig.settingsFixed === 0 && mig.ordersFixed === 0 && mig.cmsCreated.length === 0, "migration is idempotent (second run changes nothing)");
  await Order.collection.deleteOne({ _id: garbledOrderId });

  /* ------------------------------------------------------------------ 6. CMS defaults */
  console.log("\n# default CMS pages");
  // (The first migration run above already created them.) Fresh check: remove all, pre-create an edited "terms".
  await CmsPage.deleteMany({ tenantId: null });
  await CmsPage.create({ tenantId: null, slug: "terms", title: "Our real terms", type: "terms", status: "published", sections: [{ kind: "html", html: "<p>Real</p>" }] });
  let created = await ensureDefaultCmsPages();
  check(
    created.sort().join(",") === ["about", "grievance", "help", "privacy", "refunds", "shipping"].join(","),
    `missing pages created, existing "terms" skipped (${created.join(",")})`
  );
  const terms = await CmsPage.findOne({ tenantId: null, slug: "terms" }).lean();
  check(terms.title === "Our real terms" && terms.sections[0].html === "<p>Real</p>", "existing page not overwritten");
  await CmsPage.updateOne({ tenantId: null, slug: "grievance" }, { $set: { title: "Grievance officer", sections: [{ kind: "html", html: "<p>Ms. A</p>" }] } });
  created = await ensureDefaultCmsPages();
  const grievance = await CmsPage.findOne({ tenantId: null, slug: "grievance" }).lean();
  check(created.length === 0 && grievance.title === "Grievance officer" && grievance.sections[0].html === "<p>Ms. A</p>", "second run is a no-op; edited page kept");
  await CmsPage.updateOne({ tenantId: null, slug: "grievance" }, { $set: { sections: [{ kind: "html", html: DEFAULT_CMS_PAGES[0].html }] } });
  res = await call("GET", "/cms/pages/grievance");
  const html = JSON.stringify(res.data);
  check(res.status === 200 && html.includes("[Grievance officer name]") && html.includes("To be completed"), "GET /cms/pages/grievance: published placeholder that clearly needs filling in");
  res = await call("GET", "/cms/pages/about");
  check(res.status === 200, "about page is public");

  /* ------------------------------------------------------------------ 2. store cards */
  console.log("\n# store info on cart / checkout groups");
  res = await call("POST", "/cart/items", { token: alice.token, json: { variantId: String(a.variant._id), qty: 1 } });
  res = await call("POST", "/cart/items", { token: alice.token, json: { variantId: String(b.variant._id), qty: 1 } });
  check(res.status === 200 && res.data.groups?.length === 2, `cart has two store groups (${res.status} ${res.data?.message || ""})`);
  const ga = res.data.groups.find((g) => String(g.tenantId) === String(a.tenant._id));
  const gb = res.data.groups.find((g) => String(g.tenantId) === String(b.tenant._id));
  check(
    ga?.store && String(ga.store.id) === String(a.tenant._id) && ga.store.name === "Alpha Traders" && ga.store.displayName === "Alpha Wholesale" &&
      ga.store.slug === "alpha-traders" && ga.store.city === "Pune" && ga.store.logo === "/uploads/alpha.png",
    "cart group store {id, name, displayName, slug, city, logo}"
  );
  check(gb?.store?.displayName === "Beta Mart" && gb.store.logo === "" && gb.store.city === "Mumbai", "displayName falls back to the store name");
  res = await call("GET", "/cart", { token: alice.token });
  check(res.data.groups.every((g) => g.store?.slug), "GET /cart groups carry store");
  res = await call("POST", "/checkout/preview", { token: alice.token, json: { addressId: String(alice.address._id) } });
  check(res.status === 200 && res.data.groups.every((g) => g.store?.displayName && "city" in g.store && "logo" in g.store), `checkout preview groups carry store (${res.status})`);
  res = await call("GET", `/checkout/payment-options?addressId=${alice.address._id}`, { token: alice.token });
  const poA = res.data.groups?.find((g) => String(g.tenantId) === String(a.tenant._id));
  check(res.status === 200 && poA?.store?.displayName === "Alpha Wholesale" && poA.store.city === "Pune" && poA.store.logo === "/uploads/alpha.png", "payment-options groups carry the full store card");

  /* ------------------------------------------------------------------ 3. search */
  console.log("\n# search: seller / packSize / minDiscount + facets");
  const ids = (r) => (r.data.data || []).map((p) => String(p._id)).sort().join(",");
  const idOf = (...stores) => stores.map((s) => String(s.product._id)).sort().join(",");
  res = await call("GET", "/products/search");
  check(res.data.meta.total === 3, "baseline: 3 products");
  res = await call("GET", "/products/search?seller=alpha-traders");
  check(ids(res) === idOf(a), "seller by slug");
  res = await call("GET", `/products/search?seller=${b.tenant._id},gamma-store`);
  check(ids(res) === idOf(b, c), "seller comma list (id + slug)");
  res = await call("GET", "/products/search?tenantId=beta-mart");
  check(ids(res) === idOf(b), "tenantId accepts a slug");
  res = await call("GET", `/products/search?tenantId=${a.tenant._id}`);
  check(ids(res) === idOf(a), "tenantId by id still works");
  res = await call("GET", "/products/search?seller=nope");
  check(res.data.meta.total === 0, "unknown seller -> no results");
  res = await call("GET", "/products/search?packSize=5kg");
  check(ids(res) === idOf(a, b), "packSize 5kg matches '5 KG' and '5kg'");
  const rowA = res.data.data.find((p) => String(p._id) === String(a.product._id));
  check(rowA?.variants?.length === 1 && rowA.variants[0].attributes.packSize === "5 KG" && rowA.minPrice === 880, "only matching variants are returned (price summary follows)");
  res = await call("GET", "/products/search?packSize=1 kg,1l");
  check(ids(res) === idOf(a, c), "packSize comma list");
  res = await call("GET", "/products/search?minDiscount=15");
  check(ids(res) === idOf(a, c), "minDiscount=15 (20% and 50% off)");
  res = await call("GET", "/products/search?minDiscount=30&inStock=1");
  check(res.data.meta.total === 0, "minDiscount + inStock combine");
  res = await call("GET", "/products/search?minDiscount=abc");
  check(res.status === 400 && res.data.code === "VALIDATION_ERROR", "invalid minDiscount -> 400");

  res = await call("GET", "/products/search?facets=1");
  let fx = res.data.facets;
  const count = (list, key, value) => list?.find((x) => x[key] === value)?.count;
  check(fx?.sellers?.length === 3 && count(fx.sellers, "slug", "alpha-traders") === 1 && fx.sellers.every((s) => s.id && s.name), "facets.sellers [{id, name, slug, count}]");
  check(count(fx.categories, "name", "Grains") === 2 && count(fx.categories, "name", "Oils") === 1, "facets.categories [{id, name, slug, count}]");
  check(fx.packSizes?.find((p) => p.value.toLowerCase().replace(/ /g, "") === "5kg")?.count === 2 && count(fx.packSizes, "value", "1 kg") === 1 && count(fx.packSizes, "value", "1 L") === 1, "facets.packSizes [{value, count}] (one count per product)");
  check(count(fx.discounts, "min", 10) === 2 && count(fx.discounts, "min", 50) === 1 && fx.discounts.every((d) => d.label), "facets.discounts buckets");
  check(fx.inStock === 2, "facets.inStock count");
  check(Array.isArray(fx.brands) && fx.priceRange?.min === 80, "brands + priceRange still present");
  res = await call("GET", "/products/search?facets=1&seller=alpha-traders&packSize=5kg");
  fx = res.data.facets;
  check(res.data.meta.total === 1 && fx.sellers.length === 2, "seller facet ignores the seller filter (other filters apply)");
  check(fx.packSizes.length === 2 && count(fx.packSizes, "value", "1 kg") === 1, "pack facet ignores the pack filter");
  check(fx.categories.length === 1 && count(fx.categories, "name", "Grains") === 1, "category facet follows the current query");
  res = await call("GET", `/products/search?facets=1&categoryId=${cat2._id}`);
  check(res.data.meta.total === 1 && res.data.facets.categories.length === 2, "category facet ignores the category filter");

  /* ------------------------------------------------------------------ 4. platform ETA */
  console.log("\n# platform delivery estimate");
  invalidatePlatformEta();
  res = await call("GET", "/settings/public");
  check(res.data.delivery?.etaDaysMin === 2 && res.data.delivery.etaDaysMax === 7 && res.data.delivery.etaSource === "default", "no zones anywhere -> registry default 2-7");
  await Tenant.updateOne({ _id: a.tenant._id }, { $set: { deliveryZones: [{ name: "Local", pincodes: ["400001"], deliveryFee: 40, etaDaysMin: 1, etaDaysMax: 2 }] } });
  await Tenant.updateOne(
    { _id: b.tenant._id },
    {
      $set: {
        deliveryZones: [
          { name: "City", pincodes: ["400002"], deliveryFee: 30, etaDaysMin: 2, etaDaysMax: 4 },
          { name: "State", deliveryFee: 60, etaDaysMin: 3, etaDaysMax: 6 },
        ],
      },
    }
  );
  invalidatePlatformEta();
  res = await call("GET", "/settings/public");
  check(res.data.delivery.etaDaysMin === 1 && res.data.delivery.etaDaysMax === 4 && res.data.delivery.etaSource === "stores", "aggregate over active stores' zones: fastest min, median max (1-4)");
  await Settings.create({ scope: "platform", tenantId: null, key: "delivery.etaDays", value: { etaDaysMin: 1, etaDaysMax: 3 } });
  invalidateSettingCache();
  res = await call("GET", "/settings/public");
  check(res.data.delivery.etaDaysMin === 1 && res.data.delivery.etaDaysMax === 3 && res.data.delivery.etaSource === "setting", "platform setting delivery.etaDays wins");
  res = await call("GET", `/settings/public?tenantId=${a.tenant._id}`);
  check(res.data.delivery.etaDaysMin === 1 && res.data.delivery.etaDaysMax === 2 && res.data.delivery.etaSource === "zones", "with a store, the store's zones apply");
  const def = settingDefinition("delivery.etaDays");
  check(
    def?.default?.etaDaysMin === 2 && def.public && !def.schema.safeParse({ etaDaysMin: 5, etaDaysMax: 2 }).success && def.schema.safeParse({ etaDaysMin: 1, etaDaysMax: 3 }).success,
    "registry: delivery.etaDays with default and min<=max validation"
  );

  /* ------------------------------------------------------------------ 7. restock alerts */
  console.log("\n# buyer restock alerts");
  const cProduct = await Product.findById(c.product._id);
  res = await call("POST", `/products/${cProduct.slug}/notify-restock`, { token: alice.token, json: { variantId: String(c.variant._id) } });
  check(res.status === 201, `alice subscribes to a variant (${res.status} ${res.data?.message || ""})`);
  res = await call("POST", `/products/${productA.slug}/notify-restock`, { token: alice.token, json: {} });
  check(res.status === 201, "alice subscribes to any variant of product A");
  await RestockAlert.create({ tenantId: b.tenant._id, productId: b.product._id, variantId: null, email: alice.doc.email, confirmed: true });
  await RestockAlert.create({ tenantId: b.tenant._id, productId: b.product._id, variantId: null, userId: bob.user._id, confirmed: true });
  res = await call("GET", "/products/restock-alerts/mine", { token: alice.token });
  const mine = res.data.data || [];
  check(res.status === 200 && mine.length === 3 && res.data.meta.total === 3, "GET mine: alice's account + verified-email alerts, not bob's");
  const onC = mine.find((r) => String(r.productId) === String(c.product._id));
  check(
    onC?.status === "active" && onC.product?.name === "Mustard Oil" && onC.product.slug === cProduct.slug && onC.variant?.sku === c.variant.sku && onC.variant.packSize === "1 L" && onC.inStock === false && onC.channel === "account",
    "row: status, product, variant (packSize), inStock"
  );
  const onA = mine.find((r) => String(r.productId) === String(a.product._id));
  check(onA?.variant === null && onA.inStock === true, "product-level alert: variant null, inStock from all variants");
  check(mine.find((r) => String(r.productId) === String(b.product._id))?.channel === "email", "guest alert for the verified email listed as channel email");
  await RestockAlert.updateOne({ _id: onC.id }, { $set: { notifiedAt: new Date() } });
  res = await call("GET", "/products/restock-alerts/mine?status=notified", { token: alice.token });
  check(res.data.data.length === 1 && res.data.data[0].status === "notified", "status filter");
  res = await call("DELETE", `/products/restock-alerts/${onC.id}`, { token: bob.token });
  check(res.status === 404, "another buyer cannot delete it (404)");
  res = await call("DELETE", `/products/restock-alerts/${onC.id}`, { token: alice.token });
  check(res.status === 200 && res.data.deleted === true && !(await RestockAlert.findById(onC.id)), "DELETE unsubscribes");
  res = await call("DELETE", `/products/restock-alerts/${onC.id}`, { token: alice.token });
  check(res.status === 404, "deleting again -> 404");
  res = await call("DELETE", "/products/restock-alerts/xyz", { token: alice.token });
  check(res.status === 400, "invalid id -> 400");
  res = await call("GET", "/products/restock-alerts/mine");
  check(res.status === 401, "GET mine requires auth");

  /* ------------------------------------------------------------------ 5. PIN code lookup */
  console.log("\n# PIN code lookup");
  res = await call("GET", "/location/pincode/400001");
  check(
    res.status === 200 && res.data.pincode === "400001" && res.data.city === "Mumbai" && res.data.state === "Maharashtra" && res.data.stateCode === "MH" && res.data.approximate === true,
    "400001 -> Mumbai, Maharashtra (MH), approximate"
  );
  check("district" in res.data, "district field present");
  const probe = (pin) => lookupPincodeOffline(pin);
  check(probe("110001").city === "New Delhi" && probe("110001").stateCode === "DL", "110001 -> New Delhi, DL");
  check(probe("403001").stateCode === "GA" && probe("560034").city === "Bengaluru" && probe("834001").stateCode === "JH", "Goa / Bengaluru / Jharkhand exceptions");
  check(probe("500032").stateCode === "TG" && probe("793001").state === "Meghalaya" && probe("160017").stateCode === "CH", "Telangana / Meghalaya / Chandigarh");
  const rural = probe("413512");
  check(rural.stateCode === "MH" && rural.city === null && rural.approximate === true, "non-metro PIN: state only, city null");
  check(probe("990001").found === false && probe("990001").state === null, "unknown circle -> found false");
  res = await call("GET", "/location/pincode/012345");
  check(res.status === 400 && res.data.code === "VALIDATION_ERROR", "invalid PIN -> 400");
  let limited = false;
  for (let i = 0; i < 35 && !limited; i += 1) {
    const r = await call("GET", "/location/pincode/400001");
    limited = r.status === 429 && r.data.code === "RATE_LIMIT";
  }
  check(limited, "rate limited (429 RATE_LIMIT)");

  server.close();
  await teardown();
  finish("storefront2");
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
});
