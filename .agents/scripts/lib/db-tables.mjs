/**
 * Is this database empty? Prints {"tables":n,"policies":n,"size":"..."} and nothing secret.
 *
 * A Marketplace resource that is attached to no project is FREE, but it is not necessarily EMPTY:
 * the spare this factory first adopted turned out to hold 15 MB and 54 tables of an older copy of
 * this very schema, which made `drizzle-kit push` ask an interactive rename question and die.
 * So `scope: fresh` now means "prove it is empty first", and never "overwrite whatever is there".
 *
 *   DB_URL=... node db-tables.mjs
 */
import postgres from "postgres";
const sql = postgres(process.env.DB_URL, { max: 1, prepare: false, connect_timeout: 15 });
try {
  const [r] = await sql`SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS tables,
                               (SELECT count(*)::int FROM pg_policies) AS policies,
                               pg_size_pretty(pg_database_size(current_database())) AS size`;
  console.log(JSON.stringify(r));
} finally { await sql.end({ timeout: 5 }).catch(() => {}); }
