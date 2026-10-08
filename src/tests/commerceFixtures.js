/**
 * Shared fixtures for the commerce tests. They need a throwaway replica set:
 *   MONGODB_URI=mongodb://127.0.0.1:27027/msp_test_a?replicaSet=rs0 node src/tests/<file>.js
 * The database is dropped at start, so the URI must point at a test database.
 */
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { connectDb } from "../config/db.js";
import { Tenant } from "../modules/tenants/tenant.model.js";
import { User } from "../modules/users/user.model.js";
import { Role } from "../modules/rbac/role.model.js";
import { ensureSystemRoles } from "../seeds/index.js";
import { SYSTEM_ROLES } from "../config/constants.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { Warehouse } from "../modules/inventory/warehouse.model.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { StockReservation } from "../modules/inventory/reservation.model.js";
import { InventoryTransaction } from "../modules/inventory/transaction.model.js";
import { Cart } from "../modules/cart/cart.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Coupon } from "../modules/pricing/coupon.model.js";
import { CouponUsage, CouponCustomerUse } from "../modules/pricing/couponUsage.model.js";
import { CustomerLedger, LedgerEntry } from "../modules/ledger/ledger.model.js";
import { Invoice, CreditNote, InvoiceCounter } from "../modules/invoices/invoice.model.js";
import { Address } from "../modules/location/address.model.js";
import { setAvailableQty } from "../modules/inventory/service.js";
import { setRazorpayClient } from "../modules/checkout/razorpayApi.js";

let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq += 1)}`;

export async function setup() {
  if (!/msp_test/.test(env.mongoUri)) {
    throw new Error(`Refusing to run destructive tests against ${env.mongoUri} (database name must contain msp_test)`);
  }
  await connectDb();
  await mongoose.connection.db.dropDatabase();
  for (const model of [
    Tenant, User, Product, ProductVariant, Warehouse, Inventory, StockReservation, InventoryTransaction, Cart, Order,
    Coupon, CouponUsage, CouponCustomerUse, CustomerLedger, LedgerEntry, Invoice, CreditNote, InvoiceCounter, Address,
  ]) {
    await model.createCollection().catch(() => {});
    await model.syncIndexes();
  }
  // Fake Razorpay so payment code paths run offline.
  const fake = { orders: [], refunds: [] };
  setRazorpayClient({
    createOrder: async ({ amount }) => {
      const row = { id: `order_${uid()}`, amount };
      fake.orders.push(row);
      return row;
    },
    createRefund: async (paymentId, { amount, notes }) => {
      const row = { id: `rfnd_${uid()}`, payment_id: paymentId, amount, notes, status: "processed" };
      fake.refunds.push(row);
      return row;
    },
    listRefunds: async (paymentId) => ({ items: fake.refunds.filter((r) => r.payment_id === paymentId) }),
  });
  process.env.RAZORPAY_KEY_ID ||= "rzp_test_x";
  return fake;
}

export async function teardown() {
  setRazorpayClient(null);
  await new Promise((resolve) => setTimeout(resolve, 200)); // let afterCommit hooks finish
  await mongoose.disconnect();
}

export async function makeStore({ stock = 10, price = 100, state = "Maharashtra" } = {}) {
  const tag = uid();
  const tenant = await Tenant.create({ name: `Store ${tag}`, slug: `store-${tag}`, pickupAddress: { state, postalCode: "400001" } });
  const product = await Product.create({
    tenantId: tenant._id,
    name: `Product ${tag}`,
    sku: `P-${tag}`,
    status: "published",
    taxClass: { name: "GST18", rate: 18 },
    deliveryModes: ["delivery_partner"],
  });
  const variant = await ProductVariant.create({
    tenantId: tenant._id,
    productId: product._id,
    sku: `V-${tag}`,
    listPrice: price,
    sellingPrice: price,
    attributes: { weight: 250, dimensions: { l: 10, w: 8, h: 4 } },
  });
  const warehouse = await Warehouse.create({ tenantId: tenant._id, name: "Main", code: "MAIN", state, postalCode: "400001" });
  await setAvailableQty({ tenantId: tenant._id, variantId: variant._id, warehouseId: warehouse._id, qty: stock });
  return { tenant, product, variant, warehouse };
}

// Buyers hold the real system buyer role (the ledger checks it before granting terms).
let buyerRoleId = null;
async function systemBuyerRoleId() {
  if (buyerRoleId) return buyerRoleId;
  let role = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true }).select("_id");
  if (!role) {
    await ensureSystemRoles();
    role = await Role.findOne({ slug: SYSTEM_ROLES.BUYER, isSystem: true }).select("_id");
  }
  buyerRoleId = role._id;
  return buyerRoleId;
}

export async function makeBuyer({ state = "Maharashtra" } = {}) {
  const tag = uid();
  const user = await User.create({
    name: `Buyer ${tag}`,
    email: `buyer-${tag}@test.local`,
    passwordHash: "x",
    roleId: await systemBuyerRoleId(),
  });
  const address = await Address.create({
    userId: user._id,
    contactName: "Test Buyer",
    phone: "9999999999",
    addressLine1: "1 Test Road",
    city: "Mumbai",
    state,
    postalCode: "400001",
  });
  return { user: { _id: user._id, tenantId: null }, address };
}

export async function stockRow(store) {
  return Inventory.findOne({ tenantId: store.tenant._id, warehouseId: store.warehouse._id, variantId: store.variant._id }).lean();
}

/** available + reserved + committed (+ consumed units are gone) must equal what we put in. */
export async function assertCountersMatchReservations(store, label = "") {
  const row = await stockRow(store);
  const res = await StockReservation.find({ variantId: store.variant._id, warehouseId: store.warehouse._id }).lean();
  const held = res.filter((r) => r.status === "held").reduce((s, r) => s + r.qty, 0);
  const committed = res.filter((r) => r.status === "committed").reduce((s, r) => s + r.qty, 0);
  check(row.reserved === held, `${label} reserved counter ${row.reserved} == held reservations ${held}`);
  check(row.committed === committed, `${label} committed counter ${row.committed} == committed reservations ${committed}`);
  check(row.available >= 0, `${label} available ${row.available} >= 0`);
  return row;
}

let failures = 0;
export function check(cond, message) {
  if (cond) console.log(`  ok   ${message}`);
  else {
    failures += 1;
    console.error(`  FAIL ${message}`);
  }
}

export function finish(name) {
  if (failures) {
    console.error(`\n${name}: ${failures} check(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n${name}: all checks passed`);
  }
}

export function fulfilled(results) {
  return results.filter((r) => r.status === "fulfilled");
}

export function rejected(results) {
  return results.filter((r) => r.status === "rejected");
}

export function quoteTotal(quote) {
  return quote.grandTotal;
}
