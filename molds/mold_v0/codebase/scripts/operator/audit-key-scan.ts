// READ-ONLY. Credentials kept in clear in the audit trails' kept requests and text columns, every workspace (mold_v0-323); --redact --yes alone writes (masks them).
// Until mold_v0-322 a key whose six public characters held - or _ (base64url) was not masked in an entry's kept request
// (bodies, MCP tool arguments, headers not named for a secret). This finds every credential still stored there:
//   npm run operator:audit-key-scan [-- --json]
//   npm run operator:audit-key-scan -- --redact [--yes] [--json]   (masks them in the kept requests: only with --yes)
//   python3 .claude/scripts/provision.py <app_id> --operator audit-key-scan --yes -- --json   (the factory)
//
// It connects once with the app's own role (DATABASE_URL; without one, the local PGlite database) and reads in ONE
// transaction made READ ONLY before anything else (SET TRANSACTION READ ONLY, then SHOW transaction_read_only must say
// on), rolled back (src/audit-key-scan.ts). It never calls the app's getDb, which migrates on first use: DATABASE_URL is
// taken out of the environment before any of the app's modules load. It prints counts per table, kind and workspace, the
// dates, and each finding's table, row, date, JSON path and kind: never a value, only an app key's listed prefix (with
// whether a key with that prefix is still active) or another credential's last 4 characters.
// --redact without --yes: the scan, then exit 3 (a yes is needed); nothing is written.
// Exit 0: reported (findings are not an error) or redacted. 1: the database could not be read or written. 2: bad
// arguments. 3: --redact without --yes.
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const bad = args.filter((a) => !["--json", "--redact", "--yes"].includes(a));
if (bad.length) { console.error(`audit-key-scan: unknown argument ${bad.join(" ")} (it takes --json, and --redact with --yes)`); process.exit(2); }
const json = args.includes("--json"), redact = args.includes("--redact"), yes = args.includes("--yes");
if (yes && !redact) { console.error("audit-key-scan: --yes goes with --redact only (the scan itself never writes)"); process.exit(2); }

const url = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgres://audit-key-scan-reads-through-its-own-connection.invalid:1/none";
process.env.APP_MIGRATE_ON_BOOT = "off";

async function connect(): Promise<{ conn: import("../../src/audit-key-scan.js").RawConn; close: () => Promise<void> }> {
  if (url) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, application_name: `operator:audit-key-scan (${redact && yes ? "redact" : "read-only"})` });
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
  const { scanAuditKeys, redactAuditKeys, formatScan } = await import("../../src/audit-key-scan.js");
  if (redact && yes) {
    const r = await redactAuditKeys(db.conn);
    console.log(json ? JSON.stringify(r, null, 2) : formatScan(r));
    process.exitCode = 0;
  } else {
    const r = await scanAuditKeys(db.conn);
    if (redact) {
      const n = r.findings.filter((f) => f.redactable).length;
      const say = `--redact needs --yes: it would mask ${n} value(s) in the kept requests (nothing was changed)`;
      console.log(json ? JSON.stringify({ ...r, status: "needs_yes", would_redact: n, note: say }, null, 2) : `${formatScan(r)}\n${say}`);
      process.exitCode = 3;
    } else {
      console.log(json ? JSON.stringify(r, null, 2) : formatScan(r));
      process.exitCode = 0;
    }
  }
} catch (e) {
  const err = e as Error & { code?: unknown };
  // The message only: a driver error can carry the address it tried, so neither it nor the stack is printed.
  const said = String(err.message ?? err).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***").slice(0, 300);
  console.error(`audit-key-scan: could not ${redact && yes ? "redact" : "read"} the audit trails: ${said}`);
  process.exitCode = err.code === 2 ? 2 : 1;
} finally {
  await db?.close().catch(() => {});
}
