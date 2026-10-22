/**
 * Runs in sandboxes (mold_v0-055; molds/mold_v0/MOLD.md "Runs in sandboxes"). The autoscaler (src/autoscaler.ts, and on
 * a server of its own the compose project's runner service, src/run-fleet.ts) launches one sandbox per queued run:
 *
 *   demand     the queued runs a claim would take now (src/runs.ts claimableRuns: the kind's concurrency per workspace,
 *              the platform's ceiling, one writer per workspace store), reported per kind
 *   launch     a row in run_sandboxes, a worker token bound to that run and that sandbox (src/workerauth.ts), and a
 *              sandbox from the provider with the runner (src/run-sandbox-runner.ts) and only that token. At most
 *              OCTILLION_MAX_RUN_SANDBOXES at once, OCTILLION_RUN_LAUNCHES_PER_TICK a tick, within the provider plan's
 *              free sandboxes; a sandbox lives at most the run's token lifetime and a margin (the provider's TTL)
 *   claim      the runner claims its run, once (claimForSandbox): the run's worker is "sbx-<row>"
 *   run        the runner locks the run's user down to the run's egress (firewall + proxy) and carries the run out
 *   teardown   the sandbox goes when its attempt ends: at once when the runner completes (sandboxDone), else at the next
 *              tick (the run ended, was taken elsewhere, its attempt lapsed and was queued again, the sandbox died, it
 *              never claimed within OCTILLION_RUN_BOOT_MINUTES, or it is past the run's deadline). Orphans (ours by
 *              name or label, with no row) are deleted. The token is revoked with it.
 *   failures   a run whose sandbox fails to start is tried again after a back-off, and fails (infrastructure) after
 *              OCTILLION_RUN_LAUNCH_ATTEMPTS failed starts: nothing launches forever
 *
 * Providers: "boat" (the sandbox provider the product already uses for its orchestrators, with its key in the vault),
 * "docker" (a container per run on the server's own Docker, from the runner service only: it holds the Docker socket,
 * the app does not), and "process" (no sandbox at all: refused unless OCTILLION_ALLOW_UNSANDBOXED_RUNS=yes, for tests).
 * OCTILLION_RUN_SANDBOX picks one (auto: boat when its key is in the vault, else docker when this process has the
 * socket, else none); "off" launches nothing. With no provider no run is ever carried out unsandboxed: queued runs wait,
 * each with a `waiting` event that says why.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { claimableRuns, claimRun, failUnlaunchedRun, findKind, noteRunsWaiting, queuedRunsByKind, sweepRuns, type Claim, type ClaimableRun } from "./runs.js";
import { mintRunWorkerToken, revokeRunSandboxTokens } from "./workerauth.js";
import { recordComputeEvent } from "./compute-events.js";
import { keepAlive } from "./telemetry.js";

const env = process.env;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
/** The run's user in a sandbox (the image creates it; a boat sandbox's launch creates it). */
export const RUN_USER = "octirun";

export const RUN_SANDBOXES = {
  mode: () => (env.OCTILLION_RUN_SANDBOX ?? "auto").toLowerCase(),
  maxSandboxes: () => Math.max(0, num(env.OCTILLION_MAX_RUN_SANDBOXES, 10)),
  launchesPerTick: () => Math.max(1, num(env.OCTILLION_RUN_LAUNCHES_PER_TICK, 4)),
  bootMinutes: () => Math.max(1, num(env.OCTILLION_RUN_BOOT_MINUTES, 10)),
  launchAttempts: () => Math.max(1, num(env.OCTILLION_RUN_LAUNCH_ATTEMPTS, 3)),
  backoffSeconds: () => Math.max(0, num(env.OCTILLION_RUN_LAUNCH_BACKOFF_SECONDS, 30)),
  unsandboxedAllowed: () => env.OCTILLION_ALLOW_UNSANDBOXED_RUNS === "yes",
};
export const sandboxWorkerId = (rowId: number) => `sbx-${rowId}`;
/** What a boat run sandbox gets besides the runner's code (mold_v0-072): the run tools' installer and the build's list. */
export const RUN_TOOL_INSTALL_FILES = ["scripts/install-run-tools.ts", "src/run-tools.generated.json"];

// ---------- providers ----------

export interface RunSandboxSpec {
  rowId: number; runId: string; name: string;
  /** The runner's environment: the API, the run-bound token, the run user, the pack directory, lockdown on. */
  env: Record<string, string>;
  /** The provider's own limit on the sandbox's life (a TTL), in seconds. */
  ttlSeconds: number;
  /** Pack directories (relative to the code) the sandbox needs. */
  packDirs: string[];
  log: (m: string) => void;
}
export interface ListedSandbox { id: string; name: string; live: boolean; state: string }
export interface RunSandboxProvider {
  readonly name: "boat" | "docker" | "process";
  /** Where the sandbox's runner reaches the API. */
  apiUrl(): string;
  /** Sandboxes the provider's plan still has room for (null: no plan limit here). */
  free(): Promise<number | null>;
  /** Create, configure and start the runner; `onCreated` records the sandbox id before anything else can fail. */
  launch(spec: RunSandboxSpec, onCreated: (sandboxId: string) => Promise<void>): Promise<{ sandboxId: string }>;
  /** This deployment's run sandboxes (by name prefix or label), live or not. */
  list(): Promise<ListedSandbox[]>;
  remove(id: string): Promise<void>;
}

/** What a launch step threw, with the step (the Compute page's launch failures). */
const stepError = (step: string, e: unknown) => Object.assign(e instanceof Error ? e : new Error(String(e)), { launchStep: step, launchError: String((e as Error)?.message ?? e) });

/** boat: the provider the product's orchestrators run on (orchestrator/deploy/boat-lib.ts), its key from the vault. */
export function boatProvider(apiUrl: string): RunSandboxProvider {
  const libP = import("../orchestrator/deploy/boat-lib.js");
  return {
    name: "boat",
    apiUrl: () => apiUrl,
    async free() {
      const lib = await libP;
      const l = await lib.boatLimits();
      return Math.max(0, l.activeSandboxes - l.activeNow);
    },
    async launch(spec, onCreated) {
      const lib = await libP;
      const { boatCreate, boatApi } = await import("../orchestrator/core/boat.js");
      let step = "create";
      let id = "";
      try {
        const size = env.BOAT_RUN_SANDBOX_SIZE || "small";
        const c = await boatCreate({ type: size, ttlSeconds: Math.min(spec.ttlSeconds, lib.MAX_TTL_SECONDS), noEnv: true, snapshots: false });
        id = c.sandbox.id;
        step = "name";
        await onCreated(id);
        await boatApi(`/sandboxes/${id}`, { method: "PATCH", json: { name: spec.name } });
        step = "ready";
        await lib.waitReady(id);
        step = "code upload";
        // The runner's code, and the run tools' installer with the build's list (mold_v0-072): the sandbox is set up with them below.
        await lib.uploadCode(id, ROOT, [...lib.runnerCodeFiles(ROOT, spec.packDirs), ...RUN_TOOL_INSTALL_FILES]);
        step = "configure";
        const envBody = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
        if (/[\r]/.test(envBody) || Object.values(spec.env).some((v) => v.includes("\n"))) throw new Error("an environment value spans lines");
        await lib.put(id, `${lib.HOME}/runner.env.new`, envBody);
        const conf = await lib.run(id, `set -e; cd ${lib.HOME}
sudo -n install -d -m 700 -o root -g root /etc/octillion
sudo -n install -m 600 -o root -g root runner.env.new /etc/octillion/runner.env; rm -f runner.env.new
# The run's user: no sudo, no login. The egress proxy's user is made by the runner's lockdown.
id ${RUN_USER} >/dev/null 2>&1 || sudo -n useradd -r -M -s /usr/sbin/nologin ${RUN_USER}
# The provider's node is a link into the default user's home (0750): the run's user could not execute it. A real,
# world-executable copy, as the orchestrators' worker sandboxes make (orchestrator/core/runners.ts).
real="$(readlink -f /usr/local/bin/node 2>/dev/null || true)"
case "$real" in /home/*|/root/*) sudo -n cp --remove-destination "$real" /usr/local/bin/node && sudo -n chmod 0755 /usr/local/bin/node ;; esac
# What agent-workspace runs need (git) and the firewall the lockdown sets (nft or iptables), and setfacl for the step below: installed when missing.
command -v setfacl >/dev/null 2>&1 || sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq acl >/dev/null 2>&1 || true
# The local resolver's and the system bus's sockets: the run's user may not ask them to resolve names (netfilter never
# sees a unix socket). Best effort: where setfacl is missing, the firewall still keeps every packet in.
for s in /run/systemd/resolve/io.systemd.Resolve /run/systemd/resolve/io.systemd.Resolve.Monitor /run/dbus/system_bus_socket; do
  [ -e "$s" ] && command -v setfacl >/dev/null 2>&1 && sudo -n setfacl -m u:${RUN_USER}:--- "$s" || true
done
command -v git >/dev/null 2>&1 || { sudo -n apt-get update -qq && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git; } >/dev/null 2>&1 || true
command -v nft >/dev/null 2>&1 || command -v iptables >/dev/null 2>&1 || sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nftables >/dev/null 2>&1 || true
command -v git >/dev/null 2>&1 || { echo "git is missing in the run sandbox" >&2; exit 30; }
command -v nft >/dev/null 2>&1 || command -v iptables >/dev/null 2>&1 || { echo "neither nft nor iptables in the run sandbox" >&2; exit 31; }
# The run tools the packs' agent kinds declare (mold_v0-072), as the runner image has them: each artifact checked against
# its pinned sha256 before it is unpacked (root's, /opt/octi-tools). Before the runner starts: a run never downloads one.
cd ${lib.HOME}/app
grep -q '"aws"' src/run-tools.generated.json && { command -v unzip >/dev/null 2>&1 || sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip >/dev/null 2>&1 || true; }
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin ${lib.HOME}/app/orchestrator/node_modules/.bin/tsx scripts/install-run-tools.ts --from src/run-tools.generated.json --dir /opt/octi-tools >/dev/null 2>tools.err || { tail -5 tools.err >&2; exit 32; }`, 900);
        if (conf.code !== 0) throw new Error(`configure failed: ${conf.stderr.slice(-500)}`);
        step = "start";
        // As root (the runner switches to the run's user for the run itself), as a unit that outlives this command.
        const st = await lib.run(id, `sudo -n systemd-run --quiet --unit=octi-runner --property=EnvironmentFile=/etc/octillion/runner.env --property=WorkingDirectory=${lib.HOME}/app \
--property=Environment=PATH=/usr/local/bin:/usr/bin:/bin ${lib.HOME}/app/orchestrator/node_modules/.bin/tsx src/run-sandbox-runner.ts`, 60);
        if (st.code !== 0) throw new Error(`the runner did not start: ${st.stderr.slice(-300)}`);
        return { sandboxId: id };
      } catch (e) {
        if (id) await lib.deleteSandbox(id).catch(() => {});
        throw stepError(step, e);
      }
    },
    async list() {
      const lib = await libP;
      return (await lib.listSandboxes()).filter((s) => s.name?.startsWith(lib.RUN_PREFIX))
        .map((s) => ({ id: s.id, name: s.name ?? "", live: lib.isLive(s), state: s.state }));
    },
    async remove(id) { await (await libP).deleteSandbox(id); },
  };
}

/** The Docker Engine API over its unix socket (no client library). */
function dockerApi(socketPath: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath, method, path: p, timeout: 60_000, headers: { host: "docker", ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}) } }, (res) => {
      let raw = "";
      res.setEncoding("utf8").on("data", (c) => (raw += c)).on("end", () => {
        let json: any = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = { message: raw.slice(0, 300) }; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`docker ${method} ${p}: timed out`)));
    req.on("error", reject);
    req.end(data);
  });
}
const DOCKER_LABEL = "org.octillion.run-sandbox";
const namespace = () => (env.OCTILLION_BOAT_NAMESPACE || (env.VERCEL ? "octv" : "octi")).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 8) || "octi";

/**
 * docker: a container per run on this server's Docker, from the image the runner service itself runs (the app's image,
 * which has git, nft and the run user), on the compose project's `runs` network (the app is on it; the database is
 * not). No Docker socket, no mount, every capability dropped but what the runner needs to switch to the run's user and
 * set its own network namespace's firewall; no new privileges; memory, CPU and process limits.
 */
export async function dockerProvider(apiUrl: string): Promise<RunSandboxProvider | string> {
  const socketPath = env.OCTILLION_DOCKER_SOCKET || "/var/run/docker.sock";
  if (!existsSync(socketPath)) return `no Docker socket at ${socketPath}`;
  let image = env.OCTILLION_RUN_IMAGE || "", network = env.OCTILLION_RUN_NETWORK || "";
  try {
    const ping = await dockerApi(socketPath, "GET", "/_ping");
    if (ping.status !== 200) return `Docker does not answer (${ping.status})`;
    if (!image || !network) {
      // This process's own container: its image, and its compose project's runs network.
      const self = await dockerApi(socketPath, "GET", `/containers/${encodeURIComponent(hostname())}/json`);
      if (self.status !== 200) return "this process is not in a container Docker knows: set OCTILLION_RUN_IMAGE and OCTILLION_RUN_NETWORK";
      image ||= String(self.json?.Image ?? "");
      const project = self.json?.Config?.Labels?.["com.docker.compose.project"];
      network ||= project ? `${project}_runs` : "";
    }
  } catch (e) { return `Docker is not reachable: ${(e as Error).message}`; }
  if (!image || !network) return "no image or network for run containers";
  if (!apiUrl) return "OCTILLION_RUN_API_URL is not set (where run containers reach the API on the runs network)";
  // Per compose project (its runs network): two apps on one Docker host never list, or delete, each other's containers.
  const ns = `${namespace()}.${network}`;
  const call = (m: string, p: string, b?: unknown) => dockerApi(socketPath, m, p, b);
  return {
    name: "docker",
    apiUrl: () => apiUrl,
    free: async () => null,
    async launch(spec, onCreated) {
      let step = "create", id = "";
      try {
        const c = await call("POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, {
          Image: image, User: "0", WorkingDir: "/app",
          // The container's own deadline (it has no provider TTL): killed past it, whatever the scaler does.
          Cmd: ["timeout", "-s", "KILL", String(Math.max(60, Math.round(spec.ttlSeconds))), "node", "--import", "tsx", "src/run-sandbox-runner.ts"],
          Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
          Labels: { [DOCKER_LABEL]: ns, "org.octillion.run-id": spec.runId, "org.octillion.run-sandbox-row": String(spec.rowId) },
          HostConfig: {
            NetworkMode: network, Init: true, AutoRemove: false, RestartPolicy: { Name: "no" },
            CapDrop: ["ALL"], CapAdd: ["NET_ADMIN", "SETUID", "SETGID", "CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL"],
            SecurityOpt: ["no-new-privileges"], Binds: [], Privileged: false,
            Memory: Math.round(num(env.OCTILLION_RUN_MEMORY_MB, 2048) * 1024 * 1024), NanoCpus: Math.round(num(env.OCTILLION_RUN_CPUS, 1) * 1e9),
            PidsLimit: num(env.OCTILLION_RUN_PIDS, 1024), LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } },
          },
        });
        if (c.status !== 201) throw new Error(`docker create: ${c.status} ${c.json?.message ?? ""}`);
        id = String(c.json.Id);
        step = "name";
        await onCreated(id);
        step = "start";
        const s = await call("POST", `/containers/${id}/start`);
        if (s.status !== 204 && s.status !== 304) throw new Error(`docker start: ${s.status} ${s.json?.message ?? ""}`);
        return { sandboxId: id };
      } catch (e) {
        if (id) await call("DELETE", `/containers/${id}?force=true&v=true`).catch(() => {});
        throw stepError(step, e);
      }
    },
    async list() {
      const r = await call("GET", `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`${DOCKER_LABEL}=${ns}`] }))}`);
      if (r.status !== 200) throw new Error(`docker list: ${r.status}`);
      return (r.json ?? []).map((c: any) => ({ id: String(c.Id), name: String(c.Names?.[0] ?? "").replace(/^\//, ""), state: String(c.State),
        live: ["created", "running", "restarting"].includes(String(c.State)) }));
    },
    async remove(id) {
      const r = await call("DELETE", `/containers/${encodeURIComponent(id)}?force=true&v=true`);
      if (r.status !== 204 && r.status !== 404) throw new Error(`docker remove: ${r.status} ${r.json?.message ?? ""}`);
    },
  };
}

/**
 * process: the runner as a child process of this one, with no sandbox and no firewall. Only with
 * OCTILLION_ALLOW_UNSANDBOXED_RUNS=yes (offline tests); never chosen by "auto".
 */
export function processProvider(apiUrl: string): RunSandboxProvider {
  const kids = new Map<string, { child: ChildProcess; name: string }>();
  return {
    name: "process",
    apiUrl: () => apiUrl,
    free: async () => null,
    async launch(spec, onCreated) {
      const id = `proc-${randomBytes(4).toString("hex")}`;
      await onCreated(id);
      const runAs = env.OCTILLION_RUN_UID ? { OCTILLION_RUN_UID: env.OCTILLION_RUN_UID, OCTILLION_RUN_GID: env.OCTILLION_RUN_GID ?? env.OCTILLION_RUN_UID } : { OCTILLION_RUN_SAME_USER: "yes" };
      const { OCTILLION_RUN_USER: _u, ...rest } = spec.env;
      const child = spawn(process.execPath, ["--import", "tsx", "src/run-sandbox-runner.ts"], { cwd: ROOT, detached: true, stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: env.PATH ?? "/usr/bin:/bin", ...rest, ...runAs, OCTILLION_RUN_LOCKDOWN: "off", OCTILLION_ALLOW_UNSANDBOXED_RUNS: "yes" } });
      child.stderr?.on("data", (d) => spec.log(`[${id}] ${String(d).trim()}`));
      kids.set(id, { child, name: spec.name });
      return { sandboxId: id };
    },
    async list() { return [...kids].map(([id, k]) => ({ id, name: k.name, live: k.child.exitCode === null && k.child.signalCode === null, state: k.child.exitCode === null ? "running" : "exited" })); },
    async remove(id) {
      const k = kids.get(id);
      if (k?.child.pid && k.child.exitCode === null) { try { process.kill(-k.child.pid, "SIGKILL"); } catch { /* gone */ } }
      kids.delete(id);
    },
  };
}

/** Where a sandbox's runner reaches the API: OCTILLION_RUN_API_URL, else the autoscaler's address for orchestrators. */
const runApiUrl = () => (env.OCTILLION_RUN_API_URL || env.OCTILLION_INTERNAL_URL || env.PUBLIC_URL || "").replace(/\/$/, "");

let boatKeyAt = 0;
let processCache: RunSandboxProvider | null = null;
/** Whether the vault has the provider's key (and sets it for the boat client), checked at most every 5 minutes. */
async function boatConfigured(): Promise<boolean> {
  const { BOAT } = await import("../orchestrator/core/config.js");
  if (BOAT.apiKey && Date.now() - boatKeyAt < 5 * 60_000) return true;
  try {
    const { useCredential } = await import("./keyvault.js");
    BOAT.apiKey = (await useCredential("boat")).secret;
    boatKeyAt = Date.now();
    return true;
  } catch (e) {
    // A vault that does not answer for a moment keeps the last good key: a server never flips provider for a tick.
    if (BOAT.apiKey && !/no .*credential|not found|no enabled/i.test(String((e as Error).message))) return true;
    BOAT.apiKey = "";
    return false;
  }
}

/** The provider this process launches run sandboxes with, or why there is none. */
export async function resolveRunProvider(): Promise<{ provider: RunSandboxProvider | null; why: string }> {
  const mode = RUN_SANDBOXES.mode(), url = runApiUrl();
  const boat = async () => {
    if (!(await boatConfigured())) return "the sandbox provider's key is not in the vault";
    if (!/^https:\/\//.test(url)) return "the API's address for sandboxes is not HTTPS (PUBLIC_URL or OCTILLION_RUN_API_URL)";
    return boatProvider(url);
  };
  const pick = (p: RunSandboxProvider | string) => (typeof p === "string" ? { provider: null, why: p } : { provider: p, why: "" });
  switch (mode) {
    case "off": return { provider: null, why: "run sandboxes are off on this deployment (OCTILLION_RUN_SANDBOX=off)" };
    case "boat": return pick(await boat());
    case "docker": return pick(await dockerProvider(url));
    case "process":
      return RUN_SANDBOXES.unsandboxedAllowed() ? { provider: (processCache ??= processProvider(url)), why: "" }
        : { provider: null, why: "OCTILLION_RUN_SANDBOX=process runs runs with no sandbox, refused unless OCTILLION_ALLOW_UNSANDBOXED_RUNS=yes (tests only)" };
    case "auto": {
      const b = await boat();
      if (typeof b !== "string") return { provider: b, why: "" };
      const d = await dockerProvider(url);
      if (typeof d !== "string") return { provider: d, why: "" };
      return { provider: null, why: `no sandbox provider is configured: ${b}, and ${d}` };
    }
    default: return { provider: null, why: `OCTILLION_RUN_SANDBOX=${mode} is not one of auto, boat, docker, off` };
  }
}

// ---------- the runner's side (src/run-routes.ts) ----------

/** A run sandbox's claim: its own run, once, as "sbx-<row>". Null (and the sandbox torn down) when it cannot be claimed. */
export async function claimForSandbox(runId: string, rowId: number): Promise<Claim | null> {
  const db = await getDb();
  const [row] = await db.query<{ id: number }>(
    "UPDATE run_sandboxes SET claimed_at = now() WHERE id = $1 AND run_id = $2 AND claimed_at IS NULL AND state IN ('booting', 'running') RETURNING id", [rowId, runId]);
  if (!row) throw Object.assign(new Error("this sandbox has already claimed its run, or was torn down"), { status: 409 });
  const c = await claimRun(sandboxWorkerId(rowId), { runId });
  if (!c) await sandboxDone(rowId, "its run could not be claimed (taken, ended or not claimable now)");
  return c;
}

/** The sandbox's attempt is over: torn down now (on a server the loop's next tick; on Vercel a kick). */
export async function sandboxDone(rowId: number, reason: string): Promise<void> {
  await (await getDb()).query("UPDATE run_sandboxes SET state = 'draining', reap_reason = coalesce(reap_reason, $2) WHERE id = $1 AND state IN ('booting', 'running')", [rowId, reason]);
  if (env.VERCEL) void import("./autoscaler.js").then((a) => keepAlive(a.kickAutoscaler({ force: true }).catch(() => null))).catch(() => {});
}

// ---------- the scaler ----------

interface Row {
  id: number; run_id: string; attempt: number; provider: string; sandbox_id: string | null; state: string;
  created_at: Date; claimed_at: Date | null; reap_reason: string | null;
}
export interface RunTick {
  provider: string | null; leader: boolean; note?: string; error?: string;
  /** Queued runs per kind, and how many a claim would take now. */
  demand?: { queued: Record<string, number>; claimable: number };
  live?: number; cap?: number; launched?: { row: number; run: string }[]; reaped?: { row: number; run: string; reason: string }[]; failed?: string[];
}

export class RunScaler {
  readonly holder = `${hostname()}-${process.pid}-runs-${randomBytes(3).toString("hex")}`;
  private inflight = new Map<number, Promise<void>>();
  /** Sandbox ids of launches in flight: never taken for orphans while their row is being written. */
  private inflightIds = new Set<string>();
  private provider: RunSandboxProvider | null = null;
  constructor(private opts: { provider?: RunSandboxProvider | null; log?: (m: string) => void; tickMs?: () => number } = {}) {}
  private log(m: string) { (this.opts.log ?? ((x: string) => console.error(`runs: ${x}`)))(m); }
  /** Wait for launches in flight (tests; serverless before the function is frozen). */
  async settle() { await Promise.allSettled([...this.inflight.values()]); }

  private async lease(name: string): Promise<boolean> {
    const ttl = Math.ceil(((this.opts.tickMs?.() ?? 15_000) * 3) / 1000);
    const rows = await (await getDb()).query<{ holder: string }>(
      `INSERT INTO autoscaler_lease (name, holder, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (name) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
         WHERE autoscaler_lease.holder = excluded.holder OR autoscaler_lease.expires_at < now()
       RETURNING holder`, [name, this.holder, ttl]);
    return rows[0]?.holder === this.holder;
  }
  async release() { await (await getDb()).query("DELETE FROM autoscaler_lease WHERE name = 'runs' AND holder = $1", [this.holder]).catch(() => {}); }

  /** One tick, across every workspace (the platform's own bookkeeping). */
  tick(): Promise<RunTick> { return asPlatform(() => this.tickOnce()); }

  private async tickOnce(): Promise<RunTick> {
    const db = await getDb();
    const chosen = this.opts.provider !== undefined ? { provider: this.opts.provider, why: this.opts.provider ? "" : "no provider (test)" } : await resolveRunProvider();
    const st: RunTick = { provider: chosen.provider?.name ?? null, leader: false };
    // The autoscaler's kill switch stops run launches and deletes too, wherever this ticks (the runner service included).
    if ((env.OCTILLION_AUTOSCALE ?? "on").toLowerCase() === "off") { st.note = "OCTILLION_AUTOSCALE=off"; return st; }
    if (!chosen.provider) {
      // No sandbox here: nothing is launched and nothing runs unsandboxed. Unless another process (the runner service)
      // launches runs, each queued run says why it waits.
      const [l] = await db.query<{ live: boolean }>("SELECT expires_at > now() AS live FROM autoscaler_lease WHERE name = 'runs'");
      st.note = l?.live ? "another process launches run sandboxes" : `runs wait: ${chosen.why}`;
      if (!l?.live) {
        const queued = await queuedRunsByKind();
        st.demand = { queued, claimable: 0 };
        if (Object.keys(queued).length) await noteRunsWaiting(chosen.why);
      }
      return st;
    }
    this.provider = chosen.provider;
    if (!(await this.lease("runs"))) { st.note = "not the leader"; return st; }
    st.leader = true;
    try {
      await sweepRuns(); // lapsed leases (a runner that died) go back to the queue before anything else is decided
      const p = chosen.provider;
      const listing = await p.list();
      const byId = new Map(listing.map((s) => [s.id, s]));
      const rows = await db.query<Row>("SELECT id, run_id, attempt, provider, sandbox_id, state, created_at, claimed_at, reap_reason FROM run_sandboxes WHERE state <> 'deleted' ORDER BY id");
      const now = Date.now(), min = 60_000;
      st.reaped = []; st.launched = []; st.failed = [];
      /** `failedStart`: the sandbox never started its attempt (died, never claimed, or claimed nothing): it counts toward
       *  the run's failed starts, as a launch error does, so the back-off and the give-up apply (no relaunch forever). */
      const reap = async (row: Row, reason: string, failedStart = false) => {
        // Deleted whenever it has an id, listed or not (an unnamed sandbox of a launch cut short is not listed); a
        // delete of one already gone is harmless.
        if (row.sandbox_id && row.provider === p.name) await p.remove(row.sandbox_id).catch((e) => this.log(`remove ${row.sandbox_id}: ${(e as Error).message}`));
        await db.query(`UPDATE run_sandboxes SET state = 'deleted', deleted_at = now(), reap_reason = coalesce(reap_reason, $2),
                          launch_step = CASE WHEN $3 THEN coalesce(launch_step, 'boot') ELSE launch_step END,
                          launch_error = CASE WHEN $3 THEN coalesce(launch_error, $2) ELSE launch_error END WHERE id = $1`, [row.id, reason, failedStart]);
        await revokeRunSandboxTokens(row.id);
        await recordComputeEvent({ kind: "reaped", sandbox_id: row.sandbox_id, job_id: row.run_id, reason: `run sandbox: ${reason}` });
        st.reaped!.push({ row: row.id, run: row.run_id, reason });
      };
      const runsOf = new Map((await db.query<{ id: string; status: string; worker_id: string | null; deadline_at: Date | null; attempt: number }>(
        "/* tenant: internal: the run sandboxes' runs, by id */ SELECT id, status, worker_id, deadline_at, attempt FROM runs WHERE id = ANY($1::text[])", [rows.map((r) => r.run_id)])).map((r) => [r.id, r]));
      for (const row of rows) {
        const age = now - new Date(row.created_at).getTime();
        const inflight = this.inflight.has(row.id);
        // Another provider's sandbox (the provider changed): left to a process with that provider; never reaped blind.
        if (row.provider !== p.name) continue;
        if (row.state === "draining") { await reap(row, row.reap_reason ?? "its attempt ended"); continue; }
        if (!row.sandbox_id) { if (!inflight && age > RUN_SANDBOXES.bootMinutes() * min) await reap(row, "the launch never created a sandbox", true); continue; }
        const sb = byId.get(row.sandbox_id);
        if (!sb || !sb.live) {
          if (inflight && age < 2 * min) continue; // a listing can lag a fresh create
          await reap(row, sb ? `the sandbox is ${sb.state}` : "the sandbox is gone", !row.claimed_at);
          continue;
        }
        if (inflight) continue;
        const run = runsOf.get(row.run_id);
        if (!run || !["queued", "running"].includes(run.status)) { await reap(row, `its run is ${run?.status ?? "gone"}`); continue; }
        if (run.status === "running") {
          if (run.worker_id !== sandboxWorkerId(row.id)) { await reap(row, "its run is carried out elsewhere"); continue; }
          // Past the run's deadline (and the lease a dead runner would have left): never kept running on.
          if (run.deadline_at && now > new Date(run.deadline_at).getTime() + 5 * min) { await reap(row, "past its run's deadline"); continue; }
          continue;
        }
        // queued
        // Claimed, but the run never reached the attempt this sandbox was for: the claim itself failed (a failed start).
        if (row.claimed_at) { await reap(row, run.attempt < row.attempt ? "its claim did not start the run" : "its attempt ended and the run was queued again", run.attempt < row.attempt); continue; }
        if (age > RUN_SANDBOXES.bootMinutes() * min) await reap(row, `no claim within ${RUN_SANDBOXES.bootMinutes()} minutes`, true);
      }
      // Orphans: this deployment's run sandboxes with no live row (a launch cut short by a restart, a row reaped while
      // the provider was not answering).
      const known = new Set((await db.query<{ sandbox_id: string }>("SELECT sandbox_id FROM run_sandboxes WHERE state <> 'deleted' AND sandbox_id IS NOT NULL")).map((r) => r.sandbox_id));
      for (const sb of listing) {
        if (known.has(sb.id) || this.inflightIds.has(sb.id)) continue;
        if (!sb.live && p.name !== "docker") continue;
        await p.remove(sb.id).catch(() => {});
        await recordComputeEvent({ kind: "orphan_deleted", sandbox_id: sb.id, reason: `run sandbox with no row: ${sb.name}` });
        st.reaped.push({ row: 0, run: "", reason: `orphan ${sb.name}` });
      }

      // Demand, then launches within the caps.
      const queued = await queuedRunsByKind();
      const claimable = await claimableRuns();
      st.demand = { queued, claimable: claimable.length };
      const live = await db.query<{ run_id: string }>("SELECT run_id FROM run_sandboxes WHERE state <> 'deleted'");
      const served = new Set(live.map((r) => r.run_id));
      const free = await p.free().catch(() => 0);
      const cap = Math.max(0, Math.min(RUN_SANDBOXES.maxSandboxes(), live.length + (free ?? Infinity)));
      st.live = live.length; st.cap = cap;
      const notes: string[] = [];
      let n = live.length;
      for (const run of claimable) {
        if (served.has(run.id)) continue;
        // Back-off and give-up after failed starts: nothing launches forever.
        const [f] = await db.query<{ n: number; last: Date | null; err: string | null }>(
          `SELECT count(*)::int AS n, max(deleted_at) AS last, (array_agg(launch_error ORDER BY id DESC))[1] AS err FROM run_sandboxes
            WHERE run_id = $1 AND launch_error IS NOT NULL`, [run.id]);
        const fails = Number(f?.n ?? 0);
        if (fails >= RUN_SANDBOXES.launchAttempts()) {
          if (await failUnlaunchedRun(run.id, `its sandbox could not be started (${fails} tries; last: ${String(f?.err ?? "").slice(0, 300)})`)) st.failed.push(run.id);
          continue;
        }
        if (fails && f?.last && now - new Date(f.last).getTime() < RUN_SANDBOXES.backoffSeconds() * 1000 * 2 ** (fails - 1)) { notes.push(`${run.id} waits before another start`); continue; }
        if (st.launched.length >= RUN_SANDBOXES.launchesPerTick()) { notes.push(`at ${RUN_SANDBOXES.launchesPerTick()} launches a tick`); break; }
        if (n >= cap) { notes.push(`at ${cap} run sandboxes (OCTILLION_MAX_RUN_SANDBOXES ${RUN_SANDBOXES.maxSandboxes()}${free === null ? "" : `, ${free} free on the plan`})`); break; }
        const launched = await this.launch(p, run);
        if (launched) st.launched.push({ row: launched, run: run.id });
        n++;
      }
      if (notes.length) st.note = notes.join("; ");
    } catch (e) {
      st.error = (e as Error).message;
      this.log(`tick error: ${st.error}`);
    }
    return st;
  }

  /** Insert the row (it counts at once), then create and start the sandbox in the background. Returns the row's id. */
  private async launch(p: RunSandboxProvider, run: ClaimableRun): Promise<number> {
    const db = await getDb();
    // One live sandbox per run (a unique index): a second leader's insert for the same run does nothing.
    const [row] = await db.query<{ id: number }>("INSERT INTO run_sandboxes (run_id, attempt, provider) VALUES ($1, $2, $3) ON CONFLICT (run_id) WHERE state <> 'deleted' DO NOTHING RETURNING id", [run.id, run.attempt + 1, p.name]);
    if (!row) return 0;
    const id = row.id;
    const kind = findKind(run.pack, run.kind);
    // The pack's own program needs the pack's files; an agent-workspace kind fetches its repository instead.
    let packRel = "";
    if (kind && kind.runner === "workspace-harness") {
      const { packDir } = await import("./packs.js");
      packRel = path.relative(ROOT, packDir(run.pack)).split(path.sep).join("/");
      if (!packRel || packRel.startsWith("..") || path.isAbsolute(packRel)) packRel = "";
    }
    const life = RUN_SANDBOXES.bootMinutes() * 60 + run.token_lifetime_seconds + run.lease_seconds * 2;
    const token = await mintRunWorkerToken(run.id, run.org_id, id, life + 600);
    const spec: RunSandboxSpec = {
      rowId: id, runId: run.id, name: `${p.name === "boat" ? (await import("../orchestrator/deploy/boat-lib.js")).RUN_PREFIX : `${namespace()}-run-`}${id}-${randomBytes(3).toString("hex")}`,
      env: { OCTILLION_URL: p.apiUrl(), OCTILLION_WORKER_TOKEN: token, OCTILLION_RUN_ID: run.id, OCTILLION_RUN_USER: RUN_USER,
             OCTILLION_RUN_PACK_DIR: packRel, OCTILLION_RUN_LOCKDOWN: "on" },
      ttlSeconds: life + 1800, packDirs: packRel ? [packRel] : [], log: (m) => this.log(m),
    };
    let created = "";
    const job = p.launch(spec, async (sandboxId) => { created = sandboxId; this.inflightIds.add(sandboxId); await db.query("UPDATE run_sandboxes SET sandbox_id = $2 WHERE id = $1", [id, sandboxId]); })
      .then(async () => {
        await db.query("UPDATE run_sandboxes SET state = 'running', ready_at = now() WHERE id = $1 AND state = 'booting'", [id]);
        this.log(`launched run sandbox ${id} for ${run.id}`);
      })
      .catch(async (e) => {
        const step = String((e as { launchStep?: string }).launchStep ?? "unknown"), err = String((e as { launchError?: string }).launchError ?? (e as Error).message);
        const [r] = await db.query<{ sandbox_id: string | null }>(
          "UPDATE run_sandboxes SET state = 'deleted', deleted_at = now(), launch_step = $2, launch_error = $3 WHERE id = $1 AND state <> 'deleted' RETURNING sandbox_id", [id, step, err.slice(0, 500)]);
        await revokeRunSandboxTokens(id);
        await recordComputeEvent({ kind: "launch_failed", sandbox_id: r?.sandbox_id, job_id: run.id, step, reason: `run sandbox: ${err}` });
        this.log(`run sandbox ${id} for ${run.id} failed at ${step}: ${err}`);
      })
      .finally(() => { this.inflight.delete(id); this.inflightIds.delete(created); });
    this.inflight.set(id, job);
    return id;
  }
}

/** The run sandboxes for the admin's autoscaler status. */
export async function runSandboxStatus() {
  return (await getDb()).query("SELECT id, run_id, attempt, provider, sandbox_id, state, created_at, ready_at, claimed_at, deleted_at, launch_step, launch_error, reap_reason FROM run_sandboxes ORDER BY id DESC LIMIT 50");
}
