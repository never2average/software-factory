/**
 * Deterministic "is the agent done?" check, from the workspace git diff (vs the seed / cloned commit) plus the
 * run's events. No LLM involved.
 *
 * Done = the diff is non-empty AND it changes a dependency manifest or config file, or implementation code.
 * Docs-only, tests-only, lockfile-only or empty diffs are not done (a planning-only or "nothing to do here" ending).
 */
import { createHash } from "node:crypto";

export type FileKind = "deps" | "lockfile" | "config" | "code" | "test" | "docs" | "other";
export interface Progress {
  done: boolean;
  /** Short human/LLM-readable reason. */
  reason: string;
  changed_files: string[];
  kinds: Partial<Record<FileKind, number>>;
  added_lines: number;
  removed_lines: number;
  /** Stable hash of the diff: lets the session see whether a run changed anything. */
  hash: string;
}

const DEPS = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|go\.mod|Cargo\.toml|Gemfile|composer\.json|build\.gradle(\.kts)?|pom\.xml|[^/]+\.csproj)$/;
const LOCK = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|Pipfile\.lock|uv\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]*\.py$|[^/]_test\.py$/;
const DOCS = /\.(md|mdx|txt|rst|adoc)$|(^|\/)(LICENSE|CHANGELOG|NOTICE)[^/]*$/i;
const CODE = /\.([cm]?[jt]sx?|py|go|rs|rb|java|kt|kts|cs|php|swift|scala|sql|vue|svelte|astro|ex|exs|dart|c|cc|cpp|h|hpp|sh|graphql|gql|prisma|html|css|scss)$/;
const CONFIG = /(^|\/)(\.env[^/]*|Dockerfile[^/]*|docker-compose[^/]*|Procfile|Makefile|[^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|settings\.py|[^/]+\.(ya?ml|toml|ini|cfg|conf|json|properties|xml))$/;

export function classify(path: string): FileKind {
  if (LOCK.test(path)) return "lockfile";
  if (DEPS.test(path)) return "deps";
  if (TEST.test(path)) return "test";
  if (DOCS.test(path)) return "docs";
  if (CODE.test(path)) return path.match(/\.config\.[cm]?[jt]s$/) ? "config" : "code";
  if (CONFIG.test(path)) return "config";
  return "other";
}

/** Parse a unified `git diff` (as emitted by the runners' DIFF_SCRIPT) into the done verdict. */
export function assessDiff(diff: string | null | undefined): Progress {
  const d = diff ?? "";
  const files: string[] = [];
  let added = 0, removed = 0;
  for (const line of d.split("\n")) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { if (!files.includes(m[2]!)) files.push(m[2]!); continue; }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  const kinds: Partial<Record<FileKind, number>> = {};
  for (const f of files) { const k = classify(f); kinds[k] = (kinds[k] ?? 0) + 1; }
  const hash = createHash("sha256").update(d).digest("hex").slice(0, 16);
  const base = { changed_files: files.slice(0, 60), kinds, added_lines: added, removed_lines: removed, hash };
  if (!files.length) return { ...base, done: false, reason: "no changes in the workspace yet" };
  if (kinds.code || kinds.deps || kinds.config) {
    const what = [kinds.code ? `${kinds.code} code file(s)` : "", kinds.deps ? "dependency manifest" : "", kinds.config ? "config" : ""].filter(Boolean).join(", ");
    return { ...base, done: true, reason: `workspace changed: ${what}` };
  }
  const only = Object.keys(kinds).join("/");
  return { ...base, done: false, reason: `only ${only} changes so far; no implementation, dependency or config change` };
}
