/**
 * The acceptance evaluator's run (mold_v0-291; molds/mold_v0/docs/agent-harness.md "Acceptance"): trusted code in a clean
 * sandbox of its own (src/run-harness.ts dispatches a run whose runner is "program-evaluation" here), no model, no
 * credentials, no agent. Part of the run sandbox's code: node's modules and runner files only.
 *
 *   the contract  the frozen test's files, each checked against the sha256 frozen with the program's version (refused
 *                 as tampered otherwise), and the held-out cases: the agent's session never saw them
 *   three users   the candidate, the current best and the scorer each run as a run user of their own, leased for this
 *                 evaluation. Every tree they read is owned by root and only group-readable by the one user it is for, so
 *                 nothing the candidate can write is read by the baseline or the scorer. Each program's HOME and TMPDIR are
 *                 a fresh folder of its own, emptied for every case; its environment is built here, none of it from another
 *   no network    the sandbox's firewall matches its one run user: with three users, each program runs in an empty network
 *                 namespace of its own instead, so none of them reaches anything, loopback included. mold_v0-324: where no
 *                 namespace can be made (a run container: every capability but the runner's dropped, so unshare is refused)
 *                 the sandbox's own firewall shuts the three users out instead (a table of its own dropping every packet
 *                 they send, IPv4 and IPv6, loopback included: nft, else iptables with ip6tables), the same uid match the
 *                 run's lockdown already relies on in every sandbox. Either way a probe as each user must then fail to
 *                 reach a listener of this runner's on loopback before anything runs; where neither can be made, or the
 *                 probe gets through, the evaluation is refused with nothing measured (fails closed). The isolation used
 *                 is the run's `evaluation_isolation` event
 *   limits        each program the test's timeout_seconds, cut to what is left of the run's own deadline (less a minute
 *                 to report): an evaluation past it is refused with nothing scored; at most 4 MB of output a program,
 *                 a candidate or baseline bundle of at most 128 MB, test files of at most 64 MB, and 2000 cases
 *   the scorer    the test's own code, with a HOME of root's that stays empty, no user site and no module path: it reads each
 *                 case's expected answer and the candidate's output, and never runs as this runner
 *   after         the test's files and the current best's are hashed again: a change to either is reported as tampering
 *   the result    measurements only: the rule, the decision and any promotion are the API's (src/nested-runs.ts)
 *   mold_v0-303   the candidate is the target's base with the candidate's files laid over it (the API merges them, so a
 *                 change of one file runs whole), and the baseline is the current best or, with none yet, the target's
 *                 current version. A built-in scorer (src/program-scorers.ts) is run here, as trusted code, in place of a
 *                 scorer program; a built-in candidate (["builtin:file", path]) is that file of the candidate's tree, read
 *                 by this runner, with no code of the candidate's running at all (a policy, a schema)
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunView } from "./pack-api.js";
import type { Claim } from "./runs.js";
import type { HarnessOptions, RunnerClient } from "./run-harness.js";
import { runIsolation } from "./run-harness.js";
import { killUntilGone, leaseRunUser, runUidRange, sweepUserFiles, type RunUser } from "./run-users.js";
import { unpackBundle } from "./workspace-bundle.js";
import type { AcceptanceTest } from "./program-spec.js";
import { builtinScore } from "./program-scorers.js";
import { ENV } from "./env-names.js";

export interface EvaluationStart { evaluation: string; test: AcceptanceTest; metric: string; floors: string[]; has_candidate: boolean; has_champion: boolean }
export interface CaseMeasurement { id: string; baseline: number | null; candidate: number | null; floors: Record<string, number | null> }
export interface EvaluationResult { cases: CaseMeasurement[]; tampered: string | null; error?: string | null }
export interface EvaluationClient {
  start(runId: string, lease: string): Promise<EvaluationStart>;
  bundle(runId: string, lease: string, which: "candidate" | "champion"): Promise<Buffer | null>;
  file(runId: string, lease: string, index: number): Promise<Buffer>;
  result(runId: string, lease: string, r: EvaluationResult): Promise<{ outcome: string }>;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const MAX_OUTPUT = 4 * 1024 * 1024;
/** mold_v0-324: what one evaluation takes in (a bundle as the API sends it, the test's files together, its cases). */
export const EVAL_LIMITS = { bundleBytes: 128 * 1024 * 1024, testBytes: 64 * 1024 * 1024, cases: 2000, reportMarginMs: 60_000 };
const UNSHARE = "/usr/bin/unshare";
const SETPRIV = "/usr/bin/setpriv";
/** A system program by its usual places (a runner's PATH may lack /usr/sbin). */
const sbin = (name: string) => ["/usr/sbin", "/sbin", "/usr/bin", "/bin"].map((d) => path.join(d, name)).find((p) => existsSync(p)) ?? null;
/**
 * Unix sockets on a path (mold_v0-324, review): no network namespace or firewall sees one, so a local resolver, the system
 * bus or the journal would be a way out (a resolver resolves a name it is given: DNS out). These are always looked for;
 * every other socket on a path any user may connect to (its file writable by others) is found in /proc/net/unix.
 */
const KNOWN_SOCKETS = ["/run/systemd/resolve/io.systemd.Resolve", "/run/systemd/resolve/io.systemd.Resolve.Monitor", "/run/dbus/system_bus_socket",
  "/var/run/dbus/system_bus_socket", "/run/nscd/socket", "/var/run/nscd/socket", "/dev/log", "/run/systemd/journal/socket", "/run/systemd/journal/stdout", "/run/systemd/journal/dev-log"];
/** The unix sockets a run user could connect to here: each by its real path, once. */
export function openUnixSockets(): string[] {
  const paths = new Set<string>(KNOWN_SOCKETS);
  try {
    for (const line of readFileSync("/proc/net/unix", "utf8").split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 8 && cols[7]!.startsWith("/")) paths.add(cols.slice(7).join(" "));
    }
  } catch { /* no /proc/net/unix: the known paths only */ }
  const out = new Set<string>();
  for (const p of paths) {
    try {
      const real = realpathSync(p), st = statSync(real);
      if (st.isSocket() && (st.mode & 0o002 || KNOWN_SOCKETS.includes(p))) out.add(real);
    } catch { /* not there */ }
  }
  return [...out].sort();
}
/**
 * One program as one user with no network (mold_v0-324): made as root in new network, mount and IPC namespaces, where
 * every open unix socket is covered by /dev/null and /tmp, /var/tmp and /dev/shm are an empty tmpfs of the program's
 * own, then root drops to the user, its one group, no other, with no_new_privs. A mount that fails ends it (exit 97).
 */
const NETNS_SH = 'while [ "$1" != "--" ]; do mount --bind /dev/null "$1" || exit 97; shift; done; shift; '
  + 'for d in /tmp /var/tmp /dev/shm; do [ -d "$d" ] && { mount -t tmpfs -o mode=1777,size=64m,nosuid,nodev tmpfs "$d" || exit 97; }; done; exec "$@"';
const netlessArgv = (sockets: string[]) => (argv: string[], u: { uid: number; gid: number }) =>
  [UNSHARE, "--net", "--mount", "--ipc", "--propagation", "private", "--", "/bin/sh", "-c", NETNS_SH, "judge", ...sockets, "--", ...firewalledArgv(argv, u)];
/** One program as one user the firewall has shut out (no namespace): root drops to the user, its one group, no other, no_new_privs. */
const firewalledArgv = (argv: string[], u: { uid: number; gid: number }) => [SETPRIV, "--no-new-privs", `--reuid=${u.uid}`, `--regid=${u.gid}`, "--clear-groups", "--", ...argv];

/** How the evaluation's programs are kept off every network (mold_v0-324). */
export type EvaluationNetwork = "netns" | "firewall";
export const canUnshareNet = () => existsSync(UNSHARE) && spawnSync(UNSHARE, ["--net", "--mount", "--ipc", "--propagation", "private", "/bin/sh", "-c", "mount -t tmpfs tmpfs /tmp"], { stdio: "ignore", timeout: 10_000 }).status === 0;
/**
 * The firewall path's unix sockets (mold_v0-324): an ACL entry denying each user each socket. Returns how to take back
 * only the entries added here (an entry already there, the run's own lockdown's, stays); throws when a socket exists and
 * cannot be denied (no setfacl, or it fails): the evaluation is then refused.
 */
export function denySockets(uids: number[], sockets: string[]): () => void {
  if (!sockets.length) return () => {};
  const setfacl = sbin("setfacl"), getfacl = sbin("getfacl");
  if (!setfacl || !getfacl) throw new Error(`setfacl is not installed, so the local sockets ${sockets.slice(0, 3).join(", ")} cannot be denied`);
  const added: [number, string][] = [];
  const undo = () => { for (const [uid, p] of added) spawnSync(setfacl, ["-x", `u:${uid}`, p], { stdio: "ignore", timeout: 10_000 }); };
  for (const p of sockets) {
    const had = spawnSync(getfacl, ["-n", "-p", "--omit-header", p], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
    for (const uid of uids) {
      const before = new RegExp(`^user:${uid}:`, "m").test(had);
      if (spawnSync(setfacl, ["-m", `u:${uid}:---`, p], { stdio: "ignore", timeout: 10_000 }).status !== 0) { undo(); throw new Error(`setfacl could not deny ${p}`); }
      if (!before) added.push([uid, p]);
    }
  }
  return undo;
}
/** The folder evaluations are made in (mold_v0-324): root's, never writable by a run user, nor is any folder above it. */
export const EVAL_ROOT = "/run/app-eval";
export function safeAncestry(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const st = statSync(d);
    if (st.uid !== 0 || st.mode & 0o022) return d;
    if (d === path.dirname(d)) return null;
  }
}
/**
 * mold_v0-324: the sandbox's firewall drops every packet the users send (IPv4 and IPv6, loopback included), in a table of
 * its own that runs before every other output chain: a drop anywhere is final, whatever the run's lockdown accepts for
 * one of them. Returns how to take it away again (the sandbox lives one run; a machine that runs several keeps its own
 * rules). Throws, saying why, where neither nft nor iptables with ip6tables can do it.
 */
export function shutOutUsers(uids: number[], tag: string): () => void {
  const ids = [...new Set(uids)].filter((u) => Number.isSafeInteger(u) && u > 0);
  if (!ids.length || ids.length !== uids.length) throw new Error("the firewall shuts out run users only, never root");
  const nft = sbin("nft"), ipt = sbin("iptables"), ip6 = sbin("ip6tables");
  const why: string[] = [];
  if (nft) {
    const table = `app_eval_${tag.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
    const rules = `table inet ${table} {\n  chain out {\n    type filter hook output priority -300; policy accept;\n    meta skuid { ${ids.join(", ")} } counter drop\n  }\n}\n`;
    const r = spawnSync(nft, ["-f", "-"], { input: rules, encoding: "utf8", timeout: 20_000 });
    if (r.status === 0) return () => { spawnSync(nft, ["delete", "table", "inet", table], { stdio: "ignore", timeout: 20_000 }); };
    why.push(`nft: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 200)}`);
  }
  if (ipt && ip6) {
    const added: [string, number][] = [];
    const undo = () => { for (const [bin, uid] of added.reverse()) spawnSync(bin, ["-D", "OUTPUT", "-m", "owner", "--uid-owner", String(uid), "-j", "DROP"], { stdio: "ignore", timeout: 20_000 }); };
    for (const bin of [ipt, ip6]) for (const uid of ids) {
      const r = spawnSync(bin, ["-I", "OUTPUT", "1", "-m", "owner", "--uid-owner", String(uid), "-j", "DROP"], { encoding: "utf8", timeout: 20_000 });
      if (r.status !== 0) { undo(); why.push(`${path.basename(bin)}: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 200)}`); return fail(); }
      added.push([bin, uid]);
    }
    return undo;
  }
  if (!nft && !ipt) why.push("neither nft nor iptables is installed");
  else if (ipt && !ip6) why.push("iptables without ip6tables would leave IPv6 open");
  return fail();
  function fail(): never { throw new Error(why.join("; ")); }
}
/**
 * mold_v0-324: before anything runs, each user tries a listener of this runner's on loopback (IPv4, and IPv6 where there
 * is one) and every open unix socket: none may get through. Resolves to what got through (nothing, when isolated), or
 * throws when the probe itself could not run.
 */
export async function probeShutOut(users: { uid: number; gid: number }[], wrap: (argv: string[], u: { uid: number; gid: number }) => string[], sockets: string[]): Promise<string[]> {
  const net = await import("node:net");
  let reached = 0;
  const servers: import("node:net").Server[] = [];
  const listen = (host: string) => new Promise<number | null>((resolve) => {
    const s = net.createServer((c) => { reached++; c.destroy(); });
    s.once("error", () => resolve(null));
    s.listen(0, host, () => { servers.push(s); resolve((s.address() as { port: number }).port); });
  });
  const v4 = await listen("127.0.0.1"), v6 = await listen("::1");
  if (v4 === null) throw new Error("the probe's loopback listener could not start");
  const probe = `const net=require("net"),fs=require("fs");const out=[];
const tcp=(h,p)=>new Promise(r=>{if(!p)return r();const s=net.connect(p,h);const t=setTimeout(()=>{s.destroy();r()},1500);s.on("connect",()=>{clearTimeout(t);out.push(h);s.destroy();r()});s.on("error",()=>{clearTimeout(t);r()})});
for(const p of process.argv.slice(1)){try{if(fs.statSync(p).isSocket()){fs.accessSync(p,fs.constants.W_OK);out.push(p)}}catch{}}
Promise.all([tcp("127.0.0.1",${v4}),tcp("::1",${v6 ?? 0})]).then(()=>{process.stdout.write(JSON.stringify(out));process.exit(0)});`;
  try {
    const out = await Promise.all(users.map((u) => runProgram(wrap([process.execPath, "-e", probe, ...sockets], u), { cwd: "/", input: "", timeoutMs: 15_000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" } })));
    const through: string[] = [];
    out.forEach((o, i) => {
      if (!o.ok) throw new Error(`the isolation probe as uid ${users[i]!.uid} did not run: ${o.why}`);
      for (const w of JSON.parse(o.stdout) as string[]) through.push(`uid ${users[i]!.uid}: ${w}`);
    });
    if (reached && !through.length) through.push("a loopback listener was reached");
    return through;
  } finally { for (const s of servers) s.close(); }
}

/** A program run with a time limit: its stdout (bounded), and whether it exited cleanly. */
function runProgram(argv: string[], o: { cwd: string; input: string; timeoutMs: number; env: Record<string, string> }): Promise<{ ok: boolean; stdout: string; why: string | null }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    let out = "", over = false, settled = false;
    const finish = (r: { ok: boolean; stdout: string; why: string | null }) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } finish({ ok: false, stdout: "", why: "it ran past the test's time limit" }); }, o.timeoutMs);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => { if (out.length < MAX_OUTPUT) out += d; else over = true; });
    child.on("error", (e) => finish({ ok: false, stdout: "", why: `it could not start: ${e.message}`.slice(0, 200) }));
    child.on("exit", (code, sig) => { if (over) return finish({ ok: false, stdout: "", why: "it printed too much" }); finish({ ok: code === 0, stdout: out, why: code === 0 ? null : `it exited ${code ?? sig}` }); });
    child.stdin!.on("error", () => {});
    child.stdin!.end(o.input);
  });
}
/** A file's relative paths and hashes under a directory (a tree the candidate must not be able to change). */
function treeHashes(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, treeHashes(dir, r));
    else if (e.isFile()) out[r] = sha256(readFileSync(path.join(dir, r)));
    else out[r] = "not a regular file";
  }
  return out;
}

export interface EvalCase { id: string; input: unknown; expected?: unknown }
export function parseCases(body: Buffer): EvalCase[] {
  const j = JSON.parse(body.toString("utf8")) as { cases?: unknown } | unknown[];
  const list = Array.isArray(j) ? j : (j as { cases?: unknown }).cases;
  if (!Array.isArray(list) || !list.length) throw new Error("the test's cases file lists no cases");
  return list.map((c, i) => { const x = c as { id?: unknown; input?: unknown; expected?: unknown }; return { id: typeof x.id === "string" ? x.id : String(i), input: x.input, expected: x.expected }; });
}

/** Read-only to one user: owned by root, group that user's, nothing for anyone else. What is not a plain file or folder goes. */
function protectTree(dir: string, gid: number) {
  chownSync(dir, 0, gid);
  chmodSync(dir, 0o750);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) protectTree(p, gid);
    else if (e.isFile()) { const x = statSync(p).mode & 0o100; chownSync(p, 0, gid); chmodSync(p, x ? 0o750 : 0o640); }
    else rmSync(p, { force: true });
  }
}

/** Carry out one evaluation. Never throws for the evaluation's own failures: it reports them, and the API refuses (fails closed). */
export async function runProgramEvaluation(client: RunnerClient, claim: Claim, opts: HarnessOptions): Promise<RunView | null> {
  const ev = client.evaluation;
  const run = claim.run, lease = claim.lease_token;
  if (!ev) return client.complete(run.id, lease, { outcome: "failed", error_kind: "infrastructure", error: "this runner cannot carry out evaluations" }).catch(() => null);
  const iso = runIsolation(opts);
  const owned: RunUser[] = [];
  let candidateUser: RunUser | null = null, championUser: RunUser | null = null, scorerUser: RunUser | null = null;
  let undoFirewall: (() => void) | null = null, undoSockets: (() => void) | null = null;
  // mold_v0-324: the run's own deadline bounds the whole evaluation (less a margin to report what it measured).
  const deadline = (Number.isFinite(Date.parse(claim.deadline_at)) ? Date.parse(claim.deadline_at) : Date.now() + 3600_000) - EVAL_LIMITS.reportMarginMs;
  // mold_v0-324: with run users, the folder is made under one only root may write, as is every folder above it: nothing a
  // program leaves (a node_modules, a package.json) is ever on another program's module path.
  let base = opts.tmp ?? tmpdir();
  if (iso) { base = opts.tmp ?? EVAL_ROOT; mkdirSync(base, { recursive: true, mode: 0o711 }); if (base === EVAL_ROOT) { chownSync(base, 0, 0); chmodSync(base, 0o711); } }
  const unsafe = iso ? safeAncestry(base) : null;
  const scratch = mkdtempSync(path.join(base, "evaluation-"));
  // The lease is this runner's to keep while a slow test runs; a cancel is seen between cases.
  let cancelled = false;
  const beat = setInterval(() => { client.heartbeat(run.id, lease).then((h) => { if (h.cancel) cancelled = true; }).catch(() => {}); }, Math.max(1000, (claim.lease_seconds * 1000) / 3));
  beat.unref();
  const finish = async (r: EvaluationResult, failed: string | null) => {
    await ev.result(run.id, lease, r).catch((e) => console.error(`evaluation ${run.id}: its result: ${(e as Error).message}`));
    return client.complete(run.id, lease, failed ? { outcome: "failed", error_kind: "run", error: failed.slice(0, 2000) } : { outcome: "succeeded", results: [] }).catch(() => null);
  };
  try {
    if (unsafe) return finish({ cases: [], tampered: null, error: `the evaluation's folder is under ${unsafe}, which a run user could write to, so nothing was run or measured` }, null);
    if (iso) {
      const range = iso.mode === "pool" ? iso.range : (opts.runUsers ?? runUidRange());
      const lease3 = async (role: string) => { const u = await leaseRunUser(`${run.id}:${role}`, { range, dir: opts.runUidDir }); owned.push(u); return u; };
      if (iso.mode === "given") candidateUser = iso.user;
      else if (iso.mode === "fixed") { candidateUser = await leaseRunUser(run.id, { fixed: { uid: iso.uid, gid: iso.gid }, dir: opts.runUidDir }); owned.push(candidateUser); }
      else candidateUser = await lease3("candidate");
      championUser = await lease3("champion");
      scorerUser = await lease3("scorer");
    }
    const isolated = !!(candidateUser && championUser && scorerUser);
    // mold_v0-324: a runner with no run users runs the programs as itself: only offline tests may ask for that.
    if (!isolated && ENV.APP_TEST_UNISOLATED_EVALUATIONS !== "yes") return finish({ cases: [], tampered: null, error: "this runner has no run users of its own to run the evaluation's programs as, so nothing was run or measured" }, null);
    // mold_v0-324: an empty network namespace each where one can be made, else the sandbox's firewall shuts the three out;
    // the unix sockets any user could connect to covered (a namespace) or denied (ACLs) on either path.
    let network: EvaluationNetwork | null = null;
    let wrap: ((argv: string[], u: { uid: number; gid: number }) => string[]) | null = null;
    if (isolated) {
      const users = [candidateUser!, championUser!, scorerUser!];
      const sockets = openUnixSockets();
      if (opts.evaluationNetwork !== "firewall" && canUnshareNet()) { network = "netns"; wrap = netlessArgv(sockets); }
      else {
        const why: string[] = [];
        if (opts.evaluationNetwork !== "firewall") why.push("no network namespace can be made here");
        if (!existsSync(SETPRIV)) why.push("setpriv is not installed");
        else {
          try { undoFirewall = shutOutUsers(users.map((u) => u.uid), run.id); }
          catch (e) { why.push(`its firewall could not shut the evaluation's users out (${(e as Error).message})`); }
          if (undoFirewall) {
            try { undoSockets = denySockets(users.map((u) => u.uid), sockets); network = "firewall"; wrap = firewalledArgv; }
            catch (e) { why.push((e as Error).message); }
          }
        }
        if (!network) return finish({ cases: [], tampered: null, error: `this sandbox cannot keep the evaluation's programs off the network (${why.join("; ")}), so nothing was run or measured` }, null);
      }
      const through = await probeShutOut(users, wrap!, sockets).catch((e: Error) => [`(${e.message.slice(0, 200)})`]);
      for (const u of users) killUntilGone(u);
      if (through.length) return finish({ cases: [], tampered: null, error: `the evaluation's programs were not cut off from the network (${network}: a probe got through, ${through.slice(0, 3).join("; ")}), so nothing was run or measured` }, null);
      await client.events(run.id, lease, [{ type: "evaluation_isolation", data: { network, users: users.length, sockets_denied: sockets.length } }]).catch(() => {});
    }
    // Each user may pass through to its own folders (0711: never list); what is not its own it cannot open.
    if (isolated) chmodSync(scratch, 0o711);
    const start = await ev.start(run.id, lease);
    const testDir = path.join(scratch, "test");
    mkdirSync(testDir, { recursive: true, mode: 0o700 });
    let testBytes = 0;
    for (let i = 0; i < start.test.files.length; i++) {
      const f = start.test.files[i]!;
      const body = await ev.file(run.id, lease, i).catch((e: Error) => { throw Object.assign(new Error(`the test file ${f.path} could not be read as frozen: ${e.message}`), { tamper: true }); });
      testBytes += body.length;
      if (testBytes > EVAL_LIMITS.testBytes) return finish({ cases: [], tampered: null, error: `the test's files are larger than ${EVAL_LIMITS.testBytes / 1024 / 1024} MB, so nothing was measured` }, null);
      if (sha256(body) !== f.sha256) return finish({ cases: [], tampered: `the test file ${f.path} does not match the sha256 frozen with this program's version` }, null);
      const dest = path.join(testDir, f.path);
      if (!dest.startsWith(testDir + path.sep)) return finish({ cases: [], tampered: `the test file ${f.path} would leave the test's folder` }, null);
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, body, { mode: f.executable ? 0o700 : 0o600 });
    }
    const cases = parseCases(readFileSync(path.join(testDir, start.test.cases_path)));
    if (cases.length > EVAL_LIMITS.cases) return finish({ cases: [], tampered: null, error: `the test lists ${cases.length} cases, more than the ${EVAL_LIMITS.cases} an evaluation takes, so nothing was measured` }, null);
    if (scorerUser) protectTree(testDir, scorerUser.gid);
    const before = treeHashes(testDir);
    const unpack = async (which: "candidate" | "champion", user: RunUser | null) => {
      const body = await ev.bundle(run.id, lease, which);
      if (!body) return null;
      if (body.length > EVAL_LIMITS.bundleBytes) throw new Error(`the ${which === "candidate" ? "candidate's" : "baseline's"} files are larger than ${EVAL_LIMITS.bundleBytes / 1024 / 1024} MB`);
      const dir = path.join(scratch, which);
      mkdirSync(dir, { recursive: true, mode: 0o750 });
      unpackBundle(body, dir);
      if (user) protectTree(dir, user.gid);
      return dir;
    };
    const candidateDir = await unpack("candidate", candidateUser);
    if (!candidateDir) return finish({ cases: [], tampered: null, error: "the candidate's bundle could not be read" }, null);
    const championDir = start.has_champion ? await unpack("champion", championUser) : null;
    const championBefore = championDir ? treeHashes(championDir) : null;
    // No program's environment comes from another: each is built here, with no user site and no module path.
    const clean = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", NODE_PATH: "" };
    /** A folder of its own for one program of one case: emptied first, only that user's. */
    const freshWork = (name: string, user: RunUser | null) => {
      const dir = path.join(scratch, `work-${name}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { mode: 0o700 });
      if (user) chownSync(dir, user.uid, user.gid);
      return dir;
    };
    // The scorer's HOME is root's and stays empty: nothing the candidate writes can be loaded from it.
    const scorerHome = path.join(scratch, "scorer-home");
    mkdirSync(scorerHome, { mode: 0o755 });
    const testTimeoutMs = start.test.timeout_seconds * 1000;
    /** Each program gets the test's time limit, cut to what is left of the run's (mold_v0-324); none left: refused. */
    const timeoutMs = () => Math.min(testTimeoutMs, deadline - Date.now());
    const results: CaseMeasurement[] = [];
    const command = (argv: string[], u: RunUser | null) => (u ? wrap!(argv, u) : argv);
    /** After every program (mold_v0-324): every process of its user gone (else refused) and what it left in the shared folders and IPC. */
    const clearUser = (u: RunUser | null) => {
      if (!u) return;
      if (!killUntilGone(u)) throw Object.assign(new Error(`a program's processes (uid ${u.uid}) would not end, so nothing was scored`), { refuse: true });
      sweepUserFiles(u.uid);
    };
    const outOfTime = () => finish({ cases: [], tampered: null, error: `the evaluation ran past its run's time limit after ${results.length} of ${cases.length} cases, so nothing was scored` }, null);
    const builtinFile = start.test.candidate_command[0] === "builtin:file" ? start.test.candidate_command[1]! : null;
    const runOne = async (dir: string, user: RunUser | null, name: string, c: EvalCase): Promise<{ output: string | null; why: string | null }> => {
      // mold_v0-303: a built-in candidate is a file of its tree (protectTree left only plain files and folders), read here.
      if (builtinFile) {
        const f = path.resolve(dir, builtinFile);
        if (!f.startsWith(dir + path.sep) || !existsSync(f) || !statSync(f).isFile() || statSync(f).size > MAX_OUTPUT) return { output: null, why: `it has no file ${builtinFile}` };
        return { output: readFileSync(f, "utf8"), why: null };
      }
      // It gets the input only: never the expected answer, the test's folder, the other's, or the runner's own user.
      const work = freshWork(name, user);
      const r = await runProgram(command(start.test.candidate_command, user), { cwd: dir, input: JSON.stringify({ id: c.id, input: c.input }), timeoutMs: Math.max(1, timeoutMs()), env: { ...clean, HOME: work, TMPDIR: work, EVAL: "1" } });
      clearUser(user);
      return r.ok ? { output: r.stdout, why: null } : { output: null, why: r.why };
    };
    const builtinScorer = start.test.scorer_command[0]?.startsWith("builtin:") ? start.test.scorer_command[0] : null;
    const score = async (c: EvalCase, output: string | null): Promise<Record<string, number>> => {
      if (output === null) return {};
      if (builtinScorer) return builtinScore(builtinScorer, c, output);
      const work = freshWork("scorer", scorerUser);
      const s = await runProgram(command(start.test.scorer_command, scorerUser), { cwd: testDir, input: JSON.stringify({ id: c.id, input: c.input, expected: c.expected, output }), timeoutMs: Math.max(1, timeoutMs()), env: { ...clean, HOME: scorerHome, TMPDIR: work } });
      clearUser(scorerUser);
      if (!s.ok) return {};
      try { const v = JSON.parse(s.stdout) as Record<string, unknown>; return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]))); }
      catch { return {}; }
    };
    const changedBetween = (was: Record<string, string>, now: Record<string, string>) => [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((p) => was[p] !== now[p]);
    for (const c of cases) {
      if (cancelled) return finish({ cases: [], tampered: null, error: "the evaluation was cancelled" }, null);
      if (timeoutMs() < 1000) return outOfTime();
      const cand = await runOne(candidateDir, candidateUser, "candidate", c);
      if (championDir) {
        const moved = changedBetween(championBefore!, treeHashes(championDir));
        if (moved.length) return finish({ cases: [], tampered: `the current best's files changed while it ran: ${moved.slice(0, 5).join(", ")}` }, null);
      }
      const base = championDir ? await runOne(championDir, championUser, "champion", c) : { output: null, why: null };
      const cScore = await score(c, cand.output), bScore = championDir ? await score(c, base.output) : {};
      // A program cut short by the run's own deadline (not the test's limit) measured nothing: refused, never scored 0.
      if (timeoutMs() < 1) return outOfTime();
      results.push({ id: c.id, candidate: cScore[start.metric] ?? null, baseline: championDir ? bScore[start.metric] ?? null : null, floors: Object.fromEntries(start.floors.map((f) => [f, cScore[f] ?? null])) });
      const changed = changedBetween(before, treeHashes(testDir));
      if (changed.length) return finish({ cases: [], tampered: `the test's files changed while it ran: ${changed.slice(0, 5).join(", ")}` }, null);
    }
    return finish({ cases: results, tampered: null }, null);
  } catch (e) {
    if ((e as { tamper?: boolean }).tamper) return finish({ cases: [], tampered: (e as Error).message.slice(0, 300) }, null);
    if ((e as { refuse?: boolean }).refuse) return finish({ cases: [], tampered: null, error: (e as Error).message.slice(0, 500) }, null);
    return finish({ cases: [], tampered: null, error: `the evaluation failed: ${(e as Error).message}`.slice(0, 500) }, (e as Error).message);
  } finally {
    clearInterval(beat);
    // Every process of the three gone first (mold_v0-324): only then are the sockets and the network given back.
    for (const u of [candidateUser, championUser, scorerUser]) if (u) { killUntilGone(u); sweepUserFiles(u.uid); }
    try { undoSockets?.(); } catch { /* the sandbox goes with its entries */ }
    try { undoFirewall?.(); } catch { /* the sandbox goes with its rules */ }
    for (const u of owned) await u.release().catch(() => false);
    rmSync(scratch, { recursive: true, force: true });
  }
}

