// READ-ONLY. Which keys the app's key vault holds (mold_v0-173): per provider its name, category, whether a key is set and
// when one last changed; which providers the build's run kinds need and which of those are missing; queued runs and
// the latest reason they were given for waiting. Never a key, nor a prefix, length or digest of one.
//   npm run operator:vault-status [-- --json] [-- --all]
//   python3 .claude/scripts/provision.py <app_id> --operator vault-status [--dry-run|--yes] [-- --json]   (the factory)
//
// It connects once with the app's own role (DATABASE_URL; without one, the local PGlite database), opens ONE
// transaction, makes it READ ONLY before anything else (SET TRANSACTION READ ONLY, then SHOW transaction_read_only must
// say on), reads, and rolls it back (src/vault-status.ts). It never calls the app's getDb, which migrates on first use:
// DATABASE_URL is taken out of the environment before any of the app's modules load, so one that tried would fail.
// Exit 0: reported. 1: the database could not be read. 2: bad arguments.
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const bad = args.filter((a) => !["--json", "--all"].includes(a));
if (bad.length) { console.error(`vault-status: unknown argument ${bad.join(" ")} (it takes --json and --all only; it never writes)`); process.exit(2); }
const json = args.includes("--json"), all = args.includes("--all");

const url = process.env.DATABASE_URL;
// The app's own modules (read for the build's packs and settings) must never open the app's database themselves: its
// getDb runs migrations. With this address any such attempt fails instead of connecting.
process.env.DATABASE_URL = "postgres://vault-status-reads-through-its-own-read-only-transaction.invalid:1/none";
process.env.APP_MIGRATE_ON_BOOT = "off";

async function connect(): Promise<{ conn: import("../../src/vault-status.js").RawConn; close: () => Promise<void> }> {
  if (url) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, application_name: "operator:vault-status (read-only)" });
    client.on("error", () => {});
    await client.connect();
    return { conn: client, close: () => client.end() };
  }
  const dir = process.env.PGLITE_DIR ?? path.resolve(import.meta.dirname, "..", "..", ".pglite");
  if (!existsSync(dir)) throw Object.assign(new Error("no database: DATABASE_URL is not set and there is no local PGlite database"), { code: 2 });
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = await PGlite.create(dir);
  return { conn: lite, close: () => lite.close() };
}

let db: Awaited<ReturnType<typeof connect>> | undefined;
try {
  db = await connect();
  const { vaultStatus, formatVaultStatus } = await import("../../src/vault-status.js");
  const r = await vaultStatus(db.conn, { all });
  console.log(json ? JSON.stringify(r, null, 2) : formatVaultStatus(r));
  process.exitCode = 0;
} catch (e) {
  const err = e as Error & { code?: unknown };
  // The message only: a driver error can carry the address it tried, so neither it nor the stack is printed.
  const said = String(err.message ?? err).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
  console.error(`vault-status: could not read the key vault: ${said}`);
  process.exitCode = err.code === 2 ? 2 : 1;
} finally {
  await db?.close().catch(() => {});
}
