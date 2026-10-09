#!/usr/bin/env node
/**
 * sandbox:prewarm — build the sandbox templates of a BUILT agent ONE AT A TIME, on the server that will serve it.
 *
 * For a deployment that is not on Vercel (docs/self-hosting/SANDBOX.md). On Vercel, `eve build` provisions the
 * templates inside the Vercel builder and this script is not used.
 *
 * WHY IT EXISTS. A production eve server cannot build a template on demand ("Sandbox template … is not provisioned
 * … Run eve build or invoke prewarmAppSandboxes() before serving traffic"), so they must exist before it starts.
 * `eve start` does build them first, but (measured, eve 0.25.1, a 4-vCPU host):
 *
 *   · all at once: nine microVMs booted together, one timed out waiting for its agent relay, and the whole start
 *     exited 1 (eve's prewarm is a bare Promise.all with no concurrency setting);
 *   · a killed start leaves its lock directories behind, and the next start then sits at "initializing 9 sandbox
 *     templates..." in silence (eve only treats a lock as stale after 30 minutes, and gives up at 15);
 *   · its parent process holds 2.3-2.5 GB for the life of the service.
 *
 * So: clear locks nobody holds, prewarm serially (one template, then the next; a failed one is retried, the rest
 * still run), report, and exit. Then start the server itself: `node .output/server/index.mjs`.
 *
 * AND IT REFUSES TO BUILD ON EVE'S DEFAULTS. Under SANDBOX_BACKEND=microsandbox every agent node of the BUILT agent
 * (the root, every specialist, every pack specialist) must have a microsandbox backend created from the SANDBOX_*
 * settings: at least SANDBOX_CPUS virtual CPUs and the whole network deny list. `npm run build:eve` arranges that
 * (scripts/lib/sandbox-overlay.mjs); a node without it would start on eve's default of 1 vCPU and allow-all egress,
 * which on the first real server hung a template for 1h50m. Such a node is named and nothing is started.
 *
 * AND IT DOES NOT HANG. A template that is not ready within --template-timeout seconds (default 600) has its VM
 * killed and is reported with its node and the settings it was started with; the templates after it are not tried.
 *
 *   npm run build:eve          # on the server, at its final path (the build output is not relocatable)
 *   npm run sandbox:prewarm    # this script
 *
 *   --retries <n>     extra attempts per template after a failure (default 1)
 *   --link-runtime    SANDBOX_BACKEND=microsandbox only: if the microsandbox runtime is not installed for this user,
 *                     link the copy npm already installed (node_modules/@superradcompany/microsandbox-*) into
 *                     ~/.microsandbox/{bin,lib}. No download, no system package.
 *   --template-timeout <s>  seconds one template may take per attempt (default 600; or SANDBOX_PREWARM_TIMEOUT_S).
 *                     A template that takes longer is not retried: its VM is killed and the run stops, exit 1.
 *   --plan            start nothing: print, as JSON, every agent node's sandbox in the built agent (definition,
 *                     backend, template key, the SANDBOX_* settings it carries) and which would be refused. Exit 1
 *                     if any would be.
 *   --locks-only      only clear stale locks, then exit
 *   --force-locks     remove every template lock, held or not (only when you know nothing else is prewarming: a
 *                     dead owner's process id can be reused by an unrelated process, which then looks "running")
 *   --self-test       run this file's own checks (no eve, no sandbox, no network) and exit
 *
 * Run it as the user the server runs as, with the server's environment (SANDBOX_BACKEND and friends): templates and
 * locks live under <app>/.eve/sandbox-cache and, for microsandbox, that user's ~/.microsandbox.
 *
 * It imports eve's internal modules by path (the public package exports no serial prewarm). That is checked
 * at start and said plainly if an eve upgrade moves them.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const APP_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

/* ---- stale locks ------------------------------------------------------------------------------------------------ */

/** eve's own lock directory for template prewarm (execution/sandbox/template-prewarm-lock.js). */
export const locksRoot = (appRoot) => join(appRoot, ".eve", "sandbox-cache", "template-locks");

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // it exists, it is someone else's
  }
}

/** A lock with no readable owner is given this long to be a lock that is still being written. */
const OWNERLESS_GRACE_MS = 60_000;

/**
 * Remove every template lock whose owner is gone. Returns `{ removed: [...], held: [...] }`.
 *
 * eve writes `<key>.lock/owner.json` = `{ createdAt, pid }` and removes the directory when the prewarm ends. A lock
 * whose pid is not running was left by a process that was killed; it is removed. A lock whose pid IS running is
 * someone's prewarm in progress; it is left alone and reported. A lock with no readable owner is removed once it is
 * older than a minute.
 */
export function clearStaleLocks(appRoot, { alive = pidAlive, now = Date.now(), self = process.pid, force = false } = {}) {
  const root = locksRoot(appRoot);
  const removed = [];
  const held = [];
  if (!existsSync(root)) return { removed, held };
  for (const backend of readdirSync(root)) {
    const dir = join(root, backend);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".lock")) continue;
      const lock = join(dir, name);
      let pid = null;
      try {
        pid = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid;
      } catch {
        pid = null;
      }
      const label = `${backend}/${name}`;
      if (force) {
        rmSync(lock, { recursive: true, force: true });
        removed.push({ lock: label, pid });
        continue;
      }
      if (Number.isInteger(pid) && pid !== self && alive(pid)) {
        held.push({ lock: label, pid });
        continue;
      }
      if (pid === null && now - statSync(lock).mtimeMs < OWNERLESS_GRACE_MS) {
        held.push({ lock: label, pid: null });
        continue;
      }
      rmSync(lock, { recursive: true, force: true });
      removed.push({ lock: label, pid });
    }
  }
  return { removed, held };
}

/* ---- one at a time ---------------------------------------------------------------------------------------------- */

/**
 * A `dispatch` for eve's prewarm that runs the templates one after another, whatever order eve asks in, retries a
 * failed one, and keeps going after a failure so one bad template does not leave the rest unbuilt.
 *
 * eve calls `dispatch` for every template at once and awaits them all, so the first rejection ends ITS wait while the
 * queue here is still running; `settled()` resolves when the queue is empty, with every outcome.
 */
export function serialDispatch({ retries = 1, log = () => {}, beforeRetry = () => {}, timeoutMs = 0, onTimeout = async () => {}, describe = () => "" } = {}) {
  // No lock is touched here: eve takes each template's lock (in this process) before it calls dispatch and releases
  // it when the returned promise settles, so a retry runs inside the lock it already holds.
  let chain = Promise.resolve();
  const outcomes = [];
  let running = 0;
  let maxRunning = 0;
  /** Set by the first template that timed out. Nothing is started after it: what hung one will hang the next. */
  let stopped = null;
  const dispatch = ({ backend, input }) => {
    const run = async () => {
      const started = Date.now();
      if (stopped) {
        const error = new Error(`not attempted: template ${stopped} timed out before it`);
        outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: false, skipped: true, attempts: 0, ms: 0, error: error.message });
        throw error;
      }
      let lastError;
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        running++;
        maxRunning = Math.max(maxRunning, running);
        let timer;
        try {
          const work = Promise.resolve().then(() => backend.prewarm(input));
          work.catch(() => {}); // after a timeout nobody awaits it: its late rejection (the VM was killed) must not crash the report
          const result = await (timeoutMs > 0
            ? Promise.race([
                work,
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new PrewarmTimeout(timeoutMs)), timeoutMs);
                }),
              ])
            : work);
          outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: true, reused: Boolean(result?.reused), attempts: attempt, ms: Date.now() - started });
          return result;
        } catch (error) {
          lastError = error;
          if (error instanceof PrewarmTimeout) {
            // The attempt is still running somewhere behind `work`: kill what it started, then stop. No retry: a
            // template that produced nothing in this long is not a flake, and the operator is waiting.
            stopped = input.templateKey;
            let killed = "";
            try {
              killed = String((await onTimeout({ backend, input })) ?? "");
            } catch (killError) {
              killed = `could not kill its VM: ${String(killError?.message ?? killError)}`;
            }
            const settings = describe({ backend, input });
            const message = `timed out after ${Math.round(timeoutMs / 1000)}s on attempt ${attempt}${settings ? ` (${settings})` : ""}${killed ? `; ${killed}` : ""}`;
            log(`template ${input.templateKey} (${backend.name}) ${message}`);
            outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: false, timedOut: true, attempts: attempt, ms: Date.now() - started, error: message });
            throw new Error(`template ${input.templateKey} ${message}`);
          }
          log(`template ${input.templateKey} (${backend.name}) failed on attempt ${attempt}: ${String(error?.message ?? error).slice(0, 300)}`);
          if (attempt <= retries) await beforeRetry({ backend, input, attempt });
        } finally {
          clearTimeout(timer);
          running--;
        }
      }
      outcomes.push({ templateKey: input.templateKey, backend: backend.name, ok: false, attempts: retries + 1, ms: Date.now() - started, error: String(lastError?.message ?? lastError) });
      throw lastError;
    };
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  };
  return { dispatch, outcomes, settled: async () => { await chain; return outcomes; }, maxConcurrency: () => maxRunning, stoppedAt: () => stopped };
}

class PrewarmTimeout extends Error {
  constructor(ms) {
    super(`no result after ${ms} ms`);
  }
}

/* ---- killing a template VM that hung ---------------------------------------------------------------------------- */

/** eve names a template's build VM `eve-sbx-tpl-tmp…` (execution/sandbox/bindings/microsandbox-lifecycle.js). */
const TEMPLATE_VM_NAME = "eve-sbx-tpl-tmp";

/** Every process this user can see: `{ pid, ppid, uid, cmdline }`. Linux /proc; empty elsewhere. */
export function listProcesses() {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // "pid (comm) state ppid …": comm may hold spaces and parentheses, so read from the LAST ")".
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
      out.push({ pid: Number(name), ppid, uid: statSync(`/proc/${name}`).uid, cmdline });
    } catch {
      /* it exited while we looked */
    }
  }
  return out;
}

/**
 * The processes of a template VM this prewarm started: every descendant of this process, and every process of this
 * user whose command line names a template build VM (the VM's runner may be detached from us). Never this process.
 */
export function templateVmProcesses(processes, { self = process.pid, uid = process.getuid?.() } = {}) {
  const children = new Map();
  for (const p of processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);
  const found = new Map();
  const walk = (pid) => {
    for (const child of children.get(pid) ?? []) {
      if (found.has(child.pid) || child.pid === self) continue;
      found.set(child.pid, child);
      walk(child.pid);
    }
  };
  walk(self);
  for (const p of processes) if (p.pid !== self && p.uid === uid && p.cmdline.includes(TEMPLATE_VM_NAME)) found.set(p.pid, p);
  return [...found.values()].sort((a, b) => a.pid - b.pid);
}

/** SIGKILL them. Returns one line saying what was killed, for the report. */
export function killTemplateVm({ processes = listProcesses(), kill = (pid) => process.kill(pid, "SIGKILL"), self = process.pid, uid = process.getuid?.() } = {}) {
  const targets = templateVmProcesses(processes, { self, uid });
  const killed = [];
  for (const p of targets) {
    try {
      kill(p.pid);
      killed.push(p.pid);
    } catch {
      /* already gone */
    }
  }
  return killed.length ? `killed its VM (pid ${killed.join(", ")})` : "found no VM process of its to kill";
}

/* ---- every node's sandbox, in the BUILT agent -------------------------------------------------------------------- */

/** The key a build-time wrapper tags its backend with (scripts/lib/sandbox-overlay.mjs `SETTINGS_TAG`). */
const SETTINGS_TAG = Symbol.for("app.sandbox.settings");
const EVE_DEFAULT_SANDBOX = "eve:default-sandbox";

/** A backend eve resolves on first use (`lazyBackend`): its `name` is a getter. That is what "no backend named" is. */
const isLazyBackend = (backend) => typeof Object.getOwnPropertyDescriptor(backend ?? {}, "name")?.get === "function";

/** The SANDBOX_* settings a backend was created from, or null: `{ cpus, memoryMiB, deny }`. */
export function backendSettings(backend) {
  const tag = backend?.[SETTINGS_TAG];
  if (!tag || typeof tag !== "object") return null;
  const policy = tag.networkPolicy;
  return { cpus: tag.cpus, memoryMiB: tag.memoryMiB, deny: policy && typeof policy === "object" ? [...(policy.subnets?.deny ?? [])] : [] };
}

/** `cpus=2, memoryMiB=1024, deny=[…]` for a report line; says so when the backend carries no settings. */
export function describeBackend(backend) {
  const s = backendSettings(backend);
  if (s) return `cpus=${s.cpus}, memoryMiB=${s.memoryMiB}, deny=[${s.deny.join(" ")}]`;
  return isLazyBackend(backend) ? "eve's default backend options: 1 vCPU, 1024 MiB, allow-all egress" : "backend options unknown: not created from the SANDBOX_* settings";
}

/**
 * Why this node's sandbox must not be started under SANDBOX_BACKEND=microsandbox, or null. `required` is
 * `{ cpus, deny }` from this process's own SANDBOX_* settings. Reads nothing but the node's resolved definition, and
 * deliberately not `backend.name` of a lazy backend first: resolving eve's default probes for a Docker daemon.
 */
export function sandboxRefusal({ nodeId, definition }, required) {
  const label = nodeId === "__root__" || nodeId === "root" ? "root" : nodeId;
  const rebuild = "Rebuild on this server with SANDBOX_BACKEND=microsandbox set (`npm run build:eve`): the build gives every agent node the SANDBOX_* settings.";
  if (definition.sourceId === EVE_DEFAULT_SANDBOX) {
    return `${label}: no sandbox definition in this build, so eve's default backend (Docker if a daemon answers, else a microsandbox with 1 vCPU and allow-all egress: fewer than SANDBOX_CPUS=${required.cpus}, no deny list). ${rebuild}`;
  }
  const backend = definition.backend;
  if (isLazyBackend(backend)) {
    return `${label}: its sandbox definition (${definition.logicalPath}) names no backend, so eve's default (1 vCPU and allow-all egress: fewer than SANDBOX_CPUS=${required.cpus}, no deny list). ${rebuild}`;
  }
  if (backend?.name !== "microsandbox") return `${label}: its sandbox definition (${definition.logicalPath}) pins the "${backend?.name}" backend, not microsandbox. ${rebuild}`;
  const settings = backendSettings(backend);
  if (!settings) return `${label}: its microsandbox backend (${definition.logicalPath}) was not created from the SANDBOX_* settings, so its CPUs and network policy cannot be vouched for. ${rebuild}`;
  if (!(settings.cpus >= required.cpus)) return `${label}: would start with ${settings.cpus} vCPU(s), fewer than SANDBOX_CPUS=${required.cpus} (${definition.logicalPath}).`;
  const missing = required.deny.filter((cidr) => !settings.deny.includes(cidr));
  if (missing.length) return `${label}: would start without the network deny list (missing ${missing.join(", ")}; ${definition.logicalPath}).`;
  return null;
}

/** eve's internals, by path, with a plain error if an upgrade moved one. */
async function eveModule(eveRoot, eveVersion, path, names) {
  const file = join(eveRoot, "dist/src", path);
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new Error(`Could not load eve's ${path} (eve ${eveVersion}): ${String(error?.message ?? error)}. This script was written against eve 0.25.1; re-read eve's execution/sandbox/prewarm.js.`);
  }
  for (const name of names) {
    if (typeof mod[name] !== "function") throw new Error(`eve ${eveVersion} no longer exports ${name} from ${path}. This script was written against eve 0.25.1.`);
  }
  return mod;
}

/**
 * Every agent node's sandbox in the built agent at `<appRoot>/.output`, loaded the way eve's own
 * `prewarmBuiltAppSandboxes` loads it: `[{ nodeId, definition, plan, templateKey, seedFiles }]`, sorted by node.
 * Starts nothing.
 */
export async function loadBuiltSandboxes(appRoot, { eveRoot, eveVersion }) {
  const load = (path, ...names) => eveModule(eveRoot, eveVersion, path, names);
  const { createDiskRuntimeCompiledArtifactsSource, createBundledRuntimeCompiledArtifactsSource } = await load("runtime/compiled-artifacts-source.js", "createDiskRuntimeCompiledArtifactsSource", "createBundledRuntimeCompiledArtifactsSource");
  const { resolvePackageSourceFilePath } = await load("internal/application/package.js", "resolvePackageSourceFilePath");
  const { loadCompileMetadata } = await load("runtime/loaders/compile-metadata.js", "loadCompileMetadata");
  const { loadCompiledManifest } = await load("runtime/loaders/manifest.js", "loadCompiledManifest");
  const { loadCompiledModuleMapFromAuthoredSource } = await load("internal/authored-module-map-loader.js", "loadCompiledModuleMapFromAuthoredSource");
  const { withBundledCompiledArtifacts } = await load("runtime/loaders/bundled-artifacts.js", "withBundledCompiledArtifacts");
  const { resolveRuntimeAgentGraph } = await load("runtime/resolve-agent-graph.js", "resolveRuntimeAgentGraph");
  const { createRuntimeSandboxTemplatePlan } = await load("runtime/sandbox/template-plan.js", "createRuntimeSandboxTemplatePlan");
  const { createRuntimeSandboxTemplateKey } = await load("runtime/sandbox/keys.js", "createRuntimeSandboxTemplateKey");

  const output = join(appRoot, ".output");
  const disk = createDiskRuntimeCompiledArtifactsSource(output, { moduleMapLoaderPath: resolvePackageSourceFilePath("src/internal/authored-module-map-loader.ts"), sandboxAppRoot: appRoot });
  const [metadata, manifest, moduleMap] = await Promise.all([
    loadCompileMetadata({ compiledArtifactsSource: disk }),
    loadCompiledManifest({ compiledArtifactsSource: disk }),
    loadCompiledModuleMapFromAuthoredSource({ compiledArtifactsSource: disk }),
  ]);
  const nodes = [];
  await withBundledCompiledArtifacts({ manifest, metadata: metadata ?? undefined, moduleMap, sessionId: "built-app-sandbox-plan" }, async () => {
    const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
    const graph = await resolveRuntimeAgentGraph({ manifest, moduleMap });
    for (const [nodeId, node] of graph.nodesByNodeId.entries()) {
      const sandbox = node.sandboxRegistry.sandbox;
      if (sandbox === null) continue;
      const { definition, workspaceResourceRoot } = sandbox;
      const plan = createRuntimeSandboxTemplatePlan({ definition, workspaceResourceRoot });
      // The key needs the backend's name. For a lazy backend that resolves eve's default (on Vercel: no probe).
      const lazy = isLazyBackend(definition.backend);
      const backendName = definition.backend.name;
      const templateKey = await createRuntimeSandboxTemplateKey({ backendName, compiledArtifactsSource, nodeId, sourceId: definition.sourceId, templatePlan: plan });
      nodes.push({ nodeId, definition, plan, templateKey, backendName, lazy });
    }
  });
  return nodes.sort((a, b) => String(a.nodeId).localeCompare(String(b.nodeId)));
}

/** One node as the plan prints it (`--plan`), with the refusal it would get under the given requirement. */
export function planRow(node, required) {
  const { nodeId, definition, plan, templateKey, backendName, lazy } = node;
  return {
    node: nodeId,
    definition: definition.sourceId === EVE_DEFAULT_SANDBOX ? "eve default (none authored)" : definition.logicalPath,
    backend: backendName,
    backendNamedByDefinition: !lazy,
    template: plan.kind,
    templateKey,
    bootstrap: definition.bootstrap !== undefined,
    settings: backendSettings(definition.backend),
    refused: required ? sandboxRefusal(node, required) : null,
  };
}

/* ---- the microsandbox runtime ----------------------------------------------------------------------------------- */

/**
 * Link the runtime npm installed (msb and libkrunfw, in the platform package) into `<home>/.microsandbox/{bin,lib}`,
 * which is where microsandbox looks. Returns the links made. Existing files are left as they are.
 */
export function linkMicrosandboxRuntime({ packageDir, home = homedir() }) {
  const made = [];
  for (const sub of ["bin", "lib"]) {
    const from = join(packageDir, sub);
    if (!existsSync(from)) throw new Error(`The microsandbox platform package has no ${sub}/ directory (${from}).`);
    const to = join(home, ".microsandbox", sub);
    mkdirSync(to, { recursive: true });
    for (const file of readdirSync(from)) {
      const target = join(to, file);
      let present = true;
      try {
        lstatSync(target);
      } catch {
        present = false;
      }
      if (present) continue;
      symlinkSync(join(from, file), target);
      made.push(target);
    }
  }
  return made;
}

function microsandboxPlatformPackage(require) {
  // microsandbox's "exports" does not list ./package.json, so resolving it throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // (first real server, 2026-10-04). "./native" is exported with a default condition; the package root is two up.
  const dir = join(dirname(dirname(require.resolve("microsandbox/native"))), "..", "@superradcompany");
  const found = existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("microsandbox-")) : [];
  if (found.length !== 1) {
    throw new Error(`Expected exactly one microsandbox platform package under ${dir}, found ${found.length ? found.join(", ") : "none"}. Run npm ci on this server.`);
  }
  return join(dir, found[0]);
}

/* ---- the data room's file links (filesystem storage) ------------------------------------------------------------ */

/**
 * With STORAGE_DRIVER=filesystem a sandbox downloads data-room files from the web app's own address. Resolve that
 * name HERE, on the server, and refuse if any address it resolves to is in the sandbox deny list
 * (agent/lib/sandbox-settings.ts `storageReachConflict`). Null when there is nothing to check or no conflict.
 */
export async function storageReach(env, { resolve = lookupAll } = {}) {
  const settings = await import(pathToFileURL(join(APP_ROOT, "agent/lib/sandbox-settings.ts")).href);
  const storage = settings.sandboxStorageOrigin(env);
  if (!storage) return null;
  let addresses;
  try {
    addresses = await resolve(storage.host);
  } catch (error) {
    return `The data room's file links point at ${storage.origin} (${storage.setting}), and that name does not resolve on this server (${String(error?.code ?? error)}). A sandbox could not download them.`;
  }
  return settings.storageReachConflict(env, addresses);
}

async function lookupAll(host) {
  const { lookup } = await import("node:dns/promises");
  return (await lookup(host, { all: true })).map((a) => a.address);
}

/* ---- self-test -------------------------------------------------------------------------------------------------- */

async function selfTest() {
  let passed = 0;
  const failures = [];
  const check = (what, ok, detail) => {
    if (ok) passed++;
    else failures.push(what);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), "sandbox-prewarm-selftest-"));
  try {
    // Stale locks.
    const app = join(scratch, "app");
    const lock = (backend, key, owner, ageMs = 0) => {
      const dir = join(locksRoot(app), backend, `${key}.lock`);
      mkdirSync(dir, { recursive: true });
      if (owner !== undefined) writeFileSync(join(dir, "owner.json"), typeof owner === "string" ? owner : JSON.stringify(owner));
      if (ageMs) {
        const t = new Date(Date.now() - ageMs);
        utimesSync(dir, t, t);
      }
      return dir;
    };
    check("no lock directory at all is not an error", clearStaleLocks(join(scratch, "nothing")).removed.length === 0);
    const dead = lock("microsandbox", "tpl-dead", { createdAt: new Date().toISOString(), pid: 999_999_991 });
    const live = lock("microsandbox", "tpl-live", { createdAt: new Date().toISOString(), pid: 4242 });
    const mine = lock("microsandbox", "tpl-mine", { createdAt: new Date().toISOString(), pid: process.pid });
    const fresh = lock("vercel", "tpl-being-written", undefined);
    const garbled = lock("vercel", "tpl-garbled-old", "{not json", 5 * 60_000);
    const ownerlessOld = lock("docker", "tpl-ownerless-old", undefined, 5 * 60_000);
    writeFileSync(join(locksRoot(app), "microsandbox", "not-a-lock.txt"), "x");
    const alive = (pid) => pid === 4242 || pid === process.pid;
    const result = clearStaleLocks(app, { alive });
    check("a lock whose owner process is gone is removed", !existsSync(dead) && result.removed.some((r) => r.lock === "microsandbox/tpl-dead.lock"), result);
    check("a lock whose owner process is running is LEFT and reported with its pid", existsSync(live) && result.held.some((h) => h.lock === "microsandbox/tpl-live.lock" && h.pid === 4242), result);
    check("a lock this very process left earlier is removed (it is not held by anyone else)", !existsSync(mine));
    check("a lock still being written (no owner yet, seconds old) is left", existsSync(fresh) && result.held.some((h) => h.lock === "vercel/tpl-being-written.lock" && h.pid === null));
    check("a lock with an unreadable owner, minutes old, is removed", !existsSync(garbled));
    check("a lock with no owner file, minutes old, is removed", !existsSync(ownerlessOld));
    check("only *.lock entries are touched", existsSync(join(locksRoot(app), "microsandbox", "not-a-lock.txt")));
    check("every backend's directory is covered", result.removed.map((r) => r.lock.split("/")[0]).sort().join() === "docker,microsandbox,microsandbox,vercel", result.removed);
    check("the real liveness check: this process is alive, pid 999999991 is not", pidAlive(process.pid) && !pidAlive(999_999_991) && !pidAlive(0) && !pidAlive(-1));
    check("a second pass finds nothing left to remove", clearStaleLocks(app, { alive }).removed.length === 0);

    const forced = lock("microsandbox", "tpl-forced", { createdAt: new Date().toISOString(), pid: 4242 });
    check("--force-locks removes even a lock whose owner looks alive", clearStaleLocks(app, { alive, force: true }).removed.some((r) => r.lock === "microsandbox/tpl-forced.lock") && !existsSync(forced) && !existsSync(live));

    // Which sandboxes are refused under microsandbox. The shapes are eve's: a definition that names no backend gets
    // a lazy one (its `name` is a getter); one made by a build-time wrapper carries the settings it was made from.
    const required = { cpus: 2, memoryMiB: 1024, deny: ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"] };
    const lazy = () => {
      let resolved = 0;
      const backend = { get name() { resolved++; return "microsandbox"; }, create() {}, prewarm() {} };
      return { backend, resolved: () => resolved };
    };
    const tagged = (cpus, deny = required.deny, memoryMiB = 1024) => ({ name: "microsandbox", create() {}, prewarm() {}, [SETTINGS_TAG]: { cpus, memoryMiB, networkPolicy: { allow: ["*"], subnets: { deny } } } });
    const bare = sandboxRefusal({ nodeId: "subagents/fixture-bare", definition: { sourceId: "eve:default-sandbox", logicalPath: "eve:framework/default-sandbox", backend: lazy().backend } }, required);
    check("a specialist with NO sandbox definition in the build is refused, by name, with what it would start on", /^subagents\/fixture-bare: no sandbox definition/.test(bare ?? "") && /1 vCPU and allow-all egress/.test(bare) && /SANDBOX_CPUS=2/.test(bare), bare);
    const packLazy = lazy();
    const pack = sandboxRefusal({ nodeId: "subagents/fixture-pack", definition: { sourceId: "x", logicalPath: "subagents/fixture-pack/sandbox/sandbox.ts", backend: packLazy.backend } }, required);
    check("a definition with a bootstrap but no backend (what a pack ships) is refused, naming its file", /^subagents\/fixture-pack: its sandbox definition \(subagents\/fixture-pack\/sandbox\/sandbox\.ts\) names no backend/.test(pack ?? ""), pack);
    check("…without resolving eve's default backend (that probes for a Docker daemon)", packLazy.resolved() === 0);
    check("a microsandbox backend that carries no settings is refused: its CPUs cannot be vouched for", /was not created from the SANDBOX_\* settings/.test(sandboxRefusal({ nodeId: "__root__", definition: { sourceId: "x", logicalPath: "sandbox.ts", backend: { name: "microsandbox", create() {}, prewarm() {} } } }, required) ?? ""));
    check("fewer CPUs than SANDBOX_CPUS is refused, with both numbers", /^root: would start with 1 vCPU\(s\), fewer than SANDBOX_CPUS=2/.test(sandboxRefusal({ nodeId: "__root__", definition: { sourceId: "x", logicalPath: "sandbox.ts", backend: tagged(1) } }, required) ?? ""));
    const noDeny = sandboxRefusal({ nodeId: "subagents/a", definition: { sourceId: "x", logicalPath: "p", backend: tagged(2, ["10.0.0.0/8"]) } }, required);
    check("a missing deny-list entry is refused, naming the entries", /without the network deny list \(missing 169\.254\.0\.0\/16, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16, 127\.0\.0\.0\/8/.test(noDeny ?? ""), noDeny);
    check("another backend (docker) is refused", /pins the "docker" backend/.test(sandboxRefusal({ nodeId: "subagents/a", definition: { sourceId: "x", logicalPath: "p", backend: { name: "docker", create() {}, prewarm() {} } } }, required) ?? ""));
    check("the configured settings pass, and so do more CPUs and extra deny entries", sandboxRefusal({ nodeId: "subagents/a", definition: { sourceId: "x", logicalPath: "p", backend: tagged(2) } }, required) === null && sandboxRefusal({ nodeId: "subagents/a", definition: { sourceId: "x", logicalPath: "p", backend: tagged(4, [...required.deny, "203.0.113.7/32"]) } }, required) === null);
    check("a report line gives a backend's settings, or says it runs on eve's defaults", describeBackend(tagged(2)) === `cpus=2, memoryMiB=1024, deny=[${required.deny.join(" ")}]` && /eve's default backend options: 1 vCPU/.test(describeBackend(lazy().backend)));

    // One at a time.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let active = 0;
    let peak = 0;
    const order = [];
    const failing = new Map([["t3", 1], ["t5", 99]]); // t3 fails once, t5 always
    const backend = {
      name: "fake",
      async prewarm(input) {
        active++;
        peak = Math.max(peak, active);
        order.push(input.templateKey);
        await sleep(15);
        active--;
        const left = failing.get(input.templateKey) ?? 0;
        if (left > 0) {
          failing.set(input.templateKey, left - 1);
          throw new Error(`timed out waiting for agent relay (${input.templateKey})`);
        }
        return { reused: input.templateKey === "t1" };
      },
    };
    const retried = [];
    const serial = serialDispatch({ retries: 1, beforeRetry: ({ input }) => retried.push(input.templateKey) });
    // As eve calls it: every template dispatched at once, awaited together.
    const all = Promise.all(["t1", "t2", "t3", "t4", "t5", "t6"].map((templateKey) => serial.dispatch({ backend, input: { templateKey } })));
    const rejected = await all.then(() => null, (e) => e);
    const outcomes = await serial.settled();
    check("never more than one template is being built at a time", peak === 1 && serial.maxConcurrency() === 1, { peak });
    check("templates run in the order they were asked for, a failed one retried in place", order.join() === "t1,t2,t3,t3,t4,t5,t5,t6", order);
    check("a template that fails once succeeds on its retry", outcomes.find((o) => o.templateKey === "t3")?.ok === true && outcomes.find((o) => o.templateKey === "t3").attempts === 2, outcomes);
    check("a template that keeps failing is reported failed, with its error", outcomes.find((o) => o.templateKey === "t5")?.ok === false && /agent relay/.test(outcomes.find((o) => o.templateKey === "t5").error));
    check("the templates AFTER a failed one are still built", outcomes.find((o) => o.templateKey === "t6")?.ok === true && outcomes.length === 6);
    check("eve's own wait still sees the failure", rejected instanceof Error && /t5/.test(rejected.message));
    check("the retry hook ran once per retry", retried.join() === "t3,t5", retried);
    check("a reused template is told apart from a built one", outcomes.find((o) => o.templateKey === "t1").reused === true && outcomes.find((o) => o.templateKey === "t2").reused === false);

    // A template that hangs.
    const hung = [];
    const hangBackend = {
      name: "microsandbox",
      [SETTINGS_TAG]: { cpus: 2, memoryMiB: 1024, networkPolicy: { allow: ["*"], subnets: { deny: required.deny } } },
      prewarm(input) {
        hung.push(input.templateKey);
        return input.templateKey === "h2" ? new Promise(() => {}) : Promise.resolve({ reused: false }); // h2 never settles
      },
    };
    const killedFor = [];
    const lines = [];
    const timed = serialDispatch({
      retries: 2,
      timeoutMs: 60,
      log: (line) => lines.push(line),
      describe: ({ backend: b, input }) => `node subagents/${input.templateKey}; ${describeBackend(b)}`,
      onTimeout: async ({ input }) => (killedFor.push(input.templateKey), "killed its VM (pid 4242)"),
    });
    const t0 = Date.now();
    const timedAll = await Promise.allSettled(["h1", "h2", "h3", "h4"].map((templateKey) => timed.dispatch({ backend: hangBackend, input: { templateKey } })));
    const timedOutcomes = await timed.settled();
    const h2 = timedOutcomes.find((o) => o.templateKey === "h2");
    check("a template that never finishes is given up on at the timeout instead of hanging the run", h2?.timedOut === true && Date.now() - t0 < 5_000, { h2, ms: Date.now() - t0 });
    check("…it is NOT retried (retries were 2)", hung.filter((k) => k === "h2").length === 1 && h2.attempts === 1, hung);
    check("…its VM is killed", killedFor.join() === "h2", killedFor);
    check("…the report names the template, its node and the settings it was started with", /timed out after 0s on attempt 1 \(node subagents\/h2; cpus=2, memoryMiB=1024, deny=\[169\.254\.0\.0\/16 .*\]\); killed its VM \(pid 4242\)/.test(h2.error) && lines.some((l) => l.includes("template h2 (microsandbox) timed out")), h2.error);
    check("…the templates after it are not started, and are reported as not tried", hung.join() === "h1,h2" && timedOutcomes.filter((o) => o.skipped).map((o) => o.templateKey).join() === "h3,h4" && timed.stoppedAt() === "h2", { hung, timedOutcomes });
    check("…the one before it was built, and eve's own wait sees the rest fail", timedOutcomes.find((o) => o.templateKey === "h1")?.ok === true && timedAll.map((r) => r.status).join() === "fulfilled,rejected,rejected,rejected");
    const quick = serialDispatch({ timeoutMs: 5_000 });
    await quick.dispatch({ backend: hangBackend, input: { templateKey: "h1" } });
    check("a template that finishes in time is unaffected by the timeout (and its timer is cleared)", (await quick.settled())[0].ok === true);
    const killFails = serialDispatch({ timeoutMs: 30, onTimeout: async () => { throw new Error("EPERM"); } });
    await killFails.dispatch({ backend: hangBackend, input: { templateKey: "h2" } }).catch(() => {});
    check("a kill that fails is said, and the timeout is still reported", /could not kill its VM: EPERM/.test((await killFails.settled())[0].error));

    // Which processes are a hung template's VM.
    const procs = [
      { pid: 1, ppid: 0, uid: 0, cmdline: "init" },
      { pid: 100, ppid: 1, uid: 1000, cmdline: "node scripts/sandbox-prewarm-serial.mjs" }, // this script
      { pid: 101, ppid: 100, uid: 1000, cmdline: "msb run --vcpus 1" }, // its child
      { pid: 102, ppid: 101, uid: 1000, cmdline: "krun worker" }, // a grandchild
      { pid: 200, ppid: 1, uid: 1000, cmdline: "msb supervisor --name eve-sbx-tpl-tmp-abc --vcpus 1" }, // detached, named
      { pid: 201, ppid: 1, uid: 1000, cmdline: "msb supervisor --name eve-sbx-ses-xyz" }, // a live SESSION: never
      { pid: 202, ppid: 1, uid: 2000, cmdline: "msb supervisor --name eve-sbx-tpl-tmp-other-user" }, // not ours
      { pid: 300, ppid: 1, uid: 1000, cmdline: "node .output/server/index.mjs" },
    ];
    check("the VM of a hung template is this script's descendants and this user's template build VMs; never a session VM, another user's, or the server", templateVmProcesses(procs, { self: 100, uid: 1000 }).map((p) => p.pid).join() === "101,102,200", templateVmProcesses(procs, { self: 100, uid: 1000 }));
    const signalled = [];
    const said = killTemplateVm({ processes: procs, self: 100, uid: 1000, kill: (pid) => { if (pid === 102) throw new Error("ESRCH"); signalled.push(pid); } });
    check("they are killed, and the line says which", signalled.join() === "101,200" && said === "killed its VM (pid 101, 200)", said);
    check("nothing to kill is said plainly", killTemplateVm({ processes: procs.slice(0, 2), self: 100, uid: 1000, kill: () => {} }) === "found no VM process of its to kill");
    check("the real process table is readable and holds this process", process.platform !== "linux" || listProcesses().some((p) => p.pid === process.pid && p.ppid === process.ppid));

    // The data room's file links under the filesystem storage driver.
    const fsEnv = (extra) => ({ SANDBOX_BACKEND: "microsandbox", STORAGE_DRIVER: "filesystem", ...extra });
    const resolvesTo = (...addresses) => ({ resolve: async () => addresses });
    check("no storage driver set (Vercel Blob): nothing to check", (await storageReach({ SANDBOX_BACKEND: "microsandbox", WEB_ORIGIN: "https://app.example.com" }, resolvesTo("10.0.0.5"))) === null);
    check("filesystem storage on a public address: reachable, no conflict", (await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://app.example.com" }), resolvesTo("203.0.113.7"))) === null);
    const priv = await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://app.internal" }), resolvesTo("10.1.2.3"));
    check("a storage origin that resolves to a private address is refused, naming the address and the rule", /app\.internal/.test(priv ?? "") && /10\.1\.2\.3/.test(priv) && /10\.0\.0\.0\/8/.test(priv), priv);
    const own = await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://app.example.com", SANDBOX_DENY_SUBNETS: "203.0.113.7" }), resolvesTo("203.0.113.7"));
    check("…and so is the host's public address once it is added to SANDBOX_DENY_SUBNETS", /203\.0\.113\.7\/32/.test(own ?? ""), own);
    check("WEB_ORIGIN is used when STORAGE_PUBLIC_URL is unset, as the storage driver does", /WEB_ORIGIN/.test((await storageReach(fsEnv({ WEB_ORIGIN: "http://127.0.0.1:3000" }), resolvesTo("127.0.0.1"))) ?? ""));
    check("an IPv6 address in an extra deny entry is matched", /2001:db8::\/32/.test((await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://v6.example.com", SANDBOX_DENY_SUBNETS: "2001:db8::/32" }), resolvesTo("2001:db8::7"))) ?? ""));
    const unresolved = await storageReach(fsEnv({ STORAGE_PUBLIC_URL: "https://nowhere.invalid" }), { resolve: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } });
    check("a name that does not resolve on the server is refused too", /does not resolve/.test(unresolved ?? "") && /ENOTFOUND/.test(unresolved), unresolved);

    // The microsandbox runtime link.
    const pkg = join(scratch, "pkg");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(join(pkg, "bin", "msb"), "#!/bin/sh\n");
    writeFileSync(join(pkg, "lib", "libkrunfw.so.5"), "x");
    const home = join(scratch, "home");
    const made = linkMicrosandboxRuntime({ packageDir: pkg, home });
    check("the runtime files are linked into ~/.microsandbox/{bin,lib}", made.length === 2 && lstatSync(join(home, ".microsandbox", "bin", "msb")).isSymbolicLink() && readFileSync(join(home, ".microsandbox", "lib", "libkrunfw.so.5"), "utf8") === "x", made);
    check("linking again changes nothing", linkMicrosandboxRuntime({ packageDir: pkg, home }).length === 0);
    let missing = null;
    try {
      linkMicrosandboxRuntime({ packageDir: join(scratch, "nope"), home });
    } catch (error) {
      missing = error;
    }
    check("a missing platform package is a plain error", /no bin\/ directory/.test(String(missing?.message)));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures.length ? `\nsandbox-prewarm-serial --self-test: ${failures.length} FAILED` : `\nsandbox-prewarm-serial --self-test: ${passed} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

/* ---- main ------------------------------------------------------------------------------------------------------- */

/** What every node must have under microsandbox, from THIS process's settings: `{ cpus, memoryMiB, deny }`. Null otherwise. */
async function requiredSettings(env) {
  const settings = await import(pathToFileURL(join(APP_ROOT, "agent/lib/sandbox-settings.ts")).href);
  const micro = settings.microsandboxSettings(env);
  return micro ? { cpus: micro.cpus, memoryMiB: micro.memoryMiB, deny: [...micro.networkPolicy.subnets.deny] } : null;
}

const labelOf = (nodeId) => (nodeId === "__root__" ? "root" : nodeId);

/**
 * eve bundles the sandbox definitions from agent/ AGAIN when it prewarms (and when this script reads the plan), so
 * under microsandbox the wrappers the build used are put back for exactly as long as this runs, under the build's
 * own lock (a build in progress is waited for; a killed run's wrappers are removed by the next build or prewarm).
 * With the setting unset nothing is locked, written or moved.
 */
async function main() {
  if (has("--locks-only") || (process.env.SANDBOX_BACKEND ?? "").trim().toLowerCase() !== "microsandbox") return await run();
  const { withAgentTreeLock } = await import("./eve-build.mjs");
  const { applySandboxOverlay, buildStampProblem } = await import("./lib/sandbox-overlay.mjs");
  return await withAgentTreeLock(`sandbox:prewarm ${args.join(" ")}`.trim(), async () => {
    const applied = applySandboxOverlay(APP_ROOT);
    // The server runs what was bundled into .output: it must be a build made with these wrappers.
    return await run(existsSync(join(APP_ROOT, ".output")) ? buildStampProblem(APP_ROOT, applied) : null);
  });
}

async function run(stampProblem = null) {
  const t0 = Date.now();
  const at = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`;
  const say = (line) => console.log(`${at()} ${line}`);
  const retries = Number(valueOf("--retries", "1"));
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error("--retries takes a whole number from 0 to 5.");
  const timeoutS = Number(valueOf("--template-timeout", process.env.SANDBOX_PREWARM_TIMEOUT_S?.trim() || "600"));
  if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > 86_400) throw new Error("--template-timeout (or SANDBOX_PREWARM_TIMEOUT_S) takes a whole number of seconds from 1 to 86400.");
  const backendSetting = (process.env.SANDBOX_BACKEND ?? "").trim().toLowerCase() || "vercel";

  if (!has("--plan")) {
    const { removed, held } = clearStaleLocks(APP_ROOT, { force: has("--force-locks") });
    for (const r of removed) say(`removed ${has("--force-locks") ? "" : "stale "}template lock ${r.lock} (owner ${r.pid ?? "unknown"}${has("--force-locks") ? "" : " is not running"})`);
    if (held.length) {
      for (const h of held) console.error(`${at()} template lock ${h.lock} is held by ${h.pid === null ? "a process that is still writing it" : `pid ${h.pid}, which is running`}`);
      throw new Error("Another prewarm (or an `eve start` / `eve build`) is running against this app. Wait for it or stop it, then run this again. If you are sure nothing is (a dead owner's process id can be reused), run with --force-locks.");
    }
    if (has("--locks-only")) {
      say(`locks checked (${removed.length} removed)`);
      return;
    }
  }

  if (!existsSync(join(APP_ROOT, ".output"))) {
    throw new Error("There is no built agent here (.output/ is missing). Run `npm run build:eve` on this server first.");
  }
  const require = createRequire(import.meta.url);
  const eveRoot = dirname(require.resolve("eve/package.json"));
  const eveVersion = JSON.parse(readFileSync(join(eveRoot, "package.json"), "utf8")).version;

  // EVERY node's sandbox in the built agent, before anything is started. Under microsandbox each must carry the
  // SANDBOX_* settings; one that would start on eve's defaults is named and nothing is built.
  const required = await requiredSettings(process.env);
  if (required && stampProblem && !has("--plan")) throw new Error(`${stampProblem} Nothing was started.`);
  const nodes = await loadBuiltSandboxes(APP_ROOT, { eveRoot, eveVersion });
  const rows = nodes.map((node) => planRow(node, required));
  const refused = rows.filter((r) => r.refused);
  const byTemplate = new Map(nodes.filter((n) => n.templateKey).map((n) => [n.templateKey, n]));
  if (has("--plan")) {
    console.log(JSON.stringify({ eve: eveVersion, backendSetting, required, build: stampProblem, nodes: rows }, null, 2));
    if (stampProblem) throw new Error(stampProblem);
    if (refused.length) throw new Error(`${refused.length} of ${rows.length} sandbox(es) would be refused.`);
    return;
  }
  if (required) {
    if (refused.length) {
      for (const r of refused) console.error(`${at()} REFUSED ${r.refused}`);
      throw new Error(`${refused.length} of ${rows.length} sandbox(es) would not start with the SANDBOX_* settings (SANDBOX_CPUS=${required.cpus} and the network deny list). Nothing was started.`);
    }
    say(`all ${rows.length} agent node(s) carry the SANDBOX_* settings (cpus=${required.cpus}, memoryMiB=${required.memoryMiB}, deny=[${required.deny.join(" ")}]): ${rows.map((r) => labelOf(r.node)).join(", ")}`);
  }

  if (backendSetting === "microsandbox") {
    if (!existsSync("/dev/kvm")) throw new Error("SANDBOX_BACKEND=microsandbox needs KVM, and this host has no /dev/kvm.");
    const { isInstalled } = await import("microsandbox");
    if (!isInstalled()) {
      if (!has("--link-runtime")) {
        throw new Error("The microsandbox runtime is not installed for this user (~/.microsandbox/bin/msb, ~/.microsandbox/lib/libkrunfw*). Run this again with --link-runtime to link the copy npm installed (no download).");
      }
      for (const link of linkMicrosandboxRuntime({ packageDir: microsandboxPlatformPackage(require) })) say(`linked ${link}`);
      if (!isInstalled()) throw new Error("The microsandbox runtime was linked but still does not report as installed. Check ~/.microsandbox and that this user is in the kvm group.");
    }
  }

  if (backendSetting === "microsandbox") {
    // The filesystem storage driver's file links point at the web app: a sandbox must be able to reach it.
    const conflict = await storageReach(process.env);
    if (conflict) throw new Error(conflict);
  }

  const { prewarmBuiltAppSandboxes } = await eveModule(eveRoot, eveVersion, "execution/sandbox/prewarm.js", ["prewarmBuiltAppSandboxes"]);

  const nodeOf = (templateKey) => {
    const node = byTemplate.get(templateKey);
    return node ? labelOf(node.nodeId) : "unknown node";
  };
  say(`prewarming sandbox templates one at a time (eve ${eveVersion}, SANDBOX_BACKEND=${backendSetting}, retries ${retries}, ${timeoutS}s per template)`);
  const serial = serialDispatch({
    retries,
    timeoutMs: timeoutS * 1000,
    log: (line) => say(line),
    describe: ({ backend, input }) => `node ${nodeOf(input.templateKey)}; ${describeBackend(backend)}`,
    onTimeout: async () => killTemplateVm(),
  });
  // The same rule again at the last moment, on the very backend object about to be used: eve resolved the graph a
  // second time for this call, and a template must never start on a backend that was not checked.
  const guarded = ({ backend, input }) => {
    const refusal = required ? sandboxRefusal({ nodeId: nodeOf(input.templateKey), definition: { sourceId: "", logicalPath: "the built agent", backend } }, required) : null;
    if (refusal) return Promise.reject(new Error(`REFUSED ${refusal}`));
    return serial.dispatch({ backend, input });
  };
  let failure = null;
  try {
    await prewarmBuiltAppSandboxes({
      appRoot: APP_ROOT,
      dispatch: guarded,
      log: (line) => {
        if (!/elapsed\)|bootstrap run:/.test(line)) say(String(line).slice(0, 200));
      },
    });
  } catch (error) {
    failure = error;
  }
  const outcomes = await serial.settled();
  const failed = outcomes.filter((o) => !o.ok);
  for (const o of outcomes) {
    const state = o.ok ? (o.reused ? "reused" : "built ") : o.timedOut ? "TIMED OUT" : o.skipped ? "NOT TRIED" : "FAILED";
    say(`${state} ${o.templateKey} (${nodeOf(o.templateKey)}; ${o.backend}, ${(o.ms / 1000).toFixed(0)}s${o.attempts > 1 ? `, ${o.attempts} attempts` : ""})${o.ok ? "" : `: ${o.error.slice(0, 400)}`}`);
  }
  if (failed.length || failure) {
    if (failure && !failed.length) console.error(`${at()} ${String(failure?.message ?? failure)}`);
    throw new Error(`${failed.length || 1} of ${outcomes.length || "the"} sandbox template(s) could not be built. The server must not be started until this passes.`);
  }
  say(`${outcomes.length} sandbox template(s) ready (${outcomes.filter((o) => o.reused).length} reused, ${outcomes.filter((o) => !o.reused).length} built). Start the server: node .output/server/index.mjs`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (has("--self-test")) await selfTest();
  else {
    try {
      await main();
      process.exit(0);
    } catch (error) {
      console.error(`sandbox:prewarm: ${String(error?.message ?? error)}`);
      process.exit(1);
    }
  }
}
