/**
 * Hermetic test of the server's on-demand orchestrator autoscaler (src/autoscaler.ts): real server modules on a
 * temp PGlite + a mock boat API. Covers: kill switch; no demand -> nothing; queued work -> exactly one launch even
 * with two autoscaler instances (lease); named snapshot image built once, then used for launches; the cap; idle ->
 * drain -> sandbox deleted (+ cooldown, no relaunch loop); stale and stuck-booting sandboxes reaped; orphans deleted.
 *
 *   npx tsx orchestrator/test/autoscaler.ts
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "octillion-astest-"));
const BOAT_PORT = Number(process.env.ATEST_BOAT_PORT ?? 3405);
const BOAT_KEY = `boat_mock_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, {
  PGLITE_DIR: path.join(tmp, "pglite"), OCTILLION_VAULT_KEY: randomBytes(32).toString("base64"), OCTILLION_WORKER_TOKEN: `wt_${randomBytes(8).toString("hex")}`,
  PUBLIC_URL: "https://octi.example", BOAT_API_URL: `http://127.0.0.1:${BOAT_PORT}/api/v1`, OCTILLION_POD_CAPACITY: "3", OCTILLION_MAX_ORCHESTRATORS: "2",
  OCTILLION_AUTOSCALE_TICK_SECONDS: "15", OCTILLION_ORCH_IDLE_MINUTES: "10", BOAT_STARTS_PER_MINUTE: "100", OCTILLION_ORCH_SNAPSHOT: "on",
  OCTILLION_ORCH_PER_JOB: "off", // the shared fleet; one orchestrator per job is orchestrator/test/per-job.ts
  OCTILLION_ORG_MONTHLY_BUDGET_USD: "1000", // accounts without a plan get $0 (prepaid, invite-only)
});
delete process.env.DATABASE_URL; delete process.env.CLICKHOUSE_URL;

const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[atest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// ---------------------------------------------------------------- mock boat
interface Sb { id: string; name: string; state: string; from?: string; createdAt: string; files: Map<string, string> }
const sbs = new Map<string, Sb>();
const snaps = new Map<string, { status: string; at: number }>();
let creates = 0, fromImageCreates = 0, deletes = 0, failPreflight = false;
const workerTokenInFiles: string[] = [];
const json = (res: http.ServerResponse, s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
const boat = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${BOAT_KEY}`) return json(res, 401, { ok: false, code: "unauthorized" });
    const b = raw ? JSON.parse(raw) : {};
    const u = String(req.url).replace(/^\/api\/v1/, "").split("?")[0]!;
    if (u === "/limits") return json(res, 200, { ok: true, currentLimits: { activeSandboxes: 100 }, startLimits: { perMinute: 12, perHour: 60, perDay: 200 }, activeSandboxes: [...sbs.values()].filter((s) => s.state === "ready").length });
    if (u === "/sandboxes" && req.method === "GET") return json(res, 200, { ok: true, sandboxes: [...sbs.values()].map(({ files: _f, ...s }) => s), pageInfo: { nextCursor: null } });
    if (u === "/sandboxes" && req.method === "POST") {
      const id = `bx_${randomBytes(4).toString("hex")}`;
      creates++; if (b.from) fromImageCreates++;
      sbs.set(id, { id, name: "", state: "ready", from: b.from, createdAt: new Date().toISOString(), files: new Map() });
      return json(res, 202, { ok: true, sandbox: { id, state: "provisioning" } });
    }
    if (u === "/named-snapshots" && req.method === "POST") { snaps.set(b.name, { status: "saving", at: Date.now() }); return json(res, 202, { ok: true, snapshot: { name: b.name, status: "saving" } }); }
    if (u === "/named-snapshots" && req.method === "GET") return json(res, 200, { ok: true, snapshots: [...snaps.keys()].map((name) => ({ name })) });
    const ns = /^\/named-snapshots\/(.+)$/.exec(u);
    if (ns) {
      const s = snaps.get(decodeURIComponent(ns[1]!));
      if (req.method === "DELETE") { snaps.delete(decodeURIComponent(ns[1]!)); return json(res, 200, { ok: true }); }
      if (!s) return json(res, 404, { ok: false, code: "not_found" });
      if (Date.now() - s.at > 300) s.status = "ready";
      return json(res, 200, { ok: true, snapshot: { name: ns[1], status: s.status } });
    }
    const m = /^\/sandboxes\/(bx_\w+)(\/.*)?$/.exec(u);
    const sb = m ? sbs.get(m[1]!) : undefined;
    if (!sb) return json(res, 404, { ok: false, code: "not_found" });
    const rest = m![2] ?? "";
    if (req.method === "GET" && rest === "") return json(res, 200, { ok: true, sandbox: { id: sb.id, state: sb.state, name: sb.name } });
    if (req.method === "PATCH") { if (b.name) sb.name = b.name; return json(res, 200, { ok: true }); }
    if (req.method === "DELETE") { if (sb.state !== "deleted") deletes++; sbs.delete(sb.id); return json(res, 202, { ok: true, type: "sandbox.deleting" }); }
    if (req.method === "PUT" && rest === "/files") { sb.files.set(b.path, b.content); if (String(b.content).includes(process.env.OCTILLION_WORKER_TOKEN!)) workerTokenInFiles.push(`${sb.name || sb.id}:${b.path}`); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && rest === "/commands") {
      const cmd = String(b.command);
      const stdout = /in-sandbox\.ts preflight/.test(cmd) ? (failPreflight ? '{"ok":false,"reason":"API unreachable"}' : '{"ok":true,"reason":"reachable"}')
        : /test -x .*tsx/.test(cmd) ? (sb.from ? "yes" : "no") : /systemctl (enable|is-active)/.test(cmd) ? "active" : "";
      return json(res, 200, { ok: true, exitCode: 0, stdout, stderr: "" });
    }
    json(res, 404, { ok: false, code: "not_found" });
  });
});
await new Promise<void>((r) => boat.listen(BOAT_PORT, "127.0.0.1", () => r()));

// ---------------------------------------------------------------- server modules (after env)
const { getDb } = await import("../../src/db.js");
const { createOrg } = await import("../../src/auth.js");
const q = await import("../../src/queries.js");
const kv = await import("../../src/keyvault.js");
const fleet = await import("../../src/fleet.js");
const { Autoscaler, AUTOSCALE } = await import("../../src/autoscaler.js");
const db = await getDb();
await kv.setCredential("boat", BOAT_KEY, { label: "test" });
const { org } = await createOrg("Autoscale Test", "astest");
const O = org;
await q.saveProduct(O, { name: "left-pad", packages: ["left-pad"] });
const queue = async (n: number) => {
  await q.saveScenarios(O, "left-pad", Array.from({ length: n }, (_, i) => ({ title: `t${i}-${Math.random()}`, prompt: `Task number ${i}: add zero padding to the invoice numbers in this small Node project.` })));
  // Shared-pool mode serves only non-private runs: these tasks stand in for library tasks (customer-written ones are private).
  await db.query("UPDATE scenarios SET source = 'library' WHERE product_id = (SELECT id FROM products WHERE slug = 'left-pad' AND org_id = $1)", [O.orgId]);
  return q.runSimulation(O, { product: "left-pad", agents: ["codex/default"], repeats: 1 });
};
const rows = async () => db.query<any>("SELECT * FROM orchestrator_sandboxes WHERE state <> 'deleted' ORDER BY id");
const quiet: string[] = [];
const a1 = new Autoscaler({ log: (m) => quiet.push(`a1 ${m}`) });
const a2 = new Autoscaler({ log: (m) => quiet.push(`a2 ${m}`) });

try {
  // kill switch
  process.env.OCTILLION_AUTOSCALE = "off";
  const off = await a1.tick();
  check("kill switch: OCTILLION_AUTOSCALE=off does nothing", !off.enabled && creates === 0, off.note ?? "");
  delete process.env.OCTILLION_AUTOSCALE;

  // no demand
  const idle = await a1.tick();
  check("no demand -> desired 0, nothing launched", idle.leader && idle.desired === 0 && creates === 0, `desired ${idle.desired}`);

  // queue work -> exactly one launch, even with two instances racing
  await queue(2);
  const [t1, t2] = await Promise.all([a1.tick(), a2.tick()]);
  await Promise.all([a1.tick(), a2.tick()]);
  await a1.settle(); await a2.settle();
  const r1 = await rows();
  const orchCreates = [...sbs.values()].filter((s) => s.name.startsWith("octi-orch-")).length;
  check("queued work -> one orchestrator launched; second instance is not the leader (no double launch)",
    (t1.leader !== t2.leader) && r1.length === 1 && r1[0].state === "running" && orchCreates === 1, `leaders ${t1.leader}/${t2.leader}, rows ${r1.map((r: any) => `${r.sandbox_id}:${r.state}`)}, orchestrator sandboxes ${orchCreates}`);
  check("worker token only in the orchestrator sandbox env file", workerTokenInFiles.length === 1 && /octi-orch-.*orchestrator\.env/.test(workerTokenInFiles[0]!), workerTokenInFiles.join(","));
  await a1.settle();
  const imageNames = [...snaps.keys()];
  check("named snapshot image built for the current code (cold-start path)", imageNames.length === 1 && /^octi-orch-img-[0-9a-f]{16}$/.test(imageNames[0]!), imageNames.join(","));

  // cap: lots of work -> at most OCTILLION_MAX_ORCHESTRATORS (2), next launch comes from the image
  await queue(20);
  for (let i = 0; i < 3; i++) { await a1.tick(); await a1.settle(); }
  const r2 = await rows();
  const st = a1.last!;
  check("cap respected: desired clamps to OCTILLION_MAX_ORCHESTRATORS=2 (demand needs 8)", r2.length === 2 && st.cap === 2 && st.desired === 2,
    `demand ${st.demand?.sessions} sessions, cap ${st.cap}, rows ${r2.length}`);
  check("later launches boot from the snapshot image", fromImageCreates >= 1 && r2.some((r: any) => r.from_image), `${fromImageCreates} from image`);

  // check-ins, then idle -> drain -> deleted, and no relaunch loop while the remaining queue is not claimable
  for (const r of r2) await fleet.fleetCheckin(r.orchestrator_id, 3);
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status = 'queued' AND id NOT IN (SELECT id FROM agent_sessions WHERE status = 'queued' LIMIT 1)");
  // The one left is "stuck": it sat queued for a while next to live orchestrators that never claimed it.
  await db.query("UPDATE agent_sessions SET queued_at = now() - interval '15 minutes' WHERE status = 'queued'");
  const victim = r2[0];
  await fleet.fleetLeave(victim.orchestrator_id);
  await a1.tick();
  const r3 = await rows();
  check("idle exit -> fleet leave -> draining -> sandbox deleted", !sbs.has(victim.sandbox_id) && !r3.some((r: any) => r.id === victim.id),
    `reaped: ${JSON.stringify(a1.last?.reaped)}`);
  await fleet.fleetLeave(r2[1].orchestrator_id);
  await a1.tick(); await a1.tick(); await a1.settle();
  check("cooldown: queued-but-unclaimed work does not relaunch in a loop", (await rows()).length === 0 && /cooldown/.test(a1.last?.note ?? ""), a1.last?.note ?? "");
  // ...but a session queued now (a user clicking Run right after an idle exit) launches at once, not after the cooldown.
  await queue(1);
  await a1.tick(); await a1.settle();
  check("cooldown: freshly queued work launches immediately", (await rows()).length >= 1 && !/cooldown/.test(a1.last?.note ?? ""),
    `rows ${(await rows()).length}, note ${a1.last?.note ?? "-"}, fresh ${a1.last?.demand?.fresh_queued_sessions}`);
  for (const r of await rows()) { await fleet.fleetCheckin(r.orchestrator_id, 3).catch(() => {}); }
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status IN ('queued', 'running')");
  for (const r of await rows()) await fleet.fleetLeave(r.orchestrator_id).catch(() => {});
  await a1.tick();

  // stale + stuck booting + orphan
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status IN ('queued', 'running')");
  const mk = (name: string) => { const id = `bx_${randomBytes(4).toString("hex")}`; sbs.set(id, { id, name, state: "ready", createdAt: new Date().toISOString(), files: new Map() }); return id; };
  const stale = mk("octi-orch-stale1"), stuck = mk("octi-orch-stuck1"), orphan = mk("octi-orch-orphan1");
  const staleWorker = mk("octi-w-orch-stale1-codex-default"), otherWorker = mk("octi-w-orch-stale10-codex-default");
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, ready_at) VALUES ($1, 'orch-stale1', 'running', now() - interval '20 minutes')", [stale]);
  await db.query("INSERT INTO orchestrators (id, capacity, last_seen) VALUES ('orch-stale1', 3, now() - interval '6 minutes')");
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, created_at) VALUES ($1, 'orch-stuck1', 'booting', now() - interval '11 minutes')", [stuck]);
  await a1.tick();
  const reasons = Object.fromEntries((a1.last?.reaped ?? []).map((r) => [r.sandbox_id, r.reason]));
  check("stale (no fleet check-in 5 min) reaped", !sbs.has(stale) && /stale/.test(reasons[stale] ?? ""), reasons[stale] ?? "");
  check("stuck booting (> 10 min) reaped", !sbs.has(stuck) && /stuck booting/.test(reasons[stuck] ?? ""), reasons[stuck] ?? "");
  check("orphan orchestrator sandbox (no row) deleted", !sbs.has(orphan) && /orphan/.test(reasons[orphan] ?? ""), reasons[orphan] ?? "");
  check("workers of a reaped orchestrator deleted (exact prefix only)", !sbs.has(staleWorker) && sbs.has(otherWorker), reasons[staleWorker] ?? "");
  sbs.delete(otherWorker);
  // The reap reason has its own column, and every delete is in compute_events (workers and orphans have no row).
  const ended = Object.fromEntries((await db.query<any>("SELECT sandbox_id, reap_reason, launch_step FROM orchestrator_sandboxes WHERE sandbox_id = ANY($1)", [[stale, stuck]])).map((r) => [r.sandbox_id, r]));
  check("reap reason recorded apart from launch errors", /^stale/.test(ended[stale]?.reap_reason ?? "") && /^stuck booting/.test(ended[stuck]?.reap_reason ?? "") && !ended[stale]?.launch_step, JSON.stringify(ended));
  const evs = Object.fromEntries((await db.query<any>("SELECT kind, sandbox_id, orchestrator_id FROM compute_events WHERE sandbox_id = ANY($1)", [[stale, stuck, orphan, staleWorker]])).map((e) => [e.sandbox_id, e]));
  check("compute events: reaped, worker deleted with its orchestrator, orphan deleted",
    evs[stale]?.kind === "reaped" && evs[stuck]?.kind === "reaped" && evs[staleWorker]?.kind === "worker_deleted" && evs[staleWorker]?.orchestrator_id === "orch-stale1" && evs[orphan]?.kind === "orphan_deleted",
    JSON.stringify(evs));

  // A failed launch records its step and error apart (and as before in `error`), and a launch_failed event.
  failPreflight = true;
  await queue(1);
  const before = Number((await db.query<any>("SELECT max(id) AS id FROM orchestrator_sandboxes"))[0]?.id ?? 0);
  await a1.tick(); await a1.settle();
  failPreflight = false;
  const [bad] = await db.query<any>("SELECT * FROM orchestrator_sandboxes WHERE id > $1 ORDER BY id LIMIT 1", [before]);
  const [badEv] = await db.query<any>("SELECT * FROM compute_events WHERE kind = 'launch_failed' AND sandbox_id = $1", [bad?.sandbox_id ?? ""]);
  check("failed launch: step and error in their own columns, and a launch_failed event",
    bad?.state === "deleted" && bad.launch_step === "preflight" && /^preflight failed: API unreachable/.test(bad.launch_error ?? "") && /^preflight \(\d+s\): preflight failed/.test(bad.error ?? "") && !bad.reap_reason &&
    badEv?.step === "preflight" && badEv.orchestrator_id === bad.orchestrator_id && !sbs.has(bad.sandbox_id),
    JSON.stringify({ bad: bad && { state: bad.state, step: bad.launch_step, err: bad.launch_error, error: bad.error }, ev: badEv?.step }));
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status IN ('queued', 'running')");

  // recycle on deploy: an orchestrator launched before this server process runs old code. It gets no pods, is not
  // deleted while a session of its is running, and is retired right after (no idle-timeout wait).
  const old = mk("octi-orch-old1");
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, created_at, ready_at) VALUES ($1, 'orch-old1', 'running', now() - interval '1 hour', now() - interval '1 hour')", [old]);
  const first = await fleet.fleetCheckin("orch-old1", 3, { worker_id: "w-old1", running: {} }) as any;
  check("pre-deploy orchestrator is handed an empty assignment", Array.isArray(first.assignment) && first.assignment.length === 0, JSON.stringify(first.assignment));
  await queue(1);
  await db.query("UPDATE agent_sessions SET status = 'running', worker_id = 'w-old1' WHERE id = (SELECT id FROM agent_sessions WHERE status = 'queued' LIMIT 1)");
  await db.query("UPDATE agent_sessions SET status = 'cancelled' WHERE status = 'queued'");
  await new Promise((r) => setTimeout(r, 20));
  await fleet.fleetCheckin("orch-old1", 3, { worker_id: "w-old1", running: {} });
  await a1.tick(); await a1.settle();
  check("...and is kept while one of its sessions is still running", sbs.has(old), (a1.last?.reaped ?? []).map((r) => r.reason).join(","));
  await db.query("UPDATE agent_sessions SET status = 'completed' WHERE worker_id = 'w-old1'");
  await a1.tick(); await a1.settle();
  const retired = (a1.last?.reaped ?? []).find((r) => r.sandbox_id === old);
  check("...then retired at once when idle (no 10-minute idle wait)", !sbs.has(old) && /retired/.test(retired?.reason ?? ""), retired?.reason ?? "not reaped");
  // Same code, older launch (a plain server restart, or another replica launched it): not retired.
  const same = mk("octi-orch-same1");
  await db.query("INSERT INTO orchestrator_sandboxes (sandbox_id, orchestrator_id, state, created_at, ready_at, code_hash) VALUES ($1, 'orch-same1', 'running', now() - interval '1 hour', now() - interval '1 hour', $2)", [same, fleet.currentCodeHash()]);
  await fleet.fleetCheckin("orch-same1", 3, { worker_id: "w-same1", running: {} });
  await new Promise((r) => setTimeout(r, 20));
  await fleet.fleetCheckin("orch-same1", 3, { worker_id: "w-same1", running: {} });
  await a1.tick(); await a1.settle();
  check("an orchestrator on the current code is kept (restart or other replica), whatever its age",
    sbs.has(same) && !(await fleet.staleOrchestratorIds()).has("orch-same1"), (a1.last?.reaped ?? []).map((r) => r.reason).join(","));
  for (const r of await rows()) { await fleet.fleetLeave(r.orchestrator_id).catch(() => {}); }
  await a1.tick();
  check("nothing of ours left on boat", ![...sbs.values()].some((s) => s.name.startsWith("octi-orch-")), [...sbs.values()].map((s) => s.name).join(","));
  check("knobs reported", AUTOSCALE.podCapacity() === 3 && AUTOSCALE.maxOrchestrators() === 2, "");
} catch (e) {
  check("no exception", false, String((e as Error).stack ?? e));
}
if (results.some((r) => !r.ok)) console.log(quiet.slice(-30).join("\n"));
boat.close();
await db.close();
rmSync(tmp, { recursive: true, force: true });
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "AUTOSCALER TEST PASS" : "AUTOSCALER TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
