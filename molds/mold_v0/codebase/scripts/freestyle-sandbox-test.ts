// Freestyle as a run sandbox provider (mold_v0-274; src/freestyle.ts, src/run-sandboxes.ts freestyleProvider), offline:
// an embedded database, the HTTP server, and a stand-in for Freestyle's VM API that answers the calls the provider makes
// (POST /v5/vms, GET /v5/vms with its metadata filter and counts, GET and DELETE /v5/vms/{id}, POST .../exec-await,
// PUT .../fs/write with its mode and sha256, and a create taken into the background: 202, then
// /v5/background-requests/{id}) and does in a directory of its own what a Freestyle VM would: when the set-up is started
// it unpacks the uploaded code and starts the uploaded runner from exactly those files. No account, nothing spent. Like
// every stand-in sandbox (scripts/run-sandboxes-test.ts) it has no firewall, so its runner runs with the lockdown off,
// which the runner refuses unless APP_ALLOW_UNSANDBOXED_RUNS=yes; scripts/run-firewall-test.ts proves the lockdown.
//   npm run test:freestyle-sandbox
//
//  1. The platform setting chooses Freestyle (over the server's environment; the server's off still wins). With no
//     Freestyle key nothing launches: the queued run says which key is missing and where a platform owner adds it, Health
//     says the same (no_freestyle_key, never boat's), Key vault lists Freestyle and the runs' needs name it.
//  2. A job run end to end: the VM is created (its firewall: nothing in, out only HTTPS, HTTP and DNS; its TTL; ephemeral,
//     never restarted; labelled with this deployment's namespace; booted from the base snapshot), the code, the env file
//     (0600) and the set-up script (0700) written by sha256, the set-up started as root and detached; the runner claims its
//     run with a token bound to it and carries it out; the next tick deletes the VM and revokes the token.
//  3. An agent session end to end in a Freestyle VM: its wake leases the run, a message sent while it works (steer) is
//     answered, its uploaded program is executable in its workspace and runs, its platform key is in its variable and
//     redacted, its egress is its policy's hosts, and a website its governance policy does not list is refused outright
//     (approvals off: web_fetch_domain_not_allowed); then the VM is deleted. The Freestyle key is never given to a session.
//  4. Stop: a working session stopped by the person who started it: the wake stops, and its VM is deleted.
//  5. Reaping: a VM that stopped before its runner claimed is reaped as a failed start and the run goes on in a new one;
//     an orphan VM of this deployment is deleted, another deployment's is not; the plan's free VMs cap the launches.
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanup, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { NS } from "../src/namespace.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNS_DIR = path.join(ROOT, "scripts", "fixtures", "runs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const asRoot = process.getuid?.() === 0;
const PUBLIC = "https://api.example";
const KEY = `fs_mock_${randomBytes(8).toString("hex")}`;
Object.assign(process.env, {
  PUBLIC_URL: PUBLIC, APP_AUTOSCALE: "on", APP_STORAGE_DIR: path.join(TMP, "objects"), APP_RUN_LAUNCH_BACKOFF_SECONDS: "0",
  APP_RUN_SETUP_CHECK_SECONDS: "0", FREESTYLE_POLL_MS: "50", FREESTYLE_MAX_VMS: "20", APP_DOCKER_SOCKET: path.join(TMP, "no-docker.sock"),
});
for (const k of ["APP_RUN_SANDBOX", "APP_ALLOW_UNSANDBOXED_RUNS", "R2_BUCKET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "APP_FREESTYLE_EGRESS"]) delete process.env[k];
// The stand-in CLI, where a run's own user can read it (the test's TMP is its own: 0700).
const CLI_DIR = mkdtempSync(path.join(tmpdir(), "fs-cli-"));
chmodSync(CLI_DIR, 0o755);
const CLI = path.join(CLI_DIR, "cli.mjs");
copyFileSync(path.join(ROOT, "scripts", "fixtures", "agent-cli", "cli.mjs"), CLI);
chmodSync(CLI, 0o644);

// ---------- the stand-in Freestyle API ----------
let base = "";
interface Vm {
  id: string; slug: string; displayName: string; metadata: Record<string, string>; state: string; createdAt: string; create: any;
  files: Map<string, { bytes: Buffer; mode: number }>; dir: string; child?: ChildProcess; execs: { command: string; linuxUser?: string }[]; setup?: string; err?: () => string;
}
const vms = new Map<string, Vm>();
const deleted: string[] = [];
const envFiles: Record<string, Record<string, string>> = {};
let creates = 0, background = false, crashNext = false, badSha = 0;
const pending = new Map<string, { status: number; body: unknown; polls: number }>();
const parseEnv = (t: string) => Object.fromEntries(t.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const killTree = (c: ChildProcess | undefined) => { if (c?.pid && c.exitCode === null && c.signalCode === null) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } } };
const newVm = (create: any): Vm => {
  const id = randomBytes(10).toString("hex");
  const dir = path.join(TMP, "freestyle", id);
  mkdirSync(dir, { recursive: true });
  const vm: Vm = { id, slug: create.slug ?? "", displayName: create.displayName ?? "", metadata: create.metadata ?? {}, state: "starting", createdAt: new Date().toISOString(),
    create, files: new Map(), dir, execs: [] };
  vms.set(id, vm);
  return vm;
};
const show = (v: Vm) => ({ id: v.id, state: v.state, slug: v.slug, displayName: v.displayName, metadata: v.metadata, createdAt: v.createdAt });
/** The set-up, as the script does it in a VM: the parts unpacked, the orchestrator's tsx, the env file, the runner. */
function startSetup(vm: Vm) {
  if (crashNext) { crashNext = false; vm.state = "stopped"; vm.setup = "running npm"; return; }
  const parts = [...vm.files.keys()].filter((k) => /code\.tgz\.part\d+$/.test(k)).sort();
  writeFileSync(path.join(vm.dir, "code.tgz"), Buffer.concat(parts.map((k) => vm.files.get(k)!.bytes)));
  mkdirSync(path.join(vm.dir, "app"), { recursive: true });
  const t = spawnSync("tar", ["-xzf", path.join(vm.dir, "code.tgz"), "-C", path.join(vm.dir, "app")]);
  if (t.status !== 0) { vm.setup = "failed unpack"; return; }
  symlinkSync(path.join(ROOT, "orchestrator", "node_modules"), path.join(vm.dir, "app", "orchestrator", "node_modules"));
  const e = parseEnv(vm.files.get(`${H}/runner.env.new`)!.bytes.toString("utf8"));
  envFiles[vm.id] = e;
  const { APP_RUN_USER: _u, ...rest } = e;
  const child = spawn(path.join(vm.dir, "app", "orchestrator", "node_modules", ".bin", "tsx"), ["src/run-sandbox-runner.ts"], { cwd: path.join(vm.dir, "app"), detached: true, stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...rest, APP_URL: rest.APP_URL === PUBLIC ? base : rest.APP_URL!, APP_RUN_LOCKDOWN: "off", APP_ALLOW_UNSANDBOXED_RUNS: "yes",
           APP_RUN_TEST_AGENT_CLI: CLI, ...(asRoot ? {} : { APP_RUN_SAME_USER: "yes" }) } });
  let err = "";
  child.stderr!.on("data", (d) => { err += d; if (process.env.FS_DEBUG) process.stderr.write(`[${vm.displayName}] ${d}`); });
  vm.child = child; vm.err = () => err;
  vm.setup = "started runner";
}
const H = "/opt/app-run";
const api = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (s: number, b?: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(b === undefined ? "" : JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { code: "UNAUTHORIZED", message: "bad key" });
    const url = new URL(String(req.url), "http://freestyle");
    const raw = Buffer.concat(chunks);
    const bg = /^\/v5\/background-requests\/([^/]+)$/.exec(url.pathname);
    if (bg) {
      const p = pending.get(bg[1]!);
      if (!p) return send(404, { code: "NOT_FOUND", message: "no request" });
      if (p.polls++ < 1) return send(202, { requestId: bg[1] });
      pending.delete(bg[1]!);
      return send(p.status, p.body);
    }
    if (url.pathname === "/v5/vms" && req.method === "POST") {
      const b = JSON.parse(raw.toString("utf8") || "{}");
      if (!b.firewall || !Array.isArray(b.firewall.rules)) return send(400, { code: "FIREWALL_REQUIRED", message: "firewall is required" });
      if (b.slug && !/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,62}$/.test(b.slug)) return send(400, { code: "INVALID_SLUG", message: "bad slug" });
      creates++;
      const vm = newVm(b);
      if (background) { const rid = randomBytes(6).toString("hex"); pending.set(rid, { status: 200, body: { ...show(vm), firewallRules: [] }, polls: 0 }); res.setHeader("x-freestyle-background-request-id", rid); return send(202, { requestId: rid }); }
      return send(200, { ...show(vm), firewallRules: [] });
    }
    if (url.pathname === "/v5/vms" && req.method === "GET") {
      const all = [...vms.values()];
      const m = url.searchParams.get("metadata");
      const want = m ? m.split(",").map((x) => [x.slice(0, x.indexOf(":")), x.slice(x.indexOf(":") + 1)] as const) : [];
      const hit = all.filter((v) => want.every(([k, val]) => v.metadata[k] === val));
      const off = Number(url.searchParams.get("offset") ?? 0), lim = Number(url.searchParams.get("limit") ?? 100);
      const count = (s: string) => all.filter((v) => v.state === s).length;
      return send(200, { vms: hit.slice(off, off + lim).map(show), totalCount: hit.length, runningCount: count("running"), startingCount: count("starting"), pausingCount: count("pausing"), pausedCount: count("paused"), stoppedCount: count("stopped") });
    }
    const m = /^\/v5\/vms\/([a-z0-9]+)(\/.*)?$/.exec(url.pathname);
    const vm = m ? vms.get(m[1]!) : undefined;
    if (!vm) return send(404, { code: "VM_NOT_FOUND", message: "no such VM" });
    const rest = m![2] ?? "";
    if (req.method === "GET" && rest === "") { const out = show(vm); if (vm.state === "starting") vm.state = "running"; return send(200, out); }
    if (req.method === "DELETE" && rest === "") { killTree(vm.child); vms.delete(vm.id); deleted.push(vm.id); return send(200, { id: vm.id }); }
    if (req.method === "PUT" && rest === "/fs/write") {
      const p = url.searchParams.get("path") ?? "", sha = url.searchParams.get("sha256") ?? "";
      if (!p.startsWith("/")) return send(400, { code: "INVALID_PATH", message: "absolute paths only" });
      if (sha !== createHash("sha256").update(raw).digest("hex")) { badSha++; return send(400, { code: "CHECKSUM_MISMATCH", message: "the body did not arrive whole" }); }
      vm.files.set(p, { bytes: raw, mode: Number(url.searchParams.get("mode") ?? 0o600) });
      return send(200, {});
    }
    if (req.method === "POST" && rest === "/exec-await") {
      const b = JSON.parse(raw.toString("utf8") || "{}");
      vm.execs.push({ command: String(b.command), linuxUser: b.linuxUser });
      const cmd = String(b.command);
      if (cmd.includes("--unit=app-run-setup")) { startSetup(vm); return send(200, { stdout: "", stderr: "", statusCode: 0 }); }
      if (cmd.includes("run-setup.status")) return send(200, { stdout: `${vm.setup ?? "none"}\n---\n`, stderr: "", statusCode: 0 });
      return send(200, { stdout: "", stderr: "", statusCode: 0 });
    }
    send(404, { code: "NOT_FOUND", message: `${req.method} ${url.pathname}` });
  });
});
await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
process.env.FREESTYLE_API_URL = `http://127.0.0.1:${(api.address() as import("node:net").AddressInfo).port}`;

const { getDb } = await import("../src/db.js");
const db = await getDb();
await import("../src/server.js");
const F = await import("../src/features.js");
const { setPacksForTest } = await import("../src/packs.js");
const { definePack } = await import("../src/pack-api.js");
const kv = await import("../src/keyvault.js");
const { createOrg } = await import("../src/auth.js");
const sbx = await import("../src/run-sandboxes.js");
const { resolveWorkerToken } = await import("../src/workerauth.js");
const { computeSummary, resetComputeCaches } = await import("../src/compute.js");
const { modelKeys, saveSettingValues } = await import("../src/platform-keys.js");
const { runNeeds } = await import("../src/vault-providers.js");
const { listSettings } = await import("../src/settings.js");
const H_ = await import("../src/harness-sessions.js");
const P = await import("../src/agent-profiles.js");
const runsMod = await import("../src/runs.js");

let failed = false;
try {
  F.setFeatureForTest("agent_harness", true);
  const BUILDER = {
    id: "builder", name: "Build an application", description: "Builds an application.", harness: "claude-code", inference: { provider: "anthropic", model: "claude-sonnet-5-5" },
    // Approvals off: a website the policy does not list is refused outright (the reference's web_fetch_domain_not_allowed).
    governance: { egress_approvals: false, web: { enabled: true, web_search_enabled: false, web_fetch_enabled: true, web_fetch_allowed_domains: ["docs.example.org"], max_calls: 5 } },
  };
  setPacksForTest([{ manifest: { id: "fixture_fs", name: "Fixture Freestyle", version: "1", entry: "index.ts", migrations: null, words: {}, dir: RUNS_DIR }, definition: definePack({
    id: "fixture_fs",
    jobKinds: [{ name: "plain", runner: "workspace-harness", entry: "ok.mjs", lease_seconds: 15, max_attempts: 3, egress: ["api.allowed.example"] }],
    agentProfiles: [BUILDER],
  } as never) }]);
  P.resetProfileSeedForTest();
  const srv = await startHttp();
  base = srv.base;
  const W = (await createOrg(`Freestyle ${STAMP}`)).org;
  const own = await srv.signInAs(W, "owner");
  const owner = { kind: "person" as const, user: own.userId, name: "owner@example.org", role: "owner" as const };
  const staffTok = await srv.adminToken("operator");
  const adm = async (method: string, p: string, body?: unknown) => {
    const r = await srv.req(method, `/api/admin/onboarding/agent-profiles${p}`, { authorization: `Bearer ${staffTok}` }, body);
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const rs = new sbx.RunScaler({ log: (m) => { if (process.env.FS_DEBUG) console.error(`runs: ${m}`); } });
  const tick = async () => { const t = await rs.tick(); await rs.settle(); return t; };
  const waitFor = async (what: string, f: () => Promise<boolean>, ms = 90_000, every = 250) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(every)) if (await f()) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  const runRow = async (id: string) => (await db.query<{ status: string; attempt: number; error: string | null }>("SELECT status, attempt, error FROM runs WHERE id = $1", [id]))[0]!;
  const rowsOf = (runId: string) => db.query<{ id: number; state: string; sandbox_id: string | null; reap_reason: string | null; launch_error: string | null; launch_step: string | null; provider: string }>(
    "SELECT id, state, sandbox_id, reap_reason, launch_error, launch_step, provider FROM run_sandboxes WHERE run_id = $1 ORDER BY id", [runId]);
  const events = (id: string) => db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [id]);
  const startRun = async () => (await runsMod.startRun(W.orgId, "fixture_fs", "plain", { targets: { results: [] } }, "test")).id;

  // ---------- 1. the setting, and no key ----------
  {
    await saveSettingValues("test-staff", { APP_RUN_SANDBOX: "freestyle" });
    const setRow = (await listSettings()).find((s) => s.key === "APP_RUN_SANDBOX");
    assert.deepEqual([setRow?.value, setRow?.source, setRow?.options], ["freestyle", "set", ["auto", "boat", "docker", "freestyle"]], "the Sandbox provider setting, chosen by staff");
    process.env.APP_RUN_SANDBOX = "boat";
    assert.equal(sbx.RUN_SANDBOXES.mode(), "freestyle", "a staff member's choice wins over the server's environment");
    process.env.APP_RUN_SANDBOX = "off";
    assert.equal(sbx.RUN_SANDBOXES.mode(), "off", "the server's kill switch wins over the setting");
    delete process.env.APP_RUN_SANDBOX;
    const id = await startRun();
    const t = await tick();
    assert.equal(t.provider, null);
    assert.equal(creates, 0, "nothing launched");
    assert.match(t.note ?? "", /runs wait: the sandbox provider's key is not in the vault \(no Freestyle key: a platform owner adds it in Admin › Key vault, under Freestyle\)/);
    const w = (await events(id)).filter((e) => e.type === "waiting");
    assert.ok(w.length === 1 && /no Freestyle key/.test(w[0]!.data.reason), `the queued run says which key: ${JSON.stringify(w)}`);
    // The whole autoscaler tick: a build without the session engine whose runs use Freestyle never asks for a boat key.
    const { Autoscaler } = await import("../src/autoscaler.js");
    const full = new Autoscaler({ log: () => {} });
    const ft = await full.tick(); await full.settle(); await full.release();
    assert.ok(ft.leader && !ft.error, `no boat key asked for: ${ft.error}`);
    resetComputeCaches();
    const s = await computeSummary({ fresh: true });
    assert.ok(!s.verdict.some((x: { code: string }) => x.code === "tick_error"), `no tick error on Health: ${JSON.stringify(s.verdict)}`);
    const v = s.verdict.find((x: { code: string }) => x.code === "no_freestyle_key");
    assert.ok(v, `Health says the key is missing: ${JSON.stringify(s.verdict)}`);
    assert.equal(v!.text, "Runs cannot start: there is no Freestyle key. A platform owner adds it in Admin › Key vault, under Freestyle (Sandbox).");
    assert.equal(v!.href, "/admin/keys");
    assert.ok(!s.verdict.some((x: { code: string }) => x.code === "no_boat_key") && s.uses_boat === false, "never boat's key");
    assert.equal(s.runs?.mode, "freestyle");
    const { healthStatus } = await import("../src/health-tabs.js");
    assert.deepEqual((await healthStatus()).sandbox_missing, { provider: "freestyle", name: "Freestyle", text: v!.text }, "Health › Status says it too, in the same words");
    const keys = await modelKeys();
    assert.ok(keys.providers.some((p: { slug: string }) => p.slug === "freestyle"), "Key vault lists Freestyle");
    const needs = await runNeeds();
    assert.ok(needs.needs.some((n) => n.slug === "freestyle" && n.sandbox) && !needs.needs.some((n) => n.slug === "boat"), `the runs need Freestyle's key: ${JSON.stringify(needs.needs)}`);
    await saveSettingValues("test-staff", { APP_RUN_SANDBOX: "auto" });
    assert.ok(!(await modelKeys()).providers.some((p: { slug: string }) => p.slug === "freestyle"), "a build whose runs do not use it is not asked for it");
    await saveSettingValues("test-staff", { APP_RUN_SANDBOX: "freestyle" });
    console.log("✓ the Sandbox provider setting chooses Freestyle (over the environment; the server's off still wins); with no key nothing launches, the run, Health (Compute's verdict and Status) name the Freestyle key and where to add it, no boat key is asked for, Key vault lists it");

    // ---------- 2. a job run end to end ----------
    await kv.setCredential("freestyle", KEY, { label: "default" });
    sbx.forgetFreestyleKey();
    assert.equal((await healthStatus()).sandbox_missing, null, "with the key set, Health says nothing of it");
    background = true; // the create answers 202 and is polled
    const t2 = await tick();
    background = false;
    assert.equal(t2.provider, "freestyle", JSON.stringify(t2));
    assert.equal(t2.launched?.length, 1, JSON.stringify(t2));
    const [row] = await rowsOf(id);
    assert.equal(row!.state, "running", `launched: ${row!.launch_step} ${row!.launch_error}`);
    assert.equal(row!.provider, "freestyle");
    const vm = vms.get(row!.sandbox_id!)!;
    assert.ok(vm, "the row holds the VM's id");
    const c = vm.create;
    assert.deepEqual(c.firewall.rules, [
      { action: "allow", source: {}, destination: { public: true, port: 443, protocol: "tcp" } }, { action: "allow", source: {}, destination: { public: true, port: 80, protocol: "tcp" } },
      { action: "allow", source: {}, destination: { public: true, port: 53, protocol: "udp" } }, { action: "allow", source: {}, destination: { public: true, port: 53, protocol: "tcp" } },
    ], "its firewall: nothing in, out only HTTPS, HTTP and DNS");
    assert.deepEqual([c.autoDeleteSeconds, c.automaticRestart, c.snapshotId], [0, false, "freestyle/ubuntu-sm"], "ephemeral, never restarted, the base snapshot");
    assert.ok(c.ttlSeconds > 0 && c.ttlSeconds <= 10 * 60 + 2 * 3600 + 2 * 15 + 1800, `its TTL: ${c.ttlSeconds}`);
    assert.equal(c.metadata[`org.${NS}.run-sandbox`], "app", "labelled with this deployment's namespace");
    assert.equal(c.metadata[`org.${NS}.run-id`], id);
    assert.ok(/^app-run-\d+-[0-9a-f]{6}$/.test(c.slug) && c.displayName === c.slug, `its slug: ${c.slug}`);
    const mode = (p: string) => vm.files.get(p)?.mode;
    assert.equal(mode(`${H}/runner.env.new`), 0o600, "the env file: root's alone");
    assert.equal(mode(`${H}/run-setup.sh`), 0o700, "the set-up script: an executable");
    assert.ok([...vm.files.keys()].some((k) => k.endsWith("code.tgz.part000")) && badSha === 0, "the code, every write checked by its sha256");
    const setup = vm.execs.find((x) => x.command.includes("--unit=app-run-setup"));
    assert.equal(setup?.linuxUser, "root", "the set-up started as root");
    assert.ok(!vm.execs.some((x) => /npm ci|apt-get/.test(x.command)), "the launch only starts the set-up, detached");
    const e = envFiles[vm.id]!;
    assert.deepEqual(Object.keys(e).sort(), ["APP_RUN_ID", "APP_RUN_LOCKDOWN", "APP_RUN_PACK_DIR", "APP_RUN_UIDS", "APP_URL", "APP_WORKER_TOKEN"], "the runner's environment, nothing else");
    assert.equal(e.APP_RUN_LOCKDOWN, "on", "the launcher always asks for the lockdown");
    assert.ok(e.APP_WORKER_TOKEN!.startsWith("owk_"), "a run-bound token");
    const uploaded = spawnSync("tar", ["-tzf", path.join(vm.dir, "code.tgz")], { encoding: "utf8" }).stdout.split("\n");
    for (const f of ["src/run-sandbox-runner.ts", "src/agent-harness.ts", "orchestrator/core/egress.ts", "scripts/fixtures/runs/ok.mjs"]) assert.ok(uploaded.includes(f), `${f} uploaded`);
    for (const f of ["src/db.ts", "src/keyvault.ts", "src/freestyle.ts", "src/http.ts"]) assert.ok(!uploaded.includes(f), `${f} not uploaded`);
    await waitFor("the run to end", async () => ["succeeded", "failed"].includes((await runRow(id)).status));
    assert.equal((await runRow(id)).status, "succeeded", `${(await runRow(id)).error} :: ${vm.err?.()}`);
    assert.equal((await events(id)).find((x) => x.type === "claimed")?.data.worker_id, `sbx-${row!.id}`, "claimed by its VM's runner, with its lease");
    assert.equal((await rowsOf(id))[0]!.state, "draining");
    await tick();
    assert.ok(deleted.includes(vm.id) && !vms.has(vm.id), "the VM is deleted");
    assert.equal(await resolveWorkerToken(e.APP_WORKER_TOKEN!), null, "its token is revoked");
    console.log("✓ a job run in a Freestyle VM: created (its firewall, TTL, ephemeral, labelled; a create answered in the background polled), its files written by sha256 with their modes, the set-up as root; the runner claims with its run-bound lease and runs it; the VM deleted, the token revoked");
  }

  // ---------- 3. an agent session end to end ----------
  {
    const TOOL_KEY = `exa-tool-${STAMP}-0123456789`;
    await kv.setCredential("anthropic", `sk-default-${STAMP}-0123456789`, { label: "default" });
    await kv.setCredential("exa", TOOL_KEY, { label: "agent" });
    const script = Buffer.from("#!/bin/sh\necho \"HELLO-$1 from $(basename \"$0\")\"\n");
    const u0 = await adm("POST", "/uploads", { bytes: script.length });
    assert.equal(u0.status, 201, JSON.stringify(u0.body));
    const up = u0.body.upload as { id: string; parts: number };
    const put = await fetch(`${base}/api/admin/onboarding/agent-profiles/uploads/${up.id}/parts/0`, { method: "PUT", body: new Uint8Array(script),
      headers: { authorization: `Bearer ${staffTok}`, "content-type": "application/octet-stream", "x-app-admin": "1", "x-pack-request": "1" } });
    assert.equal(put.status, 200, await put.text());
    const tool = (await adm("POST", `/uploads/${up.id}/complete`, {})).body.upload;
    assert.equal(tool.executable, true);
    const b0 = (await adm("GET", "/builder")).body.profile;
    const bad = await adm("PUT", "/builder", { version: b0.version, config: { ...b0.config, keys: [{ kind: "platform", provider: "freestyle", label: "default", env: "FS_KEY" }] } });
    assert.ok(bad.status === 400 && /freestyle keys .* never given one/.test(bad.body.error), `the Freestyle key is never given to a session: ${JSON.stringify(bad.body)}`);
    const r = await adm("PUT", "/builder", { version: b0.version, config: { ...b0.config, keys: [{ kind: "platform", provider: "exa", label: "agent", env: "SEARCH_KEY" }],
      uploads: [{ id: tool.id, path: "bin/hello", bytes: tool.bytes, sha256: tool.sha256, executable: true }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = await H_.startSession(W.orgId, owner, { message: "slow 2500\nfiles", profile: "builder" });
    const rd = () => H_.readSession(W.orgId, s.id, owner);
    const said = async (re: RegExp) => (await rd()).messages.some((m) => m.role === "agent" && re.test(m.body));
    const last = async () => (await rd()).messages.filter((m) => m.role === "agent").at(-1)?.body ?? "";
    const t = await tick();
    assert.equal(t.launched?.length, 1, `the wake's VM: ${JSON.stringify(t)}`);
    const [wake] = await db.query<{ id: string }>("SELECT id FROM runs WHERE harness_session_id = $1 ORDER BY created_at DESC LIMIT 1", [s.id]);
    const [row] = await rowsOf(wake!.id);
    const vm = vms.get(row!.sandbox_id!)!;
    assert.equal(row!.provider, "freestyle");
    assert.deepEqual(await H_.wakeEgressHosts(wake!.id), ["docs.example.org"], "its wake's egress: the hosts its governance policy names");
    await waitFor("the wake is working", async () => (await rd()).phase === "working");
    await H_.messageSession(W.orgId, s.id, owner, "steer: focus on the tests");
    await waitFor("the steer answered", () => said(/^Echo: steer: focus on the tests$/));
    assert.ok(await said(/^Files: bin\/hello$/), "its upload in its workspace");
    const ev = await events(wake!.id);
    assert.ok(ev.some((x) => x.type === "steer_queued") && ev.some((x) => x.type === "steer_delivered"), "the steer went through the wake's beat");
    assert.equal(ev.find((x) => x.type === "claimed")?.data.worker_id, `sbx-${row!.id}`, "the wake claimed by its VM's runner");
    await H_.messageSession(W.orgId, s.id, owner, "run ./bin/hello world && stat -c %a bin/hello");
    await waitFor("the program", () => said(/^Ran: /));
    assert.equal(await last(), "Ran: 0 HELLO-world from hello | 700", "the uploaded program: executable (0700) and running in its workspace");
    await H_.messageSession(W.orgId, s.id, owner, "env SEARCH_KEY");
    await waitFor("the key", () => said(/^Env SEARCH_KEY/));
    assert.equal(await last(), "Env SEARCH_KEY: [credential vault:exa/agent]", "its platform key in its variable, redacted on its way out");
    assert.ok(!JSON.stringify((await rd()).messages).includes(TOOL_KEY) && !JSON.stringify(await events(wake!.id)).includes(TOOL_KEY), "the value never leaves the wake");
    await H_.messageSession(W.orgId, s.id, owner, "fetch https://other.example.com/page");
    // The wake says how it ended (the code), then its run completes and the session settles with it (policy: <code>).
    await waitFor("the governance refusal", async () => { const x = await rd(); return x.phase === "failed" && /^policy: /.test(x.reason ?? ""); }, 60_000);
    const d = await rd();
    assert.deepEqual([d.reason, d.pending_request], ["policy: web_fetch_domain_not_allowed", null], "a website its policy does not list: refused outright, never asked");
    await waitFor("the wake's run to end", async () => (await runRow(wake!.id)).status !== "running" && (await runRow(wake!.id)).status !== "queued");
    await waitFor("the VM deleted", async () => { await tick(); return deleted.includes(vm.id); }, 30_000, 500);
    console.log("✓ an agent session in a Freestyle VM: its wake claimed with the run's lease, a steer answered, its uploaded program executable (0700) and running, its key redacted, its egress its policy's hosts, an unlisted website refused outright (web_fetch_domain_not_allowed); the VM deleted; the Freestyle key never given to a session");

    // ---------- 4. stop ----------
    const s2 = await H_.startSession(W.orgId, owner, { message: "slow 4000\nwork for a while", profile: "builder" });
    await tick();
    const [w2] = await db.query<{ id: string }>("SELECT id FROM runs WHERE harness_session_id = $1 ORDER BY created_at DESC LIMIT 1", [s2.id]);
    const vm2 = vms.get((await rowsOf(w2!.id))[0]!.sandbox_id!)!;
    await waitFor("the second wake working", async () => (await H_.readSession(W.orgId, s2.id, owner)).phase === "working");
    await H_.stopSession(W.orgId, s2.id, owner);
    await waitFor("the stopped wake's run to end", async () => !["running", "queued"].includes((await runRow(w2!.id)).status), 60_000);
    await waitFor("its VM deleted", async () => { await tick(); return deleted.includes(vm2.id); }, 30_000, 500);
    assert.equal((await H_.readSession(W.orgId, s2.id, owner)).phase, "stopped");
    console.log("✓ stop: a working session stopped by its person ends its wake once its turn in progress is done (stdin closed), and its VM is deleted");
  }

  // ---------- 5. reaping ----------
  {
    crashNext = true;
    const id = await startRun();
    await tick();
    const [r1] = await rowsOf(id);
    const crashed = r1!.sandbox_id!;
    assert.equal(vms.get(crashed)?.state, "stopped", "the VM stopped before its runner claimed");
    await tick();
    const r = await rowsOf(id);
    assert.equal(r[0]!.state, "deleted");
    assert.match(r[0]!.reap_reason ?? "", /the sandbox is stopped/);
    assert.ok(r[0]!.launch_error, "counted as a failed start");
    assert.ok(deleted.includes(crashed), "the stopped VM is deleted");
    await waitFor("the run in a new VM", async () => { await tick(); return (await runRow(id)).status === "succeeded"; }, 90_000, 500);
    assert.ok((await rowsOf(id)).length >= 2, "carried out in a new VM");
    // Orphans: a VM of this deployment with no row goes; another deployment's (its own namespace) is not touched.
    const ours = newVm({ metadata: { [`org.${NS}.run-sandbox`]: "app" }, displayName: "app-run-999-orphan" }); ours.state = "running";
    const theirs = newVm({ metadata: { [`org.${NS}.run-sandbox`]: "other" }, displayName: "other-run-1-x" }); theirs.state = "running";
    const t = await tick();
    assert.ok(deleted.includes(ours.id) && t.reaped?.some((x) => x.reason === "orphan app-run-999-orphan"), `the orphan deleted: ${JSON.stringify(t.reaped)}`);
    assert.ok(vms.has(theirs.id), "another deployment's VM left alone");
    // The plan: its free VMs cap the launches (the other deployment's VM is running on the same account).
    process.env.FREESTYLE_MAX_VMS = "1";
    const id2 = await startRun();
    const t2 = await tick();
    assert.equal(t2.launched?.length ?? 0, 0, "nothing launched with no free VM");
    assert.match(t2.note ?? "", /0 free on the plan/);
    process.env.FREESTYLE_MAX_VMS = "20";
    await waitFor("the capped run, once a VM is free", async () => { await tick(); return (await runRow(id2)).status === "succeeded"; }, 90_000, 500);
    await waitFor("its VM deleted", async () => { await tick(); return [...vms.values()].every((v) => v.id === theirs.id); }, 30_000, 500);
    console.log("✓ reaping: a VM that stopped before it claimed is reaped as a failed start and the run goes on in a new one; an orphan of ours is deleted, another deployment's is not; the plan's free VMs cap the launches");
  }
  await rs.release();
  await srv.close();
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  for (const v of vms.values()) killTree(v.child);
  api.close();
  rmSync(CLI_DIR, { recursive: true, force: true });
  await cleanup();
}
process.exit(failed ? 1 : 0);
