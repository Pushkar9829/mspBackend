/**
 * Demo seed consistency: seeds a fresh database twice and checks that stock counters match the
 * reservation documents, ledgers match the purchase-order debits, delivered/refunded orders have
 * invoices / credit notes, and a pending seed order can be confirmed.
 *   MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_be1_seed?replicaSet=rs0" SUPER_ADMIN_PASSWORD=... node src/tests/commerceSeed.js
 */
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { connectDb } from "../config/db.js";
import { seedFoundation, seedDemoCatalog } from "../seeds/index.js";
import { Order } from "../modules/orders/order.model.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { StockReservation } from "../modules/inventory/reservation.model.js";
import { Invoice, CreditNote } from "../modules/invoices/invoice.model.js";
import { CustomerLedger, LedgerEntry } from "../modules/ledger/ledger.model.js";
import { presentLedger } from "../modules/ledger/service.js";
import { confirmOrder } from "../modules/orders/lifecycle.js";
import { check, finish } from "./commerceFixtures.js";

async function countersMatch(label) {
  const sums = await StockReservation.aggregate([
    { $match: { status: { $in: ["held", "committed"] } } },
    {
      $group: {
        _id: { w: "$warehouseId", v: "$variantId" },
        held: { $sum: { $cond: [{ $eq: ["$status", "held"] }, "$qty", 0] } },
        committed: { $sum: { $cond: [{ $eq: ["$status", "committed"] }, "$qty", 0] } },
      },
    },
  ]);
  const byKey = new Map(sums.map((r) => [`${r._id.w}:${r._id.v}`, r]));
  const rows = await Inventory.find({}).lean();
  const bad = rows.filter((row) => {
    const s = byKey.get(`${row.warehouseId}:${row.variantId}`) || { held: 0, committed: 0 };
    return row.reserved !== s.held || row.committed !== s.committed || row.available < 0;
  });
  check(rows.length > 0 && bad.length === 0, `${label}: ${rows.length} inventory rows match reservations (${bad.length} mismatched)`);
}

async function ledgersMatch(label) {
  const ledgers = await CustomerLedger.find({}).lean();
  let ok = true;
  for (const l of ledgers) {
    const debits = await Order.aggregate([
      { $match: { buyerId: l.userId, tenantId: l.tenantId, ledgerDebit: { $gt: 0 } } },
      { $group: { _id: null, sum: { $sum: "$ledgerDebit" } } },
    ]);
    const payments = await LedgerEntry.aggregate([
      { $match: { ledgerId: l._id, kind: "payment" } },
      { $group: { _id: null, sum: { $sum: "$amountPaise" } } },
    ]);
    const owedPaise = Math.round((debits[0]?.sum || 0) * 100) - (payments[0]?.sum || 0);
    const view = presentLedger(l);
    const expectOutstanding = Math.max(0, owedPaise);
    const expectAdvance = Math.max(0, -owedPaise);
    if (view.outstandingPaise !== expectOutstanding || view.advancePaise !== expectAdvance || view.availablePaise !== view.creditLimitPaise - expectOutstanding) {
      ok = false;
      console.error("   ledger mismatch", String(l.userId), view, { owedPaise });
    }
  }
  check(ledgers.length > 0 && ok, `${label}: ${ledgers.length} ledgers = limit - unpaid PO debits`);
}

async function main() {
  if (!/127\.0\.0\.1:27027\/msp_test_[a-z0-9_]*seed/.test(env.mongoUri)) {
    throw new Error(`Refusing to run: MONGODB_URI must be a local msp_test_*seed database (got ${env.mongoUri})`);
  }
  await connectDb();
  await mongoose.connection.db.dropDatabase();
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).init().catch(() => {})));

  console.log("\n# first seed run");
  await seedFoundation();
  await seedDemoCatalog();
  await new Promise((r) => setTimeout(r, 300));

  const orders = await Order.find({ orderNumber: /^MSR/ }).lean();
  const byNo = Object.fromEntries(orders.map((o) => [o.orderNumber, o]));
  const expected = { MSR10231: "delivered", MSR10218: "shipped", MSR10204: "confirmed", MSR10191: "pending", MSR10170: "cancelled", MSR10162: "refunded" };
  for (const [no, status] of Object.entries(expected)) check(byNo[no]?.status === status, `${no} is ${status} (${byNo[no]?.status})`);

  const resFor = async (no, statuses) =>
    StockReservation.countDocuments({ "owner.type": "order", "owner.id": byNo[no]._id, status: { $in: statuses } });
  check((await resFor("MSR10191", ["held"])) === byNo.MSR10191.items.length, "pending order holds its stock (held)");
  check((await resFor("MSR10204", ["committed"])) === byNo.MSR10204.items.length, "confirmed order stock committed");
  check((await resFor("MSR10218", ["consumed"])) === byNo.MSR10218.items.length, "shipped order stock consumed");
  check((await resFor("MSR10170", ["released"])) === byNo.MSR10170.items.length, "cancelled order stock released");
  await countersMatch("after seed");

  for (const no of ["MSR10231", "MSR10218", "MSR10204", "MSR10162"]) {
    check(Boolean(await Invoice.exists({ orderId: byNo[no]._id })), `${no} has an invoice`);
  }
  check(!(await Invoice.exists({ orderId: byNo.MSR10191._id })), "pending order has no invoice yet");
  check((await CreditNote.countDocuments({ orderId: byNo.MSR10162._id })) === 1, "refunded order has one credit note");
  check(byNo.MSR10231.paymentStatus === "paid", `delivered PO order paid (${byNo.MSR10231.paymentStatus})`);
  check(byNo.MSR10204.paymentMethod === "purchase_order" && byNo.MSR10204.ledgerDebit === byNo.MSR10204.total, "PO order debited to the ledger");
  check(byNo.MSR10162.ledgerDebit === 0 && byNo.MSR10170.ledgerDebit === 0, "refunded / cancelled orders hold no ledger debit");
  await ledgersMatch("after seed");

  console.log("\n# second seed run (idempotent)");
  const before = await Inventory.find({}).sort({ _id: 1 }).lean();
  const ledgerBefore = await CustomerLedger.find({}).sort({ _id: 1 }).lean();
  await seedDemoCatalog();
  const after = await Inventory.find({}).sort({ _id: 1 }).lean();
  const ledgerAfter = await CustomerLedger.find({}).sort({ _id: 1 }).lean();
  const same = (a, b, keys) => a.length === b.length && a.every((row, i) => keys.every((k) => row[k] === b[i][k]));
  check(same(before, after, ["available", "reserved", "committed"]), "re-seed leaves stock counters alone");
  check(same(ledgerBefore, ledgerAfter, ["balancePaise", "advancePaise", "creditLimitPaise"]), "re-seed leaves ledgers alone");
  check((await Order.countDocuments({ orderNumber: /^MSR/ })) === orders.length, "re-seed creates no duplicate orders");

  console.log("\n# confirm the pending seed order");
  const pending = await Order.findOne({ orderNumber: "MSR10191" });
  const confirmed = await confirmOrder(pending, null);
  check(confirmed.status === "confirmed", "pending seed order confirms");
  check((await resFor("MSR10191", ["committed"])) === pending.items.length, "its holds are committed");
  check(Boolean(await Invoice.exists({ orderId: pending._id })), "invoice issued on confirm");
  await countersMatch("after confirm");
  await ledgersMatch("after confirm");

  finish("commerceSeed");
  await new Promise((r) => setTimeout(r, 300));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
});
