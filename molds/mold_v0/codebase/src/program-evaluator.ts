/**
 * The acceptance evaluator's run (mold_v0-291; molds/mold_v0/docs/agent-harness.md "Acceptance"): trusted code in a clean
 * sandbox of its own (src/run-harness.ts dispatches a run whose runner is "program-evaluation" here), no model, no
 * credentials, no agent. Part of the run sandbox's code: node's modules and runner files only.
 *
 *   the contract  the frozen test's files, each checked against the sha256 frozen with the program's version (refused
 *                 as tampered otherwise), and the held-out cases: the agent's session never saw them
 *   the candidate is run per case as a run user of its own; what it prints goes to the scorer, which it cannot touch
 *   the scorer    the test's own code, as this runner, reads each case's expected answer and the candidate's output
 *   after         the test's files are hashed again: a candidate that changed them is reported as tampering
 *   the result    measurements only: the rule, the decision and any promotion are the API's (src/nested-runs.ts)
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunView } from "./pack-api.js";
import type { Claim } from "./runs.js";
import type { HarnessOptions, RunnerClient } from "./run-harness.js";
import { runIsolation } from "./run-harness.js";
import { killUser, leaseRunUser, type RunUser } from "./run-users.js";
import { unpackBundle } from "./workspace-bundle.js";
import type { AcceptanceTest } from "./program-spec.js";

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

/** A program run with a time limit: its stdout (bounded), and whether it exited cleanly. */
function runProgram(argv: string[], o: { cwd: string; input: string; timeoutMs: number; uid?: number; gid?: number; env: Record<string, string> }): Promise<{ ok: boolean; stdout: string; why: string | null }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd!, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], detached: true, ...(o.uid !== undefined ? { uid: o.uid, gid: o.gid } : {}) });
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

/** Carry out one evaluation. Never throws for the evaluation's own failures: it reports them, and the API refuses (fails closed). */
export async function runProgramEvaluation(client: RunnerClient, claim: Claim, opts: HarnessOptions): Promise<RunView | null> {
  const ev = client.evaluation;
  const run = claim.run, lease = claim.lease_token;
  if (!ev) return client.complete(run.id, lease, { outcome: "failed", error_kind: "infrastructure", error: "this runner cannot carry out evaluations" }).catch(() => null);
  const iso = runIsolation(opts);
  let user: RunUser | null = null;
  const scratch = mkdtempSync(path.join(opts.tmp ?? tmpdir(), "evaluation-"));
  const finish = async (r: EvaluationResult, failed: string | null) => {
    await ev.result(run.id, lease, r).catch((e) => console.error(`evaluation ${run.id}: its result: ${(e as Error).message}`));
    return client.complete(run.id, lease, failed ? { outcome: "failed", error_kind: "run", error: failed.slice(0, 2000) } : { outcome: "succeeded", results: [] }).catch(() => null);
  };
  try {
    if (iso) user = iso.mode === "given" ? iso.user : await leaseRunUser(run.id, { ...(iso.mode === "fixed" ? { fixed: { uid: iso.uid, gid: iso.gid } } : { range: iso.range }), dir: opts.runUidDir });
    const as = user ? { uid: user.uid, gid: user.gid } : null;
    // The run's user may pass through to its own folder (0711: never list); the test's folder stays this runner's alone (0700).
    if (as) chmodSync(scratch, 0o711);
    const start = await ev.start(run.id, lease);
    const testDir = path.join(scratch, "test");
    mkdirSync(testDir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < start.test.files.length; i++) {
      const f = start.test.files[i]!;
      const body = await ev.file(run.id, lease, i).catch((e: Error) => { throw Object.assign(new Error(`the test file ${f.path} could not be read as frozen: ${e.message}`), { tamper: true }); });
      if (sha256(body) !== f.sha256) return finish({ cases: [], tampered: `the test file ${f.path} does not match the sha256 frozen with this program's version` }, null);
      const dest = path.join(testDir, f.path);
      if (!dest.startsWith(testDir + path.sep)) return finish({ cases: [], tampered: `the test file ${f.path} would leave the test's folder` }, null);
      mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, body, { mode: f.executable ? 0o700 : 0o600 });
    }
    const before = treeHashes(testDir);
    const cases = parseCases(readFileSync(path.join(testDir, start.test.cases_path)));
    const unpack = async (which: "candidate" | "champion") => {
      const body = await ev.bundle(run.id, lease, which);
      if (!body) return null;
      const dir = path.join(scratch, which);
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      unpackBundle(body, dir);
      if (as) chownTree(dir, as.uid, as.gid);
      return dir;
    };
    const candidateDir = await unpack("candidate");
    if (!candidateDir) return finish({ cases: [], tampered: null, error: "the candidate's bundle could not be read" }, null);
    const championDir = start.has_champion ? await unpack("champion") : null;
    const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: candidateDir, LANG: "C.UTF-8", EVAL: "1" };
    const timeoutMs = start.test.timeout_seconds * 1000;
    const results: CaseMeasurement[] = [];
    const runOne = async (dir: string, c: EvalCase): Promise<{ output: string | null; why: string | null }> => {
      // The candidate gets the input only: never the expected answer, the test's folder, or the runner's own user.
      const r = await runProgram(start.test.candidate_command, { cwd: dir, input: JSON.stringify({ id: c.id, input: c.input }), timeoutMs, env, ...(as ?? {}) });
      if (as) killUser(as);
      return r.ok ? { output: r.stdout, why: null } : { output: null, why: r.why };
    };
    const score = async (c: EvalCase, output: string | null): Promise<Record<string, number>> => {
      if (output === null) return {};
      const s = await runProgram(start.test.scorer_command, { cwd: testDir, input: JSON.stringify({ id: c.id, input: c.input, expected: c.expected, output }), timeoutMs, env });
      if (!s.ok) return {};
      try { const v = JSON.parse(s.stdout) as Record<string, unknown>; return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]))); }
      catch { return {}; }
    };
    for (const c of cases) {
      const cand = await runOne(candidateDir, c);
      const base = championDir ? await runOne(championDir, c) : { output: null, why: null };
      const cScore = await score(c, cand.output), bScore = championDir ? await score(c, base.output) : {};
      results.push({ id: c.id, candidate: cScore[start.metric] ?? null, baseline: championDir ? bScore[start.metric] ?? null : null, floors: Object.fromEntries(start.floors.map((f) => [f, cScore[f] ?? null])) });
      const after = treeHashes(testDir);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]);
      if (changed.length) return finish({ cases: [], tampered: `the test's files changed while it ran: ${changed.slice(0, 5).join(", ")}` }, null);
    }
    return finish({ cases: results, tampered: null }, null);
  } catch (e) {
    if ((e as { tamper?: boolean }).tamper) return finish({ cases: [], tampered: (e as Error).message.slice(0, 300) }, null);
    return finish({ cases: [], tampered: null, error: `the evaluation failed: ${(e as Error).message}`.slice(0, 500) }, (e as Error).message);
  } finally {
    if (user) { if (iso?.mode !== "given") await user.release().catch(() => false); }
    rmSync(scratch, { recursive: true, force: true });
  }
}
function chownTree(dir: string, uid: number, gid: number) {
  chownSync(dir, uid, gid);
  for (const e of readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) chownTree(p, uid, gid); else if (e.isFile()) chownSync(p, uid, gid); }
}

