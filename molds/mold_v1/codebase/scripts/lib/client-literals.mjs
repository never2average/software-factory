/**
 * Every string a built client bundle carries, with the SOURCE FILE it came from.
 *
 * Reads `.next/static/**\/*.js` and its `.js.map` (a build with `productionBrowserSourceMaps: true`), parses each
 * chunk with acorn, and maps every string literal and template-literal chunk back through the source map to the
 * file that wrote it. Turbopack names sources `turbopack:///[project]/<path>`; `<path>` is returned relative to the
 * project (`app/_components/cockpit.tsx`, `node_modules/…`). A literal with no mapping is reported with source null.
 *
 *   clientLiterals(nextDir) -> [{ value, source, chunk }]
 *
 * Plain node, no dependency beyond acorn (already a dependency of the app).
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const B64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));

/** Decode a v3 `mappings` string into per-generated-line sorted segments [col, srcIndex]. */
function decodeMappings(mappings) {
  const lines = [];
  let src = 0, srcLine = 0, srcCol = 0, name = 0;
  for (const line of mappings.split(";")) {
    const segs = [];
    let col = 0;
    for (const seg of line.split(",")) {
      if (!seg) continue;
      const vals = [];
      let value = 0, shift = 0;
      for (const ch of seg) {
        const d = B64.get(ch);
        value += (d & 31) << shift;
        if (d & 32) shift += 5;
        else { vals.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
      }
      col += vals[0];
      if (vals.length >= 4) { src += vals[1]; srcLine += vals[2]; srcCol += vals[3]; if (vals.length >= 5) name += vals[4]; segs.push([col, src]); }
      else segs.push([col, -1]);
    }
    lines.push(segs);
  }
  return lines;
}

/** A lookup (line0, col0) -> source path for a map, flat or indexed (`sections`). */
function mapLookup(map) {
  const flat = (m) => {
    const lines = decodeMappings(m.mappings ?? "");
    const sources = (m.sources ?? []).map((s) => s.replace(/^turbopack:\/\/\/\[project\]\//, "").replace(/^webpack:\/\/[^/]*\//, "").replace(/^\.\//, ""));
    return (line, col) => {
      const segs = lines[line];
      if (!segs) return null;
      let best = null;
      for (const s of segs) { if (s[0] <= col) best = s; else break; }
      return best && best[1] >= 0 ? sources[best[1]] : null;
    };
  };
  if (!Array.isArray(map.sections)) return flat(map);
  const sections = map.sections.map((s) => ({ line: s.offset.line, col: s.offset.column, look: flat(s.map) }));
  return (line, col) => {
    let sec = null;
    for (const s of sections) { if (s.line < line || (s.line === line && s.col <= col)) sec = s; else break; }
    if (!sec) return null;
    return sec.look(line - sec.line, line === sec.line ? col - sec.col : col);
  };
}

function walkFiles(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else if (n.endsWith(".js")) out.push(p);
  }
  return out;
}

export function clientLiterals(dir) {
  const projectDir = resolve(dir);
  const require = createRequire(join(projectDir, "package.json"));
  const acorn = require("acorn");
  const staticDir = join(projectDir, ".next", "static");
  const out = [];
  for (const file of walkFiles(staticDir)) {
    const code = readFileSync(file, "utf8");
    let ast;
    for (const sourceType of ["module", "script"]) {
      try { ast = acorn.parse(code, { ecmaVersion: "latest", sourceType, locations: true, allowHashBang: true }); break; } catch { ast = null; }
    }
    if (!ast) throw new Error(`client-literals: cannot parse ${relative(projectDir, file)}`);
    // The map is named by the chunk's `//# sourceMappingURL=` comment (Turbopack does not name it <chunk>.js.map).
    const url = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code)?.[1];
    const mapFile = url && !url.startsWith("data:") ? join(dirname(file), url) : `${file}.map`;
    const look = existsSync(mapFile) ? mapLookup(JSON.parse(readFileSync(mapFile, "utf8"))) : () => null;
    const chunk = relative(projectDir, file);
    const visit = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) { for (const x of n) visit(x); return; }
      let value = null;
      if (n.type === "Literal" && typeof n.value === "string") value = n.value;
      else if (n.type === "TemplateElement") value = n.value.cooked ?? n.value.raw;
      if (value) out.push({ value, source: look(n.loc.start.line - 1, n.loc.start.column), chunk });
      for (const k in n) if (k !== "loc" && k !== "start" && k !== "end") { const v = n[k]; if (v && typeof v === "object") visit(v); }
    };
    visit(ast);
  }
  return out;
}
