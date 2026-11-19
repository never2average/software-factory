// The audit key scan (mold_v0-323), offline: an embedded database whose audit trails hold, as entries written before
// mold_v0-322 did, keys kept in clear (a workspace key whose six public characters hold - or _, one whose six are plain,
// a developer key, a GitHub and a Slack token, a connection string with a password, a key in a legacy /mcp/<key> route)
// beside harmless strings; then the scan in-process, then `npm run operator:audit-key-scan` itself.
//   npm run test:audit-key-scan
//
// Proves:
//   1. every credential is found where it is (table, row, JSON path, kind), across workspaces; nothing harmless is
//      (a word with a key's prefix, an already masked value, a sentence, an address, a sha256)
//   2. what is shown: an app key by its listed prefix with whether a key with that prefix is active, revoked or not
//      found; anything else by its kind and last 4 characters; the output (text and --json) never holds more of a value
//   3. read-only: a write inside the scan's transaction fails (25006), it is rolled back, a connection that would not go
//      read-only is refused; the rows are byte for byte the same afterwards
//   4. --redact: refused without --yes (exit 3, nothing changed); with it, only the flagged values in the kept requests
//      are masked (a credential inside a longer string: its span), the chained text columns stay, the chain still
//      verifies and the trails are append-only again
//   5. the script: exit 0 with findings, 2 for a bad argument
// Every key-shaped value is built at run time: no tracked file holds one (the repository's secret gate).
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const alnum = (n: number) => { let s = ""; while (s.length < n) s += randomBytes(n).toString("base64").replace(/[^A-Za-z0-9]/g, ""); return s.slice(0, n); };
/** A random base64url tail with upper and lower case and a digit, as a real key's. */
const tail = (n: number) => `Q${alnum(n - 3)}z7`;

// The fakes (prefixes joined at run time).
const OCT = ["oc", "t_"].join("");
const KEY_DASH = `${OCT}Ab-9_x${tail(26)}`;          // its six hold - and _: kept in clear before mold_v0-322
const KEY_PLAIN = `${OCT}Qw3rTy${tail(26)}`;          // its six plain: as a pre-fix entry's header kept it
const KEY_ROUTE = `${OCT}R_7k-Z${tail(26)}`;          // came in a legacy /mcp/<key> address
const DEV_KEY = `${["s", "k_"].join("")}Zx_7Lm${tail(43)}`;
const GH = `${["gh", "p_"].join("")}${alnum(36)}`;
const SLACK = `${["xo", "xb-"].join("")}${String(Date.now()).slice(-10)}-${String(Date.now()).slice(-9)}1-${alnum(24)}`;
const PASS = `pw${randomBytes(5).toString("hex")}`; // 12 characters: under 16, so nothing of it is shown
const HOST = ["db", "internal", "acme", "net"].join("."); // joined at run time: no tracked line reads as an address with a password
const CONN = `postgres://app:${PASS}@${HOST}:5432/app`;
const CONN_MASKED = `postgres://app:••••@${HOST}:5432/app`;
const SECRETS = [KEY_DASH, KEY_PLAIN, KEY_ROUTE, DEV_KEY, GH, SLACK, PASS];
const HARMLESS = ["app_settings_dashboard", "key_rotation_policy_2024", `${OCT}ab12cd••••`, "Bearer ••••", "Please look at the quarterly numbers again",
  "https://example.com/docs/getting-started", sha("x"), "re_run_the_import_tomorrow_please"];

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const [a] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name) VALUES ('scan-a', 'Scan A') RETURNING id");
  const [b] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name) VALUES ('scan-b', 'Scan B') RETURNING id");
  // KEY_DASH is still active, KEY_PLAIN was revoked; KEY_ROUTE and DEV_KEY are no key of this app.
  await db.query("INSERT INTO api_keys (org_id, label, key_prefix, key_hash) VALUES ($1, 'ci', $2, $3)", [a.id, KEY_DASH.slice(0, 10), sha(KEY_DASH)]);
  await db.query("INSERT INTO api_keys (org_id, label, key_prefix, key_hash, revoked_at) VALUES ($1, 'old', $2, $3, now())", [b.id, KEY_PLAIN.slice(0, 10), sha(KEY_PLAIN)]);

  const plat = (scope: number, seq: number, org: number | null, p: string, request: unknown) => db.query(
    `INSERT INTO audit_platform_events (scope_id, seq, org_id, at, kind, channel, method, path, actor_kind, request)
     VALUES ($1, $2, $3, $4, 'request', 'api', 'POST', $5, 'key', $6::jsonb)`, [scope, seq, org, `2026-11-1${seq}T09:00:00Z`, p, request === null ? null : JSON.stringify(request)]);
  // A: a body with the dashed key, a harmless body, an MCP call's arguments with a GitHub token and a connection string.
  await plat(a.id, 1, a.id, "/api/records", { method: "POST", path: "/api/records", headers: { authorization: `Bearer ••••`, "x-trace": "abc" },
    body: { notes: KEY_DASH, title: HARMLESS[0], list: [HARMLESS[1], HARMLESS[2]], text: HARMLESS[4] } });
  await plat(a.id, 2, a.id, "/api/records", { method: "GET", path: "/api/records", headers: { authorization: HARMLESS[3] }, body: { url: HARMLESS[5], digest: HARMLESS[6], note: HARMLESS[7] } });
  await plat(a.id, 3, a.id, "/mcp tools/call", { method: "POST", path: "/mcp", headers: {}, body: null,
    tools: [{ name: "save_note", arguments: { text: `clone with ${GH} please`, db: CONN } }] });
  // B: a header not named for a secret holding the plain key, a body cut at 16 KB (as text) holding a Slack token.
  await plat(b.id, 1, b.id, "/api/records", { method: "POST", path: "/api/records", headers: { "x-upstream": KEY_PLAIN }, body: null });
  await plat(b.id, 2, b.id, "/api/records", { method: "POST", path: "/api/records", headers: {}, body: JSON.stringify({ hook: SLACK, a: "x".repeat(40) }).slice(0, 120), truncated: true });
  // The platform's own (no workspace): a legacy /mcp/<key> request, its key in the chained route and in the request.
  await plat(0, 1, null, `/mcp/${KEY_ROUTE}`, { method: "POST", path: `/mcp/${KEY_ROUTE}`, headers: {}, body: null });
  // A data entry of A: the developer key in a field.
  await db.query(`INSERT INTO audit_data_events (org_id, seq, at, actor_kind, action, target, channel, area, record_key, request)
    VALUES ($1, 1, '2026-11-12T10:00:00Z', 'user', 'create', 'record', 'api', 'notes', 'n-1', $2::jsonb)`,
    [a.id, JSON.stringify({ method: "POST", path: "/api/records", headers: {}, body: { data: { remark: DEV_KEY, plain: HARMLESS[4] } } })]);
  await db.close();

  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR!;
  let lite = await PGlite.create(dir);
  const rows = async () => JSON.stringify((await lite.query("SELECT * FROM audit_platform_events ORDER BY scope_id, seq")).rows)
    + JSON.stringify((await lite.query("SELECT * FROM audit_data_events ORDER BY org_id, seq")).rows);
  const before = await rows();
  const { scanAuditKeys, formatScan, credentialsIn, maskCredentials } = await import("../src/audit-key-scan.js");

  // ---------- 3. read-only ----------
  const seen: string[] = [];
  let writeCode: string | undefined;
  const spy = {
    async query(sql: string, params?: unknown[]) {
      seen.push(sql);
      if (/FROM audit_platform_events/.test(sql) && writeCode === undefined) {
        await lite.query("SAVEPOINT probe");
        try { await lite.query("INSERT INTO organizations (slug, name) VALUES ('w', 'w')"); writeCode = "none"; }
        catch (e) { writeCode = (e as { code?: string }).code ?? "unknown"; }
        await lite.query("ROLLBACK TO SAVEPOINT probe");
      }
      return lite.query(sql, params) as Promise<{ rows: any[] }>;
    },
  };
  const r = await scanAuditKeys(spy);
  assert.equal(writeCode, "25006", "a write inside the scan's transaction fails: read-only (25006)");
  assert.equal(seen[0], "BEGIN"); assert.equal(seen[1], "SET TRANSACTION READ ONLY", "read-only before the first query");
  assert.equal(seen.at(-1), "ROLLBACK", "rolled back, never committed");
  assert.ok(!seen.some((s) => /COMMIT|INSERT|UPDATE|DELETE|ALTER/i.test(s.replace(/\/\*[\s\S]*?\*\//g, ""))), "no statement of the scan writes");
  const lax = { query: (sql: string, params?: unknown[]) => (sql === "SET TRANSACTION READ ONLY" ? Promise.resolve({ rows: [] }) : lite.query(sql, params) as Promise<{ rows: any[] }>) };
  await assert.rejects(scanAuditKeys(lax), /could not be made read-only/);
  assert.equal(await rows(), before, "the rows are exactly as before");
  console.log("✓ read-only: a write inside the scan's transaction is refused (25006), it is rolled back, a lax connection is refused, nothing changed");

  // ---------- 1. what is found, and where ----------
  const where = r.findings.map((f) => `${f.table} ${f.row} ${f.path} ${f.kind}`).sort();
  const expected = [
    `audit_platform_events ${a.id}/1 request.body.notes workspace API key (oct_)`,
    `audit_platform_events ${a.id}/3 request.tools[0].arguments.text GitHub token`,
    `audit_platform_events ${a.id}/3 request.tools[0].arguments.db connection string with a password`,
    `audit_platform_events ${b.id}/1 request.headers.x-upstream workspace API key (oct_)`,
    `audit_platform_events ${b.id}/2 request.body Slack token`,
    `audit_platform_events 0/1 path workspace API key (oct_)`,
    `audit_platform_events 0/1 request.path workspace API key (oct_)`,
    `audit_data_events ${a.id}/1 request.body.data.remark developer key (sk_)`,
  ].sort();
  assert.deepEqual(where, expected, "every credential, and nothing harmless");
  for (const h of HARMLESS) assert.deepEqual(credentialsIn(h), [], `harmless: ${h.slice(0, 12)}`);
  assert.deepEqual(r.by_table, { audit_platform_events: 7, audit_data_events: 1 });
  assert.equal(r.by_kind["workspace API key (oct_)"], 4); assert.equal(r.by_kind["GitHub token"], 1); assert.equal(r.by_kind["Slack token"], 1);
  assert.deepEqual(r.by_workspace.map((w) => [w.slug, w.findings]).sort(), [[null, 2], ["scan-a", 4], ["scan-b", 2]]);
  assert.equal(r.first_at, "2026-11-11T09:00:00.000Z"); assert.equal(r.last_at, "2026-11-13T09:00:00.000Z");
  assert.equal(r.rows_with_findings, 6);
  console.log("✓ found: each key in a body, a header, an MCP call's arguments, a body cut as text, a legacy route and a data entry; nothing harmless; counts per table, kind and workspace; the dates");

  // ---------- 2. what is shown ----------
  const one = (p: string, row: string) => r.findings.find((f) => f.path === p && f.row === row)!;
  assert.equal(one("request.body.notes", `${a.id}/1`).prefix, KEY_DASH.slice(0, 10), "an app key: its listed prefix");
  assert.equal(one("request.body.notes", `${a.id}/1`).key_status, "this key is still active");
  assert.equal(one("request.headers.x-upstream", `${b.id}/1`).key_status, "this key is revoked");
  assert.equal(one("path", "0/1").key_status, "not found (no key with this prefix)");
  assert.equal(one("request.body.data.remark", `${a.id}/1`).prefix, DEV_KEY.slice(0, 9));
  assert.equal(one("request.tools[0].arguments.text", `${a.id}/3`).last4, GH.slice(-4), "anything else: its last 4");
  assert.equal(one("request.tools[0].arguments.text", `${a.id}/3`).prefix, null);
  assert.equal(one("request.tools[0].arguments.db", `${a.id}/3`).last4, null, "a short password: nothing of it");
  assert.equal(one("path", "0/1").redactable, false, "a chained column is never redacted");
  const text = formatScan(r);
  if (process.env.AUDIT_KEY_SCAN_SHOW) console.log(text);
  assert.match(text, /Audit key scan \(READ ONLY/);
  assert.match(text, /By workspace: .*Scan A \(scan-a\) 4/);
  const allowed = (s: string) => [s.startsWith(OCT) ? s.slice(0, 10) : s.startsWith(DEV_KEY.slice(0, 3)) ? s.slice(0, 9) : ""];
  const leaks = (out: string) => SECRETS.flatMap((s) => {
    const ok = allowed(s)[0]!;
    const bad: string[] = [];
    for (let i = 0; i + 6 <= s.length; i++) { const w = s.slice(i, i + 6); if (!ok.includes(w) && out.includes(w)) bad.push(`${s.slice(0, 3)}…@${i}`); }
    return bad;
  });
  assert.deepEqual(leaks(text), [], "the text never holds six characters of a value beyond a listed prefix");
  assert.deepEqual(leaks(JSON.stringify(r)), [], "nor the JSON");
  assert.equal(maskCredentials(`clone with ${GH} please`), "clone with •••• please", "a credential inside a sentence: its span");
  assert.equal(maskCredentials(KEY_DASH), "••••");
  assert.equal(maskCredentials(CONN), CONN_MASKED);
  console.log("✓ shown: an app key by its listed prefix and whether it is active, revoked or not found; others by kind and last 4; never more of a value");
  await lite.close();

  // ---------- 5 and 4. the script, as the factory runs it ----------
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const line: string = pkg.scripts["operator:audit-key-scan"];
  assert.match(line, /^node (--[^\s]+ )*scripts\/operator\/audit-key-scan\.ts$/, "a plain `node <flags> scripts/operator/<file>` line");
  assert.match(readFileSync(path.join(ROOT, "scripts", "operator", "audit-key-scan.ts"), "utf8").split("\n")[0]!, /^\/\/ READ-ONLY\. /);
  const argv = line.split(" ").filter((t) => !t.startsWith("--env-file"));
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, PGLITE_DIR: dir, NODE_ENV: "production" };
  const go = (...extra: string[]) => spawnSync(argv[0]!, [...argv.slice(1), ...extra], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
  const t = go();
  assert.equal(t.status, 0, t.stderr); assert.match(t.stdout, /Found 8 credential\(s\) in 6 row\(s\)/);
  const j = go("--json");
  assert.equal(j.status, 0, j.stderr); assert.equal(JSON.parse(j.stdout).findings.length, 8);
  for (const bad of [["--set"], ["--yes"], ["--json", "x"]]) assert.equal(go(...bad).status, 2, `bad arguments ${bad.join(" ")}: exit 2`);
  const ask = go("--redact");
  assert.equal(ask.status, 3, ask.stderr); assert.match(ask.stdout, /--redact needs --yes: it would mask 7 value\(s\)/);
  for (const out of [t.stdout + t.stderr, j.stdout + j.stderr, ask.stdout]) assert.deepEqual(leaks(out), []);
  lite = await PGlite.create(dir);
  assert.equal(await rows(), before, "the scan and a refused --redact change nothing");
  await lite.close();
  console.log("✓ npm run operator:audit-key-scan: text and --json exit 0 with findings, 2 for bad arguments, --redact without --yes exit 3 and nothing changed");

  const red = go("--redact", "--yes");
  assert.equal(red.status, 0, red.stderr); assert.match(red.stdout, /Masked 7 value\(s\) in 6 row\(s\)/); assert.deepEqual(leaks(red.stdout), []);
  lite = await PGlite.create(dir);
  const req = async (scope: number, seq: number) => (await lite.query<{ request: any; path: string }>("SELECT request, path FROM audit_platform_events WHERE scope_id = $1 AND seq = $2", [scope, seq])).rows[0]!;
  const a1 = (await req(a.id, 1)).request;
  assert.equal(a1.body.notes, "••••"); assert.equal(a1.body.title, HARMLESS[0]); assert.deepEqual(a1.body.list, [HARMLESS[1], HARMLESS[2]]); assert.equal(a1.body.text, HARMLESS[4]);
  assert.deepEqual(a1.headers, { authorization: "Bearer ••••", "x-trace": "abc" });
  assert.deepEqual((await req(a.id, 2)).request.body, { url: HARMLESS[5], digest: HARMLESS[6], note: HARMLESS[7] }, "a row with nothing flagged is unchanged");
  const a3 = (await req(a.id, 3)).request;
  assert.equal(a3.tools[0].arguments.text, "clone with •••• please"); assert.equal(a3.tools[0].arguments.db, CONN_MASKED);
  assert.equal(a3.tools[0].name, "save_note");
  assert.equal((await req(b.id, 1)).request.headers["x-upstream"], "••••");
  assert.ok(!(await req(b.id, 2)).request.body.includes(SLACK) && (await req(b.id, 2)).request.body.includes("••••"));
  const route = await req(0, 1);
  assert.equal(route.path, `/mcp/${KEY_ROUTE}`, "the chained route is left as it was"); assert.equal(route.request.path, "/mcp/••••");
  const d1 = (await lite.query<{ request: any }>("SELECT request FROM audit_data_events WHERE org_id = $1", [a.id])).rows[0]!.request;
  assert.deepEqual(d1.body, { data: { remark: "••••", plain: HARMLESS[4] } });
  const chain = await lite.query<{ ok: boolean }>(`SELECT bool_and(hash = app_ledger_hash(prev_hash, app_ledger_fields_platform(e))) AS ok FROM audit_platform_events e`);
  assert.equal(chain.rows[0]!.ok, true, "the chain still verifies: the request is not among its fields");
  const dchain = await lite.query<{ ok: boolean }>(`SELECT bool_and(hash = app_ledger_hash(prev_hash, app_ledger_fields_data(e))) AS ok FROM audit_data_events e`);
  assert.equal(dchain.rows[0]!.ok, true);
  await assert.rejects(lite.query("UPDATE audit_platform_events SET status = 1"), /append-only/, "the trail is append-only again");
  await assert.rejects(lite.query("UPDATE audit_data_events SET rows = 1"), /append-only/);
  await lite.close();
  const again = go("--json");
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).findings.map((f: { path: string }) => f.path), ["path"], "after --redact only the chained route's key is left");
  console.log("✓ --redact --yes: only the flagged values masked (a span inside a sentence or an address), the chained route left, the chain verifies, append-only again");
  console.log("AUDIT KEY SCAN TEST PASS");
} finally {
  cleanup();
}
