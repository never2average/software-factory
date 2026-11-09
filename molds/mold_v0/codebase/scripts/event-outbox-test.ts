// The developer surface's event outbox (mold_v0-202; src/developer-webhooks.ts, sql/migrations/0036_event_outbox.sql),
// with real processes: this file is the orchestrator (a local webhook receiver; no database of its own) and, with
// --stage, each step run in a process of its own against the same database.
//   npm run test:event-outbox                                     an embedded database (PGlite), the stages one at a time
//   OUTBOX_PG_URL=postgres://user:pass@host:port/db npm run test:event-outbox   a Postgres server: a new database on it,
//                                                                 dropped at the end; the schedulers run as 3 processes
//
//  1. A rolled-back change leaves no event: a refused batch, a transaction that throws after its event was written, a
//     refused single write. A tool build (no developer surface) writes nothing and asks for no transaction.
//  2. Tenant isolation: a tenant transaction cannot write another workspace's event, nor read the outbox; one
//     workspace's events reach its own endpoints only.
//  3. A crash between the commit and the enqueue: a process writes a record and is killed (SIGKILL) right after the
//     commit, before anything relays it; the event is in the outbox, not queued. A new process's scheduler step delivers
//     it, once.
//  4. Exactly once under 3 concurrent schedulers: 60 pending events; three schedulers relay and deliver at the same time
//     (three processes on Postgres; three loops in one process on PGlite, which takes one process at a time); every
//     event is queued once and delivered once.
//  5. run.finished: the transaction that ends a run writes it (the runs trigger); a run rolled back writes nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SELF = path.join(ROOT, "scripts", "event-outbox-test.ts");
const at = process.argv.indexOf("--stage");
const STAGE = at >= 0 ? process.argv[at + 1]! : null;
const N = 60;

/** A stage's answer: one line on stdout. */
const answer = (o: unknown) => console.log(`RESULT ${JSON.stringify(o)}`);

if (STAGE) {
  await runStage(STAGE);
  process.exit(0);
}

// ---------------------------------------------------------------- the orchestrator

const TMP = mkdtempSync(path.join(tmpdir(), "event-outbox-"));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  APP_VAULT_KEY: randomBytes(32).toString("base64"),
  APP_REGISTRY: "scripts/fixtures/registry.json",
  APP_WORKER_TOKEN: `test-worker-${randomBytes(8).toString("hex")}`,
  REASONS_ENABLED: "off", APP_AUTOSCALE: "off", APP_ORG_MONTHLY_BUDGET_USD: "1000",
  APP_PREVIEW: "1", // a local receiver (a preview server's rule)
};
const PG = process.env.OUTBOX_PG_URL ?? "";
let dropDb: (() => Promise<void>) | null = null;
if (PG) {
  const { default: pg } = await import("pg");
  const name = `outbox_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: PG });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(PG); u.pathname = `/${name}`;
  env.DATABASE_URL = u.toString();
  dropDb = async () => { const c = new pg.Client({ connectionString: PG }); await c.connect(); await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await c.end(); };
} else {
  delete env.DATABASE_URL;
  env.PGLITE_DIR = path.join(TMP, "pglite");
}

/** A local webhook receiver: every request it got. */
async function receiver() {
  const got: { headers: IncomingMessage["headers"]; body: any }[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { got.push({ headers: req.headers, body: JSON.parse(b) }); res.writeHead(200).end("ok"); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/hook`, got, close: () => srv.close() };
}

/** Run one stage in a process of its own: its exit (code or signal) and its RESULT. */
function stage(name: string, extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; signal: NodeJS.Signals | null; result: any; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--import", "tsx", SELF, "--stage", name], { cwd: ROOT, env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code, signal) => {
      const line = out.split("\n").reverse().find((l) => l.startsWith("RESULT "));
      resolve({ code, signal, result: line ? JSON.parse(line.slice(7)) : null, out });
    });
  });
}
const ok = (r: Awaited<ReturnType<typeof stage>>, what: string) => {
  assert.equal(r.code, 0, `${what} failed:\n${r.out.split("\n").filter((l) => !/^migration \d+/.test(l)).slice(-40).join("\n")}`);
  return r.result;
};

const hookA = await receiver(), hookB = await receiver();
try {
  console.log(`event outbox: ${PG ? "Postgres (a new database)" : "PGlite"}`);
  const ids = ok(await stage("setup", { HOOK_A: hookA.url, HOOK_B: hookB.url }), "setup");
  const ORGS = { ORG_A: String(ids.a), ORG_B: String(ids.b), ORG_T: String(ids.t) };

  // 1 + 2. rollbacks and isolation (in one process).
  ok(await stage("rollback", ORGS), "rollback");
  console.log("✓ a rolled-back change leaves no event: a refused batch, a transaction that throws after writing its event, a refused single write; a tool build writes nothing");
  ok(await stage("isolation", ORGS), "isolation");

  // 3. The crash.
  const crash = await stage("crash", ORGS);
  assert.equal(crash.signal, "SIGKILL", `the writer was killed right after its commit (${crash.code} ${crash.signal}):\n${crash.out.slice(-2000)}`);
  const before = ok(await stage("inspect", ORGS), "inspect");
  assert.equal(before.pending, 1, `the committed record's event is in the outbox, pending (${JSON.stringify(before)})`);
  assert.equal(before.deliveries, 0, "and nothing was queued before the crash");
  assert.equal(before.record, 1, "the record itself committed");
  assert.equal(hookA.got.filter((g) => g.body.data?.key === "CRASH-1").length, 0, "nothing was sent");
  assert.deepEqual(hookA.got.map((g) => g.body.data?.key).sort(), ["ISO-OWN", "RB-5"], "only the stored writes' events reached A, once each");
  ok(await stage("restart", ORGS), "restart");
  const crashed = hookA.got.filter((g) => g.body.type === "record.created" && g.body.data.key === "CRASH-1");
  assert.equal(crashed.length, 1, `the event is delivered after the restart, once (${crashed.length})`);
  ok(await stage("restart", ORGS), "restart again");
  assert.equal(hookA.got.filter((g) => g.body.data.key === "CRASH-1").length, 1, "a second restart sends nothing again");
  console.log("✓ a crash between the commit and the enqueue: the writer killed (SIGKILL) after its commit left the event pending in the outbox; the next process's scheduler step delivered it, once");

  // 4. Three schedulers at once.
  ok(await stage("many", ORGS), "many");
  const t0 = Date.now();
  if (PG) {
    const runs = await Promise.all([1, 2, 3].map((i) => stage("scheduler", { ...ORGS, SCHEDULER: String(i) })));
    runs.forEach((r, i) => ok(r, `scheduler ${i + 1}`));
    console.log(`  three scheduler processes: relayed ${runs.map((r) => r.result.events).join(" + ")} events, attempted ${runs.map((r) => r.result.attempted).join(" + ")} deliveries (${Date.now() - t0} ms)`);
    assert.ok(runs.filter((r) => r.result.events > 0).length >= 2, "the schedulers shared the work (at least two relayed some)");
  } else ok(await stage("schedulers-in-process", ORGS), "schedulers");
  const bulk = hookA.got.filter((g) => typeof g.body.data.key === "string" && g.body.data.key.startsWith("BULK-"));
  const keys = bulk.map((g) => g.body.data.key);
  assert.equal(new Set(keys).size, N, `every event delivered (${new Set(keys).size} of ${N})`);
  assert.equal(keys.length, N, `each once (${keys.length} deliveries for ${N} events)`);
  assert.equal(new Set(bulk.map((g) => g.headers["webhook-id"])).size, N, "one webhook-id each");
  const after = ok(await stage("inspect", ORGS), "inspect");
  assert.equal(after.pending, 0, "nothing pending");
  assert.equal(after.dupes, 0, "no event queued twice for an endpoint");
  assert.equal(after.attempts_max, 1, "each event relayed by one scheduler, in one attempt");
  console.log(`✓ exactly once under 3 concurrent schedulers (${PG ? "processes" : "loops in one process"}): ${N} events, ${N} deliveries, one webhook-id each, each event relayed once`);

  // 5. run.finished.
  ok(await stage("runs", ORGS), "runs");
  ok(await stage("restart", ORGS), "restart");
  const fin = hookA.got.filter((g) => g.body.type === "run.finished");
  assert.equal(fin.length, 1, `run.finished once (${fin.length})`);
  assert.equal(fin[0]!.body.data.run.status, "succeeded");
  assert.match(fin[0]!.body.data.run.ended_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  console.log("✓ run.finished: written by the transaction that ends the run (the runs trigger), delivered once; a run ended in a transaction rolled back writes nothing");

  assert.equal(hookB.got.length, 0, `workspace B's endpoint heard nothing of A (${hookB.got.length})`);
  console.log("✓ tenant isolation: a tenant transaction cannot write another workspace's event nor read the outbox; B's endpoint heard nothing of A");
  console.log("event outbox: all checks passed");
} finally {
  hookA.close(); hookB.close();
  await dropDb?.().catch((e) => console.error(`drop: ${(e as Error).message}`));
  rmSync(TMP, { recursive: true, force: true });
}
process.exit(0);

// ---------------------------------------------------------------- the stages (each in its own process)

async function runStage(name: string) {
  const ORG_A = Number(process.env.ORG_A), ORG_B = Number(process.env.ORG_B), ORG_T = Number(process.env.ORG_T);
  if (name === "crash") {
    // The first listener after the commit, registered before the developer surface's own: the process dies right after
    // the record's transaction committed, before anything relays or queues its event.
    const ra = await import("../src/record-areas.js");
    ra.onRecordChange((c) => { if (c.key === "CRASH-1") process.kill(process.pid, "SIGKILL"); });
  }
  const { installEmbedded } = await import("./lib/embedded-fixture.js");
  await installEmbedded();
  const { getDb } = await import("../src/db.js");
  const db = await getDb();
  const hooks = await import("../src/developer-webhooks.js");
  const { workspaceRecords, inTransaction } = await import("../src/record-areas.js");
  const { withTenant, asPlatform } = await import("../src/tenant-scope.js");
  const recs = (org: number) => workspaceRecords("fixture_embedded", org);
  const count = async (sql: string, p: unknown[] = []) => Number((await asPlatform(() => db.query<{ n: number }>(sql, p)))[0]!.n);
  const outboxOf = (org: number) => count("SELECT count(*)::int AS n FROM event_outbox WHERE org_id = $1", [org]);

  switch (name) {
    case "setup": {
      const { createOrg } = await import("../src/auth.js");
      const tag = randomBytes(3).toString("hex");
      const a = (await createOrg(`Outbox A ${tag}`)).org.orgId, b = (await createOrg(`Outbox B ${tag}`)).org.orgId, t = (await createOrg(`Outbox T ${tag}`)).org.orgId;
      await hooks.createEndpoint(a, { url: process.env.HOOK_A }, "test");
      await hooks.createEndpoint(b, { url: process.env.HOOK_B }, "test");
      await hooks.createEndpoint(t, { url: process.env.HOOK_B }, "test");
      return answer({ a, b, t });
    }
    case "rollback": {
      // A refused batch (its second operation is invalid): nothing stored, no event.
      await assert.rejects(withTenant(ORG_A, () => recs(ORG_A).batch([
        { op: "create", area: "tickets", key: "RB-1", data: { summary: "kept?" } },
        { op: "create", area: "tickets", key: "RB-2", data: { points: 1000 } },
      ])));
      assert.equal(await outboxOf(ORG_A), 0, "a refused batch leaves no event");
      // A transaction that wrote its event, then threw.
      await assert.rejects(withTenant(ORG_A, () => inTransaction(ORG_A, async () => {
        await recs(ORG_A).create("tickets", "RB-3", { data: { summary: "rolled back" } });
        throw new Error("after the write");
      })), /after the write/);
      assert.equal(await outboxOf(ORG_A), 0, "a transaction rolled back after writing its event leaves none");
      assert.equal(await count("SELECT count(*)::int AS n FROM workspace_records WHERE org_id = $1 AND key = 'RB-3'", [ORG_A]), 0, "nor its record");
      // The event written straight on a transaction that then fails.
      await assert.rejects(asPlatform(async () => db.transaction(async (tx) => {
        assert.equal(await hooks.emitEvent(ORG_A, "record.created", { area: "tickets", key: "RB-4" }, "rb-4", tx), 1, "written inside");
        throw new Error("rolled back");
      })), /rolled back/);
      assert.equal(await outboxOf(ORG_A), 0, "an emitted event rolled back with its transaction");
      // A refused single write (the key exists): its transaction rolls back.
      await withTenant(ORG_A, () => recs(ORG_A).create("tickets", "RB-5", { data: { summary: "once" } }));
      const one = await outboxOf(ORG_A);
      assert.equal(one, 1, "a stored write has its event");
      await assert.rejects(withTenant(ORG_A, () => recs(ORG_A).create("tickets", "RB-5", { data: { summary: "twice" } })), /already exists/);
      assert.equal(await outboxOf(ORG_A), one, "a refused single write adds none");
      await hooks.webhookTick(); await hooks.settled();
      // A tool build (the fixture without its developer surface): nothing written, no transaction asked for.
      await installEmbedded((j) => { delete j.developer_surface; });
      const before = await count("SELECT count(*)::int AS n FROM event_outbox");
      await withTenant(ORG_T, () => recs(ORG_T).create("tickets", "TOOL-1", { data: { summary: "tool" } }));
      assert.equal(await count("SELECT count(*)::int AS n FROM event_outbox"), before, "a tool build writes no event");
      assert.equal(await hooks.webhookTick(), null, "and its tick does nothing");
      return answer({ ok: true });
    }
    case "isolation": {
      const { NO_ACCESS } = await import("../src/rls.js");
      assert.ok(NO_ACCESS.includes("event_outbox") && NO_ACCESS.includes("developer_events"), "the outbox is closed to tenant work");
      // As workspace A's tenant: another workspace's event is refused; reading the outbox is refused.
      await assert.rejects(withTenant(ORG_A, async () => db.query("SELECT app_event_outbox_put($1, 'record.created', 'x-b', '{}'::jsonb)", [ORG_B])), /another workspace|permission denied/);
      await assert.rejects(withTenant(ORG_A, async () => db.query("SELECT count(*) FROM event_outbox")), /permission denied/);
      await assert.rejects(withTenant(ORG_A, async () => db.query("INSERT INTO event_outbox (org_id, event_type, dedupe_key, payload) VALUES ($1, 'record.created', 'x', '{}')", [ORG_A])), /permission denied/);
      // Its own: through the function only.
      const [own] = await withTenant(ORG_A, async () => db.query<{ id: string | null }>("SELECT app_event_outbox_put($1, 'record.created', 'iso-own', '{\"type\":\"record.created\",\"data\":{\"key\":\"ISO-OWN\"}}'::jsonb)::text AS id", [ORG_A]));
      assert.ok(own?.id, "its own event is written");
      await hooks.webhookTick(); await hooks.settled();
      return answer({ ok: true });
    }
    case "crash": {
      await withTenant(ORG_A, () => recs(ORG_A).create("tickets", "CRASH-1", { data: { summary: "written, then the process dies" } }));
      throw new Error("the process should have been killed after the commit");
    }
    case "inspect": {
      return answer({
        pending: await count("SELECT count(*)::int AS n FROM event_outbox WHERE relayed_at IS NULL"),
        deliveries: await count("SELECT count(*)::int AS n FROM webhook_deliveries d JOIN event_outbox o ON o.dedupe_key = d.dedupe_key AND o.org_id = d.org_id WHERE o.relayed_at IS NULL"),
        record: await count("SELECT count(*)::int AS n FROM workspace_records WHERE org_id = $1 AND key = 'CRASH-1'", [ORG_A]),
        dupes: await count("SELECT count(*)::int AS n FROM (SELECT endpoint_id, dedupe_key FROM webhook_deliveries GROUP BY 1, 2 HAVING count(*) > 1) x"),
        attempts_max: await count("SELECT coalesce(max(attempts), 0)::int AS n FROM event_outbox"),
      });
    }
    case "restart": {
      const r = await hooks.webhookTick();
      await hooks.settled();
      for (let i = 0; i < 3; i++) { await hooks.deliverDue(); await hooks.settled(); }
      return answer(r);
    }
    case "many": {
      // N events written on transactions (as a record write does), none relayed yet.
      for (let i = 0; i < N; i++)
        await withTenant(ORG_A, async () => db.transaction(async (tx) =>
          hooks.emitEvent(ORG_A, "record.created", { area: "tickets", key: `BULK-${i}` }, `bulk:${i}`, tx)));
      assert.equal(await count("SELECT count(*)::int AS n FROM event_outbox WHERE relayed_at IS NULL"), N);
      return answer({ ok: true });
    }
    case "scheduler":
    case "schedulers-in-process": {
      const loop = async () => {
        let events = 0, attempted = 0;
        for (let idle = 0; idle < 3;) {
          const r = await hooks.relayOutbox(5);
          const d = await hooks.deliverDue(5);
          events += r.events; attempted += d.attempted;
          idle = r.events || d.attempted ? 0 : idle + 1;
          await new Promise((res) => setTimeout(res, 20));
        }
        return { events, attempted };
      };
      if (name === "scheduler") {
        // Start together: wait for the next whole second.
        await new Promise((res) => setTimeout(res, 1000 - (Date.now() % 1000)));
        return answer(await loop());
      }
      const all = await Promise.all([loop(), loop(), loop()]);
      return answer({ events: all.map((x) => x.events), attempted: all.map((x) => x.attempted) });
    }
    case "runs": {
      const run = `run_outbox_${randomBytes(4).toString("hex")}`;
      await asPlatform(() => db.query(
        `INSERT INTO runs (id, org_id, pack, kind, status, spec, max_attempts, token_lifetime_seconds, lease_seconds, budget_usd)
         VALUES ($1, $2, 'fixture_embedded', 'triage', 'queued', '{}'::jsonb, 1, 600, 60, 1)`, [run, ORG_A]));
      // Ended in a transaction rolled back: no event.
      await assert.rejects(asPlatform(async () => db.transaction(async (tx) => {
        await tx.query("UPDATE runs SET status = 'succeeded', ended_at = now() WHERE id = $1", [run]);
        assert.equal(Number((await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM event_outbox WHERE event_type = 'run.finished'"))[0]!.n), 1, "the trigger wrote it inside");
        throw new Error("rolled back");
      })), /rolled back/);
      assert.equal(await count("SELECT count(*)::int AS n FROM event_outbox WHERE event_type = 'run.finished'"), 0, "a run ended in a rolled-back transaction has no event");
      await asPlatform(() => db.query("UPDATE runs SET status = 'succeeded', ended_at = now() WHERE id = $1", [run]));
      await asPlatform(() => db.query("UPDATE runs SET updated_at = now() WHERE id = $1", [run]));
      assert.equal(await count("SELECT count(*)::int AS n FROM event_outbox WHERE event_type = 'run.finished'"), 1, "once per run and attempt");
      return answer({ ok: true });
    }
  }
  throw new Error(`no stage ${name}`);
}
