/**
 * The agent-workspace runner's path helpers (mold_v0-061), apart from its configuration schema
 * (src/agent-workspace-config.ts) so that the code a run sandbox loads (src/run-sandbox-runner.ts and what it imports,
 * mold_v0-055) needs nothing but node's own modules.
 */

/** "{name}" placeholders of a string. */
export const placeholders = (s: string) => [...s.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);

/** A glob (as `strip` and `record` take it) as a regular expression over relative paths. */
export function globRegex(g: string): RegExp {
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "/" && g.slice(i) === "/**") { out += "(?:/.*)?"; break; } // "dir/**": the directory and all under it
    if (c === "*" && g[i + 1] === "*") {
      i++;
      if (g[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

// ---------- git-ignore rules (mold_v0-182) ----------

/** One rule of a .gitignore file (or of a kind's write_back_ignore), relative to the directory `base` it applies under ("" the root). */
export interface IgnoreRule { base: string; re: RegExp; negate: boolean; dirOnly: boolean; source: string }

/** A gitignore pattern's body (after "!", the trailing "/" and the leading "/" are taken off) as a regular expression. */
function ignoreBody(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "\\" && i + 1 < p.length) { out += p[++i]!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"); continue; }
    if (c === "*" && p[i + 1] === "*") {
      const atStart = i === 0 || p[i - 1] === "/", atEnd = i + 2 === p.length, slashAfter = p[i + 2] === "/";
      if (atStart && slashAfter) { out += "(?:.*/)?"; i += 2; continue; } // "**/x" and "a/**/x": any directories, or none
      if (atStart && atEnd && i > 0) { out += ".*"; i += 1; continue; }   // "a/**": everything inside a
      out += "[^/]*"; i += 1; continue;                                   // any other "**" is a plain "*"
    }
    if (c === "*") { out += "[^/]*"; continue; }
    if (c === "?") { out += "[^/]"; continue; }
    if (c === "[") {
      const end = p.indexOf("]", i + 2);
      if (end > i) {
        let cls = p.slice(i + 1, end);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        out += `[${cls.replace(/\\/g, "\\\\").replace(/\//g, "")}]`;
        i = end; continue;
      }
    }
    out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return out;
}

/**
 * The rules of one .gitignore file (git's own syntax: "#" comments, "!" re-includes, a trailing "/" for directories
 * only, a pattern with a "/" anchored to the file's directory, else matched at any depth below it; "**", "*", "?", [..]).
 * `base` is the file's directory relative to the tree's root ("" for the root's own file).
 */
export function parseIgnore(text: string, base = "", source = ".gitignore"): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 5000)) {
    let line = raw;
    while (line.endsWith(" ") && !line.endsWith("\\ ")) line = line.slice(0, -1);
    if (!line || line.startsWith("#") || line.length > 1000) continue;
    let negate = false;
    if (line.startsWith("!")) { negate = true; line = line.slice(1); }
    else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    let dirOnly = false;
    while (line.endsWith("/")) { dirOnly = true; line = line.slice(0, -1); }
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    try { rules.push({ base, re: new RegExp(`^${anchored ? "" : "(?:.*/)?"}${ignoreBody(line)}$`), negate, dirOnly, source }); }
    catch { /* a pattern git would not make sense of either: left out */ }
  }
  return rules;
}

/**
 * Whether a path (relative, "/"-separated) is ignored by `rules`, as git decides it: the last rule that matches wins
 * (rules of a deeper file come later), and anything inside an ignored directory is ignored whatever a later "!" says.
 */
export function ignoreMatcher(rules: IgnoreRule[]): (rel: string, isDir: boolean) => boolean {
  if (!rules.length) return () => false;
  const own = (rel: string, isDir: boolean) => {
    let hit = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      let sub = rel;
      if (r.base) { if (!rel.startsWith(`${r.base}/`)) continue; sub = rel.slice(r.base.length + 1); }
      if (r.re.test(sub)) hit = !r.negate;
    }
    return hit;
  };
  const dirs = new Map<string, boolean>();
  const dirIgnored = (d: string): boolean => {
    const known = dirs.get(d);
    if (known !== undefined) return known;
    const i = d.lastIndexOf("/");
    const v = (i > 0 && dirIgnored(d.slice(0, i))) || own(d, true);
    dirs.set(d, v);
    return v;
  };
  return (rel, isDir) => {
    const i = rel.lastIndexOf("/");
    if (i > 0 && dirIgnored(rel.slice(0, i))) return true;
    return isDir ? dirIgnored(rel) : own(rel, false);
  };
}
