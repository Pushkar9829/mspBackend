/**
 * QA round 2 (set B): CSV import price rules + friendly row errors (R8), credit-ledger money
 * formatting / max debit / limit-change statement notes (R10), SKU format (R16), payout statement
 * CSV in IST (R16). Run ONLY against a throwaway local DB:
 *   MONGODB_URI="mongodb://127.0.0.1:27027/msp_test_q2b?replicaSet=rs0" NODE_ENV=test node src/tests/qaRound2B.js
 */
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { setup, teardown, makeStore, makeBuyer, check, finish } from "./commerceFixtures.js";
import * as catalog from "../modules/catalog/service.js";
import * as ledger from "../modules/ledger/service.js";
import { Product } from "../modules/catalog/product.model.js";
import { ProductVariant } from "../modules/catalog/variant.model.js";
import { bulkItemSchema, createProductSchema, createVariantSchema, updateProductSchema, updateVariantSchema } from "../modules/catalog/validators.js";
import { statementCsv, istDateTime } from "../modules/payouts/taxReports.js";

if (!/127\.0\.0\.1:27027\/msp_test_q2b(\?|$)/.test(env.mongoUri)) {
  console.error("Refusing to run: MONGODB_URI must point at the local msp_test_q2b database");
  process.exit(1);
}

await setup();

const sellerReq = (tenantId, extra = []) => ({
  tenantId,
  user: { _id: new mongoose.Types.ObjectId(), tenantId },
  permissions: ["products.create", "products.edit", ...extra],
  isPlatformAdmin: false,
  query: {},
});

async function rejects(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return null;
}

/* ------------------------------------------------------------------ R16 SKU format */
console.log("\n# SKU format (letters, numbers, - and _)");
{
  const base = { name: "Rice", sellingPrice: 90, listPrice: 100 };
  check(createProductSchema.safeParse({ body: { ...base, sku: "RICE-5KG_A1" } }).success, "product create accepts letters/digits/-/_");
  for (const bad of ["RICE 5KG", "RICE!", "a/b", "x.y"]) {
    const r = createProductSchema.safeParse({ body: { ...base, sku: bad } });
    check(!r.success && /letters, numbers/.test(r.error.issues.find((i) => i.path.join(".") === "body.sku")?.message || ""), `product create rejects "${bad}"`);
  }
  const v = createVariantSchema.safeParse({ body: { productId: "a".repeat(24), sku: "V 1", listPrice: 10, sellingPrice: 9 } });
  check(!v.success, "variant create rejects a SKU with a space");
  check(!bulkItemSchema.safeParse({ ...base, sku: "BAD SKU" }).success, "CSV/bulk row rejects a SKU with a space");
  // Update schemas stay permissive; the service only checks a CHANGED SKU.
  check(updateProductSchema.safeParse({ params: { id: "a".repeat(24) }, body: { sku: "LEGACY SKU" } }).success, "product update schema lets an existing SKU through");
  check(updateVariantSchema.safeParse({ params: { id: "a".repeat(24) }, body: { sku: "LEGACY SKU" } }).success, "variant update schema lets an existing SKU through");

  const store = await makeStore({ stock: 5, price: 100 });
  const req = sellerReq(store.tenant._id);
  // A legacy product whose SKU predates the rule can still be saved unchanged…
  const legacy = await Product.create({ tenantId: store.tenant._id, name: "Legacy", sku: "OLD SKU 1", status: "draft" });
  const kept = await catalog.updateProduct(req, legacy._id, { sku: "old sku 1", name: "Legacy renamed" });
  check(kept.name === "Legacy renamed", "unchanged legacy SKU can be re-saved");
  // …but changing it to another bad value is refused, and a good value is accepted.
  const bad = await rejects(catalog.updateProduct(req, legacy._id, { sku: "NEW SKU!" }));
  check(bad?.status === 400 && /letters, numbers/.test(bad.message), "changed product SKU must match the format");
  const fixed = await catalog.updateProduct(req, legacy._id, { sku: "NEW-SKU_1" });
  check(fixed.sku === "NEW-SKU_1", "changed product SKU in the new format is saved");

  const lv = await ProductVariant.create({ tenantId: store.tenant._id, productId: legacy._id, sku: "OLD VAR", listPrice: 10, sellingPrice: 9 });
  await catalog.updateVariant(req, lv._id, { sku: "old var", sellingPrice: 8 });
  check((await ProductVariant.findById(lv._id).lean()).sellingPrice === 8, "unchanged legacy variant SKU can be re-saved");
  const vbad = await rejects(catalog.updateVariant(req, lv._id, { sku: "VAR #2" }));
  check(vbad?.status === 400, "changed variant SKU must match the format");
}

/* ------------------------------------------------------------------ R8 CSV import */
console.log("\n# CSV import: price rules + friendly row errors");
{
  const store = await makeStore({ stock: 5, price: 100 });
  const req = sellerReq(store.tenant._id);
  const csv = [
    "sku,name,sellingPrice,listPrice,tierPrices",
    "OK-1,Good row,90,100,",
    ",Missing SKU,10,20,",
    "HIGH-1,Above MRP,200,100,",
    "TIER-1,Bad slab,50,60,10-5@45",
    "BAD SKU,Space in SKU,10,20,",
    "NAN-1,Bad price,abc,20,",
  ].join("\n");
  const items = catalog.csvToBulkItems(csv);
  const dry = await catalog.bulkUploadProducts(req, items, { dryRun: true });
  const rows = dry.rows;
  check(rows[0].ok, "valid row passes the dry run");
  check(rows[1].errors.sku === "SKU is required" && rows[1].message === "Row 3: SKU is required", `missing SKU → "Row 3: SKU is required" (got ${rows[1].message})`);
  check(rows[2].errors.sellingPrice === "Selling price ₹200 is above MRP ₹100", `selling > MRP is refused (got ${rows[2].errors.sellingPrice})`);
  check(rows[2].message === "Row 4: Selling price ₹200 is above MRP ₹100", "row message names the row and the prices");
  check(/Price slab 1: max qty 5 is below min qty 10/.test(rows[3].errors["tierPrices.0.maxQty"] || ""), "slab max < min is refused");
  check(/letters, numbers/.test(rows[4].errors.sku || ""), "CSV SKU format is enforced");
  check(rows[5].errors.sellingPrice === "Selling price must be a number", `non-numeric price is friendly (got ${rows[5].errors.sellingPrice})`);
  const raw = JSON.stringify(rows.map((r) => r.errors));
  check(!/Invalid input|expected string|received/.test(raw), "no raw zod wording in row errors");

  const res = await catalog.bulkUploadProducts(req, items);
  check(res.created.length === 1 && res.created[0].sku === "OK-1", "import creates only the valid row");
  const above = res.errors.find((e) => e.index === 2);
  check(above?.message === "Row 4: Selling price ₹200 is above MRP ₹100" && above.fields?.sellingPrice, "import error carries the friendly row message + fields");
  check(res.errors.find((e) => e.index === 1)?.message === "Row 3: SKU is required", "import error: Row 3: SKU is required");
  check(!(await Product.exists({ tenantId: store.tenant._id, sku: "HIGH-1" })), "row above MRP is not written");
}

/* ------------------------------------------------------------------ R10 ledger */
console.log("\n# credit ledger: formatted money, max debit, limit changes as notes");
{
  const store = await makeStore({ stock: 5, price: 100 });
  const buyer = await makeBuyer();
  const req = { tenantId: store.tenant._id, user: { _id: null }, query: {} };
  await ledger.setBuyerTerms(req, buyer.user._id, { creditEnabled: true, purchaseOrderEnabled: true, creditLimit: 17302 });
  const acct = ledger.presentLedger(await ledger.findLedger(buyer.user._id, store.tenant._id));
  check(acct.maxDebit === 17302 && acct.maxDebitPaise === 1730200, "account exposes the largest accepted debit");
  const err = await rejects(ledger.adjustBalance(req, buyer.user._id, { amount: -20000, note: "too much" }));
  check(err?.code === "INSUFFICIENT_CREDIT" && err.message.includes("₹17,302.00"), `server message formats money en-IN (got "${err?.message}")`);
  const ok = await ledger.adjustBalance(req, buyer.user._id, { amount: -17302, note: "exactly the max" });
  check(ok.spendable === 0, "a debit of exactly maxDebit is accepted (UI max matches the server)");
  await ledger.adjustBalance(req, buyer.user._id, { amount: 302, note: "credit back" });
  await ledger.setBuyerTerms(req, buyer.user._id, { creditLimit: 20000 });

  const st = await ledger.getStatement({ ...req, query: { limit: 50 } }, buyer.user._id);
  const limitRows = st.data.filter((e) => e.kind === "limit" || e.kind === "opening");
  const moneyRows = st.data.filter((e) => e.kind === "adjustment");
  check(limitRows.length >= 2 && limitRows.every((e) => e.limitChange === true && e.limitNote), "limit / opening entries are flagged as notes");
  const raise = limitRows[limitRows.length - 1];
  check(/Credit limit set to ₹20,000\.00/.test(raise.limitNote) && /raised by ₹2,698\.00/.test(raise.limitNote), `limit note is formatted (got "${raise.limitNote}")`);
  check(raise.limitDelta === 2698, "limitDelta is signed rupees");
  check(moneyRows.length === 2 && moneyRows.every((e) => !e.limitChange), "money adjustments stay in the Debit/Credit columns");
  check(st.closingBalance === ledger.presentLedger(await ledger.findLedger(buyer.user._id, store.tenant._id)).balance, "balances unchanged by the statement flags");
}

/* ------------------------------------------------------------------ R16 payout CSV IST */
console.log("\n# payout statement CSV dates in IST");
{
  // 2026-10-31 20:00 UTC = 2026-11-01 01:30 IST.
  const at = new Date("2026-10-31T20:00:00.000Z");
  check(istDateTime(at) === "2026-11-01 01:30:00", `istDateTime converts to IST (got ${istDateTime(at)})`);
  const csv = statementCsv({
    store: { name: "S", gstin: "" },
    month: "2026-11",
    openingBalance: 0,
    closingBalance: 10,
    totals: { tcs: 0, tds: 0, heldAtClose: 0 },
    lines: [{ date: at, orderNumber: "O-1", kindLabel: "Sale", memo: "", amount: 10, balance: 10, held: false }],
  });
  check(csv.includes("Date (IST)") && csv.includes("2026-11-01 01:30:00") && !csv.includes("T20:00:00"), "statement CSV uses IST date-times");
}

await teardown();
finish("qaRound2B");
