/**
 * The guardian (mold_v0-291; molds/mold_v0/docs/agent-harness.md "Acceptance"): server-owned and fail-closed. No agent
 * calls it and no agent's words reach it: what it reads is the frozen test's own measurements, taken in a clean sandbox by
 * trusted code (src/program-evaluator.ts), and the record of what was changed. Pure: the rule and its statistics are here.
 *
 *   refused       the test was tampered with, the candidate changed something outside the declared surface, a floor was
 *                 violated or a metric is missing, there are too few cases, the improvement is too small, or its 95%
 *                 confidence interval's lower bound is not above zero
 *   needs_review  there is no test, or nothing to beat (no current best, and no current version of the target to measure
 *                 in its place: mold_v0-303), or (mold_v0-303) what changed is wording only (instructions, a SKILL.md: no
 *                 model runs in the evaluator, so wording cannot be measured): a person decides, nothing is promoted by itself
 *   accepted      everything held: it beats the current best by at least min_lift, and is promoted to a new version
 */
import type { Acceptance } from "./program-spec.js";
import { globMatch, testFrozen } from "./program-spec.js";

export const CONFIDENCE = 0.95;
export const MIN_CASES = 5;
export const BOOTSTRAP_ITERATIONS = 10_000;

export interface MeasuredCase { id: string; baseline: number | null; candidate: number | null; floors?: Record<string, number | null | undefined> }
export interface Measurement { cases: MeasuredCase[]; tampered: string | null }
export interface Decision {
  outcome: "accepted" | "refused" | "needs_review";
  reasons: string[];
  metrics: { n: number; baseline_mean: number | null; candidate_mean: number | null; lift: number | null; ci_low: number | null; ci_high: number | null; floors: Record<string, number | null> };
}

/** A deterministic PRNG (mulberry32): one evaluation always gives one interval, so a decision can be checked later. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export function seedOf(id: string): number { let h = 2166136261; for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** The percentile bootstrap interval of a mean, at `confidence`, deterministic for one seed. */
export function bootstrapCI(samples: readonly number[], seed: number, confidence = CONFIDENCE, iterations = BOOTSTRAP_ITERATIONS): { low: number; high: number } {
  const rand = prng(seed), n = samples.length, means = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) { let s = 0; for (let j = 0; j < n; j++) s += samples[Math.floor(rand() * n)]!; means[i] = s / n; }
  means.sort();
  const q = (p: number) => { const pos = p * (iterations - 1), lo = Math.floor(pos), hi = Math.ceil(pos); return means[lo]! + (pos - lo) * (means[hi]! - means[lo]!); };
  const tail = (1 - confidence) / 2;
  return { low: q(tail), high: q(1 - tail) };
}

/**
 * mold_v0-303 (operator decision 2): the paths that are wording, not a measurable artefact. A change of only these goes to a
 * person: the guardian measures scripts, schemas and policies offline, and never a model reading words.
 */
export const WORDING_GLOBS = ["*.md", "**/*.md", "*.mdx", "**/*.mdx", "*.markdown", "**/*.markdown", "*.txt", "**/*.txt", "*.rst", "**/*.rst"] as const;
export const isWording = (p: string) => WORDING_GLOBS.some((g) => globMatch(g, p));
export const wordingOnly = (paths: readonly string[]) => paths.length > 0 && paths.every(isWording);

/** The candidate's paths outside its declared surface. */
export const offSurface = (paths: readonly string[], surface: readonly string[]): string[] => paths.filter((p) => !surface.some((g) => globMatch(g, p)));

/**
 * The rule. `hasBest`: a baseline was measured here: the current champion, or (mold_v0-303) with none yet, the target's
 * current version. A case is compared within the case (paired), so the interval is of the improvement, not of two separate
 * means. `changedPaths` (mold_v0-303): what the candidate changed against that baseline, when known: nothing is refused,
 * wording only goes to a person.
 */
export function decideAcceptance(a: Acceptance, input: { measured: Measurement | null; offSurfacePaths: readonly string[]; hasBest: boolean; seed: number; changedPaths?: readonly string[] }): Decision {
  const empty = { n: 0, baseline_mean: null, candidate_mean: null, lift: null, ci_low: null, ci_high: null, floors: {} };
  const refused = (reasons: string[], metrics: Decision["metrics"] = empty): Decision => ({ outcome: "refused", reasons, metrics });
  if (input.offSurfacePaths.length) return refused([`it changed something outside its declared surface: ${input.offSurfacePaths.slice(0, 10).join(", ")}`]);
  if (input.changedPaths && !input.changedPaths.length) return refused(["it changes nothing of the target"]);
  if (input.changedPaths && wordingOnly(input.changedPaths)) return { outcome: "needs_review", reasons: [`it changes wording only (${input.changedPaths.slice(0, 5).join(", ")}): the guardian measures scripts, schemas and policies, not words, so a person decides`], metrics: empty };
  if (!a.test) return { outcome: "needs_review", reasons: ["this program declares no test, so a person decides"], metrics: empty };
  if (!testFrozen(a.test)) return refused(["its test was declared from a recipe but never frozen (bring the program in again once the recipe has its version)"]);
  const m = input.measured;
  if (!m) return refused(["the evaluation did not produce measurements"]);
  if (m.tampered) return refused([`the test was tampered with: ${m.tampered}`]);
  const usable = m.cases.filter((c) => typeof c.candidate === "number" && Number.isFinite(c.candidate));
  if (usable.length !== m.cases.length) return refused([`${m.cases.length - usable.length} of ${m.cases.length} cases have no measurement for the candidate`]);
  if (usable.length < MIN_CASES) return refused([`only ${usable.length} cases were measured: at least ${MIN_CASES} are needed`]);
  const sign = a.direction === "maximize" ? 1 : -1;
  const reasons: string[] = [];
  const floors: Record<string, number | null> = {};
  for (const f of a.floors) {
    const vs = usable.map((c) => c.floors?.[f.metric]);
    if (vs.some((v) => typeof v !== "number" || !Number.isFinite(v))) { floors[f.metric] = null; reasons.push(`the floor metric ${f.metric} is missing from some cases (a floor fails closed)`); continue; }
    const avg = mean(vs as number[]);
    floors[f.metric] = avg;
    if (f.min !== undefined && avg < f.min) reasons.push(`the floor ${f.metric} is ${avg.toFixed(4)}, below its minimum ${f.min}`);
    if (f.max !== undefined && avg > f.max) reasons.push(`the floor ${f.metric} is ${avg.toFixed(4)}, above its maximum ${f.max}`);
  }
  const candMean = mean(usable.map((c) => c.candidate as number));
  if (!input.hasBest) return { outcome: reasons.length ? "refused" : "needs_review", reasons: reasons.length ? reasons : ["there is nothing to beat yet (no current best and no current version of the target), so a person decides"], metrics: { ...empty, n: usable.length, candidate_mean: candMean, floors } };
  if (usable.some((c) => typeof c.baseline !== "number" || !Number.isFinite(c.baseline))) return refused([...reasons, "the current best was not measured on every case (fails closed)"], { ...empty, n: usable.length, candidate_mean: candMean, floors });
  const deltas = usable.map((c) => sign * ((c.candidate as number) - (c.baseline as number)));
  const baseMean = mean(usable.map((c) => c.baseline as number));
  const ci = bootstrapCI(deltas, input.seed);
  const improvement = mean(deltas);
  const lift = baseMean === 0 ? (improvement > 0 ? Number.POSITIVE_INFINITY : 0) : improvement / Math.abs(baseMean);
  const metrics: Decision["metrics"] = { n: usable.length, baseline_mean: baseMean, candidate_mean: candMean, lift: Number.isFinite(lift) ? lift : null, ci_low: ci.low, ci_high: ci.high, floors };
  if (!(improvement > 0)) reasons.push(`it does not beat the current best (${candMean.toFixed(4)} against ${baseMean.toFixed(4)})`);
  if (lift < a.min_lift) reasons.push(`its improvement of ${(lift * 100).toFixed(1)}% is below the required ${(a.min_lift * 100).toFixed(1)}%`);
  if (!(ci.low > 0)) reasons.push(`the 95% confidence interval's lower bound (${ci.low.toFixed(4)}) is not above zero`);
  if (reasons.length) return refused(reasons, metrics);
  return { outcome: "accepted", reasons: [`it beats the current best by ${(lift * 100).toFixed(1)}%, and the interval's lower bound is ${ci.low.toFixed(4)}`], metrics };
}
