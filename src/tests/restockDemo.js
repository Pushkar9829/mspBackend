import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Inventory } from "../modules/inventory/inventory.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";

await mongoose.connect(env.mongoUri);
const variant = await ProductVariant.findOne({ sku: "ACM-TEE-001-M" });
if (variant) {
  await Inventory.updateMany(
    { variantId: variant._id },
    { $set: { available: 500, reserved: 0 } }
  );
  console.log("Restocked", variant.sku);
}
await mongoose.disconnect();
