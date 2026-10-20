/**
 * End-to-end integration test against the REAL Octillion server (no stand-ins on the Octillion side):
 *   key vault + credential broker + inference gateway + fleet planner + MCP tools + scoring
 * driven by the real orchestrator (Pi, RUNNER=pool, server fleet mode) and the real Claude Code image.
 * Only the LLM vendor is fake: a local Anthropic-compatible server that the vault's `anthropic` provider points at,
 * holding a FAKE canary key. Costs nothing.
 *
 *   npx tsx orchestrator/test/integration.ts
 *
 * Needs: Docker, the image octillion/agent-claude-code:2.1.296 (orchestrator/images/build.sh claude-code), the
 * Docker bridge reachable from pods (PUBLIC_URL uses its gateway IP), ports 3395/3396 free, npm deps installed in the
 * repo root and in orchestrator/. Env overrides: ITEST_PORT, ITEST_UPSTREAM_PORT, ITEST_BRIDGE_IP, ITEST_TIMEOUT_MIN,
 * ITEST_IMAGE, ITEST_KEEP=1 (keep the temp dir).
 *
 * Asserts:
 *  1. every session completes with verdict `adopted` (product "left-pad", package `left-pad`)
 *  2. gateway_usage rows exist for every session, with metered input and output tokens (and for the orchestrator's Pi)
 *  3. session gateway tokens are revoked on completion: a token that worked while the session ran gets 401 afterwards
 *  4. the canary key never appears in any pod process env, container env, transcript or gateway client request;
 *     the fake vendor only ever sees the canary in x-api-key, never an ogw_ token
 *  5. fleet assignment has separate opus/sonnet pod groups (2+1 of POD_CAPACITY=3), pods carry the group labels,
 *     and every session ran on a pod of its own group (claims stayed separated)
 *  6. the orchestrator host env holds only OCTILLION_URL and OCTILLION_WORKER_TOKEN as secrets; SIGTERM leaves the
 *     fleet and removes every pod
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, openSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.ITEST_PORT ?? 3395);
const UP_PORT = Number(process.env.ITEST_UPSTREAM_PORT ?? 3396);
const IMAGE = process.env.ITEST_IMAGE ?? "octillion/agent-claude-code:2.1.296";
const TIMEOUT_MS = Number(process.env.ITEST_TIMEOUT_MIN ?? 12) * 60_000;
const BRIDGE = process.env.ITEST_BRIDGE_IP
  ?? spawnSync("docker", ["network", "inspect", "bridge", "-f", "{{(index .IPAM.Config 0).Gateway}}"], { encoding: "utf8" }).stdout.trim()
  ?? "172.17.0.1";
const BASE = `http://127.0.0.1:${PORT}`;
// Spawn tsx directly: `npx` exits on SIGTERM without forwarding it, orphaning the real process (seen in this rig).
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const WORKER_TOKEN = `wt_${randomBytes(16).toString("hex")}`;
const ADMIN_TOKEN = `adm_${randomBytes(16).toString("hex")}`;
const VAULT_KEY = randomBytes(32).toString("base64");
const CANARY = `sk-ant-canary-${randomBytes(12).toString("hex")}`;
const ORCH_ID = `itest-${randomBytes(3).toString("hex")}`;
const AGENTS = ["claude-code/opus", "claude-code/sonnet"];
const FINAL_TEXT = "Installed left-pad with npm. Done.";

const tmp = mkdtempSync(path.join(tmpdir(), "octillion-itest-"));
const log = (...a: unknown[]) => console.log(`[itest ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`); };

// ---------------------------------------------------------------- fake Anthropic vendor (the vault's upstream)

interface UpReq { kind: "pi" | "harness" | "other"; path: string; keyOk: boolean; ogwSeen: boolean; canaryElsewhere: boolean }
const upstream: UpReq[] = [];

const textOf = (c: any): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text ?? textOf(x?.content) ?? "").join("") : "";

/** Pi orchestrator script: start_worker -> wait_for_turn -> (reply if a question) -> finish_session -> done. */
function piStep(body: any): { blocks: any[]; stop: string } {
  const msgs = (body.messages ?? []).filter((m: any) => m.role !== "system");
  const names: Record<string, string> = {};
  for (const m of msgs) if (m.role === "assistant" && Array.isArray(m.content)) for (const c of m.content) if (c.type === "tool_use") names[c.id] = c.name;
  const last = msgs[msgs.length - 1];
  const tr = Array.isArray(last?.content) ? last.content.filter((c: any) => c.type === "tool_result").pop() : null;
  const id = `toolu_${randomBytes(6).toString("hex")}`;
  if (!tr) {
    const job = /Run job (job_\w+)/.exec(textOf(last?.content))?.[1];
    return { blocks: [{ type: "tool_use", id, name: "start_worker", input: { job_id: job } }], stop: "tool_use" };
  }
  let out: any = {};
  try { out = JSON.parse(textOf(tr.content)); } catch { /* error text */ }
  const session = out.session ?? JSON.stringify(msgs).match(/w_[0-9a-f]{8}/)?.[0];
  const tool = names[tr.tool_use_id];
  if (tool === "start_worker" || tool === "reply_as_developer") return { blocks: [{ type: "tool_use", id, name: "wait_for_turn", input: { session } }], stop: "tool_use" };
  if (tool === "wait_for_turn") {
    if (out.can_reply && /\?\s*$/.test(out.last_assistant_text ?? "")) return { blocks: [{ type: "tool_use", id, name: "reply_as_developer", input: { session, text: "Your call." } }], stop: "tool_use" };
    return { blocks: [{ type: "tool_use", id, name: "finish_session", input: { session, status: "completed" } }], stop: "tool_use" };
  }
  return { blocks: [{ type: "text", text: "Finished." }], stop: "end_turn" };
}

/** Claude Code script: one Bash tool_use `npm install left-pad`, then the final text. */
function harnessStep(body: any): { blocks: any[]; stop: string } {
  const hasResult = /"type":"tool_result"/.test(JSON.stringify(body.messages ?? []));
  if (hasResult) return { blocks: [{ type: "text", text: FINAL_TEXT }], stop: "end_turn" };
  return { blocks: [{ type: "tool_use", id: `toolu_${randomBytes(6).toString("hex")}`, name: "Bash", input: { command: "npm install left-pad --no-audit --no-fund", description: "Install left-pad" } }], stop: "tool_use" };
}

function respond(res: http.ServerResponse, body: any, step: { blocks: any[]; stop: string }) {
  const mid = `msg_${randomBytes(6).toString("hex")}`;
  const model = body.model ?? "fake";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: mid, type: "message", role: "assistant", model, content: step.blocks, stop_reason: step.stop, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 } }));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id: mid, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1 } } });
  step.blocks.forEach((b, i) => {
    if (b.type === "text") {
      ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      ev("content_block_start", { index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev("content_block_stop", { index: i });
  });
  ev("message_delta", { delta: { stop_reason: step.stop, stop_sequence: null }, usage: { output_tokens: 30 } });
  ev("message_stop", {});
  res.end();
}

const fakeVendor = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON */ }
    const headerDump = JSON.stringify(req.headers);
    const tools: string[] = (body.tools ?? []).map((t: any) => t.name);
    const kind: UpReq["kind"] = tools.includes("start_worker") ? "pi" : tools.includes("Bash") ? "harness" : "other";
    upstream.push({
      kind, path: req.url ?? "",
      keyOk: req.headers["x-api-key"] === CANARY,
      ogwSeen: /ogw_/.test(headerDump) || /ogw_/.test(req.url ?? ""),
      canaryElsewhere: Object.entries(req.headers).some(([k, v]) => k !== "x-api-key" && k !== "authorization" && String(v).includes(CANARY)),
    });
    const u = req.url ?? "";
    if (req.method === "GET" && /\/v1\/models/.test(u)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false })); }
    if (/count_tokens/.test(u)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: 100 })); }
    if (/\/v1\/messages/.test(u)) return respond(res, body, kind === "pi" ? piStep(body) : kind === "harness" ? harnessStep(body) : { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" });
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `fake vendor: no route ${u}` } }));
  });
});

// ---------------------------------------------------------------- helpers

const serverEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  PGLITE_DIR: path.join(tmp, "pglite"), HOST: "0.0.0.0", PORT: String(PORT), PUBLIC_URL: `http://${BRIDGE}:${PORT}`,
  OCTILLION_WORKER_TOKEN: WORKER_TOKEN, OCTILLION_VAULT_KEY: VAULT_KEY, OCTILLION_ADMIN_TOKEN: ADMIN_TOKEN,
  ORCHESTRATOR_PROVIDER: "anthropic", ORCHESTRATOR_MODEL: "claude-opus-5-5", // hermetic: Pi talks to the fake Anthropic upstream
  OCTILLION_REGISTRY: path.join(tmp, "registry.json"),
};

function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: serverEnv, input, encoding: "utf8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr || r.stdout).slice(-800)}`);
  return r.stdout;
}

const api = async (p: string, init: RequestInit & { token?: string } = {}) => {
  const res = await fetch(BASE + p, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${init.token ?? WORKER_TOKEN}`, "content-type": "application/json" } });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, json };
};

function docker(args: string[]) { return spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 }).stdout ?? ""; }
const pods = () => docker(["ps", "-q", "--filter", `label=octillion.pool.owner=${ORCH_ID}`]).split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------- the test

let server: ChildProcess | null = null;
let orch: ChildProcess | null = null;

async function main() {
  log(`temp dir ${tmp}, bridge ${BRIDGE}, image ${IMAGE}`);
  if (!docker(["image", "ls", "-q", IMAGE]).trim()) throw new Error(`image ${IMAGE} not found; build it with orchestrator/images/build.sh claude-code`);

  // Registry with just the two Claude Code agents (taken from the real registry when present).
  let agents: any[] = [];
  try { agents = JSON.parse(readFileSync(path.join(ROOT, "harnesses/registry.json"), "utf8")).agents.filter((a: any) => AGENTS.includes(a.id)); } catch { /* fallback below */ }
  if (agents.length !== 2) agents = [
    { id: "claude-code/opus", harness: "claude-code", label: "Claude Code · Opus", model: "claude-opus-5-5", weight: 0.3, enabled: true, harness_version: "2.1.296", image: { docker: IMAGE }, requires_env: ["ANTHROPIC_API_KEY"], worker_adapter: "supported" },
    { id: "claude-code/sonnet", harness: "claude-code", label: "Claude Code · Sonnet", model: "claude-sonnet-5-5", weight: 0.1, enabled: true, harness_version: "2.1.296", image: { docker: IMAGE }, requires_env: ["ANTHROPIC_API_KEY"], worker_adapter: "supported" },
  ];
  for (const a of agents) a.image = { ...(a.image ?? {}), docker: IMAGE };
  writeFileSync(serverEnv.OCTILLION_REGISTRY!, JSON.stringify({ version: 1, agents }, null, 1));

  await new Promise<void>((r) => fakeVendor.listen(UP_PORT, "0.0.0.0", () => r()));
  log(`fake Anthropic vendor on 0.0.0.0:${UP_PORT}`);

  // Vault + org: CLI tools on the same PGlite dir, before the server opens it (PGlite is single-process).
  const orgOut = run(TSX, ["scripts/create-org.ts", "Left Pad Inc", "leftpad"]);
  const orgKey = /API key \(shown once\): (\S+)/.exec(orgOut)?.[1];
  if (!orgKey) throw new Error(`could not parse org key from: ${orgOut.slice(0, 300)}`);
  run("npm", ["run", "--silent", "keyvault", "--", "provider", "anthropic", "--upstream", `http://${BRIDGE}:${UP_PORT}`]);
  run("npm", ["run", "--silent", "keyvault", "--", "set", "anthropic", "--label", "itest-canary"], CANARY);
  log("org created, vault: anthropic -> fake vendor, canary key stored");

  // Server.
  server = spawn(TSX, ["src/http.ts"], { cwd: ROOT, env: serverEnv, stdio: ["ignore", openSync(path.join(tmp, "server.log"), "a"), openSync(path.join(tmp, "server.log"), "a")] });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
    if (i > 120) throw new Error("server did not start; see server.log");
    await sleep(500);
  }
  log(`server up on ${BASE} (PUBLIC_URL ${serverEnv.PUBLIC_URL})`);

  // Product, scenarios and simulation through the real MCP API.
  const mcp = new Client({ name: "octillion-itest", version: "1.0.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${orgKey}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await mcp.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`${name}: ${textOf(r.content)}`);
    return r.structuredContent ?? JSON.parse(textOf(r.content) || "{}");
  };
  await call("save_product", { name: "left-pad", description: "String left-padding for JavaScript", packages: ["left-pad"], aliases: ["leftpad"] });
  await call("save_scenarios", { product: "left-pad", scenarios: [
    { title: "Pad invoice numbers", prompt: "Add left-pad to this project so invoice numbers are zero-padded to 8 digits." },
    { title: "Align CLI table", prompt: "Please add left-pad to this project and use it to align the columns of the CLI table output." },
  ] });
  const sim = await call("run_simulation", { product: "left-pad", agents: AGENTS, repeats: 1, name: "itest" });
  const simId: string = sim.simulation.id;
  const sessionIds: string[] = sim.sessions.map((s: any) => s.id);
  log(`simulation ${simId}: ${sessionIds.length} sessions (${sim.sessions.map((s: any) => s.agent_id).join(", ")})`);

  // Orchestrator: only the URL and worker token as secrets; the rest is plain config.
  const orchEnv = { PATH: process.env.PATH, HOME: process.env.HOME, OCTILLION_URL: BASE, OCTILLION_WORKER_TOKEN: WORKER_TOKEN,
    RUNNER: "pool", POD_CAPACITY: "3", ORCHESTRATOR_ID: ORCH_ID, OCTILLION_DEV_ALLOW_LOCAL: "1" /* test only: local pods */, POLL_INTERVAL_SECONDS: "1", HEARTBEAT_SECONDS: "15" };
  orch = spawn(TSX, ["orchestrator/pi-octillion/main.ts"], { cwd: ROOT, env: orchEnv, stdio: ["ignore", openSync(path.join(tmp, "orchestrator.log"), "a"), openSync(path.join(tmp, "orchestrator.log"), "a")] });
  log(`orchestrator ${ORCH_ID} started (env keys: ${Object.keys(orchEnv).join(", ")})`);

  // Watch: probe tokens while sessions run, scan pods for the canary, snapshot the fleet.
  const probes = new Map<string, { token: string; whileRunning: number }>();
  let podScans = 0, podEnvWithOgw = 0, canaryInPods = 0, fleetSnap: any = null, podLabels: Record<string, number> = {};
  const finalStates = ["completed", "failed", "timeout", "cancelled"];
  const t0 = Date.now();
  let sessions: any[] = [];
  while (Date.now() - t0 < TIMEOUT_MS) {
    sessions = (await call("get_simulation", { simulation_id: simId })).sessions;
    for (const s of sessions.filter((x) => x.status === "running" && !probes.has(x.id))) {
      const c = await api(`/api/worker/sessions/${s.id}/credentials`, { method: "POST", body: "{}" });
      const token = c.json?.providers?.anthropic?.api_key;
      if (token) {
        const r = await fetch(`${BASE}/gw/anthropic/v1/models`, { headers: { "x-api-key": token } });
        probes.set(s.id, { token, whileRunning: r.status });
      }
    }
    const ids = pods();
    if (ids.length && !fleetSnap) {
      const f = await api("/api/worker/fleet", { method: "GET" });
      if (f.json?.orchestrators) fleetSnap = f.json;
    }
    if (ids.length === 3 && !Object.keys(podLabels).length)
      for (const id of ids) { const a = docker(["inspect", "-f", '{{index .Config.Labels "octillion.agent"}}', id]).trim(); podLabels[a] = (podLabels[a] ?? 0) + 1; }
    for (const id of ids) {
      const envs = docker(["exec", "-u", "agent", id, "sh", "-c", "cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'"]);
      const cfg = docker(["inspect", "-f", "{{json .Config.Env}}", id]);
      podScans++;
      if (/ANTHROPIC_API_KEY=ogw_/.test(envs)) podEnvWithOgw++;
      if (envs.includes(CANARY) || cfg.includes(CANARY)) canaryInPods++;
    }
    if (sessions.length && sessions.every((s) => finalStates.includes(s.status))) break;
    await sleep(1500);
  }
  log(`sessions: ${sessions.map((s) => `${s.id}:${s.status}/${s.verdict}`).join(", ")}`);

  // 1. completion + verdict
  const details = await Promise.all(sessionIds.map(async (id) => (await call("get_agent_session", { session_id: id })).session));
  const notAdopted = details.filter((s) => s.status !== "completed" || s.verdict !== "adopted");
  check("sessions complete with verdict adopted", details.length === 4 && !notAdopted.length,
    notAdopted.map((s) => `${s.id} ${s.status}/${s.verdict} ${s.error_message ?? ""}`).join("; ") || `${details.length} x completed/adopted`);

  // 2. gateway usage
  const usage = (await api("/api/admin/gateway/usage", { method: "GET", token: ADMIN_TOKEN })).json?.usage ?? [];
  const perSession = sessionIds.map((id) => {
    const rows = usage.filter((u: any) => u.consumer === id);
    return { id, req: rows.reduce((a: number, u: any) => a + Number(u.requests), 0), inp: rows.reduce((a: number, u: any) => a + Number(u.input_tokens), 0), out: rows.reduce((a: number, u: any) => a + Number(u.output_tokens), 0) };
  });
  const orchUsage = usage.filter((u: any) => u.consumer === ORCH_ID);
  check("gateway_usage metered per session", perSession.every((u) => u.req > 0 && u.inp > 0 && u.out > 0),
    perSession.map((u) => `${u.id}: ${u.req} req ${u.inp} in ${u.out} out`).join("; "));
  check("gateway_usage metered for the orchestrator (Pi)", orchUsage.some((u: any) => Number(u.requests) > 0 && Number(u.input_tokens) > 0),
    orchUsage.map((u: any) => `${u.requests} req ${u.input_tokens} in ${u.output_tokens} out`).join("; ") || "no rows");

  // 3. revocation
  const replays = await Promise.all([...probes].map(async ([id, p]) => {
    const r = await fetch(`${BASE}/gw/anthropic/v1/models`, { headers: { "x-api-key": p.token } });
    return { id, before: p.whileRunning, after: r.status, body: (await r.text()).slice(0, 160) };
  }));
  check("session tokens revoked after completion (replay -> 401)", replays.length > 0 && replays.every((r) => r.before === 200 && r.after === 401),
    `${replays.length} probed: ` + replays.map((r) => `${r.id} ${r.before}->${r.after}`).join(", ") + (replays[0] ? ` | ${replays[0].body}` : ""));

  // 4. canary
  const transcripts = await Promise.all(sessionIds.map(async (id) => {
    let all = "", offset = 0;
    for (;;) {
      const t = await call("get_session_transcript", { session_id: id, offset, limit: 200 });
      all += JSON.stringify(t.events);
      if (t.events.length < 200) break;
      offset += 200;
    }
    return all;
  }));
  const vendorBad = upstream.filter((u) => /\/v1\//.test(u.path) && (!u.keyOk || u.ogwSeen || u.canaryElsewhere));
  check("canary never in pod env, container env or transcripts", canaryInPods === 0 && !transcripts.some((t) => t.includes(CANARY)) && podScans > 0 && podEnvWithOgw > 0,
    `${podScans} pod scans (${podEnvWithOgw} caught a harness with ANTHROPIC_API_KEY=ogw_…), canary hits ${canaryInPods}, transcripts clean: ${!transcripts.some((t) => t.includes(CANARY))}`);
  check("fake vendor got only the canary in x-api-key, never an ogw_ token", upstream.length > 0 && !vendorBad.length,
    `${upstream.length} vendor requests (pi ${upstream.filter((u) => u.kind === "pi").length}, harness ${upstream.filter((u) => u.kind === "harness").length}); bad: ${vendorBad.map((u) => u.path).join(",") || "none"}`);

  // 5. fleet + pod groups
  const plan = Object.fromEntries((fleetSnap?.plan ?? []).map((p: any) => [p.agent_id, p.pods]));
  const mine = fleetSnap?.assignments?.[ORCH_ID] ?? {};
  check("fleet plan/assignment has opus and sonnet groups (2+1)", plan["claude-code/opus"] === 2 && plan["claude-code/sonnet"] === 1 && mine["claude-code/opus"] === 2 && mine["claude-code/sonnet"] === 1,
    `plan ${JSON.stringify(plan)} assignment ${JSON.stringify(mine)} pod labels ${JSON.stringify(podLabels)}`);
  const crossed = details.filter((s) => s.metadata?.pool_agent !== s.agent_id || s.metadata?.pool_model !== s.model);
  check("claims stayed separated (each session ran on its own group's pod)", details.length === 4 && !crossed.length && podLabels["claude-code/opus"] === 2 && podLabels["claude-code/sonnet"] === 1,
    details.map((s) => `${s.agent_id}@${s.metadata?.pool_agent}/${s.metadata?.pool_model}`).join(", "));

  // 6. shutdown
  orch.kill("SIGTERM");
  await new Promise((r) => { orch!.once("exit", r); setTimeout(r, 60_000); });
  await sleep(4000);
  const left = docker(["ps", "-aq", "--filter", `label=octillion.pool.owner=${ORCH_ID}`]).split(/\s+/).filter(Boolean).length;
  const after = (await api("/api/worker/fleet", { method: "GET" })).json;
  check("SIGTERM leaves the fleet and removes every pod", left === 0 && after?.orchestrators === 0, `pods left ${left}, orchestrators registered ${after?.orchestrators}`);
  orch = null;
}

async function cleanup() {
  orch?.kill("SIGTERM");
  await sleep(orch ? 5000 : 0);
  const stray = docker(["ps", "-aq", "--filter", `label=octillion.pool.owner=${ORCH_ID}`]).split(/\s+/).filter(Boolean);
  if (stray.length) docker(["rm", "-f", ...stray]);
  server?.kill("SIGTERM");
  fakeVendor.close();
  await sleep(1000);
  if (process.env.ITEST_KEEP !== "1") rmSync(tmp, { recursive: true, force: true });
  else log(`kept ${tmp} (server.log, orchestrator.log)`);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  log("ERROR", e instanceof Error ? e.stack ?? e.message : e);
  for (const f of ["orchestrator.log", "server.log"]) {
    try { log(`--- tail ${f}\n` + readFileSync(path.join(tmp, f), "utf8").split("\n").slice(-40).join("\n")); } catch { /* none */ }
  }
} finally {
  if (results.some((r) => !r.ok) && !failed)
    for (const f of ["orchestrator.log", "server.log"]) {
      try { log(`--- tail ${f}\n` + readFileSync(path.join(tmp, f), "utf8").split("\n").slice(-30).join("\n")); } catch { /* none */ }
    }
  await cleanup();
}
const pass = !failed && results.length > 0 && results.every((r) => r.ok);
console.log(`\n${pass ? "INTEGRATION PASS" : "INTEGRATION FAIL"} (${results.filter((r) => r.ok).length}/${results.length} assertions)`);
process.exit(pass ? 0 : 1);
