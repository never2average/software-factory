/**
 * A job kind's required outputs (mold_v0-188): the files of its write-back an agent-workspace run must write when it
 * works. A run that exited 0, validated and staged its write-back, but left a required output as it found it, did not
 * do its job: it fails with error_kind "output_missing", naming the outputs, and nothing of it is written back (as any
 * failed run). Maxwell's report_audit_findings ran 20 minutes, appended one ledger line, had its write to the report
 * refused and "succeeded" ($11.60, run_S59pF-Rit5xA3fsh): with the report declared, that run fails, saying so.
 *
 *   required_outputs       globs of write-back files (* one segment, ** any depth, ? a character; "{name}" a declared
 *                          argument's value): each must match at least one file the run added or changed. A file the
 *                          run only removed is not an output it wrote
 *   required_outputs_when  "always" (default): every run that would succeed is checked; "workspace_changed": only a run
 *                          that changed something in its workspace (a program with a quiet exit, "nothing to do, the
 *                          report is current", writes nothing at all and still succeeds; one that wrote its ledger but
 *                          not its report fails)
 *
 * Why a failure and not a new status: every API, MCP and console consumer, the charges, the schedules and the
 * allowances already know "failed"; a new terminal status would be a fourth they all had to learn, and a consumer that
 * reads "succeeded" as "done" would take a run with its report missing for a finished one. error_kind is the reason, as
 * "validation" and "timeout" are. Its cost counts as a failed run's does today (price.on_failure; allowances count
 * every run's cost).
 *
 * Plain node, no zod: the run sandbox's runner (src/run-sandbox-runner.ts) loads it (mold_v0-055).
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { globRegex } from "./agent-workspace-paths.js";

export type RequiredOutputsWhen = "always" | "workspace_changed";
export const REQUIRED_OUTPUTS_WHEN: readonly RequiredOutputsWhen[] = ["always", "workspace_changed"];
/** The error_kind of a run that did not write a required output. */
export const OUTPUT_MISSING = "output_missing" as const;

/** A required output's pattern with the run's argument values filled in (a value is one path segment's text). */
export function fillPattern(pattern: string, values: Record<string, string>): string {
  return pattern.replace(/\{([^{}]*)\}/g, (_m, p: string) => {
    const v = values[p];
    if (v === undefined) throw new Error(`required output ${pattern}: {${p}} has no value for this run`);
    // Taken literally: a value never adds a glob character, a path part or a way out of its segment.
    return v.replace(/[*?/\\[\]{}]/g, "_");
  });
}

/** Plain files under `root` (relative, forward slashes) that `keep` accepts: links and special files are not followed. */
function files(root: string | null, keep: (rel: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  if (!root) return out;
  const walk = (dir: string, rel: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name, p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile() && keep(r)) {
        try { if (lstatSync(p).isFile()) out.set(r, createHash("sha256").update(readFileSync(p)).digest("hex")); } catch { /* gone */ }
      }
    }
  };
  walk(root, "");
  return out;
}

/**
 * The files matching any of `patterns` that are in `after` (the staged write-back) and not in `before` (the snapshot the
 * run restored) with the same content: what the run wrote of them. Only matching files are read.
 */
export function writtenOutputs(before: string | null, after: string, patterns: string[]): string[] {
  if (!patterns.length) return [];
  const res = patterns.map(globRegex);
  const keep = (rel: string) => res.some((re) => re.test(rel));
  const was = files(before, keep), now = files(after, keep);
  return [...now].filter(([rel, sha]) => was.get(rel) !== sha).map(([rel]) => rel).sort();
}

export interface RequiredOutputsCheck {
  required: string[];
  when?: RequiredOutputsWhen;
  /** The store's answer to the staged write-back: nothing at all changed in the workspace. */
  workspaceUnchanged: boolean;
  /** The write-back files the run added or changed (writtenOutputs). */
  written: string[];
  values?: Record<string, string>;
}

/** The required outputs (filled in) that no written file matches; [] when none is missing or the check does not apply. */
export function missingOutputs(c: RequiredOutputsCheck): string[] {
  if (!c.required.length) return [];
  if ((c.when ?? "always") === "workspace_changed" && c.workspaceUnchanged) return [];
  return c.required.map((p) => fillPattern(p, c.values ?? {})).filter((p) => !c.written.some((w) => globRegex(p).test(w)));
}

/** A run's end as the harness reports it (src/runs.ts Completion, the fields this needs). */
export interface Outcome { outcome: "succeeded" | "failed"; error_kind?: string; error?: string; results?: unknown[] }

/**
 * A run's end once its required outputs are checked: a run that failed stays as it failed (its own reason); one that
 * would succeed fails "output_missing" when an output is missing, and succeeds as before otherwise.
 */
export function withRequiredOutputs<T extends Outcome>(end: T, c: RequiredOutputsCheck): T | { outcome: "failed"; error_kind: typeof OUTPUT_MISSING; error: string } {
  if (end.outcome !== "succeeded") return end;
  const missing = missingOutputs(c);
  if (!missing.length) return end;
  return { outcome: "failed", error_kind: OUTPUT_MISSING,
    error: `the run did not write ${missing.length === 1 ? "its required output" : `${missing.length} of its required outputs`} (${missing.join(", ")}): `
      + "this kind always does when it works, so nothing was written back; what the program said is in the run's events" };
}
