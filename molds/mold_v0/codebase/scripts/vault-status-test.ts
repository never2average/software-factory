// The operator's read-only key vault report (mold_v0-173), offline: an embedded database, the report read in-process
// against it with a fixture pack, then `npm run operator:vault-status` itself as the factory runs it.
//   npm run test:vault-status
//
// Proves:
//   1. set and unset are reported as the gateway would find them: a key turned on is set; a provider with its only key
//      turned off, a turned-off provider, or one without a key is not; a Vertex AI backend counts its service-account key
//   2. what the build's run kinds need (their providers, their operator credentials' labels, boat for their sandboxes)
//      and which of those are missing; queued runs and the latest reason they were given for waiting
//   3. never a value: a recognisable secret seeded into the vault (and its display hint) appears in no output, text or
//      --json, and no query the report runs names a sealed column
//   4. read-only: the report's transaction refuses a write made inside it (SQLSTATE 25006), is rolled back, and a
//      connection that would not go read-only is refused before anything is read; the vault's rows (use counters too)
//      are byte-for-byte the same after the script ran
import "./lib/test-world.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { cleanup } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SEALED = /\b(ciphertext|iv|tag|hint|key_id|meta)\b/i;

try {
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const kv = await import("../src/keyvault.js");
  const { setPacksForTest } = await import("../src/packs.js");
  const { definePack } = await import("../src/pack-api.js");
  const { vaultStatus, formatVaultStatus } = await import("../src/vault-status.js");

  // ---------- the vault and the runs ----------
  const CANARY = `sk-ant-api03-VAULTSTATUSCANARY${randomBytes(12).toString("hex")}`;
  const BOAT = `boat_live_CANARY${randomBytes(10).toString("hex")}`;
  const OFF = `sk-proj-OFFCANARY${randomBytes(10).toString("hex")}`;
  const OPCRED = `opcred-CANARY-${randomBytes(10).toString("hex")}`;
  await kv.setCredential("anthropic", CANARY);
  await kv.setCredential("boat", BOAT);
  const off = await kv.setCredential("openai", OFF);
  await kv.setCredentialEnabled(off.id, false);
  await db.query(`INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars) VALUES ('pack_credentials', 'direct', NULL, 'authorization', '', '{}') ON CONFLICT (slug) DO NOTHING`);
  await kv.setCredential("pack_credentials", OPCRED, { label: "fixture_vs.catalogue_login" });
  await db.query("UPDATE vault_providers SET enabled = false WHERE slug = 'resend'");
  const secrets = [CANARY, BOAT, OFF, OPCRED];
  const hints = secrets.map((s) => kv.hint(s));
  const [org] = await db.query<{ id: number }>("INSERT INTO organizations (slug, name) VALUES ('vs-org', 'VS Org') RETURNING id");
  for (const [id, kind, at] of [["run_vs1", "scan", "2026-10-28T10:00:00Z"], ["run_vs2", "scan", "2026-10-28T11:00:00Z"], ["run_vs3", "audit", "2026-10-28T12:00:00Z"]])
    await db.query(`INSERT INTO runs (id, org_id, pack, kind, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd, created_at)
                    VALUES ($1, $2, 'fixture_vs', $3, '{}'::jsonb, 1, 600, 60, 1, $4)`, [id, org.id, kind, at]);
  await db.query(`INSERT INTO runs (id, org_id, pack, kind, status, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd)
                  VALUES ('run_vs4', $1, 'fixture_vs', 'scan', 'succeeded', '{}'::jsonb, 1, 600, 60, 1)`, [org.id]);
  for (const [run, reason] of [["run_vs1", "older reason"], ["run_vs2", "no sandbox: the vault has no boat key"], ["run_vs4", "a finished run's reason"]])
    await db.query(`INSERT INTO run_events (run_id, org_id, attempt, type, data) VALUES ($1, $2, 0, 'waiting', $3::jsonb)`, [run, org.id, JSON.stringify({ reason })]);

  const fixture = definePack({
    id: "fixture_vs",
    jobKinds: [
      { name: "scan", label: "Scan", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15, providers: ["anthropic", "google"], operator_credentials: ["catalogue_login", "other_login"] },
      { name: "audit", label: "Audit", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15, providers: ["anthropic"] },
    ],
    operatorCredentials: [{ name: "catalogue_login", label: "Catalogue login", deliver_as: { env: "FIXTURE_CAT_LOGIN" } },
                          { name: "other_login", label: "Other login", deliver_as: { env: "FIXTURE_OTHER_LOGIN" } }],
  });
  setPacksForTest([{ manifest: { id: "fixture_vs", name: "Fixture vault status", version: "1", entry: "index.ts", migrations: null,
                                 dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture } as never]);
  await db.close();

  // ---------- the report, in-process, on a connection of its own ----------
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR!;
  let lite = await PGlite.create(dir);
  const fingerprint = async () => createHash("sha256").update(JSON.stringify(
    (await lite.query("SELECT * FROM vault_credentials ORDER BY id")).rows) + JSON.stringify((await lite.query("SELECT * FROM vault_providers ORDER BY slug")).rows)
    + JSON.stringify((await lite.query("SELECT id, status, updated_at FROM runs ORDER BY id")).rows) + JSON.stringify((await lite.query("SELECT count(*) FROM run_events")).rows)).digest("hex");
  const before = await fingerprint();

  const seen: string[] = [];
  let writeCode: string | undefined;
  const spy = {
    async query(sql: string, params?: unknown[]) {
      seen.push(sql);
      if (/FROM vault_providers/.test(sql) && writeCode === undefined) {
        // A write inside the report's own transaction, after it was made read-only: refused.
        // (under a savepoint, so the refused write does not abort the report's own reads)
        await lite.query("SAVEPOINT probe");
        try { await lite.query("UPDATE vault_credentials SET uses = uses + 1"); writeCode = "none"; }
        catch (e) { writeCode = (e as { code?: string }).code ?? "unknown"; }
        await lite.query("ROLLBACK TO SAVEPOINT probe");
      }
      return lite.query(sql, params) as Promise<{ rows: any[] }>;
    },
  };
  const r = await vaultStatus(spy);
  assert.equal(writeCode, "25006", "a write inside the report's transaction fails: read-only (25006)");
  assert.equal(seen[0], "BEGIN"); assert.equal(seen[1], "SET TRANSACTION READ ONLY", "read-only before the first query");
  assert.equal(seen.at(-1), "ROLLBACK", "the transaction is rolled back, never committed");
  assert.ok(!seen.some((s) => /COMMIT|INSERT|UPDATE|DELETE|nextval|pg_advisory/i.test(s)), "no statement of the report writes");
  for (const s of seen) assert.ok(!SEALED.test(s), `no query names a sealed column: ${s}`);
  assert.equal((await lite.query<{ transaction_read_only: string }>("SHOW transaction_read_only")).rows[0].transaction_read_only, "off", "out of the transaction afterwards");
  console.log("✓ read-only: a write inside the report's transaction is refused (25006); it is rolled back; no query names a sealed column");

  const p = (slug: string) => r.providers.find((x) => x.slug === slug);
  assert.equal(p("anthropic")?.set, "yes"); assert.equal(p("anthropic")?.keys, 1); assert.ok(p("anthropic")?.last_changed_at, "when the key last changed");
  assert.equal(p("anthropic")?.category, "Inference"); assert.equal(p("anthropic")?.name, "Anthropic");
  assert.equal(p("boat")?.set, "yes"); assert.equal(p("boat")?.category, "Sandbox");
  assert.equal(p("openai")?.set, "no"); assert.match(p("openai")?.note ?? "", /all turned off/);
  assert.equal(p("resend")?.set, "no"); assert.match(p("resend")?.note ?? "", /provider turned off/);
  assert.equal(p("cloudflare")?.set, "no"); assert.equal(p("cloudflare")?.last_changed_at, null);
  assert.equal(p("google")?.set, "no", "a kind's provider without a key is listed, unset");
  assert.ok(!p("cursor") && r.hidden.includes("cursor"), "a provider nothing in this build reads is left out (--all lists it)");
  assert.ok(!p("github_app"), "the GitHub App's entry is not a key");
  const allR = await vaultStatus(lite as never, { all: true });
  assert.ok(allR.providers.some((x) => x.slug === "cursor" && !x.in_build), "--all: every provider, with in_build");
  console.log("✓ set and unset as the gateway finds them (on, all turned off, provider off, none); unread providers only with --all");

  assert.equal(r.runs.kinds, 2); assert.deepEqual(r.runs.packs, ["fixture_vs"]);
  assert.equal(r.runs.sandbox_mode, "auto"); assert.equal(r.runs.boat_for_runs, true, "auto with job kinds: boat");
  const need = (slug: string) => r.runs.needs.find((n) => n.slug === slug);
  assert.deepEqual(r.runs.needs.map((n) => n.slug), ["anthropic", "boat", "google", "pack_credentials"]);
  assert.deepEqual(need("anthropic")?.kinds, ["fixture_vs.scan", "fixture_vs.audit"]); assert.equal(need("anthropic")?.set, "yes");
  assert.equal(need("google")?.set, "no");
  assert.equal(need("boat")?.set, "yes"); assert.match(need("boat")?.why ?? "", /sandboxes/);
  assert.deepEqual(need("pack_credentials")?.missing_labels, ["fixture_vs.other_login"], "an operator credential's label without a key");
  assert.deepEqual(r.runs.missing, ["google", "pack_credentials"]);
  assert.equal(r.queued?.count, 3); assert.equal(r.queued?.oldest_at, "2026-10-28T10:00:00.000Z");
  assert.deepEqual(r.queued?.by_kind, [{ pack: "fixture_vs", kind: "scan", count: 2 }, { pack: "fixture_vs", kind: "audit", count: 1 }]);
  assert.equal(r.queued?.latest_waiting?.reason, "no sandbox: the vault has no boat key", "the latest waiting reason on a queued run");
  const text = formatVaultStatus(r);
  if (process.env.VAULT_STATUS_SHOW) console.log(text);
  assert.match(text, /needs Google Gemini \(google\) for 1 run kind \(fixture_vs\.scan\): MISSING/);
  assert.match(text, /Missing for the runs: google, pack_credentials/);
  assert.match(text, /Queued runs: 3/);
  console.log("✓ what the run kinds need (providers, operator credentials' labels, boat), what is missing, queued runs and why they wait");

  // the boat rule follows the deployment's sandbox
  process.env.APP_RUN_SANDBOX = "docker";
  const dr = await vaultStatus(lite as never);
  assert.ok(!dr.runs.needs.some((n) => n.slug === "boat") && dr.runs.sandbox_mode_from === "deployment", "APP_RUN_SANDBOX=docker: boat is not needed");
  delete process.env.APP_RUN_SANDBOX;

  // Object storage (mold_v0-181): a kind that keeps a workspace store needs a bucket; from the vault when this run's
  // environment names none (no R2_*, no APP_STORAGE_DIR). Not needed while the fixture has no such kind (above).
  assert.ok(!r.runs.needs.some((n) => n.slug === "object_storage") && !p("object_storage"), "no workspace store: Object storage neither needed nor listed");
  const R2 = ["R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
  for (const k of [...R2, "APP_STORAGE_DIR"]) delete process.env[k];
  const withStore = definePack({ ...fixture, id: "fixture_vs", jobKinds: [...(fixture.jobKinds ?? []), { name: "notes", label: "Notes", runner: "workspace-harness", entry: "noop.mjs", lease_seconds: 15, workspace: true }] as never });
  setPacksForTest([{ manifest: { id: "fixture_vs", name: "Fixture vault status", version: "1", entry: "index.ts", migrations: null,
                                 dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: withStore } as never]);
  const sr = await vaultStatus(lite as never);
  const store = sr.runs.needs.find((n) => n.slug === "object_storage");
  assert.deepEqual([store?.set, store?.kinds, store?.category], ["no", ["fixture_vs.notes"], "Storage"], "a workspace store with no bucket anywhere: Object storage needed, not set");
  assert.ok(sr.runs.missing.includes("object_storage"));
  assert.ok(sr.providers.some((x) => x.slug === "object_storage" && x.in_build && x.set === "no"), "and listed on the vault (in the build)");
  assert.match(formatVaultStatus(sr), /needs Object storage \(R2 \/ S3\) \(object_storage\) for the workspace store of 1 run kind \(no R2_\* in this run's environment\) \(fixture_vs\.notes\): MISSING/);
  for (const env of [Object.fromEntries(R2.map((k) => [k, "x"])), { APP_STORAGE_DIR: "/tmp/x" }]) {
    Object.assign(process.env, env);
    assert.ok(!(await vaultStatus(lite as never)).runs.needs.some((n) => n.slug === "object_storage"), `${Object.keys(env)[0]}: the deployment has a store, not needed from the vault`);
    for (const k of Object.keys(env)) delete process.env[k];
  }
  setPacksForTest([{ manifest: { id: "fixture_vs", name: "Fixture vault status", version: "1", entry: "index.ts", migrations: null,
                                 dir: path.join(ROOT, "scripts", "fixtures", "runs") }, definition: fixture } as never]);
  console.log("✓ a workspace store with no bucket in the environment: 'needs Object storage: MISSING'; R2_* or APP_STORAGE_DIR: not needed");

  // Claude through Vertex AI (src/gateway.ts): no Anthropic key, but a Vertex AI service-account key: set, via Vertex AI.
  // Done on this connection and undone after, so the rows are as they were for the final check.
  await lite.query("UPDATE vault_credentials SET enabled = false WHERE provider = 'anthropic'");
  const noKey = await vaultStatus(lite as never);
  assert.equal(noKey.runs.needs.find((n) => n.slug === "anthropic")?.set, "no", "no Anthropic key and no Vertex key: MISSING");
  assert.match(formatVaultStatus(noKey), /needs Anthropic \(anthropic\) for 2 run kinds .*: MISSING/);
  for (const [provider, label] of [["vertex", "default"], ["anthropic", "vertex"]]) {
    await lite.query(`INSERT INTO vault_credentials (provider, label, ciphertext, iv, tag, key_id, hint) VALUES ($1, $2, 'x', 'x', 'x', 'x', 'sa@example.iam.gserviceaccount.com')`, [provider, label]);
    const viaVertex = await vaultStatus(lite as never);
    const a = viaVertex.runs.needs.find((n) => n.slug === "anthropic");
    assert.deepEqual([a?.set, a?.note?.startsWith("via Vertex AI")], ["yes", true], `${provider}/${label}: set, via Vertex AI`);
    assert.ok(!viaVertex.runs.missing.includes("anthropic"));
    assert.match(formatVaultStatus(viaVertex), /needs Anthropic \(anthropic\) for 2 run kinds \(fixture_vs\.scan, fixture_vs\.audit\): set \(via Vertex AI: no Anthropic key/);
    await lite.query("DELETE FROM vault_credentials WHERE provider = $1 AND label = $2", [provider, label]);
  }
  await lite.query("UPDATE vault_credentials SET enabled = true WHERE provider = 'anthropic'");
  assert.equal((await vaultStatus(lite as never)).runs.needs.find((n) => n.slug === "anthropic")?.note, null, "its own key again: set, no note");
  console.log("✓ Claude through Vertex AI: no Anthropic key but a Vertex AI key (the provider's, or anthropic's own \"vertex\" key): 'set (via Vertex AI)', not MISSING");

  // mutation: a connection on which the transaction would not become read-only is refused before anything is read
  const lax = { query: (sql: string, params?: unknown[]) => (sql === "SET TRANSACTION READ ONLY" ? Promise.resolve({ rows: [] }) : lite.query(sql, params) as Promise<{ rows: any[] }>) };
  await assert.rejects(vaultStatus(lax), /could not be made read-only/);
  console.log("✓ a transaction that is not read-only is refused before any read");

  for (const [s, h] of secrets.map((s, i) => [s, hints[i]])) {
    for (const out of [text, JSON.stringify(r), JSON.stringify(allR)]) { assert.ok(!out.includes(s), "no secret in the report"); assert.ok(!out.includes(h), "no hint in the report"); }
  }
  await lite.close();
  setPacksForTest(null);

  // ---------- the operator script itself, as the factory runs it (its package line, without --env-file) ----------
  const pkg = JSON.parse((await import("node:fs")).readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const line: string = pkg.scripts["operator:vault-status"];
  assert.match(line, /^node (--[^\s]+ )*scripts\/operator\/vault-status\.ts$/, "a plain `node <flags> scripts/operator/<file>` line (the factory's allow-list)");
  const argv = line.split(" ").filter((t) => !t.startsWith("--env-file"));
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, PGLITE_DIR: dir, NODE_ENV: "production" };
  const run = (...extra: string[]) => spawnSync(argv[0], [...argv.slice(1), ...extra], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
  const t = run();
  assert.equal(t.status, 0, `the script reports and exits 0: ${t.stderr}`);
  if (process.env.VAULT_STATUS_SHOW) console.log(t.stdout);
  assert.match(t.stdout, /Anthropic \(anthropic\)\s+Inference\s+yes\s+1\/1\s+\d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.match(t.stdout, /OpenAI \(openai\)\s+Inference\s+no\s+0\/1/);
  assert.match(t.stdout, /Queued runs: 3/);
  const j = run("--json");
  assert.equal(j.status, 0, j.stderr);
  const doc = JSON.parse(j.stdout);
  assert.equal(doc.read_only, true); assert.equal(doc.providers.find((x: any) => x.slug === "anthropic").set, "yes");
  for (const out of [t.stdout + t.stderr, j.stdout + j.stderr]) for (const [i, s] of secrets.entries()) {
    assert.ok(!out.includes(s), "the script never prints a secret"); assert.ok(!out.includes(hints[i]), "nor its hint");
  }
  const b = run("--set", "x");
  assert.equal(b.status, 2, "an unknown argument: exit 2, nothing read");
  lite = await PGlite.create(dir);
  assert.equal(await fingerprint(), before, "the vault's rows, their use counters and the runs are exactly as before");
  await lite.close();
  console.log("✓ npm run operator:vault-status: text and --json, exit 0, no secret or hint printed, nothing in the database changed");
  console.log("VAULT STATUS TEST PASS");
} finally {
  cleanup();
}
