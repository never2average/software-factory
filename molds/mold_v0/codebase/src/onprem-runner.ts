/**
 * The on-premises runner (mold_v0-036; src/onprem-runners.ts, docs/on-premises-runner.md): a small program a customer
 * runs inside their own network, from the app's own image, with one command. It connects OUT to the app only (it
 * listens on no port and needs no inbound rule), enrolls once with the one-time token an owner of the workspace created
 * in the console, then polls for that workspace's runs that need its private network and carries each out in a run
 * sandbox of its own: a container of this same image, started exactly as a hosted server starts one
 * (src/run-container.ts: no socket, no mount, capabilities dropped but the runner's, no new privileges, limits, a
 * deadline), whose runner (src/run-sandbox-runner.ts) locks the run's user down to the run's egress, plus the private
 * hosts and networks this runner's owner allows, and streams events and results back to the app, outbound too.
 *
 *   node --import tsx src/onprem-runner.ts           run (enroll on first start, then poll until stopped or revoked)
 *   node --import tsx src/onprem-runner.ts --check   check the settings, the app's address and Docker, and exit
 *
 * Settings (environment):
 *   APP_RUNNER_URL          the app's address (https://...; http only with APP_RUNNER_ALLOW_HTTP=yes, for tests)
 *   APP_RUNNER_TOKEN        the one-time enrollment token (ore_...), first start only: the credential the app hands back
 *                           is kept in APP_RUNNER_STATE_DIR (default /var/lib/app-runner, 0600, root's) for restarts
 *   APP_RUNNER_ALLOW        the private hosts and networks runs may reach (orchestrator/core/egress.ts
 *                           parsePrivateAllow): `vault.corp.example *.corp.example:443|8443 10.20.0.0/16:6443`. Only
 *                           runs of kinds that need the private network get them. Empty: no private host at all.
 *   APP_RUNNER_CAPACITY     runs at once (2)
 *   APP_RUNNER_NAME         a name for this machine in the console (its host name)
 *   APP_RUNNER_ISOLATION    docker (default: a container per run, through APP_DOCKER_SOCKET); process (no sandbox:
 *                           refused unless APP_ALLOW_UNSANDBOXED_RUNS=yes, tests only)
 *   APP_RUNNER_IMAGE        the run containers' image (default: this container's own)
 *   APP_RUNNER_NETWORK      their Docker network (default: bridge)
 *
 * Exit codes: 0 stopped (SIGTERM), 2 bad settings or an enrollment refused, 3 revoked in the console (its run
 * sandboxes are removed and its credential deleted first).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrivateAllow, privateAllowText, type PrivateAllow } from "../orchestrator/core/egress.js";
import { dockerApi, runContainerBody } from "./run-container.js";
import { ENV } from "./env-names.js";
import { NS } from "./namespace.js";

const env = ENV;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const log = (m: string) => console.error(`runner: ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LABEL = `org.${NS}.onprem-runner`, ROW_LABEL = `org.${NS}.run-sandbox-row`;

export interface RunnerSettings {
  url: string; token: string | null; stateDir: string; allow: PrivateAllow[]; allowText: string; capacity: number; name: string;
  isolation: "docker" | "process"; image: string; network: string; socket: string; wait: number;
}

/** The settings from the environment, checked; throws with what is wrong. */
export function runnerSettings(e: Record<string, string | undefined> = env): RunnerSettings {
  const url = String(e.APP_RUNNER_URL ?? "").replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("APP_RUNNER_URL: the app's address, like https://app.example.com"); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && e.APP_RUNNER_ALLOW_HTTP === "yes")) throw new Error("APP_RUNNER_URL must be https://");
  const isolation = (e.APP_RUNNER_ISOLATION || "docker").toLowerCase();
  if (isolation !== "docker" && isolation !== "process") throw new Error("APP_RUNNER_ISOLATION: docker or process");
  if (isolation === "process" && e.APP_ALLOW_UNSANDBOXED_RUNS !== "yes") throw new Error("APP_RUNNER_ISOLATION=process runs runs with no sandbox: refused unless APP_ALLOW_UNSANDBOXED_RUNS=yes (tests only)");
  const allow = parsePrivateAllow(e.APP_RUNNER_ALLOW);
  const capacity = Number(e.APP_RUNNER_CAPACITY ?? 2);
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 8) throw new Error("APP_RUNNER_CAPACITY: 1 to 8 runs at once");
  const token = (e.APP_RUNNER_TOKEN ?? "").trim() || null;
  if (token && !/^ore_[A-Za-z0-9_-]{20,100}$/.test(token)) throw new Error("APP_RUNNER_TOKEN: the enrollment token from the console (ore_...)");
  return {
    url, token, stateDir: e.APP_RUNNER_STATE_DIR || "/var/lib/app-runner", allow, allowText: privateAllowText(allow).join(" "), capacity,
    name: (e.APP_RUNNER_NAME || hostname()).slice(0, 120), isolation, image: e.APP_RUNNER_IMAGE || "", network: e.APP_RUNNER_NETWORK || "bridge",
    socket: e.APP_DOCKER_SOCKET || "/var/run/docker.sock", wait: Math.max(0, Math.min(20, Number(e.APP_RUNNER_WAIT_SECONDS ?? 20) || 0)),
  };
}

/** The kinds this image can carry out ("pack/kind"): the app hands it no other. */
async function imageKinds(): Promise<string[]> {
  const { jobKinds } = await import("./runs.js");
  return jobKinds().map((k) => `${k.pack}/${k.name}`);
}

interface Local { row: number; id: string; live: boolean; state: string }
interface Isolation {
  readonly name: "docker" | "process";
  check(): Promise<void>;
  start(a: { row: number; name: string; env: Record<string, string>; ttl_seconds: number }): Promise<string>;
  list(): Promise<Local[]>;
  remove(id: string): Promise<void>;
}

/** A container per run on this machine's Docker, exactly as a hosted server's (src/run-container.ts). */
function dockerIsolation(s: RunnerSettings, runnerId: () => string): Isolation {
  let image = s.image;
  const call = (m: string, p: string, b?: unknown) => dockerApi(s.socket, m, p, b);
  return {
    name: "docker",
    async check() {
      if (!existsSync(s.socket)) throw new Error(`no Docker socket at ${s.socket}: mount it (-v /var/run/docker.sock:/var/run/docker.sock)`);
      const ping = await call("GET", "/_ping");
      if (ping.status !== 200) throw new Error(`Docker does not answer (${ping.status})`);
      if (!image) {
        const self = await call("GET", `/containers/${encodeURIComponent(hostname())}/json`);
        if (self.status !== 200) throw new Error("this runner is not in a container Docker knows: set APP_RUNNER_IMAGE");
        image = String(self.json?.Image ?? "");
      }
      if (!image) throw new Error("no image for run containers: set APP_RUNNER_IMAGE");
    },
    async start(a) {
      const c = await call("POST", `/containers/create?name=${encodeURIComponent(`${NS}-onprem-${a.name}`)}`, runContainerBody({
        image, network: s.network, env: a.env, ttlSeconds: a.ttl_seconds,
        labels: { [LABEL]: runnerId(), [ROW_LABEL]: String(a.row), [`org.${NS}.run-id`]: a.env.APP_RUN_ID ?? "" },
      }));
      if (c.status !== 201) throw Object.assign(new Error(`docker create: ${c.status} ${c.json?.message ?? ""}`), { step: "create" });
      const id = String(c.json.Id);
      const st = await call("POST", `/containers/${id}/start`);
      if (st.status !== 204 && st.status !== 304) {
        await call("DELETE", `/containers/${id}?force=true&v=true`).catch(() => {});
        throw Object.assign(new Error(`docker start: ${st.status} ${st.json?.message ?? ""}`), { step: "start" });
      }
      return id;
    },
    async list() {
      const r = await call("GET", `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`${LABEL}=${runnerId()}`] }))}`);
      if (r.status !== 200) throw new Error(`docker list: ${r.status}`);
      return (r.json ?? []).map((c: any) => ({ row: Number(c.Labels?.[ROW_LABEL] ?? 0), id: String(c.Id), state: String(c.State),
        live: ["created", "running", "restarting"].includes(String(c.State)) }));
    },
    async remove(id) {
      const r = await call("DELETE", `/containers/${encodeURIComponent(id)}?force=true&v=true`);
      if (r.status !== 204 && r.status !== 404) throw new Error(`docker remove: ${r.status} ${r.json?.message ?? ""}`);
    },
  };
}

/** No sandbox at all: the run sandbox's runner as a child process with the lockdown off. Tests only. */
function processIsolation(): Isolation {
  const kids = new Map<string, { child: ChildProcess; row: number }>();
  return {
    name: "process",
    async check() { /* nothing to reach */ },
    async start(a) {
      const id = `proc-${randomBytes(4).toString("hex")}`;
      const child = spawn(process.execPath, ["--import", "tsx", "src/run-sandbox-runner.ts"], { cwd: ROOT, detached: true, stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: env.PATH ?? "/usr/bin:/bin", ...a.env, APP_RUN_LOCKDOWN: "off", APP_ALLOW_UNSANDBOXED_RUNS: "yes", APP_RUN_SAME_USER: "yes" } });
      child.stderr?.on("data", (d) => { if (env.APP_RUNNER_DEBUG) process.stderr.write(`[${id}] ${d}`); });
      kids.set(id, { child, row: a.row });
      return id;
    },
    async list() {
      return [...kids].map(([id, k]) => ({ row: k.row, id, live: k.child.exitCode === null && k.child.signalCode === null, state: k.child.exitCode === null ? "running" : "exited" }));
    },
    async remove(id) {
      const k = kids.get(id);
      if (k?.child.pid && k.child.exitCode === null) { try { process.kill(-k.child.pid, "SIGKILL"); } catch { /* gone */ } }
      kids.delete(id);
    },
  };
}

class HttpError extends Error { constructor(public status: number, public body: any) { super(`${status} ${body?.error ?? ""}`.trim()); } }
async function post(s: RunnerSettings, p: string, auth: string, body: unknown, timeoutMs = 60_000): Promise<any> {
  const res = await fetch(`${s.url}${p}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", "user-agent": `${NS}-onprem-runner` }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, json);
  return json;
}

const credFile = (s: RunnerSettings) => path.join(s.stateDir, "credential.json");
function loadCredential(s: RunnerSettings): { runner_id: string; credential: string; url: string } | null {
  try {
    const c = JSON.parse(readFileSync(credFile(s), "utf8"));
    // A credential is for the app it was enrolled with: another address enrolls again.
    return typeof c?.credential === "string" && c.url === s.url ? c : null;
  } catch { return null; }
}
function saveCredential(s: RunnerSettings, c: { runner_id: string; credential: string }) {
  mkdirSync(s.stateDir, { recursive: true, mode: 0o700 });
  const f = credFile(s);
  writeFileSync(`${f}.new`, JSON.stringify({ ...c, url: s.url }), { mode: 0o600 });
  chmodSync(`${f}.new`, 0o600);
  renameSync(`${f}.new`, f);
}

export interface RunnerHandle { stop(): Promise<void>; done: Promise<number>; runnerId(): string }

/**
 * The runner's loop: enroll (once), then poll and carry out what it is given until stopped or revoked. Resolves `done`
 * with the exit code. `s` from runnerSettings(); `isolation` replaced in tests.
 */
export function startRunner(s: RunnerSettings, opts: { isolation?: Isolation; version?: string } = {}): RunnerHandle {
  let runnerId = "", stopping = false, wake: (() => void) | null = null;
  const iso = opts.isolation ?? (s.isolation === "process" ? processIsolation() : dockerIsolation(s, () => runnerId));
  const version = opts.version ?? (() => { try { return String(JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "0"); } catch { return "0"; } })();
  const started: { row: number; sandbox_id: string }[] = [], failed: { row: number; step: string; error: string }[] = [];
  const done = (async (): Promise<number> => {
    await iso.check();
    const kinds = await imageKinds();
    const info = { version, hostname: s.name, capacity: s.capacity, isolation: iso.name, allow: privateAllowText(s.allow), kinds };
    let cred = loadCredential(s);
    if (!cred) {
      if (!s.token) { log("not enrolled: set APP_RUNNER_TOKEN to the enrollment token from the console"); return 2; }
      try {
        const out = await post(s, "/api/runner/enroll", s.token, info);
        cred = { runner_id: out.runner_id, credential: out.credential, url: s.url };
        saveCredential(s, cred);
        log(`enrolled as ${out.name} (${out.runner_id}); the enrollment token is used up`);
      } catch (e) {
        log(`enrollment refused: ${(e as Error).message}`);
        return 2;
      }
    }
    runnerId = cred.runner_id;
    log(`polling ${s.url} as ${runnerId}: up to ${s.capacity} runs at once, ${iso.name} isolation, private allow list: ${privateAllowText(s.allow).join(" ") || "(none)"}`);
    let backoff = 1000;
    while (!stopping) {
      try {
        const local = await iso.list();
        const body = { ...info, sandboxes: local.filter((l) => l.row > 0).map((l) => ({ row: l.row, sandbox_id: l.id, live: l.live, state: l.state })),
          started: started.splice(0), failed: failed.splice(0) };
        let ans: any;
        try { ans = await post(s, `/api/runner/poll?wait=${s.wait}`, cred.credential, body, (s.wait + 30) * 1000); }
        catch (e) { started.unshift(...body.started); failed.unshift(...body.failed); throw e; }
        // What the app no longer counts: removed (finished, revoked, moved, or left from before a restart).
        const keep = new Set<number>((ans.keep ?? []).map(Number));
        for (const l of local) if (!keep.has(l.row) || (ans.remove ?? []).includes(l.row)) await iso.remove(l.id).catch((e) => log(`remove ${l.id}: ${(e as Error).message}`));
        for (const a of ans.assign ?? []) {
          // The run sandbox reaches the app at the address this runner uses, and gets this runner's private allow list.
          const runEnv = { ...a.env, APP_URL: s.url, ...(s.allow.length ? { APP_RUN_PRIVATE_ALLOW: s.allowText } : {}) };
          try {
            const id = await iso.start({ row: Number(a.row), name: String(a.name), env: runEnv, ttl_seconds: Number(a.ttl_seconds) });
            started.push({ row: Number(a.row), sandbox_id: id });
            log(`run ${a.run_id}: run sandbox ${id.slice(0, 12)} started`);
          } catch (e) {
            failed.push({ row: Number(a.row), step: String((e as { step?: string }).step ?? "start"), error: String((e as Error).message).slice(0, 400) });
            log(`run ${a.run_id}: could not start its run sandbox: ${(e as Error).message}`);
          }
        }
        backoff = 1000;
        // A long poll waited at the app already: a short pause only, so nothing ever spins.
        const pause = s.wait ? 500 : Math.max(1, Number(ans.poll_seconds ?? 5)) * 1000;
        if (!stopping) await new Promise<void>((r) => { wake = r; setTimeout(r, pause); });
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) {
          if (e.body?.revoked) {
            log("this runner was revoked in the console: removing its run sandboxes and its credential, and stopping");
            for (const l of await iso.list().catch(() => [] as Local[])) await iso.remove(l.id).catch(() => {});
            rmSync(credFile(s), { force: true });
            return 3;
          }
          log(`the app does not know this runner's credential (${e.message}): enroll again with a new token`);
          return 2;
        }
        log(`poll failed: ${(e as Error).message} (again in ${Math.round(backoff / 1000)} s)`);
        await new Promise<void>((r) => { wake = r; setTimeout(r, backoff); });
        backoff = Math.min(60_000, backoff * 2);
      }
    }
    return 0;
  })();
  return {
    runnerId: () => runnerId,
    done,
    // Its run sandboxes keep running: the app tears down what they leave when this runner (or another) polls again.
    async stop() { stopping = true; (wake as (() => void) | null)?.(); await done.catch(() => 1); },
  };
}

async function check(s: RunnerSettings): Promise<number> {
  console.log(`app address: ${s.url}`);
  console.log(`private allow list: ${s.allowText || "(none)"}`);
  console.log(`isolation: ${s.isolation}, capacity ${s.capacity}`);
  try {
    const r = await fetch(`${s.url}/healthz`, { signal: AbortSignal.timeout(15_000) });
    console.log(`the app answers: ${r.status}`);
  } catch (e) { console.log(`the app does not answer: ${(e as Error).message}`); return 1; }
  if (s.isolation === "docker") {
    try { await dockerIsolation(s, () => "check").check(); console.log("Docker: ok"); }
    catch (e) { console.log(`Docker: ${(e as Error).message}`); return 1; }
  }
  console.log(loadCredential(s) ? "enrolled: yes" : s.token ? "enrolled: not yet (the token is used at the first start)" : "enrolled: no, and no APP_RUNNER_TOKEN");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let s: RunnerSettings;
  try { s = runnerSettings(); } catch (e) { log((e as Error).message); process.exit(2); }
  if (process.argv.includes("--check")) check(s).then((c) => process.exit(c), (e) => { log(String((e as Error).message)); process.exit(1); });
  else {
    const h = startRunner(s);
    process.on("SIGTERM", () => void h.stop());
    process.on("SIGINT", () => void h.stop());
    h.done.then((code) => process.exit(code), (e) => { log(`failed: ${(e as Error).message}`); process.exit(1); });
  }
}
