/**
 * Hermetic tests for production topology (orchestrators only inside boat sandboxes; worker sandboxes from there):
 *  - host guard: refuses a non-boat host, refuses RUNNER=pool|docker|local without APP_DEV_ALLOW_LOCAL=1,
 *    accepts a boat host with the launcher's markers; the real entry point refuses on this (non-boat) machine
 *  - RUNNER=boat fleet semantics: the server assignment caps concurrent worker sandboxes per agent group, claims carry
 *    {agent_ids:[group]} with limit = free slots, one fresh worker sandbox per session, deleted afterwards
 *  - start-rate: the client gate paces creates; boat 429s are backed off and retried, nothing fails
 *  - launcher budget math (orchestrators x (1 + POD_CAPACITY) <= plan)
 *  - the worker token never reaches a worker sandbox (files, commands, env files)
 *
 *   npx tsx orchestrator/test/boat-fleet.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkHost, type HostProbe } from "../core/host-guard.js";
import { StartGate } from "../core/boat.js";
import { computeBudget } from "../deploy/boat-orchestrators.js";
import { isShellEnvName } from "../core/env-names.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const BOAT_PORT = Number(process.env.BTEST_BOAT_PORT ?? 3401);
const API_PORT = Number(process.env.BTEST_API_PORT ?? 3402);
const WORKER_TOKEN = `wt_SECRET_${randomBytes(12).toString("hex")}`;
const BOAT_KEY = `boat_mock_${randomBytes(8).toString("hex")}`;
const results: { name: string; ok: boolean; detail: string }[] = [];
const log = (...a: unknown[]) => console.log(`[btest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 1. guard (pure)

const probe = (env: Record<string, string>, files: Record<string, string | true>): HostProbe => ({
  env, exists: (p) => p in files, read: (p) => (typeof files[p] === "string" ? (files[p] as string) : null),
});
const boatFiles = { "/etc/ascii": true as const, "/home/user/.ascii": true as const, "/etc/app/host-role": '{"role":"boat-orchestrator","sandbox_id":"bx_abcd2345"}' };
const boatEnv = { APP_HOST_ROLE: "boat-orchestrator", BOAT_ID: "bx_abcd2345" };
const g1 = checkHost("boat", probe({}, {}));
const g2 = checkHost("local", probe(boatEnv, boatFiles));
const g3 = checkHost("pool", probe({ APP_DEV_ALLOW_LOCAL: "1" }, {}));
const g4 = checkHost("boat", probe(boatEnv, boatFiles));
const g5 = checkHost("boat", probe({ ...boatEnv, BOAT_ID: "bx_zzzz9999" }, boatFiles));
const g6 = checkHost("boat", probe({ BOAT_ID: "bx_abcd2345" }, { "/etc/ascii": true, "/home/user/.ascii": true }));
check("guard refuses a non-boat host", !g1.ok && g1.problems.length >= 3, g1.problems.join(" | ").slice(0, 160));
check("guard refuses RUNNER=local on a boat host without the dev flag", !g2.ok && /RUNNER=local is not allowed/.test(g2.problems.join()), g2.problems[0] ?? "");
check("dev flag bypasses with a loud warning", g3.ok && g3.dev && /HOST GUARD DISABLED/.test(g3.warning ?? ""), (g3.warning ?? "").split("\n")[1] ?? "");
check("guard accepts a boat orchestrator sandbox (env role + marker + boat indicators)", g4.ok, g4.problems.join());
check("guard refuses when BOAT_ID does not match the launcher marker", !g5.ok && /does not match/.test(g5.problems.join()), "");
check("guard refuses a boat VM without the launcher's markers", !g6.ok && /HOST_ROLE|marker/.test(g6.problems.join()), "");
const g7 = checkHost("boat", probe({ ...boatEnv, BOAT_AGENT_USER: "user" }, boatFiles));
check("guard refuses running the coding agent as the sudo-capable boat user", !g7.ok && /BOAT_AGENT_USER=user/.test(g7.problems.join()), g7.problems.join());
const real = spawnSync(TSX, ["orchestrator/worker.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, APP_URL: "http://127.0.0.1:1", APP_WORKER_TOKEN: "x", RUNNER: "local" } });
check("the real entry point refuses to start on this machine", real.status !== 0 && /Refusing to start/.test(real.stderr + real.stdout),
  (real.stderr + real.stdout).split("\n").find((l) => /Refusing/.test(l))?.slice(0, 140) ?? `exit ${real.status}`);

// ---------------------------------------------------------------- 2. budget + start gate (pure)

const L = { activeSandboxes: 100, startsPerMinute: 12, startsPerHour: 60, startsPerDay: 200, activeNow: 5 };
const b4 = computeBudget(L, 4, 20, 0), b5 = computeBudget(L, 5, 20, 0), bOurs = computeBudget({ ...L, activeNow: 44 }, 2, 20, 42);
check("budget: 4 x (1+20) = 84 of 95 available -> OK; 5 -> 105 refused; max 4", b4.ok && !b5.ok && b4.maxOrchestrators === 4 && b5.requestedSandboxes === 105 && b4.available === 95,
  `${b5.reason}`);
check("budget: our own active sandboxes are not double-counted", bOurs.otherActive === 2 && bOurs.ok, `otherActive ${bOurs.otherActive}`);
check("budget: throughput ceiling = starts/day minus orchestrator starts", b4.sessionsPerDayCeiling === 196, `${b4.sessionsPerDayCeiling}/day`);
const gate = new StartGate(3, 100);
const t0 = Date.now();
const w = [gate.waitMs(t0)];
for (let i = 0; i < 3; i++) await gate.acquire();
w.push(gate.waitMs());
check("start gate: 3/min allows 3 immediately, then makes the 4th wait ~60s", w[0] === 0 && w[1]! > 55_000 && Date.now() - t0 < 1000, `4th waits ${Math.round(w[1]! / 1000)}s`);

// ---------------------------------------------------------------- 3. mock boat + mock server, real worker (RUNNER=boat)

const GROUPS = { "claude-code/opus": 2, "claude-code/sonnet": 1 };
interface Sb { id: string; name: string; alive: boolean; files: Map<string, string>; cmds: string[]; procs: Map<number, { end: number; n: number }> }
const sandboxes = new Map<string, Sb>();
const createTimes: number[] = [];
let throttled = 0, created = 0;
const seenIdem = new Set<string>();
const liveByGroup: Record<string, number> = {}, maxByGroup: Record<string, number> = {};
const groupOf = (name: string) => (/opus/.test(name) ? "claude-code/opus" : /sonnet/.test(name) ? "claude-code/sonnet" : "?");
let nextPid = 100;
const RUN_MS = 1500;
let drainFaults = 2, exitFaults = 2; // network drops injected after a run has exited (see the stream / exit handlers)

const stream = (lines: string[]) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-2222-3333-4444-555555555555", model: "m" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 } }),
].slice(Math.max(0, Number(lines[0] ?? 1) - 1));

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };

const boat = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    if (req.headers.authorization !== `Bearer ${BOAT_KEY}`) return json(res, 401, { ok: false, code: "unauthorized" });
    const b = raw ? JSON.parse(raw) : {};
    const u = String(req.url).replace(/^\/api\/v1/, "");
    if (u === "/me") return json(res, 200, { ok: true, user: { login: "mock" } });
    if (req.method === "POST" && u === "/sandboxes") {
      const now = Date.now();
      // Rate limit: >= 3 creates in 2s, and (deterministically) the first attempt of the first two creates.
      const idem = String(req.headers["idempotency-key"] ?? "");
      const firstTry = idem && !seenIdem.has(idem); if (idem) seenIdem.add(idem);
      if (createTimes.filter((t) => now - t < 2000).length >= 3 || (firstTry && seenIdem.size <= 2)) { throttled++; return json(res, 429, { ok: false, code: "rate_limited", message: "slow down" }, { "retry-after": "1" }); }
      createTimes.push(now);
      const id = `bx_${randomBytes(4).toString("hex")}`;
      created++;
      sandboxes.set(id, { id, name: "", alive: true, files: new Map(), cmds: [], procs: new Map() });
      return json(res, 202, { ok: true, sandbox: { id, state: "provisioning" } });
    }
    const m = /^\/sandboxes\/(bx_\w+)(\/.*)?$/.exec(u.split("?")[0]!);
    const sb = m ? sandboxes.get(m[1]!) : undefined;
    if (!sb) return json(res, 404, { ok: false, code: "not_found" });
    const rest = m![2] ?? "";
    if (req.method === "GET" && rest === "") return json(res, 200, { ok: true, sandbox: { id: sb.id, state: sb.alive ? "ready" : "archived", name: sb.name } });
    if (req.method === "PATCH" && rest === "") {
      if (b.name && !sb.name) { sb.name = b.name; const g = groupOf(b.name); liveByGroup[g] = (liveByGroup[g] ?? 0) + 1; maxByGroup[g] = Math.max(maxByGroup[g] ?? 0, liveByGroup[g]!); }
      return json(res, 200, { ok: true });
    }
    if (req.method === "DELETE" && rest === "") {
      if (sb.alive && sb.name) liveByGroup[groupOf(sb.name)]!--;
      sb.alive = false;
      return json(res, 202, { ok: true, type: "sandbox.deleting" });
    }
    if (req.method === "PUT" && rest === "/files") { sb.files.set(b.path, b.content); return json(res, 200, { ok: true, type: "file.written" }); }
    if (req.method === "POST" && rest === "/commands") {
      const cmd: string = b.command;
      sb.cmds.push(cmd);
      if (b.detached) {
        const n = Number(/launch-(\d+)\.sh/.exec(cmd)?.[1] ?? 0), pid = nextPid++;
        sb.procs.set(pid, { end: Date.now() + RUN_MS, n });
        return json(res, 200, { ok: true, type: "command.started", processId: pid, pid });
      }
      if (b.stream) {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        const frame = (o: object) => res.write(JSON.stringify(o) + "\n");
        frame({ type: "started" });
        const tail = /tail -n \+(\d+)(?: -F --pid=(\d+))? \/tmp\/app\/out-\d+\.jsonl/.exec(cmd);
        // Network drop on the final drain (the run has exited, no -F): boat reports the reset as an error frame.
        if (tail && !tail[2] && drainFaults-- > 0)
          return void res.end(JSON.stringify({ type: "error", error: "stream_error", message: "ECONNRESET: The socket connection was closed unexpectedly." }) + "\n");
        if (tail) {
          const p = tail[2] ? sb.procs.get(Number(tail[2])) : null;
          if (p) await sleep(Math.max(0, p.end - Date.now()));
          const lines = stream([tail[1]!]);
          if (lines.length) frame({ type: "stdout", data: lines.join("\n") + "\n" });
        }
        // The mock agent "added left-pad": a dependency change, so the done check passes after one run.
        if (/diff\.sh/.test(cmd)) frame({ type: "stdout", data: 'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{"dependencies":{"left-pad":"^1.3.0"}}\n' });
        res.end(JSON.stringify({ type: "exit", exitCode: 0 }) + "\n");
        return;
      }
      // ...and a socket that dies while reading the exit status.
      if (/cat \/tmp\/app\/exit-/.test(cmd) && exitFaults-- > 0) return void req.socket.destroy();
      if (/cat \/tmp\/app\/exit-/.test(cmd)) return json(res, 200, { ok: true, exitCode: 0, stdout: "0\n", stderr: "" });
      return json(res, 200, { ok: true, exitCode: 0, stdout: /cur=/.test(cmd) ? "harness claude-code: preinstalled (2.1.296)" : "", stderr: "" });
    }
    const cm = /^\/commands\/(\d+)$/.exec(rest);
    if (req.method === "GET" && cm) { const p = sb.procs.get(Number(cm[1])); return json(res, 200, { ok: true, running: !!p && Date.now() < p.end, exitCode: p && Date.now() >= p.end ? 0 : null, stdout: "", stderr: "" }); }
    json(res, 404, { ok: false, code: "not_found" });
  });
});

const queue = [
  ...Array.from({ length: 5 }, (_, i) => ({ session_id: `opus${i}`, agent_id: "claude-code/opus", model: "claude-opus-5-5" })),
  ...Array.from({ length: 3 }, (_, i) => ({ session_id: `sonnet${i}`, agent_id: "claude-code/sonnet", model: "claude-sonnet-5-5" })),
].map((j) => ({ simulation_id: "sim", org_id: 1, product_id: 1, harness: "claude-code", attempt: 1, prompt: "Add left-pad to this project.", repo_url: null, language: null, max_user_turns: 0, profile: null, ...j }));
const claims: { agent_ids?: string[]; limit: number; got: number }[] = [];
const completed = new Map<string, any>();
let fleetLeft = false;
const api = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${WORKER_TOKEN}`) return json(res, 401, { error: "bad token" });
    const b = raw && /^application\/json/.test(String(req.headers["content-type"])) ? JSON.parse(raw) : {};
    const u = String(req.url);
    if (u === "/api/worker/orchestrator/credentials") return json(res, 200, { boat: { api_key: BOAT_KEY }, llm: null });
    if (u === "/api/worker/fleet" && req.method === "POST")
      return json(res, 200, { orchestrator_id: b.orchestrator_id, next_checkin_seconds: 30,
        assignment: Object.entries(GROUPS).map(([agent_id, pods]) => ({ agent_id, harness: "claude-code", model: agent_id.endsWith("opus") ? "claude-opus-5-5" : "claude-sonnet-5-5", pods })) });
    if (u.startsWith("/api/worker/fleet/") && req.method === "DELETE") { fleetLeft = true; res.writeHead(204); return res.end(); }
    if (u === "/api/worker/claim") {
      const jobs = [];
      for (let i = 0; i < queue.length && jobs.length < b.limit; ) if (!b.agent_ids || b.agent_ids.includes(queue[i]!.agent_id)) jobs.push(queue.splice(i, 1)[0]); else i++;
      claims.push({ agent_ids: b.agent_ids, limit: b.limit, got: jobs.length });
      return json(res, 200, { jobs });
    }
    const m = /^\/api\/worker\/sessions\/([^/]+)\/(credentials|complete|events|heartbeat)$/.exec(u);
    if (m?.[2] === "credentials") return json(res, 200, { expires_at: new Date(Date.now() + 3600e3).toISOString(), providers: { anthropic: { mode: "gateway", base_url: "https://api.example/gw/anthropic", api_key: "ogw_session_token_x" } } });
    if (m?.[2] === "complete") { completed.set(m[1]!, b); return json(res, 200, { verdict: null }); }
    if (u.startsWith("/api/worker/research")) return json(res, 200, { jobs: [] });
    json(res, 200, {});
  });
});

await new Promise<void>((r) => boat.listen(BOAT_PORT, "127.0.0.1", () => r()));
await new Promise<void>((r) => api.listen(API_PORT, "127.0.0.1", () => r()));
const worker = spawn(TSX, ["orchestrator/worker.ts"], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, APP_URL: `http://127.0.0.1:${API_PORT}`, APP_WORKER_TOKEN: WORKER_TOKEN,
    RUNNER: "boat", POD_CAPACITY: "3", ORCHESTRATOR_ID: "btest", APP_DEV_ALLOW_LOCAL: "1", BOAT_API_URL: `http://127.0.0.1:${BOAT_PORT}/api/v1`,
    POLL_INTERVAL_SECONDS: "1", BOAT_STARTS_PER_MINUTE: "100", HEARTBEAT_SECONDS: "30" },
});
let wlog = "";
worker.stdout!.on("data", (d) => (wlog += d));
worker.stderr!.on("data", (d) => (wlog += d));
for (const t = Date.now(); completed.size < 8 && Date.now() - t < 120_000; ) await sleep(500);
worker.kill("SIGTERM");
await new Promise((r) => { worker.once("exit", r); setTimeout(r, 15_000); });

const statuses = [...completed.values()].map((c) => c.status);
check("all 8 sessions completed through worker sandboxes", completed.size === 8 && statuses.every((s) => s === "completed"), `${completed.size} completed: ${[...new Set(statuses)].join(",")}`);
check("per-group concurrent worker sandboxes capped by the fleet assignment (opus 2, sonnet 1) and reached",
  maxByGroup["claude-code/opus"] === 2 && maxByGroup["claude-code/sonnet"] === 1, JSON.stringify(maxByGroup));
const badClaims = claims.filter((c) => c.got > 0 && (!c.agent_ids || c.agent_ids.length !== 1 || c.limit > GROUPS[c.agent_ids[0] as keyof typeof GROUPS]));
check("claims carry {agent_ids:[group]} with limit <= the group's free slots", claims.length > 0 && !badClaims.length,
  claims.filter((c) => c.got).map((c) => `${c.agent_ids?.[0]?.split("/")[1]}:${c.limit}->${c.got}`).join(" "));
check("one fresh worker sandbox per session, all deleted", created === 8 && [...sandboxes.values()].every((s) => !s.alive), `${created} created, ${[...sandboxes.values()].filter((s) => s.alive).length} alive`);
check("boat 429s were backed off and retried (no session failed)", throttled > 0 && completed.size === 8, `${throttled} x 429`);
check("network drops after a run exited (final drain, exit status) are retried, not failed sessions",
  drainFaults <= 0 && exitFaults <= 0 && completed.size === 8, `drain faults left ${drainFaults}, exit faults left ${exitFaults}, completed ${completed.size}/8`);
const leaks = [...sandboxes.values()].filter((s) => [...s.files.values(), ...s.cmds].some((x) => x.includes(WORKER_TOKEN) || x.includes(BOAT_KEY)));
const envFiles = [...sandboxes.values()].flatMap((s) => [...s.files.entries()].filter(([p]) => /\/env-\d+$/.test(p)).map(([, c]) => c));
const envKeys = [...new Set(envFiles.flatMap((c) => c.split("\n").map((l) => l.split("=")[0]).filter(Boolean)))].sort();
check("worker token (and boat key) never reach a worker sandbox; env files hold only harness creds",
  !leaks.length && envFiles.length === 8 && envKeys.every((k) => !isShellEnvName(k) && !/BOAT|WORKER/.test(k)) && envFiles.every((c) => /ANTHROPIC_API_KEY='ogw_/.test(c)),
  `leaks ${leaks.length}; env keys: ${envKeys.join(",")}`);
check("SIGTERM: left the fleet", fleetLeft, "");

boat.close(); api.close();
if (results.some((r) => !r.ok)) console.log("--- worker log tail\n" + wlog.split("\n").slice(-25).join("\n"));
const pass = results.every((r) => r.ok);
console.log(`\n${pass ? "BOAT FLEET TEST PASS" : "BOAT FLEET TEST FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
