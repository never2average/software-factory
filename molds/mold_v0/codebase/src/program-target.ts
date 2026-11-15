/**
 * What an improvement improves (mold_v0-303; molds/mold_v0/docs/agent-harness.md "Acceptance"): the target of a program's
 * acceptance rule, its current files, and a candidate taken as an overlay on them.
 *
 *   the kind     fixed by the rule, or read from the run's inputs (kind_from_input, one of `kinds`): recipe, harness_policy
 *                or mold ("mold_ref" read as mold)
 *   the base     what a candidate changes and is measured against: the current best (a champion's whole files), or with
 *                none yet the target's current version: a recipe's files at its version, an agent profile's governance
 *                policy as `policy.json`, and for a mold nothing (no mold's files live in an app: a mold is only proposed to)
 *   the overlay  a candidate's `.candidate/` holds only what it changes; laid over the base it is the whole candidate, and
 *                what differs from the base is what it changed (judged against the surface, and wording only goes to a person)
 *   a deletion   mold_v0-308: `.candidate/.deleted` lists, one path a line, the base's files the candidate removes ("#" starts a
 *                comment). The list is never a file of the candidate: the merge leaves those files out, so the evaluator's
 *                bundle has none of them, a recipe proposal names them as removed, and the patch deletes them as git does.
 *                A path it lists and also writes is written (the file wins); a path the base does not have is nothing to delete.
 *   the brief    the candidate step's session gets the base read-only in `.target/` and is told the rules above
 *   a patch      what a version changes against its base, as a unified diff a person can apply to open a pull request
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { atPath, targetKindOf, TARGET_KINDS, type Acceptance, type TargetKind } from "./program-spec.js";

export interface TargetFile { path: string; body: Buffer; executable: boolean; upload?: { id: string; bytes: number; sha256: string } }
export interface TargetBase { label: string; files: TargetFile[] }
export const TARGET_DIR = ".target";
export const CANDIDATE_DIR = ".candidate";
/** mold_v0-308: the overlay's list of the base's files it removes, one path a line (never itself a file of the target). */
export const DELETED_LIST = ".deleted";
/** The most of a base the candidate's session is given (files): past it, the brief says so and lists none. */
const BRIEF_FILES = 60;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The kind a run improves: the rule's, or its input's (refused in words when it is not one the rule takes). */
export function targetKindFor(a: Acceptance, inputs: unknown): { kind: TargetKind } | { problem: string } {
  if (a.target.kind) return { kind: targetKindOf(a.target.kind) ?? a.target.kind };
  const raw = a.target.kind_from_input ? atPath(inputs ?? {}, a.target.kind_from_input) : undefined;
  const k = targetKindOf(raw);
  const allowed = a.target.kinds ?? [...TARGET_KINDS];
  if (!k) return { problem: `the input ${a.target.kind_from_input} does not name a kind of target (${allowed.join(", ")})` };
  if (!allowed.includes(k)) return { problem: `this program improves ${allowed.join(" or ")}, not ${k}` };
  return { kind: k };
}
export const targetIdFor = (a: Acceptance, inputs: unknown): string => a.target.id ?? (a.target.from_input ? String(atPath(inputs ?? {}, a.target.from_input) ?? "") : "");

/** An agent profile's governance policy as the file a candidate changes. */
export const POLICY_FILE = "policy.json";
export const policyFile = (governance: unknown): Buffer => Buffer.from(`${JSON.stringify(governance ?? {}, null, 2)}\n`);

/**
 * The target's current version, or null when it has none here (an unknown recipe, recipes off, a profile that is not
 * there, a mold). Never throws: no base means a person decides, which is what fails closed.
 */
export async function targetCurrent(kind: TargetKind, id: string): Promise<TargetBase | null> {
  if (!id) return null;
  try {
    if (kind === "recipe") {
      const R = await import("./recipes.js");
      if (!R.recipesOn()) return null;
      const r = await R.readRecipe(id);
      if (r.version < 1) return null;
      const files = r.versions.find((v) => v.version === r.version)?.files ?? [];
      const { readUploadBytes } = await import("./agent-profiles.js");
      const out: TargetFile[] = [];
      for (const f of files) out.push({ path: f.path, body: await readUploadBytes(f.id), executable: f.executable, upload: { id: f.id, bytes: f.bytes, sha256: f.sha256 } });
      return { label: `recipe ${id} version ${r.version}`, files: out };
    }
    if (kind === "harness_policy") {
      const { readProfile } = await import("./agent-profiles.js");
      const p = await readProfile(id);
      return { label: `agent profile ${id} version ${p.version}`, files: [{ path: POLICY_FILE, body: policyFile(p.config.governance ?? {}), executable: false }] };
    }
  } catch { /* no current version here */ }
  return null;
}

const looksExecutable = (b: Buffer) => b.length >= 2 && b[0] === 0x23 && b[1] === 0x21;
/** A bundle's files (src/workspace-bundle.ts), an executable one known by its `#!`. */
export async function filesOfBundle(bundle: Buffer, executable?: ReadonlySet<string>): Promise<TargetFile[]> {
  const { readBundle } = await import("./workspace-bundle.js");
  return readBundle(bundle).files.map((f: { path: string; body: Buffer }) => ({ path: f.path, body: f.body, executable: executable?.has(f.path) ?? looksExecutable(f.body) }));
}
/** Files as one bundle. */
export async function bundleOf(files: readonly TargetFile[]): Promise<Buffer> {
  const { packBundle } = await import("./workspace-bundle.js");
  const dir = mkdtempSync(path.join(tmpdir(), "target-"));
  try {
    for (const f of files) {
      const dest = path.resolve(dir, f.path);
      if (!dest.startsWith(dir + path.sep)) throw new Error(`${f.path} would leave its folder`);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, f.body);
    }
    return packBundle(dir).bundle;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** The paths an overlay's `.deleted` list names (mold_v0-308): one a line, blank lines and "#" comments skipped. */
export function deletedList(over: readonly TargetFile[]): string[] {
  const f = over.find((x) => x.path === DELETED_LIST);
  if (!f) return [];
  return [...new Set(f.body.toString("utf8").split(/\r?\n/).map((l) => l.trim().replace(/^\.?\/+/, "")).filter((l) => l && !l.startsWith("#")))];
}
/**
 * The overlay laid over the base: its files win; a file it does not name is the base's; a base file its `.deleted` list
 * names is left out (mold_v0-308), unless the overlay writes it too.
 */
export function overlay(base: readonly TargetFile[], over: readonly TargetFile[]): TargetFile[] {
  const out = new Map(base.map((f) => [f.path, f]));
  for (const p of deletedList(over)) out.delete(p);
  for (const f of over) {
    if (f.path === DELETED_LIST) continue;
    const b = base.find((x) => x.path === f.path);
    out.set(f.path, { path: f.path, body: f.body, executable: b ? b.executable || looksExecutable(f.body) : f.executable });
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}
/** What `merged` changes against `base` (added, different, or removed: mold_v0-308), in path order. */
export function changedPaths(base: readonly TargetFile[], merged: readonly TargetFile[]): string[] {
  const was = new Map(base.map((f) => [f.path, sha(f.body)]));
  return [...merged.filter((f) => was.get(f.path) !== sha(f.body)).map((f) => f.path), ...deletedPaths(base, merged)].sort();
}
/** The base's files `merged` no longer has (mold_v0-308), in path order. */
export function deletedPaths(base: readonly TargetFile[], merged: readonly TargetFile[]): string[] {
  const now = new Set(merged.map((f) => f.path));
  return base.filter((f) => !now.has(f.path)).map((f) => f.path).sort();
}

/** What the candidate step's session is told of its target, beside its own prompt. */
export function targetBrief(t: { kind: TargetKind; id: string; base: TargetBase | null; surface: readonly string[] }): string {
  const files = t.base?.files ?? [];
  return ["## The target",
    `You improve the ${t.kind === "harness_policy" ? "governance policy" : t.kind} ${t.id}${t.base ? ` (${t.base.label})` : " (it has no version here yet: you start it)"}.`,
    files.length ? `Its current files are in ${TARGET_DIR}/, read-only${files.length <= BRIEF_FILES ? `: ${files.map((f) => f.path).join(", ")}` : ` (${files.length} files)`}.` : `${TARGET_DIR}/ is empty.`,
    `Write only the files you change, at the same paths, under ${CANDIDATE_DIR}/ (for example ${CANDIDATE_DIR}/${files[0]?.path ?? "path/of/the/file"}): every file you do not write is taken from ${TARGET_DIR}/. To remove a file, list its path on a line of ${CANDIDATE_DIR}/${DELETED_LIST}. You may change only ${t.surface.join(", ")}.`,
    "It is measured by the platform's own test, which you never see. Scripts, schemas and policies are measured; a change of wording alone (instructions, a SKILL.md) is decided by a person.",
    t.kind === "mold" ? "A change to a mold is only ever proposed: a person reviews its patch and opens the pull request." : ""].filter(Boolean).join("\n");
}

/** One file's lines, and whether it ends without a newline. */
const linesOf = (b: Buffer) => { const s = b.toString("utf8"); const end = s.endsWith("\n"); const l = s.length ? (end ? s.slice(0, -1) : s).split("\n") : []; return { l, end }; };
const isText = (b: Buffer) => !b.subarray(0, 8000).includes(0);
/**
 * What `merged` changes against `base` as a unified diff (git's form): each changed file one hunk, its old lines out and
 * its new ones in; a removed file (mold_v0-308) as git deletes one, every old line out; a binary file named, not shown.
 * A person applies it (`git apply`) to open a pull request.
 */
export type PatchFile = { path: string; change: "added" | "modified" | "deleted"; binary: boolean };
export function unifiedPatch(base: readonly TargetFile[], merged: readonly TargetFile[]): { patch: string; files: PatchFile[] } {
  const was = new Map(base.map((f) => [f.path, f]));
  const out: string[] = [], files: PatchFile[] = [];
  for (const p of changedPaths(base, merged)) {
    const now = merged.find((f) => f.path === p), old = was.get(p);
    out.push(`diff --git a/${p} b/${p}`);
    if (!now) {
      const binary = !isText(old!.body);
      files.push({ path: p, change: "deleted", binary });
      out.push(`deleted file mode ${old!.executable ? "100755" : "100644"}`);
      if (binary) { out.push(`Binary files a/${p} and /dev/null differ`); continue; }
      const a = linesOf(old!.body);
      if (!a.l.length) continue; // an empty file: git names it, with no hunk
      out.push(`--- a/${p}`, "+++ /dev/null", `@@ -1,${a.l.length} +0,0 @@`);
      a.l.forEach((x, i) => { out.push(`-${x}`); if (i === a.l.length - 1 && !a.end) out.push("\\ No newline at end of file"); });
      continue;
    }
    const binary = !isText(now.body) || (!!old && !isText(old.body));
    files.push({ path: p, change: old ? "modified" : "added", binary });
    if (!old) out.push(`new file mode ${now.executable ? "100755" : "100644"}`);
    if (binary) { out.push(`Binary files ${old ? `a/${p}` : "/dev/null"} and b/${p} differ`); continue; }
    const a = old ? linesOf(old.body) : { l: [], end: true }, b = linesOf(now.body);
    out.push(`--- ${old ? `a/${p}` : "/dev/null"}`, `+++ b/${p}`, `@@ -${a.l.length ? 1 : 0},${a.l.length} +${b.l.length ? 1 : 0},${b.l.length} @@`);
    a.l.forEach((x, i) => { out.push(`-${x}`); if (i === a.l.length - 1 && !a.end) out.push("\\ No newline at end of file"); });
    b.l.forEach((x, i) => { out.push(`+${x}`); if (i === b.l.length - 1 && !b.end) out.push("\\ No newline at end of file"); });
  }
  return { patch: out.length ? `${out.join("\n")}\n` : "", files };
}
