// On-premises runners (mold_v0-036; src/onprem-runners.ts, src/onprem-runner-routes.ts, src/onprem-runner.ts), offline:
// an embedded database, the HTTP server, an in-process fake runner speaking the outbound protocol with fetch, and the
// real runner program against a fake Docker Engine API on a unix socket (whose containers start the run sandbox's
// runner from this codebase, with the lockdown off as every offline stand-in does: scripts/run-sandboxes-test.ts).
//   npm run test:onprem-runners
//
//  1. A build with no kind that needs a private network mounts nothing; runs are hosted.
//  2. Enrollment: owners only (and the CSRF header with the cookie); a one-time token, stored hashed, used once, expiring;
//     the runner's own credential stored hashed.
//  3. Routing: hosted by default (a runner gets nothing); on premises needs a runner online; a run of a private-network
//     kind goes to the workspace's runner, any other kind stays hosted; the hosted scaler's demand and the fleet token
//     never see it; a hosted sandbox cannot claim it.
//  4. Isolation: another workspace's runner is never handed it, nor changes its rows by naming them; the run token a
//     runner gets is bound to that run and sandbox, as a hosted one.
//  5. The outbound protocol with an in-process fake runner: assign, claim, complete, remove; kinds its image lacks wait.
//  6. The real runner program: enrolls, keeps its credential 0600, starts a container per run with the hosted settings,
//     its own address and allow list, the run succeeds in its own workspace, the container is removed; health shown.
//  7. Revocation: at once, the credential, the sandbox token and the run's attempt stop; the run goes back to the queue;
//     the runner removes its containers, deletes its credential and exits 3. Switching back to hosted moves queued runs.
//  8. A silent runner loses its sandboxes' tokens; staff see every runner (no secret) and only operators revoke.
//  9. The allow list parser; APP_ONPREM_RUNNERS=off sends every run back to the hosted scaler.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { cleanup, connect, STAMP, startHttp, TMP } from "./lib/test-world.js";
import { ENV } from "../src/env-names.js";
import { NS } from "../src/namespace.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const RUNS_DIR = path.join(ROOT, "scripts", "fixtures", "runs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const PUBLIC = "https://api.example";
Object.assign(process.env, { PUBLIC_URL: PUBLIC, APP_AUTOSCALE: "on", APP_ORCH_PER_JOB: "off", APP_RUN_SANDBOX: "off", APP_RUN_LAUNCH_BACKOFF_SECONDS: "0" });
delete process.env.APP_ALLOW_UNSANDBOXED_RUNS;
delete process.env.APP_ONPREM_RUNNERS;

// ---------- the fake Docker Engine API (the customer's machine) ----------
const kids = new Set<ChildProcess>();
const killTree = (c: ChildProcess | undefined) => { if (c?.pid && c.exitCode === null && c.signalCode === null) { try { process.kill(-c.pid, "SIGKILL"); } catch { /* gone */ } } };
interface Ct { id: string; name: string; body: any; child?: ChildProcess; state: string }
const cts = new Map<string, Ct>();
let base = "";
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
      return send(200, [...cts.values()].filter((c) => !want || Object.entries(c.body.Labels ?? {}).map(([k, v]) => `${k}=${v}`).includes(want))
        .map((c) => ({ Id: c.id, Names: [`/${c.name}`], State: c.state, Labels: c.body.Labels })));
    }
    const m = /^\/containers\/([^/]+)(\/start|\/json)?$/.exec(url.pathname);
    const c = m ? cts.get(m[1]!) : undefined;
    if (!c) return send(404, { message: "no such container" });
    if (m![2] === "/start" && req.method === "POST") {
      const env = Object.fromEntries((c.body.Env as string[]).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      // The image's code is this codebase; the container's runner without a firewall (a stand-in has none).
      const child = spawn(process.execPath, ["--import", "tsx", "src/run-sandbox-runner.ts"], { cwd: ROOT, detached: true, stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env, APP_RUN_LOCKDOWN: "off", APP_ALLOW_UNSANDBOXED_RUNS: "yes", APP_RUN_SAME_USER: "yes" } });
      child.stderr!.on("data", (d) => { if (process.env.ONPREM_DEBUG) process.stderr.write(`[ct ${c.id.slice(0, 6)}] ${d}`); });
      kids.add(child); child.on("exit", () => { kids.delete(child); c.state = "exited"; });
      c.child = child; c.state = "running";
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
const { definePack } = await import("../src/pack-api.js");
const { onpremFixturePack, ONPREM_KINDS } = await import("./fixtures/onprem-pack.js");
const rec = await import("../src/record-areas.js");
const { createOrg } = await import("../src/auth.js");
const { withTenant } = await import("../src/tenant-scope.js");
const onprem = await import("../src/onprem-runners.js");
const routes = await import("../src/onprem-runner-routes.js");
const { claimableRuns, queuedRunsByKind } = await import("../src/runs.js");
const { resolveWorkerToken, mintRunWorkerToken } = await import("../src/workerauth.js");
const { parsePrivateAllow, privateAllowText } = await import("../orchestrator/core/egress.js");

let failed = false;
try {
  // ---------- 1. no kind needs a private network ----------
  {
    const plainOnly = definePack({ id: "fixture_hosted", jobKinds: [{ name: "plain", runner: "workspace-harness", entry: "ok.mjs" }] as never });
    setPacksForTest([{ manifest: { id: "fixture_hosted", name: "Hosted", version: "1", entry: "index.ts", migrations: null, words: {}, dir: RUNS_DIR }, definition: plainOnly }]);
    assert.equal(onprem.onPremAvailable(), false);
    assert.equal(routes.onPremAppRouter().stack.length, 0, "nothing mounted at /api/runners");
    assert.equal(routes.onPremRunnerRouter().stack.length, 0, "nothing mounted at /api/runner");
    assert.equal(await onprem.runLocationFor(db, 1), "hosted");
    console.log("✓ no kind needs a private network: nothing mounted, every run hosted");
  }

  const A = (await createOrg(`Onprem A ${STAMP}`)).org, B = (await createOrg(`Onprem B ${STAMP}`)).org;
  setPacksForTest([onpremFixturePack()] as never);
  assert.equal(onprem.onPremAvailable(), true);
  await rec.putPlatform(null, "run_sources", "s1", { title: "Keep logs", data: { body: "a year" } });
  await rec.putPlatform(null, "run_checks", "c1", { title: "Retention", data: { summary: "logs kept" } });
  await withTenant(A.orgId, () => rec.workspaceRecords("fixture_onprem", A.orgId).put("run_apps", "app-a", { title: "A's app", data: { url: "https://a.example" } }));
  await withTenant(B.orgId, () => rec.workspaceRecords("fixture_onprem", B.orgId).put("run_apps", "app-b", { title: "B's app", data: { url: "https://b.example" } }));
  const srv = await startHttp();
  base = srv.base;
  const ca = await connect(A), cb = await connect(B);
  const start = async (c: typeof ca, kind: string, targets: Record<string, unknown> = {}) => {
    const r = await c.call("op_start_run", { kind, targets });
    assert.ok(!r.isError, `start ${kind}: ${r.content[0]?.text}`);
    return (r.structuredContent as { id: string }).id;
  };
  const runRow = async (id: string) => (await db.query<{ status: string; attempt: number; worker_id: string | null; error: string | null; org_id: number; runner_location: string }>(
    "SELECT status, attempt, worker_id, error, org_id, runner_location FROM runs WHERE id = $1", [id]))[0]!;
  const events = async (id: string) => db.query<{ type: string; data: any }>("SELECT type, data FROM run_events WHERE run_id = $1 ORDER BY id", [id]);
  const waitFor = async (what: string, f: () => Promise<boolean>, ms = 90_000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) if (await f()) return;
    throw new Error(`timed out waiting for ${what}`);
  };
  const ended = (id: string) => async () => ["succeeded", "failed", "cancelled"].includes((await runRow(id)).status);
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const api = async (method: string, p: string, tok: string, body?: unknown, extra: Record<string, string> = {}) => {
    const r = await srv.req(method, p, { ...bearer(tok), ...extra }, body);
    return { status: r.status, body: await r.json().catch(() => ({})) as any };
  };
  const ownerA = await srv.signIn(A, "owner"), memberA = await srv.signIn(A, "member"), ownerB = await srv.signIn(B, "owner");
  const allKinds = ONPREM_KINDS.map((k) => `fixture_onprem/${k.name}`);
  /** The in-process fake runner: the outbound protocol, by hand. */
  const runner = (credential: string) => ({
    poll: (report: Record<string, unknown> = {}) => api("POST", "/api/runner/poll", credential, { version: "test", hostname: "fake", capacity: 2, isolation: "docker", allow: ["*.corp.example"], kinds: allKinds, sandboxes: [], ...report }),
  });

  // ---------- 2. enrollment ----------
  let credA = "", runnerA = "", credB = "";
  {
    const g = await api("GET", "/api/runners", memberA);
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.equal(g.body.location, "hosted", "hosted by default");
    assert.deepEqual(g.body.runners, []);
    assert.deepEqual(g.body.kinds.map((k: any) => k.name), ["probe", "probe_slow"], "the kinds it applies to");
    assert.equal(g.body.can_manage, false);
    assert.equal((await api("POST", "/api/runners", memberA, { name: "dc1" })).status, 403, "a member cannot add a runner");
    assert.equal((await srv.req("POST", "/api/runners", { cookie: `__session=${ownerA}` }, { name: "dc1" })).status, 403, "the cookie needs the CSRF header");
    assert.equal((await api("PUT", "/api/runners/location", ownerA, { location: "on_premises" })).status, 409, "on premises needs a runner online");
    assert.equal((await api("POST", "/api/runners", ownerA, { name: "" })).status, 400);
    const c = await api("POST", "/api/runners", ownerA, { name: "Data centre 1" });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const token = c.body.enrollment_token as string;
    assert.match(token, /^ore_[A-Za-z0-9_-]{30,}$/);
    assert.ok(c.body.command.includes(token) && c.body.command.includes("src/onprem-runner.ts") && c.body.command.includes(`APP_RUNNER_URL=${PUBLIC}`), c.body.command);
    assert.equal(c.body.runner.status, "waiting_for_install");
    const [row] = await db.query<any>("SELECT * FROM onprem_runners WHERE id = $1", [c.body.runner.id]);
    assert.equal(row.enroll_token_hash, sha256(token), "only the token's sha256 is stored");
    assert.ok(!JSON.stringify(row).includes(token), "the token itself is nowhere in the row");
    // Enrolling: a wrong token, the right one once, then never again.
    assert.equal((await api("POST", "/api/runner/enroll", `ore_${"x".repeat(32)}`, {})).status, 401);
    assert.equal((await api("POST", "/api/runner/enroll", "orr_not-an-enrollment", {})).status, 401);
    const e = await api("POST", "/api/runner/enroll", token, { version: "1.0", hostname: "dc1-host", capacity: 2, isolation: "docker", allow: ["10.20.0.0/16"] });
    assert.equal(e.status, 200, JSON.stringify(e.body));
    credA = e.body.credential; runnerA = e.body.runner_id;
    assert.match(credA, /^orr_/);
    const [after] = await db.query<any>("SELECT * FROM onprem_runners WHERE id = $1", [runnerA]);
    assert.equal(after.state, "enrolled");
    assert.equal(after.enroll_token_hash, null, "the token is used up");
    assert.equal(after.secret_hash, sha256(credA), "only the credential's sha256 is stored");
    assert.ok(!JSON.stringify(after).includes(credA));
    assert.equal((await api("POST", "/api/runner/enroll", token, {})).status, 401, "a token enrolls once");
    // An expired token is refused.
    const old = await api("POST", "/api/runners", ownerA, { name: "Too late" });
    await db.query("UPDATE onprem_runners SET enroll_expires_at = now() - interval '1 minute' WHERE id = $1", [old.body.runner.id]);
    assert.equal((await api("POST", "/api/runner/enroll", old.body.enrollment_token, {})).status, 401, "an expired token is refused");
    assert.equal((await api("GET", "/api/runners", ownerA)).body.runners.find((r: any) => r.id === old.body.runner.id).status, "enrollment_expired");
    assert.equal((await api("DELETE", `/api/runners/${old.body.runner.id}`, ownerA)).status, 200);
    // B's runner, B's owner only: A's owner cannot revoke it.
    const cbr = await api("POST", "/api/runners", ownerB, { name: "B site" });
    const eb = await api("POST", "/api/runner/enroll", cbr.body.enrollment_token, { hostname: "b-host" });
    credB = eb.body.credential;
    assert.equal((await api("DELETE", `/api/runners/${eb.body.runner_id}`, ownerA)).status, 404, "another workspace's runner is not found");
    assert.equal((await api("POST", "/api/runner/poll", "orr_unknown", {})).status, 401);
    console.log("✓ enrollment: owners only (CSRF with the cookie), a one-time token stored hashed, used once, expiring; the runner's credential stored hashed");
  }

  // ---------- 3, 4, 5. routing, isolation, the protocol ----------
  const fa = runner(credA), fb = runner(credB);
  {
    // Hosted by default: a private-network run stays hosted and no runner is handed it.
    const hostedProbe = await start(ca, "probe", { asset: "app-a" });
    assert.equal((await runRow(hostedProbe)).runner_location, "hosted");
    const p0 = await fa.poll();
    assert.equal(p0.status, 200, JSON.stringify(p0.body));
    assert.deepEqual(p0.body.assign, [], "hosted runs are never handed to a runner");
    assert.ok((await claimableRuns()).some((r) => r.id === hostedProbe), "the hosted scaler takes it");
    await db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = $1 AND status = 'queued'", [hostedProbe]);

    // A chooses on premises (its runner polled just now: online).
    const loc = await api("PUT", "/api/runners/location", ownerA, { location: "on_premises" });
    assert.equal(loc.status, 200, JSON.stringify(loc.body));
    const probe = await start(ca, "probe", { asset: "app-a" }), plain = await start(ca, "plain", { asset: "app-a" });
    assert.equal((await runRow(probe)).runner_location, "on_premises", "a private-network kind goes on premises");
    assert.equal((await runRow(plain)).runner_location, "hosted", "any other kind stays hosted");
    assert.ok(!(await events(probe)).some((e) => e.type === "waiting"), "a runner is online: no waiting note");
    // The hosted side never sees it: the scaler's demand, its claimable runs, the fleet token's claim.
    assert.ok(!(await claimableRuns()).some((r) => r.id === probe), "not in the hosted scaler's runs");
    assert.ok((await claimableRuns()).some((r) => r.id === plain));
    assert.equal((await queuedRunsByKind())["fixture_onprem/probe"], undefined, "nor its demand");
    const fleet = await srv.req("POST", "/api/worker/runs/claim", bearer(ENV.APP_WORKER_TOKEN!), { worker_id: "fleet-1", kinds: ["fixture_onprem/probe"] });
    assert.equal((await fleet.json() as any).run, null, "the fleet token never claims a run routed on premises");
    await db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = $1", [plain]);
    // A hosted sandbox launched for it (a run moved after its launch) cannot claim it.
    const [hrow] = await db.query<{ id: number }>("INSERT INTO run_sandboxes (run_id, attempt, provider, sandbox_id, state) VALUES ($1, 1, 'docker', 'x', 'running') RETURNING id", [probe]);
    const htok = await mintRunWorkerToken(probe, A.orgId, hrow!.id, 600);
    const hc = await srv.req("POST", "/api/worker/runs/claim", bearer(htok), {});
    assert.equal((await hc.json() as any).run, null, "a hosted sandbox never claims a run routed on premises");
    await db.query("UPDATE run_sandboxes SET state = 'deleted' WHERE id = $1", [hrow!.id]);

    // B's runner: nothing of A's, whatever it reports.
    const pb = await fb.poll({ sandboxes: [{ row: hrow!.id, sandbox_id: "y", live: false }], failed: [{ row: hrow!.id, step: "start", error: "x" }] });
    assert.equal(pb.status, 200);
    assert.deepEqual(pb.body.assign, [], "another workspace's runner is never handed it");
    assert.deepEqual(pb.body.remove, []);
    assert.equal((await db.query<{ launch_error: string | null }>("SELECT launch_error FROM run_sandboxes WHERE id = $1", [hrow!.id]))[0]!.launch_error, null, "naming another's row changes nothing");

    // A's runner, with an image that lacks the kind: it waits.
    const lacks = await fa.poll({ kinds: ["fixture_onprem/plain"] });
    assert.deepEqual(lacks.body.assign, [], "a kind its image lacks is not handed out");
    // With the kind: one assignment, a run token bound to it, the hosted sandbox's environment.
    const p1 = await fa.poll();
    assert.equal(p1.body.assign.length, 1, JSON.stringify(p1.body));
    const a1 = p1.body.assign[0];
    assert.equal(a1.run_id, probe);
    assert.deepEqual(Object.keys(a1.env).sort(), ["APP_RUN_ID", "APP_RUN_LOCKDOWN", "APP_RUN_PACK_DIR", "APP_RUN_UIDS", "APP_URL", "APP_WORKER_TOKEN"]);
    assert.equal(a1.env.APP_RUN_LOCKDOWN, "on");
    assert.ok(a1.env.APP_WORKER_TOKEN.startsWith("owk_") && a1.env.APP_WORKER_TOKEN !== ENV.APP_WORKER_TOKEN, "a run token, never the fleet token");
    assert.ok(!JSON.stringify(p1.body).includes("DATABASE_URL") && !JSON.stringify(p1.body).includes(String(process.env.APP_VAULT_KEY)));
    const auth = await resolveWorkerToken(a1.env.APP_WORKER_TOKEN);
    assert.equal(auth?.kind, "run");
    assert.equal((auth as any).runId, probe);
    assert.deepEqual(p1.body.keep, [a1.row]);
    // A second poll at once hands out nothing more (one sandbox per run).
    assert.deepEqual((await fa.poll({ sandboxes: [{ row: a1.row, sandbox_id: "c1", live: true }], started: [{ row: a1.row, sandbox_id: "c1" }] })).body.assign, []);
    // The run sandbox (here: by hand) claims, once, then completes with results in A's workspace.
    const w = (p: string, body: unknown, lease?: string) => srv.req("POST", `/api/worker/runs${p}`, { ...bearer(a1.env.APP_WORKER_TOKEN), ...(lease ? { "x-run-lease": lease } : {}) }, body);
    const claim = (await (await w("/claim", {})).json()) as any;
    assert.equal(claim.run?.run.id, probe, JSON.stringify(claim));
    assert.equal((await w("/claim", {})).status, 409, "claims once");
    assert.equal((await srv.req("GET", "/api/worker/fleet", bearer(a1.env.APP_WORKER_TOKEN))).status, 403, "no other worker route");
    const done = await w(`/${probe}/complete`, { outcome: "succeeded", results: [{ check: { area: "run_checks", key: "c1" }, asset: { area: "run_apps", key: "app-a" }, status: "pass", finding_fingerprint: "c1:a" }] }, claim.run.lease_token);
    assert.equal(done.status, 200, await done.text());
    assert.equal((await runRow(probe)).status, "succeeded");
    assert.equal((await db.query<{ org_id: number }>("SELECT org_id FROM run_results WHERE run_id = $1", [probe]))[0]!.org_id, A.orgId);
    // Completing drains the sandbox: the next poll tells the runner to remove it, and its token is revoked.
    const p2 = await fa.poll({ sandboxes: [{ row: a1.row, sandbox_id: "c1", live: true }] });
    assert.deepEqual(p2.body.remove, [a1.row]);
    assert.deepEqual(p2.body.keep, []);
    assert.equal(await resolveWorkerToken(a1.env.APP_WORKER_TOKEN), null, "its token is revoked");
    // A sandbox that never starts: reported failed, three times, then the run fails (never launched forever).
    const doomed = await start(ca, "probe", { asset: "app-a" });
    let pd = await fa.poll();
    for (let i = 0; i < 3; i++) {
      assert.equal(pd.body.assign.length, 1, `start ${i + 1}: ${JSON.stringify(pd.body)}`);
      pd = await fa.poll({ failed: [{ row: pd.body.assign[0].row, step: "create", error: "no such image (test)" }] });
    }
    assert.deepEqual(pd.body.assign, [], "no fourth start");
    const rd = await runRow(doomed);
    assert.equal(rd.status, "failed");
    assert.match(rd.error ?? "", /could not be started \(3 tries; last: the runner could not start it: no such image/);
    // Health on the console.
    const h = (await api("GET", "/api/runners", memberA)).body.runners.find((r: any) => r.id === runnerA);
    assert.equal(h.status, "online");
    assert.equal(h.hostname, "fake");
    assert.deepEqual(h.allow, ["*.corp.example"]);
    // The fake runner goes; the real one comes next.
    assert.equal((await api("DELETE", `/api/runners/${runnerA}`, ownerA)).status, 200);
    assert.equal((await fa.poll()).body.revoked, true, "a revoked runner is told so");
    console.log("✓ routing: hosted by default; on premises needs a runner online; private-network kinds go to the workspace's runner, others stay hosted; the hosted scaler, the fleet token and hosted sandboxes never take them");
    console.log("✓ isolation and protocol: another workspace's runner gets nothing and changes nothing; a kind the image lacks waits; a run token bound to its run and sandbox; claim, complete, remove; failed starts give up after 3");
  }

  // ---------- 6. the real runner program, against the fake Docker ----------
  await new Promise<void>((r) => docker.listen(DOCKER_SOCK, () => r()));
  const stateDir = path.join(TMP, "runner-state");
  const c2 = await api("POST", "/api/runners", ownerA, { name: "Data centre 2" });
  const runnerEnv = { PATH: process.env.PATH!, APP_RUNNER_URL: base, APP_RUNNER_ALLOW_HTTP: "yes", APP_RUNNER_TOKEN: c2.body.enrollment_token,
    APP_RUNNER_STATE_DIR: stateDir, APP_DOCKER_SOCKET: DOCKER_SOCK, APP_RUNNER_IMAGE: "sha256:runimage", APP_RUNNER_NETWORK: "customer-net",
    APP_RUNNER_ALLOW: "*.corp.example vault.corp.example:443|8200 10.20.0.0/16:6443", APP_RUNNER_WAIT_SECONDS: "1", APP_RUNNER_NAME: "dc2-host",
    // The runner reports the kinds its image has: this test's fixture pack (scripts/fixtures/onprem-runner-fixture.ts).
    APP_REGISTRY: process.env.APP_REGISTRY! };
  let out = "";
  const proc = spawn(process.execPath, ["--import", "tsx", "scripts/fixtures/onprem-runner-fixture.ts"], { cwd: ROOT, env: runnerEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr!.on("data", (d) => { out += d; if (process.env.ONPREM_DEBUG) process.stderr.write(`[runner] ${d}`); });
  proc.stdout!.on("data", (d) => { out += d; });
  const exited = new Promise<number>((r) => proc.on("exit", (code) => r(code ?? -1)));
  try {
    await waitFor("the runner to enroll", async () => existsSync(path.join(stateDir, "credential.json")), 30_000);
    assert.equal(statSync(path.join(stateDir, "credential.json")).mode & 0o777, 0o600, "its credential is the runner's alone");
    await waitFor("the runner online", async () => (await api("GET", "/api/runners", memberA)).body.runners.some((r: any) => r.name === "Data centre 2" && r.status === "online"), 30_000);
    const id = await start(ca, "probe", { asset: "app-a" });
    await waitFor("its container", async () => cts.size > 0, 30_000);
    const ct = [...cts.values()][0]!;
    const hc = ct.body.HostConfig;
    assert.equal(ct.body.Image, "sha256:runimage");
    assert.deepEqual(ct.body.Cmd.slice(0, 3), ["timeout", "-s", "KILL"], "its own deadline");
    assert.deepEqual(ct.body.Cmd.slice(-3), ["--import", "tsx", "src/run-sandbox-runner.ts"]);
    assert.deepEqual(hc.CapDrop, ["ALL"]);
    assert.deepEqual([...hc.CapAdd].sort(), ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "NET_ADMIN", "SETGID", "SETUID"]);
    assert.deepEqual(hc.SecurityOpt, ["no-new-privileges"]);
    assert.ok(hc.Privileged === false && hc.Binds.length === 0 && !hc.Mounts, "no socket, no mount");
    assert.equal(hc.NetworkMode, "customer-net");
    assert.ok(hc.Memory > 0 && hc.NanoCpus > 0 && hc.PidsLimit > 0);
    const env = Object.fromEntries((ct.body.Env as string[]).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(env.APP_URL, base, "the run reaches the app at the runner's own address");
    assert.equal(env.APP_RUN_PRIVATE_ALLOW, "*.corp.example vault.corp.example:443|8200 10.20.0.0/16:6443", "and gets the runner's allow list");
    assert.equal(env.APP_RUN_LOCKDOWN, "on");
    assert.ok(!(ct.body.Env as string[]).some((l) => l.includes("orr_") || l.includes("ore_")), "neither the runner's credential nor its token");
    assert.equal(ct.body.Labels[`org.${NS}.onprem-runner`], (await db.query<{ id: string }>("SELECT id FROM onprem_runners WHERE name = 'Data centre 2'"))[0]!.id);
    await waitFor("the run", ended(id));
    const r = await runRow(id);
    assert.equal(r.status, "succeeded", `${r.error} :: ${out.slice(-1500)}`);
    assert.ok((await events(id)).some((e) => e.type === "claimed" && /^sbx-\d+$/.test(e.data.worker_id)), "claimed by its run sandbox");
    assert.equal((await db.query<{ org_id: number; asset_key: string }>("SELECT org_id, asset_key FROM run_results WHERE run_id = $1", [id]))[0]!.asset_key, "app-a");
    await waitFor("the container removed", async () => cts.size === 0, 30_000);
    const health = (await api("GET", "/api/runners", memberA)).body.runners.find((x: any) => x.name === "Data centre 2");
    assert.deepEqual(health.allow, ["*.corp.example", "vault.corp.example:443|8200", "10.20.0.0/16:6443"]);
    assert.equal(health.hostname, "dc2-host");
    assert.equal(health.isolation, "docker");
    console.log("✓ the runner program: enrolls (credential 0600), a container per run with the hosted settings, its own address and allow list; the run succeeds in its workspace; the container is removed; health shown");

    // ---------- 7. revocation ----------
    const slow = await start(ca, "probe_slow", { asset: "app-a" });
    await waitFor("the slow run to work", async () => (await events(slow)).some((e) => e.type === "progress" || e.type === "log"), 60_000);
    const [srow] = await db.query<{ id: number }>("SELECT id FROM run_sandboxes WHERE run_id = $1 AND state <> 'deleted'", [slow]);
    const sTok = Object.fromEntries((([...cts.values()][0]!.body.Env) as string[]).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])).APP_WORKER_TOKEN!;
    assert.ok(await resolveWorkerToken(sTok));
    const rid = health.id;
    const rv = await api("DELETE", `/api/runners/${rid}`, ownerA);
    assert.equal(rv.status, 200, JSON.stringify(rv.body));
    assert.deepEqual(rv.body, { revoked: true, runs_stopped: 1 });
    // At once: its sandbox's token, its row, and the run's attempt.
    assert.equal(await resolveWorkerToken(sTok), null, "the sandbox's token stops at once");
    assert.equal((await db.query<{ state: string }>("SELECT state FROM run_sandboxes WHERE id = $1", [srow!.id]))[0]!.state, "deleted");
    const rs = await runRow(slow);
    assert.equal(rs.status, "queued", "its run goes back to the queue (an attempt is left)");
    assert.equal(rs.worker_id, null);
    assert.equal(await exited, 3, `the runner exits 3 when revoked: ${out.slice(-800)}`);
    assert.equal(cts.size, 0, "it removed its containers");
    assert.ok(!existsSync(path.join(stateDir, "credential.json")), "and deleted its credential");
    const g = (await api("GET", "/api/runners", memberA)).body;
    assert.equal(g.runners.find((x: any) => x.id === rid).status, "revoked");
    assert.equal(g.queued_on_premises, 1, "the run waits for a runner");
    // Back to hosted: the queued run moves with it.
    const back = await api("PUT", "/api/runners/location", ownerA, { location: "hosted" });
    assert.deepEqual(back.body, { location: "hosted", moved: 1 });
    assert.equal((await runRow(slow)).runner_location, "hosted");
    assert.ok((await claimableRuns()).some((x) => x.id === slow), "the hosted scaler takes it now");
    assert.ok((await events(slow)).some((e) => e.type === "location" && e.data.location === "hosted"));
    await db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = $1", [slow]);
    console.log("✓ revocation: at once the sandbox token, the row and the run's attempt stop; the run is queued again; the runner removes its containers, deletes its credential and exits 3; back to hosted moves the queued run");
  } finally { killTree(proc); proc.kill("SIGKILL"); }

  // ---------- 8. a silent runner; staff ----------
  {
    await fb.poll();
    const lb = await api("PUT", "/api/runners/location", ownerB, { location: "on_premises" });
    assert.equal(lb.status, 200, JSON.stringify(lb.body));
    const id = await start(cb, "probe", { asset: "app-b" });
    const p = await fb.poll();
    assert.equal(p.body.assign.length, 1);
    assert.equal(p.body.assign[0].run_id, id, "B's runner gets B's run");
    const tok = p.body.assign[0].env.APP_WORKER_TOKEN;
    await db.query("UPDATE onprem_runners SET last_seen_at = now() - interval '20 minutes' WHERE secret_hash = $1", [sha256(credB)]);
    assert.equal((await api("GET", "/api/runners", ownerB)).body.runners[0].status, "offline");
    assert.equal(await onprem.reapSilentRunners(), 1);
    assert.equal(await resolveWorkerToken(tok), null, "a silent runner's sandbox token is revoked");
    await db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = $1", [id]);
    // A new run of B's while its runner is offline says it waits.
    const waiting = await start(cb, "probe", { asset: "app-b" });
    assert.match((await events(waiting)).find((e) => e.type === "waiting")?.data.reason ?? "", /on-premises runner: none is online/);
    await db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = $1", [waiting]);
    // Staff: every workspace's runners, no secret; only operators revoke.
    const viewer = await srv.adminToken("viewer"), operator = await srv.adminToken("operator");
    const list = await api("GET", "/api/admin/onboarding/runners", viewer);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const orgs = new Set(list.body.runners.map((x: any) => x.org_id));
    assert.ok(orgs.has(A.orgId) && orgs.has(B.orgId), "both workspaces'");
    const text = JSON.stringify(list.body);
    assert.ok(!/secret_hash|enroll_token_hash|orr_|ore_/.test(text) && !text.includes(sha256(credB)), "no secret or hash");
    const bid = list.body.runners.find((x: any) => x.org_id === B.orgId && x.status !== "revoked").id;
    assert.equal((await api("DELETE", `/api/admin/onboarding/runners/${bid}`, viewer)).status, 403, "a viewer cannot revoke");
    assert.equal((await api("DELETE", `/api/admin/onboarding/runners/${bid}`, operator)).status, 200, "an operator can");
    assert.equal((await fb.poll()).status, 401);
    console.log("✓ a silent runner's sandbox tokens are revoked; a run with no runner online says it waits; staff see every runner without secrets; operators revoke");
  }

  // ---------- 9. the allow list; the off switch ----------
  {
    assert.deepEqual(privateAllowText(parsePrivateAllow("vault.corp.example, *.corp.example:443|8443 10.20.3.4/16:6443 192.168.1.10")),
      ["vault.corp.example", "*.corp.example:443|8443", "10.20.0.0/16:6443", "192.168.1.10/32"]);
    for (const bad of ["127.0.0.1", "10.0.0.0/7", "169.254.169.254", "localhost", "*.com", "[::1]", "fd00::/8", "a.example:0", "a.example:70000", "224.0.0.1", "not a host!"])
      assert.throws(() => parsePrivateAllow(bad), /allow list entry/, bad);
    assert.deepEqual(parsePrivateAllow(""), []);
    // Off: every run is hosted again (a queued on-premises run included), and nothing new is routed.
    await db.query("INSERT INTO workspace_runner_settings (org_id, location) VALUES ($1, 'on_premises') ON CONFLICT (org_id) DO UPDATE SET location = 'on_premises'", [A.orgId]);
    const q = await start(ca, "probe", { asset: "app-a" });
    assert.equal((await runRow(q)).runner_location, "on_premises");
    assert.ok(!(await claimableRuns()).some((x) => x.id === q));
    process.env.APP_ONPREM_RUNNERS = "off";
    assert.equal(onprem.onPremAvailable(), false);
    assert.ok((await claimableRuns()).some((x) => x.id === q), "off: the hosted scaler takes it");
    const q2 = await start(ca, "probe", { asset: "app-a" });
    assert.equal((await runRow(q2)).runner_location, "hosted", "off: new runs are hosted");
    delete process.env.APP_ONPREM_RUNNERS;
    await db.query("UPDATE runs SET status = 'cancelled', ended_at = now() WHERE id = ANY($1::text[])", [[q, q2]]);
    console.log("✓ the allow list: names, wildcards, networks and ports; loopback, link-local, multicast, IPv6, wide networks refused; APP_ONPREM_RUNNERS=off sends every run back to the hosted scaler");
  }
  await ca.close(); await cb.close();
  await srv.close();
  console.log("\nONPREM RUNNERS TEST PASS");
} catch (e) {
  failed = true;
  console.error(e);
  console.error("\nONPREM RUNNERS TEST FAIL");
} finally {
  for (const k of [...kids]) killTree(k);
  docker.close();
  if (existsSync(DOCKER_SOCK)) rmSync(DOCKER_SOCK, { force: true });
  await db.close();
  cleanup();
}
process.exit(failed ? 1 : 0);
