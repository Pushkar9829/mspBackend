/**
 * One-off / idempotent catalog data migration (Agent C fixes).
 *   node src/modules/catalog/migrate.js            
 * Steps: uppercase SKUs, normalise restock alerts + dedupe, backfill product slugs + migrate
 * wishlist rows, then syncIndexes() for catalog/reviews/wishlist/search models (drops the old
 * redundant / non-unique indexes and builds the new unique + TTL ones).
 */
import mongoose from "mongoose";
import { pathToFileURL } from "url";
import { Product } from "./product.model.js";
import { ProductVariant } from "./variant.model.js";
import { RestockAlert } from "./restockAlert.model.js";
import { ensureProductSlugs, syncCatalogIndexes } from "./service.js";

async function uppercaseSkus(model) {
  let fixed = 0;
  let conflicts = 0;
  const cursor = model.collection.find({ sku: { $regex: "[a-z]|^\\s|\\s$" } }, { projection: { sku: 1 } });
  for await (const doc of cursor) {
    try {
      await model.collection.updateOne({ _id: doc._id }, { $set: { sku: String(doc.sku).trim().toUpperCase() } });
      fixed += 1;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      conflicts += 1;
      console.warn(`[migrate] ${model.modelName} ${doc._id}: SKU "${doc.sku}" clashes when upper-cased; fix manually`);
    }
  }
  return { fixed, conflicts };
}

async function normaliseRestockAlerts() {
  const col = RestockAlert.collection;
  // Signed-in subscriptions are keyed by userId only; they were always "confirmed".
  const users = await col.updateMany(
    { userId: { $type: "objectId" }, confirmed: { $exists: false } },
    { $set: { email: "", confirmed: true } }
  );
  // Legacy guest subscriptions never went through double opt-in: keep them unconfirmed and let them expire.
  const guests = await col.updateMany(
    { userId: null, confirmed: { $exists: false } },
    { $set: { confirmed: false, expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000) } }
  );
  // Notified alerts get a retention TTL.
  await col.updateMany(
    { notifiedAt: { $ne: null }, $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }] },
    { $set: { expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) } }
  );
  let removed = 0;
  for (const key of ["userId", "email"]) {
    const match = key === "userId" ? { userId: { $type: "objectId" } } : { email: { $gt: "" } };
    const dups = await col
      .aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },
        { $group: { _id: { p: "$productId", v: "$variantId", k: `$${key}` }, ids: { $push: "$_id" }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray();
    for (const d of dups) {
      const res = await col.deleteMany({ _id: { $in: d.ids.slice(1) } });
      removed += res.deletedCount;
    }
  }
  return { userRows: users.modifiedCount, guestRows: guests.modifiedCount, duplicatesRemoved: removed };
}

export async function runCatalogMigration() {
  const out = {};
  out.productSkus = await uppercaseSkus(Product);
  out.variantSkus = await uppercaseSkus(ProductVariant);
  out.restock = await normaliseRestockAlerts();
  out.slugs = await ensureProductSlugs();
  out.indexes = await syncCatalogIndexes();
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { env } = await import("../../config/env.js");
  await mongoose.connect(env.mongoUri);
  try {
    console.log(JSON.stringify(await runCatalogMigration(), null, 2));
  } finally {
    await mongoose.disconnect();
  }
}
