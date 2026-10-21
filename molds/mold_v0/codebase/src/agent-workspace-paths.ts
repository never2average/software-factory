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
