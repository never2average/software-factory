/**
 * THE STORED-FOLDER RATCHET: no data-room folder name in base code.
 *
 * The data room's folders are stored under names the DEPLOYMENT PROFILE gives (profiles/*.json
 * `dataroom.domains.<id>.folder`, `dataroom.uploads_folder`; agent/lib/dataroom-folders.ts). Base code builds a path
 * as `${FOLDER.accounts}/…` and base text writes `{folder:accounts}/…`; neither spells a name. That is what lets a
 * new deployment store under the default profile's neutral names while a deployment that already holds files pins
 * the names it has and moves nothing.
 *
 * A name written into the code breaks that silently: the default deployment passes every test and a pinned one
 * reads from a folder it never wrote to. So this counts, in every scanned file:
 *
 *   - a PATH HEAD: a folder name followed by `/` (`<Name>/acme/context.md`, `orgs/x/<Name>/…`), anywhere in the file,
 *     comments included (a comment that spells a path teaches the next edit to do the same);
 *   - an EXACT VALUE: a string literal, or a JSON string value, that is exactly a folder name (`"<Name>"`), which is
 *     how a name is handed to a list call, a switch, a sheet or an enum. Read only in the code that runs or ships
 *     (`values_in`): in a test, a string that is exactly one of these words is almost always the WORD (a record
 *     area's label, a heading), and the path heads beside it are what a test must not hardcode.
 *
 * The names are never written here either. They are read from the two places that may spell them: the names the
 * folders had while they were in the code (scripts/lib/legacy-dataroom-folders.json) and the default profile's
 * (profiles/00-default.json). A file may carry one only under a ceiling in scripts/neutral-names.allow.json
 * (`stored_folders`), in a group that says why; more fails, fewer fails too with the number to lower it to, and a
 * ceiling on a file that carries none fails.
 *
 * Offline, no build. Source files are parsed with the TypeScript compiler (parse only).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./neutral-names.mjs";
import { jsonTexts, sourceTexts } from "./record-words.mjs";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every stored folder name base code could spell: the former names and the default profile's, each once. */
export function storedFolderNames(root) {
  const legacy = JSON.parse(readFileSync(join(root, "scripts/lib/legacy-dataroom-folders.json"), "utf8"));
  const room = JSON.parse(readFileSync(join(root, "profiles/00-default.json"), "utf8")).dataroom;
  const names = new Set();
  for (const [k, v] of Object.entries(legacy)) if (!k.startsWith("$") && typeof v === "string") names.add(v);
  for (const d of Object.values(room.domains ?? {})) if (typeof d?.folder === "string") names.add(d.folder);
  if (typeof room.uploads_folder === "string") names.add(room.uploads_folder);
  return [...names].sort();
}

/**
 * The folder names spelled in one file: path heads anywhere in its text, and exact values among its string literals
 * (a source file) or its string values (a JSON file). `[{ kind, name, line, text }]`.
 */
export function storedFoldersInFile(path, source, names, { values = true } = {}) {
  const out = [];
  if (!names.length) return out;
  const alt = names.map(escapeRegExp).join("|");
  // Not inside a longer word, an identifier, a placeholder or an interpolation; a `/` before it is a longer path.
  const head = new RegExp(`(?<![A-Za-z0-9_.\\-{:$])(${alt})(?=/)`, "g");
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= index) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const textOf = (line) => source.slice(lineStarts[line - 1], lineStarts[line] === undefined ? undefined : lineStarts[line] - 1).trim().slice(0, 160);
  for (const m of source.matchAll(head)) {
    const line = lineOf(m.index);
    out.push({ kind: "path", name: m[1], line, text: textOf(line) });
  }
  const exact = new Set(values ? names : []);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) {
    for (const t of sourceTexts(path, source)) if (exact.has(t.text)) out.push({ kind: "value", name: t.text, line: t.line, text: textOf(t.line) });
  } else if (/\.json$/.test(path)) {
    for (const t of jsonTexts(source)) if (exact.has(t.text)) out.push({ kind: "value", name: t.text, line: 0, at: t.path, text: `${t.path}: "${t.text}"` });
  }
  return out;
}

const globToRegExp = (glob) =>
  new RegExp(
    "^" +
      glob
        .split(/(\*\*\/|\*\*|\*)/)
        .map((p) => (p === "**/" ? "(?:.*/)?" : p === "**" ? ".*" : p === "*" ? "[^/]*" : p.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$",
  );

/** The `stored_folders` section of the allow-list, validated. */
export function readFolderAllow(raw) {
  const r = raw.stored_folders;
  if (!r || typeof r !== "object") throw new Error('neutral-names: the allow-list has no "stored_folders" section');
  const list = (key) => {
    const body = r[key];
    if (!body || typeof body !== "object") throw new Error(`neutral-names: stored_folders.${key} is missing`);
    const entries = Object.entries(body).filter(([k]) => !k.startsWith("$"));
    for (const [k, why] of entries) if (typeof why !== "string" || !why.trim()) throw new Error(`neutral-names: stored_folders.${key}["${k}"] needs a reason`);
    return entries.map(([k]) => k);
  };
  const scan = list("scan");
  const skip = list("skip");
  const valuesIn = list("values_in");
  if (!scan.length) throw new Error("neutral-names: stored_folders.scan parsed as empty; refusing to check nothing");
  if (!valuesIn.length) throw new Error("neutral-names: stored_folders.values_in parsed as empty; refusing to check nothing");
  const ceilings = new Map();
  for (const [group, body] of Object.entries(r.ceilings ?? {})) {
    if (group.startsWith("$")) continue;
    if (typeof body?.why !== "string" || !body.why.trim() || typeof body.files !== "object") throw new Error(`neutral-names: stored_folders.ceilings["${group}"] needs a "why" and "files"`);
    for (const [file, count] of Object.entries(body.files)) {
      if (!Number.isInteger(count) || count < 1) throw new Error(`neutral-names: stored_folders.ceilings["${group}"].files["${file}"] must be a positive integer`);
      if (ceilings.has(file)) throw new Error(`neutral-names: ${file} has a stored-folder ceiling in two groups`);
      ceilings.set(file, { count, group });
    }
  }
  return { scan: scan.map(globToRegExp), skip: skip.map(globToRegExp), valuesIn: valuesIn.map(globToRegExp), ceilings };
}

/** Walk the tree: the folder names spelled per scanned file, and every way the allow-list is out of step. */
export function checkStoredFolders(root, allow, names = storedFolderNames(root)) {
  const problems = [];
  const counts = new Map();
  const hits = new Map();
  const any = new RegExp(names.map(escapeRegExp).join("|"));
  for (const path of listFiles(root)) {
    if (!allow.scan.some((re) => re.test(path)) || allow.skip.some((re) => re.test(path))) continue;
    let source;
    try {
      const bytes = readFileSync(join(root, path));
      if (bytes.includes(0)) continue;
      source = bytes.toString("utf8");
    } catch {
      continue;
    }
    if (!any.test(source)) continue;
    let found;
    try {
      found = storedFoldersInFile(path, source, names, { values: allow.valuesIn.some((re) => re.test(path)) });
    } catch (error) {
      problems.push(`${path}: could not be read for stored folder names (${error instanceof Error ? error.message : error})`);
      continue;
    }
    if (!found.length) continue;
    counts.set(path, found.length);
    hits.set(path, found);
    const ceiling = allow.ceilings.get(path);
    const fix = "Build a path from FOLDER.<id> (agent/lib/dataroom-folders.ts), or write the placeholder {folder:<id>} / {domain:<id>} in text; the name is the deployment profile's.";
    if (!ceiling) {
      const first = found.slice(0, 4).map((h) => `${h.line || h.at}: ${h.kind === "path" ? `"${h.name}/"` : `"${h.name}"`} in "${h.text.slice(0, 90)}"`).join("; ");
      problems.push(`${path}: ${found.length} stored folder name(s) spelled in a file with no ceiling (${first}). ${fix}`);
    } else if (found.length > ceiling.count) {
      problems.push(`${path}: ${found.length} stored folder name(s) spelled, over its ceiling of ${ceiling.count} (lines ${found.map((h) => h.line || h.at).join(",")}). ${fix}`);
    } else if (found.length < ceiling.count) {
      problems.push(`${path}: ${found.length} stored folder name(s) spelled, under its ceiling of ${ceiling.count}: lower stored_folders.ceilings["${ceiling.group}"].files["${path}"] to ${found.length}`);
    }
  }
  for (const [file, { group }] of allow.ceilings) {
    if (!counts.has(file)) problems.push(`${file}: has a stored-folder ceiling but spells none now: remove it from stored_folders.ceilings["${group}"].files`);
  }
  return { problems, counts, hits };
}
