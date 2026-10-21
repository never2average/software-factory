/**
 * The "workspace-harness" runner (mold_v0-041, with the workspace store of mold_v0-033): how a claimed run is carried
 * out. The contract a runner keeps, wherever it runs:
 *
 *   1. claim       POST /api/worker/runs/claim (the fleet token) or claimRun() in-process: the run, its frozen job kind,
 *                  a lease token, a deadline, gateway env for the kind's providers, and the egress allowlist
 *   2. workspace   (kinds with workspace: true) check the workspace's latest snapshot out into an empty directory
 *   3. run         the kind's entry, a program in the pack, with node, in that directory, with an environment built from
 *                  nothing: PATH, a private HOME, RUN_* (id, attempt, scope, targets, the output directory) and the
 *                  gateway env. Never the server's own environment (database URL, vault key, provider keys).
 *                  Its stdout lines are events (a JSON line {"event": "<type>", ...} is that event; anything else "log").
 *                  Exit 0: done. Exit 75: an infrastructure failure (the engine retries while attempts remain). Else failed.
 *   4. heartbeat   every lease_seconds / 3; on cancel=true (cancelled, or past the deadline) the program is stopped
 *   5. validate    the kind's validator, a program in the pack, with the workspace and output directories: exit 0 is valid
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
import { spawn, type ChildProcess } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { proxySource } from "../orchestrator/core/egress.js";
import type { RunView } from "./pack-api.js";
import type { Claim, Completion } from "./runs.js";
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
  /** Where a pack's files are (src/packs.ts packDir by default). */
  packDir?: (pack: string) => string;
  /** "proxy" (default): the run's egress proxy; "off": none (tests without network rules only). */
  egress?: "proxy" | "off";
  /** A scratch directory; a fresh one under the system's temp directory by default. Removed afterwards. */
  tmp?: string;
  /** Called with each heartbeat's answer (tests). */
  onHeartbeat?: (h: { cancel: boolean; reason: string | null }) => void;
  /** Called with the egress proxy's decision log before the scratch directory is removed (tests, diagnostics). */
  onProxyLog?: (log: string) => void;
}

const INFRA_EXIT = 75;
const inside = (root: string, rel: string) => {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`${rel} is outside the pack`);
  return p;
};

/** Carry out one claimed run, from checkout to completion. Never throws for the run's own failures: it completes them. */
export async function runWorkspaceHarness(client: RunnerClient, claim: Claim, opts: HarnessOptions = {}): Promise<RunView | null> {
  const run = claim.run, spec = run.spec, lease = claim.lease_token;
  const scratch = mkdtempSync(path.join(opts.tmp ?? tmpdir(), `run-${run.id.slice(4, 12)}-`));
  const work = path.join(scratch, "workspace"), out = path.join(scratch, "out"), home = path.join(scratch, "home");
  for (const d of [work, out, home]) mkdirSync(d, { recursive: true });
  let proxy: RunProxy | null = null;
  const proc: { child: ChildProcess | null } = { child: null };
  let stopped: "cancelled" | "deadline" | "lease" | null = null;
  const pending: { type: string; data?: Record<string, unknown> }[] = [];
  let leaseLost = false;
  const flush = async () => {
    if (!pending.length || leaseLost) return;
    const batch = pending.splice(0, 500);
    await client.events(run.id, lease, batch).catch((e) => { if ((e as { status?: number }).status === 409) leaseLost = true; });
  };
  const complete = async (c: Completion) => {
    if (leaseLost) return null; // another attempt owns the run now: nothing of this one may land
    await flush();
    try { return await client.complete(run.id, lease, c); }
    catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 409) return null;
      // Results the engine refuses (a record that is not there, a reference to another workspace's): the run failed.
      if (status === 400 && c.outcome === "succeeded")
        return client.complete(run.id, lease, { outcome: "failed", error_kind: "run", error: `results refused: ${(e as Error).message}`.slice(0, 2000) });
      throw e;
    }
  };
  const stop = (why: NonNullable<typeof stopped>) => {
    stopped ??= why;
    const c = proc.child;
    if (c && c.exitCode === null) { killGroup(c, "SIGTERM"); setTimeout(() => { if (c.exitCode === null) killGroup(c, "SIGKILL"); }, 3000).unref(); }
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
    let pdir: string, entry: string, validator: string | null;
    try {
      pdir = path.resolve((opts.packDir ?? (await import("./packs.js")).packDir)(run.pack));
      entry = inside(pdir, spec.entry);
      validator = spec.validator ? inside(pdir, spec.validator) : null;
      if (!existsSync(entry)) throw new Error(`the kind's entry ${spec.entry} is not in the pack`);
      if (spec.workspace) await client.checkout(run.id, lease, work);
      if ((opts.egress ?? "proxy") === "proxy") proxy = await startRunProxy(claim.egress.hosts, path.join(scratch, "egress"));
    } catch (e) {
      return await complete({ outcome: "failed", error_kind: "infrastructure", error: `prepare: ${(e as Error).message}` });
    }
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8",
      RUN_ID: run.id, RUN_ATTEMPT: String(run.attempt), RUN_KIND: run.kind, RUN_OUT: out, RUN_WORKSPACE: work,
      RUN_SCOPE: JSON.stringify(run.scope), RUN_TARGETS: JSON.stringify(run.targets), RUN_DEADLINE: claim.deadline_at,
      ...claim.gateway.env, ...(proxy?.env ?? {}),
    };
    const code = await new Promise<number | null>((resolve) => {
      // Its own process group, so a stop (and the end of the run) takes whatever it started with it.
      const child = spawn(process.execPath, [entry], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      proc.child = child;
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const l of lines) if (l.trim() && pending.length < 5000) pending.push(lineEvent(l));
      });
      let err = "";
      child.stderr!.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-4000); });
      child.on("error", () => resolve(INFRA_EXIT));
      child.on("close", (c) => {
        killGroup(child, "SIGKILL"); // nothing the program left running may touch the workspace after it ends
        if (buf.trim()) pending.push(lineEvent(buf)); if (err.trim()) pending.push({ type: "stderr", data: { tail: err.slice(-2000) } }); resolve(c);
      });
    });
    if (stopped === "lease") return null;
    if (stopped === "cancelled") return await complete({ outcome: "failed", error_kind: "run", error: "cancelled" });
    if (stopped === "deadline") return await complete({ outcome: "failed", error_kind: "timeout", error: "the run reached its deadline" });
    if (code === INFRA_EXIT) return await complete({ outcome: "failed", error_kind: "infrastructure", error: "the run reported an infrastructure failure (exit 75)" });
    if (code !== 0) return await complete({ outcome: "failed", error_kind: "run", error: `the run exited with ${code}` });
    if (validator) {
      const v = await new Promise<number | null>((resolve) => {
        const p = spawn(process.execPath, [validator!, work, out], { cwd: work, env: { PATH: env.PATH!, HOME: home, LANG: "C.UTF-8", RUN_ID: run.id }, stdio: "ignore" });
        const t = setTimeout(() => p.kill("SIGKILL"), 600_000);
        p.on("error", () => resolve(null)); p.on("close", (c) => { clearTimeout(t); resolve(c); });
      });
      if (v !== 0) return await complete({ outcome: "failed", error_kind: "validation", error: `validation exited with ${v}: the workspace is not written back` });
    }
    let results: unknown[] = [];
    const file = path.join(out, "results.json");
    if (existsSync(file)) {
      try { results = JSON.parse(readFileSync(file, "utf8")); if (!Array.isArray(results)) throw new Error("not a list"); }
      catch (e) { return await complete({ outcome: "failed", error_kind: "run", error: `results.json: ${(e as Error).message}` }); }
    }
    if (spec.workspace) {
      try { await client.stage(run.id, lease, work); }
      catch (e) {
        const status = (e as { status?: number }).status;
        if (status === 409) return null;
        // A workspace the run left unpackable (a symbolic link, a special file, too big) is the run's failure, not the infrastructure's.
        return await complete({ outcome: "failed", error_kind: status === 400 ? "run" : "infrastructure", error: `write back: ${(e as Error).message}` });
      }
    }
    return await complete({ outcome: "succeeded", results });
  } finally {
    clearInterval(beat); clearTimeout(deadline);
    proxy?.stop();
    if (proxy && opts.onProxyLog) { try { opts.onProxyLog(readFileSync(proxy.log, "utf8")); } catch { opts.onProxyLog(""); } }
    rmSync(scratch, { recursive: true, force: true });
  }
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

/** Claim and carry out runs until none is left (a runner process; scripts/run-worker.ts). Returns how many ran. */
export async function drainRuns(client: RunnerClient, opts: HarnessOptions & { kinds?: string[]; max?: number } = {}): Promise<number> {
  let n = 0;
  for (; n < (opts.max ?? Infinity); n++) {
    const c = await client.claim(opts.kinds);
    if (!c) break;
    await runWorkspaceHarness(client, c, opts);
  }
  return n;
}
