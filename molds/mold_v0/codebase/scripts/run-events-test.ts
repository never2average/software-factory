// The operator's read-only run report (mold_v0-183), offline: an embedded database with a run shaped like Maxwell's
// first refresh (a "succeeded" run whose program said it was refused its write, and whose write-back changed nothing),
// the report read in-process, then `npm run audit:run-events` itself as the factory runs it.
//   npm run test:run-events
//
// Proves:
//   1. the run's events in order, its state and cost, the count of each type; --type, --attempt and --limit (truncated
//      is said); the program's own words (step lines, its result file) are there to read
//   2. --recent lists the latest runs' ids, kinds and states (newest first, a pack's only with --pack)
//   3. never a secret: a token or a URL's password inside an event is masked in text and --json
//   4. read-only: the report's transaction refuses a write made inside it (25006), is rolled back; a connection that
//      would not go read-only is refused before anything is read; the rows are byte for byte the same afterwards
//   5. the script: exit 0 with a report, 3 for a run that does not exist, 2 for a bad argument (nothing read)
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const TOKEN = `ghp_RUNEVENTSCANARY${randomBytes(12).toString("hex")}`;
  const PASS = `pw${randomBytes(10).toString("hex")}`;
  const [org] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name) VALUES ('re-org', 'RE Org') RETURNING id");
  const run = (id: string, kind: string, status: string, at: string) => db.query(
    `INSERT INTO runs (id, org_id, pack, kind, status, attempt, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, cost_usd, targets, scope, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, '{}'::jsonb, 1, 600, 60, 40, 3.678372, $6::jsonb, $7::jsonb, $8)`,
    [id, org.id, kind === "other" ? "fixture_other" : "fixture_re", kind, status, JSON.stringify({ asset: { area: "applications", key: "app-1" } }),
     JSON.stringify({ application: { appId: "app-1", secret_note: TOKEN } }), at]);
  await run("run_refresh01", "refresh_apps", "succeeded", "2026-10-30T20:59:49Z");
  await run("run_seed0001", "seed_company", "succeeded", "2026-10-30T19:56:27Z");
  await run("run_other001", "other", "failed", "2026-10-30T18:00:00Z");
  const events: [string, number, string, unknown][] = [
    ["run_refresh01", 0, "queued", { kind: "refresh_apps" }],
    ["run_refresh01", 1, "claimed", { worker_id: "sbx-18" }],
    ["run_refresh01", 1, "workspace_restored", { restored: 3, kept_aside: 0 }],
    ["run_refresh01", 1, "log", { line: `  "result": "The repo record update was blocked. A permission deny rule covers applications/app-1/repos/app-1.json", "clone": "https://x-access-token:${PASS}@github.com/acme/app"` }],
    ["run_refresh01", 1, "stderr", { tail: `[run-headless] claude -p ... token ${TOKEN}` }],
    ["run_refresh01", 1, "agent_output", { path: "maxwell-result.json", size: 99, sha256: "0".repeat(64), json: { result: "wrote no files", files: null, auth: `Bearer ${TOKEN}` } }],
    ["run_refresh01", 1, "workspace_ignored", { paths: 1, sample: ["applications/app-1/repos/app-1"] }],
    ["run_refresh01", 1, "workspace_written", { version: 1, unchanged: true }],
    ["run_refresh01", 1, "succeeded", { cost_usd: 3.678372 }],
    ["run_seed0001", 1, "succeeded", {}],
  ];
  for (const [id, attempt, type, data] of events)
    await db.query("INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, $3, $4, $5::jsonb)", [id, org.id, attempt, type, JSON.stringify(data)]);
  await db.close();

  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR!;
  let lite = await PGlite.create(dir);
  const fingerprint = async () => createHash("sha256").update(JSON.stringify((await lite.query("SELECT * FROM runs ORDER BY id")).rows)
    + JSON.stringify((await lite.query("SELECT * FROM run_events ORDER BY id")).rows)).digest("hex");
  const before = await fingerprint();
  const { runEvents, recentRuns, formatRunEvents, formatRecentRuns, maskSecrets } = await import("../src/run-events.js");

  // ---------- 4. read-only ----------
  const seen: string[] = [];
  let writeCode: string | undefined;
  const spy = {
    async query(sql: string, params?: unknown[]) {
      seen.push(sql);
      if (/FROM runs r/.test(sql) && writeCode === undefined) {
        await lite.query("SAVEPOINT probe");
        try { await lite.query("UPDATE runs SET status = 'failed'"); writeCode = "none"; }
        catch (e) { writeCode = (e as { code?: string }).code ?? "unknown"; }
        await lite.query("ROLLBACK TO SAVEPOINT probe");
      }
      return lite.query(sql, params) as Promise<{ rows: any[] }>;
    },
  };
  const r = await runEvents(spy, { run: "run_refresh01" });
  assert.equal(writeCode, "25006", "a write inside the report's transaction fails: read-only (25006)");
  assert.equal(seen[0], "BEGIN"); assert.equal(seen[1], "SET TRANSACTION READ ONLY", "read-only before the first query");
  assert.equal(seen.at(-1), "ROLLBACK", "rolled back, never committed");
  assert.ok(!seen.some((s) => /COMMIT|INSERT|UPDATE|DELETE|nextval|pg_advisory/i.test(s)), "no statement of the report writes");
  assert.ok(!seen.some((s) => /vault_|gateway_tokens|lease_token|credentials/i.test(s)), "nothing of the vault, a token or a credential is read");
  const lax = { query: (sql: string, params?: unknown[]) => (sql === "SET TRANSACTION READ ONLY" ? Promise.resolve({ rows: [] }) : lite.query(sql, params) as Promise<{ rows: any[] }>) };
  await assert.rejects(runEvents(lax, { run: "run_refresh01" }), /could not be made read-only/);
  await assert.rejects(runEvents(lite as never, { run: "run_x'; DROP TABLE runs; --" }), /not a run id/);
  await assert.rejects(runEvents(lite as never, { run: "run_refresh01", types: ["a b"] }), /not an event type/);
  console.log("✓ read-only: a write inside the report's transaction is refused (25006), it is rolled back, a lax connection is refused, bad ids are refused before any read");

  // ---------- 1. the run's own account ----------
  assert.equal(r.run?.status, "succeeded"); assert.equal(r.run?.kind, "refresh_apps"); assert.equal(r.run?.workspace, "re-org"); assert.equal(r.run?.cost_usd, 3.678372);
  assert.deepEqual(r.run?.scope_keys, ["application"], "the scope's keys only, never its values");
  assert.deepEqual(r.events.map((e) => e.type), ["queued", "claimed", "workspace_restored", "log", "stderr", "agent_output", "workspace_ignored", "workspace_written", "succeeded"], "in order");
  assert.equal(r.total, 9); assert.equal(r.truncated, false); assert.equal(r.counts.log, 1); assert.equal(r.counts.workspace_written, 1);
  assert.deepEqual(r.events.find((e) => e.type === "workspace_written")?.data, { version: 1, unchanged: true });
  const only = await runEvents(lite as never, { run: "run_refresh01", types: ["workspace_written", "agent_output"] });
  assert.deepEqual(only.events.map((e) => e.type), ["agent_output", "workspace_written"]); assert.equal(only.total, 2); assert.equal(only.counts.log, 1, "counts are of every type");
  const first = await runEvents(lite as never, { run: "run_refresh01", limit: 2 });
  assert.equal(first.events.length, 2); assert.equal(first.truncated, true);
  assert.deepEqual((await runEvents(lite as never, { run: "run_refresh01", attempt: 0 })).events.map((e) => e.type), ["queued"]);
  assert.equal((await runEvents(lite as never, { run: "run_nosuch01" })).run, null);
  const text = formatRunEvents(r);
  if (process.env.RUN_EVENTS_SHOW) console.log(text);
  assert.match(text, /fixture_re\/refresh_apps: succeeded, attempt 1 of 1, cost 3\.678372 USD/);
  assert.match(text, /workspace_written \{"version":1,"unchanged":true\}/);
  assert.match(text, /A permission deny rule covers applications\/app-1\/repos\/app-1\.json/, "the program's own words");
  assert.match(text, /maxwell-result\.json \(99 bytes\)\n {4}\{[^\n]*"result":"wrote no files"/, "its result file's JSON");
  assert.match(formatRunEvents(first), /2 of 9 event\(s\) shown \(raise --limit for the rest\)/);
  console.log("✓ the run's events in order with its state, cost and counts; --type, --attempt and --limit; the program's words and result file are readable");

  // ---------- 2. --recent ----------
  const recent = await recentRuns(lite as never, {});
  assert.deepEqual(recent.map((x) => x.id), ["run_refresh01", "run_seed0001", "run_other001"], "newest first");
  assert.deepEqual((await recentRuns(lite as never, { pack: "fixture_re", limit: 1 })).map((x) => x.id), ["run_refresh01"]);
  assert.match(formatRecentRuns(recent), /run_seed0001 {2}2026-10-30T19:56:27\.000Z {2}re-org {2}fixture_re\/seed_company {2}succeeded/);
  console.log("✓ --recent: the latest runs' ids, kinds and states, newest first; a pack's only with --pack");

  // ---------- 3. never a secret ----------
  for (const out of [text, JSON.stringify(r), JSON.stringify(recent)]) {
    assert.ok(!out.includes(TOKEN), "no token"); assert.ok(!out.includes(PASS), "no URL password");
  }
  assert.match(text, /https:\/\/\*\*\*@github\.com\/acme\/app/);
  assert.equal(maskSecrets("see sk-ant-api03-abcdefghijklmnop and oct_abcdefghijklmnop"), "see sk-ant-api03-*** and oct_***");
  console.log("✓ never a secret: tokens and URL passwords inside events are masked; the scope's values are never read out");
  await lite.close();

  // ---------- 5. the script, as the factory runs it (its package line, without --env-file) ----------
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const line: string = pkg.scripts["audit:run-events"];
  assert.match(line, /^node (--[^\s]+ )*scripts\/operator\/run-events\.ts$/, "a plain `node <flags> scripts/operator/<file>` line (the factory's allow-list)");
  assert.match(readFileSync(path.join(ROOT, "scripts", "operator", "run-events.ts"), "utf8").split("\n")[0]!, /^\/\/ READ-ONLY\. /, "its first line says READ-ONLY (the factory reads it)");
  const argv = line.split(" ").filter((t) => !t.startsWith("--env-file"));
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, PGLITE_DIR: dir, NODE_ENV: "production" };
  const go = (...extra: string[]) => spawnSync(argv[0]!, [...argv.slice(1), ...extra], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
  const t = go("run_refresh01");
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /Run run_refresh01 \(READ ONLY; nothing was changed\)/);
  assert.match(t.stdout, /workspace_written \{"version":1,"unchanged":true\}/);
  const j = go("run_refresh01", "--type", "workspace_written", "--json");
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(JSON.parse(j.stdout).events.map((e: { type: string }) => e.type), ["workspace_written"]);
  const rc = go("--recent", "5", "--json");
  assert.equal(rc.status, 0, rc.stderr); assert.equal(JSON.parse(rc.stdout).runs.length, 3);
  assert.equal(go("run_nosuch01").status, 3, "no such run: exit 3");
  for (const bad of [["--set", "x"], [], ["run_refresh01", "--recent"], ["run_refresh01", "--limit", "x"]]) assert.equal(go(...bad).status, 2, `bad arguments ${bad.join(" ")}: exit 2`);
  for (const out of [t.stdout + t.stderr, j.stdout + j.stderr]) { assert.ok(!out.includes(TOKEN)); assert.ok(!out.includes(PASS)); }
  lite = await PGlite.create(dir);
  assert.equal(await fingerprint(), before, "the runs and their events are exactly as before");
  await lite.close();
  console.log("✓ npm run audit:run-events: text and --json, --recent, exit 3 for no such run and 2 for bad arguments, no secret printed, nothing changed");
  console.log("RUN EVENTS TEST PASS");
} finally {
  cleanup();
}
