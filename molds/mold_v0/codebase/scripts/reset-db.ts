// Destructive: drops every table and recreates the schema. Refuses to run with NODE_ENV=production.
import { getDb, resetDb } from "../src/db.js";

if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset a production database");
const db = await getDb();
await resetDb(db);
console.log(`Reset ${db.kind} database: schema recreated, no data.`);
await db.close();
