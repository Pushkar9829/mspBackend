/**
 * One-off, idempotent migration to owned stock reservations (+ commerce index sync).
 *
 *   MONGODB_URI=... node src/modules/inventory/migrateReservations.js [--dry-run] [--release-leaked]
 *
 * 1. Normalises legacy fields (empty idempotency keys, ledger paise, legacy ledgers' terms) and
 *    fixes ledger accounting (fixLedgers): balance above the credit limit becomes `advance`,
 *    orphan entries get their ledgerId, payment references get a normalised `referenceKey`
 *    (pre-existing duplicates are disambiguated) so the unique payment-reference index builds.
 * 2. Syncs indexes of the commerce models (drops the old unique Order {tenantId,idempotencyKey}
 *    and CustomerLedger {userId} indexes, builds the new ones).
 * 3. Creates StockReservation docs for live orders (pending -> held, confirmed..ready_to_ship ->
 *    committed, shipped..return_approved -> consumed) and for cart lines that still carry a
 *    legacy `reservedQty` hold. Lines that already have a reservation are skipped.
 * 4. Recomputes Inventory.reserved / committed / isLow from the reservation docs. Units that
 *    were held by the old anonymous counters but are owned by nobody ("leaked", including units
 *    of already-shipped orders that were never decremented) are NOT returned to `available`
 *    unless --release-leaked is passed; units newly owned by migrated orders that the counters
 *    never took are taken out of `available`. Running it twice changes nothing.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectDb } from "../../config/db.js";
import { Inventory } from "./inventory.model.js";
import { InventoryTransaction } from "./transaction.model.js";
import { StockReservation } from "./reservation.model.js";
import { Cart } from "../cart/cart.model.js";
import { Order } from "../orders/order.model.js";
import { CustomerLedger, LedgerEntry } from "../ledger/ledger.model.js";
import { Invoice, CreditNote, InvoiceCounter } from "../invoices/invoice.model.js";
import { CouponUsage, CouponCustomerUse } from "../pricing/couponUsage.model.js";
import { CART_RESERVATION_MINUTES } from "../../config/constants.js";

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const RELEASE_LEAKED = args.has("--release-leaked");

const ORDER_STATE = {
  pending: "held",
  confirmed: "committed",
  processing: "committed",
  ready_to_ship: "committed",
  shipped: "consumed",
  out_for_delivery: "consumed",
  delivered: "consumed",
  return_requested: "consumed",
  return_approved: "consumed",
};

const report = { orderHolds: 0, cartHolds: 0, rows: 0, rowsChanged: 0, shortfall: [], leaked: [], indexes: {}, ledgers: 0 };

async function normalise() {
  if (DRY) {
    report.ledgerFix = {
      overpaidAccounts: await CustomerLedger.countDocuments({ $expr: { $gt: ["$balancePaise", { $ifNull: ["$creditLimitPaise", 0] }] } }),
      paymentKeysMissing: await LedgerEntry.countDocuments({ kind: "payment", reference: { $gt: "" }, referenceKey: { $exists: false } }),
    };
    return;
  }
  await Order.collection.updateMany({ idempotencyKey: "" }, { $unset: { idempotencyKey: "" } });
  const ledgers = await migrateLedgers();
  report.ledgers = ledgers.legacyTerms;
}

/** Drop the pre-tenancy unique {userId} ledger index (accounts are per buyer per store now). */
async function dropLegacyLedgerIndex() {
  let indexes;
  try {
    indexes = await CustomerLedger.collection.indexes();
  } catch (err) {
    if (err?.code === 26 || err?.codeName === "NamespaceNotFound") return [];
    throw err;
  }
  const dropped = [];
  for (const idx of indexes) {
    const keys = Object.keys(idx.key || {});
    if (idx.unique && keys.length === 1 && keys[0] === "userId") {
      await CustomerLedger.collection.dropIndex(idx.name);
      dropped.push(idx.name);
    }
  }
  return dropped;
}

/**
 * Ledger part of normalise(), safe to run on every start (bootstrap runs it): every step only
 * matches documents still in the legacy shape, so a second run changes nothing.
 *  - drops the old unique {userId} CustomerLedger index;
 *  - backfills balancePaise / amountPaise / balanceAfterPaise from the rupee fields;
 *  - legacy accounts (no buyerTerms.updatedAt) keep credit + PO and get creditLimitPaise;
 *  - fixLedgers (orphan entries, advance, payment reference keys).
 */
export async function migrateLedgers() {
  const droppedIndexes = await dropLegacyLedgerIndex();
  await CustomerLedger.collection.updateMany({ balancePaise: { $exists: false } }, [
    { $set: { balancePaise: { $round: [{ $multiply: [{ $ifNull: ["$balance", 0] }, 100] }, 0] } } },
  ]);
  await LedgerEntry.collection.updateMany({ amountPaise: { $exists: false } }, [
    {
      $set: {
        amountPaise: { $round: [{ $multiply: [{ $ifNull: ["$amount", 0] }, 100] }, 0] },
        balanceAfterPaise: { $round: [{ $multiply: [{ $ifNull: ["$balanceAfter", 0] }, 100] }, 0] },
      },
    },
  ]);
  // Before this change every buyer could use credit / PO; keep that for existing accounts.
  const legacy = await CustomerLedger.collection.updateMany({ "buyerTerms.updatedAt": { $exists: false } }, [
    {
      $set: {
        "buyerTerms.creditEnabled": true,
        "buyerTerms.purchaseOrderEnabled": true,
        "buyerTerms.paymentDays": 30,
        "buyerTerms.updatedAt": "$$NOW",
        openingGrantedAt: { $ifNull: ["$openingGrantedAt", "$createdAt"] },
        creditLimitPaise: { $ifNull: ["$creditLimitPaise", { $max: ["$balancePaise", 0] }] },
      },
    },
  ]);
  // Must run before fixLedgers: a missing limit would turn the whole balance into advance.
  const limits = await CustomerLedger.collection.updateMany({ creditLimitPaise: { $exists: false } }, [
    { $set: { creditLimitPaise: { $max: [{ $ifNull: ["$balancePaise", 0] }, 0] } } },
  ]);
  await fixLedgers();
  return { droppedIndexes, legacyTerms: legacy.modifiedCount, limitsBackfilled: limits.modifiedCount, ...report.ledgerFix };
}

/**
 * Ledger accounting fix (idempotent):
 *  - entries without ledgerId get their account's id (so per-account guards apply to them);
 *  - accounts get advancePaise; a balance above the credit limit (overpayments recorded before
 *    the advance existed) is reclassified as advance: balance = limit, advance += excess;
 *  - payment entries get a normalised referenceKey for the duplicate-reference unique index;
 *    duplicates that already exist keep their reference but get a disambiguated key.
 */
async function fixLedgers() {
  report.ledgerFix = { entriesLinked: 0, advanceInitialised: 0, overpaidAccounts: 0, paymentKeys: 0, duplicateRefs: 0 };
  const orphans = await LedgerEntry.collection
    .find({ $or: [{ ledgerId: null }, { ledgerId: { $exists: false } }] }, { projection: { userId: 1, tenantId: 1 } })
    .toArray();
  for (const entry of orphans) {
    const account = await CustomerLedger.collection.findOne({ userId: entry.userId, tenantId: entry.tenantId ?? null }, { projection: { _id: 1 } });
    if (!account) continue;
    await LedgerEntry.collection.updateOne({ _id: entry._id }, { $set: { ledgerId: account._id } });
    report.ledgerFix.entriesLinked += 1;
  }
  const init = await CustomerLedger.collection.updateMany({ advancePaise: { $exists: false } }, { $set: { advancePaise: 0, advance: 0 } });
  report.ledgerFix.advanceInitialised = init.modifiedCount;
  const overpaid = await CustomerLedger.collection.updateMany(
    { $expr: { $gt: ["$balancePaise", { $ifNull: ["$creditLimitPaise", 0] }] } },
    [
      {
        $set: {
          advancePaise: {
            $add: [{ $ifNull: ["$advancePaise", 0] }, { $subtract: ["$balancePaise", { $ifNull: ["$creditLimitPaise", 0] }] }],
          },
          balancePaise: { $ifNull: ["$creditLimitPaise", 0] },
        },
      },
      { $set: { balance: { $divide: ["$balancePaise", 100] }, advance: { $divide: ["$advancePaise", 100] } } },
    ]
  );
  report.ledgerFix.overpaidAccounts = overpaid.modifiedCount;
  const payments = await LedgerEntry.collection
    .find({ kind: "payment", reference: { $type: "string", $gt: "" }, referenceKey: { $exists: false } })
    .sort({ createdAt: 1 })
    .toArray();
  for (const entry of payments) {
    const key = String(entry.reference).trim().replace(/\s+/g, " ").toUpperCase();
    if (!key) continue;
    const taken = await LedgerEntry.collection.findOne({ ledgerId: entry.ledgerId ?? null, kind: "payment", referenceKey: key, _id: { $ne: entry._id } });
    const referenceKey = taken ? `${key}#DUP-${entry._id}` : key;
    if (taken) report.ledgerFix.duplicateRefs += 1;
    await LedgerEntry.collection.updateOne({ _id: entry._id }, { $set: { referenceKey } });
    report.ledgerFix.paymentKeys += 1;
  }
}

async function syncIndexes() {
  const models = [StockReservation, Inventory, InventoryTransaction, Cart, Order, CustomerLedger, LedgerEntry, Invoice, CreditNote, InvoiceCounter, CouponUsage, CouponCustomerUse];
  for (const model of models) {
    if (DRY) {
      report.indexes[model.modelName] = await model.diffIndexes().catch((err) => ({ error: err.message }));
      continue;
    }
    try {
      const dropped = await model.syncIndexes();
      report.indexes[model.modelName] = { dropped };
    } catch (err) {
      report.indexes[model.modelName] = { error: err.message };
    }
  }
}

async function migrateOrders() {
  const cursor = Order.find({ status: { $in: Object.keys(ORDER_STATE) } }).cursor();
  for await (const order of cursor) {
    const status = ORDER_STATE[order.status];
    for (const item of order.items || []) {
      if (!item.warehouseId || !(item.qty > 0)) continue;
      const exists = await StockReservation.exists({ "owner.type": "order", "owner.id": order._id, "owner.line": item._id });
      if (exists) continue;
      report.orderHolds += 1;
      if (DRY) continue;
      await StockReservation.create({
        tenantId: order.tenantId,
        warehouseId: item.warehouseId,
        variantId: item.variantId,
        qty: item.qty,
        owner: { type: "order", id: order._id, line: item._id },
        status,
        active: status === "held" || status === "committed",
        reference: order.orderNumber,
        history: [{ from: null, to: status, note: "migrated" }],
      });
    }
  }
}

async function migrateCarts() {
  const carts = await Cart.find({ "items.reservedQty": { $gt: 0 } });
  for (const cart of carts) {
    let changed = false;
    for (const item of cart.items) {
      if (item.reservationId || !item.warehouseId || !(item.reservedQty > 0)) continue;
      report.cartHolds += 1;
      if (DRY) continue;
      const res = await StockReservation.create({
        tenantId: item.tenantId,
        warehouseId: item.warehouseId,
        variantId: item.variantId,
        qty: item.reservedQty,
        owner: { type: "cart", id: item._id, cartId: cart._id },
        status: "held",
        active: true,
        expiresAt: new Date(Date.now() + CART_RESERVATION_MINUTES * 60 * 1000),
        reference: `cart:${cart._id}`,
        history: [{ from: null, to: "held", note: "migrated" }],
      });
      item.reservationId = res._id;
      changed = true;
    }
    if (changed) await Cart.updateOne({ _id: cart._id }, { $set: { items: cart.items } });
  }
}

async function recomputeCounters() {
  const sums = await StockReservation.aggregate([
    { $match: { status: { $in: ["held", "committed"] } } },
    {
      $group: {
        _id: { t: "$tenantId", w: "$warehouseId", v: "$variantId" },
        held: { $sum: { $cond: [{ $eq: ["$status", "held"] }, "$qty", 0] } },
        committed: { $sum: { $cond: [{ $eq: ["$status", "committed"] }, "$qty", 0] } },
      },
    },
  ]);
  const byKey = new Map(sums.map((row) => [`${row._id.t}:${row._id.w}:${row._id.v}`, row]));
  const cursor = Inventory.find({}).cursor();
  for await (const row of cursor) {
    report.rows += 1;
    const s = byKey.get(`${row.tenantId}:${row.warehouseId}:${row.variantId}`) || { held: 0, committed: 0 };
    const legacyHolds = (row.reserved || 0) + (row.committed || 0);
    const newHolds = s.held + s.committed;
    let available = row.available || 0;
    // Counters to write: normally the reservation sums; capped below when stock can't cover them.
    let held = s.held;
    let committed = s.committed;
    if (newHolds > legacyHolds) {
      const take = Math.min(available, newHolds - legacyHolds);
      available -= take;
      if (newHolds - legacyHolds > take) {
        report.shortfall.push({ sku: row.sku, warehouseId: String(row.warehouseId), missing: newHolds - legacyHolds - take });
        // Only count units that physically exist (legacy holds + what we took from available),
        // committed first, so releasing the uncovered holds later can't mint phantom stock.
        const covered = legacyHolds + take;
        committed = Math.min(s.committed, covered);
        held = Math.min(s.held, covered - committed);
      }
    } else if (legacyHolds > newHolds) {
      report.leaked.push({ sku: row.sku, warehouseId: String(row.warehouseId), units: legacyHolds - newHolds, returned: RELEASE_LEAKED });
      if (RELEASE_LEAKED) available += legacyHolds - newHolds;
    }
    const unchanged = available === row.available && held === row.reserved && committed === row.committed;
    if (unchanged && typeof row.isLow === "boolean") continue;
    report.rowsChanged += 1;
    if (DRY) continue;
    const threshold = row.lowStockThreshold || 0;
    const isLow = available <= 0 || (threshold > 0 && available <= threshold);
    await Inventory.updateOne(
      { _id: row._id, available: row.available, reserved: row.reserved, committed: row.committed },
      { $set: { available, reserved: held, committed, isLow, ...(isLow ? {} : { lastLowStockAlertAt: null }) } }
    );
    if (available !== row.available) {
      await InventoryTransaction.create({
        tenantId: row.tenantId,
        warehouseId: row.warehouseId,
        variantId: row.variantId,
        sku: row.sku || "-",
        reason: "adjustment",
        qty: available - row.available,
        availableAfter: available,
        reservedAfter: held,
        committedAfter: committed,
        note: "reservation migration",
      });
    }
  }
}

async function main() {
  await connectDb();
  console.log(`migrateReservations${DRY ? " (dry run)" : ""}${RELEASE_LEAKED ? " --release-leaked" : ""}`);
  await normalise();
  await syncIndexes();
  await migrateOrders();
  await migrateCarts();
  await recomputeCounters();
  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

// Also imported at startup (bootstrap -> migrateLedgers): only run main() when executed directly.
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (err) => {
    console.error("migration failed:", err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

export { main as migrateReservations, normalise, fixLedgers };
