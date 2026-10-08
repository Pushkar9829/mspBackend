/**
 * Ledger accounting (outstanding / available / advance), the ledger data migration, and the
 * ORDER_UPDATED event.
 *   MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_be1?replicaSet=rs0" NODE_ENV=test node src/tests/commerceLedger.js
 */
import mongoose from "mongoose";
import { setup, teardown, makeStore, makeBuyer, check, finish } from "./commerceFixtures.js";
import * as ledger from "../modules/ledger/service.js";
import { CustomerLedger, LedgerEntry } from "../modules/ledger/ledger.model.js";
import { fixLedgers } from "../modules/inventory/migrateReservations.js";
import { addItem, getOrCreateCart, quoteCart } from "../modules/cart/service.js";
import { checkout } from "../modules/checkout/service.js";
import { confirmOrder, cancelOrder, advanceOrder, refundOrder } from "../modules/orders/lifecycle.js";
import { bus } from "../utils/events.js";

const staffReq = (tenantId) => ({ tenantId, user: { _id: null } });
const settle = () => new Promise((r) => setTimeout(r, 200));

async function place(buyer, store, { qty = 1, paymentMethod = "credit_terms" } = {}) {
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty });
  const cart = await getOrCreateCart(buyer.user._id);
  const quote = await quoteCart(cart, buyer.user._id, buyer.address);
  const { orders } = await checkout({
    user: buyer.user,
    addressId: buyer.address._id,
    paymentMethod,
    poNumber: "PO-L",
    idempotencyKey: `k-${Math.random()}`,
    expectedGrandTotal: quote.grandTotal,
  });
  return orders[0];
}

async function view(buyer, store) {
  return ledger.presentLedger(await ledger.findLedger(buyer.user._id, store.tenant._id));
}

async function testAccounting() {
  console.log("\n# outstanding / available / advance");
  const store = await makeStore({ stock: 50, price: 100 });
  const buyer = await makeBuyer();
  const req = staffReq(store.tenant._id);
  await ledger.setBuyerTerms(req, buyer.user._id, { creditEnabled: true, purchaseOrderEnabled: true, creditLimit: 1000 });
  let v = await view(buyer, store);
  check(v.creditLimit === 1000 && v.available === 1000 && v.outstanding === 0 && v.advance === 0, "fresh account: available = limit");

  const order = await place(buyer, store, { qty: 4 });
  v = await view(buyer, store);
  check(v.outstanding === order.total && v.available + v.outstanding === 1000, `order debit -> outstanding ${v.outstanding}`);

  const partial = await ledger.recordPayment(req, buyer.user._id, { amount: 100, reference: "CHQ-1" });
  check(partial.payment.appliedToDues === 100 && partial.payment.toAdvance === 0 && partial.outstanding === Math.round((order.total - 100) * 100) / 100, "partial payment reduces dues");
  const over = await ledger.recordPayment(req, buyer.user._id, { amount: 1000, reference: "CHQ-2" });
  const due = Math.round((order.total - 100) * 100) / 100;
  check(over.outstanding === 0 && over.available === 1000 && over.advance === Math.round((1000 - due) * 100) / 100, `overpayment: available capped at limit, advance ${over.advance}`);
  check(over.payment.toAdvance === over.advance && over.payment.appliedToDues === due, "payment split reported");
  const dup = await Promise.allSettled([ledger.recordPayment(req, buyer.user._id, { amount: 5, reference: " chq-2 " })]);
  check(dup[0].reason?.code === "DUPLICATE_PAYMENT" && dup[0].reason?.status === 409, "duplicate reference -> 409");
  const race = await Promise.allSettled([
    ledger.recordPayment(req, buyer.user._id, { amount: 1, reference: "RACE-1" }),
    ledger.recordPayment(req, buyer.user._id, { amount: 1, reference: "RACE-1" }),
    ledger.recordPayment(req, buyer.user._id, { amount: 1, reference: "race-1" }),
  ]);
  check(race.filter((r) => r.status === "fulfilled").length === 1, "concurrent duplicate references: one wins (unique index)");
  const noRef = await Promise.allSettled([
    ledger.recordPayment(req, buyer.user._id, { amount: 1 }),
    ledger.recordPayment(req, buyer.user._id, { amount: 1 }),
  ]);
  check(noRef.every((r) => r.status === "fulfilled"), "payments without a reference are not de-duplicated");

  v = await view(buyer, store);
  const advanceBefore = v.advance;
  await ledger.setBuyerTerms(req, buyer.user._id, { creditLimit: 2000 });
  v = await view(buyer, store);
  check(v.creditLimit === 2000 && v.available === 2000 && v.outstanding === 0 && v.advance === advanceBefore, "raising the limit adds credit, advance unchanged");

  const second = await place(buyer, store, { qty: 2 });
  v = await view(buyer, store);
  const used = Math.min(advanceBefore, second.total);
  check(v.advance === Math.round((advanceBefore - used) * 100) / 100 && v.outstanding === Math.round((second.total - used) * 100) / 100, "orders use the advance first");
  await cancelOrder(second, null, "x");
  v = await view(buyer, store);
  check(v.advance === advanceBefore && v.outstanding === 0, "cancel restores the advance");

  await ledger.setBuyerTerms(req, buyer.user._id, { creditLimit: 500 });
  const third = await place(buyer, store, { qty: 1 });
  v = await view(buyer, store);
  check(v.available + v.outstanding === 500 || v.outstanding > 0, "limit cut keeps dues consistent");
  const adj = await ledger.adjustBalance(req, buyer.user._id, { amount: -1, note: "fee" });
  check(adj.spendable === Math.round((v.spendable - 1) * 100) / 100, "negative adjustment reduces spendable");
  const tooMuch = await Promise.allSettled([ledger.adjustBalance(req, buyer.user._id, { amount: -1e6, note: "x" })]);
  check(tooMuch[0].reason?.code === "INSUFFICIENT_CREDIT", "negative adjustment cannot exceed spendable");

  // Delivered then refunded after the buyer paid: the reversal becomes advance (store owes the buyer).
  let paid = await confirmOrder(third, null);
  for (const s of ["processing", "ready_to_ship", "shipped", "delivered"]) paid = await advanceOrder(paid, s, {});
  const before = await view(buyer, store);
  await ledger.recordPayment(req, buyer.user._id, { amount: before.outstanding || 0.01, reference: "FINAL" });
  const settled = await view(buyer, store);
  await refundOrder(paid, null, "refund");
  const after = await view(buyer, store);
  check(after.outstanding === 0 && after.advance === Math.round((settled.advance + third.total) * 100) / 100, "refund of a paid order credits advance");
  const me = await ledger.getLedgerForUser(buyer.user._id);
  check(me.advance === after.advance && me.ledgers.length === 1 && "outstanding" in me && "creditLimit" in me, "buyer summary carries the same fields");
}

async function testMigration() {
  console.log("\n# ledger migration (idempotent)");
  const store = await makeStore();
  const buyer = await makeBuyer();
  const userId = buyer.user._id;
  const tenantId = store.tenant._id;
  // Legacy account: balance above the limit (overpayment before advance existed), no advance field.
  const { insertedId } = await CustomerLedger.collection.insertOne({
    userId,
    tenantId,
    balancePaise: 150000,
    balance: 1500,
    creditLimitPaise: 100000,
    buyerTerms: { creditEnabled: true, purchaseOrderEnabled: true, updatedAt: new Date() },
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const legacy = ledger.presentLedger(await CustomerLedger.findById(insertedId).lean());
  check(legacy.available === 1000 && legacy.advance === 500, "before migration: excess is already reported as advance, not credit");
  const entry = { userId, tenantId, type: "credit", kind: "payment", amount: 10, amountPaise: 1000, balanceAfter: 0, reference: "Dup-Ref", createdAt: new Date() };
  await LedgerEntry.collection.insertMany([{ ...entry }, { ...entry, reference: "dup-ref " }, { ...entry, reference: "Other" }]);
  await fixLedgers();
  const fixed = await CustomerLedger.findById(insertedId).lean();
  check(fixed.balancePaise === 100000 && fixed.advancePaise === 50000, "balance above limit moved to advance");
  const entries = await LedgerEntry.find({ userId }).lean();
  check(entries.every((e) => String(e.ledgerId) === String(insertedId)), "orphan entries linked to their account");
  const keys = entries.map((e) => e.referenceKey).sort();
  check(keys.includes("DUP-REF") && keys.some((k) => k.startsWith("DUP-REF#DUP-")) && keys.includes("OTHER"), `duplicate legacy refs disambiguated (${keys.join(", ")})`);
  await LedgerEntry.syncIndexes();
  await fixLedgers();
  const again = await CustomerLedger.findById(insertedId).lean();
  check(again.balancePaise === 100000 && again.advancePaise === 50000, "second run changes nothing");
  const dup = await Promise.allSettled([ledger.recordPayment(staffReq(tenantId), userId, { amount: 1, reference: "dup-ref" })]);
  check(dup[0].reason?.code === "DUPLICATE_PAYMENT", "migrated reference is guarded");
}

async function testOrderUpdated() {
  console.log("\n# ORDER_UPDATED");
  const seen = [];
  bus.on("ORDER_UPDATED", (payload) => seen.push(payload));
  const store = await makeStore({ stock: 10 });
  const buyer = await makeBuyer();
  const order = await place(buyer, store, { paymentMethod: "cod" });
  await settle();
  const keys = ["_id", "tenantId", "buyerId", "orderNumber", "status", "paymentStatus", "paymentMethod", "grandTotal", "fulfillmentMode"];
  const created = seen.find((p) => String(p.order._id) === String(order._id));
  check(created && keys.every((k) => k in created.order) && created.order.status === "pending", "emitted after checkout with { order } fields");
  const n = seen.length;
  await confirmOrder(order, null);
  await settle();
  check(seen.length === n + 1 && seen.at(-1).order.status === "confirmed", "emitted once after confirm (committed state)");
  await Promise.allSettled([cancelOrder(order, null, "a"), cancelOrder(order, null, "b")]);
  await settle();
  const cancels = seen.slice(n + 1).filter((p) => p.order.status === "cancelled");
  check(cancels.length === 1, "one event for the winning cancel, none for the rejected one");
}

async function main() {
  await setup();
  await testAccounting();
  await testMigration();
  await testOrderUpdated();
  finish("commerceLedger");
  await teardown();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await teardown().catch(() => {});
  await mongoose.disconnect().catch(() => {});
});
