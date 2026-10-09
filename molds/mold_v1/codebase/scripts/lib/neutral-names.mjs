/**
 * THE NEUTRAL-NAMES GATE: the base product's old role word appears NOWHERE in this repository.
 *
 * The base was written for one use, and its role word ran through everything: the operator tooling's folder and npm
 * script names, the package's bin names, an environment prefix, database columns, browser keys, comments and tests.
 * Four other gates keep it out of what a PERSON reads (check:ui-vocabulary), what the MODEL reads
 * (check:agent-vocabulary), a published package's own names (the agent-cli own-name gate) and the identifiers on the
 * wire (check:wire-names). This one covers the whole tree, and it has no allowance at all: no listed contract, no
 * per-file ceiling, no exempt path. Every name that carried the word was migrated (drizzle/0037 and 0038 for the
 * columns), and the few places that still READ data written under it (a stored value, an old record key, an old tool
 * name in a stored transcript) build it from its letters in one definition (agent/lib/legacy-member.ts,
 * BASE_PRODUCT_WORD in scripts/lib/agent-cli.mjs) instead of spelling it.
 *
 * It matches what `grep -rIi` matches: the three letters in that order, in any case, ANYWHERE: inside an identifier,
 * a hex digest, a URL-encoded path (`%2F` before a capital D and e), a lockfile hash. A file that must hold such a
 * value exactly (a recorded golden, a schema snapshot) writes the letter as a JSON `\uXXXX` escape
 * (scripts/lib/json-text.mjs), which parses to the same value. Binary files (a NUL byte) are not read, as `grep -I`.
 *
 * Offline, no network, no build: it reads the tracked and untracked-but-not-ignored files of a git checkout, or walks
 * the directory when there is no git.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BASE_PRODUCT_WORD } from "./agent-cli.mjs";

const OCCURRENCE = new RegExp(BASE_PRODUCT_WORD, "gi");
const IDENT = /[A-Za-z0-9_-]/;

/** Every occurrence in `text`: its line and the whole name it sits in (extended over letters, digits, `_` and `-`). */
export function occurrencesIn(text) {
  const out = [];
  String(text).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(OCCURRENCE)) {
      let a = m.index;
      let b = m.index + m[0].length;
      while (a > 0 && IDENT.test(line[a - 1])) a--;
      while (b < line.length && IDENT.test(line[b])) b++;
      out.push({ line: i + 1, name: line.slice(a, b) });
    }
  });
  return out;
}

/** The files to read: tracked plus untracked-not-ignored in a git checkout, else a plain walk. */
export function listFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // A deleted-but-still-tracked file is listed by --cached; it is not in the tree any more.
    return [...new Set(out.split("\0").filter(Boolean))].filter((p) => {
      try {
        return statSync(join(root, p)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    const SKIP = new Set(["node_modules", ".git", ".next", "test-results", ".dataroom", ".vercel", "dist"]);
    const out = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        if (SKIP.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else out.push(relative(root, full));
      }
    };
    walk(root);
    return out;
  }
}

/**
 * The allow-list file, read for the sections the other ratchets use. The word has NO section: a list that brings
 * one back (contracts, examples, a per-file ceiling or an exempt path) is refused, not honoured.
 */
export function readAllowList(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  for (const key of ["contracts", "examples", "base_word", "exempt_paths"]) {
    if (key in raw) throw new Error(`neutral-names: "${key}" is not an allowance any more; the base product's old role word is allowed nowhere`);
  }
  return {};
}

/** Check a tree. Returns { problems, files } (files: how many were read). */
export function checkTree(root) {
  const problems = [];
  let files = 0;
  for (const path of listFiles(root)) {
    for (const hit of occurrencesIn(path)) problems.push(`${path}: the path carries "${hit.name}". Name it after what it does.`);
    let text;
    try {
      const bytes = readFileSync(join(root, path));
      if (bytes.includes(0)) continue;
      text = bytes.toString("utf8");
    } catch {
      continue;
    }
    files++;
    for (const hit of occurrencesIn(text)) {
      problems.push(`${path}:${hit.line}: "${hit.name}" carries the base product's old role word. Use a neutral name (member, owner, operator, workspace); to READ data stored under it, build it from agent/lib/legacy-member.ts; for a recorded value (a hash, an encoded path) write the JSON escape (scripts/lib/json-text.mjs).`);
    }
  }
  return { problems, files };
}
