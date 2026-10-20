// List landing-page access requests, newest first.
import { getDb } from "../src/db.js";

const db = await getDb();
const rows = await db.query<Record<string, any>>(
  "SELECT created_at, email, company, product_url, message FROM access_requests ORDER BY created_at DESC LIMIT 200",
);
console.table(rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString().slice(0, 16), message: String(r.message ?? "").slice(0, 60) })));
await db.close();
