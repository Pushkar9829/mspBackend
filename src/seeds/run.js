import { connectDb } from "../config/db.js";
import { seedFoundation, seedDemoCatalog } from "./index.js";

await connectDb();
await seedFoundation();
const demo = await seedDemoCatalog();
console.log("Seed complete", demo);
process.exit(0);
