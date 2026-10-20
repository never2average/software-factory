// Delete an organization and all its data: Postgres, transcripts (ClickHouse or Postgres) and R2 (src/tenancy.ts).
//   npm run org:delete -- <slug|id>            dry run: what would be deleted
//   npm run org:delete -- <slug|id> --yes      delete
import { getDb } from "../src/db.js";
import { deleteOrg } from "../src/tenancy.js";

const [ref, flag] = process.argv.slice(2);
if (!ref) throw new Error("Usage: npm run org:delete -- <slug|id> [--yes]");
const db = await getDb();
const [org] = await db.query<{ id: number; slug: string }>("SELECT id, slug FROM organizations WHERE slug = $1 OR id::text = $1", [ref]);
const id = org?.id ?? (/^\d+$/.test(ref) ? Number(ref) : null);
if (id == null) throw new Error(`No organization ${ref}`);
const r = await deleteOrg(id, { dryRun: flag !== "--yes", log: (m) => console.log(m) });
console.log(JSON.stringify(r, null, 2));
if (flag !== "--yes") console.log("Dry run. Re-run with --yes to delete.");
await db.close();
