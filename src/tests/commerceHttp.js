/**
 * HTTP-level checks for the commerce routers (orders, reports, ledger, inventory, pricing),
 * mounted on a mini app. Local throwaway replica set only:
 *   MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_be1?replicaSet=rs0" NODE_ENV=test node src/tests/commerceHttp.js
 */
import express from "express";
import mongoose from "mongoose";
import { setup, teardown, makeStore, makeBuyer, check, finish } from "./commerceFixtures.js";
import { signAccessToken } from "../utils/tokens.js";
import { errorHandler } from "../middleware/error.js";
import { ensureSystemRoles } from "../seeds/index.js";
import { Role } from "../modules/rbac/role.model.js";
import { User } from "../modules/users/user.model.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Offer } from "../modules/pricing/offer.model.js";
import { Coupon } from "../modules/pricing/coupon.model.js";
import { PriceList } from "../modules/pricing/priceList.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { deleteVariantInventory, setAvailableQty } from "../modules/inventory/service.js";
import { addItem, getOrCreateCart, quoteCart } from "../modules/cart/service.js";
import { checkout } from "../modules/checkout/service.js";
import { confirmOrder, advanceOrder, requestReturn } from "../modules/orders/lifecycle.js";
import orderRoutes from "../modules/orders/routes.js";
import reportRoutes from "../modules/reports/routes.js";
import ledgerRoutes from "../modules/ledger/routes.js";
import { warehouseRouter, inventoryRouter } from "../modules/inventory/routes.js";
import { pricingRouter, offerRouter, couponRouter } from "../modules/pricing/routes.js";
import { setRazorpayClient } from "../modules/checkout/razorpayApi.js";

const PORT = 4311;
const base = `http://127.0.0.1:${PORT}`;
let server;

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

function tokenFor(user) {
  return signAccessToken({ sub: String(user._id), tenantId: user.tenantId ? String(user.tenantId) : null, tv: user.tokenVersion || 0 });
}

async function staff(tenant, slug, permissions) {
  const role = await Role.create({ name: slug, slug: `${slug}-${tenant._id}`, tenantId: tenant._id, permissions, scope: "tenant" });
  const user = await User.create({
    name: `Staff ${slug}`,
    email: `${slug}-${tenant._id}@test.local`,
    passwordHash: "x",
    roleId: role._id,
    tenantId: tenant._id,
    status: "active",
    emailVerified: true,
  });
  return { user, token: tokenFor(user) };
}

async function asBuyer(buyerRole, buyer, extra = {}) {
  await User.updateOne({ _id: buyer.user._id }, { $set: { roleId: buyerRole._id, status: "active", emailVerified: true, ...extra } });
  const user = await User.findById(buyer.user._id);
  return { ...buyer, doc: user, token: tokenFor(user) };
}

async function place(buyer, variantId, { qty = 1, paymentMethod = "cod" } = {}) {
  await addItem(buyer.user._id, null, { variantId: String(variantId), qty });
  const cart = await getOrCreateCart(buyer.user._id);
  const quote = await quoteCart(cart, buyer.user._id, buyer.address);
  const { orders } = await checkout({
    user: buyer.user,
    addressId: buyer.address._id,
    paymentMethod,
    poNumber: paymentMethod === "purchase_order" ? "PO-H" : undefined,
    idempotencyKey: `k-${Math.random()}`,
    expectedGrandTotal: quote.grandTotal,
  });
  return orders[0];
}

const ids = (res) => (res.data?.data || []).map((o) => String(o._id || o.orderId || o.id));

async function main() {
  await setup();
  setRazorpayClient(null);
  await ensureSystemRoles();
  const app = express();
  app.use(express.json());
  app.use("/orders", orderRoutes);
  app.use("/reports", reportRoutes);
  app.use("/ledger", ledgerRoutes);
  app.use("/warehouses", warehouseRouter);
  app.use("/inventory", inventoryRouter);
  app.use("/pricing", pricingRouter);
  app.use("/offers", offerRouter);
  app.use("/coupons", couponRouter);
  app.use(errorHandler);
  server = app.listen(PORT);

  const buyerRole = await Role.findOne({ slug: "buyer", isSystem: true });
  const superRole = await Role.findOne({ slug: "super_admin", isSystem: true });
  const admin = await User.create({ name: "Admin", email: "admin-h@test.local", passwordHash: "x", roleId: superRole._id, status: "active" });
  const adminTok = tokenFor(admin);

  const a = await makeStore({ stock: 50, price: 100 });
  const b = await makeStore({ stock: 50, price: 100 });
  const viewer = await staff(a.tenant, "viewer", ["orders.view"]);
  const manager = await staff(a.tenant, "manager", [
    "orders.view", "orders.update", "orders.refund", "reports.view", "reports.export", "ledger.view", "ledger.manage",
    "inventory.view", "inventory.adjust", "warehouses.create", "warehouses.edit", "warehouses.view",
    "pricing.view", "coupons.create", "coupons.disable", "offers.create", "pricing.approve",
  ]);
  const disabler = await staff(a.tenant, "disabler", ["pricing.view", "coupons.disable"]);
  const managerB = await staff(b.tenant, "managerb", ["orders.view", "orders.update", "reports.view", "pricing.approve", "pricing.view"]);

  const alice = await asBuyer(buyerRole, await makeBuyer());
  const bob = await asBuyer(buyerRole, await makeBuyer({ state: "Karnataka" }));
  await User.updateOne({ _id: bob.user._id }, { $set: { name: "Bob Unique Name" } });

  /* ------------------------------------------------------------------ orders */
  console.log("\n# order visibility (buyers by role, staff by tenant)");
  const o1 = await place(alice, a.variant._id, { qty: 2 });
  const o2 = await place(bob, a.variant._id, { qty: 5 });
  const o3 = await place(alice, b.variant._id, { qty: 1 });
  // The viewer (staff with only orders.view) also bought something as a buyer elsewhere.
  await Order.collection.insertOne({ ...(await Order.findById(o3._id).lean()), _id: new mongoose.Types.ObjectId(), orderNumber: "ORD-VIEWERS-OWN", buyerId: viewer.user._id, idempotencyKey: "viewer-own" });

  let res = await call("GET", "/orders", { token: viewer.token });
  check(res.status === 200 && ids(res).includes(String(o1._id)) && ids(res).includes(String(o2._id)), "staff with only orders.view sees the store's orders");
  check(!ids(res).includes(String(o3._id)) && res.data.data.every((o) => o.orderNumber !== "ORD-VIEWERS-OWN"), "...and not other stores' or their own purchases");
  res = await call("GET", `/orders/${o1._id}`, { token: viewer.token });
  check(res.status === 200, "staff with orders.view can open a store order");
  res = await call("GET", "/orders", { token: alice.token });
  check(ids(res).length === 2 && ids(res).includes(String(o3._id)) && !ids(res).includes(String(o2._id)), "buyer sees only own orders (both stores)");
  res = await call("GET", `/orders/${o2._id}`, { token: alice.token });
  check(res.status === 404, "buyer cannot open someone else's order");
  res = await call("GET", "/orders?limit=100", { token: adminTok });
  check(ids(res).includes(String(o1._id)) && ids(res).includes(String(o3._id)), "platform admin sees all tenants");
  res = await call("GET", "/orders", { token: managerB.token });
  check(!ids(res).includes(String(o1._id)), "other store's staff do not see store A orders");
  res = await call("POST", `/orders/${o1._id}/status`, { token: viewer.token, json: { status: "confirmed" } });
  check(res.status === 403, `orders.view-only staff cannot change status (${res.status})`);
  res = await call("POST", `/orders/${o1._id}/status`, { token: manager.token, json: { status: "confirmed" } });
  check(res.status === 200 && res.data.status === "confirmed", "manager confirms a store order");

  console.log("\n# order filters, search, sort");
  await Order.updateOne({ _id: o2._id }, { $set: { "items.0.fulfillmentMode": "store_pickup" } });
  await Order.updateOne(
    { _id: o2._id },
    { $push: { refunds: { key: `${o2._id}:x`, provider: "razorpay", paymentId: "pay_x", amount: 10, status: "failed", lastError: "boom" } } }
  );
  const o4 = await place(alice, a.variant._id, { qty: 1 });
  let o4d = await confirmOrder(o4, null);
  for (const step of ["processing", "ready_to_ship", "shipped", "delivered"]) o4d = await advanceOrder(o4d, step, {});
  await requestReturn(o4d, { actorId: alice.user._id, reason: "Wrong item" });

  res = await call("GET", "/orders?fulfillmentMode=store_pickup", { token: manager.token });
  check(ids(res).length === 1 && ids(res)[0] === String(o2._id), "fulfillmentMode filter");
  res = await call("GET", "/orders?refundStatus=failed", { token: manager.token });
  check(ids(res).length === 1 && ids(res)[0] === String(o2._id), "refundStatus=failed filter");
  res = await call("GET", "/orders?queue=returns", { token: manager.token });
  check(ids(res).length === 1 && ids(res)[0] === String(o4._id), "returns queue filter");
  res = await call("GET", "/orders?paymentMethod=cod&paymentStatus=unpaid", { token: manager.token });
  check(res.status === 200 && ids(res).length >= 2 && !ids(res).includes(String(o4._id)), "paymentMethod + paymentStatus filters (delivered COD is paid)");
  res = await call("GET", `/orders?buyerId=${bob.user._id}`, { token: manager.token });
  check(ids(res).length === 1 && ids(res)[0] === String(o2._id), "buyerId filter");
  res = await call("GET", "/orders?q=Bob%20Unique", { token: manager.token });
  check(ids(res).length === 1 && ids(res)[0] === String(o2._id), "q matches buyer name");
  res = await call("GET", `/orders?q=${o1.orderNumber.slice(4, 10)}`, { token: manager.token });
  check(ids(res).includes(String(o1._id)), "q matches order number");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  res = await call("GET", `/orders?from=${today}&to=${today}`, { token: manager.token });
  check(ids(res).length === 3, `from/to (IST day) includes today's orders (${ids(res).length})`);
  res = await call("GET", "/orders?from=2020-01-01&to=2020-01-02", { token: manager.token });
  check(ids(res).length === 0, "from/to excludes other days");
  res = await call("GET", "/orders?sort=grandTotal&order=asc", { token: manager.token });
  const totals = res.data.data.map((o) => o.total);
  check(totals.every((t, i) => i === 0 || totals[i - 1] <= t), `sort=grandTotal asc (${totals.join(",")})`);
  res = await call("GET", "/orders?sort=bogus", { token: manager.token });
  check(res.status === 400, "invalid sort -> 400");
  res = await call("GET", "/orders?status=confirmed,return_requested", { token: manager.token });
  check(ids(res).length === 2, "status accepts a comma list");

  console.log("\n# failed refunds endpoint + retry");
  res = await call("GET", "/orders/refunds", { token: manager.token });
  check(res.status === 200 && res.data.data.length === 1 && res.data.data[0].refund.status === "failed" && res.data.data[0].orderNumber === o2.orderNumber, "GET /orders/refunds lists failed refunds");
  res = await call("GET", "/orders/refunds", { token: viewer.token });
  check(res.status === 403, "refund queue needs orders.refund/update");
  res = await call("GET", "/orders/refunds", { token: alice.token });
  check(res.status === 403, "buyers cannot see the refund queue");
  setRazorpayClient({ createRefund: async () => ({ id: "rfnd_retry", status: "processed" }), createOrder: async () => ({ id: "x" }), listRefunds: async () => ({ items: [] }) });
  res = await call("POST", `/orders/${o2._id}/refunds/${encodeURIComponent(`${o2._id}:x`)}/retry`, { token: manager.token });
  check(res.status === 200 && res.data.refunds[0].status === "processed", `failed refund retried (${res.status} ${res.data?.refunds?.[0]?.status})`);
  setRazorpayClient(null);

  console.log("\n# orders export honours filters");
  res = await call("GET", "/reports/export/orders?q=Bob%20Unique", { token: manager.token });
  check(res.status === 200 && res.data.includes(o2.orderNumber) && !res.data.includes(o1.orderNumber), "export honours q");
  check(res.headers.get("x-export-total") === "1" && !res.headers.get("x-export-truncated"), "export total header, not truncated");
  res = await call("GET", "/reports/export/orders?fulfillmentMode=store_pickup", { token: manager.token });
  check(res.data.split("\n").length === 2, "export honours fulfillmentMode");
  const bulkTenant = await Tenant.create({ name: "Bulk", slug: `bulk-${Date.now()}` });
  const template = await Order.findById(o1._id).lean();
  await Order.collection.insertMany(
    Array.from({ length: 1005 }, (_, i) => ({ ...template, _id: new mongoose.Types.ObjectId(), tenantId: bulkTenant._id, orderNumber: `BULK-${i}`, idempotencyKey: `bulk-${i}` }))
  );
  res = await call("GET", "/reports/export/orders", { token: adminTok, headers: { "X-Tenant-Id": String(bulkTenant._id) } });
  check(res.headers.get("x-export-truncated") === "true" && res.headers.get("x-export-total") === "1005" && res.data.split("\n").length === 1001, "export capped at 1000 with X-Export-Truncated + total");

  /* ------------------------------------------------------------------ ledger */
  console.log("\n# ledger: overpayment becomes advance; duplicate references rejected");
  res = await call("PUT", `/ledger/accounts/${alice.user._id}/terms`, { token: manager.token, json: { creditEnabled: true, purchaseOrderEnabled: true, creditLimit: 1000 } });
  check(res.status === 200 && res.data.creditLimit === 1000 && res.data.available === 1000 && res.data.outstanding === 0 && res.data.advance === 0, "terms response has creditLimit/available/outstanding/advance");
  const credit = await place(alice, a.variant._id, { qty: 3, paymentMethod: "credit_terms" });
  res = await call("GET", `/ledger/accounts/${alice.user._id}`, { token: manager.token });
  check(res.data.outstanding === credit.total && res.data.available === Math.round((1000 - credit.total) * 100) / 100, `order debit raises outstanding (${res.data.outstanding})`);
  res = await call("POST", `/ledger/accounts/${alice.user._id}/payments`, { token: manager.token, json: { amount: credit.total + 500, reference: "UTR 123" } });
  check(
    res.status === 201 && res.data.outstanding === 0 && res.data.available === 1000 && res.data.advance === 500 && res.data.payment.toAdvance === 500,
    `overpayment: dues cleared, 500 advance, available capped at the limit (${JSON.stringify({ o: res.data.outstanding, a: res.data.available, adv: res.data.advance })})`
  );
  res = await call("POST", `/ledger/accounts/${alice.user._id}/payments`, { token: manager.token, json: { amount: 10, reference: "utr  123" } });
  check(res.status === 409 && res.data.code === "DUPLICATE_PAYMENT", `same reference twice -> 409 (${res.status})`);
  res = await call("GET", `/ledger/accounts/${alice.user._id}/statement`, { token: manager.token });
  check(res.status === 200 && res.data.closingAdvance === 500 && res.data.account.advance === 500, "statement shows advance");
  res = await call("GET", "/ledger/me", { token: alice.token });
  check(res.data.advance === 500 && res.data.available === 1000 && res.data.ledgers[0].outstanding === 0, "buyer view has the same figures");
  const usesAdvance = await place(alice, a.variant._id, { qty: 2, paymentMethod: "credit_terms" });
  res = await call("GET", `/ledger/accounts/${alice.user._id}`, { token: manager.token });
  const expectAdvance = Math.round((500 - Math.min(500, usesAdvance.total)) * 100) / 100;
  check(res.data.advance === expectAdvance && res.data.outstanding === Math.round(Math.max(0, usesAdvance.total - 500) * 100) / 100, `next order uses the advance first (advance ${res.data.advance})`);

  /* --------------------------------------------------------------- customers */
  console.log("\n# customers");
  const carol = await asBuyer(buyerRole, await makeBuyer(), { homeTenantId: a.tenant._id, name: "Carol Home" });
  const dave = await asBuyer(buyerRole, await makeBuyer(), { name: "Dave Elsewhere" });
  res = await call("GET", "/reports/customers?sort=orders&order=desc", { token: viewer.token });
  const rows = res.data.data || [];
  check(res.status === 200 && rows[0]?.id === String(alice.user._id) && rows.some((r) => r.id === String(carol.user._id) && r.orders === 0 && r.homeStore), "customers list: sort by orders, home-store buyers included");
  check(rows.find((r) => r.id === String(alice.user._id))?.ledger?.advance !== undefined, "customers list carries ledger figures");
  res = await call("GET", "/reports/customers?q=carol", { token: manager.token });
  check(res.data.meta.total === 1, "customers q search");
  res = await call("GET", `/reports/customers/${alice.user._id}`, { token: viewer.token });
  check(res.status === 200 && res.data.stats.orders >= 3 && res.data.orders.data.length >= 3 && res.data.ledger?.creditLimit === 1000 && res.data.customer.email, "customer detail: profile, stats, orders, ledger");
  res = await call("GET", `/reports/customers/${carol.user._id}`, { token: manager.token });
  check(res.status === 200 && res.data.customer.homeStore && res.data.stats.orders === 0, "home-store buyer visible without orders");
  res = await call("GET", `/reports/customers/${dave.user._id}`, { token: manager.token });
  check(res.status === 404, "unrelated buyer -> 404");
  res = await call("GET", `/reports/customers/${alice.user._id}`, { token: alice.token });
  check(res.status === 403, "buyers cannot use the customers report");

  /* ----------------------------------------------------------------- reports */
  console.log("\n# reports");
  res = await call("GET", "/reports/overview", { token: manager.token });
  check(res.status === 200 && typeof res.data.period.aov === "number" && res.data.changes.gmv === null && res.data.scope === "lifetime", `overview: period.aov, changes null without a previous period (${res.data.changes?.gmv})`);
  res = await call("GET", `/reports/overview?from=2020-01-01&to=2020-01-31`, { token: manager.token });
  check(res.data.scope === "range" && Object.keys(res.data.byStatus).length === 0 && res.data.topSkus.length === 0 && res.data.customers === 0, "overview byStatus/topSkus/customers respect the range");
  res = await call("GET", `/reports/sales?from=2026-01-01&to=2026-01-03`, { token: manager.token });
  check(res.status === 200 && res.data.length === 3 && res.data[0]._id === "2026-01-01" && "aov" in res.data[0], "sales accepts from/to (IST days)");
  res = await call("GET", `/reports/export/sales?from=2026-01-01&to=2026-01-05`, { token: manager.token });
  check(res.status === 200 && res.data.trim().split("\n").length === 6, "sales export accepts from/to");
  res = await call("GET", `/reports/sales?from=2026-02-01&to=2026-01-01`, { token: manager.token });
  check(res.status === 400, "from after to -> 400");
  await User.create({ name: "Gone", email: "gone@test.local", passwordHash: "x", roleId: buyerRole._id, status: "deleted", deletedAt: new Date() });
  res = await call("GET", "/reports/overview", { token: adminTok });
  const live = await User.countDocuments({ status: { $ne: "deleted" }, deletedAt: null });
  check(res.data.users === live && live < (await User.countDocuments({})), `platform users excludes deleted (${res.data.users})`);
  res = await call("GET", "/reports/tenants?sort=gmv", { token: adminTok });
  const rowA = res.data.data?.find((r) => String(r.tenantId) === String(a.tenant._id));
  check(res.status === 200 && rowA && rowA.staffCount === 3 && rowA.ordersCount > 0 && rowA.gmv > 0, `tenants summary (${JSON.stringify(rowA && { s: rowA.staffCount, o: rowA.ordersCount, g: rowA.gmv })})`);
  res = await call("GET", "/reports/tenants", { token: manager.token });
  check(res.status === 403, "tenants summary is platform-only");

  /* --------------------------------------------------------------- inventory */
  console.log("\n# inventory");
  res = await call("POST", "/inventory/set-quantity", { token: manager.token, json: { variantId: String(a.variant._id), warehouseId: String(a.warehouse._id), qty: 40, note: "cycle count" } });
  check(res.status === 200 && res.data.available === 40, `set-quantity sets available (${res.data.available})`);
  res = await call("GET", `/inventory/transactions?variantId=${a.variant._id}&reason=set`, { token: manager.token });
  check(res.data.data.length === 1 && res.data.data[0].note === "cycle count" && res.data.data[0].warehouse?.name === "Main" && res.data.data[0].productName, "set-quantity is recorded; transactions populated + reason filter");
  res = await call("GET", `/inventory/reservations?orderId=${o1._id}`, { token: manager.token });
  check(res.status === 200 && res.data.data.length === 1 && res.data.data[0].orderNumber === o1.orderNumber && res.data.data[0].variant?.sku && res.data.data[0].warehouse?.name, "reservations by orderId, populated");
  res = await call("GET", `/inventory/reservations?status=committed&warehouseId=${a.warehouse._id}`, { token: manager.token });
  check(res.data.data.every((r) => r.status === "committed") && res.data.data.length >= 1, "reservations status + warehouse filters");
  res = await call("GET", `/inventory/transactions?orderId=${o1._id}`, { token: manager.token });
  check(res.data.data.length >= 2 && res.data.data.every((t) => t.orderNumber === o1.orderNumber), `transactions by orderId (${res.data.data.length})`);
  res = await call("GET", `/inventory/transactions?from=2020-01-01&to=2020-01-02`, { token: manager.token });
  check(res.data.data.length === 0, "transactions from/to");
  res = await call("GET", `/inventory/reservations?status=bogus`, { token: manager.token });
  check(res.status === 400, "invalid reservation status -> 400");

  // Archived row: adding stock un-archives it; a deleted variant is rejected.
  const p2 = await Product.create({ tenantId: a.tenant._id, name: "Second", sku: `P2-${Date.now()}`, status: "published", taxClass: { name: "GST18", rate: 18 } });
  const v2 = await ProductVariant.create({ tenantId: a.tenant._id, productId: p2._id, sku: `V2-${Date.now()}`, listPrice: 50, sellingPrice: 50 });
  await setAvailableQty({ tenantId: a.tenant._id, variantId: v2._id, warehouseId: a.warehouse._id, qty: 5 });
  await deleteVariantInventory({ tenantId: a.tenant._id, variantId: v2._id });
  res = await call("GET", `/reports/export/inventory`, { token: manager.token });
  check(res.status === 200 && !res.data.includes(v2.sku) && res.data.includes(a.variant.sku), "inventory export excludes archived rows");
  res = await call("GET", `/reports/export/inventory?q=${encodeURIComponent(v2.sku)}`, { token: manager.token });
  check(res.data.trim().split("\n").length === 1, "inventory export honours q");
  res = await call("POST", "/inventory/adjust", { token: manager.token, json: { warehouseId: String(a.warehouse._id), variantId: String(v2._id), reason: "inward", qty: 7 } });
  check(res.status === 200 && res.data.archived === false && res.data.available === 7, "adjust (+) un-archives an archived row");
  res = await call("GET", `/inventory?variantId=${v2._id}`, { token: manager.token });
  check(res.data.data.length === 1, "un-archived row is listed again");
  await ProductVariant.updateOne({ _id: v2._id }, { $set: { status: "archived", deletedAt: new Date() } });
  res = await call("POST", "/inventory/adjust", { token: manager.token, json: { warehouseId: String(a.warehouse._id), variantId: String(v2._id), reason: "inward", qty: 1 } });
  check(res.status === 409 && res.data.code === "VARIANT_DELETED", "adding stock to a deleted variant -> 409");
  res = await call("POST", "/warehouses", { token: manager.token, json: { name: "Dup", code: "main" } });
  check(res.status === 409 && res.data.message === "Warehouse code already exists", "duplicate warehouse code -> 409");
  const wh2 = await call("POST", "/warehouses", { token: manager.token, json: { name: "Second", code: "SEC" } });
  res = await call("PATCH", `/warehouses/${wh2.data._id}`, { token: manager.token, json: { code: "MAIN" } });
  check(res.status === 409, "renaming a warehouse to an existing code -> 409");

  /* ----------------------------------------------------------------- pricing */
  console.log("\n# pricing, coupons, offers");
  res = await call("POST", "/coupons", { token: manager.token, json: { code: "SAVE10", name: "Save", type: "percent", value: 10 } });
  check(res.status === 201, "coupon created");
  const couponId = res.data._id;
  res = await call("POST", "/coupons", { token: manager.token, json: { code: "save10", name: "Again", type: "percent", value: 5 } });
  check(res.status === 409 && res.data.message === "Coupon code already exists", "duplicate coupon code -> 409");
  await call("POST", "/coupons", { token: manager.token, json: { code: "OTHER", name: "Other", type: "fixed", value: 5 } });
  res = await call("PATCH", `/coupons/${couponId}`, { token: manager.token, json: { code: "OTHER" } });
  check(res.status === 409, "renaming a coupon to an existing code -> 409");
  res = await call("PATCH", `/coupons/${couponId}`, { token: disabler.token, json: { name: "Nope" } });
  check(res.status === 403, "PATCH /coupons needs coupons.edit/create, not coupons.disable");
  res = await call("PATCH", `/coupons/${couponId}`, { token: manager.token, json: { name: "Renamed" } });
  check(res.status === 200 && res.data.name === "Renamed", "PATCH with coupons.create works");
  await call("POST", `/coupons/${couponId}/disable`, { token: disabler.token });
  res = await call("POST", `/coupons/${couponId}/enable`, { token: disabler.token });
  check(res.status === 200 && res.data.status === "active", "disabled coupon re-enabled");
  res = await call("POST", `/coupons/${couponId}/enable`, { token: viewer.token });
  check(res.status === 403, "enable needs a coupon permission");
  res = await call("GET", "/coupons?status=active&q=renamed", { token: manager.token });
  check(res.data.data.length === 1, "coupon list q + status");

  await PriceList.create([
    { tenantId: a.tenant._id, name: "Gold buyers", status: "active", items: [] },
    { tenantId: a.tenant._id, name: "Gold draft", status: "draft", items: [] },
    { tenantId: a.tenant._id, name: "Silver", status: "active", items: [] },
  ]);
  res = await call("GET", "/pricing?q=gold&status=active", { token: manager.token });
  check(res.status === 200 && res.data.length === 1 && res.data[0].name === "Gold buyers", "GET /pricing honours q + status");
  res = await call("GET", "/pricing?status=bogus", { token: manager.token });
  check(res.status === 400, "invalid price list status -> 400");

  const window = { startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 86400000) };
  const offA = await Offer.create({ tenantId: a.tenant._id, name: "A offer", value: 5, status: "pending_approval", ...window });
  const offB = await Offer.create({ tenantId: b.tenant._id, name: "B offer", value: 5, status: "pending_approval", ...window });
  res = await call("GET", "/offers?status=pending_approval", { token: adminTok });
  const offerIds = (res.data.data || []).map((o) => String(o._id));
  check(res.status === 200 && offerIds.includes(String(offA._id)) && offerIds.includes(String(offB._id)), "platform admin lists offers across tenants without X-Tenant-Id");
  check(res.data.data.every((o) => o.tenantId?.name), "offer rows include the tenant name");
  res = await call("GET", `/offers?status=pending_approval&tenantId=${b.tenant._id}`, { token: adminTok });
  check(res.data.data.length === 1 && String(res.data.data[0]._id) === String(offB._id), "?tenantId narrows the platform list");
  res = await call("GET", "/offers", { token: manager.token });
  check(res.data.data.every((o) => String(o.tenantId._id) === String(a.tenant._id)), "staff still see only their store's offers");
  res = await call("POST", `/offers/${offA._id}/approve`, { token: managerB.token });
  check(res.status === 404, "another store cannot approve the offer");
  res = await call("POST", `/offers/${offA._id}/approve`, { token: adminTok });
  check(res.status === 200 && res.data.status === "active", "platform admin approves cross-tenant without X-Tenant-Id");
  res = await call("POST", `/offers/${offA._id}/approve`, { token: adminTok });
  check(res.status === 409, "approving an active offer -> 409");
  res = await call("POST", "/offers", { token: adminTok, json: { name: "x", value: 1, ...window } });
  check(res.status === 400, "platform admin still needs a tenant to create offers");

  finish("commerceHttp");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    server?.close();
    await teardown().catch(() => {});
  });
