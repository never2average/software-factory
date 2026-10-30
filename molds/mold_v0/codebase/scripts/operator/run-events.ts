// READ-ONLY. One run's events in order (what the runner and the run engine recorded), or the latest runs' ids; never a key, a token or a credential.
//   npm run audit:run-events -- <run_id> [--type <event type>]... [--attempt <n>] [--limit <n>] [--full] [--json]
//   npm run audit:run-events -- --recent [<n>] [--pack <id>] [--json]
//   python3 .claude/scripts/provision.py <app_id> --operator audit:run-events -- <run_id> [...]   (the factory; an audit:
//   script writes nothing, so it runs without a yes)
//
// mold_v0-183: "the run succeeded but its records did not change" is answered from the run itself: its steps' output
// lines (step_log), the agent's output files (agent_output: Maxwell's out/maxwell-result.json), what the write-back
// left out (workspace_ignored), what it committed (workspace_written) and what the index made of it (workspace_indexed).
//
// It connects once with the app's own role (DATABASE_URL; without one, the local PGlite database), opens ONE
// transaction, makes it READ ONLY before anything else (SET TRANSACTION READ ONLY, then SHOW transaction_read_only must
// say on), reads, and rolls it back (src/run-events.ts). It never calls the app's getDb, which migrates on first use:
// DATABASE_URL is taken out of the environment before any of the app's modules load, so one that tried would fail.
// Exit 0: reported. 1: the database could not be read. 2: bad arguments. 3: no run with that id.
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const usage = "usage: audit:run-events <run_id> [--type t]... [--attempt n] [--limit n] [--full] [--json] | --recent [n] [--pack id] [--json] (it never writes)";
const flags = new Set(["--json", "--full", "--recent"]);
const valued = new Set(["--type", "--attempt", "--limit", "--pack"]);
let runId: string | undefined, recentN: number | undefined, attempt: number | undefined, limit: number | undefined, pack: string | undefined;
const types: string[] = [];
const seen = new Set<string>();
const fail = (m: string) => { console.error(`run-events: ${m}\n${usage}`); process.exit(2); };
const int = (v: string | undefined, what: string) => { if (v === undefined || !/^\d{1,6}$/.test(v)) fail(`${what} takes a whole number`); return Number(v); };
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (flags.has(a)) {
    seen.add(a);
    if (a === "--recent" && args[i + 1] && /^\d+$/.test(args[i + 1]!)) recentN = int(args[++i], "--recent");
  } else if (valued.has(a)) {
    const v = args[++i];
    if (v === undefined) fail(`${a} needs a value`);
    if (a === "--type") types.push(v!);
    else if (a === "--attempt") attempt = int(v, a);
    else if (a === "--limit") limit = int(v, a);
    else pack = v;
  } else if (!a.startsWith("-") && runId === undefined) runId = a;
  else fail(`unknown argument ${a.slice(0, 80)}`);
}
const json = seen.has("--json"), full = seen.has("--full"), recent = seen.has("--recent");
if (recent === (runId !== undefined)) fail(recent ? "--recent takes no run id" : "name a run id, or --recent");

const url = process.env.DATABASE_URL;
// The app's own modules must never open the app's database themselves: its getDb runs migrations. With this address
// any such attempt fails instead of connecting.
process.env.DATABASE_URL = "postgres://run-events-reads-through-its-own-read-only-transaction.invalid:1/none";
process.env.APP_MIGRATE_ON_BOOT = "off";

async function connect(): Promise<{ conn: import("../../src/vault-status.js").RawConn; close: () => Promise<void> }> {
  if (url) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url, application_name: "audit:run-events (read-only)" });
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
  const m = await import("../../src/run-events.js");
  if (recent) {
    const rows = await m.recentRuns(db.conn, { pack, limit: recentN });
    console.log(json ? JSON.stringify({ read_only: true, runs: rows }, null, 2) : m.formatRecentRuns(rows));
    process.exitCode = 0;
  } else {
    const r = await m.runEvents(db.conn, { run: runId!, types, limit, attempt });
    console.log(json ? JSON.stringify(r, null, 2) : m.formatRunEvents(r, { full }));
    process.exitCode = r.run ? 0 : 3;
  }
} catch (e) {
  const err = e as Error & { code?: unknown };
  // The message only: a driver error can carry the address it tried, so neither it nor the stack is printed.
  const said = String(err.message ?? err).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***");
  console.error(`run-events: could not read the run: ${said}`);
  process.exitCode = err.code === 2 ? 2 : 1;
} finally {
  await db?.close().catch(() => {});
}
