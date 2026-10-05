/**
 * THE BUILT-IN-LIBRARY RATCHET: base code ships no workflow and no recipe of its own.
 *
 * Base code once carried a workflow library (every script under one base directory, compiled into
 * agent/lib/workflow-library.generated.ts) and a recipe list (a constant in agent/lib/provision-workspace.ts), and
 * wrote both into every workspace of every deployment, whatever the deployment was for. What a workspace receives is
 * the deployment profile's now: the directories it names under `library.sources` (scripts/lib/profile-library.mjs).
 * This holds the four ways base code could grow a library of its own again:
 *
 *   1. a workflow script (`*.workflow.js`) outside the library directories (`library/<id>/workflows/`): a script
 *      anywhere else is one some base code is about to read and seed;
 *   2. the default profile naming a library source: `library.sources` in profiles/00-default.json is `{}`. A
 *      deployment opts into a library by ADDING a profile file; the default deployment has none;
 *   3. a recipe written as a literal in base code: an object with both `slug` and `satisfiesCheck` in a source
 *      file. A recipe is a row of a library's recipes.json;
 *   4. a new WRITER: a source file that inserts into the `workflows` or `recipes` table. Each one that exists is
 *      listed with what decides its rows (`builtin_library.writers` in scripts/neutral-names.allow.json: a person's
 *      request, the profile's library, the specialist registry); a file that starts inserting must be added there
 *      with its reason, where a reviewer reads it, and one that stops must be removed.
 *
 * Tests and pinned fixtures are not base code that runs in a deployment: `skip` lists them.
 *
 * Offline, no build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./neutral-names.mjs";

const globToRegExp = (glob) => new RegExp(`^${glob.split("**").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);

export function readLibraryAllow(doc) {
  const section = doc?.builtin_library ?? {};
  const keys = (name) => Object.keys(section[name] ?? {}).filter((k) => k !== "$comment");
  const libraries = keys("libraries");
  if (!libraries.length) throw new Error("neutral-names: builtin_library.libraries parsed as empty; refusing to check nothing");
  return {
    libraries: libraries.map(globToRegExp),
    skip: keys("skip").map(globToRegExp),
    writers: new Set(keys("writers")),
  };
}

const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** An insert into one of the two tables a library is written to: the query builder's, or SQL. */
export const WRITER = /\.insert\(\s*(?:schema\.)?(?:workflows|recipes)\s*\)|\binsert\s+into\s+"?(?:workflows|recipes)\b/i;
/** A recipe as an object literal: `slug` and `satisfiesCheck` in one pair of braces. */
export const RECIPE_LITERAL = /\{[^{}]*\bslug\s*:\s*["'`][^{}]*\bsatisfiesCheck\s*:[^{}]*\}|\{[^{}]*\bsatisfiesCheck\s*:\s*["'`][^{}]*\bslug\s*:[^{}]*\}/;

/** Walk the tree: every way base code carries, or could seed, a library of its own. */
export function checkBuiltinLibrary(root, allow) {
  const problems = [];
  const writersSeen = new Set();
  const inLibrary = (p) => allow.libraries.some((re) => re.test(p));
  const skipped = (p) => allow.skip.some((re) => re.test(p));
  for (const path of listFiles(root)) {
    if (path.endsWith(".workflow.js") && !inLibrary(path) && !skipped(path)) {
      problems.push(`${path}: a workflow script outside a library directory. Base code ships no workflow of its own: put it in a library the deployment profile names (library/<id>/workflows/, docs/DEPLOYMENT_PROFILE.md "library"), or in a pack.`);
    }
    if (!SOURCE.test(path) || inLibrary(path) || skipped(path)) continue;
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    if (RECIPE_LITERAL.test(text)) {
      problems.push(`${path}: a recipe written as a literal ({ slug, satisfiesCheck }). Base code ships no recipe of its own: a recipe is a row of a library's recipes.json, named by the deployment profile.`);
    }
    if (WRITER.test(text)) {
      writersSeen.add(path);
      if (!allow.writers.has(path)) {
        problems.push(`${path}: inserts into the workflows or recipes table and is not a listed writer. What a workspace receives is decided by a person's request, the deployment profile's library or the specialist registry, never by a list in base code: if this is one of those, add the file to builtin_library.writers in scripts/neutral-names.allow.json with what decides its rows.`);
      }
    }
  }
  for (const w of allow.writers) {
    if (!writersSeen.has(w)) problems.push(`${w}: listed in builtin_library.writers but no longer inserts into workflows or recipes. Remove it from the list.`);
  }
  let sources;
  try {
    sources = JSON.parse(readFileSync(join(root, "profiles/00-default.json"), "utf8"))?.library?.sources;
  } catch {
    sources = undefined;
  }
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    problems.push(`profiles/00-default.json: library.sources is missing. It is the one place a deployment's library is named, and the default names none: "library": { "sources": {} }.`);
  } else if (Object.keys(sources).filter((k) => k !== "$comment").length) {
    problems.push(`profiles/00-default.json: library.sources names ${Object.keys(sources).filter((k) => k !== "$comment").join(", ")}. The default profile names no library: a deployment opts into one by adding a profile file (cp library/<id>/profile.json profiles/40-library-<id>.json).`);
  }
  return { problems, writers: writersSeen.size };
}
