#!/usr/bin/env node
/**
 * FIRST-LOAD JAVASCRIPT HAS A BUDGET.
 *
 * Why this exists: opening the app downloaded 36 files, 4.7 MB of JavaScript (1.35 MB brotli), before the person
 * had done anything, because shiki, katex, mermaid, recharts, pdf.js, zod and every ops panel were imported at the
 * top of modules the chat page loads. Nothing measured it, so each import that pulled a library in looked free. The
 * libraries now load on first use; this keeps it that way. It reads what `next build` itself reports each page loads
 * first (.next/diagnostics/route-bundle-stats.json), weighs it raw and brotli-compressed, and fails when a page
 * grows past its baseline (scripts/bundle-budget.json): brotli by more than +5% or +20 KB, whichever is smaller (raw:
 * +5% or +80 KB), or by one more file. A baseline page the build no longer reports is a failure, not a skip.
 *
 * SIZE IS NOT ENOUGH. Putting motion back into the "Thinking…" shimmer costs +34 KB brotli, well inside a percentage
 * of 470 KB, and it is exactly the regression this exists to stop. So the check also knows WHICH modules are in each
 * first load: it builds once more with source maps into a separate directory (.next-budget, never the one CI and
 * deploys use, because maps carry source text), attributes every byte of the page's first-load chunks to the module
 * it came from, and fails if any module in FORBIDDEN is there (motion, @dnd-kit, zod, the renderers, the Ops panels,
 * the control panel, …), by identity, whatever its size. The same attribution names what grew on a size failure.
 *
 *   npm run check:bundle-budget                   check the build in .next/ (CI: right after `npm run build`); builds
 *                                                 .next-budget/ to check module identity
 *   npm run check:bundle-budget -- --explain      the same (kept for older instructions)
 *   npm run check:bundle-budget -- --update       write the current build as the new baseline (with modules)
 *   npm run check:bundle-budget -- --json         print the measurement as JSON
 *   npm run check:bundle-budget -- --no-explain   sizes only, no second build (skips the identity check; local use)
 *   npm run check:bundle-budget -- --dir <d>      a built checkout other than this one
 *   BUNDLE_BUDGET_KEEP=1 … --explain [--reuse]    keep .next-budget/ afterwards [attribute an existing one, no build]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const DIR = argAfter("--dir") ?? ROOT;
const UPDATE = process.argv.includes("--update");
const NO_EXPLAIN = process.argv.includes("--no-explain");
const JSON_OUT = process.argv.includes("--json");
const BASELINE_FILE = join(ROOT, "scripts/bundle-budget.json");
const EXPLAIN_DIST = ".next-budget";

/** The pages a person opens. The chat is the one that matters; the others keep their own budgets. */
const ROUTES = ["/", "/workspace", "/onboard"];
/** Growth allowed past the baseline: the SMALLER of the fraction and the bytes. The file count may not grow. */
const BROTLI_ALLOW = { fraction: 0.05, bytes: 20 * 1024 };
const RAW_ALLOW = { fraction: 0.05, bytes: 80 * 1024 };
const limit = (base, allow) => base + Math.min(base * allow.fraction, allow.bytes);

/**
 * Modules that must never be in a page's first load, by identity (module names as `moduleName` gives them). Each was
 * in the chat's first load once and each loads on first use now; the patterns name the package or file, so a
 * re-export or a sibling file of the same package counts too.
 */
export const FORBIDDEN = {
  common: [
    /^node_modules\/(motion|motion-dom|motion-utils|framer-motion)$/,
    /^node_modules\/zod$/,
    /^node_modules\/(katex|rehype-katex)$/,
    /^node_modules\/(mermaid|@mermaid-js\/.+|khroma|roughjs|dagre-d3-es|cytoscape.*)$/,
    /^node_modules\/(shiki|@shikijs\/.+|oniguruma-to-es|oniguruma-parser)$/,
    /^node_modules\/(recharts|victory-vendor|d3-.+)$/,
    /^node_modules\/(pdfjs-dist|xlsx|exceljs|docx-preview)$/,
    /^node_modules\/@streamdown\/(cjk|code|math|mermaid)$/,
    /^node_modules\/remark-cjk-friendly.*$/,
  ],
  "/": [
    /^node_modules\/@dnd-kit\/.+$/,
    /^app\/_components\/(cockpit|ops-center|dataroom|pdf-view)\.tsx$/,
    /^app\/_components\/ops\/(.+-panel|dashboard-charts|burndown|board|workflow-builder|run-graph)\.tsx$/,
  ],
};
const forbiddenFor = (route) => [...FORBIDDEN.common, ...(FORBIDDEN[route] ?? [])];
/** Below this, an attribution is a shared helper's crumb rather than the module. */
const IDENTITY_MIN_BYTES = 256;
const KB = (n) => `${(n / 1024).toFixed(1)} KB`;

const stripMapComment = (buf) => buf.toString("utf8").replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, "");

/** raw and brotli bytes of every first-load chunk of each route, from `distDir`. */
function measure(distDir) {
  const statsFile = join(DIR, distDir, "diagnostics/route-bundle-stats.json");
  if (!existsSync(statsFile)) throw new Error(`${statsFile} is missing: run \`npm run build\` first (Next 16 writes it on every build).`);
  const stats = JSON.parse(readFileSync(statsFile, "utf8"));
  const chunks = new Map();
  const routes = {};
  for (const r of stats) {
    if (!ROUTES.includes(r.route)) continue;
    let raw = 0;
    let brotli = 0;
    const files = [];
    for (const p of r.firstLoadChunkPaths) {
      const rel = p.replace(/^\.next[^/]*\//, "");
      if (!chunks.has(rel)) {
        const text = stripMapComment(readFileSync(join(DIR, distDir, rel)));
        chunks.set(rel, {
          raw: Buffer.byteLength(text),
          brotli: brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
        });
      }
      const c = chunks.get(rel);
      raw += c.raw;
      brotli += c.brotli;
      files.push({ file: rel, ...c });
    }
    routes[r.route] = { files: files.length, raw, brotli, chunks: files.sort((a, b) => b.raw - a.raw) };
  }
  return routes;
}

/* ------------------------------------------------------------------ attributing bytes to modules (source maps) */

const B64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));
/** Decode one line of VLQ `mappings` into segments of [genCol, srcIdx]. The source index is a running delta across
 *  the whole map (`state.src`); only the generated column restarts on each line. */
function* segments(line, state) {
  let genCol = 0;
  for (const seg of line.split(",")) {
    if (!seg) continue;
    const vals = [];
    let shift = 0;
    let value = 0;
    for (const ch of seg) {
      const d = B64.get(ch);
      value += (d & 31) << shift;
      if (d & 32) shift += 5;
      else {
        vals.push(value & 1 ? -(value >>> 1) : value >>> 1);
        shift = 0;
        value = 0;
      }
    }
    genCol += vals[0];
    if (vals.length > 1) state.src += vals[1];
    yield [genCol, vals.length > 1 ? state.src : null];
  }
}

/** A module's name as a person reads it: the npm package for anything under node_modules, else the repo path. */
export function moduleName(source) {
  const s = String(source ?? "")
    .replace(/^turbopack:\/\/\/?/, "")
    .replace(/^\[project\]\//, "")
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/\?.*$/, "");
  const nm = s.lastIndexOf("node_modules/");
  if (nm >= 0) {
    const rest = s.slice(nm + "node_modules/".length).split("/");
    return `node_modules/${rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]}`;
  }
  return s.replace(/^\.\//, "") || "(unmapped)";
}

/** bytes per module in one chunk, from its (possibly sectioned) source map. */
function attribute(code, map, into) {
  const lines = code.split("\n");
  const add = (name, n) => into.set(name, (into.get(name) ?? 0) + n);
  const walk = (m, line0, col0, endLine, endCol) => {
    if (m.sections) {
      m.sections.forEach((s, i) => {
        const next = m.sections[i + 1]?.offset;
        walk(s.map, line0 + s.offset.line, (s.offset.line === 0 ? col0 : 0) + s.offset.column, next ? line0 + next.line : endLine, next ? next.column : endCol);
      });
      return;
    }
    const mlines = String(m.mappings ?? "").split(";");
    const state = { src: 0 };
    for (let li = 0; li < mlines.length; li++) {
      const gl = line0 + li;
      if (gl >= lines.length || gl > endLine) break;
      const text = lines[gl];
      const base = li === 0 ? col0 : 0;
      const segs = [...segments(mlines[li], state)];
      for (let si = 0; si < segs.length; si++) {
        const start = base + segs[si][0];
        let end = si + 1 < segs.length ? base + segs[si + 1][0] : text.length;
        if (gl === endLine && endCol != null) end = Math.min(end, endCol);
        if (end <= start) continue;
        add(segs[si][1] == null ? "(unmapped)" : moduleName(m.sources?.[segs[si][1]]), end - start);
      }
    }
  };
  walk(map, 0, 0, Number.POSITIVE_INFINITY, null);
}

/** Build with source maps into .next-budget (only when explaining) and attribute each route's first load. */
function explain() {
  // The source-mapped build must land in .next-budget/, which only a next.config that honours BUNDLE_BUDGET_DIST does;
  // anything else would build over the checkout's own .next/.
  const reusing = process.argv.includes("--reuse") && existsSync(join(DIR, EXPLAIN_DIST, "diagnostics/route-bundle-stats.json"));
  if (!reusing && !/bundleBudgetDist\(/.test(readFileSync(join(DIR, "next.config.ts"), "utf8"))) {
    throw new Error(`${DIR}/next.config.ts does not honour BUNDLE_BUDGET_DIST, so a second build would overwrite its .next/`);
  }
  // `next build` points tsconfig's include and next-env.d.ts at its dist dir's types; this build is a measurement,
  // not a change, so both are put back.
  const touched = ["tsconfig.json", "next-env.d.ts"].map((f) => join(DIR, f)).filter((f) => existsSync(f));
  const before = touched.map((f) => readFileSync(f, "utf8"));
  const reuse = process.argv.includes("--reuse") && existsSync(join(DIR, EXPLAIN_DIST, "diagnostics/route-bundle-stats.json"));
  if (!reuse) console.log(`bundle budget: building with source maps into ${EXPLAIN_DIST}/ to name the modules …`);
  const r = reuse ? { status: 0 } : spawnSync(process.execPath, [join(DIR, "node_modules/next/dist/bin/next"), "build"], {
    cwd: DIR,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, BUNDLE_BUDGET_DIST: EXPLAIN_DIST, NEXT_TELEMETRY_DISABLED: "1" },
  });
  touched.forEach((f, i) => readFileSync(f, "utf8") !== before[i] && writeFileSync(f, before[i]));
  if (r.status !== 0) throw new Error("the source-map build failed");
  const routes = measure(EXPLAIN_DIST);
  for (const [route, m] of Object.entries(routes)) {
    const mods = new Map();
    for (const c of m.chunks) {
      const file = join(DIR, EXPLAIN_DIST, c.file);
      const text = readFileSync(file, "utf8");
      // Turbopack names a chunk's map by the map's own hash; the chunk says which it is.
      const url = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(text)?.[1];
      const mapFile = url ? join(dirname(file), url) : `${file}.map`;
      if (!existsSync(mapFile)) { mods.set("(no source map)", (mods.get("(no source map)") ?? 0) + c.raw); continue; }
      attribute(stripMapComment(Buffer.from(text)), JSON.parse(readFileSync(mapFile, "utf8")), mods);
    }
    m.modules = Object.fromEntries([...mods].sort((a, b) => b[1] - a[1]));
  }
  if (!process.env.BUNDLE_BUDGET_KEEP) rmSync(join(DIR, EXPLAIN_DIST), { recursive: true, force: true });
  return routes;
}

/* ------------------------------------------------------------------------------------------------- the check */

const current = measure(".next");
const baseline = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, "utf8")) : null;

const failures = [];
if (baseline && !UPDATE) {
  for (const [route, base] of Object.entries(baseline.routes)) {
    const now = current[route];
    if (!now) {
      failures.push(`${route}: the build reports no first load for this page (renamed or removed? update the baseline)`);
      continue;
    }
    if (now.raw > limit(base.raw, RAW_ALLOW)) failures.push(`${route}: first-load JS is ${KB(now.raw)}, over its budget of ${KB(limit(base.raw, RAW_ALLOW))} (${KB(base.raw)} + 5% or 80 KB, whichever is smaller)`);
    if (now.brotli > limit(base.brotli, BROTLI_ALLOW)) failures.push(`${route}: first-load JS is ${KB(now.brotli)} brotli, over its budget of ${KB(limit(base.brotli, BROTLI_ALLOW))} (${KB(base.brotli)} + 5% or 20 KB, whichever is smaller)`);
    if (now.files > base.files) failures.push(`${route}: first load fetches ${now.files} files, more than its ${base.files}`);
  }
}

let explained = null;
if (!NO_EXPLAIN) {
  try {
    explained = explain();
  } catch (e) {
    // Without the attribution the identity check cannot run: that is a failure, not a pass.
    failures.push(`could not attribute modules (${e.message})`);
  }
}
const forbiddenFound = [];
for (const [route, m] of Object.entries(explained ?? {})) {
  for (const [name, n] of Object.entries(m.modules ?? {})) {
    if (n >= IDENTITY_MIN_BYTES && forbiddenFor(route).some((re) => re.test(name))) forbiddenFound.push(`${route}: ${name} (${KB(n)}) is in the first load and must load on first use`);
  }
}
failures.push(...forbiddenFound);

if (JSON_OUT) {
  const out = Object.fromEntries(Object.entries(explained ?? current).map(([r, m]) => [r, { ...m, raw: current[r].raw, brotli: current[r].brotli, files: current[r].files }]));
  console.log(JSON.stringify(out, null, 2));
}

for (const [route, m] of Object.entries(current)) {
  const base = baseline?.routes?.[route];
  const delta = base ? ` (baseline ${KB(base.raw)} / ${KB(base.brotli)} brotli / ${base.files} files)` : "";
  if (!JSON_OUT) console.log(`${route}: ${m.files} files, ${KB(m.raw)} raw, ${KB(m.brotli)} brotli${delta}`);
}

if (UPDATE) {
  const routes = Object.fromEntries(
    Object.entries(current).map(([r, m]) => [
      r,
      {
        files: m.files,
        raw: m.raw,
        brotli: m.brotli,
        // The modules that make up the first load, so a failure can say what is NEW. Tiny ones are noise.
        modules: Object.fromEntries(Object.entries(explained?.[r]?.modules ?? {}).filter(([, n]) => n >= 512)),
      },
    ]),
  );
  if (forbiddenFound.length) {
    console.error(`bundle budget: refusing to write a baseline with forbidden modules in a first load:\n  ${forbiddenFound.join("\n  ")}`);
    process.exit(1);
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ $comment: "Written by `npm run check:bundle-budget -- --update` after a deliberate change; see scripts/check-bundle-budget.mjs.", routes }, null, 2)}\n`);
  console.log(`bundle budget: baseline written to scripts/bundle-budget.json`);
  process.exit(0);
}

if (failures.length) {
  console.error("\nFIRST-LOAD JAVASCRIPT FAILED ITS BUDGET");
  for (const f of failures) console.error(`  - ${f}`);
  for (const route of new Set(failures.map((f) => f.split(":")[0]).filter((r) => r in (baseline?.routes ?? {}) && current[r]))) {
    const base = baseline.routes[route];
    const now = explained?.[route]?.modules;
    if (now) {
      const grown = Object.entries(now)
        .map(([name, n]) => [name, n - (base.modules?.[name] ?? 0), !(name in (base.modules ?? {}))])
        .filter(([, d]) => d >= 1024)
        .sort((a, b) => b[1] - a[1]);
      if (grown.length) console.error(`  ${route}: heaviest new module: ${grown[0][0]} (+${KB(grown[0][1])}${grown[0][2] ? ", not in the baseline" : ""})`);
      for (const [name, d, isNew] of grown.slice(0, 8)) console.error(`      ${isNew ? "new  " : "grew "} +${KB(d).padStart(9)}  ${name}`);
    } else {
      console.error(`  ${route}: heaviest chunks: ${current[route].chunks.slice(0, 3).map((c) => `${c.file} ${KB(c.raw)}`).join(", ")}`);
    }
  }
  console.error(
    "\nLoad it where it is used (next/dynamic, or `await import()` on first use), or, if the growth is deliberate,\n" +
      "`npm run build && npm run check:bundle-budget -- --update` and say why in the pull request.",
  );
  process.exit(1);
}
if (!baseline) console.log("bundle budget: no baseline yet; run with --update to write one.");
else console.log("bundle budget: within budget.");
