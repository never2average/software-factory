/**
 * THE NEUTRAL-NAMES RATCHET: where the base product's role word may still appear
 * in this repository, and nowhere else.
 *
 * The base was written for one use, a forward-deployed engineering team, and its
 * role word ran through everything: the operator tooling's folder and npm script
 * names, the package's bin names, an environment prefix, a database column, the
 * comments and the tests. Four earlier gates took it out of what a PERSON reads
 * (check:ui-vocabulary), what the MODEL reads (check:agent-vocabulary), a
 * published package's own names (the agent-cli own-name gate) and the identifiers
 * on the wire (check:wire-names). This one covers the rest of the tree, the part
 * none of them walks, so the word cannot drift back in through a new identifier,
 * file name or comment while the contracts are migrated one PR at a time.
 *
 * Every occurrence of the word is one of exactly three things, and
 * scripts/neutral-names.allow.json says which:
 *
 *   1. A CONTRACT: an exact name something outside this repository already holds
 *      (a database column, an environment variable, a browser-storage key, a tool
 *      name, a bin, an npm script, a Vercel project, a URL). Contracts move by an
 *      additive migration with the old name kept as an alias, never by a rename,
 *      so they are listed one by one, each with its kind and its plan. A listed
 *      contract that no longer occurs anywhere FAILS: the list only ever shrinks
 *      to match the tree.
 *   2. The bare WORD in a file whose text legitimately carries it: the default
 *      deployment profile's own vocabulary (translated per profile at the tool
 *      and UI boundary, so a relabelled deployment never shows it), the
 *      vocabulary machinery that translates or gates it, the history of earlier
 *      renames, and prose about the tooling still to move. Each such file has a
 *      CEILING, the exact count today. More fails (a new occurrence); fewer also
 *      fails, with the number to lower it to, so the ceiling follows every
 *      removal down and never leaves room for a new one.
 *   3. A path under an EXEMPT prefix, each with its reason (migration history
 *      that must never be rewritten, pinned before-images of old surfaces).
 *
 * Anything else fails: a new identifier (`fooFdeBar`, `FDE_NEW`), a new file or
 * directory named with the word, or the word in a file with no ceiling.
 *
 * Offline, no network, no build: it reads the tracked and untracked-but-not-ignored
 * files of a git checkout, or walks the directory when there is no git.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BASE_PRODUCT_WORD } from "./agent-cli.mjs";

const W = BASE_PRODUCT_WORD.toLowerCase();
const Cap = W[0].toUpperCase() + W.slice(1);
const UP = W.toUpperCase();

/**
 * One occurrence of the word as a word or an identifier part:
 *   - at a boundary (not preceded by a letter or digit): `fde_owner`, `FDE_OPS_URL`, `fde-login`, `fdeOwner`;
 *   - or as a camelCase part (`solutionFdeOwner`, `ownerFDE`); a regex escape (`\bFDE`) is a boundary;
 * optionally plural, and never followed by a lowercase letter or a digit. So `confdeltype`,
 * `wfDefs`, `RefDetail` and hex such as `3fde41` or `deadbeefdeadbeef` are not occurrences.
 */
const OCCURRENCE = new RegExp(`(?:(?:(?<![A-Za-z0-9])|(?<=\\\\[A-Za-z]))(?:${W}|${Cap}|${UP})|(?<=(?<!\\\\)[a-z])(?:${Cap}|${UP}))s?(?![a-z0-9])`, "g");
const BARE = new RegExp(`^(?:${W}|${Cap}|${UP})s?$`);
const IDENT = /[A-Za-z0-9_-]/;

/**
 * The whole name an occurrence sits in: extended over letters, digits, `_` and `-`, and over a
 * `:` joining two name parts (`fde:new-org`, an npm script). The bare word stays bare.
 */
export function occurrencesIn(text) {
  const out = [];
  const lines = String(text).split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(OCCURRENCE)) {
      let a = m.index;
      let b = m.index + m[0].length;
      // A regex escape (`\bFDE`) is a boundary, not a name part: stop before its letter.
      while (a > 0 && IDENT.test(line[a - 1]) && !(line[a - 2] === "\\" && /[A-Za-z]/.test(line[a - 1]))) a--;
      while (b < line.length && IDENT.test(line[b])) b++;
      // `fde:new-org` is one name (an npm script); `owner:…:project:fde-agent:…` is not, so only the bare word extends.
      if (BARE.test(line.slice(a, b)) && line[b] === ":" && /[a-z]/.test(line[b + 1] ?? "")) {
        b++;
        while (b < line.length && IDENT.test(line[b])) b++;
      }
      out.push({ line: i + 1, name: line.slice(a, b), bare: BARE.test(line.slice(a, b)) });
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

/** The allow-list, validated: a malformed table is an error, never an empty allowance. */
export function readAllowList(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const exempt = raw.exempt_paths ?? {};
  // `examples` follow the same rule as contracts (exact names, each must still occur); they are kept apart
  // because they are not held by anything outside: legacy prefixes named in prose, the vocabulary
  // machinery's own examples, and the offenders the gate tests construct.
  const contracts = { ...(raw.contracts ?? {}), ...(raw.examples ?? {}) };
  const ceilings = new Map();
  for (const [group, body] of Object.entries(raw.base_word ?? {})) {
    if (group.startsWith("$")) continue;
    if (typeof body?.why !== "string" || typeof body.files !== "object") throw new Error(`neutral-names: base_word["${group}"] needs a "why" and "files"`);
    for (const [file, count] of Object.entries(body.files)) {
      if (!Number.isInteger(count) || count < 1) throw new Error(`neutral-names: base_word["${group}"].files["${file}"] must be a positive integer`);
      if (ceilings.has(file)) throw new Error(`neutral-names: ${file} has a ceiling in two groups`);
      ceilings.set(file, { count, group });
    }
  }
  for (const [name, c] of Object.entries(contracts)) {
    if (name.startsWith("$")) continue;
    if (typeof c?.kind !== "string" || typeof c?.plan !== "string") throw new Error(`neutral-names: "${name}" needs a "kind" and a "plan"`);
  }
  for (const [prefix, why] of Object.entries(exempt)) {
    if (prefix.startsWith("$")) continue;
    if (typeof why !== "string" || !why) throw new Error(`neutral-names: exempt path "${prefix}" needs a reason`);
  }
  const prefixes = Object.keys(exempt).filter((k) => !k.startsWith("$"));
  const contractNames = new Set(Object.keys(contracts).filter((k) => !k.startsWith("$")));
  if (!contractNames.size) throw new Error("neutral-names: the contract list parsed as empty; refusing a blank allowance");
  return { prefixes, contractNames, ceilings };
}

/**
 * Check a tree against an allow-list. Returns { problems, seenContracts, baseCounts } —
 * `baseCounts` is the bare-word count per file, which `--report` prints.
 */
export function checkTree(root, allow) {
  const problems = [];
  const seen = new Set();
  const baseCounts = new Map();
  const exempt = (p) => allow.prefixes.some((x) => p === x || p.startsWith(x));
  for (const path of listFiles(root)) {
    if (exempt(path)) continue;
    // The path itself: a file or directory named with the word is a name somebody types.
    for (const hit of occurrencesIn(path.split("/").join("\n"))) {
      if (allow.contractNames.has(hit.name)) seen.add(hit.name);
      else problems.push(`${path}: the path carries "${hit.name}". Name the file after what it does; if something outside the repository already calls it this, it is a contract: list it in scripts/neutral-names.allow.json with its plan.`);
    }
    let text;
    try {
      const bytes = readFileSync(join(root, path));
      if (bytes.includes(0)) continue;
      text = bytes.toString("utf8");
    } catch {
      continue;
    }
    let bare = 0;
    const firstBare = [];
    for (const hit of occurrencesIn(text)) {
      if (allow.contractNames.has(hit.name)) {
        seen.add(hit.name);
        continue;
      }
      if (hit.bare) {
        bare++;
        if (firstBare.length < 3) firstBare.push(hit.line);
        continue;
      }
      problems.push(`${path}:${hit.line}: "${hit.name}" carries the base product's role word. Use a neutral name (member, owner, operator, workspace); if it is a contract something outside already holds, add it to "contracts" with its kind and migration plan.`);
    }
    if (bare) baseCounts.set(path, bare);
    const ceiling = allow.ceilings.get(path);
    if (bare && !ceiling) {
      problems.push(`${path}:${firstBare.join(",")}: the word "${UP}" (any case) appears ${bare} time(s) in a file with no ceiling. Write "member", "owner" or "operator"; the default profile's own words live in profiles/ and are translated per deployment.`);
    } else if (ceiling && bare > ceiling.count) {
      problems.push(`${path}: the word "${UP}" (any case) appears ${bare} times, over its ceiling of ${ceiling.count} ("${ceiling.group}"). A new occurrence is not allowed; use a neutral word.`);
    } else if (ceiling && bare < ceiling.count) {
      problems.push(`${path}: the word "${UP}" (any case) now appears ${bare} time(s), under its ceiling of ${ceiling.count}. Lower the ceiling in scripts/neutral-names.allow.json to ${bare}${bare ? "" : " (remove the entry)"} so the room cannot be reused.`);
    }
  }
  for (const [file] of allow.ceilings) {
    if (!baseCounts.has(file) && !problems.some((p) => p.startsWith(`${file}:`))) {
      problems.push(`${file}: has a ceiling but no occurrence (or no longer exists). Remove its entry from scripts/neutral-names.allow.json.`);
    }
  }
  for (const name of allow.contractNames) {
    if (!seen.has(name)) problems.push(`contract "${name}" no longer occurs anywhere. Remove it from scripts/neutral-names.allow.json: the list only ever shrinks to match the tree.`);
  }
  return { problems, seenContracts: seen, baseCounts };
}
