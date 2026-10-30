/**
 * Runs in sandboxes (mold_v0-055; molds/mold_v0/MOLD.md "Runs in sandboxes"). The autoscaler (src/autoscaler.ts, and on
 * a server of its own the compose project's runner service, src/run-fleet.ts) launches one sandbox per queued run:
 *
 *   demand     the queued runs a claim would take now (src/runs.ts claimableRuns: the kind's concurrency per workspace,
 *              the platform's ceiling, one writer per workspace store), reported per kind
 *   launch     a row in run_sandboxes, a worker token bound to that run and that sandbox (src/workerauth.ts), and a
 *              sandbox from the provider with the runner (src/run-sandbox-runner.ts) and only that token. At most
 *              APP_MAX_RUN_SANDBOXES at once, APP_RUN_LAUNCHES_PER_TICK a tick, within the provider plan's
 *              free sandboxes; a sandbox lives at most the run's token lifetime and a margin (the provider's TTL)
 *   claim      the runner claims its run, once (claimForSandbox): the run's worker is "sbx-<row>"
 *   run        the runner locks the run's user down to the run's egress (firewall + proxy) and carries the run out
 *   teardown   the sandbox goes when its attempt ends: at once when the runner completes (sandboxDone), else at the next
 *              tick (the run ended, was taken elsewhere, its attempt lapsed and was queued again, the sandbox died, it
 *              never claimed within APP_RUN_BOOT_MINUTES, or it is past the run's deadline). Orphans (ours by
 *              name or label, with no row) are deleted. The token is revoked with it.
 *   failures   a run whose sandbox fails to start is tried again after a back-off, and fails (infrastructure) after
 *              APP_RUN_LAUNCH_ATTEMPTS failed starts: nothing launches forever
 *
 * Providers: "boat" (the sandbox provider the product already uses for its orchestrators, with its key in the vault),
 * "docker" (a container per run on the server's own Docker, from the runner service only: it holds the Docker socket,
 * the app does not), and "process" (no sandbox at all: refused unless APP_ALLOW_UNSANDBOXED_RUNS=yes, for tests).
 * APP_RUN_SANDBOX picks one (auto: boat when its key is in the vault, else docker when this process has the
 * socket, else none); "off" launches nothing. With no provider no run is ever carried out unsandboxed: queued runs wait,
 * each with a `waiting` event that says why.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { claimableRuns, claimRun, failUnlaunchedRun, findKind, noteRunsWaiting, queuedRunsByKind, sweepRuns, type Claim, type ClaimableRun } from "./runs.js";
import { mintRunWorkerToken, revokeRunSandboxTokens } from "./workerauth.js";
import { recordComputeEvent } from "./compute-events.js";
import { invocationDeadline, keepAlive } from "./telemetry.js";
import { DEFAULT_RUN_UIDS } from "./run-users.js";
import { ENV } from "./env-names.js";
import { NS } from "./namespace.js";
import { dockerApi, runContainerBody } from "./run-container.js";
import { onPremAvailable, reapSilentRunners } from "./onprem-runners.js";
import { boatNamespace, boatNamespaces } from "../orchestrator/core/boat-namespace.js";

const env = ENV;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
/** The image's fixed run account (kept for an older runner); runs now lease a uid of their own per run (mold_v0-078). */
export const RUN_USER = "apprun";
/** The range a sandbox's runner leases its run's user from (mold_v0-078, src/run-users.ts). */
const runUids = () => env.APP_RUN_UIDS || DEFAULT_RUN_UIDS;

export const RUN_SANDBOXES = {
  mode: () => (env.APP_RUN_SANDBOX ?? "auto").toLowerCase(),
  maxSandboxes: () => Math.max(0, num(env.APP_MAX_RUN_SANDBOXES, 10)),
  launchesPerTick: () => Math.max(1, num(env.APP_RUN_LAUNCHES_PER_TICK, 4)),
  bootMinutes: () => Math.max(1, num(env.APP_RUN_BOOT_MINUTES, 10)),
  launchAttempts: () => Math.max(1, num(env.APP_RUN_LAUNCH_ATTEMPTS, 3)),
  backoffSeconds: () => Math.max(0, num(env.APP_RUN_LAUNCH_BACKOFF_SECONDS, 30)),
  /** How old a launched sandbox is before a tick asks where its set-up stands (mold_v0-179). */
  setupCheckSeconds: () => Math.max(0, num(env.APP_RUN_SETUP_CHECK_SECONDS, 20)),
  unsandboxedAllowed: () => env.APP_ALLOW_UNSANDBOXED_RUNS === "yes",
};
/**
 * Whether the packs' runs may get their sandbox from boat (mold_v0-169): APP_RUN_SANDBOX=boat, or auto (the default:
 * boat when its key is in the vault, else Docker) in a build whose packs have job kinds. A deployment that names another
 * sandbox (docker on a server, off) does not use boat for runs. On Vercel, auto with job kinds is boat: there is no Docker.
 */
export const boatForRuns = (mode: string, hasKinds: boolean) => mode === "boat" || (mode === "auto" && hasKinds);

export const sandboxWorkerId = (rowId: number) => `sbx-${rowId}`;
/** What a boat run sandbox gets besides the runner's code (mold_v0-072): the run tools' installer and the build's list. */
export const RUN_TOOL_INSTALL_FILES = ["scripts/install-run-tools.ts", "src/run-tools.generated.json"];
/** A launch needs at least this much of its function call left to start (on Vercel; mold_v0-179). */
export const LAUNCH_MIN_MS = 90_000;

/**
 * A boat run sandbox's set-up (mold_v0-179): its files in the sandbox's working directory, and its systemd unit. The
 * launch only uploads the code and starts this script, detached; unpacking, `npm ci`, the run user, packages, the run
 * tools and the runner's start happen in the sandbox after the launching call has returned, so no function call waits
 * on them (on Vercel one did, past its 300 s, and was frozen mid-upload). The script writes its state to `status`
 * ("running <step>", then "started runner" or "failed <step>") and its errors to `log`; the next tick reads both.
 */
export const RUN_SETUP = { script: "run-setup.sh", status: "run-setup.status", log: "run-setup.err", unit: "app-run-setup" } as const;
/** The runner's PATH in the sandbox: the system's own directories, sbin too (useradd, nft: mold_v0-174). */
const SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The set-up script for a run sandbox whose working directory is `home` (orchestrator/deploy/boat-lib.ts HOME). */
export function runSetupScript(home: string): string {
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(home)) throw new Error(`not a plain absolute directory: ${home}`);
  const S = `${home}/${RUN_SETUP.status}`, apt = "sudo -n env DEBIAN_FRONTEND=noninteractive timeout 600 apt-get";
  return `#!/bin/bash
# A run sandbox's set-up (mold_v0-179; written by src/run-sandboxes.ts boatProvider, started detached by its launch).
set -u
H=${home}
cd "$H" || exit 1
exec </dev/null 2>>"$H/${RUN_SETUP.log}"
step=""
at() { step="$1"; printf 'running %s\\n' "$1" > "${S}.new" && mv -f "${S}.new" "${S}"; echo "--- $1 ($(date -u +%H:%M:%S))" >&2; }
fail() { echo "$1" >&2; printf 'failed %s\\n' "$step" > "${S}.new" && mv -f "${S}.new" "${S}"; exit 1; }

at unpack
{ cat code.tgz.part* > code.tgz && rm -f code.tgz.part* && rm -rf app.new && mkdir app.new && tar -xzf code.tgz -C app.new && rm -f code.tgz; } || fail "the code did not unpack"

at npm
# The orchestrator's tsx, which runs the runner (nothing else is installed).
( cd app.new/orchestrator && timeout 600 npm ci --omit=dev --no-audit --no-fund >/dev/null 2>"$H/npm.err" ) || { tail -20 "$H/npm.err" >&2; fail "npm ci failed"; }
{ rm -rf app.old; if [ -d app ]; then mv app app.old; fi; mv app.new app && rm -rf app.old; } || fail "the code could not be put in place"

at configure
{ sudo -n install -d -m 700 -o root -g root /etc/${NS} && sudo -n install -m 600 -o root -g root runner.env.new /etc/${NS}/runner.env && rm -f runner.env.new; } || fail "the runner's environment file could not be installed"
# The run's user: no sudo, no login. The egress proxy's user is made by the runner's lockdown.
id ${RUN_USER} >/dev/null 2>&1 || sudo -n useradd -r -M -s /usr/sbin/nologin ${RUN_USER} || fail "the run user could not be made"
# The provider's node is a link into the default user's home (0750): the run's user could not execute it. A real,
# world-executable copy, as the orchestrators' worker sandboxes make (orchestrator/core/runners.ts).
real="$(readlink -f /usr/local/bin/node 2>/dev/null || true)"
case "$real" in /home/*|/root/*) { sudo -n cp --remove-destination "$real" /usr/local/bin/node && sudo -n chmod 0755 /usr/local/bin/node; } || fail "node could not be copied for the run user" ;; esac

at packages
# What agent-workspace runs need (git) and the firewall the lockdown sets (nft or iptables), and setfacl (the runner's
# lockdown denies the local resolver's and the system bus's sockets to the run's user with it): installed when missing.
command -v setfacl >/dev/null 2>&1 || ${apt} install -y -qq acl >/dev/null 2>&1 || true
command -v git >/dev/null 2>&1 || { ${apt} update -qq && ${apt} install -y -qq git; } >/dev/null 2>&1 || true
command -v nft >/dev/null 2>&1 || command -v iptables >/dev/null 2>&1 || ${apt} install -y -qq nftables >/dev/null 2>&1 || true
command -v git >/dev/null 2>&1 || fail "git is missing in the run sandbox"
command -v nft >/dev/null 2>&1 || command -v iptables >/dev/null 2>&1 || fail "neither nft nor iptables in the run sandbox"

at tools
# The run tools the packs' agent kinds declare (mold_v0-072), as the runner image has them: each artifact checked against
# its pinned sha256 before it is unpacked (root's, /opt/app-tools). Before the runner starts: a run never downloads one.
cd "$H/app" || fail "no code directory"
if grep -q '"aws"' src/run-tools.generated.json; then command -v unzip >/dev/null 2>&1 || ${apt} install -y -qq unzip >/dev/null 2>&1 || true; fi
sudo -n env PATH=/usr/local/bin:/usr/bin:/bin $H/app/orchestrator/node_modules/.bin/tsx scripts/install-run-tools.ts --from src/run-tools.generated.json --dir /opt/app-tools >/dev/null 2>"$H/tools.err" || { tail -5 "$H/tools.err" >&2; fail "the run tools could not be installed"; }

at start
# As root (the runner switches to the run's user for the run itself), as a unit of its own.
sudo -n systemd-run --quiet --unit=app-runner --property=EnvironmentFile=/etc/${NS}/runner.env --property=WorkingDirectory=$H/app \\
  --property=Environment=PATH=${SANDBOX_PATH} $H/app/orchestrator/node_modules/.bin/tsx src/run-sandbox-runner.ts || fail "the runner did not start"
printf 'started runner\\n' > "${S}.new" && mv -f "${S}.new" "${S}"
`;
}

/** What a sandbox's set-up says (the status line and the log's tail, as boatProvider.bootStatus reads them). */
export interface BootStatus { state: "none" | "running" | "failed" | "started" | "unknown"; step: string; detail: string }
export function parseBootStatus(out: string): BootStatus {
  const [head = "", ...rest] = out.split("\n---\n");
  const line = head.trim().split("\n").pop() ?? "";
  const m = /^(running|failed|started)\s+(\S+)/.exec(line);
  // The log's last lines, without the step markers: what went wrong, in the sandbox's own words.
  const detail = rest.join("\n---\n").split("\n").filter((l) => l.trim() && !l.startsWith("--- ")).slice(-6).join(" | ").slice(-600);
  if (!m) return { state: line === "none" ? "none" : "unknown", step: "", detail };
  return { state: m[1] as BootStatus["state"], step: m[2]!, detail };
}

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
  /** When the call launching it is cut off (ms since the epoch; Vercel), else null: the launch is over by then. */
  deadlineAt?: number | null;
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
  /** Where a launched sandbox's set-up stands (a provider whose set-up goes on after its launch returned: boat). */
  bootStatus?(id: string): Promise<BootStatus>;
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
      // On Vercel the call this runs in is cut off at its deadline: each step starts only with time left for it, so the
      // launch ends (and cleans up) inside the call rather than being frozen half done (mold_v0-179).
      const left = () => (spec.deadlineAt ? spec.deadlineAt - Date.now() : Infinity);
      const need = (s: string, ms: number) => {
        step = s;
        if (left() < ms) throw new Error(`the call launching it had ${Math.max(0, Math.round(left() / 1000))} s left, too little to ${s}: tried again from a later one`);
      };
      try {
        need("create", 45_000);
        const size = env.BOAT_RUN_SANDBOX_SIZE || "small";
        const c = await boatCreate({ type: size, ttlSeconds: Math.min(spec.ttlSeconds, lib.MAX_TTL_SECONDS), noEnv: true, snapshots: false }, spec.deadlineAt ? { maxTries: 3 } : {});
        id = c.sandbox.id;
        step = "name";
        await onCreated(id);
        await boatApi(`/sandboxes/${id}`, { method: "PATCH", json: { name: spec.name } });
        need("ready", 30_000);
        await lib.waitReady(id, Math.min(300_000, left() - 25_000));
        need("code upload", 20_000);
        // The runner's code, and the run tools' installer with the build's list (mold_v0-072). Only sent here: the set-up
        // script below unpacks and installs it in the sandbox.
        const files = [...lib.runnerCodeFiles(ROOT, spec.packDirs), ...RUN_TOOL_INSTALL_FILES];
        const up = await lib.uploadParts(id, ROOT, files);
        spec.log(`run sandbox ${spec.name}: ${files.length} files, ${up.bytes} bytes (${up.parts} part${up.parts === 1 ? "" : "s"})`);
        step = "configure";
        const envBody = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
        if (/[\r]/.test(envBody) || Object.values(spec.env).some((v) => v.includes("\n"))) throw new Error("an environment value spans lines");
        await lib.put(id, `${lib.HOME}/runner.env.new`, envBody);
        await lib.put(id, `${lib.HOME}/${RUN_SETUP.script}`, runSetupScript(lib.HOME));
        need("start", 10_000);
        // Detached, as a unit of its own (as root, as the runner it starts; its sudo calls are then no-ops), with this
        // command's PATH (where the provider's node and npm are): the command returns at once, the set-up goes on.
        const st = await lib.run(id, `set -e; cd ${lib.HOME}; rm -f ${RUN_SETUP.status} ${RUN_SETUP.log}; chmod 700 ${RUN_SETUP.script}
sudo -n systemd-run --quiet --collect --unit=${RUN_SETUP.unit} --setenv=HOME=/root --setenv=PATH="$PATH" \\
  --property=WorkingDirectory=${lib.HOME} /bin/bash ${lib.HOME}/${RUN_SETUP.script}`, 60);
        if (st.code !== 0) throw new Error(`the set-up did not start: ${(st.stderr || st.stdout).slice(-300)}`);
        return { sandboxId: id };
      } catch (e) {
        // Deleted before the call ends; one that cannot be deleted now is an orphan the next tick deletes (named ours).
        if (id) await lib.deleteSandbox(id).catch((d) => spec.log(`run sandbox ${id} could not be deleted after its failed launch: ${(d as Error).message}`));
        throw stepError(step, e);
      }
    },
    async bootStatus(id) {
      const lib = await libP;
      const r = await lib.run(id, `cat ${lib.HOME}/${RUN_SETUP.status} 2>/dev/null || echo none; echo ---; tail -c 2000 ${lib.HOME}/${RUN_SETUP.log} 2>/dev/null || true`, 30, { repeatable: true });
      return parseBootStatus(r.stdout);
    },
    async list() {
      const lib = await libP;
      // Ours under the namespace's old default too (lib.NAMESPACES): a run sandbox launched before mold_v0-156.
      return (await lib.listSandboxes()).filter((s) => lib.isRunName(s.name))
        .map((s) => ({ id: s.id, name: s.name ?? "", live: lib.isLive(s), state: s.state }));
    },
    async remove(id) { await (await libP).deleteSandbox(id); },
  };
}

const DOCKER_LABEL = `org.${NS}.run-sandbox`;
/** This deployment's namespace (orchestrator/core/boat-namespace.ts), as the orchestrators' sandboxes are named. */
const namespace = boatNamespace;

/**
 * docker: a container per run on this server's Docker, from the image the runner service itself runs (the app's image,
 * which has git, nft and the run user), on the compose project's `runs` network (the app is on it; the database is
 * not). No Docker socket, no mount, every capability dropped but what the runner needs to switch to the run's user and
 * set its own network namespace's firewall; no new privileges; memory, CPU and process limits.
 */
export async function dockerProvider(apiUrl: string): Promise<RunSandboxProvider | string> {
  const socketPath = env.APP_DOCKER_SOCKET || "/var/run/docker.sock";
  if (!existsSync(socketPath)) return `no Docker socket at ${socketPath}`;
  let image = env.APP_RUN_IMAGE || "", network = env.APP_RUN_NETWORK || "";
  try {
    const ping = await dockerApi(socketPath, "GET", "/_ping");
    if (ping.status !== 200) return `Docker does not answer (${ping.status})`;
    if (!image || !network) {
      // This process's own container: its image, and its compose project's runs network.
      const self = await dockerApi(socketPath, "GET", `/containers/${encodeURIComponent(hostname())}/json`);
      if (self.status !== 200) return "this process is not in a container Docker knows: set APP_RUN_IMAGE and APP_RUN_NETWORK";
      image ||= String(self.json?.Image ?? "");
      const project = self.json?.Config?.Labels?.["com.docker.compose.project"];
      network ||= project ? `${project}_runs` : "";
    }
  } catch (e) { return `Docker is not reachable: ${(e as Error).message}`; }
  if (!image || !network) return "no image or network for run containers";
  if (!apiUrl) return "APP_RUN_API_URL is not set (where run containers reach the API on the runs network)";
  // Per compose project (its runs network): two apps on one Docker host never list, or delete, each other's containers.
  const ns = `${namespace()}.${network}`;
  // Every label value whose containers are ours: this namespace's, and its old default's (a container launched before
  // mold_v0-156, still running or left to reap), until a later cleanup.
  const labelled = boatNamespaces().map((n) => `${n}.${network}`);
  const call = (m: string, p: string, b?: unknown) => dockerApi(socketPath, m, p, b);
  return {
    name: "docker",
    apiUrl: () => apiUrl,
    free: async () => null,
    async launch(spec, onCreated) {
      let step = "create", id = "";
      try {
        const c = await call("POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, runContainerBody({
          image, network, env: spec.env, ttlSeconds: spec.ttlSeconds,
          labels: { [DOCKER_LABEL]: ns, [`org.${NS}.run-id`]: spec.runId, [`org.${NS}.run-sandbox-row`]: String(spec.rowId) },
        }));
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
      // One call per label value: Docker's label filters all have to hold, so two values in one call match nothing.
      const found: any[] = [];
      for (const value of labelled) {
        const r = await call("GET", `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ label: [`${DOCKER_LABEL}=${value}`] }))}`);
        if (r.status !== 200) throw new Error(`docker list: ${r.status}`);
        found.push(...(r.json ?? []));
      }
      return found.map((c: any) => ({ id: String(c.Id), name: String(c.Names?.[0] ?? "").replace(/^\//, ""), state: String(c.State),
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
 * APP_ALLOW_UNSANDBOXED_RUNS=yes (offline tests); never chosen by "auto".
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
      // As root, the runner leases its run's own user (mold_v0-078) as a sandbox's does; else it runs as this user (tests).
      const runAs: Record<string, string> = process.getuid?.() === 0
        ? Object.fromEntries((["APP_RUN_UIDS", "APP_RUN_UID_DIR"] as const).flatMap((k) => (env[k] ? [[k, env[k]!]] : [])))
        : { APP_RUN_SAME_USER: "yes" };
      const { APP_RUN_USER: _u, ...rest } = spec.env;
      const child = spawn(process.execPath, ["--import", "tsx", "src/run-sandbox-runner.ts"], { cwd: ROOT, detached: true, stdio: ["ignore", "ignore", "pipe"],
        env: { PATH: env.PATH ?? "/usr/bin:/bin", ...rest, ...runAs, APP_RUN_LOCKDOWN: "off", APP_ALLOW_UNSANDBOXED_RUNS: "yes" } });
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

/** Where a sandbox's runner reaches the API: APP_RUN_API_URL, else the autoscaler's address for orchestrators. */
const runApiUrl = () => (env.APP_RUN_API_URL || env.APP_INTERNAL_URL || env.PUBLIC_URL || "").replace(/\/$/, "");

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
    if (!/^https:\/\//.test(url)) return "the API's address for sandboxes is not HTTPS (PUBLIC_URL or APP_RUN_API_URL)";
    return boatProvider(url);
  };
  const pick = (p: RunSandboxProvider | string) => (typeof p === "string" ? { provider: null, why: p } : { provider: p, why: "" });
  switch (mode) {
    case "off": return { provider: null, why: "run sandboxes are off on this deployment (APP_RUN_SANDBOX=off)" };
    case "boat": return pick(await boat());
    case "docker": return pick(await dockerProvider(url));
    case "process":
      return RUN_SANDBOXES.unsandboxedAllowed() ? { provider: (processCache ??= processProvider(url)), why: "" }
        : { provider: null, why: "APP_RUN_SANDBOX=process runs runs with no sandbox, refused unless APP_ALLOW_UNSANDBOXED_RUNS=yes (tests only)" };
    case "auto": {
      const b = await boat();
      if (typeof b !== "string") return { provider: b, why: "" };
      const d = await dockerProvider(url);
      if (typeof d !== "string") return { provider: d, why: "" };
      return { provider: null, why: `no sandbox provider is configured: ${b}, and ${d}` };
    }
    default: return { provider: null, why: `APP_RUN_SANDBOX=${mode} is not one of auto, boat, docker, off` };
  }
}

// ---------- the runner's side (src/run-routes.ts) ----------

/** A run sandbox's claim: its own run, once, as "sbx-<row>". Null (and the sandbox torn down) when it cannot be claimed. */
export async function claimForSandbox(runId: string, rowId: number): Promise<Claim | null> {
  const db = await getDb();
  const [row] = await db.query<{ id: number; provider: string }>(
    "UPDATE run_sandboxes SET claimed_at = now() WHERE id = $1 AND run_id = $2 AND claimed_at IS NULL AND state IN ('booting', 'running') RETURNING id, provider", [rowId, runId]);
  if (!row) throw Object.assign(new Error("this sandbox has already claimed its run, or was torn down"), { status: 409 });
  // mold_v0-036: an on-premises runner's sandbox carries out only a run routed on premises, a hosted one only a hosted
  // run (a run moved between the two after its sandbox was launched is left to a sandbox of its new place).
  const [loc] = await db.query<{ runner_location: string }>("/* tenant: internal, the sandbox's own run by id */ SELECT runner_location FROM runs WHERE id = $1", [runId]);
  const onPrem = loc?.runner_location === "on_premises" && onPremAvailable();
  if ((row.provider === "onprem") !== onPrem) {
    await sandboxDone(rowId, "its run is routed to another runner location");
    return null;
  }
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
    if ((env.APP_AUTOSCALE ?? "on").toLowerCase() === "off") { st.note = "APP_AUTOSCALE=off"; return st; }
    // On-premises runners gone silent (mold_v0-036): their sandboxes' tokens go, wherever this ticks.
    await reapSilentRunners().catch((e) => this.log(`on-premises runners: ${(e as Error).message}`));
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
      const reap = async (row: Row, reason: string, failedStart = false, step = "boot") => {
        // Deleted whenever it has an id, listed or not (an unnamed sandbox of a launch cut short is not listed); a
        // delete of one already gone is harmless.
        if (row.sandbox_id && row.provider === p.name) await p.remove(row.sandbox_id).catch((e) => this.log(`remove ${row.sandbox_id}: ${(e as Error).message}`));
        await db.query(`UPDATE run_sandboxes SET state = 'deleted', deleted_at = now(), reap_reason = coalesce(reap_reason, $2),
                          launch_step = CASE WHEN $3 THEN coalesce(launch_step, $4) ELSE launch_step END,
                          launch_error = CASE WHEN $3 THEN coalesce(launch_error, $2) ELSE launch_error END WHERE id = $1`, [row.id, reason.slice(0, 500), failedStart, step]);
        if (failedStart) await this.noteWaiting(row.run_id, `its sandbox did not start (${step}: ${reason})`);
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
        // mold_v0-179: the sandbox's set-up goes on after its launch returned. A failed one is reaped at once, with its
        // step and the sandbox's own error (a failed start: back-off, then the run fails with it); one still going is
        // said on the run, so a queued run says what it waits for.
        let boot: BootStatus | null = null;
        if (row.state === "running" && p.bootStatus && age >= RUN_SANDBOXES.setupCheckSeconds() * 1000) {
          boot = await p.bootStatus(row.sandbox_id).catch((e) => ({ state: "unknown" as const, step: "", detail: (e as Error).message }));
          if (boot.state === "failed") { await reap(row, `its set-up failed at ${boot.step}${boot.detail ? `: ${boot.detail}` : ""}`, true, `setup ${boot.step}`); continue; }
        }
        if (age > RUN_SANDBOXES.bootMinutes() * min) {
          const where = boot?.state === "running" ? ` (its set-up was at ${boot.step})` : boot?.state === "started" ? " (its runner started and did not claim)" : boot?.state === "none" ? " (its set-up never ran)" : "";
          await reap(row, `no claim within ${RUN_SANDBOXES.bootMinutes()} minutes${where}`, true, boot?.state === "running" ? `setup ${boot.step}` : "boot");
        } else if (boot && boot.state !== "unknown") {
          await this.noteWaiting(row.run_id, boot.state === "started" ? "its sandbox is up; its runner is starting" : `its sandbox is being set up (${boot.state === "running" ? boot.step : "starting"})`);
        }
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
      // On-premises runners' sandboxes (mold_v0-036, provider "onprem") are on customers' machines: not counted here.
      const live = await db.query<{ run_id: string }>("SELECT run_id FROM run_sandboxes WHERE state <> 'deleted' AND provider <> 'onprem'");
      const served = new Set(live.map((r) => r.run_id));
      let freeError = "";
      const free = await p.free().catch((e) => { freeError = (e as Error).message; return 0; });
      const cap = Math.max(0, Math.min(RUN_SANDBOXES.maxSandboxes(), live.length + (free ?? Infinity)));
      st.live = live.length; st.cap = cap;
      const notes: string[] = [];
      if (freeError) notes.push(`the provider's limits could not be read (${freeError.slice(0, 200)}): nothing launched`);
      // On Vercel this tick's call is cut off at its deadline: a launch starts only with time left to finish in it.
      const deadline = await invocationDeadline();
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
        if (n >= cap) { notes.push(`at ${cap} run sandboxes (APP_MAX_RUN_SANDBOXES ${RUN_SANDBOXES.maxSandboxes()}${free === null ? "" : `, ${free} free on the plan`})`); break; }
        if (deadline !== null && deadline - Date.now() < LAUNCH_MIN_MS) { notes.push(`this call has ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} s left, too little for a launch: the next tick launches`); break; }
        const launched = await this.launch(p, run, deadline);
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

  /** Say on a queued run why it waits (a `waiting` event, once per reason). Never fails the tick. */
  private async noteWaiting(runId: string, reason: string) {
    await noteRunsWaiting(reason.slice(0, 500), 1, [runId]).catch((e) => this.log(`note on ${runId}: ${(e as Error).message}`));
  }

  /** Insert the row (it counts at once), then create and start the sandbox in the background. Returns the row's id. */
  private async launch(p: RunSandboxProvider, run: ClaimableRun, deadline: number | null = null): Promise<number> {
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
      env: { APP_URL: p.apiUrl(), APP_WORKER_TOKEN: token, APP_RUN_ID: run.id, APP_RUN_UIDS: runUids(),
             APP_RUN_PACK_DIR: packRel, APP_RUN_LOCKDOWN: "on" },
      ttlSeconds: life + 1800, packDirs: packRel ? [packRel] : [], log: (m) => this.log(m),
      // A margin before the call's own deadline: the failure path (a delete, the row) must fit in it too.
      deadlineAt: deadline === null ? null : deadline - 15_000,
    };
    let created = "";
    const job = p.launch(spec, async (sandboxId) => { created = sandboxId; this.inflightIds.add(sandboxId); await db.query("UPDATE run_sandboxes SET sandbox_id = $2 WHERE id = $1", [id, sandboxId]); })
      .then(async () => {
        await db.query("UPDATE run_sandboxes SET state = 'running', ready_at = now() WHERE id = $1 AND state = 'booting'", [id]);
        this.log(`launched run sandbox ${id} for ${run.id}`);
        await this.noteWaiting(run.id, "its sandbox is being set up");
      })
      .catch(async (e) => {
        const step = String((e as { launchStep?: string }).launchStep ?? "unknown"), err = String((e as { launchError?: string }).launchError ?? (e as Error).message);
        const [r] = await db.query<{ sandbox_id: string | null }>(
          "UPDATE run_sandboxes SET state = 'deleted', deleted_at = now(), launch_step = $2, launch_error = $3 WHERE id = $1 AND state <> 'deleted' RETURNING sandbox_id", [id, step, err.slice(0, 500)]);
        await revokeRunSandboxTokens(id);
        await recordComputeEvent({ kind: "launch_failed", sandbox_id: r?.sandbox_id, job_id: run.id, step, reason: `run sandbox: ${err}` });
        this.log(`run sandbox ${id} for ${run.id} failed at ${step}: ${err}`);
        await this.noteWaiting(run.id, `its sandbox did not start (${step}: ${err})`);
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
