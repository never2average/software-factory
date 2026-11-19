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
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunView } from "./pack-api.js";
import type { Claim } from "./runs.js";
import type { HarnessOptions, RunnerClient } from "./run-harness.js";
import { runIsolation } from "./run-harness.js";
import { killUser, leaseRunUser, runUidRange, type RunUser } from "./run-users.js";
import { unpackBundle } from "./workspace-bundle.js";
import type { AcceptanceTest } from "./program-spec.js";
import { builtinScore } from "./program-scorers.js";

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
/** The sockets a run's user is denied in a sandbox (src/run-sandbox-runner.ts): a network namespace does not cover a unix socket. */
const LOCAL_RESOLVER_SOCKETS = ["/run/systemd/resolve/io.systemd.Resolve", "/run/systemd/resolve/io.systemd.Resolve.Monitor", "/run/dbus/system_bus_socket"];
/** One program as one user with no network: made as root, which drops to the user (and its one group) before it runs. */
const netlessArgv = (argv: string[], u: { uid: number; gid: number }, noNewPrivs: boolean) => [...(noNewPrivs ? ["setpriv", "--no-new-privs", "--"] : []), UNSHARE, "--net", `--setgid=${u.gid}`, `--setuid=${u.uid}`, "--", ...argv];
/** mold_v0-324: one program as one user the firewall has shut out (no namespace): root drops to the user, its one group, no other. */
const firewalledArgv = (argv: string[], u: { uid: number; gid: number }, noNewPrivs: boolean) => [SETPRIV, ...(noNewPrivs ? ["--no-new-privs"] : []), `--reuid=${u.uid}`, `--regid=${u.gid}`, "--clear-groups", "--", ...argv];

/** How the evaluation's programs are kept off every network (mold_v0-324). */
export type EvaluationNetwork = "netns" | "firewall";
export const canUnshareNet = () => existsSync(UNSHARE) && spawnSync(UNSHARE, ["--net", "/bin/true"], { stdio: "ignore", timeout: 10_000 }).status === 0;
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
 * mold_v0-324: before anything runs, each user tries a listener of this runner's on loopback (and IPv6 loopback where
 * there is one): it must not get through. Resolves to the users that did (none, when isolated), or throws when the
 * probe itself could not run.
 */
export async function probeShutOut(users: { uid: number; gid: number }[], wrap: (argv: string[], u: { uid: number; gid: number }) => string[]): Promise<number[]> {
  const net = await import("node:net");
  let reached = 0;
  const server = net.createServer((s) => { reached++; s.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const port = (server.address() as { port: number }).port;
  const probe = `const net=require("net");const s=net.connect(${port},"127.0.0.1");const t=setTimeout(()=>{process.stdout.write("blocked");process.exit(0)},1500);s.on("connect",()=>{process.stdout.write("open");process.exit(0)});s.on("error",()=>{clearTimeout(t);process.stdout.write("blocked");process.exit(0)});`;
  try {
    const out = await Promise.all(users.map((u) => runProgram(wrap([process.execPath, "-e", probe], u), { cwd: "/", input: "", timeoutMs: 15_000, env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" } })));
    out.forEach((o, i) => { if (!o.ok && !o.stdout) throw new Error(`the network probe as uid ${users[i]!.uid} did not run: ${o.why}`); });
    return users.filter((_, i) => out[i]!.stdout !== "blocked" || reached > 0).map((u) => u.uid);
  } finally { server.close(); }
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
  let undoFirewall: (() => void) | null = null;
  const deniedSockets: string[] = [];
  // mold_v0-324: the run's own deadline bounds the whole evaluation (less a margin to report what it measured).
  const deadline = (Number.isFinite(Date.parse(claim.deadline_at)) ? Date.parse(claim.deadline_at) : Date.now() + 3600_000) - EVAL_LIMITS.reportMarginMs;
  const scratch = mkdtempSync(path.join(opts.tmp ?? tmpdir(), "evaluation-"));
  // The lease is this runner's to keep while a slow test runs; a cancel is seen between cases.
  let cancelled = false;
  const beat = setInterval(() => { client.heartbeat(run.id, lease).then((h) => { if (h.cancel) cancelled = true; }).catch(() => {}); }, Math.max(1000, (claim.lease_seconds * 1000) / 3));
  beat.unref();
  const finish = async (r: EvaluationResult, failed: string | null) => {
    await ev.result(run.id, lease, r).catch((e) => console.error(`evaluation ${run.id}: its result: ${(e as Error).message}`));
    return client.complete(run.id, lease, failed ? { outcome: "failed", error_kind: "run", error: failed.slice(0, 2000) } : { outcome: "succeeded", results: [] }).catch(() => null);
  };
  try {
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
    // mold_v0-324: an empty network namespace each where one can be made, else the sandbox's firewall shuts the three out.
    let network: EvaluationNetwork | null = null;
    if (isolated) {
      const users = [candidateUser!, championUser!, scorerUser!];
      if (opts.evaluationNetwork !== "firewall" && canUnshareNet()) network = "netns";
      else {
        const why: string[] = [];
        if (opts.evaluationNetwork !== "firewall") why.push("no network namespace can be made here");
        if (!existsSync(SETPRIV)) why.push("setpriv is not installed");
        else try { undoFirewall = shutOutUsers(users.map((u) => u.uid), run.id); network = "firewall"; }
        catch (e) { why.push(`its firewall could not shut the evaluation's users out (${(e as Error).message})`); }
        if (!network) return finish({ cases: [], tampered: null, error: `this sandbox cannot keep the evaluation's programs off the network (${why.join("; ")}), so nothing was run or measured` }, null);
      }
      const wrap = network === "netns" ? netlessArgv : firewalledArgv;
      const through = await probeShutOut(users, (argv, u) => wrap(argv, u, !!opts.noNewPrivs)).catch((e: Error) => [`(${e.message.slice(0, 200)})`]);
      for (const u of users) killUser({ uid: u.uid, gid: u.gid });
      if (through.length) return finish({ cases: [], tampered: null, error: `the evaluation's programs were not cut off from the network (${network}: a probe got through as ${through.join(", ")}), so nothing was run or measured` }, null);
      await client.events(run.id, lease, [{ type: "evaluation_isolation", data: { network, users: users.length } }]).catch(() => {});
    }
    // The local resolver's and the system bus's unix sockets (no namespace or firewall sees one): denied to all three in a
    // run sandbox (the run's own user already is, by its lockdown).
    if (isolated && opts.egress === "system") for (const u of [candidateUser!, championUser!, scorerUser!]) for (const s of LOCAL_RESOLVER_SOCKETS)
      if (existsSync(s) && spawnSync("setfacl", ["-m", `u:${u.uid}:---`, s], { stdio: "ignore", timeout: 10_000 }).status === 0) deniedSockets.push(`${u.uid}:${s}`);
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
    const command = (argv: string[], u: RunUser | null) => (u ? (network === "firewall" ? firewalledArgv : netlessArgv)(argv, u, !!opts.noNewPrivs) : argv);
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
      if (user) killUser({ uid: user.uid, gid: user.gid });
      return r.ok ? { output: r.stdout, why: null } : { output: null, why: r.why };
    };
    const builtinScorer = start.test.scorer_command[0]?.startsWith("builtin:") ? start.test.scorer_command[0] : null;
    const score = async (c: EvalCase, output: string | null): Promise<Record<string, number>> => {
      if (output === null) return {};
      if (builtinScorer) return builtinScore(builtinScorer, c, output);
      const work = freshWork("scorer", scorerUser);
      const s = await runProgram(command(start.test.scorer_command, scorerUser), { cwd: testDir, input: JSON.stringify({ id: c.id, input: c.input, expected: c.expected, output }), timeoutMs: Math.max(1, timeoutMs()), env: { ...clean, HOME: scorerHome, TMPDIR: work } });
      if (scorerUser) killUser({ uid: scorerUser.uid, gid: scorerUser.gid });
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
    return finish({ cases: [], tampered: null, error: `the evaluation failed: ${(e as Error).message}`.slice(0, 500) }, (e as Error).message);
  } finally {
    clearInterval(beat);
    for (const d of deniedSockets) { const i = d.indexOf(":"); spawnSync("setfacl", ["-x", `u:${d.slice(0, i)}`, d.slice(i + 1)], { stdio: "ignore", timeout: 10_000 }); }
    try { undoFirewall?.(); } catch { /* the sandbox goes with its rules */ }
    for (const u of owned) await u.release().catch(() => false);
    rmSync(scratch, { recursive: true, force: true });
  }
}

