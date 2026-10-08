import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { env } from "../config/env.js";
import { seedFoundation, seedDemoCatalog } from "./index.js";

await connectDb();
await seedFoundation();
// Demo accounts have well-known passwords: only with SEED_DEMO=true, never in production.
if (env.seedDemo && !env.isProd) {
  const demo = await seedDemoCatalog();
  console.log("Seed complete", demo);
} else {
  console.log("Foundation seeded (set SEED_DEMO=true outside production for demo data)");
}
await mongoose.disconnect();
process.exit(0);
