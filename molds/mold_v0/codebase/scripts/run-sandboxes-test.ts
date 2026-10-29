// Runs in sandboxes (mold_v0-055; src/run-sandboxes.ts, src/run-sandbox-runner.ts, src/run-routes.ts), offline: an
// embedded database, the HTTP server, and stand-ins for the sandbox providers that carry out what a sandbox would with
// the code a sandbox gets: a mock of the provider's API (the same kind of mock as orchestrator/test/autoscaler.ts) that
// unpacks the uploaded code and starts the uploaded runner from it, and a fake Docker Engine API on a unix socket that
// starts the runner from the image's code. Neither stand-in has a firewall (scripts/run-firewall-test.ts proves the
// lockdown the runner applies in a real sandbox), so the stand-ins start the runner with the lockdown off, which the
// runner refuses unless APP_ALLOW_UNSANDBOXED_RUNS=yes says this is a test.
//   npm run test:run-sandboxes
//
//  1. No provider and the unsandboxed flag off: nothing launches and nothing runs; the queued run says why it waits.
//     APP_RUN_SANDBOX=process without the flag is refused the same way; the runner refuses lockdown "off" alone.
//  2. The autoscaler's demand counts queued runs per kind; its tick launches one sandbox for the run (the provider's TTL
//     bounded by the run's lifetime); the runner, from the uploaded files only, claims the run with a token bound to it
//     and carries it out as the run's user; completing marks the sandbox for teardown and the next tick deletes it and
//     revokes the token.
//  3. Two workspaces: two sandboxes, one per run, each token bound to its own run: it cannot claim twice, act on the other
//     run, or reach any other worker route; each run's results land in its own workspace.
//  4. A crashed runner: its run's lease lapses, the run is swept and queued again, the dead sandbox is torn down and a
//     new one carries out the next attempt.
//  5. Cost: at most APP_MAX_RUN_SANDBOXES at once; a run whose sandbox cannot start is tried
//     APP_RUN_LAUNCH_ATTEMPTS times and then fails (never launched forever); orphans of this deployment are
//     deleted and another deployment's are not.
//  6. The server's own Docker (the compose runner service): a container per run with no socket, no mount, every
//     capability dropped but the runner's, no new privileges, limits, on the runs network; removed after its run.
//  7. APP_RUN_SANDBOX=process with the flag (tests only) carries a run out.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { ENV } from "../src/env-names.js";
import { NS } from "../src/namespace.js";
import { legacyBoatNamespace } from "../orchestrator/core/boat-namespace.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNS_DIR = path.join(ROOT, "scripts", "fixtures", "runs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asRoot = process.getuid?.() === 0;
const PUBLIC = "https://api.example";
const BOAT_KEY = `boat_mock_${randomBytes(6).toString("hex")}`;
Object.assign(process.env, {
  PUBLIC_URL: PUBLIC, APP_AUTOSCALE: "on", APP_ORCH_PER_JOB: "off", APP_RUN_SANDBOX: "auto",
  APP_DOCKER_SOCKET: path.join(TMP, "no-docker.sock"), APP_RUN_LAUNCH_BACKOFF_SECONDS: "0", BOAT_STARTS_PER_MINUTE: "1000", BOAT_STARTS_PER_HOUR: "1000",
});
delete process.env.APP_ALLOW_UNSANDBOXED_RUNS;

// ---------- the sandbox stand-ins ----------
let base = ""; // the HTTP server, as a sandbox's network reaches the API's public address
const kids = new Set<ChildProcess>();
// Each stand-in's runner leases a run user of its own (mold_v0-078: a uid per run from APP_RUN_UIDS, as a real
// sandbox's runner does; these stand-ins share this machine, so the leases keep their runs apart).
/** Start the runner as a sandbox would, from `cwd`'s code, with `env` (as written for the sandbox), and no firewall. */
/** mold_v0-179: how long the stand-ins' runners take to prepare (a real sandbox's lockdown can outlast a lease). */
let prepareMs = 0;
function startRunner(cwd: string, bin: string[], env: Record<string, string>, tag: string): ChildProcess {
  const { APP_RUN_USER: _u, ...rest } = env;
  const child = spawn(bin[0]!, [...bin.slice(1), "src/run-sandbox-runner.ts"], { cwd, detached: true, stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...rest, APP_URL: rest.APP_URL === PUBLIC ? base : rest.APP_URL!,
           APP_RUN_LOCKDOWN: "off", APP_ALLOW_UNSANDBOXED_RUNS: "yes", ...(prepareMs ? { APP_RUN_TEST_PREPARE_MS: String(prepareMs) } : {}),
           ...(asRoot ? {} : { APP_RUN_SAME_USER: "yes" }) } });
  let err = "";
  child.stderr!.on("data", (d) => { err += d; if (process.env.SBX_DEBUG) process.stderr.write(`[${tag}] ${d}`); });
  child.on("exit", () => kids.delete(child));
  (child as ChildProcess & { err: () => string }).err = () => err;
  kids.add(child);
  return child;
}
const killTree = (c: ChildProcess | undefined) => { if (c?.pid && c.exitCode === null && c.signalCode === null) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } } };

interface Sb { id: string; name: string; state: string; createdAt: string; files: Map<string, string>; dir: string; child?: ChildProcess; create: Record<string, unknown>; commands: string[]; setup?: string; setupErr?: string }
const sbs = new Map<string, Sb>();
let creates = 0, failCreates = false;
/** mold_v0-179: the set-up script fails at this step (its status file says so, its log has the error). */
let failSetupAt = "";
/** mold_v0-179: drop this many listing requests without an answer (a dead keep-alive socket, as on Vercel after a freeze). */
let dropListings = 0, dropped = 0;
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
    if (u === "/sandboxes" && req.method === "GET" && dropListings > 0) { dropListings--; dropped++; return void req.socket.destroy(); }
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
      if (cmd.includes("--unit=app-run-setup")) {
        // mold_v0-179: the set-up script, started detached: what it does in a sandbox, done here (unpack the parts, the
        // orchestrator's tsx, the env file, then the runner), and its status file as the script writes it.
        const parts = [...sb.files.keys()].filter((k) => /code\.tgz\.part\d+$/.test(k)).sort();
        writeFileSync(path.join(sb.dir, "code.tgz"), Buffer.concat(parts.map((k) => Buffer.from(sb.files.get(k)!, "base64"))));
        if (failSetupAt) { sb.setup = `failed ${failSetupAt}`; sb.setupErr = `--- ${failSetupAt} (12:00:00)\nnpm ERR! code E404 (test)\nnpm ci failed`; return json(res, 200, { ok: true, exitCode: 0, stdout: "", stderr: "" }); }
        mkdirSync(path.join(sb.dir, "app"), { recursive: true });
        const t = spawnSync("tar", ["-xzf", path.join(sb.dir, "code.tgz"), "-C", path.join(sb.dir, "app")]);
        if (t.status !== 0) { sb.setup = "failed unpack"; sb.setupErr = String(t.stderr); return json(res, 200, { ok: true, exitCode: 0, stdout: "", stderr: "" }); }
        symlinkSync(path.join(ROOT, "orchestrator", "node_modules"), path.join(sb.dir, "app", "orchestrator", "node_modules"));
        const e = parseEnv([...sb.files].find(([k]) => k.endsWith("/runner.env.new"))?.[1] ?? "");
        envFiles[sb.id] = e;
        sb.child = startRunner(path.join(sb.dir, "app"), [path.join(sb.dir, "app", "orchestrator", "node_modules", ".bin", "tsx")], e, sb.name);
        sb.setup = "started runner";
        return json(res, 200, { ok: true, exitCode: 0, stdout: "", stderr: "" });
      }
      if (cmd.includes("run-setup.status")) return json(res, 200, { ok: true, exitCode: 0, stdout: `${sb.setup ?? "none"}\n---\n${sb.setupErr ?? ""}\n`, stderr: "" });
      if (cmd.includes("--unit=app-runner")) {
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
    // mold_v0-179: the workspace store, with the shortest lease (its preparation in the sandbox outlasts it).
    { name: "slow_ws", runner: "workspace-harness", entry: "ok.mjs", lease_seconds: 15, max_attempts: 1, workspace: true },
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
  const rows = (runId: string) => db.query<{ id: number; state: string; sandbox_id: string | null; claimed_at: Date | null; reap_reason: string | null; launch_error: string | null; launch_step: string | null; provider: string }>(
    "SELECT id, state, sandbox_id, claimed_at, reap_reason, launch_error, launch_step, provider FROM run_sandboxes WHERE run_id = $1 ORDER BY id", [runId]);
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
    process.env.APP_RUN_SANDBOX = "process";
    const t2 = await new sbx.RunScaler({ log: () => {} }).tick();
    assert.equal(t2.provider, null, "process provider refused without the flag");
    assert.match((await events(id)).filter((e) => e.type === "waiting").at(-1)!.data.reason, /refused unless APP_ALLOW_UNSANDBOXED_RUNS=yes/);
    process.env.APP_RUN_SANDBOX = "auto";
    // The runner itself refuses a sandbox with no firewall unless the test flag says so (before claiming anything).
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/run-sandbox-runner.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000,
      env: { PATH: process.env.PATH!, APP_URL: base, APP_WORKER_TOKEN: "owk_x", APP_RUN_LOCKDOWN: "off" } });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /APP_RUN_LOCKDOWN=off is refused/);
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
    assert.ok(sb.name.startsWith(`app-run-${row!.id}-`), sb.name);
    assert.ok(Number(sb.create.ttlSeconds) <= 10 * 60 + 2 * 3600 + 2 * 15 + 1800 && Number(sb.create.ttlSeconds) > 0, `TTL ${sb.create.ttlSeconds}`);
    const e = envFiles[sb.id]!;
    assert.equal(e.APP_RUN_LOCKDOWN, "on", "the launcher always asks for the lockdown");
    assert.equal(e.APP_RUN_UIDS, "61000-64999", "the range its runner leases the run's user from (mold_v0-078)");
    assert.equal(e.APP_URL, PUBLIC);
    assert.ok(e.APP_WORKER_TOKEN?.startsWith("owk_") && e.APP_WORKER_TOKEN !== ENV.APP_WORKER_TOKEN, "a run token, never the fleet token");
    for (const k of Object.keys(e)) assert.ok(["APP_URL", "APP_WORKER_TOKEN", "APP_RUN_ID", "APP_RUN_UIDS", "APP_RUN_PACK_DIR", "APP_RUN_LOCKDOWN"].includes(k), `unexpected ${k} in the sandbox`);
    // The uploaded code is the runner's import graph, the pack and the orchestrator: no server code.
    const uploaded = spawnSync("tar", ["-tzf", path.join(sb.dir, "code.tgz")], { encoding: "utf8" }).stdout.split("\n");
    for (const f of ["src/run-sandbox-runner.ts", "src/run-harness.ts", "orchestrator/core/egress.ts", "scripts/fixtures/runs/ok.mjs"]) assert.ok(uploaded.includes(f), `${f} uploaded`);
    // mold_v0-072: the run tools' installer and the build's list go too, and the set-up runs it (as root, before the runner).
    for (const f of ["src/run-tools.ts", "scripts/install-run-tools.ts", "src/run-tools.generated.json"]) assert.ok(uploaded.includes(f), `${f} uploaded`);
    const setupScript = [...sb.files].find(([k]) => k.endsWith("/run-setup.sh"))?.[1] ?? "";
    assert.match(setupScript, /sudo -n env PATH=\S+ \S+\/tsx scripts\/install-run-tools\.ts --from src\/run-tools\.generated\.json --dir \/opt\/app-tools/, "the set-up installs the run tools");
    // mold_v0-179: the launch only uploads and starts the set-up, detached; nothing it runs waits on npm ci or apt-get.
    assert.ok(sb.commands.some((c) => c.includes("--unit=app-run-setup")) && !sb.commands.some((c) => /npm ci|apt-get/.test(c)), sb.commands.join("\n---\n"));
    for (const f of ["src/db.ts", "src/runs.ts", "src/keyvault.ts", "src/http.ts", ".env"]) assert.ok(!uploaded.includes(f), `${f} not uploaded`);
    await waitFor("the run to end", ended(id));
    assert.ok((await events(id)).some((x) => x.type === "sandbox_prepared" && Number.isFinite(x.data.prepared_ms)), "the runner says how long its sandbox took to prepare");
    const r1 = await runRow(id);
    assert.equal(r1.status, "succeeded", `${r1.error} :: ${(sb.child as any)?.err?.()}`);
    assert.equal(r1.worker_id, null);
    const claimed = (await events(id)).find((x) => x.type === "claimed");
    assert.equal(claimed?.data.worker_id, `sbx-${row!.id}`, "claimed by its sandbox");
    assert.equal((await rows(id))[0]!.state, "draining", "completing marks the sandbox for teardown");
    assert.ok(await resolveWorkerToken(e.APP_WORKER_TOKEN!), "token live until teardown");
    const t3 = await as.tick();
    assert.ok(!sbs.has(sb.id), "the sandbox is deleted");
    assert.equal((await rows(id))[0]!.state, "deleted");
    assert.equal(await resolveWorkerToken(e.APP_WORKER_TOKEN!), null, "its token is revoked");
    assert.equal((await worker(e.APP_WORKER_TOKEN!, "POST", "/runs/claim", {})).status, 401);
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
    const ta = envFiles[ra!.sandbox_id!]!.APP_WORKER_TOKEN!, tb = envFiles[rb!.sandbox_id!]!.APP_WORKER_TOKEN!;
    assert.notEqual(ta, tb);
    assert.equal(envFiles[ra!.sandbox_id!]!.APP_RUN_ID, a);
    // A's token: its own run only, once; nothing else of the worker API.
    assert.equal((await worker(ta, "POST", "/runs/claim", {})).status, 409, "claims once");
    for (const [m, p] of [["POST", `/runs/${b}/heartbeat`], ["GET", `/runs/${b}/credentials`], ["GET", `/runs/${b}/workspace`], ["POST", `/runs/${b}/complete`]] as const)
      assert.equal((await worker(ta, m, p, m === "POST" ? {} : undefined, "orl_x")).status, 403, `${m} ${p} with A's token`);
    for (const [m, p] of [["POST", "/claim"], ["GET", "/fleet"], ["POST", "/research/claim"], ["POST", "/orchestrator/credentials"], ["POST", "/fleet"], ["GET", "/library/tasks"]] as const)
      assert.equal((await worker(ta, m, p, m === "POST" ? { worker_id: "x" } : undefined)).status, 403, `${m} ${p} refused to a run token`);
    assert.equal((await worker(ENV.APP_WORKER_TOKEN!, "POST", "/runs/claim", { worker_id: "sbx-1" })).status, 400, "sbx- worker ids are the sandboxes' own");
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
    process.env.APP_MAX_RUN_SANDBOXES = "1";
    const a = await start(ca, "plain", { asset: "app-a" }), b = await start(cb, "plain", { asset: "app-b" });
    const t = await rs.tick(); await rs.settle();
    assert.equal(t.launched?.length, 1, "one launch under a cap of 1");
    assert.match(t.note ?? "", /at 1 run sandboxes/);
    await waitFor("the first", async () => (await ended(a)()) || (await ended(b)()));
    await rs.tick(); await rs.settle();
    await waitFor("both", async () => (await ended(a)()) && (await ended(b)()));
    await rs.tick();
    process.env.APP_MAX_RUN_SANDBOXES = "10";
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
    // Orphans: ours (by name) without a row go, under the namespace's default before mold_v0-156 too (one launched by
    // the release before, orchestrator/core/boat-namespace.ts); another deployment's stay.
    const mk = (name: string) => { const id = `bx_${randomBytes(4).toString("hex")}`; sbs.set(id, { id, name, state: "ready", createdAt: new Date().toISOString(), files: new Map(), dir: TMP, create: {}, commands: [] }); return id; };
    const legacyNs = legacyBoatNamespace()!;
    assert.ok(legacyNs && legacyNs !== "app", "APP_BOAT_NAMESPACE is unset here: the old default is ours too");
    const orphan = mk("app-run-9999-abcdef"), legacyOrphan = mk(`${legacyNs}-run-9998-abcdef`), other = mk("appv-run-1-abcdef");
    await rs.tick();
    assert.ok(!sbs.has(orphan) && !sbs.has(legacyOrphan) && sbs.has(other), "ours (new and old default) reaped, another deployment's kept");
    sbs.delete(other);
    // The Compute page counts what was named under the old default as ours, workers with their parents (src/compute.ts).
    const { classifySandboxNames } = await import("../src/compute.js");
    const kinds = classifySandboxNames([
      { id: "a", name: "app-orch-a", state: "running" }, { id: "b", name: `${legacyNs}-orch-b`, state: "running" },
      { id: "c", name: `${legacyNs}-w-orch-b-codex`, state: "running" }, { id: "d", name: `${legacyNs}-orch-img-x`, state: "ready" },
      { id: "e", name: `${legacyNs}-img-build`, state: "running" }, { id: "f", name: "appv-orch-c", state: "running" },
    ], undefined, ["orch-b"]).map((x) => [x.kind, x.parent_orchestrator_id, x.prefix]);
    assert.deepEqual(kinds, [["orchestrator", null, null], ["orchestrator", null, null], ["worker", "orch-b", null], ["image", null, null],
      ["image_builder", null, null], ["other", null, "appv"]], "ours under either name; another deployment's as other");
    console.log("✓ cost: at most APP_MAX_RUN_SANDBOXES; a sandbox that cannot start is tried 3 times, then the run fails; orphans of this deployment deleted, another's kept");
  }

  // ---------- 5b. mold_v0-179: launches that fit their call, set-up failures said, dropped connections tried again ----------
  {
    // The set-up script itself, run with stand-ins for sudo, npm and apt-get: its steps, its status line and its log.
    assert.deepEqual(sbx.parseBootStatus("running npm\n---\n--- npm (12:00:00)\nslow\n"), { state: "running", step: "npm", detail: "slow" });
    assert.deepEqual(sbx.parseBootStatus("none\n---\n\n"), { state: "none", step: "", detail: "" });
    assert.equal(sbx.parseBootStatus("garbage\n---\nx").state, "unknown");
    for (const failNpm of [false, true]) {
      const h = path.join(TMP, `setup-${failNpm ? "fail" : "ok"}`), bin = path.join(TMP, `setup-bin-${failNpm ? "fail" : "ok"}`), tree = path.join(TMP, `setup-tree-${failNpm}`);
      for (const d of [h, bin, path.join(tree, "orchestrator"), path.join(tree, "src")]) mkdirSync(d, { recursive: true });
      writeFileSync(path.join(tree, "orchestrator", "package.json"), "{}");
      writeFileSync(path.join(tree, "src", "run-tools.generated.json"), "{}");
      spawnSync("tar", ["-czf", path.join(h, "code.tgz.part000"), "-C", tree, "."]);
      writeFileSync(path.join(h, "runner.env.new"), "APP_URL=https://api.example\n");
      const stub = (name: string, body: string) => { writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
      stub("sudo", `echo "sudo $*" >> ${h}/sudo.log; exit 0`);
      stub("npm", failNpm ? `echo "npm ERR! code E404 (stand-in)" >&2; exit 1` : "exit 0");
      stub("apt-get", "exit 0"); stub("git", "exit 0"); stub("nft", "exit 0");
      const script = sbx.runSetupScript(h);
      assert.equal(spawnSync("bash", ["-n"], { input: script }).status, 0, "the set-up script parses");
      writeFileSync(path.join(h, "run-setup.sh"), script);
      const r = spawnSync("bash", [path.join(h, "run-setup.sh")], { encoding: "utf8", timeout: 60_000, env: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: h } });
      const status = readFileSync(path.join(h, "run-setup.status"), "utf8").trim(), log = readFileSync(path.join(h, "run-setup.err"), "utf8");
      const st = sbx.parseBootStatus(`${status}\n---\n${log}`);
      if (failNpm) {
        assert.equal(r.status, 1);
        assert.deepEqual([st.state, st.step], ["failed", "npm"], status);
        assert.match(st.detail, /npm ERR! code E404 \(stand-in\) \| npm ci failed/);
        assert.ok(!existsSync(path.join(h, "sudo.log")) || !readFileSync(path.join(h, "sudo.log"), "utf8").includes("app-runner"), "no runner after a failed step");
      } else {
        assert.equal(r.status, 0, log);
        assert.equal(status, "started runner", log);
        const sudo = readFileSync(path.join(h, "sudo.log"), "utf8");
        assert.match(sudo, /install -m 600 -o root -g root runner\.env\.new \/etc\/\S+\/runner\.env/);
        assert.match(sudo, /systemd-run --quiet --unit=app-runner .*src\/run-sandbox-runner\.ts/);
        assert.ok(existsSync(path.join(h, "app", "orchestrator", "package.json")) && !existsSync(path.join(h, "runner.env.new")), "the code in place, the env file installed");
      }
    }

    // A dropped connection on a read (a keep-alive socket dead after a Vercel freeze) is tried again on a fresh one.
    dropListings = 1; dropped = 0;
    const t0 = await rs.tick();
    assert.equal(t0.error, undefined, String(t0.error));
    assert.equal(dropped, 1, "the first listing was dropped, the tick went on");
    // One that keeps failing says which request failed and why (undici's bare "fetch failed" hid both).
    dropListings = 10;
    const t1 = await rs.tick();
    assert.match(t1.error ?? "", /^boat GET \/sandboxes: fetch failed \(.+\)$/, String(t1.error));
    dropListings = 0;

    // A set-up that fails in the sandbox: reaped at the next tick with its step and the sandbox's own error, the run told
    // why it waits; three such starts, then the run fails with that error. No sandbox is left.
    process.env.APP_RUN_SETUP_CHECK_SECONDS = "0";
    failSetupAt = "npm";
    const f = await start(ca, "plain", { asset: "app-a" });
    for (let i = 0; i < 12 && (await runRow(f)).status === "queued"; i++) { await rs.tick(); await rs.settle(); }
    failSetupAt = "";
    const fr = await rows(f);
    assert.equal(fr.length, 3, JSON.stringify(fr));
    for (const r of fr) {
      assert.equal(r.state, "deleted");
      assert.equal(r.launch_step, "setup npm");
      assert.match(r.launch_error ?? "", /^its set-up failed at npm: npm ERR! code E404 \(test\) \| npm ci failed$/, r.launch_error ?? "");
      assert.ok(!sbs.has(r.sandbox_id!), "its sandbox is deleted");
    }
    const rf = await runRow(f);
    assert.equal(rf.status, "failed");
    assert.match(rf.error ?? "", /its sandbox could not be started \(3 tries; last: its set-up failed at npm: npm ERR!/);
    assert.ok((await events(f)).some((x) => x.type === "waiting" && /^its sandbox did not start \(setup npm: its set-up failed at npm/.test(x.data.reason)), "the run says why it waits");
    delete process.env.APP_RUN_SETUP_CHECK_SECONDS;

    // A launch with too little of its call left does not start (on Vercel it would be frozen half done).
    const before = creates;
    await assert.rejects(sbx.boatProvider(PUBLIC).launch({ rowId: 0, runId: "run_x", name: "app-run-0-x", env: {}, ttlSeconds: 600, packDirs: [], log: () => {}, deadlineAt: Date.now() + 5_000 }, async () => {}),
      (e: Error & { launchStep?: string }) => e.launchStep === "create" && /too little to create/.test(e.message));
    assert.equal(creates, before, "nothing created");

    // A runner whose preparation outlasts the run's lease (15 s here; a lockdown on boat took longer than 120 s) keeps the
    // lease, and the workspace store's: its checkout is still its own.
    prepareMs = 20_000;
    const w = await start(ca, "slow_ws", { asset: "app-a" });
    await rs.tick(); await rs.settle();
    await waitFor("the slowly prepared run", ended(w), 120_000);
    prepareMs = 0;
    const rw = await runRow(w);
    assert.equal(rw.status, "succeeded", rw.error ?? "");
    const prep = (await events(w)).find((x) => x.type === "sandbox_prepared");
    assert.ok(prep && prep.data.prepared_ms >= 20_000, JSON.stringify(prep));
    await rs.tick();
    console.log("✓ mold_v0-179: a dropped read is tried again, a failing one names itself; a set-up that fails in the sandbox is reaped with its step and error (3, then the run fails with it); no launch without time left in its call; a slow preparation keeps the run's and its store's lease");
  }

  // ---------- 6. the server's own Docker (the compose runner service) ----------
  {
    await new Promise<void>((r) => docker.listen(DOCKER_SOCK, () => r()));
    Object.assign(process.env, { APP_RUN_SANDBOX: "docker", APP_DOCKER_SOCKET: DOCKER_SOCK, APP_RUN_IMAGE: "sha256:runimage",
      APP_RUN_NETWORK: "sf-test_runs", APP_RUN_API_URL: base });
    const id = await start(cb, "plain", { asset: "app-b" });
    const t = await rs.tick(); await rs.settle();
    assert.equal(t.provider, "docker");
    assert.equal(t.launched?.length, 1, JSON.stringify(t));
    const [row] = await rows(id);
    const ct = cts.get(row!.sandbox_id!)!;
    const h = ct.body.HostConfig;
    assert.equal(ct.body.Image, "sha256:runimage");
    assert.equal(ct.body.Labels[`org.${NS}.run-sandbox`], "app.sf-test_runs", "labelled per project: another project's runner never lists it");
    assert.deepEqual(ct.body.Cmd.slice(0, 3), ["timeout", "-s", "KILL"], "the container has its own deadline");
    assert.equal(ct.body.User, "0");
    assert.deepEqual(h.CapDrop, ["ALL"]);
    assert.deepEqual([...h.CapAdd].sort(), ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "NET_ADMIN", "SETGID", "SETUID"]);
    assert.deepEqual(h.SecurityOpt, ["no-new-privileges"]);
    assert.ok(h.Privileged === false && Array.isArray(h.Binds) && h.Binds.length === 0 && !h.Mounts, "no socket, no mount");
    assert.equal(h.NetworkMode, "sf-test_runs");
    assert.ok(h.Memory > 0 && h.NanoCpus > 0 && h.PidsLimit > 0);
    const env = Object.fromEntries((ct.body.Env as string[]).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    assert.equal(env.APP_RUN_LOCKDOWN, "on");
    for (const k of ["DATABASE_URL", "APP_VAULT_KEY"]) assert.ok(!(k in env), `${k} not in a run container`);
    assert.ok(!(ct.body.Env as string[]).some((l) => l.includes(ENV.APP_WORKER_TOKEN!)), "no fleet token");
    await waitFor("the docker run", ended(id));
    assert.equal((await runRow(id)).status, "succeeded");
    await rs.tick();
    assert.ok(!cts.has(ct.id), "the container is removed");
    // A container the release before labelled under the namespace's old default (mold_v0-156) and left with no row is
    // listed and removed too; one of another project's runs network, or another deployment's namespace, is never touched.
    const legacyCt = (label: string) => { const cid = randomBytes(12).toString("hex"); cts.set(cid, { id: cid, name: `x-run-1-${cid.slice(0, 6)}`, state: "exited", body: { Labels: { [`org.${NS}.run-sandbox`]: label } } }); return cid; };
    const oldOurs = legacyCt(`${legacyBoatNamespace()}.sf-test_runs`), otherProject = legacyCt(`${legacyBoatNamespace()}.other_runs`), otherNs = legacyCt("appv.sf-test_runs");
    await rs.tick();
    assert.ok(!cts.has(oldOurs) && cts.has(otherProject) && cts.has(otherNs), "an orphan under the old default removed; others' kept");
    cts.delete(otherProject); cts.delete(otherNs);
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
    Object.assign(process.env, { APP_RUN_SANDBOX: "process", APP_ALLOW_UNSANDBOXED_RUNS: "yes" });
    const id = await start(ca, "plain", { asset: "app-a" });
    const t = await rs.tick(); await rs.settle();
    assert.equal(t.provider, "process");
    await waitFor("the process run", ended(id));
    assert.equal((await runRow(id)).status, "succeeded");
    await rs.tick();
    delete process.env.APP_ALLOW_UNSANDBOXED_RUNS;
    console.log("✓ process mode (APP_ALLOW_UNSANDBOXED_RUNS=yes, tests only) carries a run out");
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
