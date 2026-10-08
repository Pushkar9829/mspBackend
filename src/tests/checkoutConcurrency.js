/**
 * Concurrency tests for stock + checkout.
 *   MONGODB_URI=mongodb://127.0.0.1:27027/msp_test_a?replicaSet=rs0 node src/tests/checkoutConcurrency.js
 */
import mongoose from "mongoose";
import {
  setup,
  teardown,
  makeStore,
  makeBuyer,
  stockRow,
  assertCountersMatchReservations,
  check,
  finish,
  fulfilled,
  rejected,
} from "./commerceFixtures.js";
import { addItem, getOrCreateCart, quoteCart } from "../modules/cart/service.js";
import { checkout } from "../modules/checkout/service.js";
import { reserve, adjustStock, releaseExpiredHolds, moveReservation } from "../modules/inventory/service.js";
import { StockReservation } from "../modules/inventory/reservation.model.js";
import { InventoryTransaction } from "../modules/inventory/transaction.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Cart } from "../modules/cart/cart.model.js";
import { runJob } from "../jobs/index.js";
import { withTransaction } from "../utils/transaction.js";

async function placeArgs(buyer, user) {
  const cart = await getOrCreateCart(user._id);
  const quote = await quoteCart(cart, user._id, buyer.address);
  return { user, addressId: buyer.address._id, paymentMethod: "cod", expectedGrandTotal: quote.grandTotal };
}

async function testDoubleCheckout() {
  console.log("\n# double checkout on one cart");
  const store = await makeStore({ stock: 5 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 2 });
  let row = await stockRow(store);
  check(row.available === 3 && row.reserved === 2, `add to cart holds 2 (available ${row.available}, reserved ${row.reserved})`);

  // GET /cart (quote) must not reserve anything.
  const cart = await getOrCreateCart(buyer.user._id);
  await Promise.all([quoteCart(cart, buyer.user._id), quoteCart(cart, buyer.user._id), quoteCart(cart, buyer.user._id)]);
  row = await stockRow(store);
  check(row.available === 3 && row.reserved === 2, "quote is read-only for stock");

  const args = await placeArgs(buyer, buyer.user);
  const results = await Promise.allSettled([
    checkout({ ...args, idempotencyKey: "k-a" }),
    checkout({ ...args, idempotencyKey: "k-b" }),
    checkout({ ...args, idempotencyKey: "k-c" }),
  ]);
  const ok = fulfilled(results);
  check(ok.length === 1, `exactly one checkout succeeds (got ${ok.length}; errors: ${rejected(results).map((r) => r.reason.code).join(",")})`);
  const orders = await Order.find({ buyerId: buyer.user._id });
  check(orders.length === 1, `one order created (got ${orders.length})`);
  row = await assertCountersMatchReservations(store, "after double checkout");
  check(row.available === 3 && row.reserved === 2, `the cart hold became the order hold, no extra stock taken (available ${row.available})`);
  const holds = await StockReservation.find({ variantId: store.variant._id, status: "held" });
  check(holds.length === 1 && holds[0].owner.type === "order", "hold re-owned to the order");
  const freshCart = await Cart.findById(cart._id);
  check(freshCart.items.length === 0, "cart cleared in the checkout transaction");

  // Same idempotency key twice → same orders.
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 1 });
  const args2 = await placeArgs(buyer, buyer.user);
  const replay = await Promise.allSettled([
    checkout({ ...args2, idempotencyKey: "same" }),
    checkout({ ...args2, idempotencyKey: "same" }),
  ]);
  const ids = new Set(fulfilled(replay).flatMap((r) => r.value.orders.map((o) => String(o._id))));
  check(fulfilled(replay).length === 2 && ids.size === 1, `same key replays the same order (fulfilled ${fulfilled(replay).length}, ids ${ids.size})`);
}

async function testAdjustVsReserve() {
  console.log("\n# concurrent adjustStock vs reserve");
  const store = await makeStore({ stock: 10 });
  const req = { tenantId: store.tenant._id, user: { _id: new mongoose.Types.ObjectId() } };
  const reserves = Array.from({ length: 8 }, () =>
    withTransaction((session) =>
      reserve({
        tenantId: store.tenant._id,
        warehouseId: store.warehouse._id,
        variantId: store.variant._id,
        qty: 1,
        owner: { type: "order", id: new mongoose.Types.ObjectId() },
        session,
      })
    )
  );
  const adjusts = Array.from({ length: 6 }, (_, i) =>
    adjustStock(req, {
      warehouseId: store.warehouse._id,
      variantId: store.variant._id,
      reason: "adjustment",
      qty: i % 2 ? -1 : 2,
    })
  );
  const results = await Promise.allSettled([...reserves, ...adjusts]);
  const okReserves = fulfilled(results.slice(0, 8)).length;
  const adjustResults = results.slice(8);
  const adjustDelta = adjustResults.reduce((sum, r, i) => sum + (r.status === "fulfilled" ? (i % 2 ? -1 : 2) : 0), 0);
  const row = await assertCountersMatchReservations(store, "after races");
  check(
    row.available + row.reserved === 10 + adjustDelta,
    `stock conserved: available ${row.available} + reserved ${row.reserved} == 10 + adjustments ${adjustDelta}`
  );
  check(row.reserved === okReserves, `reserved == successful reserves (${okReserves})`);
  const txCount = await InventoryTransaction.countDocuments({ variantId: store.variant._id, reason: { $in: ["adjustment", "reserve"] } });
  check(txCount === 1 + okReserves + fulfilled(adjustResults).length, `every move wrote an InventoryTransaction (${txCount})`);
}

async function testStaleHoldJobTwice() {
  console.log("\n# stale-hold release job running twice concurrently");
  const store = await makeStore({ stock: 4 });
  const buyer = await makeBuyer();
  await addItem(buyer.user._id, null, { variantId: String(store.variant._id), qty: 3 });
  await StockReservation.updateMany({ variantId: store.variant._id, status: "held" }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const results = await Promise.allSettled([
    releaseExpiredHolds(),
    releaseExpiredHolds(),
    runJob("reservation-timeout"),
    runJob("reservation-timeout"),
  ]);
  check(rejected(results).length === 0, "job runs did not throw");
  const released = fulfilled(results.slice(0, 2)).reduce((s, r) => s + r.value, 0) +
    fulfilled(results.slice(2)).reduce((s, r) => s + (r.value.result?.releasedHolds || 0), 0);
  check(released === 1, `hold released exactly once (count ${released})`);
  const row = await assertCountersMatchReservations(store, "after expiry");
  check(row.available === 4 && row.reserved === 0, `all units back (available ${row.available})`);
  const cart = await getOrCreateCart(buyer.user._id);
  check(!cart.items[0].reservationId && cart.items[0].reservedQty === 0, "cart line pointer cleared");

  // A second move on the same reservation is a no-op (cannot eat another owner's units).
  const res = await StockReservation.findOne({ variantId: store.variant._id });
  const again = await withTransaction((session) => moveReservation({ reservationId: res._id, from: "held", to: "released", session }));
  check(again === null, "double release is a no-op");

  // Checkout after the hold expired re-reserves fresh stock.
  const args = await placeArgs(buyer, buyer.user);
  const placed = await checkout({ ...args, idempotencyKey: "after-expiry" });
  const row2 = await assertCountersMatchReservations(store, "checkout after expiry");
  check(placed.orders.length === 1 && row2.reserved === 3 && row2.available === 1, "checkout re-reserved after hold expiry");
}

async function main() {
  await setup();
  await testDoubleCheckout();
  await testAdjustVsReserve();
  await testStaleHoldJobTwice();
  finish("checkoutConcurrency");
  await teardown();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
  await teardown().catch(() => {});
});
