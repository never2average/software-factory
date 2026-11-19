// The evaluator's run as a run sandbox's runner carries it out (mold_v0-324), with a stand-in for the API: the run
// claimed for "program-evaluation" goes through src/run-harness.ts runWorkspaceHarness, exactly as in a sandbox, and
// the API's evaluation calls (start, the candidate's and the baseline's bundles, the frozen test's files, the result)
// are answered from a folder instead of over HTTP. Run as root, on this machine or inside a run container:
//   node --import tsx scripts/fixtures/judge/drive.ts <spec.json>
// spec: {test_dir, cases_path, candidate_command, scorer_command, timeout_seconds, candidate_dir, champion_dir?, metric,
//        floors, deadline_seconds?, network?: "auto"|"firewall", egress?: "system"|"off", uids: {first, last}, uid_dir,
//        control?: {host, port}, plant_socket?, out?}
// plant_socket: a unix socket this runner (root) listens on, connectable by anyone (as a local resolver's is): the
// evaluation's users must not reach it.
// It writes {control, result, events, completion} to spec.out (else stdout). `control`: whether this runner (root) reaches
// the outside listener itself, so a "blocked" seen by the evaluation's users means the rules, not a dead address.
// Imports only runner code (what a run sandbox gets) and node's own modules.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { runWorkspaceHarness, type RunnerClient } from "../../../src/run-harness.js";
import { packBundle } from "../../../src/workspace-bundle.js";
import type { EvaluationResult } from "../../../src/program-evaluator.js";

const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const filesOf = (dir: string, rel = ""): string[] => readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? filesOf(dir, path.join(rel, e.name)) : [path.join(rel, e.name)])).sort();
const testFiles = filesOf(spec.test_dir).map((p) => { const body = readFileSync(path.join(spec.test_dir, p)); return { path: p, body, sha256: sha(body), executable: !!(statSync(path.join(spec.test_dir, p)).mode & 0o100) }; });

const control = spec.control ? await new Promise<string>((res) => {
  const s = net.connect({ host: spec.control.host, port: spec.control.port });
  const t = setTimeout(() => { s.destroy(); res("unreachable"); }, 3000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); res("reached"); });
  s.on("error", () => { clearTimeout(t); res("unreachable"); });
}) : "untested";

let planted: net.Server | null = null;
if (spec.plant_socket) {
  rmSync(spec.plant_socket, { force: true });
  planted = await new Promise<net.Server>((res, rej) => { const s = net.createServer((c) => { c.end("planted\n"); }); s.once("error", rej); s.listen(spec.plant_socket, () => res(s)); });
  chmodSync(spec.plant_socket, 0o666);
}
const events: { type: string; data?: Record<string, unknown> }[] = [];
let result: EvaluationResult | null = null, completion: unknown = null;
const runId = `run_judge${randomBytes(4).toString("hex")}`, lease = `orl_${randomBytes(8).toString("hex")}`;
const nope = async () => { throw new Error("not an evaluation's call"); };
const client = {
  claim: nope, checkout: nope, stage: nope, credentials: nope,
  heartbeat: async () => ({ cancel: false, reason: null }),
  events: async (_id: string, _l: string, e: typeof events) => { events.push(...e); },
  complete: async (_id: string, _l: string, c: unknown) => { completion = c; return {} as never; },
  evaluation: {
    start: async () => ({ evaluation: "ev_judge", metric: spec.metric, floors: spec.floors, has_candidate: true, has_champion: !!spec.champion_dir,
      test: { files: testFiles.map(({ body: _b, ...f }) => ({ ...f, id: f.path, bytes: _b.length })), sha256: "", cases_path: spec.cases_path, candidate_command: spec.candidate_command, scorer_command: spec.scorer_command, timeout_seconds: spec.timeout_seconds } }),
    bundle: async (_id: string, _l: string, which: "candidate" | "champion") => (which === "candidate" ? packBundle(spec.candidate_dir).bundle : spec.champion_dir ? packBundle(spec.champion_dir).bundle : null),
    file: async (_id: string, _l: string, n: number) => testFiles[n]!.body,
    result: async (_id: string, _l: string, r: EvaluationResult) => { result = r; return { outcome: "measured" }; },
  },
} as unknown as RunnerClient;
const claim = {
  run: { id: runId, org_id: 1, attempt: 1, spec: { runner: "program-evaluation" } },
  lease_token: lease, lease_seconds: 60, lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  deadline_at: new Date(Date.now() + (spec.deadline_seconds ?? 3600) * 1000).toISOString(),
  gateway: { expires_at: "", env: {}, providers: {}, gateway_url: "", token: null }, egress: { hosts: [] },
} as never;
const t0 = Date.now();
await runWorkspaceHarness(client, claim, { runUsers: spec.uids, runUidDir: spec.uid_dir, egress: spec.egress ?? "off", noNewPrivs: true, evaluationNetwork: spec.network ?? "auto" });
planted?.close();
if (spec.plant_socket) rmSync(spec.plant_socket, { force: true });
const out = JSON.stringify({ control, result, events, completion, ms: Date.now() - t0 });
if (spec.out) writeFileSync(spec.out, out); else process.stdout.write(out);
process.exit(0);
