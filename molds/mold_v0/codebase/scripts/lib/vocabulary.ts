// The shell's vocabulary check and its env-name alias table (mold_v0-045): scripts/check-vocabulary.ts runs them,
// scripts/vocabulary-test.ts proves them on planted trees. Rules: scripts/vocabulary.json.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface AllowEntry { id: string; pattern: string; paths: string[]; why: string }
export interface Vocabulary { words: string[]; files: Record<string, string>; allow: AllowEntry[] }
export interface Finding { file: string; line: number; text: string }
export interface Report { findings: Finding[]; unused: string[]; scanned: number }

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vercel", "dist", ".transcripts", ".turbo"]);
const BINARY = /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|wasm|mp4|mov|lockb)$/i;

/** A glob over relative paths: `*` within one segment, `**` across segments. */
export function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const matches = (globs: string[], rel: string) => globs.some((g) => globRe(g).test(rel));

/** Whether the tree is a build with packs (a pack directory with a pack.json): its generated files are then the packs'. */
export const hasPacks = (root: string) =>
  existsSync(path.join(root, "packs")) && readdirSync(path.join(root, "packs"), { withFileTypes: true }).some((e) => e.isDirectory() && existsSync(path.join(root, "packs", e.name, "pack.json")));

/** Files a pack owns, and in a build with packs the files generated from them and from the app's own state. */
function packOwned(rel: string, packed: boolean): boolean {
  if (/^packs\/[^/]+\//.test(rel) || /^web\/src\/packs\/[^/]+\//.test(rel) || /^orchestrator\/packs\/[^/]+\//.test(rel)) return true;
  if (!packed) return false;
  return /\.generated\.[a-z]+$/.test(rel) || ["profile.json", "deploy-facts.json", "DATA-MAP.md", "web/src/app/opengraph-image.alt.txt"].includes(rel);
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory() && (SKIP_DIRS.has(e.name) || e.name.startsWith(".pglite"))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

/** Every product word in the tree that no allow entry covers, and the entries that cover nothing. */
export function checkVocabulary(root: string, v: Vocabulary): Report {
  const word = new RegExp(v.words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  const allow = v.allow.map((a) => ({ ...a, re: new RegExp(a.pattern, "g"), used: 0 }));
  const wholeFiles = Object.keys(v.files);
  const usedFiles = new Set<string>();
  const findings: Finding[] = [];
  const packed = hasPacks(root);
  let scanned = 0;
  for (const rel of listFiles(root)) {
    if (packOwned(rel, packed) || rel === "scripts/vocabulary.json" || rel.endsWith(".tsbuildinfo")) continue; // the rules themselves; a compiler cache
    const whole = wholeFiles.find((g) => globRe(g).test(rel));
    if (whole) { usedFiles.add(whole); continue; }
    if (word.test(rel)) findings.push({ file: rel, line: 0, text: "(its path)" });
    word.lastIndex = 0;
    if (BINARY.test(rel) || statSync(path.join(root, rel)).size > 8_000_000) continue;
    const buf = readFileSync(path.join(root, rel));
    if (buf.includes(0)) continue;
    scanned++;
    const lines = buf.toString("utf8").split("\n");
    const here = allow.filter((a) => matches(a.paths, rel));
    lines.forEach((line, i) => {
      word.lastIndex = 0;
      if (!word.test(line)) return;
      word.lastIndex = 0; // matchAll starts where the test left off
      const spans = here.flatMap((a) => [...line.matchAll(a.re)].map((m) => ({ a, from: m.index!, to: m.index! + m[0].length })));
      for (const m of line.matchAll(word)) {
        const at = m.index!, end = at + m[0].length;
        const cover = spans.find((s) => s.from <= at && end <= s.to);
        if (cover) cover.a.used++;
        else findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160) });
      }
    });
  }
  const unused = [...allow.filter((a) => a.used === 0).map((a) => `allow ${a.id}`), ...wholeFiles.filter((g) => !usedFiles.has(g)).map((g) => `files ${g}`)];
  return { findings, unused, scanned };
}

// ---------- the env names' alias table (MOLD.md) ----------

/** Where the shell names its environment variables: code, deploy files, the env example (not prose). */
const ENV_SOURCES = [/^src\//, /^api\//, /^scripts\//, /^orchestrator\//, /^web\/src\//, /^web\/[^/]+\.(ts|mjs|js)$/, /^web\/Dockerfile$/, /^deploy\//, /^Dockerfile$/,
  /^docker-compose[^/]*\.ya?ml$/, /^\.env\.example$/, /^package\.json$/];

/** Every APP_ name the shell's code and deploy files use (a name ending in _ is a family: APP_LIMIT_ENDPOINTS_*). */
export function shellEnvNames(root: string): string[] {
  const packed = hasPacks(root);
  const names = new Set<string>();
  for (const rel of listFiles(root)) {
    if (packOwned(rel, packed) || !ENV_SOURCES.some((r) => r.test(rel)) || BINARY.test(rel) || /\.(md|txt)$/.test(rel) || rel.endsWith(".generated.json")) continue;
    if (["scripts/vocabulary-test.ts", "scripts/env-names-test.ts"].includes(rel) || rel.startsWith("orchestrator/workspaces/")) continue; // the tests' planted names; starter projects (not the shell's)
    if (!/(\.(ts|tsx|mts|mjs|js|sh|ya?ml|json|example)|Dockerfile[^/]*)$/.test(rel)) continue;
    const text = readFileSync(path.join(root, rel), "utf8");
    for (const m of text.matchAll(/(?<![A-Za-z0-9_])APP_[A-Z][A-Z0-9_]*/g)) if (m[0] !== "APP_X") names.add(m[0].endsWith("__") ? m[0].replace(/_+$/, "_") : m[0]); // APP_X: the docs' placeholder
  }
  return [...names].sort();
}

export const TABLE_BEGIN = "<!-- env-names:begin (generated by `npm run check:vocabulary -- --write` in the codebase; do not edit) -->";
export const TABLE_END = "<!-- env-names:end -->";

/** The alias table: each new name and the old one still read as its fallback. */
export function aliasTable(names: string[], legacyPrefix: string, prefix: string): string {
  const rows = names.map((n) => {
    const fam = n.endsWith("_") ? "*" : "";
    return `| \`${legacyPrefix}${n.slice(prefix.length)}${fam}\` | \`${n}${fam}\` |`;
  });
  return [TABLE_BEGIN, "", `${names.length} names. The old name is read only when the new one is unset (src/env-names.ts); a family (\`*\`) is every name with that start.`, "",
    "| Old name (still read) | Name |", "|---|---|", ...rows, "", TABLE_END].join("\n");
}

/** MOLD.md's text with its table replaced (null when it has no markers). */
export function withTable(md: string, table: string): string | null {
  const a = md.indexOf(TABLE_BEGIN), b = md.indexOf(TABLE_END);
  if (a < 0 || b < a) return null;
  return md.slice(0, a) + table + md.slice(b + TABLE_END.length);
}
