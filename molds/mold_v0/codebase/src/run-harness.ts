/**
 * The "workspace-harness" runner (mold_v0-041, with the workspace store of mold_v0-033): how a claimed run is carried
 * out. The contract a runner keeps, wherever it runs:
 *
 *   1. claim       POST /api/worker/runs/claim (the fleet token) or claimRun() in-process: the run, its frozen job kind,
 *                  a lease token, a deadline, gateway env for the kind's providers, and the egress allowlist
 *   2. workspace   (kinds with workspace: true) check the workspace's latest snapshot out into an empty directory
 *   3. run         the kind's entry, a program in (the run's own copy of) the pack, with node, in that directory, as a
 *                  user of the run's own (a uid leased for this run alone from APP_RUN_UIDS, src/run-users.ts,
 *                  mold_v0-078; never the runner's), with an environment built from
 *                  nothing: PATH, a private HOME, RUN_* (id, attempt, scope, targets, the output directory) and the
 *                  gateway env. Never the runner's own environment (database URL, vault key, worker token), which the
 *                  separate user cannot read either (/proc/<runner>/environ). When it ends, every process of that user
 *                  is killed and its files in the shared temporary directories removed: no other run has that uid, so
 *                  this never touches another run. Without a separate user the harness refuses to run, unless told
 *                  (allowSameUser, tests).
 *                  Its stdout lines are events (a JSON line {"event": "<type>", ...} is that event; anything else "log").
 *                  Exit 0: done. Exit 75: an infrastructure failure (the engine retries while attempts remain). Else failed.
 *   4. heartbeat   every lease_seconds / 3; on cancel=true (cancelled, or past the deadline) the program is stopped
 *   5. validate    the kind's validator, a program in the pack, with the workspace and output directories: exit 0 is valid
 *      credentials (kinds that name credential fields, mold_v0-034) fetched with the lease (GET .../credentials): each
 *                  an environment variable of the entry program, or a file (mode 0400, the run user's) in a private
 *                  directory on tmpfs (/dev/shm when there is one) named by RUN_CREDENTIALS_DIR, removed as soon as the
 *                  entry program ends; the validator gets none. Every line, stderr tail, results file and error the
 *                  run produces is redacted (src/credential-redact.ts) before it is sent, and the engine redacts again
 *                  before it stores; a workspace that holds a value is not written back.
 *   6. write back  (workspace kinds) only when the run exited 0 and validation exited 0: the directory is staged and the
 *                  engine commits it as the next version when the run completes as succeeded; any failure leaves the
 *                  workspace's version where it was
 *   7. complete    with <output>/results.json (a list of {check, asset, source, status, finding_fingerprint,
 *                  evidence_ref, detail}) when it succeeded; the engine checks every reference against the record areas
 *
 * Egress: the run's processes get proxy settings for an egress proxy (orchestrator/core/egress.ts proxySource, the
 * sandboxes' own) that allows only the run's hosts (the kind's `egress` and the gateway's public host). Enforced here:
 * every connection made through the proxy (a process that honours HTTPS_PROXY) to any other host is refused.
 * NOT enforced here: a process that ignores the proxy settings and connects directly. Only the sandbox's firewall
 * (setupScript in orchestrator/core/egress.ts: nftables/iptables by the run user's uid) closes that path: a run sandbox
 * (mold_v0-055, src/run-sandbox-runner.ts) locks its run user down to the run's list before the run starts and then runs
 * the harness with egress "system" (the sandbox's own proxy, which the firewall also sends direct 443 and DNS to).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { chmodSync, chownSync, closeSync, constants, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { EGRESS_PROXY_PORT, proxyEnv, proxySource } from "../orchestrator/core/egress.js";
const EGRESS_LOG_DIR = "/var/log"; // where setupScript's proxy logs (orchestrator/core/egress.ts)
import type { RunView } from "./pack-api.js";
import type { Claim, Completion } from "./runs.js";
import type { RunCredentials } from "./credentials.js";
import { findSecret, redactJson, redactText, type Secret } from "./credential-redact.js";
import { packBundle, unpackBundle } from "./workspace-bundle.js";
import { openTransfer, sealTransfer, sha256Hex, sizeInWords } from "./run-transfer-seal.js";
import { AgentRunError, argValues, collectWriteBack, expand, fetchPinned, headCommit, recordedFiles, restoreInto, stripPaths, underWriteBack, writeBackIgnore, type WriteBackIgnore } from "./agent-workspace.js";
import { checkInput, CheckoutCache, field, gitCredentialFiles, mapResults, mountInto, pinCommits, readManifests, writeInputFile, type GitCredential, type InputSchema, type ResultsFrom } from "./agent-workspace-steps.js";
import { linkTools, RUN_TOOL_CATALOG, RunToolError, verifyTools, type ToolCatalog } from "./run-tools.js";
import { hostDir, killUser, LEGACY_HOST_DIRS, leaseRunUser, processesOf, runUidRange, RunUserError, sweepUserFiles, type RunUser, type UidRange } from "./run-users.js";
import { ENV } from "./env-names.js";
import { now as clockNow, REFRESH_MARGIN_MS } from "./clock.js";

/** Kept here for callers that imported it from the harness (it lives in src/run-users.ts, mold_v0-078). */
export { sweepUserFiles };

/** What a runner needs from the engine: in-process (localRunnerClient) or over HTTP (httpRunnerClient). */
export interface RunnerClient {
  claim(kinds?: string[]): Promise<Claim | null>;
  heartbeat(runId: string, lease: string): Promise<{ cancel: boolean; reason: string | null }>;
  events(runId: string, lease: string, events: { type: string; data?: Record<string, unknown> }[]): Promise<void>;
  complete(runId: string, lease: string, c: Completion): Promise<RunView>;
  /** The workspace store (mold_v0-033): the latest snapshot into `dir` (empty for a workspace's first run). */
  checkout(runId: string, lease: string, dir: string): Promise<{ version: number }>;
  /** Stage `dir` as the next version; the engine commits it only when the run completes as succeeded. */
  stage(runId: string, lease: string, dir: string): Promise<{ manifest_sha256: string; files: number; unchanged: boolean }>;
  /** The workspace credentials the run receives (mold_v0-034): only for the lease holder, only what its kind names. */
  credentials(runId: string, lease: string): Promise<RunCredentials>;
}

/**
 * Keep a claimed run's lease, and with it its workspace store's (src/runs.ts heartbeatRun), from the claim until the
 * harness's own heartbeat takes over (mold_v0-179). A sandbox's runner sets the run's user and its lockdown up between
 * the two, which took longer than a 120 s lease on boat: the store's lease lapsed and the checkout was refused ("this
 * run does not hold its workspace's lease"). Heartbeats every lease_seconds / 3; `onLost` once the engine answers 409.
 */
export function keepLease(client: RunnerClient, runId: string, lease: string, leaseSeconds: number, onLost: () => void = () => {}): { stop: () => void } {
  let lost = false;
  const t = setInterval(() => {
    client.heartbeat(runId, lease).catch((e) => { if ((e as { status?: number }).status === 409 && !lost) { lost = true; onLost(); } });
  }, Math.max(1000, (leaseSeconds * 1000) / 3));
  return { stop: () => clearInterval(t) };
}

/** The engine in this process (a runner on the server itself, and the offline tests). */
export async function localRunnerClient(workerId: string): Promise<RunnerClient> {
  const runs = await import("./runs.js");
  const store = await import("./workspace-store.js");
  return {
    claim: (kinds) => runs.claimRun(workerId, { kinds }),
    heartbeat: (id, lease) => runs.heartbeatRun(id, lease),
    events: async (id, lease, ev) => void (await runs.appendRunEvents(id, lease, ev)),
    complete: (id, lease, c) => runs.completeRun(id, lease, c),
    checkout: (id, lease, dir) => store.checkoutForRun(id, lease, dir),
    stage: (id, lease, dir) => store.stageForRun(id, lease, dir),
    credentials: (id, lease) => runs.runCredentialsForLease(id, lease),
  };
}

/**
 * The largest body sent to (or taken from) the worker API in one request (mold_v0-182): 4 MiB, under a hosted
 * function's 4.5 MB (Vercel: FUNCTION_PAYLOAD_TOO_LARGE). Anything larger goes through the object store with a link
 * the API hands out (src/run-transfers.ts), where the store has links; events go in batches below it.
 */
export const INLINE_MAX_BYTES = () => Number(process.env.APP_WORKER_INLINE_MAX_BYTES ?? 4 * 1024 * 1024);

/** A write-back (or a completion) the API or the store refused for its size: the size, the limit when known, and why. */
export class TooLargeError extends Error {
  status = 413;
  constructor(message: string, public bytes: number, public limit: number | null) { super(message); }
}

/** The engine over HTTP, as a runner elsewhere (a sandbox) reaches it: /api/worker/runs with the fleet token. */
export function httpRunnerClient(base: string, workerToken: string, workerId: string): RunnerClient {
  const url = (p: string) => `${base.replace(/\/$/, "")}/api/worker/runs${p}`;
  const call = async <T>(method: string, p: string, lease: string | null, body?: unknown, raw?: Buffer): Promise<T> => {
    const res = await fetch(url(p), {
      method, headers: { authorization: `Bearer ${workerToken}`, ...(lease ? { "x-run-lease": lease } : {}),
        ...(raw ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}) },
      body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let detail: { error?: string; bytes?: number; limit?: number } | null = null;
      try { detail = JSON.parse(text); } catch { /* the platform's own page, not the API's */ }
      throw Object.assign(new Error(`${method} ${p}: ${res.status} ${text.slice(0, 300)}`), { status: res.status, detail });
    }
    return (res.headers.get("content-type") ?? "").includes("json") ? (res.json() as Promise<T>) : (Buffer.from(await res.arrayBuffer()) as unknown as T);
  };
  const runPath = (id: string, rest: string) => `/${encodeURIComponent(id)}${rest}`;
  /**
   * mold_v0-182: `body` to the object store with the link the API hands out for this run's attempt, sealed with the
   * key it made for this transfer; the transfer's id, or null where the store gives no links (a local directory).
   */
  const upload = async (id: string, lease: string, purpose: "workspace" | "completion", body: Buffer): Promise<string | null> => {
    const r = await call<{ upload: { id: string; url: string; key: string } | null }>("POST", runPath(id, "/uploads"), lease, { purpose, bytes: body.length, sha256: sha256Hex(body) });
    if (!r.upload) return null;
    const sealed = sealTransfer(Buffer.from(r.upload.key, "base64"), r.upload.id, body);
    let res: Response;
    try { res = await fetch(r.upload.url, { method: "PUT", body: new Uint8Array(sealed), headers: { "content-type": "application/octet-stream" } }); }
    catch (e) { throw Object.assign(new Error(`upload to the object store: ${(e as Error).message}`), { status: 503 }); }
    // The store's own refusal: an infrastructure failure (retried), never the run's.
    if (!res.ok) throw Object.assign(new Error(`upload to the object store: ${res.status} ${(await res.text()).slice(0, 200)}`), { status: 503 });
    return r.upload.id;
  };
  /** The API refused a body for its size (its own 413, or the platform's in front of it: FUNCTION_PAYLOAD_TOO_LARGE). */
  const refused = (what: string, bytes: number, e: unknown): TooLargeError => {
    const d = (e as { detail?: { error?: string; limit?: number } | null }).detail;
    // The API's own refusal names the size and its limit; the platform's (FUNCTION_PAYLOAD_TOO_LARGE) names neither.
    if (d?.error && typeof d.limit === "number") return new TooLargeError(d.error, bytes, d.limit);
    if (d?.error && /at most/.test(d.error)) return new TooLargeError(d.error, bytes, null);
    return new TooLargeError(`${what} is ${sizeInWords(bytes)} (${bytes} bytes), more than the API takes in one request (it answered: ${(e as Error).message.replace(/\s+/g, " ").slice(0, 160)}; ` +
      `a hosted API takes at most 4.5 MB), and its object store gave no upload link`, bytes, 4_500_000);
  };
  return {
    claim: async (kinds) => (await call<{ run: Claim | null }>("POST", "/claim", null, { worker_id: workerId, kinds })).run,
    heartbeat: (id, lease) => call("POST", runPath(id, "/heartbeat"), lease, {}),
    events: async (id, lease, events) => {
      // In batches under the API's request limit (500 events of up to 16 KB each would be 8 MB in one).
      let batch: typeof events = [], size = 0;
      const max = Math.max(64 * 1024, Math.floor(INLINE_MAX_BYTES() * 0.75));
      for (const e of events) {
        const n = Buffer.byteLength(JSON.stringify(e)) + 1;
        if (batch.length && size + n > max) { await call("POST", runPath(id, "/events"), lease, { events: batch }); batch = []; size = 0; }
        batch.push(e); size += n;
      }
      if (batch.length) await call("POST", runPath(id, "/events"), lease, { events: batch });
    },
    complete: async (id, lease, c) => {
      const body = Buffer.from(JSON.stringify(c));
      try {
        if (body.length > INLINE_MAX_BYTES()) {
          const up = await upload(id, lease, "completion", body);
          if (up) return (await call<{ run: RunView }>("POST", runPath(id, "/complete"), lease, { upload: up })).run;
        }
        return (await call<{ run: RunView }>("POST", runPath(id, "/complete"), lease, c)).run;
      } catch (e) { if ((e as { status?: number }).status === 413) throw refused("the run's completion (its results)", body.length, e); throw e; }
    },
    checkout: async (id, lease, dir) => {
      const res = await fetch(url(runPath(id, "/workspace")), { headers: { authorization: `Bearer ${workerToken}`, "x-run-lease": lease, "x-workspace-transfer": "link" } });
      if (!res.ok) throw Object.assign(new Error(`GET workspace: ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
      if ((res.headers.get("content-type") ?? "").includes("json")) {
        // mold_v0-182: larger than the API answers: from the object store, with the link and the key it made for this checkout.
        const j = await res.json() as { version: number; manifest_sha256: string; download: { id: string; url: string; key: string; bytes: number; sha256: string } };
        let got: Response;
        try { got = await fetch(j.download.url); } catch (e) { throw Object.assign(new Error(`checkout from the object store: ${(e as Error).message}`), { status: 503 }); }
        if (!got.ok) throw Object.assign(new Error(`checkout from the object store: ${got.status} ${(await got.text()).slice(0, 200)}`), { status: 503 });
        const bundle = openTransfer(Buffer.from(j.download.key, "base64"), j.download.id, Buffer.from(await got.arrayBuffer()));
        if (bundle.length !== j.download.bytes || sha256Hex(bundle) !== j.download.sha256) throw Object.assign(new Error("checkout from the object store: not the bundle the API announced"), { status: 503 });
        unpackBundle(bundle, dir, j.manifest_sha256);
        return { version: Number(j.version) };
      }
      unpackBundle(Buffer.from(await res.arrayBuffer()), dir, res.headers.get("x-workspace-manifest-sha256") ?? undefined);
      return { version: Number(res.headers.get("x-workspace-version") ?? 0) };
    },
    stage: async (id, lease, dir) => {
      const { bundle } = packBundle(dir);
      type Staged = { manifest_sha256: string; files: number; unchanged: boolean };
      const viaStore = async () => {
        const up = await upload(id, lease, "workspace", bundle);
        return up ? call<Staged>("POST", runPath(id, "/workspace/commit"), lease, { upload: up }) : null;
      };
      try {
        // mold_v0-182: larger than the API takes in one request: straight to the object store (where it has links).
        if (bundle.length > INLINE_MAX_BYTES()) { const r = await viaStore(); if (r) return r; }
        try { return await call<Staged>("PUT", runPath(id, "/workspace"), lease, undefined, bundle); }
        catch (e) {
          // The platform in front of the API refused it below our own threshold (not the API's own limit): the store, once.
          if ((e as { status?: number }).status === 413 && bundle.length <= INLINE_MAX_BYTES() && !(e as { detail?: { limit?: number } }).detail?.limit) {
            const r = await viaStore(); if (r) return r;
          }
          throw e;
        }
      } catch (e) { if ((e as { status?: number }).status === 413) throw refused("the workspace's write-back", bundle.length, e); throw e; }
    },
    credentials: (id, lease) => call("GET", runPath(id, "/credentials"), lease),
  };
}

// ---------- the egress proxy for one run ----------

const freeTcp = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer(); s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});
const freeUdp = () => new Promise<number>((resolve, reject) => {
  const s = createSocket("udp4"); s.once("error", reject);
  s.bind(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

export interface RunProxy { port: number; env: Record<string, string>; log: string; stop: () => void }
/** Start the sandboxes' egress proxy for one run's allowlist on free local ports; resolves once it accepts connections. */
export async function startRunProxy(hosts: string[], dir: string, exact: string[] = []): Promise<RunProxy> {
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "egress-proxy.mjs"), allow = path.join(dir, "egress-allow.json"), log = path.join(dir, "egress.log");
  writeFileSync(script, proxySource());
  // `exact`: hosts allowed exactly, not their subdomains (a company's own, mold_v0-075).
  writeFileSync(allow, JSON.stringify({ hosts, exact }));
  const [port, tport, dport] = [await freeTcp(), await freeTcp(), await freeUdp()];
  const proc = spawn(process.execPath, [script, allow, log, String(port), String(tport), String(dport)], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
  const stop = () => { if (proc.exitCode === null) proc.kill("SIGKILL"); };
  for (let i = 0; ; i++) {
    const up = await new Promise<boolean>((r) => {
      const c = net.connect(port, "127.0.0.1", () => { c.destroy(); r(true); });
      c.on("error", () => r(false));
    });
    if (up) break;
    if (proc.exitCode !== null || i > 60) { stop(); throw new Error("the run's egress proxy did not start"); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const p = `http://127.0.0.1:${port}`;
  const env = { HTTPS_PROXY: p, HTTP_PROXY: p, https_proxy: p, http_proxy: p, ALL_PROXY: p, all_proxy: p, NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1", npm_config_proxy: p, npm_config_https_proxy: p };
  return { port, env, log, stop };
}

// ---------- one run ----------

export interface HarnessOptions {
  /**
   * The run's user (mold_v0-078): by default every run gets a uid of its own, leased from the reserved range
   * (src/run-users.ts: APP_RUN_UIDS, default 61000-64999) for that run alone and given back when it ends, never
   * the runner's own. A program cannot read the runner's memory or environment (/proc/<runner>/environ is the runner's),
   * its scratch is its own (mode 0700), and when the run ends every process of that user is killed and its files in the
   * shared temporary directories are removed: since no other run has that uid, that never touches another run. Needs
   * a runner started as root.
   *
   * `runAs` fixes the uid instead (tests, older setups): it is leased the same way, so a second run on the host that
   * asks for the same uid while the first runs is refused (an infrastructure failure, retried) rather than sharing it.
   */
  runAs?: { uid: number; gid: number };
  /** The reserved range to lease from (default APP_RUN_UIDS, else 61000-64999). */
  runUsers?: UidRange;
  /** A run user the caller already leased (a run sandbox's runner, which locks its uid down first); the caller releases it. */
  runUser?: RunUser;
  /** Where the leases are kept (default APP_RUN_UID_DIR, else /run/app-run-uids). Tests only. */
  runUidDir?: string;
  /**
   * Run the programs as the runner's own user, without the protection above (offline tests only). A program can then
   * read the runner's environment (its worker token; on the server, the vault key and database address) and start
   * processes that outlive the run. Refused unless set: the harness will not run a program unisolated by default.
   */
  allowSameUser?: boolean;
  /** Where a pack's files are (src/packs.ts packDir by default). The run gets its own copy. */
  packDir?: (pack: string) => string;
  /**
   * "proxy" (default): the run's egress proxy, started here; "system": the sandbox's own proxy, already started with the
   * run's list behind the firewall (src/run-sandbox-runner.ts, mold_v0-055); "off": none (tests without network rules only).
   */
  egress?: "proxy" | "system" | "off";
  /** A scratch directory; a fresh one under the system's temp directory by default. Removed afterwards. */
  tmp?: string;
  /** Called with each heartbeat's answer (tests). */
  onHeartbeat?: (h: { cancel: boolean; reason: string | null }) => void;
  /** Where the private directory of a run's credential files is made: /dev/shm (tmpfs) by default, else the scratch. */
  secretsBase?: string;
  /** Called with the egress proxy's decision log before the scratch directory is removed (tests, diagnostics). */
  onProxyLog?: (log: string) => void;
  /** Agent-workspace runs (mold_v0-061): accept a file:/// agent repository (a mirror on this machine; offline tests). */
  allowFileUpstream?: boolean;
  /** Agent-workspace runs: accept an http:// agent repository (tests of the redirect refusal only). */
  allowHttpUpstream?: boolean;
  /**
   * Start the run's programs with no_new_privs (setpriv --no-new-privs): a setuid program or sudo in the sandbox gives
   * the run's user nothing (a run sandbox, mold_v0-055).
   */
  noNewPrivs?: boolean;
  /**
   * mold_v0-014: how often, while the run goes, the harness checks its short-lived credentials (a GitHub App's or an
   * OAuth connection's tokens, delivered with expires_at): once one has less than src/clock.ts REFRESH_MARGIN_MS left it
   * asks for the run's credentials again and rewrites the credential files and git's token files in place, so a program
   * that reads its file (or git, which asks its helper each time) keeps a working token past the token's life. Every
   * minute by default. A variable is set when a program starts: a long program should take such a credential as a file.
   */
  credentialRefreshMs?: number;
  /** The run tools (mold_v0-072): where the image installed them (APP_RUN_TOOLS_DIR, /opt/app-tools) and, for the offline tests only, another catalogue. */
  runTools?: { dir?: string; catalog?: ToolCatalog };
  /**
   * The checkout cache's directory (mold_v0-074): APP_RUN_CACHE_DIR, else /var/cache/app-checkouts for a runner
   * started as root (or its name before mold_v0-156 on a host that still has only that: src/run-users.ts hostDir),
   * else one under the system's temp directory. Per workspace inside it, capped at APP_RUN_CACHE_MAX_BYTES (2 GiB) per
   * workspace, entries unused for APP_RUN_CACHE_DAYS (7) removed.
   */
  cacheDir?: string;
}

/** The checkout cache's settings (mold_v0-074). */
const cacheBase = (o: HarnessOptions) => o.cacheDir ?? ENV.APP_RUN_CACHE_DIR ?? (process.getuid?.() === 0 ? hostDir("/var/cache/app-checkouts", LEGACY_HOST_DIRS.cache) : path.join(tmpdir(), `app-checkouts-${process.getuid?.() ?? 0}`));
const cacheMaxBytes = () => Math.max(1024 * 1024, Number(ENV.APP_RUN_CACHE_MAX_BYTES ?? 2 * 1024 ** 3) || 2 * 1024 ** 3);
const cacheDays = () => Math.max(0, Number(ENV.APP_RUN_CACHE_DAYS ?? 7) || 7);

export class HarnessConfigError extends Error {}
/** How a run's programs are isolated: a run user leased per run (the default for a runner started as root), a given one, or (tests) none. */
let warnedRunUid = false;
export type Isolation = { mode: "pool"; range: UidRange } | { mode: "fixed"; uid: number; gid: number } | { mode: "given"; user: RunUser } | null;
/** The isolation a runner uses: a run user per run, or (tests) an explicit opt-out. Throws when neither is possible. */
export function runIsolation(opts: HarnessOptions): Isolation {
  const root = process.getuid?.() === 0;
  if (opts.runUser) return { mode: "given", user: opts.runUser };
  if (opts.runAs) {
    const as = opts.runAs;
    if (!Number.isSafeInteger(as.uid) || !Number.isSafeInteger(as.gid) || as.uid <= 0 || as.gid <= 0) throw new HarnessConfigError("runAs: a uid and gid other than root");
    if (!root) throw new HarnessConfigError("runAs needs a runner started as root (to switch to the run's user)");
    if (as.uid === process.getuid?.()) throw new HarnessConfigError("runAs: the run's user must not be the runner's");
    return { mode: "fixed", uid: as.uid, gid: as.gid };
  }
  if (opts.allowSameUser) return null;
  if (root) {
    if (ENV.APP_RUN_UID && !warnedRunUid) {
      warnedRunUid = true;
      console.error("APP_RUN_UID is no longer read (mold_v0-078): every run leases a uid of its own from APP_RUN_UIDS (default 61000-64999)");
    }
    try { return { mode: "pool", range: opts.runUsers ?? runUidRange() }; }
    catch (e) { throw new HarnessConfigError((e as Error).message); }
  }
  throw new HarnessConfigError("the workspace harness runs programs only as a run user of their own (a runner started as root leases one per run, APP_RUN_UIDS): start it as root, or set allowSameUser in offline tests");
}

const INFRA_EXIT = 75;
const inside = (root: string, rel: string) => {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`${rel} is outside the pack`);
  return p;
};
const chownTree = (dir: string, uid: number, gid: number) => {
  chownSync(dir, uid, gid);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) chownTree(p, uid, gid); else chownSync(p, uid, gid);
  }
};
/**
 * Before the runner (root) reads what the run's user wrote: every process of that user gone, so nothing can swap a
 * file for a link between a check and a read. Killed again a few times; still alive, the run stops (infrastructure).
 */
function ensureUserGone(as: { uid: number; gid: number }) {
  for (let i = 0; i < 5; i++) {
    killUser(as);
    if (!processesOf(as.uid).length) return;
    spawnSync("/bin/sleep", ["0.2"]);
  }
  throw new HarnessConfigError(`processes of the run's user (${as.uid}) are still running: the run's files are not read`);
}

/** A program of the run, in its own process group; resolves with its exit code once it and its group are gone. */
function runProgram(cmd0: string, args0: string[], o: { cwd: string; env: Record<string, string>; as: { uid: number; gid: number } | null; nnp?: boolean;
  onStdout?: (line: string) => void; onStderr?: (text: string) => void; holder: { child: ChildProcess | null; timedOut?: boolean }; timeoutMs?: number }): Promise<number | null> {
  const [cmd, args] = o.nnp ? ["setpriv", ["--no-new-privs", "--", cmd0, ...args0]] as const : [cmd0, args0] as const;
  return new Promise((resolve) => {
    o.holder.timedOut = false;
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true,
      ...(o.as ? { uid: o.as.uid, gid: o.as.gid } : {}) });
    o.holder.child = child;
    let buf = "", done = false;
    const finish = (c: number | null) => {
      if (done) return; done = true;
      clearTimeout(t);
      killGroup(child, "SIGKILL"); // nothing the program left running in its group may touch the workspace after it ends
      if (buf.trim()) o.onStdout?.(buf);
      // Its output streams may be held open by a process outside its group: do not wait on them.
      child.stdout?.destroy(); child.stderr?.destroy();
      resolve(c);
    };
    const t = o.timeoutMs ? setTimeout(() => { o.holder.timedOut = true; killGroup(child, "SIGKILL"); if (o.as) killUser(o.as); }, o.timeoutMs) : setTimeout(() => {}, 0);
    // Decoded as streams: a character split between two chunks stays whole (else redaction could miss a value).
    child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) o.onStdout?.(l);
    });
    child.stderr!.on("data", (d: string) => o.onStderr?.(d));
    child.on("error", () => finish(INFRA_EXIT));
    // "exit", not "close": a grandchild holding stdout open must not keep the run waiting.
    child.on("exit", (c, sig) => setTimeout(() => finish(c ?? (sig ? 128 : null)), 200));
  });
}

/** Carry out one claimed run, from checkout to completion. Never throws for the run's own failures: it completes them. */
export async function runWorkspaceHarness(client: RunnerClient, claim: Claim, opts: HarnessOptions = {}): Promise<RunView | null> {
  const iso = runIsolation(opts);
  const prog = (cmd: string, args: string[], o: Omit<Parameters<typeof runProgram>[2], "nnp">) => runProgram(cmd, args, { ...o, nnp: !!opts.noNewPrivs });
  const run = claim.run, spec = run.spec, lease = claim.lease_token;
  // mold_v0-078: the run's own user, leased for this run alone (no other run on the host has its uid while it runs).
  const userNotes: { type: string; data: Record<string, unknown> }[] = [];
  let user: RunUser | null = null;
  if (iso) {
    try {
      user = iso.mode === "given" ? iso.user : await leaseRunUser(run.id, { ...(iso.mode === "fixed" ? { fixed: { uid: iso.uid, gid: iso.gid } } : { range: iso.range }),
        dir: opts.runUidDir, note: (type, data) => userNotes.push({ type, data }) });
    } catch (e) {
      // No run user free now (or a fixed one in use by another run): nothing ran; an infrastructure failure, retried.
      const busy = e instanceof RunUserError && e.kind === "busy";
      return client.complete(run.id, lease, { outcome: "failed", error_kind: "infrastructure", error: `prepare: ${busy ? "" : "the run's user: "}${(e as Error).message}`.slice(0, 2000) }).catch(() => null);
    }
  }
  const as = user ? { uid: user.uid, gid: user.gid } : null;
  /** The agent-workspace runner's configuration (mold_v0-061), or null for a program of the pack's own. */
  const agent = spec.runner === "agent-workspace" ? spec.agent : null;
  let scratch: string;
  try {
    if (as) { killUser(as); sweepUserFiles(as.uid); } // nothing of an earlier holder of this uid is left for this run
    scratch = mkdtempSync(path.join(opts.tmp ?? tmpdir(), `run-${run.id.slice(4, 12)}-`));
    for (const d of ["workspace", "checkout", "out", "home"]) if (d !== (agent ? "workspace" : "checkout")) mkdirSync(path.join(scratch, d), { recursive: true, mode: 0o700 });
  } catch (e) {
    // Before the run's own clean-up is in place: the leased user goes back now (never held by a run that is not going).
    if (user && iso?.mode !== "given") await user.release().catch(() => false);
    throw e;
  }
  // An agent run's directory is the agent repository's checkout; its snapshot is unpacked beside it, where only the
  // runner can read it (the run's user gets the write-back paths restored into the checkout, nothing else).
  const work = path.join(scratch, agent ? "checkout" : "workspace"), out = path.join(scratch, "out"), home = path.join(scratch, "home"), pack = path.join(scratch, "pack");
  const snap = path.join(scratch, "snapshot"), stageDir = path.join(scratch, "stage");
  // The pinned tree as it stood before the agent ran (after setup, without the workspace): the validation runs on a copy
  // of it with the staged write-back laid over, never on files the agent could have changed (its validator, its deps).
  const pristine = path.join(scratch, "pristine"), vdir = path.join(scratch, "validate");
  let proxy: RunProxy | null = null;
  let delivered: RunCredentials | null = null;
  const proc: { child: ChildProcess | null; timedOut?: boolean } = { child: null };
  let stopped: "cancelled" | "deadline" | "lease" | null = null;
  const pending: { type: string; data?: Record<string, unknown> }[] = [...userNotes, ...(as ? [{ type: "run_user", data: { uid: as.uid } }] : [])];
  let leaseLost = false;
  /** The credential values this run received: whatever it writes is redacted of them before it leaves the harness. */
  let secrets: Secret[] = [];
  // An agent may print its environment: the run's gateway token is redacted like a credential (it is revoked at the end).
  if (agent && claim.gateway.token) secrets.push({ name: "gateway token", value: claim.gateway.token });
  let secretDir: string | null = null;
  /** mold_v0-014: the credential files the running program has (its field files and git's token files), by credential. */
  let liveFiles: { name: string; path: string }[] = [];
  const dropSecrets = () => { liveFiles = []; if (secretDir) { rmSync(secretDir, { recursive: true, force: true }); secretDir = null; } };
  /** mold_v0-074: the checkout cache (entered for this run's workspace only) and the links it put into the checkout. */
  let cache: CheckoutCache | null = null;
  const mounts: { at: string; target: string }[] = [];
  let toolBin: string | null = null;
  /** mold_v0-182: what the write-back leaves out (the agent repository's .gitignore, the kind's write_back_ignore). */
  let wbIgnore: WriteBackIgnore | null = null;
  const flush = async () => {
    if (!pending.length || leaseLost) return;
    const batch = pending.splice(0, 500).map((e) => ({ type: redactText(e.type, secrets) === e.type ? e.type : "redacted", data: redactJson(e.data, secrets) }));
    await client.events(run.id, lease, batch).catch((e) => { if ((e as { status?: number }).status === 409) leaseLost = true; });
  };
  const complete = async (c0: Completion) => {
    if (leaseLost) return null; // another attempt owns the run now: nothing of this one may land
    const c: Completion = { ...c0, ...(c0.error !== undefined ? { error: redactText(c0.error, secrets) } : {}), ...(c0.results ? { results: redactJson(c0.results, secrets) } : {}) };
    await flush();
    try { return await client.complete(run.id, lease, c); }
    catch (e) {
      const status = (e as { status?: number }).status ?? 0;
      if (status === 409) return null;
      // Results the engine refuses (a record that is not there, another workspace's, listed twice, too many): the run failed.
      if (status >= 400 && status < 500 && c.outcome === "succeeded")
        return client.complete(run.id, lease, { outcome: "failed", error_kind: "run", error: `results refused: ${(e as Error).message}`.slice(0, 2000) });
      throw e;
    }
  };
  const stop = (why: NonNullable<typeof stopped>) => {
    stopped ??= why;
    const c = proc.child;
    if (c && c.exitCode === null) { killGroup(c, "SIGTERM"); setTimeout(() => { if (c.exitCode === null) killGroup(c, "SIGKILL"); }, 3000).unref(); }
    if (as) setTimeout(() => killUser(as), 3000).unref();
  };
  const beat = setInterval(async () => {
    try {
      const h = await client.heartbeat(run.id, lease);
      opts.onHeartbeat?.(h);
      if (h.cancel) stop(h.reason === "deadline" ? "deadline" : "cancelled");
      await flush();
    } catch (e) {
      if ((e as { status?: number }).status === 409) { leaseLost = true; stop("lease"); }
    }
  }, Math.max(1000, (claim.lease_seconds * 1000) / 3));
  /**
   * mold_v0-014: short-lived credentials outlive their tokens. Once one has less than REFRESH_MARGIN_MS left, the run's
   * credentials are asked for again (the engine mints or refreshes: the same margin there) and every file the running
   * program holds is rewritten in place (a new file renamed over the old: a reader sees one or the other); a credential no
   * longer given (a connection removed, an installation uninstalled) has its files emptied. The next program gets the
   * fresh values as it starts. Whatever the run writes is redacted of the old and the new.
   */
  let refreshTimer: NodeJS.Timeout | null = null;
  let refreshing: Promise<void> | null = null;
  const refreshCredentials = (): Promise<void> => {
    const due = (delivered?.credentials ?? []).some((c) => c.expires_at && Date.parse(c.expires_at) - clockNow() < REFRESH_MARGIN_MS);
    if (!due || leaseLost) return Promise.resolve();
    refreshing ??= (async () => {
      let fresh: RunCredentials;
      try { fresh = await client.credentials(run.id, lease); }
      catch (e) { pending.push({ type: "credentials_refresh_failed", data: { error: redactText(String((e as Error)?.message ?? e), secrets).slice(0, 300) } }); return; }
      const old = delivered!;
      secrets = [...secrets, ...fresh.credentials.filter((c) => !secrets.some((x) => x.value === c.value)).map((c) => ({ name: c.name, value: c.value }))];
      delivered = fresh;
      const changed: string[] = [], withdrawn: string[] = [];
      for (const o of old.credentials) {
        const n = fresh.credentials.find((c) => c.name === o.name);
        if (n && n.value === o.value) continue;
        (n ? changed : withdrawn).push(o.name);
        for (const f of liveFiles.filter((x) => x.name === o.name)) {
          try {
            const tmpFile = `${f.path}.${process.pid}.new`;
            writeFileSync(tmpFile, n && !(/[\r\n]/.test(n.value) && f.path.includes(".git-credential")) ? n.value : "", { mode: 0o400, flag: "wx" });
            if (as) chownSync(tmpFile, as.uid, as.gid);
            renameSync(tmpFile, f.path);
          } catch { /* the program ended and its directory went: nothing to rewrite */ }
        }
      }
      if (changed.length || withdrawn.length) pending.push({ type: "credentials_refreshed", data: { changed, withdrawn,
        expires_at: Object.fromEntries(fresh.credentials.filter((c) => c.expires_at).map((c) => [c.name, c.expires_at])) } });
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  const deadline = setTimeout(() => stop("deadline"), Math.max(0, new Date(claim.deadline_at).getTime() - Date.now()));
  const untilDeadline = () => Math.max(1000, new Date(claim.deadline_at).getTime() - Date.now());
  /**
   * mold_v0-074: the runner's own checkout step. The manifests (files of the checkout, read as root without following a
   * link, once every process of the run's user is gone) name repositories: each on one of the step's hosts, at a full
   * commit id. Each is fetched at exactly that commit (fetchPinned, outside the run's proxy as the agent repository is,
   * with the step's credential through git's credential helper for that host only) into the workspace's checkout cache,
   * and linked read-only at its mount in the checkout. The links are removed before the write-back is collected.
   */
  const checkoutStep = async (stepName: string, c: NonNullable<NonNullable<typeof agent>["steps"][number]["checkout"]>, values: Record<string, string>, timeoutMs: number) => {
    const t0 = Date.now();
    const glob = expand(c.manifests, values);
    if (glob.split("/").includes("..") || glob.startsWith("/")) throw new AgentRunError(`the manifests ${glob} are outside the checkout`);
    // By default from the workspace as restored (what earlier, validated runs committed), never from what this run's
    // programs wrote: they do not choose what the runner fetches with the step's credential (`source: "checkout"` lets them).
    const found = readManifests(c.source === "checkout" ? work : snap, glob, c.max_repos);
    const kindHosts = (spec.egress ?? []).map((h: string) => h.replace(/^\*\./, "").toLowerCase());
    const onHost = (h: string, list: string[]) => list.some((x) => h === x || h.endsWith(`.${x}`));
    const repos = found.map((m) => {
      const url = field(m.json, c.url), commit = field(m.json, c.commit), name = field(m.json, c.name);
      if (!url || !commit || !name) throw new AgentRunError(`${m.path}: no ${!url ? c.url : !commit ? c.commit : c.name}`);
      if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw new AgentRunError(`${m.path}: ${c.commit} is not a full commit id`);
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name === "." || name === "..") throw new AgentRunError(`${m.path}: ${c.name} is not a plain name`);
      let u: URL;
      try { u = new URL(url); } catch { throw new AgentRunError(`${m.path}: ${c.url} is not an address`); }
      const local = (opts.allowFileUpstream && u.protocol === "file:") || (opts.allowHttpUpstream && u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname));
      if (!local) {
        if (!/^https:\/\/[A-Za-z0-9.-]+(:443)?\/[A-Za-z0-9._~\/-]+$/.test(url)) throw new AgentRunError(`${m.path}: ${c.url} must be an https:// address with no user, query or fragment`);
        const h = u.hostname.toLowerCase();
        // Exactly one of the step's hosts (never a subdomain: the token is offered to that host alone).
        if (!c.hosts.includes(h)) throw new AgentRunError(`${m.path}: ${h} is not one of the step's hosts (${c.hosts.join(", ")})`);
        if (!onHost(h, kindHosts)) throw new AgentRunError(`${m.path}: ${h} is not in the kind's egress`);
      }
      const mount = expand(c.mount, { ...values, name });
      if (!mount || mount.startsWith("/") || mount.split("/").some((x) => x === "" || x === "." || x === "..") || /[\u0000-\u001f*?]/.test(mount)) throw new AgentRunError(`mount ${mount}: not a plain path inside the checkout`);
      return { url, commit, name, mount, at: m.path, proto: u.protocol.replace(/:$/, ""), host: u.host.toLowerCase() };
    });
    if (new Set(repos.map((r) => r.mount)).size !== repos.length) throw new AgentRunError("two repositories have the same mount");
    // A mount never replaces the workspace's own files (they would not be written back).
    for (const r of repos) { let st = null; try { st = lstatSync(path.join(snap, r.mount)); } catch { /* none */ } if (st) throw new AgentRunError(`the workspace holds files at ${r.mount}: a checkout is not mounted over them`); }
    if (!repos.length) { pending.push({ type: "agent_checkout_repos", data: { step: stepName, repos: [] } }); return; }
    if (!cache) { cache = new CheckoutCache(cacheBase(opts), run.org_id, { maxBytes: cacheMaxBytes(), maxAgeDays: cacheDays(), runUser: !!as }); cache.open(); }
    const cred = c.credential ? (delivered?.credentials ?? []).find((x) => x.name === c.credential) : undefined;
    if (c.credential && !cred) pending.push({ type: "git_credentials_missing", data: { names: [c.credential] } });
    const report: Record<string, unknown>[] = [];
    for (const r of repos) {
      if (Date.now() - t0 > timeoutMs) throw new AgentRunError(`ran past its time limit (${Math.round(timeoutMs / 1000)} s)`);
      const entry = await cache.get(r.url, r.commit, c.max_bytes, async (dest) => {
        let helperDir: string | null = null;
        try {
          let credentialHelper: { scope: string; script: string } | undefined;
          if (cred && r.proto !== "file") {
            const tmpfs = opts.secretsBase ?? (existsSync("/dev/shm") && statSync("/dev/shm").isDirectory() ? "/dev/shm" : null);
            if (!tmpfs) throw new AgentRunError("a credentialed checkout needs a tmpfs (/dev/shm)", "infrastructure");
            helperDir = mkdtempSync(path.join(tmpfs, "run-git-"));
            chmodSync(helperDir, 0o700);
            const g = gitCredentialFiles(helperDir, [{ protocol: r.proto as "https" | "http", host: r.host, username: c.username, value: cred.value }], null);
            credentialHelper = { scope: g.scopes[0]!, script: g.helper };
          }
          await fetchPinned(r.url, r.commit, dest, { allowFile: opts.allowFileUpstream, allowHttp: opts.allowHttpUpstream, home: path.join(scratch, "git-home-checkout"),
            timeoutMs: Math.max(1000, timeoutMs - (Date.now() - t0)), credentialHelper, maxTreeBytes: c.max_bytes });
        } finally { if (helperDir) rmSync(helperDir, { recursive: true, force: true }); }
      });
      const target = entry.tree;
      const { replaced } = mountInto(work, r.mount, target, as);
      mounts.push({ at: path.join(work, r.mount), target });
      report.push({ name: r.name, url: r.url, commit: r.commit, mount: r.mount, cached: entry.hit, bytes: entry.bytes, files: entry.files, ...(replaced ? { replaced: true } : {}) });
    }
    pending.push({ type: "agent_checkout_repos", data: { step: stepName, repos: report } });
  };
  try {
    let cmd: string, cmdArgs: string[], validator: { cmd: string; args: string[]; timeoutMs: number } | null;
    let declaredEnv: Record<string, string> = {};
    const t0 = Date.now();
    const usage: Record<string, unknown> = {};
    try {
      if (agent) {
        // mold_v0-061: the agent repository at exactly its pin, the declared paths stripped, the workspace laid over it.
        const values = argValues(agent, run);
        const got = await fetchPinned(agent.repository, agent.commit, work, { allowFile: opts.allowFileUpstream, allowHttp: opts.allowHttpUpstream, home: path.join(scratch, "git-home") });
        const stripped = stripPaths(work, [".git", ...agent.strip]);
        pending.push({ type: "agent_checkout", data: { commit: got.commit, files: got.files, stripped: stripped.length } });
        // mold_v0-182: what is never written back, read from the pinned tree now (before anything of the run's runs).
        const a = agent as typeof agent & { write_back_ignore?: string[]; write_back_gitignore?: boolean };
        wbIgnore = writeBackIgnore(work, a.write_back_ignore ?? [], a.write_back_gitignore ?? true);
        await client.checkout(run.id, lease, snap);
        chmodSync(snap, 0o700);
        // mold_v0-079: `strip` is the pinned tree's (its samples, its own data), applied at checkout only. What the
        // workspace holds is the workspace's: restored as it is, never stripped (a strip pattern that matches a file the
        // workspace keeps, its own series, say, would otherwise delete it on every run).
        const r = restoreInto(snap, work, agent.write_back);
        pending.push({ type: "workspace_restored", data: r });
        // mold_v0-072: the kind's tools, as pinned, from the image (never downloaded now), first on the run's PATH.
        if (agent.tools.length) {
          const catalog = opts.runTools?.catalog ?? RUN_TOOL_CATALOG;
          try { toolBin = linkTools(verifyTools(agent.tools, { dir: opts.runTools?.dir, catalog }), path.join(scratch, "tools-bin")); }
          catch (e) { throw e instanceof RunToolError ? new AgentRunError(`${e.message}: the runner image is not built for this kind (scripts/install-run-tools.ts)`) : e; }
          pending.push({ type: "agent_tools", data: { tools: agent.tools.map((t) => `${t} ${catalog[t]?.version ?? "?"}`) } });
        }
        cmd = agent.command[0] === "node" ? process.execPath : agent.command[0]!;
        cmdArgs = agent.command.slice(1).map((a) => expand(a, values));
        const gw: Record<string, string> = { "gateway.url": claim.gateway.gateway_url, ...(claim.gateway.token ? { "gateway.token": claim.gateway.token } : {}),
          ...Object.fromEntries(Object.entries(claim.gateway.providers).map(([slug, p]) => [`gateway.${slug}.base_url`, p.base_url])) };
        declaredEnv = Object.fromEntries(Object.entries(agent.env).map(([k, v]) => [k, expand(v, { ...values, ...gw })]));
        const vcmd = agent.validate.command;
        validator = { cmd: vcmd[0] === "node" ? process.execPath : vcmd[0]!, args: vcmd.slice(1), timeoutMs: agent.validate.timeout_seconds * 1000 };
      } else {
        const hs = spec as Extract<typeof spec, { runner: "workspace-harness" }>;
        // The run gets its own copy of the pack's files (the pack directory itself may be unreadable to the run's user).
        const pdir = path.resolve((opts.packDir ?? (await import("./packs.js")).packDir)(run.pack));
        inside(pdir, hs.entry); if (hs.validator) inside(pdir, hs.validator);
        cpSync(pdir, pack, { recursive: true, dereference: false, filter: (src) => !lstatSync(src).isSymbolicLink() });
        const entry = inside(pack, hs.entry);
        if (!existsSync(entry)) throw new Error(`the kind's entry ${hs.entry} is not in the pack`);
        cmd = process.execPath; cmdArgs = [entry];
        validator = hs.validator ? { cmd: process.execPath, args: [inside(pack, hs.validator), work, out], timeoutMs: 600_000 } : null;
        if (spec.workspace) await client.checkout(run.id, lease, work);
      }
      if ((opts.egress ?? "proxy") === "proxy") proxy = await startRunProxy(claim.egress.hosts, path.join(scratch, "egress"), claim.egress.exact ?? []);
      else if (opts.egress === "system") proxy = { port: EGRESS_PROXY_PORT, env: proxyEnv(), log: path.join(EGRESS_LOG_DIR, "app-egress.log"), stop: () => {} };
      if (as) {
        if (!agent) chownTree(pack, as.uid, as.gid);
        // 0700: the run's user only (on a runner that carries out several runs at once, never another run's user).
        for (const d of [work, out, home]) { chownTree(d, as.uid, as.gid); chmodSync(d, 0o700); }
        chmodSync(scratch, 0o711);
      }
    } catch (e) {
      dropSecrets();
      const kind = e instanceof AgentRunError ? e.kind : "infrastructure";
      return await complete({ outcome: "failed", error_kind: kind, error: `prepare: ${(e as Error).message}` });
    }
    const runEnv: Record<string, string> = {
      PATH: `${toolBin ? `${toolBin}:` : ""}${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, LANG: "C.UTF-8",
      RUN_ID: run.id, RUN_ATTEMPT: String(run.attempt), RUN_KIND: run.kind, RUN_OUT: out, RUN_WORKSPACE: work,
      RUN_SCOPE: JSON.stringify(run.scope), RUN_TARGETS: JSON.stringify(run.targets), RUN_DEADLINE: claim.deadline_at,
    };
    // mold_v0-079: a gated write is given the preview's output that was approved (its run, results and recorded files,
    // and the sha256 the approver saw), to apply exactly that.
    if (claim.approval) {
      try {
        const f = path.join(scratch, "approved-preview.json");
        writeFileSync(f, JSON.stringify(claim.approval, null, 2), { mode: 0o400, flag: "wx" });
        if (as) chownSync(f, as.uid, as.gid);
        runEnv.RUN_APPROVED_PREVIEW = f;
      } catch (e) { return await complete({ outcome: "failed", error_kind: "infrastructure", error: `prepare: the approved preview: ${(e as Error).message}` }); }
    }
    if (agent?.setup) {
      // The repository's own preparation (its dependencies): the run's egress, no credential, no gateway token.
      const s0 = Date.now();
      const sc = agent.setup.command;
      const code = await prog(sc[0] === "node" ? process.execPath : sc[0]!, sc.slice(1), { cwd: work, env: { ...runEnv, ...(proxy?.env ?? {}) }, as, holder: proc,
        timeoutMs: Math.min(agent.setup.timeout_seconds * 1000, untilDeadline()), onStdout: (l) => { if (pending.length < 5000) pending.push(lineEvent(redactText(l, secrets), "setup")); } });
      if (as) killUser(as);
      usage.setup_ms = Date.now() - s0;
      if (stopped === "lease") return null;
      if (stopped) return await complete({ outcome: "failed", error_kind: stopped === "deadline" ? "timeout" : "run", error: stopped === "deadline" ? "the run reached its deadline" : "cancelled" });
      if (proc.timedOut) return await complete({ outcome: "failed", error_kind: "timeout", error: `setup ran past its time limit (${agent.setup.timeout_seconds} s)` });
      if (code !== 0) return await complete({ outcome: "failed", error_kind: "run", error: `setup exited with ${code}` });
    }
    if (agent) {
      // Taken once setup's processes are gone and before the agent runs: the tree the validation will run in.
      try {
        if (as) ensureUserGone(as);
        cpSync(work, pristine, { recursive: true, dereference: false, verbatimSymlinks: true,
          filter: (src) => { const rel = path.relative(work, src); return !rel || !underWriteBack(rel.split(path.sep).join("/"), agent.write_back); } });
        chmodSync(pristine, 0o700);
      } catch (e) {
        return await complete({ outcome: "failed", error_kind: e instanceof HarnessConfigError ? "infrastructure" : "run", error: `prepare: the checkout could not be kept for validation: ${(e as Error).message}`.slice(0, 1000) });
      }
    }
    try {
      if (spec.credentials?.length || spec.operator_credentials?.length) {
        delivered = await client.credentials(run.id, lease);
        secrets = [...secrets, ...delivered.credentials.map((c) => ({ name: c.name, value: c.value }))];
        if (delivered.credentials.some((c) => c.expires_at)) refreshTimer = setInterval(() => void refreshCredentials(), Math.max(50, opts.credentialRefreshMs ?? 60_000));
      }
    } catch (e) {
      return await complete({ outcome: "failed", error_kind: "infrastructure", error: `prepare: ${(e as Error).message}` });
    }
    const base: Record<string, string> = {
      ...runEnv,
      // A program of the pack's own gets the gateway's variables for its kind's providers; an agent exactly what its
      // configuration declares (its env, with the run's gateway token where it says {gateway.token}).
      ...(agent ? declaredEnv : claim.gateway.env), ...(proxy?.env ?? {}),
    };
    /**
     * The credentials one program receives (mold_v0-034; per step since mold_v0-074): those it names (null: all the
     * kind's), each as its field delivers it (a variable, or a 0400 file in a private directory on tmpfs), and git's
     * credential helper for its git_credentials (gitCredentialFiles). The directory goes when the program ends.
     */
    const stepBase: Record<string, string> = { ...runEnv, ...(proxy?.env ?? {}) };
    const deliver = (names: string[] | null, git: { credential: string; host: string; username: string }[], env: Record<string, string> = base): Record<string, string> => {
      const chosen = (delivered?.credentials ?? []).filter((c) => names === null || names.includes(c.name));
      const files = chosen.filter((c) => c.file);
      const gits: GitCredential[] = [];
      const missing: string[] = [];
      const shadowedPaths: string[] = [];
      const gitNames: string[] = [];
      for (const g of git) {
        const c = (delivered?.credentials ?? []).find((x) => x.name === g.credential);
        if (c) { gits.push({ protocol: "https", host: g.host, username: g.username, value: c.value }); gitNames.push(c.name); } else missing.push(g.credential);
      }
      if (missing.length) pending.push({ type: "git_credentials_missing", data: { names: missing } });
      const extra: Record<string, string> = {};
      if (files.length || gits.length) {
        // On tmpfs when there is one: a value never reaches a disk. Only the run's user can enter the directory.
        const tmpfs = opts.secretsBase ?? (existsSync("/dev/shm") && statSync("/dev/shm").isDirectory() ? "/dev/shm" : null);
        if (!tmpfs) throw new Error("credential files need a tmpfs (/dev/shm, or secretsBase): none here, so none is written to disk");
        secretDir = mkdtempSync(path.join(tmpfs, "run-cred-"));
        chmodSync(secretDir, 0o700);
        for (const f of files) {
          const p = path.join(secretDir, path.basename(f.file!));
          writeFileSync(p, f.value, { mode: 0o400, flag: "wx" });
          if (as) chownSync(p, as.uid, as.gid);
          liveFiles.push({ name: f.name, path: p });
          // mold_v0-075: the file's full path in the variable its field names (KUBECONFIG, a pack's own locator).
          if (f.path_env) { if (f.path_env in env || f.path_env in extra) shadowedPaths.push(f.name); else extra[f.path_env] = p; }
        }
        if (files.length) extra.RUN_CREDENTIALS_DIR = secretDir;
        if (gits.length) {
          Object.assign(extra, gitCredentialFiles(secretDir, gits, as).env);
          // gitCredentialFiles writes git-token-<i> in the order given: git's helper reads it at every request.
          gitNames.forEach((n, i) => liveFiles.push({ name: n, path: path.join(secretDir!, ".git-credential", `git-token-${i}`) }));
        }
        if (as) chownSync(secretDir, as.uid, as.gid);
      }
      // A credential's variable never replaces one the shell sets (a gateway provider's, say): that one is not delivered.
      const credEnv: Record<string, string> = {};
      const shadowed: string[] = [...shadowedPaths];
      for (const c of chosen) if (c.env) { if (c.env in env || c.env in extra) shadowed.push(c.name); else credEnv[c.env] = c.value; }
      if (shadowed.length) pending.push({ type: "credentials_shadowed", data: { names: shadowed } });
      return { ...credEnv, ...env, ...extra };
    };
    /** Programs' stderr, redacted whole and then cut (a cut never leaves part of a value behind). */
    const stderrTail = (err: string, cut: boolean, data: Record<string, unknown> = {}) => {
      if (cut) err = err.includes("\n") ? err.slice(err.indexOf("\n") + 1) : "";
      let tail = redactText(err, secrets);
      if (tail.length > 2000) { tail = tail.slice(-2000); tail = tail.includes("\n") ? tail.slice(tail.indexOf("\n") + 1) : ""; }
      if (tail.trim()) pending.push({ type: "stderr", data: { ...data, tail } });
    };
    const values = agent ? argValues(agent, run) : {};
    if (agent) {
      // mold_v0-073: the declared inputs, each a new file of the checkout (checked, capped, never a credential's value).
      try {
        const written: Record<string, unknown>[] = [];
        for (const [name, inp] of Object.entries(agent.inputs)) {
          const [root, ...rest] = inp.from.split(".");
          let v = rest.reduce<unknown>((o, k) => (o && typeof o === "object" && !Array.isArray(o) && Object.hasOwn(o, k) ? (o as Record<string, unknown>)[k] : undefined), root === "scope" ? run.scope : run.targets);
          if (v === undefined) throw new AgentRunError(`input ${name}: the run gives no ${inp.from}`);
          // mold_v0-166: repositories it lists without a commit are pinned to their branch's head, the value checked
          // against the schema first (nothing is asked of a repository for a value the schema refuses) and again below.
          if (inp.pin) {
            const first = checkInput(v, inp.schema as InputSchema);
            if (first.length) throw new AgentRunError(`input ${name} does not match its schema: ${first.slice(0, 5).join("; ").slice(0, 600)}`);
            const kindHosts = (spec.egress ?? []).map((h: string) => h.replace(/^\*\./, "").toLowerCase());
            const local = (u: string) => (!!opts.allowFileUpstream && u.startsWith("file:///"));
            v = await pinCommits(v, { ...inp.pin, hosts: inp.pin.hosts.filter((h) => kindHosts.some((x: string) => h === x || h.endsWith(`.${x}`))) }, (u, b) =>
              headCommit(u, b, { allowFile: opts.allowFileUpstream, home: path.join(scratch, "git-home-pin") }), local);
          }
          if (inp.format === "text" && typeof v !== "string") throw new AgentRunError(`input ${name}: a text input takes a string`);
          const body = Buffer.from(inp.format === "text" ? (v as string) : `${JSON.stringify(v, null, 2)}\n`, "utf8");
          // The size first: the schema's patterns never see more than the cap allows.
          if (body.length > inp.max_bytes) throw new AgentRunError(`input ${name} is ${body.length} bytes, more than its ${inp.max_bytes}`);
          const problems = checkInput(v, inp.schema as InputSchema);
          if (problems.length) throw new AgentRunError(`input ${name} does not match its schema: ${problems.slice(0, 5).join("; ").slice(0, 600)}`);
          // Never a secret: a value of the run's credentials or its gateway token is not written into the checkout.
          const hit = findSecret(body, secrets);
          if (hit) throw new AgentRunError(`input ${name} holds the value of credential ${hit}: it is not written`);
          writeInputFile(work, inp.path, body, as);
          written.push({ name, path: inp.path, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
        }
        if (written.length) pending.push({ type: "agent_inputs", data: { inputs: written } });
      } catch (e) {
        return await complete({ outcome: "failed", error_kind: "run", error: `inputs: ${(e as Error).message}`.slice(0, 1000) });
      }
      // mold_v0-074: the steps before the command, in order.
      for (const step of agent.steps) {
        const s0 = Date.now();
        await refreshCredentials(); // mold_v0-014: a step (a checkout's fetch too) starts with tokens that have time left
        if (step.checkout) {
          try {
            if (as) ensureUserGone(as);
            await checkoutStep(step.name, step.checkout, values, Math.min(step.timeout_seconds * 1000, untilDeadline()));
          } catch (e) {
            if (e instanceof HarnessConfigError) return await complete({ outcome: "failed", error_kind: "infrastructure", error: e.message });
            const kind = e instanceof AgentRunError ? e.kind : "infrastructure";
            return await complete({ outcome: "failed", error_kind: kind, error: redactText(`step ${step.name}: ${(e as Error).message}`, secrets).slice(0, 1000) });
          }
          usage[`step_${step.name}_ms`] = Date.now() - s0;
          if (stopped === "lease") return null;
          if (stopped) return await complete({ outcome: "failed", error_kind: stopped === "deadline" ? "timeout" : "run", error: stopped === "deadline" ? "the run reached its deadline" : "cancelled" });
          continue;
        }
        let env: Record<string, string>;
        // A step gets the run's own variables and only what it names: the kind's env (the gateway token) only with env: true.
        try { env = deliver(step.credentials, step.git_credentials, step.env ? base : stepBase); }
        catch (e) { dropSecrets(); return await complete({ outcome: "failed", error_kind: e instanceof AgentRunError ? e.kind : "infrastructure", error: `step ${step.name}: ${(e as Error).message}` }); }
        const sc = step.command!;
        let serr = "", scut = false;
        const code = await prog(sc[0] === "node" ? process.execPath : sc[0]!, sc.slice(1).map((a) => expand(a, values)), { cwd: work, env, as, holder: proc,
          timeoutMs: Math.min(step.timeout_seconds * 1000, untilDeadline()),
          onStdout: (l) => { if (pending.length < 5000) pending.push({ type: "step_log", data: { step: step.name, line: redactText(l, secrets).slice(0, 2000) } }); },
          onStderr: (t) => { serr += t; if (serr.length > 65536) { serr = serr.slice(-65536); scut = true; } } });
        const stepTimedOut = !!proc.timedOut;
        if (as) killUser(as);
        dropSecrets(); // a step's credential files and git's helper go with it: the next step gets only its own
        usage[`step_${step.name}_ms`] = Date.now() - s0;
        stderrTail(serr, scut, { step: step.name });
        if (stopped === "lease") return null;
        if (stopped) return await complete({ outcome: "failed", error_kind: stopped === "deadline" ? "timeout" : "run", error: stopped === "deadline" ? "the run reached its deadline" : "cancelled" });
        if (stepTimedOut) return await complete({ outcome: "failed", error_kind: "timeout", error: `step ${step.name} ran past its time limit (${step.timeout_seconds} s): every process of the run was stopped` });
        if (code === INFRA_EXIT) return await complete({ outcome: "failed", error_kind: "infrastructure", error: `step ${step.name} reported an infrastructure failure (exit 75)` });
        if (code !== 0) return await complete({ outcome: "failed", error_kind: "run", error: `step ${step.name} exited with ${code}` });
      }
    }
    await refreshCredentials();
    let env: Record<string, string>;
    // The command: the credentials it names, else all the kind's but a checkout's (that one is the runner's own).
    const checkoutCreds = new Set((agent?.steps ?? []).flatMap((st) => st.checkout?.credential ? [st.checkout.credential] : []));
    // mold_v0-075: an operator credential reaches an agent's command only when its `credentials` name it (never by
    // default: an agent reads the workspace's files, which its people write). A program of the pack's own gets all.
    try { env = agent ? deliver(agent.credentials ?? (spec.credentials ?? []).filter((n: string) => !checkoutCreds.has(n)), agent.git_credentials) : deliver(null, []); }
    catch (e) { dropSecrets(); return await complete({ outcome: "failed", error_kind: "infrastructure", error: `prepare: ${(e as Error).message}` }); }
    let err = "", errCut = false;
    const c0 = Date.now();
    const code = await prog(cmd, cmdArgs, { cwd: work, env, as, holder: proc,
      ...(agent ? { timeoutMs: Math.min(agent.timeout_seconds * 1000, untilDeadline()) } : {}),
      onStdout: (l) => { if (pending.length < 5000) pending.push(lineEvent(redactText(l, secrets))); }, onStderr: (t) => { err += t; if (err.length > 65536) { err = err.slice(-65536); errCut = true; } } });
    const timedOut = !!proc.timedOut;
    if (as) killUser(as); // whatever the program started, in any group or session, ends with it
    dropSecrets(); // the files go with the entry program: the validator and the write-back never see them
    usage.command_ms = Date.now() - c0; usage.exit = code;
    // Redacted whole, then cut: a cut never leaves part of a value behind (a cut window loses its first, partial line).
    stderrTail(err, errCut);
    // The agent's transcript and usage files (record), whatever its outcome: what it did is worth keeping either way.
    if (agent?.record.length && stopped !== "lease") {
      try { if (as) ensureUserGone(as); for (const f of recordedFiles(work, agent.record)) pending.push({ type: "agent_file", data: f }); }
      catch (e) { pending.push({ type: "agent_file_error", data: { error: (e as Error).message.slice(0, 300) } }); }
    }
    // mold_v0-071: every file the run wrote under its output directory (a result file, a report), recorded the same way.
    if (agent && stopped !== "lease") {
      try { if (as) ensureUserGone(as); for (const f of recordedFiles(out, ["**"])) pending.push({ type: "agent_output", data: f }); }
      catch (e) { pending.push({ type: "agent_file_error", data: { error: (e as Error).message.slice(0, 300) } }); }
    }
    if (stopped === "lease") return null;
    if (stopped === "cancelled") return await complete({ outcome: "failed", error_kind: "run", error: "cancelled" });
    if (stopped === "deadline") return await complete({ outcome: "failed", error_kind: "timeout", error: "the run reached its deadline" });
    if (agent && timedOut) { pending.push({ type: "agent_usage", data: usage }); return await complete({ outcome: "failed", error_kind: "timeout", error: `the agent ran past its time limit (${agent.timeout_seconds} s): every process of the run was stopped` }); }
    if (code === INFRA_EXIT) return await complete({ outcome: "failed", error_kind: "infrastructure", error: "the run reported an infrastructure failure (exit 75)" });
    if (code !== 0) { if (agent) pending.push({ type: "agent_usage", data: usage }); return await complete({ outcome: "failed", error_kind: "run", error: `the run exited with ${code}` }); }
    if (agent) {
      // What would be written back, collected now (every process of the run is gone), and validated as such: a copy of
      // the pinned tree with exactly the staged write-back paths laid over it.
      try {
        if (as) ensureUserGone(as);
        // The checkout cache's links (mold_v0-074) are never part of the workspace: gone before the write-back is read.
        // Each only where every directory on its way is still a real one of the checkout (the run may have swapped one for a link).
        for (const m of mounts) {
          try {
            const rel = path.relative(work, m.at).split(path.sep);
            let cur = work, real = true;
            for (const p of rel.slice(0, -1)) { cur = path.join(cur, p); if (!lstatSync(cur).isDirectory()) { real = false; break; } }
            if (real && lstatSync(m.at).isSymbolicLink()) rmSync(m.at, { force: true });
          } catch { /* gone */ }
        }
        // Written back as the run left it (mold_v0-079: strip is applied at checkout only, never to the workspace).
        const wb = collectWriteBack(work, snap, stageDir, agent.write_back, wbIgnore);
        if (wb.skipped.length) pending.push({ type: "workspace_skipped", data: { skipped: wb.skipped } });
        if (wb.ignored.paths) pending.push({ type: "workspace_ignored", data: { paths: wb.ignored.paths, sample: wb.ignored.sample,
          why: "ignored by the agent repository's .gitignore or the kind's write_back_ignore: never written back" } });
        cpSync(pristine, vdir, { recursive: true, dereference: false, verbatimSymlinks: true });
        restoreInto(stageDir, vdir, agent.write_back);
        if (as) { chownTree(vdir, as.uid, as.gid); }
      } catch (e) {
        if (e instanceof HarnessConfigError) return await complete({ outcome: "failed", error_kind: "infrastructure", error: e.message });
        // The store's own limits (files, bytes), met while the write-back was collected: refused, naming the limit.
        const lim = /more than (\d+) (files|bytes)/.exec((e as Error).message);
        if (lim) pending.push({ type: "workspace_write_back_refused", data: { bytes: null, limit: Number(lim[1]), unit: lim[2], reason: (e as Error).message.slice(0, 1000) } });
        return await complete({ outcome: "failed", error_kind: "run", error: `write back: ${(e as Error).message}`.slice(0, 1000) });
      }
    }
    if (validator) {
      const v0 = Date.now();
      const venv: Record<string, string> = agent ? { ...runEnv, RUN_WORKSPACE: vdir, ...(proxy?.env ?? {}) } : { PATH: env.PATH!, HOME: home, LANG: "C.UTF-8", RUN_ID: run.id };
      const v = await prog(validator.cmd, validator.args, { cwd: agent ? vdir : work, env: venv, as, holder: proc,
        timeoutMs: Math.min(validator.timeoutMs, untilDeadline()),
        ...(agent ? { onStdout: (l: string) => { if (pending.length < 5000) pending.push(lineEvent(redactText(l, secrets), "validate")); } } : {}) });
      const vTimedOut = !!proc.timedOut;
      if (as) killUser(as);
      usage.validate_ms = Date.now() - v0; usage.validate_exit = v;
      if (agent) pending.push({ type: "agent_usage", data: { ...usage, total_ms: Date.now() - t0 } });
      if (stopped === "lease") return null;
      if (stopped) return await complete({ outcome: "failed", error_kind: stopped === "deadline" ? "timeout" : "run", error: stopped === "deadline" ? "the run reached its deadline" : "cancelled" });
      if (vTimedOut && agent) return await complete({ outcome: "failed", error_kind: "validation", error: `validation ran past its time limit (${agent.validate.timeout_seconds} s): the workspace is not written back` });
      if (v !== 0) return await complete({ outcome: "failed", error_kind: "validation", error: `validation exited with ${v}: the workspace is not written back` });
    }
    let results: unknown[] = [];
    let text: string | null = null;
    // Read without following a link and only from a plain file (the run's user owns these directories).
    const rf = agent?.results_from as ResultsFrom | undefined;
    try {
      if (as) ensureUserGone(as);
      text = rf ? readInside(out, rf.file) : agent?.results ? readInside(work, agent.results) : readInside(out, "results.json");
      if (text === null && rf) throw new Error(`results_from: ${rf.file} is missing: the program wrote no result file`);
      if (text === null && agent?.results) throw new Error(`${agent.results} is missing: the agent wrote no results`);
    }
    catch (e) { return await complete({ outcome: "failed", error_kind: "run", error: `results: ${(e as Error).message}` }); }
    if (text !== null && rf) {
      // mold_v0-071: the program's own result file, mapped; redacted as text first, as a results list is. Every result
      // is checked again by the engine (references in the run's own workspace, status, fingerprint, sizes).
      try {
        let doc: unknown;
        try { doc = JSON.parse(redactText(text, secrets)); } catch { throw new AgentRunError(`results_from: ${rf.file} is not valid JSON`); }
        // Redacted again once parsed (a value written with escapes the text form hid), before anything is cut.
        const m = mapResults(JSON.stringify(redactJson(doc, secrets)), rf, values);
        const mode = spec.unresolved_references ?? "reject";
        pending.push({ type: "results_mapped", data: { file: rf.file, items: m.items, results: m.results.length, skipped: m.skipped, unmapped: m.unmapped.length } });
        if (m.unmapped.length) {
          if (mode === "reject") throw new AgentRunError(`results_from: item ${m.unmapped[0]!.item} does not map (${m.unmapped[0]!.reason})${m.unmapped.length > 1 ? ` and ${m.unmapped.length - 1} more` : ""}`);
          pending.push({ type: "result_unmapped", data: { count: m.unmapped.length, items: m.unmapped.slice(0, 20) } });
          if (m.unmapped.length > (spec.max_unresolved ?? 100)) throw new AgentRunError(`results_from: ${m.unmapped.length} items do not map (this kind accepts at most ${spec.max_unresolved ?? 100})`);
        }
        results = redactJson(m.results, secrets) as unknown[];
      } catch (e) { return await complete({ outcome: "failed", error_kind: "run", error: `results: ${(e as Error).message}`.slice(0, 1000) }); }
    } else if (text !== null) {
      // Redacted as text first (a value as a number, or in a form a parser would undo), then as values.
      try { results = redactJson(JSON.parse(redactText(text, secrets)), secrets); if (!Array.isArray(results)) throw new Error("not a list"); }
      // A parse error quotes the file (which may hold a value, cut where redaction cannot see it): never its text.
      catch (e) { return await complete({ outcome: "failed", error_kind: "run", error: `results.json: ${e instanceof SyntaxError ? "not valid JSON" : (e as Error).message}` }); }
    }
    if (spec.workspace) {
      let dir = work;
      // Only the write-back paths of the checkout (and what the snapshot held outside them), as validated, are staged.
      if (agent) dir = stageDir;
      // A credential written into the workspace would outlive the run in its store: such a workspace is not written back.
      const leaked = secrets.length ? secretIn(dir, secrets) : null;
      if (leaked) return await complete({ outcome: "failed", error_kind: "run", error: `the workspace holds the value of credential ${leaked}: it is not written back` });
      try { await client.stage(run.id, lease, dir); }
      catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 409) return null;
        // mold_v0-182: refused for its size: an event naming the size and the limit, and the run's error says the same.
        if (status === 413) {
          const t = e as Partial<TooLargeError>;
          pending.push({ type: "workspace_write_back_refused", data: { bytes: t.bytes ?? null, limit: t.limit ?? null, reason: String((e as Error).message).slice(0, 1000) } });
        }
        // A workspace the run left unpackable (a symbolic link, a special file, too big) is the run's failure, not the infrastructure's.
        return await complete({ outcome: "failed", error_kind: status === 400 || status === 413 ? "run" : "infrastructure", error: `write back: ${(e as Error).message}` });
      }
    }
    return await complete({ outcome: "succeeded", results });
  } finally {
    clearInterval(beat); clearTimeout(deadline); if (refreshTimer) clearInterval(refreshTimer);
    if (as) { killUser(as); sweepUserFiles(as.uid); }
    dropSecrets();
    (cache as CheckoutCache | null)?.close();
    proxy?.stop();
    if (proxy && opts.onProxyLog) { try { opts.onProxyLog(readFileSync(proxy.log, "utf8")); } catch { opts.onProxyLog(""); } }
    rmSync(scratch, { recursive: true, force: true });
    // mold_v0-078: the uid goes back only once none of its processes is left (else it stays out of use: quarantined).
    // A run user the caller leased (a run sandbox's) is the caller's to give back.
    if (user && iso?.mode !== "given") await user.release().catch((e) => console.error(`run ${run.id}: releasing its run user ${user!.uid}: ${(e as Error).message}`));
  }
}

/** A file inside `root` read without following a link anywhere on its path (the run's user may have planted one). */
function readInside(root: string, rel: string): string | null {
  let cur = root;
  for (const p of rel.split("/").slice(0, -1)) {
    cur = path.join(cur, p);
    let st; try { st = lstatSync(cur); } catch { return null; }
    if (!st.isDirectory()) throw new Error(`${rel}: ${p} is not a directory`);
  }
  let fd: number;
  try { fd = openSync(path.join(root, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error(`${rel}: ${(e as NodeJS.ErrnoException).code === "ELOOP" ? "a symbolic link" : "unreadable"}`); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw new Error(`${rel} is not a plain file`);
    if (st.size > 32 * 1024 * 1024) throw new Error(`${rel} is too big`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

/** The name of a credential whose value is in a file under `dir` (links are not followed), or null. */
function secretIn(dir: string, secrets: Secret[]): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    // Its name too: a file named after a value would carry it in the snapshot's manifest.
    const hit = findSecret(e.name, secrets) ?? (e.isDirectory() ? secretIn(p, secrets) : e.isFile() ? findSecret(readFileSync(p), secrets) : null);
    if (hit) return hit;
  }
  return null;
}

function killGroup(c: ChildProcess, signal: NodeJS.Signals) {
  try { if (c.pid) process.kill(-c.pid, signal); } catch { /* already gone */ }
}

/** Event types the harness and the engine write: a program's line claiming one is a log line. */
export const RESERVED_EVENT = /^(queued|claimed|retry|succeeded|failed|cancelled|cancel_requested|waiting|approved|approval_used|run_user.*|credentials.*|git_credentials.*|agent_.*|workspace_.*|results?_.*|stderr|setup_log|validate_log|step_log|log|redacted)$/;
function lineEvent(line: string, step?: "setup" | "validate"): { type: string; data?: Record<string, unknown> } {
  const l = line.slice(0, 8000);
  // A setup or validation step's lines are its log, never events of the run (they could not pose as one).
  if (step) return { type: `${step}_log`, data: { line: l.slice(0, 2000) } };
  if (l.startsWith("{")) {
    try {
      const j = JSON.parse(l);
      // The harness's and the engine's own event types are never a program's (it could not pose as one: an approval, a
      // recorded file that a preview's digest counts, its run user, its credentials). Found by the review of mold_v0-078.
      if (j && typeof j.event === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/.test(j.event) && !RESERVED_EVENT.test(j.event)) { const { event, ...data } = j; return { type: event, data }; }
    } catch { /* plain text */ }
  }
  return { type: "log", data: { line: l.slice(0, 2000) } };
}

/**
 * Claim and carry out runs until none is left (a runner with the fleet token; a run sandbox's runner carries out its one
 * run instead, src/run-sandbox-runner.ts).
 * One run's failure to complete (the engine unreachable) never stops the loop: that run's lease lapses and it is retried.
 */
export async function drainRuns(client: RunnerClient, opts: HarnessOptions & { kinds?: string[]; max?: number } = {}): Promise<number> {
  runIsolation(opts); // refuse before claiming anything
  let n = 0;
  for (; n < (opts.max ?? Infinity); n++) {
    const c = await client.claim(opts.kinds);
    if (!c) break;
    try { await runWorkspaceHarness(client, c, opts); }
    catch (e) { console.error(`run ${c.run.id}: ${(e as Error).message}`); }
  }
  return n;
}
