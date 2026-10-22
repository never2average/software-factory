// Runs in sandboxes (mold_v0-055; src/run-sandboxes.ts, src/run-sandbox-runner.ts, src/run-routes.ts), offline: an
// embedded database, the HTTP server, and stand-ins for the sandbox providers that carry out what a sandbox would with
// the code a sandbox gets: a mock of the provider's API (the same kind of mock as orchestrator/test/autoscaler.ts) that
// unpacks the uploaded code and starts the uploaded runner from it, and a fake Docker Engine API on a unix socket that
// starts the runner from the image's code. Neither stand-in has a firewall (scripts/run-firewall-test.ts proves the
// lockdown the runner applies in a real sandbox), so the stand-ins start the runner with the lockdown off, which the
// runner refuses unless OCTILLION_ALLOW_UNSANDBOXED_RUNS=yes says this is a test.
//   npm run test:run-sandboxes
//
//  1. No provider and the unsandboxed flag off: nothing launches and nothing runs; the queued run says why it waits.
//     OCTILLION_RUN_SANDBOX=process without the flag is refused the same way; the runner refuses lockdown "off" alone.
//  2. The autoscaler's demand counts queued runs per kind; its tick launches one sandbox for the run (the provider's TTL
//     bounded by the run's lifetime); the runner, from the uploaded files only, claims the run with a token bound to it
//     and carries it out as the run's user; completing marks the sandbox for teardown and the next tick deletes it and
//     revokes the token.
//  3. Two workspaces: two sandboxes, one per run, each token bound to its own run: it cannot claim twice, act on the other
//     run, or reach any other worker route; each run's results land in its own workspace.
//  4. A crashed runner: its run's lease lapses, the run is swept and queued again, the dead sandbox is torn down and a
//     new one carries out the next attempt.
//  5. Cost: at most OCTILLION_MAX_RUN_SANDBOXES at once; a run whose sandbox cannot start is tried
//     OCTILLION_RUN_LAUNCH_ATTEMPTS times and then fails (never launched forever); orphans of this deployment are
//     deleted and another deployment's are not.
//  6. The server's own Docker (the compose runner service): a container per run with no socket, no mount, every
//     capability dropped but the runner's, no new privileges, limits, on the runs network; removed after its run.
//  7. OCTILLION_RUN_SANDBOX=process with the flag (tests only) carries a run out.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNS_DIR = path.join(ROOT, "scripts", "fixtures", "runs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asRoot = process.getuid?.() === 0;
const PUBLIC = "https://octi.example";
const BOAT_KEY = `boat_mock_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, {
  PUBLIC_URL: PUBLIC, OCTILLION_AUTOSCALE: "on", OCTILLION_ORCH_PER_JOB: "off", OCTILLION_RUN_SANDBOX: "auto",
  OCTILLION_DOCKER_SOCKET: path.join(TMP, "no-docker.sock"), OCTILLION_RUN_LAUNCH_BACKOFF_SECONDS: "0", BOAT_STARTS_PER_MINUTE: "1000", BOAT_STARTS_PER_HOUR: "1000",
});
delete process.env.OCTILLION_ALLOW_UNSANDBOXED_RUNS;

// ---------- the sandbox stand-ins ----------
let base = ""; // the HTTP server, as a sandbox's network reaches the API's public address
const kids = new Set<ChildProcess>();
// Each stand-in's runner leases a run user of its own (mold_v0-078: a uid per run from OCTILLION_RUN_UIDS, as a real
// sandbox's runner does; these stand-ins share this machine, so the leases keep their runs apart).
/** Start the runner as a sandbox would, from `cwd`'s code, with `env` (as written for the sandbox), and no firewall. */
function startRunner(cwd: string, bin: string[], env: Record<string, string>, tag: string): ChildProcess {
  const { OCTILLION_RUN_USER: _u, ...rest } = env;
  const child = spawn(bin[0]!, [...bin.slice(1), "src/run-sandbox-runner.ts"], { cwd, detached: true, stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...rest, OCTILLION_URL: rest.OCTILLION_URL === PUBLIC ? base : rest.OCTILLION_URL!,
           OCTILLION_RUN_LOCKDOWN: "off", OCTILLION_ALLOW_UNSANDBOXED_RUNS: "yes",
           ...(asRoot ? {} : { OCTILLION_RUN_SAME_USER: "yes" }) } });
  let err = "";
  child.stderr!.on("data", (d) => { err += d; if (process.env.SBX_DEBUG) process.stderr.write(`[${tag}] ${d}`); });
  child.on("exit", () => kids.delete(child));
  (child as ChildProcess & { err: () => string }).err = () => err;
  kids.add(child);
  return child;
}
const killTree = (c: ChildProcess | undefined) => { if (c?.pid && c.exitCode === null && c.signalCode === null) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } } };

interface Sb { id: string; name: string; state: string; createdAt: string; files: Map<string, string>; dir: string; child?: ChildProcess; create: Record<string, unknown>; commands: string[] }
const sbs = new Map<string, Sb>();
let creates = 0, failCreates = false;
const envFiles: Record<string, Record<string, string>> = {};
const parseEnv = (t: string) => Object.fromEntries(t.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const json = (res: http.ServerResponse, s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
const boat = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${BOAT_KEY}`) return json(res, 401, { ok: false, code: "unauthorized" });
    const b = raw ? JSON.parse(raw) : {};
    const u = String(req.url).replace(/^\/api\/v1/, "").split("?")[0]!;
    if (u === "/limits") return json(res, 200, { ok: true, currentLimits: { activeSandboxes: 100 }, startLimits: { perMinute: 100, perHour: 1000, perDay: 2000 }, activeSandboxes: [...sbs.values()].filter((s) => s.state === "ready").length });
    if (u === "/sandboxes" && req.method === "GET") return json(res, 200, { ok: true, sandboxes: [...sbs.values()].map((s) => ({ id: s.id, name: s.name, state: s.state, createdAt: s.createdAt })), pageInfo: { nextCursor: null } });
    if (u === "/sandboxes" && req.method === "POST") {
      if (failCreates) return json(res, 400, { ok: false, code: "bad_request", message: "no such machine type (test)" });
      const id = `bx_${randomBytes(4).toString("hex")}`;
      creates++;
      const dir = path.join(TMP, "boat", id);
      mkdirSync(dir, { recursive: true });
      sbs.set(id, { id, name: "", state: "ready", createdAt: new Date().toISOString(), files: new Map(), dir, create: b, commands: [] });
      return json(res, 202, { ok: true, sandbox: { id, state: "provisioning" } });
    }
    if (u.startsWith("/named-snapshots")) return json(res, 404, { ok: false, code: "not_found" });
    const m = /^\/sandboxes\/(bx_\w+)(\/.*)?$/.exec(u);
    const sb = m ? sbs.get(m[1]!) : undefined;
    if (!sb) return json(res, 404, { ok: false, code: "not_found" });
    const rest = m![2] ?? "";
    if (req.method === "GET" && rest === "") return json(res, 200, { ok: true, sandbox: { id: sb.id, state: sb.state, name: sb.name } });
    if (req.method === "PATCH") { if (b.name) sb.name = b.name; return json(res, 200, { ok: true }); }
    if (req.method === "DELETE") { killTree(sb.child); sbs.delete(sb.id); return json(res, 202, { ok: true }); }
    if (req.method === "PUT" && rest === "/files") { sb.files.set(b.path, b.content); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && rest === "/commands") {
      const cmd = String(b.command);
      sb.commands.push(cmd);
      if (cmd.includes("tar -xzf code.tgz")) {
        // The upload: exactly the parts that were sent, unpacked; tsx is the orchestrator's (its `npm ci` there).
        const parts = [...sb.files.keys()].filter((k) => /code\.tgz\.part\d+$/.test(k)).sort();
        writeFileSync(path.join(sb.dir, "code.tgz"), Buffer.concat(parts.map((k) => Buffer.from(sb.files.get(k)!, "base64"))));
        mkdirSync(path.join(sb.dir, "app"), { recursive: true });
        const t = spawnSync("tar", ["-xzf", path.join(sb.dir, "code.tgz"), "-C", path.join(sb.dir, "app")]);
        if (t.status !== 0) return json(res, 200, { ok: true, exitCode: 1, stdout: "", stderr: String(t.stderr) });
        symlinkSync(path.join(ROOT, "orchestrator", "node_modules"), path.join(sb.dir, "app", "orchestrator", "node_modules"));
        return json(res, 200, { ok: true, exitCode: 0, stdout: "", stderr: "" });
      }
      if (cmd.includes("--unit=octi-runner")) {
        const envText = [...sb.files].find(([k]) => k.endsWith("/runner.env.new"))?.[1] ?? "";
        const e = parseEnv(envText);
        envFiles[sb.id] = e;
        sb.child = startRunner(path.join(sb.dir, "app"), [path.join(sb.dir, "app", "orchestrator", "node_modules", ".bin", "tsx")], e, sb.name);
        return json(res, 200, { ok: true, exitCode: 0, stdout: "", stderr: "" });
      }
      return json(res, 200, { ok: true, exitCode: 0, stdout: "", stderr: "" });
    }
    json(res, 404, { ok: false, code: "not_found" });
  });
});
await new Promise<void>((r) => boat.listen(0, "127.0.0.1", () => r()));
process.env.BOAT_API_URL = `http://127.0.0.1:${(boat.address() as import("node:net").AddressInfo).port}/api/v1`;

// The Docker Engine API, faked on a unix socket: what the runner service's provider calls.
interface Ct { id: string; name: string; body: any; child?: ChildProcess; state: string }
let crashOnStart = false; // a container whose runner dies before it claims (a broken image, an unreachable API)
const cts = new Map<string, Ct>();
const DOCKER_SOCK = path.join(TMP, "docker.sock");
const docker = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(String(req.url), "http://docker");
    const send = (s: number, b?: unknown) => { res.writeHead(s, b === undefined ? {} : { "content-type": "application/json" }); res.end(b === undefined ? undefined : JSON.stringify(b)); };
    if (url.pathname === "/_ping") { res.writeHead(200); return res.end("OK"); }
    if (url.pathname === "/containers/create" && req.method === "POST") {
      const id = randomBytes(12).toString("hex");
      cts.set(id, { id, name: url.searchParams.get("name") ?? "", body: JSON.parse(raw), state: "created" });
      return send(201, { Id: id, Warnings: [] });
    }
    if (url.pathname === "/containers/json") {
      const want = JSON.parse(url.searchParams.get("filters") ?? "{}").label?.[0] as string | undefined;
      return send(200, [...cts.values()].filter((c) => !want || `${Object.entries(c.body.Labels ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}`.split("\n").includes(want))
        .map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: c.state, Labels: c.body.Labels })));
    }
    const m = /^\/containers\/([^/]+)(\/start)?$/.exec(url.pathname);
    const c = m ? cts.get(m[1]!) : undefined;
    if (!c) return send(404, { message: "no such container" });
    if (m![2] && req.method === "POST") {
      const env = Object.fromEntries((c.body.Env as string[]).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      // The image's code is this codebase; its node and tsx, as the container's command says.
      c.child = crashOnStart ? spawn("/bin/false", [], { stdio: "ignore" }) : startRunner(ROOT, [process.execPath, "--import", "tsx"], env, c.name);
      c.state = "running";
      c.child.on("exit", () => { c.state = "exited"; });
      return send(204);
    }
    if (req.method === "DELETE") { killTree(c.child); cts.delete(c.id); return send(204); }
    send(404, { message: "not found" });
  });
});

const { getDb } = await import("../src/db.js");
const db = await getDb();
await import("../src/server.js");
const { setPacksForTest } = await import("../src/packs.js");
const { definePack, defineTool, z } = await import("../src/pack-api.js");
const rec = await import("../src/record-areas.js");
const kv = await import("../src/keyvault.js");
const { createOrg } = await import("../src/auth.js");
const { withTenant } = await import("../src/tenant-scope.js");
const sbx = await import("../src/run-sandboxes.js");
const { resolveWorkerToken } = await import("../src/workerauth.js");
const { Autoscaler, computeDemand } = await import("../src/autoscaler.js");

let failed = false;
try {
  const A = (await createOrg(`Sbx A ${STAMP}`)).org, B = (await createOrg(`Sbx B ${STAMP}`)).org;
  const kinds = [
    { name: "plain", runner: "workspace-harness", entry: "ok.mjs", lease_seconds: 15, egress: ["api.allowed.example"] },
    { name: "stall_once", runner: "workspace-harness", entry: "stall-once.mjs", lease_seconds: 15, max_attempts: 3 },
  ];
  const fixture = definePack({
    id: "fixture_sbx",
    recordAreas: [
      { name: "run_sources", label: "Sources", role: "source", scope: "platform", fields: [{ name: "body", label: "Body" }] },
      { name: "run_checks", label: "Checks", role: "check", scope: "platform", fields: [{ name: "summary", label: "Summary" }] },
      { name: "run_apps", label: "Applications", role: "asset", scope: "workspace", fields: [{ name: "url", label: "Address" }] },
    ],
    jobKinds: kinds as never,
    tools: [
      defineTool({ name: "sbx_start_run", description: "Start a run (test).", inputSchema: { kind: z.string(), targets: z.record(z.string(), z.unknown()).optional() },
        handler: async (_ws, { kind, targets }, { runs: r }) => r.start(kind, { targets }) }),
    ],
  });
  setPacksForTest([{ manifest: { id: "fixture_sbx", name: "Fixture sandboxes", version: "1", entry: "index.ts", migrations: null, words: {}, dir: RUNS_DIR }, definition: fixture }]);
  await rec.putPlatform(null, "run_sources", "s1", { title: "Keep logs", data: { body: "a year" } });
  await rec.putPlatform(null, "run_checks", "c1", { title: "Retention", data: { summary: "logs kept" } });
  await withTenant(A.orgId, () => rec.workspaceRecords("fixture_sbx", A.orgId).put("run_apps", "app-a", { title: "A's app", data: { url: "https://a.example" } }));
  await withTenant(B.orgId, () => rec.workspaceRecords("fixture_sbx", B.orgId).put("run_apps", "app-b", { title: "B's app", data: { url: "https://b.example" } }));
  const srv = await startHttp();
  base = srv.base;
  const ca = await connect(A), cb = await connect(B);
  const start = async (c: typeof ca, kind: string, targets: Record<string, unknown> = {}) => {
    const r = await c.call("sbx_start_run", { kind, targets });
    assert.ok(!r.isError, `start ${kind}: ${r.content[0]?.text}`);
    return (r.structuredContent as { id: string }).id;
  };
  const runRow = async (id: string) => (await db.query<{ status: string; attempt: number; worker_id: string | null; error: string | null; org_id: number }>(
    "SELECT status, attempt, worker_id, error, org_id FROM runs WHERE id = $1", [id]))[0]!;
  const events = async (id: string) => db.query<{ type: string; data: any; attempt: number }>("SELECT type, data, attempt FROM run_events WHERE run_id = $1 ORDER BY id", [id]);
  const waitFor = async (what: string, f: () => Promise<boolean>, ms = 90_000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) if (await f()) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  const ended = (id: string) => async () => ["succeeded", "failed", "cancelled"].includes((await runRow(id)).status);
  const rows = (runId: string) => db.query<{ id: number; state: string; sandbox_id: string | null; claimed_at: Date | null; reap_reason: string | null; launch_error: string | null; provider: string }>(
    "SELECT id, state, sandbox_id, claimed_at, reap_reason, launch_error, provider FROM run_sandboxes WHERE run_id = $1 ORDER BY id", [runId]);
  const worker = (tok: string, method: string, p: string, body?: unknown, lease?: string) => fetch(`${base}/api/worker${p}`, { method,
    headers: { authorization: `Bearer ${tok}`, ...(lease ? { "x-run-lease": lease } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });

  // ---------- 1. no provider, unsandboxed off ----------
  {
    const id = await start(ca, "plain", { asset: "app-a" });
    const rs0 = new sbx.RunScaler({ log: () => {} });
    const t = await rs0.tick();
    assert.equal(t.provider, null);
    assert.match(t.note ?? "", /runs wait: no sandbox provider is configured/);
    assert.equal(creates, 0, "nothing launched");
    assert.equal((await runRow(id)).status, "queued", "the run waits");
    const w = (await events(id)).filter((e) => e.type === "waiting");
    assert.equal(w.length, 1, "one waiting event");
    assert.match(w[0]!.data.reason, /sandbox provider's key is not in the vault/);
    await rs0.tick();
    assert.equal((await events(id)).filter((e) => e.type === "waiting").length, 1, "said once, not every tick");
    process.env.OCTILLION_RUN_SANDBOX = "process";
    const t2 = await new sbx.RunScaler({ log: () => {} }).tick();
    assert.equal(t2.provider, null, "process provider refused without the flag");
    assert.match((await events(id)).filter((e) => e.type === "waiting").at(-1)!.data.reason, /refused unless OCTILLION_ALLOW_UNSANDBOXED_RUNS=yes/);
    process.env.OCTILLION_RUN_SANDBOX = "auto";
    // The runner itself refuses a sandbox with no firewall unless the test flag says so (before claiming anything).
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/run-sandbox-runner.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH!, OCTILLION_URL: base, OCTILLION_WORKER_TOKEN: "owk_x", OCTILLION_RUN_LOCKDOWN: "off" } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /OCTILLION_RUN_LOCKDOWN=off is refused/);
    assert.equal((await runRow(id)).status, "queued");
    console.log("✓ no provider: nothing launched, nothing run; the run waits with its reason (once); process mode and lockdown off refused without the test flag");

    // ---------- 2. the autoscaler launches the run's sandbox; claim, run, teardown ----------
    await kv.setCredential("boat", BOAT_KEY, { label: "test" });
    assert.deepEqual((await computeDemand()).runs, { "fixture_sbx/plain": 1 }, "the autoscaler's demand: queued runs per kind");
    const as = new Autoscaler({ log: () => {} });
    const st = await as.tick();
    assert.deepEqual(st.runs?.demand?.queued, { "fixture_sbx/plain": 1 }, `demand per kind: ${JSON.stringify(st.runs)}`);
    assert.equal(st.runs?.provider, "boat");
    assert.equal(st.runs?.launched?.length, 1, JSON.stringify(st.runs));
    await as.settle();
    const [row] = await rows(id);
    assert.equal(row!.state, "running", `launched: ${row!.launch_error}`);
    const sb = sbs.get(row!.sandbox_id!)!;
    assert.ok(sb.name.startsWith(`octi-run-${row!.id}-`), sb.name);
    assert.ok(Number(sb.create.ttlSeconds) <= 10 * 60 + 2 * 3600 + 2 * 15 + 1800 && Number(sb.create.ttlSeconds) > 0, `TTL ${sb.create.ttlSeconds}`);
    const e = envFiles[sb.id]!;
    assert.equal(e.OCTILLION_RUN_LOCKDOWN, "on", "the launcher always asks for the lockdown");
    assert.equal(e.OCTILLION_RUN_UIDS, "61000-64999", "the range its runner leases the run's user from (mold_v0-078)");
    assert.equal(e.OCTILLION_URL, PUBLIC);
    assert.ok(e.OCTILLION_WORKER_TOKEN?.startsWith("owk_") && e.OCTILLION_WORKER_TOKEN !== process.env.OCTILLION_WORKER_TOKEN, "a run token, never the fleet token");
    for (const k of Object.keys(e)) assert.ok(["OCTILLION_URL", "OCTILLION_WORKER_TOKEN", "OCTILLION_RUN_ID", "OCTILLION_RUN_UIDS", "OCTILLION_RUN_PACK_DIR", "OCTILLION_RUN_LOCKDOWN"].includes(k), `unexpected ${k} in the sandbox`);
    // The uploaded code is the runner's import graph, the pack and the orchestrator: no server code.
    const uploaded = spawnSync("tar", ["-tzf", path.join(sb.dir, "code.tgz")], { encoding: "utf8" }).stdout.split("\n");
    for (const f of ["src/run-sandbox-runner.ts", "src/run-harness.ts", "orchestrator/core/egress.ts", "scripts/fixtures/runs/ok.mjs"]) assert.ok(uploaded.includes(f), `${f} uploaded`);
    // mold_v0-072: the run tools' installer and the build's list go too, and the set-up runs it (as root, before the runner).
    for (const f of ["src/run-tools.ts", "scripts/install-run-tools.ts", "src/run-tools.generated.json"]) assert.ok(uploaded.includes(f), `${f} uploaded`);
    assert.ok(sb.commands.some((c) => /sudo -n env PATH=\S+ \S+\/tsx scripts\/install-run-tools\.ts --from src\/run-tools\.generated\.json --dir \/opt\/octi-tools/.test(c)), "the set-up installs the run tools");
    for (const f of ["src/db.ts", "src/runs.ts", "src/keyvault.ts", "src/http.ts", ".env"]) assert.ok(!uploaded.includes(f), `${f} not uploaded`);
    await waitFor("the run to end", ended(id));
    const r1 = await runRow(id);
    assert.equal(r1.status, "succeeded", `${r1.error} :: ${(sb.child as any)?.err?.()}`);
    assert.equal(r1.worker_id, null);
    const claimed = (await events(id)).find((x) => x.type === "claimed");
    assert.equal(claimed?.data.worker_id, `sbx-${row!.id}`, "claimed by its sandbox");
    assert.equal((await rows(id))[0]!.state, "draining", "completing marks the sandbox for teardown");
    assert.ok(await resolveWorkerToken(e.OCTILLION_WORKER_TOKEN!), "token live until teardown");
    const t3 = await as.tick();
    assert.ok(!sbs.has(sb.id), "the sandbox is deleted");
    assert.equal((await rows(id))[0]!.state, "deleted");
    assert.equal(await resolveWorkerToken(e.OCTILLION_WORKER_TOKEN!), null, "its token is revoked");
    assert.equal((await worker(e.OCTILLION_WORKER_TOKEN!, "POST", "/runs/claim", {})).status, 401);
    assert.equal(t3.runs?.launched?.length ?? 0, 0, "nothing relaunched");
    const res = await db.query<{ org_id: number }>("SELECT org_id FROM run_results WHERE run_id = $1", [id]);
    assert.ok(res.length === 1 && res[0]!.org_id === A.orgId);
    await as.release();
    console.log("✓ the autoscaler's demand counts queued runs per kind; one sandbox launched (TTL bounded), the runner from the uploaded files claims with a run token, runs, completes; torn down at the next tick, token revoked");
  }

  // One scaler from here on (the "runs" lease is one holder's at a time).
  const rs = new sbx.RunScaler({ log: () => {} });

  // ---------- 3. two workspaces ----------
  {
    const a = await start(ca, "plain", { asset: "app-a" }), b = await start(cb, "plain", { asset: "app-b" });
    const t = await rs.tick();
    assert.equal(t.launched?.length, 2);
    await rs.settle();
    await waitFor("both runs", async () => (await ended(a)()) && (await ended(b)()));
    assert.equal((await runRow(a)).status, "succeeded");
    assert.equal((await runRow(b)).status, "succeeded");
    const [ra] = await rows(a), [rb] = await rows(b);
    assert.notEqual(ra!.sandbox_id, rb!.sandbox_id, "one sandbox per run");
    const ta = envFiles[ra!.sandbox_id!]!.OCTILLION_WORKER_TOKEN!, tb = envFiles[rb!.sandbox_id!]!.OCTILLION_WORKER_TOKEN!;
    assert.notEqual(ta, tb);
    assert.equal(envFiles[ra!.sandbox_id!]!.OCTILLION_RUN_ID, a);
    // A's token: its own run only, once; nothing else of the worker API.
    assert.equal((await worker(ta, "POST", "/runs/claim", {})).status, 409, "claims once");
    for (const [m, p] of [["POST", `/runs/${b}/heartbeat`], ["GET", `/runs/${b}/credentials`], ["GET", `/runs/${b}/workspace`], ["POST", `/runs/${b}/complete`]] as const)
      assert.equal((await worker(ta, m, p, m === "POST" ? {} : undefined, "orl_x")).status, 403, `${m} ${p} with A's token`);
    for (const [m, p] of [["POST", "/claim"], ["GET", "/fleet"], ["POST", "/research/claim"], ["POST", "/orchestrator/credentials"], ["POST", "/fleet"], ["GET", "/library/tasks"]] as const)
      assert.equal((await worker(ta, m, p, m === "POST" ? { worker_id: "x" } : undefined)).status, 403, `${m} ${p} refused to a run token`);
    assert.equal((await worker(process.env.OCTILLION_WORKER_TOKEN!, "POST", "/runs/claim", { worker_id: "sbx-1" })).status, 400, "sbx- worker ids are the sandboxes' own");
    const ea = (await events(a)).find((x) => x.type === "claimed"), eb = (await events(b)).find((x) => x.type === "claimed");
    assert.equal(ea?.data.worker_id, `sbx-${ra!.id}`); assert.equal(eb?.data.worker_id, `sbx-${rb!.id}`);
    const resA = await db.query<{ org_id: number; asset_key: string }>("SELECT org_id, asset_key FROM run_results WHERE run_id = $1", [a]);
    const resB = await db.query<{ org_id: number; asset_key: string }>("SELECT org_id, asset_key FROM run_results WHERE run_id = $1", [b]);
    assert.ok(resA.length === 1 && resA[0]!.org_id === A.orgId && resA[0]!.asset_key === "app-a");
    assert.ok(resB.length === 1 && resB[0]!.org_id === B.orgId && resB[0]!.asset_key === "app-b");
    if (asRoot) {
      // mold_v0-078: the two runs, at once on this machine, each as a user of its own.
      const ua = (await events(a)).find((x) => x.type === "run_user")?.data.uid, ub = (await events(b)).find((x) => x.type === "run_user")?.data.uid;
      assert.ok(ua >= 61000 && ub >= 61000 && ua !== ub, `a run user per run (${ua}, ${ub})`);
    }
    await rs.tick();
    assert.ok(!sbs.has(ra!.sandbox_id!) && !sbs.has(rb!.sandbox_id!), "both torn down");
    console.log("✓ two workspaces: a sandbox and a token per run; a token claims once, never the other run, never another worker route; results in each run's own workspace");
  }

  // ---------- 4. a crashed runner ----------
  {
    const id = await start(ca, "stall_once", { asset: "app-a" });
    await rs.tick(); await rs.settle();
    await waitFor("the first attempt to run", async () => (await events(id)).some((x) => x.type === "stalling"));
    const [first] = await rows(id);
    const dead = sbs.get(first!.sandbox_id!)!;
    killTree(dead.child); // the runner and everything it started, by process group: the sandbox's runner crashed
    assert.equal((await runRow(id)).status, "running", "still running until its lease lapses");
    await waitFor("the lease to lapse and the run to be queued again", async () => { await rs.tick(); await rs.settle(); return (await rows(id)).length >= 2; }, 60_000);
    const all = await rows(id);
    assert.equal(all[0]!.state, "deleted");
    assert.match(all[0]!.reap_reason ?? "", /queued again|attempt ended/, all[0]!.reap_reason ?? "");
    assert.ok(!sbs.has(dead.id), "the crashed sandbox is deleted");
    await waitFor("the retry", ended(id));
    const r = await runRow(id);
    assert.equal(r.status, "succeeded", r.error ?? "");
    assert.equal(r.attempt, 2);
    assert.ok((await events(id)).some((x) => x.type === "retry" && x.data.reason === "lease lapsed"));
    await rs.tick();
    assert.equal((await rows(id)).filter((x) => x.state !== "deleted").length, 0);
    console.log("✓ a crashed runner: the lease lapses, the run is swept and queued again, the dead sandbox is deleted, a new sandbox carries out attempt 2");
  }

  // ---------- 5. caps, failed starts, orphans ----------
  {
    process.env.OCTILLION_MAX_RUN_SANDBOXES = "1";
    const a = await start(ca, "plain", { asset: "app-a" }), b = await start(cb, "plain", { asset: "app-b" });
    const t = await rs.tick(); await rs.settle();
    assert.equal(t.launched?.length, 1, "one launch under a cap of 1");
    assert.match(t.note ?? "", /at 1 run sandboxes/);
    await waitFor("the first", async () => (await ended(a)()) || (await ended(b)()));
    await rs.tick(); await rs.settle();
    await waitFor("both", async () => (await ended(a)()) && (await ended(b)()));
    await rs.tick();
    process.env.OCTILLION_MAX_RUN_SANDBOXES = "10";
    // A sandbox that cannot start: three tries, then the run fails; nothing more is created for it.
    failCreates = true;
    const c = await start(ca, "plain", { asset: "app-a" });
    for (let i = 0; i < 3; i++) { await rs.tick(); await rs.settle(); }
    assert.equal((await rows(c)).filter((x) => x.launch_error).length, 3);
    const t4 = await rs.tick();
    assert.deepEqual(t4.failed, [c]);
    const rc = await runRow(c);
    assert.equal(rc.status, "failed");
    assert.match(rc.error ?? "", /its sandbox could not be started \(3 tries/);
    const t5 = await rs.tick();
    assert.equal(t5.launched?.length ?? 0, 0);
    failCreates = false;
    const evs = await db.query<{ kind: string }>("SELECT kind FROM compute_events WHERE job_id = $1", [c]);
    assert.equal(evs.filter((x) => x.kind === "launch_failed").length, 3);
    // Orphans: ours (by name) without a row go; another deployment's stay.
    const mk = (name: string) => { const id = `bx_${randomBytes(4).toString("hex")}`; sbs.set(id, { id, name, state: "ready", createdAt: new Date().toISOString(), files: new Map(), dir: TMP, create: {}, commands: [] }); return id; };
    const orphan = mk("octi-run-9999-abcdef"), other = mk("octv-run-1-abcdef");
    await rs.tick();
    assert.ok(!sbs.has(orphan) && sbs.has(other));
    sbs.delete(other);
    console.log("✓ cost: at most OCTILLION_MAX_RUN_SANDBOXES; a sandbox that cannot start is tried 3 times, then the run fails; orphans of this deployment deleted, another's kept");
  }

  // ---------- 6. the server's own Docker (the compose runner service) ----------
  {
    await new Promise<void>((r) => docker.listen(DOCKER_SOCK, () => r()));
    Object.assign(process.env, { OCTILLION_RUN_SANDBOX: "docker", OCTILLION_DOCKER_SOCKET: DOCKER_SOCK, OCTILLION_RUN_IMAGE: "sha256:runimage",
      OCTILLION_RUN_NETWORK: "sf-test_runs", OCTILLION_RUN_API_URL: base });
    const id = await start(cb, "plain", { asset: "app-b" });
    const t = await rs.tick(); await rs.settle();
    assert.equal(t.provider, "docker");
    assert.equal(t.launched?.length, 1, JSON.stringify(t));
    const [row] = await rows(id);
    const ct = cts.get(row!.sandbox_id!)!;
    const h = ct.body.HostConfig;
    assert.equal(ct.body.Image, "sha256:runimage");
    assert.equal(ct.body.Labels["org.octillion.run-sandbox"], "octi.sf-test_runs", "labelled per project: another project's runner never lists it");
    assert.deepEqual(ct.body.Cmd.slice(0, 3), ["timeout", "-s", "KILL"], "the container has its own deadline");
    assert.equal(ct.body.User, "0");
    assert.deepEqual(h.CapDrop, ["ALL"]);
    assert.deepEqual([...h.CapAdd].sort(), ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "NET_ADMIN", "SETGID", "SETUID"]);
    assert.deepEqual(h.SecurityOpt, ["no-new-privileges"]);
    assert.ok(h.Privileged === false && Array.isArray(h.Binds) && h.Binds.length === 0 && !h.Mounts, "no socket, no mount");
    assert.equal(h.NetworkMode, "sf-test_runs");
    assert.ok(h.Memory > 0 && h.NanoCpus > 0 && h.PidsLimit > 0);
    const env = Object.fromEntries((ct.body.Env as string[]).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.equal(env.OCTILLION_RUN_LOCKDOWN, "on");
    for (const k of ["DATABASE_URL", "OCTILLION_VAULT_KEY"]) assert.ok(!(k in env), `${k} not in a run container`);
    assert.ok(!(ct.body.Env as string[]).some((l) => l.includes(process.env.OCTILLION_WORKER_TOKEN!)), "no fleet token");
    await waitFor("the docker run", ended(id));
    assert.equal((await runRow(id)).status, "succeeded");
    await rs.tick();
    assert.ok(!cts.has(ct.id), "the container is removed");
    // A runner that dies before it claims: each such sandbox is a failed start; three, and the run fails (no relaunch loop).
    crashOnStart = true;
    const dead = await start(cb, "plain", { asset: "app-b" });
    for (let i = 0; i < 8 && (await runRow(dead)).status === "queued"; i++) { await rs.tick(); await rs.settle(); await sleep(300); }
    crashOnStart = false;
    const rd = await runRow(dead);
    assert.equal(rd.status, "failed", JSON.stringify(rd));
    assert.match(rd.error ?? "", /could not be started \(3 tries/);
    assert.equal((await rows(dead)).length, 3, "three sandboxes, no more");
    assert.equal(cts.size, 0, "none left");
    console.log("✓ Docker: a container per run (no socket or mount, capabilities dropped but the runner's, no new privileges, limits, a deadline, the runs network, a per-project label), removed after its run; a runner that dies before claiming counts as a failed start (3, then the run fails)");
  }

  // ---------- 7. process (tests only) ----------
  {
    Object.assign(process.env, { OCTILLION_RUN_SANDBOX: "process", OCTILLION_ALLOW_UNSANDBOXED_RUNS: "yes" });
    const id = await start(ca, "plain", { asset: "app-a" });
    const t = await rs.tick(); await rs.settle();
    assert.equal(t.provider, "process");
    await waitFor("the process run", ended(id));
    assert.equal((await runRow(id)).status, "succeeded");
    await rs.tick();
    delete process.env.OCTILLION_ALLOW_UNSANDBOXED_RUNS;
    console.log("✓ process mode (OCTILLION_ALLOW_UNSANDBOXED_RUNS=yes, tests only) carries a run out");
  }
  await ca.close(); await cb.close();
  await srv.close();
  console.log("\nRUN SANDBOXES TEST PASS");
} catch (e) {
  failed = true;
  console.error(e);
  console.error("\nRUN SANDBOXES TEST FAIL");
} finally {
  for (const k of [...kids]) killTree(k);
  boat.close(); docker.close();
  if (existsSync(DOCKER_SOCK)) rmSync(DOCKER_SOCK, { force: true });
  await db.close();
  cleanup();
}
process.exit(failed ? 1 : 0);
