// A program's frozen test against a candidate, measured by the acceptance evaluator the way a run sandbox measures it
// (mold_v0-324; scripts/lib/judge-sandbox.ts): its three run users, no network, the test's time limit, the run's
// deadline. Nothing is stored or promoted: it prints what the evaluator would report to the API. Run as root.
//   npx tsx scripts/judge-sandbox.ts <spec.json> [--container <runner image>] [--firewall]
// spec.json: {test_dir, candidate_dir, champion_dir?, cases_path, candidate_command, scorer_command, timeout_seconds,
//             metric, floors, deadline_seconds?} (paths on this machine; they are copied into a folder only root reads).
// --container: inside a run container from that image (src/run-container.ts's shape, this checkout's code mounted);
// else on this machine (--firewall: the firewall path even where a network namespace could be made).
// Prints {isolation, cases, means, error, tampered, ms}; exits 0 when measured, 1 when refused or failed.
import { readFileSync } from "node:fs";
import { judgeHere, judgeInContainer, type JudgeSpec } from "./lib/judge-sandbox.js";

const args = process.argv.slice(2);
const at = args.indexOf("--container");
const image = at >= 0 ? args[at + 1] : null;
const file = args.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
if (!file || (at >= 0 && !image)) { console.error("usage: judge-sandbox.ts <spec.json> [--container <runner image>] [--firewall]"); process.exit(2); }
if (process.getuid?.() !== 0) { console.error("judge-sandbox: run as root (the evaluator switches to run users of its own)"); process.exit(2); }
const spec = { ...JSON.parse(readFileSync(file, "utf8")), network: args.includes("--firewall") ? "firewall" : "auto" } as JudgeSpec;
const out = image ? await judgeInContainer(spec, { image, ttlSeconds: (spec.deadline_seconds ?? 3600) + 120 }) : judgeHere(spec);
const cases = out.result?.cases ?? [];
const mean = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => typeof x === "number"); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1e4) / 1e4 : null; };
const floors = Object.fromEntries((spec.floors ?? []).map((f) => [f, mean(cases.map((c) => c.floors[f] ?? null))]));
console.log(JSON.stringify({
  isolation: out.events.find((e) => e.type === "evaluation_isolation")?.data ?? null,
  n: cases.length, means: { candidate: mean(cases.map((c) => c.candidate)), baseline: mean(cases.map((c) => c.baseline)), floors },
  unscored: { candidate: cases.filter((c) => c.candidate === null).map((c) => c.id), baseline: cases.filter((c) => c.baseline === null).map((c) => c.id) },
  error: out.result?.error ?? (out.completion?.outcome === "failed" ? out.completion.error ?? "failed" : null), tampered: out.result?.tampered ?? null, ms: out.ms,
}, null, 1));
process.exit(cases.length && !out.result?.error && !out.result?.tampered ? 0 : 1);
