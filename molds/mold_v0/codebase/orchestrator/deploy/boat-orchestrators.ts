/**
 * Manual launcher for the orchestrators (the server's autoscaler, src/autoscaler.ts, normally does this on
 * demand). Orchestrators run ONLY inside boat.dev sandboxes and create their worker sandboxes from there. Run from
 * the main VM or a laptop; needs only APP_URL + APP_WORKER_TOKEN (the boat key comes from the broker).
 *
 *   npm run boat-orchestrators -- budget [n]                 plan limits vs n orchestrators x (1 + POD_CAPACITY)
 *   npm run boat-orchestrators -- up <n> [--skip-preflight]  ensure n orchestrator sandboxes exist and run
 *   npm run boat-orchestrators -- status                     sandboxes, uptime, TTL left, fleet check-in, workers
 *   npm run boat-orchestrators -- logs <sandbox-id> [lines]  orchestrator journal (secrets redacted)
 *   npm run boat-orchestrators -- renew                      reset every orchestrator's TTL to the maximum
 *   npm run boat-orchestrators -- update                     redeploy code to every orchestrator, restart gracefully
 *   npm run boat-orchestrators -- down <sandbox-id>|--all    graceful stop (leaves the fleet, deletes its workers), delete
 *   npm run boat-orchestrators -- image                      build the named snapshot image for the current code
 *   npm run boat-orchestrators -- selftest                   live check: boot one orchestrator sandbox, guard, preflight,
 *                                                            nested worker create/delete, tear down, verify nothing left
 * The shared logic lives in deploy/boat-lib.ts.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOAT, CFG } from "../core/config.js";
import { boatApi } from "../core/boat.js";
import { api, sleep } from "../core/util.js";
import * as lib from "./boat-lib.js";
import { ENV } from "../core/env-names.js";

export { computeBudget, TUNING_VARS, ORCH_PREFIX, WORKER_PREFIX, MAX_TTL_SECONDS } from "./boat-lib.js";
export type { Budget, BoatLimits } from "./boat-lib.js";

const POD_CAPACITY = Math.max(1, Math.min(20, Number(process.env.POD_CAPACITY ?? 20)));
const secrets = () => [CFG.token, BOAT.apiKey].filter((s) => s && s.length > 6);
const redact = (s: string) => secrets().reduce((a, k) => a.split(k).join("***"), s).replace(/\b(ogw_|boat_|oct_)[A-Za-z0-9-]{16,}/g, "$1***");
const out = (...a: unknown[]) => console.log(redact(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 1))).join(" ")));

const ctx = (placeholderToken = false): lib.LaunchContext => ({
  url: CFG.url, workerToken: CFG.token, podCapacity: POD_CAPACITY, placeholderToken, log: (m) => out(m),
  tuning: Object.fromEntries(lib.TUNING_VARS.filter((k) => ENV[k]).map((k) => [k, ENV[k]!])),
});

function printBudget(b: lib.Budget, l: lib.BoatLimits) {
  out(`boat plan: ${b.plan} concurrent sandboxes, starts ${l.startsPerMinute}/min ${l.startsPerHour}/h ${l.startsPerDay}/day; active now ${l.activeNow} (${b.otherActive} not ours)`);
  out(`per orchestrator: 1 orchestrator sandbox + ${b.perOrchestrator - 1} worker sandboxes = ${b.perOrchestrator}; max orchestrators: ${b.maxOrchestrators}`);
  out(`requested ${b.requested} -> ${b.requestedSandboxes} sandboxes of ${b.available} available: ${b.ok ? "OK" : "REFUSED"}`);
  out(`throughput ceiling: ~${b.sessionsPerDayCeiling} agent sessions/day (each session = 1 fresh worker sandbox = 1 boat start; plan ${b.startsPerDay} starts/day)`);
}

async function boatKey(): Promise<void> {
  if (!CFG.token) throw new Error("APP_WORKER_TOKEN is required");
  const r = (await api("/api/worker/orchestrator/credentials", { json: { orchestrator_id: "launcher" } })) as { boat?: { api_key?: string } | null };
  if (!r?.boat?.api_key) throw new Error("the credential broker returned no boat key (store one: npm run keyvault -- set boat)");
  BOAT.apiKey = r.boat.api_key;
}

const orchestrators = async () => (await lib.listSandboxes()).filter((s) => s.name?.startsWith(lib.ORCH_PREFIX) && lib.isLive(s));
const workersOf = (all: lib.Sb[], orchId: string) => all.filter((s) => s.name?.startsWith(lib.workerPrefixOf(orchId)) && lib.isLive(s));

async function currentImage(): Promise<string | null> {
  const name = lib.imageName(lib.codeHash());
  return (await lib.imageStatus(name)) === "ready" ? name : null;
}

async function cmdUp(n: number, skipPreflight: boolean) {
  const existing = await orchestrators();
  const all = await lib.listSandboxes();
  const ours = all.filter((s) => (s.name?.startsWith(lib.ORCH_PREFIX) || s.name?.startsWith(lib.WORKER_PREFIX)) && lib.isLive(s)).length;
  const limits = await lib.boatLimits();
  const b = lib.computeBudget(limits, n, POD_CAPACITY, ours);
  printBudget(b, limits);
  if (!b.ok) throw new Error(`refusing: ${b.reason}`);
  out(`${existing.length} orchestrator sandbox(es) exist; target ${n}`);
  const image = await currentImage();
  for (let i = existing.length; i < n; i++) {
    const r = await lib.launchOrchestrator(ctx(), { image, requirePreflight: !skipPreflight });
    out(`${r.sandboxId} (${r.orchId}) started${r.fromImage ? " from image" : ""}; preflight ${r.preflight.ok ? "OK" : `SKIPPED (${r.preflight.reason})`}; timings ${JSON.stringify(r.timings)}`);
  }
  if (existing.length > n) out(`note: ${existing.length - n} more orchestrator(s) than requested; use \`down <id>\` to remove`);
}

async function cmdStatus() {
  const all = await lib.listSandboxes();
  const orchs = all.filter((s) => s.name?.startsWith(lib.ORCH_PREFIX) && lib.isLive(s));
  const fleet = (await api("/api/worker/fleet", { method: "GET" }).catch(() => null)) as any;
  out(`fleet: ${fleet?.orchestrators ?? "?"} orchestrator(s) checked in, ${fleet?.total_pods ?? "?"} worker slots planned, queue ${JSON.stringify(fleet?.queue ?? {})}`);
  for (const s of orchs) {
    const orchId = lib.orchIdOf(s.id);
    const svc = await lib.run(s.id, `${lib.LEGACY_UNIT_SH}; systemctl is-active $u; systemctl show $u -p ActiveEnterTimestamp --value`, 30).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    const [active, since] = svc.stdout.trim().split("\n");
    const ttlLeft = s.archiveAfter ? Math.round((Date.parse(s.archiveAfter) - Date.now()) / 3600_000) : null;
    out(`${s.id} ${orchId} state=${s.state} service=${active ?? "?"} since=${since ?? "?"} up=${s.createdAt ? Math.round((Date.now() - Date.parse(s.createdAt)) / 3600_000) : "?"}h ttl_left=${ttlLeft ?? "none"}h ` +
      `fleet=${fleet?.assignments?.[orchId] ? JSON.stringify(fleet.assignments[orchId]) : "not checked in"} workers=${workersOf(all, orchId).length}`);
  }
  if (!orchs.length) out("no orchestrator sandboxes");
}

async function cmdLogs(id: string, lines = 200) {
  const r = await lib.run(id, `${lib.LEGACY_UNIT_SH}; journalctl -u $u -n ${lines} --no-pager 2>&1 | tail -n ${lines}`, 60);
  out(r.stdout || r.stderr);
}

async function cmdRenew() {
  for (const s of await orchestrators()) {
    await boatApi(`/sandboxes/${s.id}`, { method: "PATCH", json: { ttlSeconds: lib.MAX_TTL_SECONDS } });
    const after = (await boatApi(`/sandboxes/${s.id}`)).sandbox.archiveAfter;
    out(`${s.id}: archiveAfter ${s.archiveAfter ?? "none"} -> ${after ?? "none"}`);
  }
}

async function cmdUpdate() {
  for (const s of await orchestrators()) {
    const bytes = await lib.uploadCode(s.id);
    await lib.configure(s.id, lib.orchIdOf(s.id), ctx());
    const r = await lib.run(s.id, `sudo systemctl restart ${lib.UNIT} && sleep 3 && systemctl is-active ${lib.UNIT}`, 300);
    out(`${s.id}: redeployed ${bytes} bytes, service ${r.stdout.trim()}`);
  }
}

async function cmdDown(target: string) {
  const orchs = await orchestrators();
  const victims = target === "--all" ? orchs : orchs.filter((s) => s.id === target);
  if (!victims.length) throw new Error(target === "--all" ? "no orchestrator sandboxes" : `no orchestrator sandbox ${target}`);
  for (const s of victims) {
    const svc = await lib.stopService(s.id);
    const left = workersOf(await lib.listSandboxes(), lib.orchIdOf(s.id));
    for (const w of left) await lib.deleteSandbox(w.id);
    await lib.deleteSandbox(s.id);
    out(`${s.id}: service ${svc}, ${left.length} leftover worker(s) deleted, sandbox deleted`);
  }
}

/** Live selftest: everything created here is deleted here, then the listing is checked. */
async function cmdSelftest() {
  const created: string[] = [];
  const evidence: Record<string, unknown> = {};
  try {
    const limits = await lib.boatLimits();
    printBudget(lib.computeBudget(limits, 1, POD_CAPACITY), limits);
    const c = await lib.launchOrchestrator(ctx(true), {
      image: await currentImage(), ttlSeconds: 1200, requirePreflight: false,
      onCreated: (id) => { created.push(id); },
    }).catch(async (e) => { throw e; });
    evidence.orchestrator_sandbox = c.sandboxId;
    evidence.timings = c.timings;
    // selftest: the service was started with a placeholder token; stop it before poking around
    await lib.stopService(c.sandboxId);
    evidence.guard = await lib.guard(c.sandboxId);
    out("guard inside the sandbox:", evidence.guard);
    evidence.preflight = c.preflight;
    out(`preflight: ${c.preflight.ok ? "reachable" : c.preflight.reason}`);
    await lib.put(c.sandboxId, `${lib.HOME}/selftest-boat.key`, BOAT.apiKey);
    await lib.run(c.sandboxId, `chmod 600 ${lib.HOME}/selftest-boat.key`, 30);
    const nested = await lib.run(c.sandboxId, `cd ${lib.HOME}/app/orchestrator && node_modules/.bin/tsx deploy/in-sandbox.ts nested ${lib.HOME}/selftest-boat.key; rm -f ${lib.HOME}/selftest-boat.key`, 300);
    try { evidence.nested = JSON.parse(nested.stdout.trim().split("\n").pop()!); } catch { evidence.nested = { raw: (nested.stdout + nested.stderr).slice(-500) }; }
    out("nested worker sandbox from inside the orchestrator sandbox:", evidence.nested);
    const w = (evidence.nested as any)?.worker_sandbox;
    if (w) created.push(w);
  } finally {
    for (const id of created) await lib.deleteSandbox(id).catch((e) => out(`delete ${id}: ${String(e)}`));
    await sleep(5000);
    const after = await lib.listSandboxes();
    const ours = after.filter((s) => lib.isLive(s) && (created.includes(s.id) || s.name?.startsWith(lib.ORCH_PREFIX) || s.name?.startsWith(lib.WORKER_PREFIX)));
    evidence.final_listing = { total: after.length, ours: ours.map((s) => `${s.id}:${s.state}`) };
    out("final GET /sandboxes:", evidence.final_listing);
  }
  return evidence;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  (async () => {
    const cmds = ["budget", "up", "status", "logs", "renew", "update", "down", "image", "selftest"];
    if (!cmds.includes(cmd ?? "")) {
      console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith(" *   npm run")).join("\n"));
      process.exit(2);
    }
    await boatKey();
    if (cmd === "budget") { const l = await lib.boatLimits(); printBudget(lib.computeBudget(l, Number(a ?? 1), POD_CAPACITY), l); }
    if (cmd === "up") await cmdUp(Number(a ?? 1), process.argv.includes("--skip-preflight"));
    if (cmd === "status") await cmdStatus();
    if (cmd === "logs") await cmdLogs(a!, Number(b ?? 200));
    if (cmd === "renew") await cmdRenew();
    if (cmd === "update") await cmdUpdate();
    if (cmd === "down") await cmdDown(a ?? "");
    if (cmd === "image") out(await lib.buildImage({ log: (m) => out(m) }));
    if (cmd === "selftest") await cmdSelftest();
  })().catch((e) => { console.error(redact(String(e instanceof Error ? e.message : e))); process.exit(1); });
}
