import mongoose from "mongoose";
import { env } from "../config/env.js";
import { seedFoundation, seedDemoCatalog } from "../seeds/index.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { reserveStock } from "../modules/inventory/service.js";

const STOCK = 10;
const CONCURRENT = 8;
const QTY = 2;

async function main() {
  await mongoose.connect(env.mongoUri);
  await seedFoundation();
  const demo = await seedDemoCatalog();

  await Inventory.updateOne(
    { tenantId: demo.tenantId, warehouseId: demo.warehouseId, variantId: demo.variantId },
    { $set: { available: STOCK, reserved: 0, committed: 0 } }
  );

  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENT }, (_, i) =>
      reserveStock({
        tenantId: demo.tenantId,
        warehouseId: demo.warehouseId,
        variantId: demo.variantId,
        qty: QTY,
        reference: `concurrency-${i}`,
      })
    )
  );

  const ok = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  const stock = await Inventory.findOne({
    tenantId: demo.tenantId,
    warehouseId: demo.warehouseId,
    variantId: demo.variantId,
  });

  const conserved = stock.available + stock.reserved === STOCK;
  console.log({
    ok,
    failed,
    available: stock.available,
    reserved: stock.reserved,
    conserved,
  });

  if (!conserved || stock.available < 0 || ok * QTY + stock.available !== STOCK) {
    console.error("FAIL: oversell or conservation broken");
    process.exit(1);
  }

  if (ok !== Math.floor(STOCK / QTY)) {
    console.error(`FAIL: expected ${Math.floor(STOCK / QTY)} successful reserves, got ${ok}`);
    process.exit(1);
  }

  console.log("PASS: concurrent reserve did not oversell");

  await Inventory.updateOne(
    { tenantId: demo.tenantId, warehouseId: demo.warehouseId, variantId: demo.variantId },
    { $set: { available: STOCK, reserved: 0, committed: 0 } }
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
