/**
 * Orchestrator-sandbox library, shared by the CLI launcher (deploy/boat-orchestrators.ts) and the server's autoscaler
 * (src/autoscaler.ts). API calls only: nothing here runs agent code on the calling machine.
 *
 * Callers set the boat key first (`BOAT.apiKey = …`, from the broker or the vault) and pass an explicit
 * LaunchContext (public server URL, worker token, pod capacity, tuning). The worker token only ever goes into the
 * orchestrator sandbox's 0600 env file.
 *
 * Cold start (measured live 2026-10-10): code upload as a tarball through the files API + `npm ci` there -> service
 * active ~8s after the create call. Optional named snapshot image "<ns>-orch-img-<code hash>" (code + node_modules):
 * ~22s (lazy disk hydration) and a ~170s build per code change, so it is opt-in (APP_ORCH_SNAPSHOT=on).
 */
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BOAT } from "../core/config.js";
import { boatApi, boatCreate, boatExec, BoatError } from "../core/boat.js";
import { sleep } from "../core/util.js";
import { boatNamespace, boatNamespaces } from "../core/boat-namespace.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
/**
 * Sandbox names start with a namespace so two deployments sharing one boat account never touch each other's
 * sandboxes: each autoscaler reaps "orphans" by name prefix. "app" (the VM production) by default; the Vercel
 * preview uses "appv" (core/boat-namespace.ts). Orchestrators get it as a tuning var, so their worker sandboxes carry it too.
 */
export const BOAT_NAMESPACE = boatNamespace();
export const ORCH_PREFIX = `${BOAT_NAMESPACE}-orch-`;
export const WORKER_PREFIX = `${BOAT_NAMESPACE}-w-`;
export const IMAGE_PREFIX = `${BOAT_NAMESPACE}-orch-img-`;
export const IMAGE_BUILDER_NAME = `${BOAT_NAMESPACE}-img-build`;
/** Run sandboxes (mold_v0-055, src/run-sandboxes.ts): one per run, "<ns>-run-<row>-<id>". */
export const RUN_PREFIX = `${BOAT_NAMESPACE}-run-`;
/**
 * Every namespace whose sandboxes are ours: BOAT_NAMESPACE, and the default before mold_v0-156 when APP_BOAT_NAMESPACE
 * is unset (core/boat-namespace.ts): what was launched under it before this release is listed, counted and reaped as
 * ours, never leaked or taken for another deployment's. New names always use BOAT_NAMESPACE (the prefixes above).
 */
export const NAMESPACES = boatNamespaces();
const underAny = (name: string | undefined, part: string) => !!name && NAMESPACES.some((ns) => name.startsWith(`${ns}-${part}`));
/** An orchestrator sandbox of ours (its snapshot images too: "<ns>-orch-img-…" start the same way). */
export const isOrchName = (name?: string) => underAny(name, "orch-");
export const isWorkerName = (name?: string) => underAny(name, "w-");
export const isRunName = (name?: string) => underAny(name, "run-");
export const isImageName = (name?: string) => underAny(name, "orch-img-");
export const isImageBuilderName = (name?: string) => !!name && NAMESPACES.some((ns) => name === `${ns}-img-build`);
/** An orchestrator or a worker of ours: what this deployment holds on the boat plan. */
export const isOursName = (name?: string) => isOrchName(name) || isWorkerName(name);
export const MAX_TTL_SECONDS = 2_592_000; // 30 days: boat's maximum numeric TTL (docs.boat.dev/long-running-tasks)
export const HOME = "/home/user/app";
/**
 * Unprivileged system user the orchestrator service runs as (no sudo); created by configure(). A sandbox set up before
 * mold_v0-156 has its old account too, which nothing runs as once configure has installed the unit again (no sudo, no
 * login shell, owns only its own home): it goes with the sandbox (recycled on every deploy, at most 30 days).
 */
export const SERVICE_USER = "appsvc";
export const UNIT = "app-orchestrator";
/** The launcher's root-owned host marker (core/host-guard.ts reads it). */
export const MARKER_DIR = "/etc/app";
/**
 * The service unit, home and marker directory an orchestrator sandbox set up before mold_v0-097 has (the first product's
 * name). A sandbox still running them is moved over when the next release configures it (configure: the old unit
 * stopped and removed, its home with its env file and its marker deleted), and is stopped whichever unit it runs
 * (stopService). LEGACY_UNIT_SH picks the unit a sandbox runs, for status and logs.
 */
export const LEGACY_UNIT = "octillion-orchestrator", LEGACY_HOME = "/home/user/octillion", LEGACY_MARKER_DIR = "/etc/octillion";
export const LEGACY_UNIT_SH = `u=${UNIT}; [ -f /etc/systemd/system/${UNIT}.service ] || [ ! -f /etc/systemd/system/${LEGACY_UNIT}.service ] || u=${LEGACY_UNIT}`;
const CHUNK = 3_500_000; // raw bytes per files-API PUT (limit: 5 MiB after base64 decoding)

/** Non-secret tuning knobs that may go into an orchestrator's env file (nothing else is ever written). */
export const TUNING_VARS = ["ORCHESTRATOR_MODEL", "MAX_SESSION_MINUTES", "MAX_BUDGET_USD", "MAX_USER_TURNS", "ORCHESTRATOR_THINKING", "BOAT_SANDBOX_SIZE",
  "RESEARCH_MAX_COST_USD", "APP_ORCH_IDLE_MINUTES", "MAX_AGENT_TURNS", "GIVE_UP_RUNS", "ORCHESTRATOR_JOB", "APP_ZED_ACP", "APP_EGRESS", "APP_BOAT_NAMESPACE"] as const;

export interface LaunchContext {
  url: string;               // public HTTPS server URL
  workerToken: string;       // goes ONLY into the orchestrator sandbox's 0600 env file
  podCapacity: number;
  tuning?: Record<string, string>;
  root?: string;             // repo root holding orchestrator/ + harnesses/registry.json
  log?: (msg: string) => void;
  placeholderToken?: boolean; // selftest: never ship the real token
}

// ---------------------------------------------------------------- budget (pure; unit-tested)

export interface BoatLimits { activeSandboxes: number; startsPerMinute: number; startsPerHour: number; startsPerDay: number; activeNow: number }
export interface Budget {
  plan: number; perOrchestrator: number; maxOrchestrators: number; requested: number; requestedSandboxes: number;
  otherActive: number; available: number; ok: boolean; startsPerDay: number; sessionsPerDayCeiling: number; reason?: string;
}

/** Each orchestrator = 1 sandbox + up to podCapacity worker sandboxes, all counted against plan concurrency. */
export function computeBudget(limits: BoatLimits, n: number, podCapacity: number, oursActive = 0): Budget {
  const perOrchestrator = 1 + podCapacity;
  const otherActive = Math.max(0, limits.activeNow - oursActive);
  const available = limits.activeSandboxes - otherActive;
  const requestedSandboxes = n * perOrchestrator;
  const maxOrchestrators = Math.max(0, Math.floor(available / perOrchestrator));
  const ok = n >= 0 && requestedSandboxes <= available;
  return {
    plan: limits.activeSandboxes, perOrchestrator, maxOrchestrators, requested: n, requestedSandboxes, otherActive, available, ok,
    startsPerDay: limits.startsPerDay, sessionsPerDayCeiling: Math.max(0, limits.startsPerDay - n),
    reason: ok ? undefined : `${n} orchestrators x (1 + ${podCapacity}) = ${requestedSandboxes} sandboxes > ${available} available (plan ${limits.activeSandboxes} - ${otherActive} other active); max ${maxOrchestrators}`,
  };
}

export async function boatLimits(): Promise<BoatLimits> {
  const l = await boatApi("/limits");
  return {
    activeSandboxes: Number(l?.currentLimits?.activeSandboxes ?? l?.maxActiveSandboxes ?? 100),
    startsPerMinute: Number(l?.startLimits?.perMinute ?? 12), startsPerHour: Number(l?.startLimits?.perHour ?? 60),
    startsPerDay: Number(l?.startLimits?.perDay ?? 200), activeNow: Number(l?.activeSandboxes ?? 0),
  };
}

// ---------------------------------------------------------------- boat helpers

export interface Sb { id: string; name?: string; state: string; createdAt?: string; archiveAfter?: string | null; type?: string }

export async function listSandboxes(): Promise<Sb[]> {
  const all: Sb[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await boatApi(`/sandboxes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
    all.push(...(r?.sandboxes ?? []));
    cursor = r?.pageInfo?.nextCursor ?? null;
    if (!cursor) break;
  }
  return all;
}

export const isLive = (s: Sb) => !["archived", "archiving", "cancelled", "error", "deleted"].includes(s.state);
export const orchIdOf = (sandboxId: string) => `orch-${sandboxId.replace(/^bx_/, "")}`;
export const workerPrefixOf = (orchId: string) => `${WORKER_PREFIX}${orchId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
/**
 * Every name start an orchestrator's workers may have: under each of NAMESPACES (an orchestrator launched before
 * mold_v0-156 names its workers under the old default it was given). Ends with "-": an id is never another's prefix.
 */
export const workerPrefixesOf = (orchId: string) => NAMESPACES.map((ns) => `${ns}-w-${orchId}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-") + "-");
export const isWorkerOf = (name: string | undefined, orchId: string) => !!name && workerPrefixesOf(orchId).some((p) => name.startsWith(p));

export async function waitReady(id: string, timeoutMs = 300_000) {
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await sleep(2000)) {
    const st = (await boatApi(`/sandboxes/${id}`)).sandbox.state;
    if (["ready", "idle", "running"].includes(st)) return;
    if (["error", "cancelled"].includes(st)) throw new Error(`sandbox ${id} is ${st}`);
  }
  throw new Error(`sandbox ${id} not ready after ${timeoutMs / 1000}s`);
}

/** A boat failure worth another try: gateway errors (502/503/504, e.g. "sandbox_direct_failed: Socket is closed"), rate limits, dropped connections. */
const transient = (e: unknown) => e instanceof BoatError ? [429, 502, 503, 504].includes(e.status)
  : e instanceof Error && /fetch failed|socket|ECONNRESET|ETIMEDOUT|UND_ERR|aborted|timeout/i.test(`${e.message} ${(e as { cause?: Error }).cause?.message ?? ""}`);

/** Writes a file. Writing the same content to the same path twice is harmless, so transient failures retry: 5 tries, 1, 2, 4, 8 s apart. */
export async function put(id: string, p: string, content: string, encoding: "utf8" | "base64" = "utf8") {
  for (let i = 0; ; i++) {
    try { return void await boatApi(`/sandboxes/${id}/files`, { method: "PUT", json: { path: p, content, encoding } }); }
    catch (e) {
      if (i >= 4 || !transient(e)) throw e;
      await sleep(((e as BoatError).retryAfterMs ?? 0) || 1000 * 2 ** i);
    }
  }
}

export async function run(id: string, cmd: string, timeout = 300): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const r = await boatExec(id, cmd, timeout);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

export async function deleteSandbox(id: string) {
  await boatApi(`/sandboxes/${id}`, { method: "DELETE", headers: { "X-Ascii-Confirm-Delete": id } }).catch((e) => {
    if (!(e instanceof BoatError && e.status === 404)) throw e;
  });
}

// ---------------------------------------------------------------- code: files, hash, tarball

const CODE_EXCLUDE = /(^|\/)(node_modules|\.pi-upstream|pi-upstream|test)(\/|$)|^orchestrator\/harnesses\/fixtures(\/|$)/;

/** The files an orchestrator needs: orchestrator/ (no node_modules, Pi clone, tests, fixtures) + the registry. */
export function codeFiles(root = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (CODE_EXCLUDE.test(r)) continue;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  walk("orchestrator");
  if (statSync(path.join(root, "harnesses/registry.json"), { throwIfNoEntry: false })) out.push("harnesses/registry.json");
  return out.sort();
}

/**
 * The files a run sandbox needs (mold_v0-055): the orchestrator's (for its tsx, installed by the same `npm ci`), the code's
 * package.json (its module type only), the run
 * sandbox runner and every file it imports (static imports, followed from src/run-sandbox-runner.ts; type-only imports
 * and the harness's in-process dynamic imports are not followed: the sandbox never uses them), and the given pack
 * directories (relative to the root). Refuses a runner import that is not a relative file or a node built-in.
 */
export function runnerCodeFiles(root = REPO_ROOT, packDirs: string[] = []): string[] {
  const out = new Set(codeFiles(root));
  const seen = new Set<string>();
  const visit = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel); out.add(rel);
    const text = readFileSync(path.join(root, rel), "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/gm)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      if (!spec.startsWith(".")) throw new Error(`the run sandbox runner imports ${spec} (from ${rel}): it may import only node's modules and its own files`);
      let dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (dep.endsWith(".js") && statSync(path.join(root, dep.replace(/\.js$/, ".ts")), { throwIfNoEntry: false })) dep = dep.replace(/\.js$/, ".ts");
      if (dep.startsWith("..")) throw new Error(`the run sandbox runner imports ${spec} outside the code`);
      visit(dep);
    }
  };
  visit("src/run-sandbox-runner.ts");
  out.add("package.json"); // the code's module type (ES modules); nothing is installed from it
  for (const d of packDirs) {
    const rel = path.posix.normalize(d.split(path.sep).join("/"));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`a pack directory outside the code: ${d}`);
    const walk = (r: string) => {
      for (const e of readdirSync(path.join(root, r), { withFileTypes: true })) {
        const x = `${r}/${e.name}`;
        if (e.name === "node_modules" || e.name === ".git") continue;
        if (e.isDirectory()) walk(x); else if (e.isFile()) out.add(x);
      }
    };
    walk(rel);
  }
  return [...out].sort();
}

/** Content hash of the orchestrator code: keys the named snapshot image. */
export function codeHash(root = REPO_ROOT): string {
  const h = createHash("sha256");
  for (const f of codeFiles(root)) { h.update(f + "\0"); h.update(readFileSync(path.join(root, f))); h.update("\0"); }
  return h.digest("hex").slice(0, 16);
}

/** A gzipped ustar archive of the code, built in-process: serverless hosts (Vercel) have no `tar` binary. File modes
 *  are kept (the setup scripts are executable); owners, times and order are fixed so the bytes depend on content only. */
export function tarball(root = REPO_ROOT, files = codeFiles(root)): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = readFileSync(path.join(root, f));
    const mode = statSync(path.join(root, f)).mode & 0o777;
    blocks.push(tarHeader(f, data.length, mode), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function tarHeader(name: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(512);
  // Names over 100 bytes go into the ustar prefix field, split at a slash.
  let prefix = "", base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${name}`);
    prefix = name.slice(0, cut); base = name.slice(cut + 1);
  }
  const put = (v: string, off: number, len: number) => h.write(v, off, len, "utf8");
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(base, 0, 100); put(oct(mode, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12); put(oct(0, 12), 136, 12); put("        ", 148, 8); put("0", 156, 1);
  put("ustar\0", 257, 6); put("00", 263, 2); put(prefix, 345, 155);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export async function uploadCode(id: string, root = REPO_ROOT, files?: string[]): Promise<number> {
  const tgz = tarball(root, files);
  await run(id, `install -d -m 700 ${HOME} && rm -rf ${HOME}/code.tgz.part*`, 30);
  const parts = Math.ceil(tgz.length / CHUNK);
  for (let i = 0; i < parts; i++) await put(id, `${HOME}/code.tgz.part${String(i).padStart(3, "0")}`, tgz.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64"), "base64");
  const r = await run(id, `set -e; cd ${HOME}; cat code.tgz.part* > code.tgz; rm -f code.tgz.part*; rm -rf app.new; mkdir app.new; tar -xzf code.tgz -C app.new; rm code.tgz
cd app.new/orchestrator && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>npm.err || { tail -20 npm.err >&2; exit 1; }
cd ${HOME}; rm -rf app.old; [ -d app ] && mv app app.old; mv app.new app; rm -rf app.old`, 600);
  if (r.code !== 0) throw new Error(`code deploy failed: ${r.stderr.slice(-800)}`);
  return tgz.length;
}

// ---------------------------------------------------------------- configure / preflight / service

/** Env file (0600), host marker (root-owned) and systemd unit (Restart=on-failure: an idle exit 0 stays down). */
export async function configure(id: string, orchId: string, ctx: LaunchContext) {
  const tuning = Object.entries(ctx.tuning ?? {}).filter(([k, v]) => (TUNING_VARS as readonly string[]).includes(k) && /^[A-Za-z0-9._-]{1,32}$/.test(v)).map(([k, v]) => `${k}=${v}`);
  const envBody = [
    `APP_URL=${ctx.url}`, `APP_WORKER_TOKEN=${ctx.placeholderToken ? "selftest-placeholder-not-a-token" : ctx.workerToken}`, `ORCHESTRATOR_ID=${orchId}`,
    "RUNNER=boat", `POD_CAPACITY=${ctx.podCapacity}`, "APP_HOST_ROLE=boat-orchestrator", ...tuning, "",
  ].join("\n");
  await run(id, `install -d -m 700 ${HOME}`, 30);
  await put(id, `${HOME}/orchestrator.env.new`, envBody);
  const unit = `[Unit]
Description=Orchestrator (${orchId})
After=network-online.target
[Service]
User=${SERVICE_USER}
WorkingDirectory=${HOME}/app
EnvironmentFile=${HOME}/orchestrator.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=/var/lib/${SERVICE_USER}
NoNewPrivileges=true
ExecStart=${HOME}/app/orchestrator/node_modules/.bin/tsx orchestrator/main.ts
Restart=on-failure
RestartSec=10
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=240
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
`;
  await put(id, `${HOME}/${UNIT}.service`, unit);
  const r = await run(id, `set -e; cd ${HOME}
{ cat orchestrator.env.new; env | grep -E '^(BOAT_ID|BOX_ID)=' || true; } > orchestrator.env; rm -f orchestrator.env.new; chmod 600 orchestrator.env
# The service runs as ${SERVICE_USER}: no sudo, no login shell (docs/security.md). It reads the code (made world-readable,
# the boat user still owns and deploys it) and writes only to its own home and the temp dir; systemd reads the env file.
id ${SERVICE_USER} >/dev/null 2>&1 || sudo useradd -r -m -d /var/lib/${SERVICE_USER} -s /usr/sbin/nologin ${SERVICE_USER}
sudo chmod 711 /home/user; sudo chmod 755 ${HOME}; sudo chmod -R a+rX ${HOME}/app
sudo install -d -m 755 ${MARKER_DIR}
printf '%s' '{"role":"boat-orchestrator","sandbox_id":"${id}","orchestrator_id":"${orchId}"}' | sudo tee ${MARKER_DIR}/host-role >/dev/null
sudo chmod 644 ${MARKER_DIR}/host-role
# Set up before mold_v0-097: the old unit stops (gracefully, as a restart does) and goes, with its home and marker, so
# one sandbox never runs two orchestrators.
if [ -f /etc/systemd/system/${LEGACY_UNIT}.service ]; then sudo systemctl disable --now ${LEGACY_UNIT} || true; sudo rm -f /etc/systemd/system/${LEGACY_UNIT}.service; fi
sudo rm -rf ${LEGACY_HOME} ${LEGACY_MARKER_DIR}
sudo install -m 644 ${UNIT}.service /etc/systemd/system/${UNIT}.service && rm -f ${UNIT}.service
sudo systemctl daemon-reload`, 360);
  if (r.code !== 0) throw new Error(`configure failed: ${r.stderr.slice(-500)}`);
}

/** From inside the sandbox, with the orchestrator's own env: is APP_URL reachable over public HTTPS? */
export async function preflight(id: string): Promise<{ ok: boolean; reason: string }> {
  const r = await run(id, `cd ${HOME}/app/orchestrator && set -a && . ${HOME}/orchestrator.env && set +a && node_modules/.bin/tsx deploy/in-sandbox.ts preflight`, 60);
  try { const j = JSON.parse(r.stdout.trim().split("\n").pop()!); return { ok: !!j.ok, reason: j.reason }; }
  catch { return { ok: false, reason: (r.stderr || r.stdout).slice(-300) }; }
}

export async function guard(id: string): Promise<any> {
  const r = await run(id, `cd ${HOME}/app/orchestrator && set -a && . ${HOME}/orchestrator.env && set +a && node_modules/.bin/tsx deploy/in-sandbox.ts guard; RUNNER=local node_modules/.bin/tsx deploy/in-sandbox.ts guard | sed 's/^/LOCAL /'`, 60);
  const lines = r.stdout.trim().split("\n");
  const parse = (l?: string) => { try { return JSON.parse(l ?? ""); } catch { return { raw: l }; } };
  return { boat: parse(lines.find((l) => l.startsWith("{"))), runner_local: parse(lines.find((l) => l.startsWith("LOCAL "))?.slice(6)) };
}

export async function startService(id: string): Promise<string> {
  const r = await run(id, `sudo systemctl enable --now ${UNIT} && sleep 2 && systemctl is-active ${UNIT}`, 60);
  return (r.stdout.trim() || r.stderr.trim()).split("\n").pop() ?? "";
}

/** Graceful stop: SIGTERM -> the orchestrator kills its sessions (deleting their workers) and leaves the fleet. */
export async function stopService(id: string): Promise<string> {
  const r = await run(id, `${LEGACY_UNIT_SH}; sudo systemctl stop $u; systemctl is-active $u || true`, 300).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
  return r.stdout.trim() || "stopped";
}

// ---------------------------------------------------------------- image snapshot (cold start)

export const imageName = (hash: string) => `${IMAGE_PREFIX}${hash}`.slice(0, 63);

export async function imageStatus(name: string): Promise<"ready" | "saving" | "failed" | "missing"> {
  try { return (await boatApi(`/named-snapshots/${encodeURIComponent(name)}`))?.snapshot?.status ?? "missing"; }
  catch (e) { if (e instanceof BoatError && e.status === 404) return "missing"; throw e; }
}

/**
 * Build the orchestrator image for the current code: a builder sandbox gets the code + `npm ci` (no env file, no
 * marker, no token), is saved as the named snapshot, then deleted. Older orchestrator snapshot images (any of NAMESPACES) are removed.
 */
export async function buildImage(ctx: Pick<LaunchContext, "root" | "log">): Promise<{ name: string; ms: number }> {
  const t0 = Date.now();
  const name = imageName(codeHash(ctx.root));
  const c = await boatCreate({ type: "small", ttlSeconds: 1800, noEnv: true });
  const id: string = c.sandbox.id;
  try {
    await boatApi(`/sandboxes/${id}`, { method: "PATCH", json: { name: IMAGE_BUILDER_NAME } }).catch(() => {});
    await waitReady(id);
    await uploadCode(id, ctx.root);
    await boatApi("/named-snapshots", { method: "POST", json: { sandboxId: id, name } });
    for (let i = 0; i < 180; i++) {
      const st = await imageStatus(name);
      if (st === "ready") break;
      if (st === "failed") throw new Error(`named snapshot ${name} failed`);
      await sleep(5000);
    }
    if ((await imageStatus(name)) !== "ready") throw new Error(`named snapshot ${name} not ready after 15 min`);
  } finally {
    await deleteSandbox(id).catch(() => {});
  }
  // Keep only the current image (each named snapshot above the free 10 costs money).
  const all = (await boatApi("/named-snapshots").catch(() => null))?.snapshots ?? [];
  for (const s of all) if (typeof s?.name === "string" && isImageName(s.name) && s.name !== name)
    await boatApi(`/named-snapshots/${encodeURIComponent(s.name)}`, { method: "DELETE" }).catch(() => {});
  ctx.log?.(`orchestrator image ${name} ready in ${Math.round((Date.now() - t0) / 1000)}s`);
  return { name, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- launch

export interface LaunchResult { sandboxId: string; orchId: string; fromImage: boolean; timings: Record<string, number>; preflight: { ok: boolean; reason: string } }

/** What `launchOrchestrator` throws: the message says "<step> (<n>s): <error>"; the parts are also kept apart. */
export interface LaunchError extends Error { launchStep: string; launchError: string }
const launchError = (e: unknown, step: string, t0: number): LaunchError => {
  const err = e instanceof Error ? e : new Error(String(e));
  const raw = err.message;
  // Say which step failed and how long in (a bare boat error does not).
  return Object.assign(err, { message: `${step} (${Math.round((Date.now() - t0) / 1000)}s): ${raw}`, launchStep: step, launchError: raw });
};

/**
 * Create one orchestrator sandbox and start it. `onCreated` fires right after the create (so callers can record the
 * sandbox id before anything else can fail). Throws a LaunchError, after deleting the sandbox, if anything fails.
 */
/** Orchestrators always run on boat's small machine (BOAT_PRICE_PER_HOUR.small): the Compute page's sandbox estimate. */
export const ORCH_SANDBOX_TYPE = "small";

export async function launchOrchestrator(ctx: LaunchContext, opts: { image?: string | null; ttlSeconds?: number; onCreated?: (sandboxId: string, orchId: string) => Promise<void> | void; requirePreflight?: boolean } = {}): Promise<LaunchResult> {
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  let step = "create";
  const mark = (k: string) => { timings[k] = Date.now() - t0; };
  let c: any;
  try { c = await boatCreate({ type: ORCH_SANDBOX_TYPE, ttlSeconds: opts.ttlSeconds ?? MAX_TTL_SECONDS, noEnv: true, snapshots: false, ...(opts.image ? { from: opts.image } : {}) }); }
  catch (e) { throw launchError(e, step, t0); }
  const id: string = c.sandbox.id;
  const orchId = orchIdOf(id);
  mark("created");
  try {
    step = "name";
    await opts.onCreated?.(id, orchId);
    await boatApi(`/sandboxes/${id}`, { method: "PATCH", json: { name: `${ORCH_PREFIX}${id.replace(/^bx_/, "")}` } });
    step = "ready";
    await waitReady(id);
    mark("ready");
    let fromImage = false;
    if (opts.image) fromImage = (await run(id, `test -x ${HOME}/app/orchestrator/node_modules/.bin/tsx && echo yes || echo no`, 30)).stdout.includes("yes");
    step = "code upload";
    if (!fromImage) { await uploadCode(id, ctx.root); mark("code"); }
    step = "configure";
    await configure(id, orchId, ctx);
    mark("configured");
    step = "preflight";
    const pf = await preflight(id);
    mark("preflight");
    if (!pf.ok && opts.requirePreflight !== false) throw new Error(`preflight failed: ${pf.reason}`);
    step = "start";
    const svc = await startService(id);
    mark("started");
    // "activating" = (re)starting; a crash loop never checks in and the autoscaler's stale reaper deletes it.
    if (svc !== "active" && svc !== "activating") throw new Error(`service is ${svc}`);
    return { sandboxId: id, orchId, fromImage, timings, preflight: pf };
  } catch (e) {
    await deleteSandbox(id).catch(() => {});
    throw launchError(e, step, t0);
  }
}

/** BOAT.apiKey must be set by the caller; this just documents the dependency. */
export const requireBoatKey = () => { if (!BOAT.apiKey) throw new Error("boat key not set"); };
