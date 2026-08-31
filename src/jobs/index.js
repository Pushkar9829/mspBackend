import cron from "node-cron";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { Order } from "../modules/orders/order.model.js";
import { Cart } from "../modules/cart/cart.model.js";
import { emitDomain } from "../utils/events.js";
import { publishScheduled as publishCms } from "../modules/cms/service.js";
import { publishScheduled as publishNotes } from "../modules/notifications/service.js";
import { cancelOrder } from "../modules/checkout/service.js";
import { CART_RESERVATION_MINUTES } from "../config/constants.js";

export function startJobs() {
  cron.schedule("*/15 * * * *", async () => {
    try {
      const cutoff = new Date(Date.now() - 6 * 60 * 60 * 1000);
      const low = await Inventory.find({
        lowStockThreshold: { $gt: 0 },
        $expr: { $lte: ["$available", "$lowStockThreshold"] },
        $or: [{ lastLowStockAlertAt: null }, { lastLowStockAlertAt: { $lt: cutoff } }],
      }).limit(50);
      for (const row of low) {
        const event = row.available === 0 ? "OUT_OF_STOCK" : "LOW_STOCK";
        emitDomain(event, {
          tenantId: row.tenantId,
          variantId: row.variantId,
          sku: row.sku,
          available: row.available,
          warehouseId: row.warehouseId,
        });
        row.lastLowStockAlertAt = new Date();
        await row.save();
      }
    } catch (err) {
      console.error("low-stock job", err.message);
    }
  });

  cron.schedule("* * * * *", async () => {
    try {
      await publishCms();
      await publishNotes();
      const due = await Product.updateMany(
        { status: "scheduled", scheduledAt: { $lte: new Date() } },
        { $set: { status: "published" } }
      );
      if (due.modifiedCount) {
        emitDomain("PRODUCT_PUBLISHED", { count: due.modifiedCount, resource: "product" });
      }
    } catch (err) {
      console.error("schedule job", err.message);
    }
  });

  cron.schedule("* * * * *", async () => {
    try {
      const stale = new Date(Date.now() - CART_RESERVATION_MINUTES * 60 * 1000);
      const orders = await Order.find({ status: "pending", createdAt: { $lt: stale } }).limit(25);
      for (const order of orders) {
        await cancelOrder(order, null, "Reservation timeout", { timeout: true });
      }
    } catch (err) {
      console.error("reservation-timeout job", err.message);
    }
  });

  cron.schedule("0 3 * * *", async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await Cart.deleteMany({ userId: null, updatedAt: { $lt: cutoff }, "items.0": { $exists: false } });
    } catch (err) {
      console.error("cleanup job", err.message);
    }
  });
}
