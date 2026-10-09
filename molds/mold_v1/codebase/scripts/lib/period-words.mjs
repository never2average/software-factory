/**
 * THE PERIOD-WORD RATCHET: base text never spells what a work period is called.
 *
 * What a period is called is the deployment profile's (`work_periods.label`, agent/lib/work-periods.ts): text the
 * model reads writes `{period}` / `{periods}`, text a person reads takes it from lib/work-periods-ui.ts. The base
 * product used to write its own word for it into components, tool descriptions, activity sentences and the coding
 * agent's tools, so a deployment whose people keep their own weekly targets read the base product's word everywhere.
 *
 * The word itself is read from profiles/00-default.json, so this file does not spell it either. Every occurrence in
 * the tree (any case, as a word or as part of an identifier) is one of four things, and
 * scripts/neutral-names.allow.json `period_words` says which:
 *
 *   default_profile    the default profile and the modules generated from it: the word's home;
 *   legacy_definition  ONE definition (the `cycles` table's own comment), with an exact count per file: more fails,
 *                      and fewer fails too, with the number to lower it to;
 *   contracts          an exact name something outside this repository already holds (a wire tool name a coding
 *                      agent's configuration calls, the view key in a link somebody shared, a workflow's name), each a
 *                      pattern with its reason, and optionally the only files it may appear in. A contract that no
 *                      longer occurs anywhere fails: the list only shrinks;
 *   exempt_paths       history and before-images that must never be rewritten, each with its reason.
 *
 * Anything else fails.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./neutral-names.mjs";

/** The default profile's words for a period, lower case: what the ratchet looks for. */
export function defaultPeriodWords(root) {
  const profile = JSON.parse(readFileSync(join(root, "profiles/00-default.json"), "utf8"));
  const label = profile.work_periods?.label;
  if (!label?.singular || !label?.plural) throw new Error("period-words: profiles/00-default.json has no work_periods.label");
  return [...new Set([label.singular, label.plural].map((w) => w.trim().toLowerCase()))].sort((a, b) => b.length - a.length);
}

export function readPeriodAllow(raw) {
  const p = raw.period_words;
  if (!p || typeof p !== "object") throw new Error('period-words: scripts/neutral-names.allow.json has no "period_words" section');
  const reasoned = (map, what) => {
    for (const [k, why] of Object.entries(map ?? {})) if (!k.startsWith("$") && (typeof why !== "string" || !why.trim())) throw new Error(`period-words: ${what} "${k}" needs a reason`);
    return Object.keys(map ?? {}).filter((k) => !k.startsWith("$"));
  };
  const contracts = [];
  for (const [i, c] of (p.contracts ?? []).entries()) {
    if (typeof c?.pattern !== "string" || typeof c?.why !== "string" || !c.why.trim()) throw new Error(`period-words: contracts[${i}] needs a "pattern" and a "why"`);
    if (c.files !== undefined && (!Array.isArray(c.files) || !c.files.length)) throw new Error(`period-words: contracts[${i}].files must be a non-empty list when given`);
    contracts.push({ pattern: c.pattern, re: new RegExp(c.pattern, "g"), files: c.files ?? null, seen: 0 });
  }
  const legacy = new Map();
  for (const [file, n] of Object.entries(p.legacy_definition?.files ?? {})) {
    if (!Number.isInteger(n) || n < 1) throw new Error(`period-words: legacy_definition.files["${file}"] must be a positive integer`);
    legacy.set(file, n);
  }
  if (legacy.size > 1) throw new Error("period-words: there is ONE legacy definition; legacy_definition.files lists more than one file");
  return { defaultProfile: reasoned(p.default_profile, "default_profile file"), exempt: reasoned(p.exempt_paths, "exempt path"), contracts, legacy };
}

/** Check a tree. Returns { problems, total }. */
export function checkPeriodWords(root, allow, words = defaultPeriodWords(root)) {
  // One occurrence: the word in lower, Capitalised or UPPER case, at a boundary (not after a letter) or as a camelCase
  // hump (`isLap`), and never followed by a lower-case letter. So `lapCount`, `next_lap` and `LAP_ID` are occurrences;
  // `overlap`, `laptop` and `collapse` are not. No `i` flag: the case of the neighbours is the rule.
  const capital = words.map((w) => w[0].toUpperCase() + w.slice(1));
  const anyCase = [...words, ...capital, ...words.map((w) => w.toUpperCase())].join("|");
  const occurrence = new RegExp(`(?<![A-Za-z])(?:${anyCase})(?![a-z])|(?<=[a-z0-9])(?:${capital.join("|")})(?![a-z])`, "g");
  const problems = [];
  let total = 0;
  const isExempt = (path) => allow.exempt.some((x) => path === x || path.startsWith(x));
  const legacySeen = new Map();
  for (const path of listFiles(root)) {
    if (isExempt(path) || allow.defaultProfile.includes(path)) continue;
    const inPath = path.match(occurrence);
    let text;
    try {
      const bytes = readFileSync(join(root, path));
      if (bytes.includes(0)) continue;
      text = bytes.toString("utf8");
    } catch {
      continue;
    }
    let loose = 0;
    const lines = [];
    // The path is checked like a line of the file: a file named with the word is a name somebody types.
    const rows = [...(inPath ? [[0, path]] : []), ...text.split("\n").map((line, i) => [i + 1, line])];
    for (const [no, line] of rows) {
      const hits = [...line.matchAll(occurrence)];
      if (!hits.length) continue;
      const covered = [];
      for (const c of allow.contracts) {
        if (c.files && !c.files.includes(path)) continue;
        for (const m of line.matchAll(c.re)) {
          covered.push([m.index, m.index + m[0].length]);
          c.seen++;
        }
      }
      for (const h of hits) {
        total++;
        if (covered.some(([a, b]) => h.index >= a && h.index + h[0].length <= b)) continue;
        loose++;
        if (lines.length < 4 && !lines.includes(no || "path")) lines.push(no || "path");
      }
    }
    if (!loose) continue;
    const ceiling = allow.legacy.get(path);
    if (ceiling === undefined) {
      problems.push(`${path}:${lines.join(",")}: the default profile's word for a work period ("${words.at(-1)}") is spelled ${loose} time(s). Base text never spells it: write {period} / {periods} for the model, take it from lib/work-periods-ui.ts (or W.period in lib/ui-words.ts) for a person. If it is a name something outside this repository already holds, list it under period_words.contracts in scripts/neutral-names.allow.json with its reason.`);
    } else {
      legacySeen.set(path, loose);
      if (loose > ceiling) problems.push(`${path}: the legacy definition spells the period word ${loose} times, over its count of ${ceiling}. A new occurrence is not allowed.`);
      else if (loose < ceiling) problems.push(`${path}: the legacy definition now spells the period word ${loose} time(s), under its count of ${ceiling}. Lower period_words.legacy_definition in scripts/neutral-names.allow.json to ${loose}.`);
    }
  }
  for (const [file] of allow.legacy) if (!legacySeen.has(file)) problems.push(`${file}: listed as the legacy definition but no longer spells the period word (or no longer exists). Remove it from period_words.legacy_definition.`);
  for (const c of allow.contracts) if (!c.seen) problems.push(`period_words contract /${c.pattern}/ no longer occurs anywhere${c.files ? ` in ${c.files.join(", ")}` : ""}. Remove it from scripts/neutral-names.allow.json: the list only ever shrinks to match the tree.`);
  return { problems, total };
}
