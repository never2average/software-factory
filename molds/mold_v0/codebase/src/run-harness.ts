/**
 * The "workspace-harness" runner (mold_v0-041, with the workspace store of mold_v0-033): how a claimed run is carried
 * out. The contract a runner keeps, wherever it runs:
 *
 *   1. claim       POST /api/worker/runs/claim (the fleet token) or claimRun() in-process: the run, its frozen job kind,
 *                  a lease token, a deadline, gateway env for the kind's providers, and the egress allowlist
 *   2. workspace   (kinds with workspace: true) check the workspace's latest snapshot out into an empty directory
 *   3. run         the kind's entry, a program in (the run's own copy of) the pack, with node, in that directory, as a
 *                  user kept for runs (runAs / OCTILLION_RUN_UID; never the runner's), with an environment built from
 *                  nothing: PATH, a private HOME, RUN_* (id, attempt, scope, targets, the output directory) and the
 *                  gateway env. Never the runner's own environment (database URL, vault key, worker token), which the
 *                  separate user cannot read either (/proc/<runner>/environ). When it ends, every process of that user
 *                  is killed. Without a separate user the harness refuses to run, unless told (allowSameUser, tests).
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
 * NOT enforced here: a process that ignores the proxy settings and connects directly. Only the sandbox VM's firewall
 * (setupScript in orchestrator/core/egress.ts: nftables/iptables by the agent's uid) closes that path, and runs are
 * not yet placed in sandbox VMs (this harness runs the program as a child process of the runner).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { proxySource } from "../orchestrator/core/egress.js";
import type { RunView } from "./pack-api.js";
import type { Claim, Completion } from "./runs.js";
import type { RunCredentials } from "./credentials.js";
import { findSecret, redactJson, redactText, type Secret } from "./credential-redact.js";
import { packBundle, unpackBundle } from "./workspace-bundle.js";

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

/** The engine over HTTP, as a runner elsewhere (a sandbox) reaches it: /api/worker/runs with the fleet token. */
export function httpRunnerClient(base: string, workerToken: string, workerId: string): RunnerClient {
  const url = (p: string) => `${base.replace(/\/$/, "")}/api/worker/runs${p}`;
  const call = async <T>(method: string, p: string, lease: string | null, body?: unknown, raw?: Buffer): Promise<T> => {
    const res = await fetch(url(p), {
      method, headers: { authorization: `Bearer ${workerToken}`, ...(lease ? { "x-run-lease": lease } : {}),
        ...(raw ? { "content-type": "application/octet-stream" } : body !== undefined ? { "content-type": "application/json" } : {}) },
      body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw Object.assign(new Error(`${method} ${p}: ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
    return (res.headers.get("content-type") ?? "").includes("json") ? (res.json() as Promise<T>) : (Buffer.from(await res.arrayBuffer()) as unknown as T);
  };
  return {
    claim: async (kinds) => (await call<{ run: Claim | null }>("POST", "/claim", null, { worker_id: workerId, kinds })).run,
    heartbeat: (id, lease) => call("POST", `/${encodeURIComponent(id)}/heartbeat`, lease, {}),
    events: async (id, lease, events) => void (await call("POST", `/${encodeURIComponent(id)}/events`, lease, { events })),
    complete: async (id, lease, c) => (await call<{ run: RunView }>("POST", `/${encodeURIComponent(id)}/complete`, lease, c)).run,
    checkout: async (id, lease, dir) => {
      const res = await fetch(url(`/${encodeURIComponent(id)}/workspace`), { headers: { authorization: `Bearer ${workerToken}`, "x-run-lease": lease } });
      if (!res.ok) throw Object.assign(new Error(`GET workspace: ${res.status} ${(await res.text()).slice(0, 300)}`), { status: res.status });
      unpackBundle(Buffer.from(await res.arrayBuffer()), dir, res.headers.get("x-workspace-manifest-sha256") ?? undefined);
      return { version: Number(res.headers.get("x-workspace-version") ?? 0) };
    },
    stage: (id, lease, dir) => call("PUT", `/${encodeURIComponent(id)}/workspace`, lease, undefined, packBundle(dir).bundle),
    credentials: (id, lease) => call("GET", `/${encodeURIComponent(id)}/credentials`, lease),
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
export async function startRunProxy(hosts: string[], dir: string): Promise<RunProxy> {
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "egress-proxy.mjs"), allow = path.join(dir, "egress-allow.json"), log = path.join(dir, "egress.log");
  writeFileSync(script, proxySource());
  writeFileSync(allow, JSON.stringify({ hosts }));
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
   * The user the run's programs run as (and only they): a uid and gid kept for runs, never the runner's own. Then a
   * program cannot read the runner's memory or environment (/proc/<runner>/environ is the runner's), its scratch is its
   * own (mode 0700), and when the run ends every process of that user is killed, so nothing it started outlives it or
   * touches the workspace while it is written back. Needs a runner started as root. One run at a time per user.
   * Default: OCTILLION_RUN_UID / OCTILLION_RUN_GID.
   */
  runAs?: { uid: number; gid: number };
  /**
   * Run the programs as the runner's own user, without the protection above (offline tests only). A program can then
   * read the runner's environment (its worker token; on the server, the vault key and database address) and start
   * processes that outlive the run. Refused unless set: the harness will not run a program unisolated by default.
   */
  allowSameUser?: boolean;
  /** Where a pack's files are (src/packs.ts packDir by default). The run gets its own copy. */
  packDir?: (pack: string) => string;
  /** "proxy" (default): the run's egress proxy; "off": none (tests without network rules only). */
  egress?: "proxy" | "off";
  /** A scratch directory; a fresh one under the system's temp directory by default. Removed afterwards. */
  tmp?: string;
  /** Called with each heartbeat's answer (tests). */
  onHeartbeat?: (h: { cancel: boolean; reason: string | null }) => void;
  /** Where the private directory of a run's credential files is made: /dev/shm (tmpfs) by default, else the scratch. */
  secretsBase?: string;
  /** Called with the egress proxy's decision log before the scratch directory is removed (tests, diagnostics). */
  onProxyLog?: (log: string) => void;
}

export class HarnessConfigError extends Error {}
/** The isolation a runner uses: a dedicated user, or (tests) an explicit opt-out. Throws when neither. */
export function runIsolation(opts: HarnessOptions): { uid: number; gid: number } | null {
  const env = process.env.OCTILLION_RUN_UID ? { uid: Number(process.env.OCTILLION_RUN_UID), gid: Number(process.env.OCTILLION_RUN_GID ?? process.env.OCTILLION_RUN_UID) } : null;
  const as = opts.runAs ?? env;
  if (as) {
    if (!Number.isSafeInteger(as.uid) || !Number.isSafeInteger(as.gid) || as.uid <= 0 || as.gid <= 0) throw new HarnessConfigError("runAs: a uid and gid other than root");
    if (process.getuid?.() !== 0) throw new HarnessConfigError("runAs needs a runner started as root (to switch to the run's user)");
    if (as.uid === process.getuid?.()) throw new HarnessConfigError("runAs: the run's user must not be the runner's");
    return as;
  }
  if (opts.allowSameUser) return null;
  throw new HarnessConfigError("the workspace harness runs programs only as a dedicated user (runAs, OCTILLION_RUN_UID): set one, or allowSameUser in offline tests");
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
/** Every process of the run's user, gone (kill -KILL -1 as that user signals all of its processes but itself). */
const killUser = (as: { uid: number; gid: number }) => { spawnSync("/bin/kill", ["-KILL", "-1"], { uid: as.uid, gid: as.gid, stdio: "ignore", timeout: 10_000 }); };

/** A program of the run, in its own process group; resolves with its exit code once it and its group are gone. */
function runProgram(file: string, args: string[], o: { cwd: string; env: Record<string, string>; as: { uid: number; gid: number } | null;
  onStdout?: (line: string) => void; onStderr?: (text: string) => void; holder: { child: ChildProcess | null }; timeoutMs?: number }): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true,
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
    const t = o.timeoutMs ? setTimeout(() => { killGroup(child, "SIGKILL"); }, o.timeoutMs) : setTimeout(() => {}, 0);
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
  const as = runIsolation(opts);
  if (as) { killUser(as); sweepUserFiles(as.uid); } // nothing of an earlier run (one whose runner died) is left for this one
  const run = claim.run, spec = run.spec, lease = claim.lease_token;
  const scratch = mkdtempSync(path.join(opts.tmp ?? tmpdir(), `run-${run.id.slice(4, 12)}-`));
  const work = path.join(scratch, "workspace"), out = path.join(scratch, "out"), home = path.join(scratch, "home"), pack = path.join(scratch, "pack");
  for (const d of [work, out, home]) mkdirSync(d, { recursive: true });
  let proxy: RunProxy | null = null;
  let delivered: RunCredentials | null = null;
  const proc: { child: ChildProcess | null } = { child: null };
  let stopped: "cancelled" | "deadline" | "lease" | null = null;
  const pending: { type: string; data?: Record<string, unknown> }[] = [];
  let leaseLost = false;
  /** The credential values this run received: whatever it writes is redacted of them before it leaves the harness. */
  let secrets: Secret[] = [];
  let secretDir: string | null = null;
  const dropSecrets = () => { if (secretDir) { rmSync(secretDir, { recursive: true, force: true }); secretDir = null; } };
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
  const deadline = setTimeout(() => stop("deadline"), Math.max(0, new Date(claim.deadline_at).getTime() - Date.now()));
  try {
    let entry: string, validator: string | null;
    try {
      // The run gets its own copy of the pack's files (the pack directory itself may be unreadable to the run's user).
      const pdir = path.resolve((opts.packDir ?? (await import("./packs.js")).packDir)(run.pack));
      inside(pdir, spec.entry); if (spec.validator) inside(pdir, spec.validator);
      cpSync(pdir, pack, { recursive: true, dereference: false, filter: (src) => !lstatSync(src).isSymbolicLink() });
      entry = inside(pack, spec.entry);
      validator = spec.validator ? inside(pack, spec.validator) : null;
      if (!existsSync(entry)) throw new Error(`the kind's entry ${spec.entry} is not in the pack`);
      if (spec.workspace) await client.checkout(run.id, lease, work);
      if ((opts.egress ?? "proxy") === "proxy") proxy = await startRunProxy(claim.egress.hosts, path.join(scratch, "egress"));
      if (as) { chownTree(pack, as.uid, as.gid); for (const d of [work, out, home]) chownTree(d, as.uid, as.gid); chmodSync(scratch, 0o711); }
      if (spec.credentials?.length) {
        delivered = await client.credentials(run.id, lease);
        secrets = delivered.credentials.map((c) => ({ name: c.name, value: c.value }));
        const files = delivered.credentials.filter((c) => c.file);
        if (files.length) {
          // On tmpfs when there is one: a value never reaches a disk. Only the run's user can enter the directory.
          const base = opts.secretsBase ?? (existsSync("/dev/shm") && statSync("/dev/shm").isDirectory() ? "/dev/shm" : null);
          if (!base) throw new Error("credential files need a tmpfs (/dev/shm, or secretsBase): none here, so none is written to disk");
          secretDir = mkdtempSync(path.join(base, "run-cred-"));
          chmodSync(secretDir, 0o700);
          for (const f of files) {
            const p = path.join(secretDir, path.basename(f.file!));
            writeFileSync(p, f.value, { mode: 0o400, flag: "wx" });
            if (as) chownSync(p, as.uid, as.gid);
          }
          if (as) chownSync(secretDir, as.uid, as.gid);
        }
      }
    } catch (e) {
      dropSecrets();
      return await complete({ outcome: "failed", error_kind: "infrastructure", error: `prepare: ${(e as Error).message}` });
    }
    const base: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8",
      RUN_ID: run.id, RUN_ATTEMPT: String(run.attempt), RUN_KIND: run.kind, RUN_OUT: out, RUN_WORKSPACE: work,
      RUN_SCOPE: JSON.stringify(run.scope), RUN_TARGETS: JSON.stringify(run.targets), RUN_DEADLINE: claim.deadline_at,
      ...(secretDir ? { RUN_CREDENTIALS_DIR: secretDir } : {}),
      ...claim.gateway.env, ...(proxy?.env ?? {}),
    };
    // A credential's variable never replaces one the shell sets (a gateway provider's, say): that one is not delivered.
    const credEnv: Record<string, string> = {};
    const shadowed: string[] = [];
    for (const c of delivered?.credentials ?? []) if (c.env) { if (c.env in base) shadowed.push(c.name); else credEnv[c.env] = c.value; }
    if (shadowed.length) pending.push({ type: "credentials_shadowed", data: { names: shadowed } });
    const env: Record<string, string> = { ...credEnv, ...base };
    let err = "", errCut = false;
    const code = await runProgram(entry, [], { cwd: work, env, as, holder: proc,
      onStdout: (l) => { if (pending.length < 5000) pending.push(lineEvent(redactText(l, secrets))); }, onStderr: (t) => { err += t; if (err.length > 65536) { err = err.slice(-65536); errCut = true; } } });
    if (as) killUser(as); // whatever the program started, in any group or session, ends with it
    dropSecrets(); // the files go with the entry program: the validator and the write-back never see them
    // Redacted whole, then cut: a cut never leaves part of a value behind (a cut window loses its first, partial line).
    if (errCut) err = err.includes("\n") ? err.slice(err.indexOf("\n") + 1) : "";
    let tail = redactText(err, secrets);
    if (tail.length > 2000) { tail = tail.slice(-2000); tail = tail.includes("\n") ? tail.slice(tail.indexOf("\n") + 1) : ""; }
    if (tail.trim()) pending.push({ type: "stderr", data: { tail } });
    if (stopped === "lease") return null;
    if (stopped === "cancelled") return await complete({ outcome: "failed", error_kind: "run", error: "cancelled" });
    if (stopped === "deadline") return await complete({ outcome: "failed", error_kind: "timeout", error: "the run reached its deadline" });
    if (code === INFRA_EXIT) return await complete({ outcome: "failed", error_kind: "infrastructure", error: "the run reported an infrastructure failure (exit 75)" });
    if (code !== 0) return await complete({ outcome: "failed", error_kind: "run", error: `the run exited with ${code}` });
    if (validator) {
      const v = await runProgram(validator, [work, out], { cwd: work, env: { PATH: env.PATH!, HOME: home, LANG: "C.UTF-8", RUN_ID: run.id }, as, holder: proc,
        timeoutMs: Math.min(600_000, Math.max(1000, new Date(claim.deadline_at).getTime() - Date.now())) });
      if (as) killUser(as);
      if (stopped === "lease") return null;
      if (stopped) return await complete({ outcome: "failed", error_kind: stopped === "deadline" ? "timeout" : "run", error: stopped === "deadline" ? "the run reached its deadline" : "cancelled" });
      if (v !== 0) return await complete({ outcome: "failed", error_kind: "validation", error: `validation exited with ${v}: the workspace is not written back` });
    }
    let results: unknown[] = [];
    const file = path.join(out, "results.json");
    if (existsSync(file)) {
      // Redacted as text first (a value as a number, or in a form a parser would undo), then as values.
      try { results = redactJson(JSON.parse(redactText(readFileSync(file, "utf8"), secrets)), secrets); if (!Array.isArray(results)) throw new Error("not a list"); }
      // A parse error quotes the file (which may hold a value, cut where redaction cannot see it): never its text.
      catch (e) { return await complete({ outcome: "failed", error_kind: "run", error: `results.json: ${e instanceof SyntaxError ? "not valid JSON" : (e as Error).message}` }); }
    }
    if (spec.workspace) {
      // A credential written into the workspace would outlive the run in its store: such a workspace is not written back.
      const leaked = secrets.length ? secretIn(work, secrets) : null;
      if (leaked) return await complete({ outcome: "failed", error_kind: "run", error: `the workspace holds the value of credential ${leaked}: it is not written back` });
      try { await client.stage(run.id, lease, work); }
      catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 409) return null;
        // A workspace the run left unpackable (a symbolic link, a special file, too big) is the run's failure, not the infrastructure's.
        return await complete({ outcome: "failed", error_kind: status === 400 || status === 413 ? "run" : "infrastructure", error: `write back: ${(e as Error).message}` });
      }
    }
    return await complete({ outcome: "succeeded", results });
  } finally {
    clearInterval(beat); clearTimeout(deadline);
    if (as) { killUser(as); sweepUserFiles(as.uid); }
    dropSecrets();
    proxy?.stop();
    if (proxy && opts.onProxyLog) { try { opts.onProxyLog(readFileSync(proxy.log, "utf8")); } catch { opts.onProxyLog(""); } }
    rmSync(scratch, { recursive: true, force: true });
  }
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

/**
 * Every file the run's user left in the shared temporary directories (/tmp, /var/tmp, /dev/shm), removed. Runs share
 * that user, so a copy of a credential (or anything else) left there would be readable by the next run, of any
 * workspace. Done before a run starts (what a runner that died left behind) and after it ends.
 */
export function sweepUserFiles(uid: number, roots = ["/tmp", "/var/tmp", "/dev/shm"]) {
  const sweep = (dir: string, depth: number) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.uid === uid) { rmSync(p, { recursive: true, force: true }); continue; }
      // Another owner's directory the run's user could still write into (world-writable, like /tmp itself).
      if (st.isDirectory() && (st.mode & 0o002) && depth < 4) sweep(p, depth + 1);
    }
  };
  for (const r of roots) sweep(r, 0);
}

function killGroup(c: ChildProcess, signal: NodeJS.Signals) {
  try { if (c.pid) process.kill(-c.pid, signal); } catch { /* already gone */ }
}

function lineEvent(line: string): { type: string; data?: Record<string, unknown> } {
  const l = line.slice(0, 8000);
  if (l.startsWith("{")) {
    try {
      const j = JSON.parse(l);
      if (j && typeof j.event === "string" && /^[a-z][a-z0-9_.:-]{0,63}$/.test(j.event)) { const { event, ...data } = j; return { type: event, data }; }
    } catch { /* plain text */ }
  }
  return { type: "log", data: { line: l.slice(0, 2000) } };
}

/**
 * Claim and carry out runs until none is left (the loop a runner process would run; no such process is deployed yet).
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
