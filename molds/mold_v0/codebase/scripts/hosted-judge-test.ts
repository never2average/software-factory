// The acceptance evaluator (the guardian's judge, src/program-evaluator.ts) carried out the way a run sandbox's runner
// carries it out (mold_v0-324), against a hostile candidate, for real: no stand-in for the firewall, the users or the
// time limits. Only the API is a stand-in (scripts/fixtures/judge/drive.ts answers its evaluation calls from a folder).
//   npm run test:hosted-judge        (needs root; the run container items need Docker and JUDGE_RUN_IMAGE, else SKIPPED)
//
// Each run: 5 cases the candidate answers right and the baseline wrong, and 1 case where both hang. On every case the
// candidate (scripts/fixtures/judge/candidate/run.cjs) tries the outside (a listener this runner reaches itself: the
// control), a listener of root's on loopback, DNS, the frozen test's expected answers (in the evaluator's folder and where
// the driver keeps them), a listing of the evaluator's folder, the baseline's own file, writing into the test, and any
// readable environment holding the runner's fake secret; the scorer tries the outside too.
//  1. This machine, the firewall path (no namespace used): every case scored, every way out held, the hung case cut at
//     the test's time limit with nothing scored for it, the isolation reported as "firewall".
//  2. This machine, the namespace path (what a VM sandbox gives): the same, reported as "netns".
//  3. A run container (src/run-container.ts runContainerBody: every capability dropped but the runner's, no new
//     privileges, the runs' limits), the runner image JUDGE_RUN_IMAGE with this checkout's code mounted over its own:
//     no namespace can be made there (no CAP_SYS_ADMIN), so the firewall path is taken, and holds.
//  4. The same container without NET_ADMIN: neither a namespace nor the firewall: refused, with nothing run or measured.
//  5. The run's own deadline: an evaluation that would outlast it is refused with nothing scored.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { bridgeGateway, dockerSocket, judgeHere, judgeInContainer, type JudgeOut, type JudgeSpec } from "./lib/judge-sandbox.js";

const FIX = path.join(import.meta.dirname, "fixtures", "judge");
if (process.getuid?.() !== 0) { console.log("HOSTED JUDGE TEST SKIPPED: not root (the evaluator switches to run users of its own)"); process.exit(0); }

let failed = 0, ran = 0;
async function item(name: string, fn: () => Promise<void | string>) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  ran++;
  try { const skip = await fn(); console.log(skip ? `- ${name}: SKIPPED (${skip})` : `✓ ${name}`); }
  catch (e) { failed++; console.log(`✗ ${name}\n    ${String((e as Error).stack ?? (e as Error).message).split("\n").slice(0, 8).join("\n    ").slice(0, 2000)}`); }
}

const work = mkdtempSync(path.join(tmpdir(), "hosted-judge-"));
chmodSync(work, 0o700); // root's: the run users never read what the driver reads from
const listeners: net.Server[] = [];
const listen = (host: string) => new Promise<{ port: number; hits: () => number }>((resolve, reject) => {
  let hits = 0;
  const s = net.createServer((c) => { hits++; c.destroy(); });
  s.once("error", reject);
  s.listen(0, host, () => { listeners.push(s); resolve({ port: (s.address() as net.AddressInfo).port, hits: () => hits }); });
});

const FLOORS = ["net_blocked", "loopback_blocked", "dns_blocked", "expected_hidden", "scratch_hidden", "champion_hidden", "test_unwritable", "secret_absent", "scorer_net_blocked"];
/** One evaluation's folder: the test (cases and scorer), the candidate (mult 2) and the baseline (mult 1, with a file of its own). */
function setUp(name: string, o: { outside: { host: string; port: number }; loopback: number; specDir?: string; timeout: number }) {
  const dir = path.join(work, name);
  for (const d of ["test", "candidate", "champion"]) mkdirSync(path.join(dir, d), { recursive: true });
  copyFileSync(path.join(FIX, "test", "score.cjs"), path.join(dir, "test", "score.cjs"));
  const input = (x: number, mode?: string) => ({ x, ...(mode ? { mode } : {}), outside: o.outside, loopback: o.loopback, cases_path: "cases.json", spec_cases: path.join(o.specDir ?? dir, "test", "cases.json"), secret_name: "JUDGE_FAKE_SECRET" });
  const cases = [1, 2, 3, 4, 5].map((x) => ({ id: `c${x}`, input: input(x), expected: 2 * x })).concat([{ id: "hang", input: input(6, "sleep"), expected: 12 }]);
  writeFileSync(path.join(dir, "test", "cases.json"), JSON.stringify({ cases }));
  for (const d of ["candidate", "champion"]) copyFileSync(path.join(FIX, "candidate", "run.cjs"), path.join(dir, d, "run.cjs"));
  writeFileSync(path.join(dir, "candidate", "lib.json"), JSON.stringify({ mult: 2 }));
  writeFileSync(path.join(dir, "champion", "lib.json"), JSON.stringify({ mult: 1 }));
  writeFileSync(path.join(dir, "champion", "champion-only.txt"), "the baseline's own file\n");
  const spec = (extra: Partial<JudgeSpec> = {}): JudgeSpec => ({
    test_dir: path.join(dir, "test"), candidate_dir: path.join(dir, "candidate"), champion_dir: path.join(dir, "champion"), cases_path: "cases.json",
    candidate_command: ["node", "run.cjs"], scorer_command: ["node", "score.cjs"], timeout_seconds: o.timeout, metric: "score", floors: FLOORS,
    control: o.outside, ...extra });
  return { dir, spec };
}
type Out = JudgeOut;
/** What every isolated run must show: scores back, every way out held, the hung case cut at the time limit. */
function holds(out: Out, network: string, timeout: number) {
  assert.equal(out.control, "reached", "the runner itself reaches the outside listener (else a blocked probe proves nothing)");
  assert.equal(out.completion?.outcome, "succeeded", JSON.stringify(out.completion));
  assert.ok(out.result && !out.result.error && !out.result.tampered, JSON.stringify(out.result));
  const iso = out.events.find((e) => e.type === "evaluation_isolation");
  assert.deepEqual(iso?.data, { network, users: 3 }, "the isolation used is the run's event");
  const byId = Object.fromEntries(out.result!.cases.map((c) => [c.id, c]));
  for (const x of [1, 2, 3, 4, 5]) {
    const c = byId[`c${x}`]!;
    assert.equal(c.candidate, 1, `c${x}: the candidate's score came back`); assert.equal(c.baseline, 0, `c${x}: the baseline's score came back`);
    for (const f of FLOORS) assert.equal(c.floors[f], 1, `c${x}: ${f} held (${JSON.stringify(c.floors)})`);
  }
  assert.equal(byId.hang!.candidate, null, "the hung candidate scored nothing"); assert.equal(byId.hang!.baseline, null);
  // Cases 1-5: four programs each, the probes' 1.5 s timeouts at most a few times; the hung case: two programs cut at the limit.
  assert.ok(out.ms < 2 * timeout * 1000 + 5 * 4 * 12_000, `it took ${out.ms} ms`);
}
const TIMEOUT = 6;
/** The runner's fake secret: in its environment (the container's), never in any program's. */
const secretEnv = () => ({ JUDGE_FAKE_SECRET: randomBytes(12).toString("hex") });
try {
  const outside = await listen("127.0.0.1"), loop = await listen("127.0.0.1");
  await item("1. this machine, the firewall path: scores back, every way out held, the hang cut at its limit", async () => {
    const s = setUp("fw", { outside: { host: "127.0.0.1", port: outside.port }, loopback: loop.port, timeout: TIMEOUT });
    const before = outside.hits();
    const out = judgeHere(s.spec({ network: "firewall" }), secretEnv());
    holds(out, "firewall", TIMEOUT);
    await new Promise((r) => setTimeout(r, 300)); // the driver ran synchronously: its connections are accepted now
    assert.equal(outside.hits() - before, 1, "only the runner's own control connection arrived");
    assert.equal(spawnSync("sh", ["-c", "nft list tables 2>/dev/null | grep -c app_eval_"], { encoding: "utf8" }).stdout.trim(), "0", "the evaluation's firewall table is gone after it");
  });
  await item("2. this machine, the namespace path: the same, each program in an empty network", async () => {
    const s = setUp("ns", { outside: { host: "127.0.0.1", port: outside.port }, loopback: loop.port, timeout: TIMEOUT });
    holds(judgeHere(s.spec({ network: "auto" }), secretEnv()), "netns", TIMEOUT);
  });
  await item("5. the run's own deadline: an evaluation that would outlast it is refused, nothing scored", async () => {
    const s = setUp("late", { outside: { host: "127.0.0.1", port: outside.port }, loopback: loop.port, timeout: TIMEOUT });
    // A minute and a half: past the minute kept to report, about 30 s to measure in, less than the cases take.
    const out = judgeHere(s.spec({ network: "firewall", deadline_seconds: 75 }), secretEnv());
    assert.equal(out.completion?.outcome, "succeeded", "the run itself ends; the API refuses the evaluation");
    assert.deepEqual(out.result?.cases, []);
    assert.match(out.result?.error ?? "", /ran past its run's time limit after \d of 6 cases, so nothing was scored/);
  });

  // ---------- a run container ----------
  const sock = dockerSocket();
  const image = process.env.JUDGE_RUN_IMAGE || "";
  const why = !existsSync(sock) ? "no Docker socket" : !image ? "JUDGE_RUN_IMAGE names no runner image (one built from this codebase's Dockerfile)" : null;
  const inContainer = async (name: string, drop: string[] = []): Promise<Out | string> => {
    if (why) return why;
    const gw = await bridgeGateway(sock);
    if (!gw) return "the Docker bridge network has no gateway address";
    const out = await listen(gw);
    const lo = 45000 + Math.floor(Math.random() * 1000); // a port inside the container; nothing listens there: blocked either way
    const s = setUp(name, { outside: { host: gw, port: out.port }, loopback: lo, specDir: "/spec", timeout: TIMEOUT });
    return judgeInContainer(s.spec(), { image, drop, sock, ttlSeconds: 300, env: { ...secretEnv(), APP_WORKER_TOKEN: `fake-${randomBytes(8).toString("hex")}` } });
  };
  await item("3. a run container: no namespace can be made, the firewall path holds", async () => {
    const out = await inContainer("ctr");
    if (typeof out === "string") return out;
    holds(out, "firewall", TIMEOUT);
  });
  await item("4. a run container without NET_ADMIN: neither a namespace nor the firewall: refused, nothing run or measured", async () => {
    const out = await inContainer("nocap", ["NET_ADMIN"]);
    if (typeof out === "string") return out;
    assert.equal(out.completion?.outcome, "succeeded", "the run ends; the API refuses the evaluation");
    assert.deepEqual(out.result?.cases, []);
    assert.match(out.result?.error ?? "", /^this sandbox cannot keep the evaluation's programs off the network \(no network namespace can be made here; its firewall could not shut the evaluation's users out \(nft: .+\)\), so nothing was run or measured$/);
    assert.ok(!out.events.some((e) => e.type === "evaluation_isolation"));
  });
} finally {
  for (const s of listeners) s.close();
  rmSync(work, { recursive: true, force: true });
}
console.log(`\nhosted judge: ${ran - failed} of ${ran} passed`);
process.exit(failed ? 1 : 0);
