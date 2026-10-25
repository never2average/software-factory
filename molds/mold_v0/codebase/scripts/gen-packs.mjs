#!/usr/bin/env node
// The pack registry generator (mold_v0-038; molds/mold_v0/MOLD.md "Pack and record-area contract"). Reads every
// packs/<id>/pack.json in this build copy and profile.json, checks them, and writes what the server and the console
// import, so nothing in the shell names a pack:
//
//   src/packs.generated.ts               each pack's manifest and its entry module (definePack), in pack order
//   src/pack-migrations.generated.ts     the ordered list of pack migration directories (no pack code imported)
//   src/run-tools.generated.json         the run tools the packs' agent kinds need (mold_v0-072), installed in the runner image
//   src/profile.generated.ts             the profile: product name, MCP server name, console title, email sender
//   src/email-pitch.generated.ts         the landing block's hero subheadline, the welcome email's pitch (mold_v0-101)
//   src/legal.generated.ts               profile.json `legal` (mold_v0-109, src/legal.ts), checked; null without one
//   web/src/config/legal.generated.ts    the same, for the console's /terms, /privacy, footers and sitemap
//   src/access-request.generated.ts      the access-request form's own fields (mold_v0-102, src/access-request.ts): the
//                                        packs' pack.json access_request, or the app's profile.json one; [] without
//   web/src/config/access-request.generated.ts  the same, for the request form and the staff console's Requests page
//   web/src/lib/access-request.generated.ts     a copy of src/access-request.ts, so the console runs the server's rules
//   web/src/config/pack-nav.generated.ts the packs' console pages and their sidebar entries (/app and /admin), and the
//                                        record areas they declare (mold_v0-047) with their list pages' sidebar entries
//   web/src/config/profile.generated.ts  the profile, for the console
//   src/hosts.generated.ts               the host packs' server entries (mold_v0-039; src/host.ts), imported by src/hosts.ts,
//                                        and their pack.json engine.config (mold_v0-137) when one declares it
//   web/src/config/pack-web.generated.ts the host packs' console code (web/src/packs/<id>/index.ts)
//   web/src/config/pack-guides.generated.ts  the customer guide: a host pack's guide code, else the packs' own guide pages
//                                        (pack.json guide) and the facts its generated pages are written from (mold_v0-106)
//   orchestrator/packs.generated.ts      the host packs' orchestrator entries (orchestrator/packs/<id>/main.ts)
//   src/deploy-facts.generated.ts        the deploy facts the factory wrote into this build copy (deploy-facts.json at the
//                                        codebase root, mold_v0-050): names, places and providers, never a value; null
//                                        without the file. Read by src/data-map.ts (DATA-MAP.md)
//
// Host packs (mold_v0-039): a pack whose pack.json has `host` (an entry with defineHost, src/host.ts) is the product's
// own surface: tools, routes and hooks at the shell's fixed points, console pages (web/src/packs/<id>/), an orchestrator
// extension (orchestrator/packs/<id>/) and operator scripts (`host.scripts`). Only a pack the build's profile.json lists
// in `host_packs` may be one. Its server code may import its own files, src/pack-api.ts and src/pack-host.ts (the shell
// services it may use) and the server's packages, nothing else of the shell; its console code its own files, the
// console's shared code (@/components, @/lib, @/hooks, @/types, @/config, @/features) and the console's packages; its
// orchestrator code its own files and the orchestrator's (never src/); its scripts anything (they are never loaded by
// the server: server code may not import them).
//
// It refuses (exit 1, every problem listed) a pack whose files would get past the seam:
//   - pack.json: unknown fields, an id that is not the directory's, a missing entry, badly named or numbered migrations
//   - code: the pack has two kinds (mold_v0-054), told apart by pack.json `runner`, a directory inside the pack:
//       server code  (everything outside `runner`: the entry, its tools and routes, loaded into the server) may import
//                    its own files (never the runner's) and src/pack-api.ts, and nothing that starts processes or
//                    reaches a database: no process API, no driver
//       runner code  (the files under `runner`: a job kind's programs, run by the workspace harness as the run's own
//                    user with node, src/run-harness.ts) may also start processes and use the file system
//                    (node:child_process, node:fs, node:os, ...), and imports only its own runner files and node's
//                    built-ins: never src/pack-api.ts, the server code or any other shell module; .js or .mjs only
//     neither may mention asPlatform, SET/RESET ROLE, set_config or the tenant setting (leaving the workspace's scope),
//     nor load a module outside a plain import (require, createRequire, a computed dynamic import, eval)
//   - SQL: a table, index or statement outside the pack's own `<id>_` names; GRANT, REVOKE, policies, roles, DO blocks,
//     functions, views, triggers, rules, SECURITY DEFINER, extensions, default privileges, disabling row-level
//     security; and any table created without row-level security: each CREATE TABLE must be followed, in the pack's
//     migrations, by SELECT shell_pack_tenant_table('<table>') (a workspace table: org_id NOT NULL, a policy that
//     limits the tenant role to its own workspace, fails closed) or shell_pack_private_table('<table>') (no tenant
//     access at all). src/migrate.ts checks the same again in the database when it applies them.
//     A host pack whose tables keep the names they had in the shell's base schema (mold_v0-049) declares them in
//     pack.json host.schema (tables, functions, adopts); its migrations may also name those tables, define those
//     functions and run DO blocks, GRANT, REVOKE and policies, which only the database can check: src/migrate.ts
//     refuses any change outside the pack's own tables and functions, and any of its tables without row-level security.
//
// Record areas are declared in code (definePack({ recordAreas })), so once every check above passes, each pack's entry
// is loaded once (through tsx, as the server loads it) to read them; with no packs nothing is loaded.
//
//   node scripts/gen-packs.mjs            write the files (npm run gen:packs)
//   node scripts/gen-packs.mjs --check    exit 1 when a written file differs from what the packs say (npm run check:packs)
//   --packs <dir> --out <dir> --profile <file> --facts <file>   another packs directory, output root, profile or deploy
//                                                facts file (tests)
//   --share-image <file>                         another brand share image than brand/share-image.png (tests)
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The words engine (mold_v0-100): plain TypeScript node runs as it is (types stripped), shared with the server and the console.
const WORDS_ENGINE = path.join(HERE, "..", "src", "words.ts");
const { BASE_WORDS, WORD_KEYS, fillWith, resolveWords, wordProblem } = await import(pathToFileURL(WORDS_ENGINE).href);
// The legal pages' rules (mold_v0-109): plain TypeScript with no imports, as the words engine.
const { legalProblems, legalOf } = await import(pathToFileURL(path.join(HERE, "..", "src", "legal.ts")).href);
// The shell pages a build hides from its customer console (mold_v0-130): plain TypeScript with no imports, as the words engine.
const { CONSOLE_PAGES, consoleProblems, hiddenPages, hiddenRedirects, isHiddenUrl, SIDEBAR_SHELL_PAGES, TAB_KIND_PAGE } = await import(pathToFileURL(path.join(HERE, "..", "src", "console-pages.ts")).href);
// The access-request form's own fields (mold_v0-102): plain TypeScript with no imports, as the words engine.
const ACCESS_REQUEST = path.join(HERE, "..", "src", "access-request.ts");
const { joinAccessFields } = await import(pathToFileURL(ACCESS_REQUEST).href);
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = path.resolve(HERE, "..");
const PACKS_DIR = path.resolve(opt("--packs") ?? path.join(ROOT, "packs"));
const OUT = path.resolve(opt("--out") ?? ROOT);
const PROFILE_FILE = path.resolve(opt("--profile") ?? path.join(ROOT, "profile.json"));
const FACTS_FILE = path.resolve(opt("--facts") ?? path.join(ROOT, "deploy-facts.json"));
const CHECK = argv.includes("--check");
const PACK_API = path.join(ROOT, "src", "pack-api.ts");
const PACK_HOST = path.join(ROOT, "src", "pack-host.ts");

/**
 * The neutral profile: what a build with no profile.json shows. No product's words. Its `words` (mold_v0-100) are the
 * neutral BASE of src/words.ts ({run} is "run", {member} "member"...), never written into the profile modules: they go to
 * src/vocabulary.generated.ts and the console's web/src/config/vocabulary.generated.ts, under the packs' and the profile's.
 */
export const DEFAULT_PROFILE = {
  name: "Workspace",
  mcp_server_name: "workspace",
  console_title: "Workspace",
  console_description: "Your workspace: connect an MCP client, run agents and read their results.",
  short_description: "Connect an MCP client, run agents and read their results.",
  email_sender_name: "Workspace",
  email_from_address: "no-reply@example.com",
};
const PROFILE_KEYS = Object.keys(DEFAULT_PROFILE);

const ID = /^[a-z][a-z0-9_]{1,30}$/;
const PAGE_ID = /^[a-z][a-z0-9-]{0,40}$/;
const DATA_PATH = /^\/[a-z0-9_\-/]*$/i;
const MIGRATION = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MANIFEST_KEYS = new Set(["$schema", "$comment", "id", "name", "version", "description", "entry", "migrations", "pages", "words", "upstream", "runner", "host",
  // a host pack's engine settings (mold_v0-137: engine.config, read by its own code through src/pack-host.ts engineConfig)
  "engine",
  // the declarations (mold_v0-057; src/pack-manifest.ts checks them, and refuses the keys reserved for later tickets)
  "record_areas", "job_kinds", "credentials", "operator_credentials", "schedules", "onboarding", "metrics", "repositories", "run_results", "tabs", "mcp", "charts",
  // the app's landing page (mold_v0-091, src/landing.ts), the customer guide's own pages (mold_v0-106, src/pack-guide.ts),
  // the shell pages the customer console hides (mold_v0-130, src/console-pages.ts), the access-request form's own fields
  // (mold_v0-102, src/access-request.ts)
  "landing", "guide", "console", "access_request"]);
const PAGE_KEYS = new Set(["id", "area", "title", "description", "data", "columns", "nav_group", "icon"]);
/** What a pack's code may import besides its own files and src/pack-api.ts. */
const ALLOWED_BARE = new Set(["zod", "node:crypto", "node:path", "node:url", "node:util", "node:buffer", "node:events", "node:fs", "node:fs/promises",
  "@modelcontextprotocol/sdk/types.js"]);
/**
 * What a pack's runner code (pack.json `runner`, mold_v0-054) may import: node's built-ins a run program needs, starting
 * processes and the file system included. Never a shell module (src/pack-api.ts included) or a package: a program runs
 * from its own copy of the pack, as the run's user, with nothing of the server's.
 */
const RUNNER_BARE = new Set(["node:child_process", "node:fs", "node:fs/promises", "node:path", "node:url", "node:util", "node:buffer", "node:events",
  "node:crypto", "node:os", "node:stream", "node:stream/promises", "node:readline", "node:timers", "node:timers/promises", "node:zlib", "node:string_decoder"]);

/**
 * What a host pack's server code (mold_v0-039) may import besides its own files, src/pack-api.ts and src/pack-host.ts:
 * node's built-ins and the server's own packages (package.json dependencies). Never another shell module: everything
 * of the shell a host pack uses is named in src/pack-host.ts.
 */
const SERVER_DEPS = (() => { try { const j = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")); return new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]); } catch { return new Set(); } })();
const packageOf = (spec) => spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
const hostBare = (spec) => spec.startsWith("node:") || SERVER_DEPS.has(packageOf(spec));
/** The text bans a host pack's server code is held to (it may leave a workspace's scope and read the environment: it is the product's reviewed code). */
const HOST_BANNED = (re) => /workspace_records|SESSION|eval|createRequire/.test(String(re));
/** The packs the build's profile.json allows to be host packs (mold_v0-039): `host_packs`, a list of ids. */
const HOST_PACKS = (() => {
  try { const v = JSON.parse(readFileSync(PROFILE_FILE, "utf8"))?.host_packs; return Array.isArray(v) ? new Set(v.filter((x) => typeof x === "string")) : new Set(); }
  catch { return new Set(); }
})();

const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const posix = (p) => p.split(path.sep).join("/");

function readJson(file, where) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { fail(where, `not valid JSON (${e.message})`); return null; }
}

/** Every entry under a pack, dot files and directories included: nothing a loader could reach is skipped. */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) out.push({ p, link: true });
    else if (e.isDirectory()) { out.push({ p, dir: true }); out.push(...walk(p)); }
    else out.push({ p });
  }
  return out;
}

/** The files a pack may carry: code (.ts, .mts, .js, .mjs, checked) and data a loader never runs. */
const CODE_FILE = /\.(ts|mts|js|mjs)$/;
/**
 * Why a file other than pack.json is refused in a declarative pack (mold_v0-124), and the declaration to use instead.
 * Shared with the factory's packs.py check, which says the same for an app's pack.
 */
function declarativeOnly(rel) {
  const say = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(rel)
    ? "code: rows from the workspace's files or an upstream are repositories.<name>.map in pack.json (fields with value paths, list items a[0] and a[], only, matches, max_length, any; where; retires; only_latest), runs are job_kinds, the MCP tools are generated from the declarations (mcp)"
    : /\.md$/i.test(rel) ? "the customer guide's pages are pack.json guide.markdown (one page per ## heading)"
    : /\.sql$/i.test(rel) ? "rows live in the shell's tables: declare record_areas in pack.json"
    : "everything a declarative pack says is in its pack.json";
  return `a declarative pack (no entry, migrations or runner) is its pack.json alone, so this file is never read; ${say} (MOLD.md "Declared row maps")`;
}
const DATA_FILE = /\.(json|sql|md|txt|csv|ya?ml|html|css|svg|png|jpe?g|gif|webp|pdf)$/i;

// ---------- code: the import boundary ----------

const SPECIFIERS = /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const BANNED_CODE = [
  [/\basPlatform\b/, "asPlatform (leaves the workspace's scope)"],
  [/\b(SET|RESET)\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i, "SET/RESET ROLE (leaves the tenant role)"],
  [/\bset_config\b/i, "set_config (changes the tenant setting)"],
  [/octillion\.org_id/, "the tenant setting"],
  // The record tables are the shell's record store's (mold_v0-057): a pack reaches records through ctx.records, which
  // checks fields, states and permissions; a raw query would write past them.
  [/\b(workspace_records|platform_records)\b/i, "the record tables (use ctx.records: it checks fields, states and permissions)"],
  [/\bSESSION\s+AUTHORIZATION\b/i, "SET SESSION AUTHORIZATION"],
  // Ways to load a module the import list below cannot see.
  [/\brequire\b/, "require (a pack is an ES module: use import)"],
  [/\bcreateRequire\b|\bgetBuiltinModule\b|\bprocess\s*(\.|\[)\s*["'`]?(binding|_linkedBinding|dlopen|mainModule)\b/, "a module loader outside import"],
  [/\beval\s*\(|\bFunction\s*\(|\bnew\s+Function\b|\bglobalThis\b|\bReflect\b|\bimport\.meta\.resolve\b/, "eval, Function, globalThis or Reflect"],
];
/** Every dynamic import must be a single string literal: import("…"). */
const DYNAMIC_IMPORT = /\bimport\s*\(/g;
const LITERAL_IMPORT = /^import\s*\(\s*(["'])[^"'`$]*\1\s*\)/;

const within = (dir, p) => { const r = path.relative(dir, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

/**
 * The import boundary: server code everywhere but `runnerDir`, runner code under it (mold_v0-054). `host` (mold_v0-039)
 * is null for an ordinary pack, else { scriptsDir }: its server code may also import src/pack-host.ts and the server's
 * packages, and the files under scriptsDir are operator scripts, never loaded by the server.
 */
function checkCode(packDir, id, runnerDir, host = null) {
  const code = [];
  for (const e of walk(packDir)) {
    const where = `pack ${id}: ${posix(path.relative(packDir, e.p))}`;
    // A link could make a pack file be a shell module (or a runner file be server code): packs carry plain files only.
    if (e.link) fail(where, "a symbolic link: a pack carries plain files only");
    else if (e.dir) { if (path.basename(e.p) === "node_modules") fail(where, "a node_modules directory: a pack carries its own files only, never packages"); }
    else if (CODE_FILE.test(e.p)) code.push(e.p);
    // A host pack (mold_v0-039) may also carry its downloads (a .zip under public/) and Python data tools (never loaded by node).
    else if (!DATA_FILE.test(e.p) && !(host && ((/\.zip$/i.test(e.p) && within(path.join(packDir, "public"), e.p)) || /\.py$/i.test(e.p)))) fail(where, "a file a pack may not carry (code is .ts, .mts, .js or .mjs; data .json, .sql, .md, .txt, .csv, .yaml, .html, .css or an image)");
  }
  const scriptsDir = host?.scriptsDir ?? null;
  const isScript = (f) => scriptsDir !== null && within(scriptsDir, f);
  graphJobs.push({ packDir, id, runnerDir, code: code.filter((f) => !isScript(f)), host, scriptsDir });
  for (const file of code) {
    const where = `pack ${id}: ${posix(path.relative(packDir, file))}`;
    // A host pack's operator scripts (mold_v0-039) are run by hand with tsx, never loaded by the server: no import rule.
    if (isScript(file)) continue;
    const runner = runnerDir !== null && within(runnerDir, file);
    const src = readFileSync(file, "utf8");
    if (runner && !/\.m?js$/.test(file)) fail(where, "runner code runs with node as it is: a .js or .mjs file");
    for (const [re, what] of BANNED_CODE) if ((!host || runner || HOST_BANNED(re)) && re.test(src)) fail(where, `uses ${what}`);
    // Server code runs in the server's process: no process object at all, so it can neither read the server's
    // environment nor change the limits read from it (mold_v0-018, src/rate-limits.ts). Runner code has its own process.
    // A host pack's server code is the product's own (mold_v0-039) and reads its settings from the environment.
    if (!runner && !host && /\bprocess\b/.test(src)) fail(where, "uses process (server code may not read or change the server's environment)");
    for (const m of src.matchAll(DYNAMIC_IMPORT)) if (!LITERAL_IMPORT.test(src.slice(m.index))) fail(where, "a dynamic import of anything but one string literal");
    for (const m of src.matchAll(SPECIFIERS)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (runner) {
        if (spec.startsWith(".")) {
          if (!within(runnerDir, path.resolve(path.dirname(file), spec))) fail(where, `imports ${spec}: runner code may import its own runner files and node's built-ins only (never src/pack-api.ts, the pack's server code or the shell)`);
        } else if (!RUNNER_BARE.has(spec)) fail(where, `imports ${spec}: not allowed in runner code (allowed: ${[...RUNNER_BARE].join(", ")}, its own runner files)`);
        continue;
      }
      if (spec.startsWith(".")) {
        const raw = path.resolve(path.dirname(file), spec);
        const target = raw.replace(/\.js$/, ".ts");
        if (target === PACK_API) continue;
        if (host && target === PACK_HOST) continue;
        const inside = path.relative(packDir, target);
        if (inside.startsWith("..") || path.isAbsolute(inside)) fail(where, `imports ${spec}: a pack may import its own files and src/pack-api.ts only${host ? " (a host pack also src/pack-host.ts)" : ""}`);
        else if (runnerDir !== null && (within(runnerDir, raw) || within(runnerDir, target))) fail(where, `imports ${spec}: server code may not import the runner's code (it may start processes)`);
        else if (isScript(raw) || isScript(target)) fail(where, `imports ${spec}: server code may not import the pack's operator scripts`);
      } else if (host ? !hostBare(spec) : !ALLOWED_BARE.has(spec)) fail(where, host ? `imports ${spec}: a host pack's server code may import node's built-ins and the server's packages only` : `imports ${spec}: not allowed in a pack's server code (allowed: ${[...ALLOWED_BARE].join(", ")}, src/pack-api.ts, its own files${runnerDir !== null ? "; a run program that needs more goes under the pack's runner directory" : ""})`);
    }
  }
}

/**
 * The import graph, as a loader resolves it (esbuild, which tsx itself uses): every code file of the pack is an entry,
 * and every import it makes (static, re-export, dynamic) is resolved, extensionless and index files included. A file
 * outside the pack, a server file reaching the runner's code, a runner file reaching anything but its own runner files
 * and the built-ins it may use, or a package or built-in outside the lists is refused. The text checks above stay as a
 * second layer (computed imports, require, the scope-leaving words).
 */
const graphJobs = [];
async function checkGraphs() {
  if (!graphJobs.length) return;
  let esbuild;
  try { esbuild = createRequire(path.join(ROOT, "package.json"))("esbuild"); }
  catch { fail("packs", "checking the packs' imports needs esbuild (a dependency of tsx): run npm ci"); return; }
  for (const { packDir, id, runnerDir, code, host, scriptsDir } of graphJobs) {
    if (!code.length) continue;
    const API = "pack-api:", HOSTAPI = "pack-host:";
    const plugin = { name: "pack-boundary", setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (a.kind === "entry-point") return undefined;
        if (!a.path.startsWith(".") && !a.path.startsWith("/")) return { path: a.path, external: true };
        const abs = path.resolve(a.resolveDir, a.path);
        if (abs === PACK_API || abs.replace(/\.js$/, ".ts") === PACK_API) return { path: API, external: true };
        if (host && (abs === PACK_HOST || abs.replace(/\.js$/, ".ts") === PACK_HOST)) return { path: HOSTAPI, external: true };
        return undefined;
      });
    } };
    let meta;
    try {
      const r = await esbuild.build({ entryPoints: code, bundle: true, write: false, metafile: true, platform: "node", format: "esm", outdir: path.join(tmpdir(), "gen-packs-graph"),
        absWorkingDir: packDir, logLevel: "silent", plugins: [plugin], loader: { ".json": "json" } });
      meta = r.metafile;
    } catch (e) {
      const first = e?.errors?.[0];
      fail(`pack ${id}`, `its code does not resolve: ${first ? `${first.location?.file ?? ""}: ${first.text}` : String(e?.message ?? e).slice(0, 300)}`);
      continue;
    }
    for (const [input, info] of Object.entries(meta.inputs)) {
      const file = path.resolve(packDir, input);
      const where = `pack ${id}: ${posix(input)}`;
      if (!within(packDir, file)) { fail(where, "a file outside the pack is loaded: a pack may import its own files and src/pack-api.ts only"); continue; }
      if (scriptsDir !== null && within(scriptsDir, file)) { fail(where, "the pack's operator scripts are loaded by its server code: server code may not import them"); continue; }
      const runner = runnerDir !== null && within(runnerDir, file);
      for (const imp of info.imports ?? []) {
        const target = imp.external ? null : path.resolve(packDir, imp.path);
        if (runner) {
          if (imp.path === API && imp.external) fail(where, "imports src/pack-api.ts: runner code may import its own runner files and node's built-ins only");
          else if (imp.external && !RUNNER_BARE.has(imp.path)) fail(where, `imports ${imp.path}: not allowed in runner code`);
          else if (target && !within(runnerDir, target)) fail(where, `imports ${posix(imp.path)}: runner code may import its own runner files and node's built-ins only (never src/pack-api.ts, the pack's server code or the shell)`);
        } else {
          if (imp.external && imp.path !== API && !(host && imp.path === HOSTAPI) && !(host ? hostBare(imp.path) : ALLOWED_BARE.has(imp.path))) fail(where, `imports ${imp.path}: not allowed in a pack's server code`);
          else if (target && runnerDir !== null && within(runnerDir, target)) fail(where, `imports ${posix(imp.path)}: server code may not import the runner's code (it may start processes)`);
          else if (target && !within(packDir, target)) fail(where, `imports ${posix(imp.path)}: a pack may import its own files and src/pack-api.ts only`);
        }
      }
    }
  }
}

// ---------- SQL: names, statements, row-level security ----------

/**
 * Lex a migration the way Postgres does, so nothing can hide from the checks below: -- and (nested) block comments
 * become a space, the text inside '…' and "…" is kept for the statement checks but blanked for the banned-word scan
 * (so a quote can neither hide a comment marker nor carry a banned word). Escape-string (E'…'), Unicode (U&'…') and
 * dollar quoting are refused outright. Returns null (and records why) when the text cannot be lexed safely.
 */
function lex(sql, where, host = false) {
  let code = "", blank = "", i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i], next = sql[i + 1];
    if (ch === "-" && next === "-") { while (i < n && sql[i] !== "\n") i++; code += " "; blank += " "; continue; }
    if (ch === "/" && next === "*") {
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      } while (depth > 0 && i < n);
      if (depth > 0) { fail(where, "an unterminated /* comment"); return null; }
      code += " "; blank += " "; continue;
    }
    if (ch === "$" && /^\$[a-z_0-9]*\$/i.test(sql.slice(i)) && !/[a-z0-9_$]/i.test(sql[i - 1] ?? "")) {
      // A host pack's schema (mold_v0-049) carries DO blocks and its declared functions: the body stays in the text the
      // banned-word scan reads (so nothing banned hides in it) and is one opaque token for the statement checks.
      if (!host) { fail(where, "uses dollar-quoted bodies (DO blocks, functions): not allowed in a pack migration"); return null; }
      const tag = /^\$[a-z_0-9]*\$/i.exec(sql.slice(i))[0];
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) { fail(where, `an unterminated ${tag} body`); return null; }
      code += `${tag} BODY ${tag}`; blank += ` ${sql.slice(i + tag.length, end)} `; i = end + tag.length; continue;
    }
    if (ch === "'" || ch === '"') {
      // E'…' interprets backslash escapes (E'\'' is a quote inside the string); U&'…' has escapes too: refuse both.
      if (ch === "'" && /(^|[^a-z0-9_$])(e|u&)$/i.test(sql.slice(Math.max(0, i - 3), i))) {
        fail(where, "escape (E'…') and Unicode (U&'…') strings are not allowed in a pack migration"); return null;
      }
      let j = i + 1, body = "";
      for (;;) {
        if (j >= n) { fail(where, `an unterminated ${ch} quote`); return null; }
        if (sql[j] === ch) { if (sql[j + 1] === ch) { body += ch + ch; j += 2; continue; } break; }
        body += sql[j++];
      }
      code += ch + body + ch; blank += ch + " ".repeat(body.length) + ch; i = j + 1; continue;
    }
    code += ch; blank += ch; i++;
  }
  return { code, blank };
}

/** Statements split on ; outside quotes, from lexed text (comments already gone). */
function statements(code) {
  const out = [];
  let cur = "", q = null;
  for (const ch of code) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (ch === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((x) => x.replace(/\s+/g, " "));
}

const BANNED_SQL = [
  [/\$[a-z_0-9]*\$/i, "dollar-quoted bodies (DO blocks, functions)"],
  [/\bGRANT\b/i, "GRANT"], [/\bREVOKE\b/i, "REVOKE"],
  [/\bPOLICY\b/i, "policies (the shell's helpers write them)"],
  [/\b(SET|RESET)\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i, "SET/RESET ROLE"], [/\bSESSION\s+AUTHORIZATION\b/i, "SESSION AUTHORIZATION"],
  [/\bSECURITY\s+DEFINER\b/i, "SECURITY DEFINER"], [/\bset_config\b/i, "set_config"],
  [/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i, "DISABLE ROW LEVEL SECURITY"], [/\bNO\s+FORCE\s+ROW\s+LEVEL\b/i, "NO FORCE ROW LEVEL SECURITY"],
  [/\bOWNER\s+TO\b/i, "OWNER TO"], [/\bINHERITS\b/i, "INHERITS"], [/\bPARTITION\s+OF\b/i, "PARTITION OF"],
];

/**
 * A host pack's schema (mold_v0-049) may grant, revoke, write policies and run DO blocks on its own tables (the database
 * holds it to that: src/migrate.ts securitySnapshot); never the rest of BANNED_SQL, nor objects that act outside a table.
 */
const HOST_ALLOWED = new Set(["GRANT", "REVOKE", "policies (the shell's helpers write them)", "dollar-quoted bodies (DO blocks, functions)"]);
const HOST_BANNED_SQL = [
  [/\b(CREATE|ALTER|DROP)\s+(ROLE|USER|GROUP)\b/i, "roles"], [/\bDEFAULT\s+PRIVILEGES\b/i, "default privileges"],
  [/\b(CREATE|ALTER)\s+(OR\s+REPLACE\s+)?(TRIGGER|RULE|VIEW|EXTENSION|EVENT\s+TRIGGER|PUBLICATION|SCHEMA|AGGREGATE|OPERATOR|CAST)\b/i, "triggers, rules, views, extensions, schemas or operators"],
  [/\bLANGUAGE\s+(c|internal|plpython\w*|plperl\w*|pltcl\w*)\b/i, "an untrusted function language"],
  [/\bCOPY\b/i, "COPY"], [/\bpg_read_|\blo_import\b|\blo_export\b|\bdblink\b/i, "server file or connection functions"],
];

const NAME = String.raw`"?([a-z_][a-z0-9_]*)"?`;
const unq = (s) => s.replace(/"/g, "").toLowerCase();

function checkMigrations(dir, id, where, schema = null) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const prefix = `${id}_`;
  // A host pack's declared tables (mold_v0-049) are its own too, under their names.
  const declared = new Set(schema?.tables ?? []);
  const fns = new Set(schema?.functions ?? []);
  const own = (t) => { const n = unq(t).replace(/^public\./, ""); return n.startsWith(prefix) || declared.has(n); };
  const createdNames = new Set();
  const definedFns = new Set();
  const created = []; // [table, file]
  const secured = new Map(); // table -> "tenant" | "private"
  const order = [];
  files.forEach((f, i) => {
    const m = MIGRATION.exec(f);
    if (!m) return fail(`${where}/${f}`, "name it NNNN_lowercase_words.sql");
    if (Number(m[1]) !== i + 1) fail(`${where}/${f}`, `expected version ${String(i + 1).padStart(4, "0")} (no gaps or duplicates)`);
    const sql = readFileSync(path.join(dir, f), "utf8");
    const lexed = lex(sql, `${where}/${f}`, !!schema);
    if (!lexed) return;
    for (const [re, what] of BANNED_SQL) if (re.test(lexed.blank) && !(schema && HOST_ALLOWED.has(what))) fail(`${where}/${f}`, `uses ${what}: not allowed in a pack migration`);
    if (schema) for (const [re, what] of HOST_BANNED_SQL) if (re.test(lexed.blank)) fail(`${where}/${f}`, `uses ${what}: not allowed in a pack migration`);
    for (const st of statements(lexed.code)) {
      const at = `${where}/${f}: ${st.slice(0, 80)}`;
      let x;
      if (schema && /^DO (\$[a-z_0-9]*\$) BODY \1$/i.test(st)) continue; // checked in the database (src/migrate.ts)
      if (schema && (x = new RegExp(String.raw`^CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?${NAME} ?\(`, "i").exec(st))) {
        if (!fns.has(unq(x[1]))) fail(at, `defines function ${unq(x[1])}, which pack.json host.schema.functions does not declare`);
        else definedFns.add(unq(x[1]));
        if (/\bSECURITY\s+DEFINER\b/i.test(st)) fail(at, "SECURITY DEFINER");
        continue;
      }
      if ((x = new RegExp(String.raw`^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?(?:public\.)?${NAME} ?\((.*)\)$`, "i").exec(st))) {
        const t = unq(x[1]);
        if (!own(t)) { fail(at, `table ${t} must be named ${prefix}…${schema ? " or declared in pack.json host.schema.tables" : ""}`); continue; }
        createdNames.add(t);
        // A declared table is secured by the pack's own policies, which the database checks (src/migrate.ts).
        if (declared.has(t)) continue;
        created.push({ t, f, body: x[2], i: order.length });
        order.push({ kind: "create", t });
      } else if ((x = new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${NAME} )?ON (?:ONLY )?(?:public\.)?${NAME}\b`, "i").exec(st))) {
        if (x[1] && !own(x[1]) && !declared.has(unq(x[2]))) fail(at, `index ${unq(x[1])} must be named ${prefix}…`);
        if (!own(x[2])) fail(at, `an index on ${unq(x[2])}, which is not this pack's table`);
      } else if ((x = new RegExp(String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(?:public\.)?${NAME} (.*)$`, "i").exec(st))) {
        if (!own(x[1])) fail(at, `alters ${unq(x[1])}, which is not this pack's table`);
        if (/\bRENAME\s+TO\b/i.test(x[2])) fail(at, "renames a table: create the new one instead");
        // Only column and constraint changes: never INHERIT, ATTACH/DETACH PARTITION, OF, SET SCHEMA, rules, triggers.
        else if (!/^(ADD|DROP|ALTER|RENAME)\b/i.test(x[2]) || /\b(INHERIT|ATTACH|DETACH|OF|SCHEMA|RULE|TRIGGER|REPLICA|CLUSTER|TABLESPACE|LOGGED|UNLOGGED|ACCESS\s+METHOD|OIDS)\b/i.test(x[2].replace(/'[^']*'/g, "''")))
          fail(at, "ALTER TABLE may only add, drop, alter or rename columns and constraints");
      } else if ((x = new RegExp(String.raw`^DROP (TABLE|INDEX) (?:IF EXISTS )?(.*?)(?: CASCADE| RESTRICT)?$`, "i").exec(st))) {
        for (const n of x[2].split(",")) if (!own(n.trim())) fail(at, `drops ${unq(n.trim())}, which is not this pack's`);
        if (/CASCADE/i.test(st)) fail(at, "DROP … CASCADE can reach shell objects");
      } else if ((x = new RegExp(String.raw`^(?:INSERT INTO|UPDATE|DELETE FROM) (?:ONLY )?(?:public\.)?${NAME}\b`, "i").exec(st))) {
        if (!own(x[1])) fail(at, `writes ${unq(x[1])}, which is not this pack's table`);
      } else if ((x = /^COMMENT ON (TABLE|COLUMN|INDEX) (?:public\.)?("?)([a-z_][a-z0-9_]*)\2/i.exec(st))) {
        if (!own(x[3])) fail(at, `comments on ${unq(x[3])}, which is not this pack's`);
      } else if ((x = /^SELECT shell_pack_(tenant|private)_table\('([a-z_][a-z0-9_]*)'\)$/i.exec(st))) {
        const t = x[2].toLowerCase();
        if (!own(t)) fail(at, `secures ${t}, which is not this pack's table`);
        secured.set(t, x[1].toLowerCase());
        order.push({ kind: "secure", t, how: x[1].toLowerCase() });
      } else fail(at, "not a statement a pack migration may run (CREATE TABLE/INDEX, ALTER/DROP its own tables, seed rows, COMMENT, SELECT shell_pack_*_table)");
    }
  });
  // A declared table (mold_v0-049) must be one this pack's migrations create, and a declared function one they define.
  for (const t of declared) if (!createdNames.has(t)) fail(where, `pack.json host.schema.tables names ${t}, which no migration here creates`);
  for (const fn of fns) if (!definedFns.has(fn)) fail(where, `pack.json host.schema.functions names ${fn}, which no migration here defines`);
  // Every table created must be secured after its (last) creation, and a workspace table must carry org_id NOT NULL.
  for (const c of created) {
    const later = order.slice(c.i + 1).find((o) => o.t === c.t);
    if (!later || later.kind !== "secure")
      fail(`${where}/${c.f}`, `table ${c.t} has no row-level security: add SELECT shell_pack_tenant_table('${c.t}') (a workspace table) or shell_pack_private_table('${c.t}') (no tenant access) after it`);
    // Deleting a workspace is one DELETE of its organizations row (src/tenancy.ts): its pack rows must go with it.
    else if (later.how === "tenant" && !/(^|,)\s*org_id\s+(INT|INTEGER|BIGINT)\b[^,]*\bNOT NULL\b[^,]*\bREFERENCES\s+organizations\b[^,]*\bON DELETE CASCADE\b/i.test(c.body))
      fail(`${where}/${c.f}`, `workspace table ${c.t} needs org_id INT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE`);
  }
  return files.length;
}

// ---------- packs ----------

/**
 * pack.json host.schema (mold_v0-049), or null. Only a host pack of this build may declare one; its tables are not the
 * shell's (checked once the shell's tables are known, below) and its names are plain identifiers.
 */
function hostSchemaOf(m, dirName, where) {
  const sc = m?.host && typeof m.host === "object" ? m.host.schema : undefined;
  if (sc === undefined) return null;
  const IDENT = /^[a-z][a-z0-9_]{1,62}$/;
  if (!HOST_PACKS.has(dirName)) { fail(where, "host.schema: only a host pack of this build may declare its own tables"); return null; }
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) { fail(where, "host.schema must be an object {tables, functions?, adopts?}"); return null; }
  for (const k of Object.keys(sc)) if (!["tables", "functions", "adopts", "platform_read", "references"].includes(k)) fail(where, `host.schema: unknown field ${k}`);
  const list = (v, what) => Array.isArray(v) && v.every((x) => typeof x === "string" && IDENT.test(x)) && new Set(v).size === v.length ? v : (fail(where, `host.schema.${what} must be a list of distinct lowercase names`), []);
  const tables = list(sc.tables, "tables");
  if (!tables.length) fail(where, "host.schema.tables names no table");
  const functions = sc.functions === undefined ? [] : list(sc.functions, "functions");
  for (const fn of functions) if (fn.startsWith("shell_pack_")) fail(where, `host.schema.functions: ${fn} is the shell's`);
  const platformRead = sc.platform_read === undefined ? [] : list(sc.platform_read, "platform_read");
  for (const t of platformRead) if (!tables.includes(t)) fail(where, `host.schema.platform_read: ${t} is not one of host.schema.tables`);
  const adopts = {};
  if (sc.adopts !== undefined) {
    if (!sc.adopts || typeof sc.adopts !== "object" || Array.isArray(sc.adopts)) fail(where, "host.schema.adopts must be an object of pack migration -> shell migration");
    else for (const [k, v] of Object.entries(sc.adopts)) {
      if (!/^\d{4}_[a-z0-9_]+$/.test(k) || typeof v !== "string" || !/^\d{4}_[a-z0-9_]+$/.test(v)) fail(where, `host.schema.adopts.${k}: NNNN_name -> NNNN_name (file names without .sql)`);
      else adopts[k] = v;
    }
  }
  const references = {};
  if (sc.references !== undefined) {
    if (!sc.references || typeof sc.references !== "object" || Array.isArray(sc.references)) fail(where, "host.schema.references must be an object of shell table.column -> its table");
    else for (const [k, v] of Object.entries(sc.references)) {
      if (!/^[a-z][a-z0-9_]{1,62}\.[a-z][a-z0-9_]{1,62}$/.test(k) || typeof v !== "string" || !tables.includes(v)) fail(where, `host.schema.references.${k}: a shell table.column -> one of host.schema.tables`);
      else references[k] = v;
    }
  }
  return { tables, functions, adopts, platform_read: platformRead, references };
}

function loadPack(dirName) {
  const dir = path.join(PACKS_DIR, dirName);
  const where = `packs/${dirName}/pack.json`;
  const file = path.join(dir, "pack.json");
  if (!existsSync(file)) return null;
  const m = readJson(file, where);
  if (!m || typeof m !== "object" || Array.isArray(m)) { if (m) fail(where, "must be an object"); return null; }
  for (const k of Object.keys(m)) if (!MANIFEST_KEYS.has(k)) fail(where, `unknown field ${k}`);
  if (typeof m.id !== "string" || !ID.test(m.id)) fail(where, "id: 2-31 lowercase letters, digits or _, starting with a letter");
  else if (m.id !== dirName) fail(where, `id ${m.id} must be the directory's name (${dirName})`);
  const id = m.id;
  if (typeof m.name !== "string" || !m.name.trim()) fail(where, "name is required");
  if (typeof m.version !== "string" || !m.version.trim()) fail(where, "version is required");
  // The code entry is optional (mold_v0-057): a pack.json alone is a whole pack. Without `entry`, index.ts is the entry
  // when there is one (as before), else the pack has no code entry and its definition is its declarations.
  const entry = m.entry ?? (existsSync(path.join(dir, "index.ts")) ? "index.ts" : null);
  if (entry !== null && (typeof entry !== "string" || !/^[a-z0-9_\-/]+\.ts$/i.test(entry) || entry.includes(".."))) fail(where, "entry must be a .ts file inside the pack");
  else if (entry !== null && !existsSync(path.join(dir, entry))) fail(where, `entry ${entry} does not exist`);
  // A host pack's schema (mold_v0-049): its tables under their own names, its functions, the migrations it adopts.
  const schema = hostSchemaOf(m, dirName, where);
  let migrations = null;
  if (m.migrations !== undefined) {
    if (typeof m.migrations !== "string" || !/^[a-z0-9_\-/]+$/i.test(m.migrations) || m.migrations.includes("..")) fail(where, "migrations must be a directory inside the pack");
    else if (!existsSync(path.join(dir, m.migrations)) || !statSync(path.join(dir, m.migrations)).isDirectory()) fail(where, `migrations directory ${m.migrations} does not exist`);
    else if (checkMigrations(path.join(dir, m.migrations), id, `packs/${dirName}/${m.migrations}`, schema) === 0) fail(where, `migrations directory ${m.migrations} has no .sql files`);
    else migrations = m.migrations;
  }
  if (schema) {
    if (!migrations) fail(where, "host.schema needs the pack's migrations (pack.json migrations), which create those tables");
    else for (const [mine, shell] of Object.entries(schema.adopts ?? {}))
      if (!existsSync(path.join(dir, m.migrations, `${mine}.sql`))) fail(where, `host.schema.adopts names ${mine}, which is not one of its migrations`);
      else if (!existsSync(path.join(ROOT, "sql", "migrations", `${shell}.sql`))) fail(where, `host.schema.adopts maps ${mine} to ${shell}, which is not a shell migration`);
  }
  const pages = [];
  if (m.pages !== undefined && !Array.isArray(m.pages)) fail(where, "pages must be a list");
  const seen = new Set();
  for (const [i, pg] of (Array.isArray(m.pages) ? m.pages : []).entries()) {
    const at = `${where} pages[${i}]`;
    if (!pg || typeof pg !== "object") { fail(at, "must be an object"); continue; }
    for (const k of Object.keys(pg)) if (!PAGE_KEYS.has(k)) fail(at, `unknown field ${k}`);
    if (typeof pg.id !== "string" || !PAGE_ID.test(pg.id)) fail(at, "id: lowercase letters, digits and -");
    if (pg.area !== "app" && pg.area !== "admin") fail(at, 'area must be "app" (a workspace\'s people) or "admin" (platform staff)');
    if (typeof pg.title !== "string" || !pg.title.trim()) fail(at, "title is required");
    if (typeof pg.data !== "string" || !DATA_PATH.test(pg.data)) fail(at, "data must be a path under the pack's own API, starting with /");
    if (pg.columns !== undefined && (!Array.isArray(pg.columns) || pg.columns.some((c) => !c || typeof c.key !== "string" || typeof c.label !== "string")))
      fail(at, "columns must be a list of {key, label}");
    for (const k of ["description", "nav_group", "icon"]) if (pg[k] !== undefined && typeof pg[k] !== "string") fail(at, `${k} must be text`);
    const key = `${pg.area} ${pg.id}`;
    if (seen.has(key)) fail(at, `page ${pg.id} is declared twice in ${pg.area}`);
    seen.add(key);
    pages.push({ pack: id, id: pg.id, area: pg.area, title: pg.title, description: pg.description ?? null, data: pg.data,
      columns: pg.columns ?? [], nav_group: pg.nav_group ?? m.name, icon: pg.icon ?? null });
  }
  const words = {};
  if (m.words !== undefined) {
    if (!m.words || typeof m.words !== "object" || Array.isArray(m.words)) fail(where, "words must be an object of shell word -> the pack's word");
    else for (const [k, v] of Object.entries(m.words)) {
      if (!/^[a-z][a-z_]{1,30}$/.test(k) || typeof v !== "string" || !v.trim() || v.length > 40) fail(where, `words.${k}: a lowercase shell word mapped to a word of up to 40 characters`);
      else words[k] = v;
    }
  }
  // The runner directory (mold_v0-054): a job kind's programs, held to the runner rules instead of the server's.
  let runnerDir = null;
  if (m.runner !== undefined) {
    if (typeof m.runner !== "string" || !/^[a-z0-9_\-/]+$/i.test(m.runner) || m.runner.includes("..") || m.runner.startsWith("/")) fail(where, "runner must be a directory inside the pack");
    else if (!existsSync(path.join(dir, m.runner)) || !statSync(path.join(dir, m.runner)).isDirectory()) fail(where, `runner directory ${m.runner} does not exist`);
    else {
      runnerDir = path.join(dir, m.runner);
      if (runnerDir === path.resolve(dir)) fail(where, "runner must be a directory under the pack, not the pack itself");
      if (typeof entry === "string" && within(runnerDir, path.join(dir, entry))) fail(where, `entry ${entry} is inside the runner directory: the server's entry is server code`);
      if (typeof m.migrations === "string" && within(runnerDir, path.join(dir, m.migrations))) fail(where, "migrations may not be inside the runner directory");
    }
  }
  // A host pack (mold_v0-039): `host` names its server entry (defineHost, src/host.ts), optionally its operator scripts'
  // directory and the profile it brings (under the build's profile.json). Only a pack profile.json lists in host_packs.
  let host = null;
  if (m.host !== undefined) {
    const h = m.host;
    const HOST_KEYS = new Set(["entry", "scripts", "profile", "schema"]);
    if (!h || typeof h !== "object" || Array.isArray(h)) fail(where, "host must be an object {entry, scripts?, profile?}");
    else {
      for (const k of Object.keys(h)) if (!HOST_KEYS.has(k)) fail(where, `host: unknown field ${k}`);
      if (!HOST_PACKS.has(dirName)) fail(where, `host: pack ${dirName} is not a host pack of this build (profile.json host_packs does not list it)`);
      if (typeof h.entry !== "string" || !/^[a-z0-9_\-/]+\.ts$/i.test(h.entry) || h.entry.includes("..")) fail(where, "host.entry must be a .ts file inside the pack");
      else if (!existsSync(path.join(dir, h.entry))) fail(where, `host.entry ${h.entry} does not exist`);
      let scriptsDir = null;
      if (h.scripts !== undefined) {
        if (typeof h.scripts !== "string" || !/^[a-z0-9_\-/]+$/i.test(h.scripts) || h.scripts.includes("..")) fail(where, "host.scripts must be a directory inside the pack");
        else if (!existsSync(path.join(dir, h.scripts))) fail(where, `host.scripts directory ${h.scripts} does not exist`);
        else scriptsDir = path.join(dir, h.scripts);
      }
      if (scriptsDir && typeof h.entry === "string" && within(scriptsDir, path.join(dir, h.entry))) fail(where, "host.entry may not be inside host.scripts");
      if (h.profile !== undefined && (!h.profile || typeof h.profile !== "object" || Array.isArray(h.profile))) fail(where, "host.profile must be an object of profile fields");
      host = { entry: typeof h.entry === "string" ? h.entry : null, scriptsDir, profile: h.profile ?? null };
    }
  }
  if (id && ID.test(id)) checkCode(dir, id, runnerDir, host ? { scriptsDir: host.scriptsDir } : null);
  // A pack with no entry is its pack.json alone (mold_v0-057): server code it carries would never load, so say so (a
  // host pack's server code loads from its host entry). A declarative pack (mold_v0-124: no entry, migrations or runner)
  // holds nothing but its pack.json: nothing else of it is ever read, so any other file is refused, naming the
  // declaration that says it instead.
  const declarative = entry === null && !host && m.migrations === undefined && m.runner === undefined;
  if (entry === null && !host) for (const e of walk(dir)) {
    if (e.dir) continue;
    const rel = posix(path.relative(dir, e.p));
    if (declarative) { if (rel !== "pack.json") fail(where, `${rel}: ${declarativeOnly(rel)}`); }
    else if (!e.link && CODE_FILE.test(e.p) && !(runnerDir !== null && within(runnerDir, e.p)))
      fail(where, `${rel} is server code but the pack has no entry (name it in pack.json \`entry\`, or move a run program under \`runner\`)`);
  }
  if (host && entry !== null && entry === host.entry) fail(where, "host.entry and entry must be different files (definePack and defineHost)");
  // Its upstream pin (mold_v0-050), checked with the rest of pack.json below (src/pack-manifest.ts): the source offer's.
  const upstream = m.upstream && typeof m.upstream === "object" && !Array.isArray(m.upstream) ? m.upstream : null;
  // The customer guide's own pages (mold_v0-106, src/pack-guide.ts): a host pack's guide is its code (web/src/packs/<id>/guide.ts);
  // a declarative pack's is inline in pack.json (guide.markdown; guide.dir is gone, mold_v0-124), checked below.
  if (m.guide !== undefined && host) fail(where, "guide: a host pack's customer guide is its console code (web/src/packs/<id>/guide.ts), not pack.json guide");
  // A host pack's engine settings (mold_v0-137): read by its own code only (src/pack-host.ts engineConfig), so only a
  // host pack may have them; their shape is checked below (src/pack-manifest.ts) and against the host entry's schema when
  // the server starts (src/host.ts registerHosts).
  if (m.engine !== undefined && !host) fail(where, "engine: only a host pack's own code reads engine.config (a declarative pack says everything in its declarations)");
  const engineConfig = host && m.engine && typeof m.engine === "object" && !Array.isArray(m.engine) && m.engine.config && typeof m.engine.config === "object" && !Array.isArray(m.engine.config) ? m.engine.config : null;
  return { id, dir, json: m, host, schema, engineConfig, migrationsDir: migrations && posix(path.relative(ROOT, path.join(dir, migrations))), manifest: { id, name: m.name, version: m.version, entry, migrations, words, dir: posix(path.relative(ROOT, dir)), ...(upstream ? { upstream } : {}) }, pages };
}

// ---------- a host pack's console and orchestrator code (mold_v0-039) ----------

const WEB_PACKS = path.join(ROOT, "web", "src", "packs");
const ORCH_PACKS = path.join(ROOT, "orchestrator", "packs");
const WEB_DEPS = (() => { try { const j = JSON.parse(readFileSync(path.join(ROOT, "web", "package.json"), "utf8")); return new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]); } catch { return new Set(); } })();
const ORCH_DEPS = (() => { try { const j = JSON.parse(readFileSync(path.join(ROOT, "orchestrator", "package.json"), "utf8")); return new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]); } catch { return new Set(); } })();
const ORCH_LOCKED = (() => { try { return new Set(Object.keys(JSON.parse(readFileSync(path.join(ROOT, "orchestrator", "package-lock.json"), "utf8")).packages ?? {}).filter((k) => k.startsWith("node_modules/")).map((k) => k.slice("node_modules/".length))); } catch { return new Set(); } })();
/** The console's shared code a host pack's pages may import (never another pack's pages, never the shell's own pages). */
const WEB_SHARED = /^@\/(components|lib|hooks|types|config|features|styles|constants)(\/|$)/;
const WEB_FILE = /\.(ts|tsx|css|json|md|svg|png|jpe?g|webp|gif|txt)$/i;
const ORCH_FILE = /\.(ts|mts|js|mjs|json|md|txt|ya?ml|sh|toml|py|go|rs|java|kt|xml|gradle|properties|html|css|tsx|jsx|dart|swift|cmake|cpp|hpp|h|c|lock|gitignore|env|example)$|(^|\/)(Dockerfile|Makefile|CMakeLists\.txt|Cargo\.toml|go\.mod|go\.sum|Gemfile|Podfile|gradlew|\.gitignore|\.env\.example)$/i;
function checkSideCode(base, kind, ids) {
  if (!existsSync(base)) return [];
  const found = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (e.name === "README.md" || (kind === "orchestrator" && e.name === "packs.generated.ts")) continue;
    const at = `${posix(path.relative(ROOT, base))}/${e.name}`;
    if (!e.isDirectory() || e.isSymbolicLink()) { fail(at, "only one directory per host pack lives here"); continue; }
    if (!ids.has(e.name)) { fail(at, `no host pack ${e.name} in this build (a pack's ${kind} code is a host pack's only)`); continue; }
    found.push(e.name);
    const own = path.join(base, e.name);
    for (const f of walk(own)) {
      const where = `${posix(path.relative(ROOT, f.p))}`;
      if (f.link) { fail(where, "a symbolic link: a pack carries plain files only"); continue; }
      if (f.dir) { if (path.basename(f.p) === "node_modules") fail(where, "a node_modules directory"); continue; }
      if (kind === "web" && !WEB_FILE.test(f.p)) { fail(where, "a file a pack's console code may not carry"); continue; }
      if (!/\.(ts|tsx|mts|js|mjs)$/.test(f.p)) continue;
      // An orchestrator pack's starter workspaces (workspaces/: projects agents work in) and its tests (test/: run by hand,
      // never uploaded to a sandbox, orchestrator/deploy/boat-lib.ts) are never loaded by the orchestrator.
      if (kind === "orchestrator" && (within(path.join(own, "workspaces"), f.p) || within(path.join(own, "test"), f.p))) continue;
      const src = readFileSync(f.p, "utf8");
      if (/\beval\s*\(|\bnew\s+Function\b|\bcreateRequire\b/.test(src)) fail(where, "uses eval, Function or createRequire");
      if (kind === "web" && /process\.env\.(?!NEXT_PUBLIC_|NODE_ENV\b)/.test(src)) fail(where, "reads the server's environment (a console page may read NEXT_PUBLIC_ names only)");
      for (const m of src.matchAll(SPECIFIERS)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (spec.startsWith(".")) {
          const t = path.resolve(path.dirname(f.p), spec);
          if (kind === "web" && !within(own, t)) fail(where, `imports ${spec}: a console pack imports its own files, the console's shared code (@/components, @/lib, …) and packages only`);
          if (kind === "orchestrator" && !within(path.join(ROOT, "orchestrator"), t)) fail(where, `imports ${spec}: orchestrator code imports the orchestrator's own files only (never the server's src/)`);
          if (kind === "orchestrator" && within(ORCH_PACKS, t) && !within(own, t)) fail(where, `imports ${spec}: another pack's orchestrator code`);
        } else if (kind === "web" && spec.startsWith("@/")) {
          if (spec === `@/packs/${e.name}` || spec.startsWith(`@/packs/${e.name}/`)) continue;
          if (!WEB_SHARED.test(spec)) fail(where, `imports ${spec}: a console pack may import the console's shared code only (@/components, @/lib, @/hooks, @/types, @/config, @/features, @/styles)`);
        } else if (!spec.startsWith("node:") && !(kind === "web" ? WEB_DEPS : ORCH_DEPS).has(packageOf(spec))
          // The orchestrator's packages' own packages (Pi's model layer, installed with it: its package-lock) count as its packages.
          && !(kind === "orchestrator" && ORCH_LOCKED.has(packageOf(spec))))
          fail(where, `imports ${spec}: not a package of the ${kind === "web" ? "console" : "orchestrator"}`);
      }
    }
  }
  return found;
}

const packDirs = existsSync(PACKS_DIR) ? readdirSync(PACKS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
const packs = [];
for (const d of packDirs) {
  if (!existsSync(path.join(PACKS_DIR, d, "pack.json"))) { fail(`packs/${d}`, "a pack directory needs a pack.json"); continue; }
  const p = loadPack(d);
  if (p) packs.push(p);
}
const hostIds = new Set(packs.filter((p) => p.host).map((p) => p.id));
const webPacks = !opt("--packs") ? checkSideCode(WEB_PACKS, "web", hostIds) : [];
const orchPacks = !opt("--packs") ? checkSideCode(ORCH_PACKS, "orchestrator", hostIds) : [];
for (const id of webPacks) if (!existsSync(path.join(WEB_PACKS, id, "index.ts"))) fail(`web/src/packs/${id}`, "a console pack's entry is index.ts (its pages, nav and landing)");
for (const id of orchPacks) if (!existsSync(path.join(ORCH_PACKS, id, "main.ts"))) fail(`orchestrator/packs/${id}`, "an orchestrator pack's entry is main.ts");

// Nor may it name a shell table: pack "api" would own api_keys, and its migrations could then alter or re-secure it.
const SHELL_TABLES = new Set(["pack_schema_migrations", "schema_migrations"]);
for (const f of existsSync(path.join(ROOT, "sql", "migrations")) ? readdirSync(path.join(ROOT, "sql", "migrations")).filter((x) => x.endsWith(".sql")) : [])
  for (const m of readFileSync(path.join(ROOT, "sql", "migrations", f), "utf8").matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)/gi))
    SHELL_TABLES.add(m[1].toLowerCase());
// The shell's own functions (its migrations define them): no host pack may declare one (mold_v0-049).
const SHELL_FUNCTIONS = new Set();
for (const f of existsSync(path.join(ROOT, "sql", "migrations")) ? readdirSync(path.join(ROOT, "sql", "migrations")).filter((x) => x.endsWith(".sql")) : [])
  for (const m of readFileSync(path.join(ROOT, "sql", "migrations", f), "utf8").matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)/gi))
    SHELL_FUNCTIONS.add(m[1].toLowerCase());
for (const p of packs) {
  const clash = [...SHELL_TABLES].filter((t) => t.startsWith(`${p.id}_`));
  if (clash.length) fail(`packs/${p.id}`, `its table prefix ${p.id}_ is taken by the shell's ${clash.join(", ")}: choose another id`);
  for (const t of p.schema?.tables ?? []) {
    if (SHELL_TABLES.has(t)) fail(`packs/${p.id}/pack.json`, `host.schema.tables: ${t} is a shell table`);
    for (const q of packs) if (`${t}`.startsWith(`${q.id}_`) && q !== p) fail(`packs/${p.id}/pack.json`, `host.schema.tables: ${t} is named with pack ${q.id}'s prefix`);
    for (const q of packs) if (q !== p && q.schema?.tables.includes(t)) fail(`packs/${p.id}/pack.json`, `host.schema.tables: ${t} is also pack ${q.id}'s`);
  }
  for (const fn of p.schema?.functions ?? []) if (SHELL_FUNCTIONS.has(fn)) fail(`packs/${p.id}/pack.json`, `host.schema.functions: ${fn} is a shell function`);
}
// One pack's table prefix may not be another's (pack "a" would own "a_b_…", pack "a_b"'s tables).
for (const a of packs) for (const b of packs) if (a !== b && `${b.id}_`.startsWith(`${a.id}_`)) fail(`packs/${b.id}`, `its id starts with pack ${a.id}'s table prefix ${a.id}_`);

/**
 * The profile's optional `limits` (mold_v0-018, src/rate-limits.ts): sections mcp, endpoints and runs of positive
 * numbers, and plans.<plan name> with the same sections. Only the names the shell knows; checked here so a typo fails
 * the build rather than silently keeping a default.
 */
const LIMIT_KEYS = {
  mcp: ["per_key_per_minute", "per_member_per_minute", "per_workspace_per_minute", "per_ip_per_minute", "concurrent_per_workspace", "max_request_bytes", "max_response_bytes"],
  endpoints: ["signup_per_hour_per_ip", "invites_per_hour_per_workspace", "keys_per_hour_per_workspace",
    "signin_per_hour_per_ip", "signin_checks_per_hour_per_ip", "signin_codes_per_hour_per_address"],
  runs: ["budget_usd_max", "concurrency_per_workspace", "kind_month_budget_usd", "live_per_workspace"],
};
function limitsProblem(v, plans = true) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object";
  for (const [section, body] of Object.entries(v)) {
    if (section === "plans" && plans) {
      if (!body || typeof body !== "object" || Array.isArray(body)) return "plans must be an object of plan name -> limits";
      for (const [name, p] of Object.entries(body)) { const bad = limitsProblem(p, false); if (bad) return `plans.${name}: ${bad}`; }
      continue;
    }
    if (!LIMIT_KEYS[section]) return `unknown section ${section} (known: ${Object.keys(LIMIT_KEYS).join(", ")}${plans ? ", plans" : ""})`;
    if (!body || typeof body !== "object" || Array.isArray(body)) return `${section} must be an object`;
    for (const [k, n] of Object.entries(body)) {
      if (!LIMIT_KEYS[section].includes(k)) return `${section}.${k} is not a limit (known: ${LIMIT_KEYS[section].join(", ")})`;
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return `${section}.${k} must be a positive number`;
    }
  }
  return null;
}

/** profile.json `source_offer` (mold_v0-050): null when it is well formed, else what is wrong. */
const SPDX = /^(?=.{1,80}$)\(?[A-Za-z0-9][A-Za-z0-9.+-]*\)?( (AND|OR|WITH) \(?[A-Za-z0-9][A-Za-z0-9.+-]*\)?)*$/;
function sourceOfferProblem(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object {app, upstreams}";
  for (const k of Object.keys(v)) if (k !== "app" && k !== "upstreams" && k !== "$comment") return `unknown field ${k} (known: app, upstreams)`;
  // The packs whose pinned upstream is the licensor's own project (mold_v0-099): {"<pack id>": "licensor_owned"}, each a
  // pack of this build that pins an upstream (an id that is not would hide nothing, or something later added by mistake).
  if (v.upstreams !== undefined) {
    const u = v.upstreams;
    if (!u || typeof u !== "object" || Array.isArray(u) || !Object.keys(u).length) return 'upstreams must be an object {"<pack id>": "licensor_owned"}';
    for (const [id, how] of Object.entries(u)) {
      if (how !== "licensor_owned") return `upstreams.${String(id).slice(0, 40)} must be "licensor_owned"`;
      const pk = packs.find((p) => p.id === id);
      if (!pk) return `upstreams names ${String(id).slice(0, 40)}, which is not a pack of this build`;
      if (!pk.manifest.upstream) return `upstreams names ${id}, whose pack.json pins no upstream`;
    }
  }
  const a = v.app;
  if (a === undefined || a === "licensor_exception") return null;
  if (!a || typeof a !== "object" || Array.isArray(a)) return 'app must be "licensor_exception" or {url, license}';
  for (const k of Object.keys(a)) if (k !== "url" && k !== "license") return `app: unknown field ${k} (known: url, license)`;
  if (typeof a.url !== "string" || !/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~%/+=-]*)?$/.test(a.url) || a.url.length > 300) return "app.url must be an https:// address of the source (no query, no user or password)";
  if (typeof a.license !== "string" || !SPDX.test(a.license)) return "app.license must be an SPDX licence id or expression";
  return null;
}

/**
 * deploy-facts.json (mold_v0-050): what the factory knows from the app's state about where this build is deployed, written
 * into the build copy before the generators run (.claude/scripts/packs.py). Names, places and providers only: every value
 * is a short word, a name, a host or an https:// address without a user, password or query, and each secret is a NAME.
 * Anything else is refused, so a value can never be carried into the build by this file. -> the facts or null.
 */
function readFacts() {
  if (!existsSync(FACTS_FILE)) return null;
  const where = rel(FACTS_FILE);
  const f = readJson(FACTS_FILE, where);
  if (!f) return null;
  const WORD = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$/, HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/, URL_ = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/, SECRET = /^[A-Z][A-Z0-9_]{1,62}$/;
  const SOURCE = /^[A-Za-z0-9 .,_:/()<>'-]{1,300}$/;
  const shape = {
    $comment: "text", app_id: "id", target: ["vercel", "compose_remote"], source: "source",
    vercel: { team: "word", api_project: "word", web_project: "word", production_url: "url", api_url: "url", function_region: "word" },
    server: { provider: "word", host: "host", domain: "host", region: "word", compose_project: "word" },
    database: { provider: "word", exposure: "word", resource: "word", region: "word" },
    object_store: { provider: "word", bucket: "word", region: "word" },
    secret_store: "word", secrets: { required: "names", optional: "names" },
  };
  const ok = {
    text: (x) => typeof x === "string" && x.length <= 2000, id: (x) => typeof x === "string" && ID.test(x), word: (x) => x === null || (typeof x === "string" && WORD.test(x)),
    host: (x) => x === null || (typeof x === "string" && HOST.test(x)), url: (x) => x === null || (typeof x === "string" && URL_.test(x)),
    source: (x) => typeof x === "string" && SOURCE.test(x), names: (x) => Array.isArray(x) && x.length <= 200 && x.every((n) => typeof n === "string" && SECRET.test(n)),
  };
  const walkFacts = (obj, spec, at) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return fail(where, `${at || "the file"} must be an object`);
    for (const [k, v] of Object.entries(obj)) {
      const s = spec[k], here = at ? `${at}.${k}` : k;
      if (s === undefined) fail(where, `unknown field ${here}: deploy facts carry names, places and providers only`);
      else if (Array.isArray(s)) { if (!s.includes(v)) fail(where, `${here} must be one of ${s.join(", ")}`); }
      else if (typeof s === "object") walkFacts(v, s, here);
      else if (!ok[s](v)) fail(where, `${here} is not a ${s === "names" ? "list of secret NAMES (A-Z, 0-9, _)" : s === "url" ? "an https:// address with no path, user or query" : s} (a deploy fact is never a value)`);
    }
  };
  walkFacts(f, shape, "");
  for (const k of ["app_id", "target", "source", "database", "object_store", "secret_store", "secrets"]) if (f[k] === undefined) fail(where, `${k} is required`);
  return f;
}
const deployFacts = readFacts();

/**
 * The profile's optional `billing` (mold_v0-019, src/run-charges.ts): price per run, off unless `enabled` is true.
 * Only the app's own profile.json may set it (a host pack's profile may not: a pack never turns billing on or widens
 * its rules). Checked here so a typo fails the build rather than billing differently than written.
 */
const BILLING_KEYS = ["$comment", "enabled", "currency", "max_fixed", "max_cost_plus_percent", "charge_failed_runs", "charge_cancelled_runs", "stripe_meter"];
function billingProblem(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object";
  for (const k of Object.keys(v)) if (!BILLING_KEYS.includes(k)) return `${k} is not a billing setting (known: ${BILLING_KEYS.slice(1).join(", ")})`;
  if (typeof v.enabled !== "boolean") return "enabled must be true or false";
  if (v.currency !== undefined && (typeof v.currency !== "string" || !/^[a-z]{3}$/.test(v.currency))) return "currency must be a currency code in lower case, e.g. usd";
  for (const k of ["max_fixed", "max_cost_plus_percent"])
    if (v[k] !== undefined && (typeof v[k] !== "number" || !Number.isFinite(v[k]) || v[k] < 0 || v[k] > (k === "max_fixed" ? 1_000_000 : 10_000))) return `${k} must be a number from 0 to ${k === "max_fixed" ? "1000000" : "10000"}`;
  for (const k of ["charge_failed_runs", "charge_cancelled_runs"]) if (v[k] !== undefined && typeof v[k] !== "boolean") return `${k} must be true or false`;
  if (v.stripe_meter !== undefined && (typeof v.stripe_meter !== "string" || !/^[a-z0-9_]{3,100}$/.test(v.stripe_meter))) return "stripe_meter must be an event name of lower-case letters, digits and underscores";
  return null;
}

/** The keys of an `export const NAME = { key: ..., ... }` block in a shell file: the one list both sides read. */
const blockKeys = (file, name) => {
  const m = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\}`).exec(readFileSync(path.join(ROOT, "src", file), "utf8"));
  return m ? [...m[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((x) => x[1]) : [];
};

/**
 * The profile's optional `email` (mold_v0-083, src/email.ts): `provider` (resend, test or none) and `notifications`
 * (the groups that are on besides sign-in codes and invitations, from src/email.ts NOTIFICATION_GROUPS, each once).
 */
function emailProblem(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object";
  for (const k of Object.keys(v)) if (!["$comment", "provider", "notifications", "pitch", "library_nouns"].includes(k)) return `${k} is not an email setting (known: provider, notifications, pitch, library_nouns)`;
  // What a library item of each kind is called (mold_v0-101): kind -> a word of the build's.
  if (v.library_nouns !== undefined) {
    if (!v.library_nouns || typeof v.library_nouns !== "object" || Array.isArray(v.library_nouns)) return "library_nouns: an object of kind -> words";
    for (const [k, x] of Object.entries(v.library_nouns)) if (!/^[a-z][a-z_]{0,30}$/.test(k) || wordProblem(x)) return `library_nouns.${k.slice(0, 40)}: a kind (lowercase) -> ${wordProblem(x) ?? "words"}`;
  }
  // The welcome email's pitch (mold_v0-101, src/email.ts): plain text on one line; placeholders are filled from the words.
  if (v.pitch !== undefined && (typeof v.pitch !== "string" || !v.pitch.trim() || v.pitch.length > 400 || /[\u0000-\u001f\u007f<>]/.test(v.pitch))) return "pitch: plain text on one line, up to 400 characters, no < or >";
  if (v.provider !== undefined && !["resend", "test", "none"].includes(v.provider)) return "provider must be resend, test or none";
  const groups = blockKeys("email.ts", "NOTIFICATION_GROUPS");
  if (v.notifications !== undefined) {
    if (!Array.isArray(v.notifications) || new Set(v.notifications).size !== v.notifications.length) return "notifications must be a list of groups, each once";
    const bad = v.notifications.filter((g) => !groups.includes(g));
    if (bad.length) return `notifications: ${bad.map(String).join(", ").slice(0, 120)} ${bad.length === 1 ? "is not a group" : "are not groups"} (known: ${groups.join(", ")})`;
  }
  return null;
}

/**
 * The profile's optional `entitlements` (mold_v0-083, src/entitlements.ts): `plans` (name -> {features, run_charges?})
 * and `without_plan` (one of them). Features from src/entitlements.ts FEATURES, each once. Every plan `limits.plans`
 * names must be declared here too (else its limits could never apply). Only the app's own profile.json sets it.
 */
const PLAN_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/;
function entitlementsProblem(v, limits) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "must be an object";
  for (const k of Object.keys(v)) if (!["$comment", "plans", "without_plan"].includes(k)) return `${k} is not an entitlements setting (known: plans, without_plan)`;
  if (!v.plans || typeof v.plans !== "object" || Array.isArray(v.plans) || !Object.keys(v.plans).length) return "plans must be an object of plan name -> {features, run_charges}";
  const features = blockKeys("entitlements.ts", "FEATURES");
  for (const [name, p] of Object.entries(v.plans)) {
    if (!PLAN_NAME.test(name) || name === "__proto__") return `plans: ${JSON.stringify(name.slice(0, 60))} is not a plan name (letters, digits, space, _ . -; up to 60)`;
    if (!p || typeof p !== "object" || Array.isArray(p)) return `plans.${name} must be an object {features, run_charges}`;
    for (const k of Object.keys(p)) if (!["features", "run_charges"].includes(k)) return `plans.${name}.${k} is not a plan setting (known: features, run_charges)`;
    if (!Array.isArray(p.features) || new Set(p.features).size !== p.features.length) return `plans.${name}.features must be a list of features, each once`;
    const bad = p.features.filter((f) => !features.includes(f));
    if (bad.length) return `plans.${name}.features: ${bad.map(String).join(", ").slice(0, 120)} (known: ${features.join(", ")})`;
    if (p.run_charges !== undefined && !["charged", "included"].includes(p.run_charges)) return `plans.${name}.run_charges must be charged or included`;
  }
  if (typeof v.without_plan !== "string" || !Object.hasOwn(v.plans, v.without_plan)) return "without_plan must name one of the plans (the plan of a workspace with no live subscription)";
  const undeclared = Object.keys(limits?.plans ?? {}).filter((n) => !Object.hasOwn(v.plans, n));
  if (undeclared.length) return `limits.plans names ${undeclared.join(", ").slice(0, 120)}, which entitlements.plans does not declare (its limits would never apply)`;
  return null;
}

let profile = { ...DEFAULT_PROFILE };
/** The profile's own `words` (mold_v0-100): profile.json `words` (the app's) and a host pack's `host.profile.words` (its engine's). */
const appWords = {}, hostWords = {};
/** profile.json `landing` (mold_v0-091): the app's own landing block, over a pack's; checked and written below, never part of the profile modules. */
let profileLanding;
/** profile.json `legal` (mold_v0-109, src/legal.ts): the app's legal pages; checked here, never part of the profile modules. */
let profileLegal = null;
/** profile.json `console` (mold_v0-130, src/console-pages.ts): the shell pages the app hides, joined with its packs'. */
let profileConsole;
/** profile.json `access_request` (mold_v0-102, src/access-request.ts): the app's own request fields, which replace the packs'. */
let profileAccess;
// A host pack's own profile (mold_v0-039) comes under profile.json: the product's names when the build has no brand of
// its own, the brand's (written to profile.json by the factory) when it has one. At most one host pack brings one.
const hostProfiles = packs.filter((p) => p.host?.profile);
if (hostProfiles.length > 1) fail("profile", `host packs ${hostProfiles.map((p) => p.id).join(" and ")} both bring a profile`);
{
  const filePf = existsSync(PROFILE_FILE) ? readJson(PROFILE_FILE, rel(PROFILE_FILE)) : null;
  const pf = { ...(hostProfiles[0]?.host.profile ?? {}), ...(filePf && typeof filePf === "object" && !Array.isArray(filePf) ? filePf : {}) };
  if (filePf && (typeof filePf !== "object" || Array.isArray(filePf))) fail(rel(PROFILE_FILE), "must be an object");
  if (hostProfiles[0]?.host.profile?.billing !== undefined) fail(`packs/${hostProfiles[0].id}`, "host.profile may not set billing: only the app's own profile.json turns billing on");
  if (hostProfiles[0]?.host.profile?.legal !== undefined) fail(`packs/${hostProfiles[0].id}`, "host.profile may not set legal: only the app's own profile.json names the company behind it (mold_v0-109)");
  if (hostProfiles[0]?.host.profile?.access_request !== undefined) fail(`packs/${hostProfiles[0].id}`, "host.profile may not set access_request: a pack declares its request fields in pack.json `access_request` (mold_v0-102)");
  if (hostProfiles[0]?.host.profile?.landing !== undefined) fail(`packs/${hostProfiles[0].id}`, "host.profile may not set landing: a pack declares its landing page in pack.json `landing` (mold_v0-091)");
  if (hostProfiles[0]?.host.profile?.source_offer?.upstreams !== undefined) fail(`packs/${hostProfiles[0].id}`, "host.profile may not set source_offer.upstreams: only the app's own profile.json says an upstream is its licensor's own (mold_v0-099)");
  if (hostProfiles[0]?.host.profile?.entitlements !== undefined) fail(`packs/${hostProfiles[0].id}`, "host.profile may not set entitlements: only the app's own profile.json says what each plan unlocks");
  {
    for (const [k, v] of Object.entries(pf)) {
      if (k === "$comment") continue;
      // The app's words (mold_v0-100, src/words.ts): the shell's word keys (and their plurals) -> the app's word.
      if (k === "words") {
        const known = new Set([...WORD_KEYS, ...WORD_KEYS.map((w) => `${w}s`)]);
        for (const [where, layer, into] of [[`packs/${hostProfiles[0]?.id}: host.profile`, hostProfiles[0]?.host.profile?.words, hostWords], [rel(PROFILE_FILE), filePf?.words, appWords]]) {
          if (layer === undefined) continue;
          if (!layer || typeof layer !== "object" || Array.isArray(layer)) { fail(where, "words: an object of shell word -> the app's word"); continue; }
          for (const [w, x] of Object.entries(layer)) {
            if (!known.has(w)) fail(where, `words.${w}: not a shell word (known: ${[...known].join(", ")})`);
            else if (wordProblem(x)) fail(where, `words.${w}: ${wordProblem(x)}`);
            else into[w] = x.trim();
          }
        }
        continue;
      }
      // Which packs may be host packs (read above, before the packs): a list of pack ids, never shown.
      if (k === "host_packs") { if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !ID.test(x))) fail(rel(PROFILE_FILE), "host_packs: a list of pack ids"); continue; }
      if (k === "limits") { const bad = limitsProblem(v); if (bad) fail(rel(PROFILE_FILE), `limits: ${bad}`); else profile.limits = v; continue; }
      if (k === "billing") { const bad = billingProblem(v); if (bad) fail(rel(PROFILE_FILE), `billing: ${bad}`); else profile.billing = v; continue; }
      // The email adapter (mold_v0-083): a host pack's profile may set it (the product's notifications), the app's wins.
      if (k === "email") { const bad = emailProblem(v); if (bad) fail(rel(PROFILE_FILE), `email: ${bad}`); else profile.email = v; continue; }
      if (k === "entitlements") { const bad = entitlementsProblem(v, pf.limits); if (bad) fail(rel(PROFILE_FILE), `entitlements: ${bad}`); else profile.entitlements = v; continue; }
      // The customer MCP server's own version and instructions (mold_v0-060), optional: absent, the shell's.
      if (k === "mcp_server_version") { if (typeof v !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}([-+][0-9A-Za-z.-]{1,40})?$/.test(v)) fail(rel(PROFILE_FILE), "mcp_server_version: a version like 1.2.3"); else profile[k] = v; continue; }
      if (k === "mcp_instructions") {
        if (typeof v !== "string" || !v.trim() || v.length > 4000 || /[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u.test(v)) fail(rel(PROFILE_FILE), "mcp_instructions: plain text of up to 4000 characters");
        else profile[k] = v;
        continue;
      }
      // Where the build's own source is offered (mold_v0-050, src/source-offer.ts), optional: {app: {url, license}} or
      // {app: "licensor_exception"} (the licensor's additional permission applies to this deployment, and it says so).
      if (k === "source_offer") { const bad = sourceOfferProblem(v); if (bad) fail(rel(PROFILE_FILE), `source_offer: ${bad}`); else profile[k] = v; continue; }
      // Per-member API keys (mold_v0-099, src/member-keys.ts): false turns them off; absent or true, as before.
      if (k === "member_keys") { if (typeof v !== "boolean") fail(rel(PROFILE_FILE), "member_keys: true or false (false: no member API keys; clients sign in)"); else profile[k] = v; continue; }
      // The app's landing page (mold_v0-091, src/landing.ts): checked with the packs' blocks below.
      if (k === "landing") { profileLanding = v; continue; }
      // The shell pages the customer console hides (mold_v0-130, src/console-pages.ts): joined with the packs' below.
      if (k === "console") { const bad = consoleProblems(v, "profile.json"); if (bad.length) for (const b of bad) fail(rel(PROFILE_FILE), b); else profileConsole = v; continue; }
      // The access-request form's own fields (mold_v0-102, src/access-request.ts): checked with the packs' below.
      if (k === "access_request") { profileAccess = v; continue; }
      // The app's legal pages (mold_v0-109, src/legal.ts): written to legal.generated.ts below, never to the profile modules.
      if (k === "legal") { const bad = legalProblems(v); if (bad.length) for (const b of bad) fail(rel(PROFILE_FILE), b); else profileLegal = legalOf(v); continue; }
      // The clients the install pages offer (mold_v0-010), optional: absent, every client src/connect-catalog.ts lists.
      if (k === "install_clients") {
        const known = [...readFileSync(path.join(ROOT, "src", "connect-catalog.ts"), "utf8").matchAll(/\{ id: "([a-z0-9-]+)"/g)].map((m) => m[1]).filter((id) => id !== "header");
        const bad = Array.isArray(v) ? v.filter((x) => !known.includes(x)) : null;
        if (!Array.isArray(v) || !v.length || new Set(v).size !== v.length || bad.length)
          fail(rel(PROFILE_FILE), `install_clients: a list of client ids, each once, from ${known.join(", ")}${bad?.length ? ` (not one: ${bad.map(String).join(", ").slice(0, 200)})` : ""}`);
        else profile[k] = v;
        continue;
      }
      if (!PROFILE_KEYS.includes(k)) fail(rel(PROFILE_FILE), `unknown field ${k} (known: ${PROFILE_KEYS.join(", ")}, limits, billing, email, entitlements, mcp_server_version, mcp_instructions, install_clients, source_offer, member_keys, landing, legal, console, access_request, words)`);
      else if (typeof v !== "string" || !v.trim()) fail(rel(PROFILE_FILE), `${k} must be text`);
      else profile[k] = v;
    }
  }
}
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile.mcp_server_name)) fail("profile", "mcp_server_name: lowercase letters, digits and -");
if (/[<>"\r\n]/.test(profile.email_sender_name)) fail("profile", "email_sender_name may not contain < > \" or line breaks");
if (!/^[^\s@<>]+@[^\s@<>]+$/.test(profile.email_from_address)) fail("profile", "email_from_address must be an address");

await checkGraphs();

const refuse = () => {
  if (!problems.length) return;
  console.error(`gen-packs: refused (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
};
refuse();

/**
 * The titles of the customer guide's pages the console writes from the packs' declarations (mold_v0-106;
 * web/src/content/customer-guide.ts reads them from pack-guides.generated.ts), in the build's words: a pack's own guide
 * page may not take one.
 */
const GUIDE_TITLES = Object.fromEntries(Object.entries({ start: "Getting started", console: "Your console", records: "Records", runs: "{Runs}", tools: "MCP tools", account: "Your account" })
  .map(([k, t]) => [k, fillWith(resolveWords([appWords, hostWords, ...packs.map((p) => p.manifest.words)]), profile.name, t)]));

// ---------- each pack's definition: its pack.json's declarations (mold_v0-057) extended by its code entry ----------
// Record areas (mold_v0-047), credentials (mold_v0-034) and onboarding (mold_v0-011) are read from it for the console.

/**
 * Each pack's pack.json checked against its schema (src/pack-manifest.ts) and compiled into definePack fields, its
 * entry (when it has one) loaded once through tsx as the server loads it, the two merged and checked as the server will
 * (src/pack-api.ts validatePack): what the console needs, and the compiled declarations for the registry.
 */
function readDefinitions() {
  if (!packs.length) return {};
  const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) { fail("packs", `reading the packs' definitions needs tsx (${rel(tsx)}): run npm ci`); return {}; }
  const dir = mkdtempSync(path.join(tmpdir(), "gen-packs-"));
  try {
    const script = path.join(dir, "definitions.mts");
    writeFileSync(script, `import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const [api, manifestApi, specApi, entries, pages, catalogApi, shellToolsApi, offerApi, wordsApi, words, product, guideApi, guideTitles] = JSON.parse(readFileSync(process.argv[2], "utf8"));
const MARK = process.argv[3];
const { RecordAreaSchema, CredentialSchema, OnboardingStepSchema, validatePack } = await import(pathToFileURL(api).href);
const { compileDeclarations, mergePack, PackJsonError } = await import(pathToFileURL(manifestApi).href);
const { checkViews, viewsOf, tabRoles, tabLabel, tabEmpty, tabAreas, tabColumns, metricRoles, metricUnit } = await import(pathToFileURL(specApi).href);
const { fillWith } = await import(pathToFileURL(wordsApi).href);
const { upstreamProblems } = await import(pathToFileURL(offerApi).href);
const { compileGuide } = await import(pathToFileURL(guideApi).href);
const out = {};
const loaded = [];
for (const [id, json, file] of entries) {
  let declared;
  try { declared = compileDeclarations(json); }
  catch (e) { out[id] = { json: e instanceof PackJsonError ? e.problems : [String(e?.message ?? e)] }; continue; }
  try {
    let code = null;
    if (file) { const m = await import(pathToFileURL(file).href); code = m.default?.default ?? m.default ?? null; }
    const def = validatePack(mergePack(id, declared, code));
    if (def.id !== id) throw new Error(\`its entry defines pack \${JSON.stringify(def.id)}; the ids must match\`);
    // The source offer names the commit that runs (mold_v0-050): an agent kind on the upstream's repository runs its pin.
    const offerProblems = upstreamProblems([{ id, manifest: { name: json.name, upstream: json.upstream }, definition: def }]);
    if (offerProblems.length) throw new Error(offerProblems.join("; "));
    loaded.push({ id, name: json.name, words: json.words ?? {}, definition: def });
    out[id] = { declared, areas: (def.recordAreas ?? []).map((a) => RecordAreaSchema.parse(a)),
      credentials: (def.credentials ?? []).map((c) => CredentialSchema.parse(c)).map((c) => ({ name: c.name, label: c.label })),
      onboarding: (def.onboarding ?? []).map((st) => OnboardingStepSchema.parse(st)).map((st) => ({ id: st.id })),
      metrics: (def.metrics ?? []).map((x) => ({ name: x.name, over: x.over })),
      argRefs: [...(def.jobKinds ?? []), ...(def.agentJobKinds ?? [])].flatMap((k) => (k.args ?? []).filter((a) => a.type === "reference").map((a) => ({ kind: k.name, arg: a.name, to: a.to }))),
      store: (def.agentJobKinds ?? []).length > 0 || (def.jobKinds ?? []).some((k) => k.workspace === true),
      resultChecks: def.runResults?.check ?? [],
      kinds: [...(def.jobKinds ?? []), ...(def.agentJobKinds ?? [])].map((k) => ({ name: k.name, label: k.label ?? null, runner: k.runner, entry: k.entry ?? null, validator: k.validator ?? null, tools: k.agent?.tools ?? [] })),
      // The customer guide (mold_v0-106): the pack's own pages (pack.json guide, checked: src/pack-guide.ts) and what the
      // console's generated pages say of it, in its declared words.
      guide: json.guide === undefined ? null : compileGuide(json.guide, guideTitles),
      facts: {
        name: json.name, description: json.description ?? null,
        onboarding: (def.onboarding ?? []).map((st) => OnboardingStepSchema.parse(st)).map((st) => ({ id: st.id, label: st.label, help: st.help ?? null, prompt: st.prompt ?? null })),
        kinds: [...(def.jobKinds ?? []), ...(def.agentJobKinds ?? [])].map((k) => ({ name: k.name, label: k.label ?? null, description: k.description ?? null,
          credentials: k.credentials ?? [], report: k.report ? (k.report.label ?? "") : null, approval: k.approval ? k.approval.preview : null })),
        credentials: (def.credentials ?? []).map((c) => CredentialSchema.parse(c)).map((c) => ({ name: c.name, label: c.label, help: c.help ?? null, bound_to: c.bound_to, area: c.area ?? null })),
        schedules: (def.schedules ?? []).map((x) => ({ name: x.name, label: x.label ?? null, job_kind: x.job_kind, cron: x.cron, area: x.assets?.area ?? null, enabled: x.enabled !== false })),
      } };
  } catch (e) { out[id] = { error: String(e?.message ?? e).slice(0, 3000) }; }
}
// Metrics, charts and tabs across the build (mold_v0-063, 058): checked together once every pack loaded.
let views = { problems: [], metrics: [], charts: [], tabs: [] };
let b = null;
if (loaded.length === entries.length) {
  b = viewsOf(loaded, pages);
  const problems = checkViews(b);
  const over = (m) => b.areas.find((a) => a.name === m.over) ?? m.over;
  views = { problems,
    metrics: b.metrics.map((m) => ({ pack: m.pack, name: m.name, label: m.label, unit: metricUnit(m, over(m)), roles: metricRoles(m, b.areas) })),
    charts: b.charts.map((c) => ({ pack: c.pack, name: c.name, title: c.title, description: c.description ?? null, type: c.type, metrics: c.metrics, palette: c.palette })),
    // An area tab's columns, resolved; a merged tab (mold_v0-135) also by its own area (the first) and its areas, each
    // with its rows and source word.
    tabs: problems.length ? [] : b.tabs.map((t) => ({ ...t, label: tabLabel(t, b), roles: tabRoles(t, b),
      ...(t.kind === "area" ? { columns: tabColumns(t, b.areas) } : {}), ...(t.areas ? { area: tabAreas(t)[0].area, areas: tabAreas(t) } : {}) })) };
}
// The MCP tools generated from the declarations (mold_v0-060, src/mcp-catalog.ts), across the build's packs: each
// pack's mcp settings name real tools, names fit, no two take one name, and none takes a name of the shell's own tools
// (src/shell-tools.ts, mold_v0-067: refused here at build, not only when the server starts). The tools the settings
// withhold (exclude, admin_only) also withhold their console tabs (below).
const { generateCatalog } = await import(pathToFileURL(catalogApi).href);
const { SHELL_TOOL_NAMES, RECORD_TOOL_NAMES, ADMIN_SHELL_TOOL_NAMES } = await import(pathToFileURL(shellToolsApi).href);
const mcp = { problems: [], withheld: [], tools: [], records: [] };
if (loaded.length === entries.length) {
  const shell = [...SHELL_TOOL_NAMES, ...RECORD_TOOL_NAMES];
  const own = new Map();
  for (const p of loaded) for (const t of p.definition.tools ?? []) {
    if (!t || typeof t.name !== "string") continue;
    if (shell.includes(t.name)) mcp.problems.push(\`pack \${p.id}: tool \${t.name} is already a shell tool\`);
    else if (own.has(t.name)) mcp.problems.push(\`pack \${p.id}: tool \${t.name} is already pack \${own.get(t.name)}'s\`);
    else own.set(t.name, p.id);
  }
  const catalog = generateCatalog(loaded, { customer: shell, admin: ADMIN_SHELL_TOOL_NAMES });
  mcp.problems.push(...catalog.problems);
  // The packs' declared slash commands (mold_v0-137, pack.json mcp.prompts): one name, one pack.
  const promptOwner = new Map();
  for (const p of loaded) for (const pr of p.definition.mcp?.prompts ?? []) {
    if (promptOwner.has(pr.name)) mcp.problems.push(\`pack \${p.id}: prompt \${pr.name} is already pack \${promptOwner.get(pr.name)}'s\`);
    else promptOwner.set(pr.name, p.id);
  }
  mcp.withheld = catalog.withheld;
  // Each tab's empty state (mold_v0-107), in the build's words: an area is addable when its create tool is on the customer MCP.
  const addable = new Set(catalog.tools.filter((t) => t.op === "create" && t.door === "workspace" && !t.admin_only).map((t) => t.area));
  if (b) views.tabs = views.tabs.map((t) => ({ ...t, empty: tabEmpty(t, b, { addable: (a) => addable.has(a), fill: (x) => fillWith(words, product, x) }) }));
  // The generated tools a workspace's client sees (mold_v0-106: the guide groups the tools by what they reach).
  mcp.tools = catalog.tools.filter((t) => t.door === "workspace" && !t.admin_only).map((t) => ({ name: t.name, pack: t.pack, op: t.op, area: t.area ?? null, kind: t.kind ?? null }));
  mcp.records = [...RECORD_TOOL_NAMES];
}
process.stdout.write("\\n" + MARK + " " + JSON.stringify({ packs: out, views, mcp }) + "\\n");
`);
    // The packs' pack.json files go in a file (an argument is limited to 128 KiB); the answer comes back on a line marked
    // with a one-time word, so nothing a pack's entry prints while it loads can stand in for it.
    const input = path.join(dir, "input.json"), mark = `PACK_DEFINITIONS_${randomBytes(12).toString("hex")}`;
    writeFileSync(input, JSON.stringify([PACK_API, path.join(ROOT, "src", "pack-manifest.ts"), path.join(ROOT, "src", "metric-spec.ts"),
      packs.map((p) => [p.id, p.json, p.manifest.entry === null ? null : path.join(p.dir, p.manifest.entry)]),
      Object.fromEntries(packs.map((p) => [p.id, p.pages.filter((pg) => pg.area === "app").map((pg) => pg.id)])),
      path.join(ROOT, "src", "mcp-catalog.ts"), path.join(ROOT, "src", "shell-tools.ts"), path.join(ROOT, "src", "source-offer.ts"),
      WORDS_ENGINE, resolveWords([appWords, hostWords, ...packs.map((p) => p.manifest.words)]), profile.name, path.join(ROOT, "src", "pack-guide.ts"), Object.values(GUIDE_TITLES)]));
    const r = spawnSync(tsx, [script, input, mark], { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    const line = (r.stdout ?? "").split("\n").findLast((l) => l.startsWith(`${mark} `));
    if (r.status !== 0 || !line) { fail("packs", `loading the packs' definitions failed: ${r.error ? `${r.error.code ?? ""} ${r.error.message} ` : ""}${((r.stderr ?? "") + (r.stdout ?? "")).trim().split("\n").slice(-6).join(" | ").slice(0, 1200)}`); return {}; }
    const { packs: got, views, mcp } = JSON.parse(line.slice(mark.length + 1));
    for (const pr of views.problems) fail("packs", pr);
    for (const pr of mcp.problems) fail("packs", pr);
    packViews = views;
    withheld = mcp.withheld;
    guideTools = { tools: mcp.tools, records: mcp.records };
    const empty = { declared: {}, areas: [], credentials: [], onboarding: [], metrics: [], argRefs: [], kinds: [], guide: null, facts: null };
    for (const [id, v] of Object.entries(got)) {
      if (v.json !== undefined) { for (const pr of v.json) fail(`packs/${id}/pack.json`, pr); got[id] = empty; }
      else if (v.error !== undefined) { fail(`packs/${id}`, `its definition does not load: ${v.error}`); got[id] = empty; }
      else for (const pr of v.guide?.problems ?? []) fail(`packs/${id}/pack.json`, pr);
    }
    // A declared kind's programs are files of the pack (a workspace-harness kind's entry and validator).
    for (const p of packs) for (const k of got[p.id]?.kinds ?? []) for (const f of [k.entry, k.validator])
      if (f && !existsSync(path.join(p.dir, f))) fail(`packs/${p.id}`, `job kind ${k.name}: ${f} is not a file of the pack`);
    return got;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** The build's metrics, charts and tabs (mold_v0-063, 058), as checked across every pack by src/metric-spec.ts. */
let packViews = { problems: [], metrics: [], charts: [], tabs: [] };
/**
 * The generated MCP tools the packs' mcp settings withhold (mold_v0-067, src/mcp-catalog.ts WithheldTool): their
 * console tabs are left out of the sidebar, as their routes answer 404 (src/mcp-withheld.ts). An area whose list tool
 * is withheld has no Records entry and no area tab; a pack whose runs list is withheld has no runs tab.
 */
let withheld = [];
/** The generated tools a workspace's client sees, and the shell's record tools (mold_v0-106: the guide's MCP tools page). */
let guideTools = { tools: [], records: [] };
const listWithheld = (area, op = "list") => withheld.some((w) => w.area === area && w.op === op);
const runsWithheld = (pack) => withheld.some((w) => w.pack === pack && w.op === "list_runs");
const defsByPack = readDefinitions();
const recordAreas = packs.flatMap((p) => (defsByPack[p.id]?.areas ?? []).map((a) => ({ pack: p.id, ...a })));
/** The credential fields the packs declare (mold_v0-034): the console's Credentials page appears when there is one. */
const credentialFields = packs.flatMap((p) => (defsByPack[p.id]?.credentials ?? []).map((c) => ({ pack: p.id, ...c })));
/** The onboarding steps the packs declare (mold_v0-011): the console's Setup page asks for them only when there is one. */
const onboardingSteps = packs.flatMap((p) => (defsByPack[p.id]?.onboarding ?? []).map((st) => ({ pack: p.id, ...st })));
/** Every reference an area makes: its links and its reference fields (mold_v0-057). */
const linksOf = (a) => [...(a.links ?? []), ...a.fields.filter((f) => f.type === "reference" && !(a.links ?? []).some((l) => l.field === f.name)).map((f) => ({ field: f.name, area: f.to }))];
/** Job kinds (mold_v0-041) and due-date areas (mold_v0-035): the console's Schedules and Notices pages appear with one. */
const jobKindCount = packs.reduce((n, p) => n + (defsByPack[p.id]?.kinds ?? []).filter((k) => k.runner === "workspace-harness").length, 0);
const dueAreaCount = recordAreas.filter((a) => a.due).length;
/**
 * The shell pages this build's customer console hides (mold_v0-130, src/console-pages.ts): the packs' pack.json `console`
 * and the app's profile.json `console`, joined. Each leaves the /app sidebar (below, the tabs, nav-config.ts) and redirects
 * to /app (pack-routes.generated.json).
 */
for (const p of packs) if (p.json?.console !== undefined) for (const b of consoleProblems(p.json.console, "pack.json")) fail(`packs/${p.id}`, b);
const HIDDEN = hiddenPages([...packs.map((p) => p.json?.console), profileConsole]);
/**
 * The access-request form's own fields (mold_v0-102, src/access-request.ts): the packs' pack.json `access_request` in pack
 * order (a key once in a build), or the app's profile.json `access_request` in their place. [] asks the shell's own only.
 */
const ACCESS_FIELDS = (() => {
  const r = joinAccessFields(packs.map((p) => ({ id: p.id, spec: p.json?.access_request })), profileAccess);
  for (const pr of r.problems) { const i = pr.indexOf(": "); fail(pr.slice(0, i), pr.slice(i + 2)); }
  return r.fields;
})();
const workspaceItems = [
  ...(credentialFields.length ? [{ title: "Credentials", url: "/app/credentials", icon: "lock", items: [] }] : []),
  ...(jobKindCount ? [{ title: "Schedules", url: "/app/schedules", icon: "calendar", items: [] }] : []),
  ...(dueAreaCount ? [{ title: "Notices", url: "/app/notices", icon: "notification", items: [] }] : []),
  // The workspace store's file viewer (mold_v0-056) when a pack has a workspace store.
  ...(packs.some((p) => defsByPack[p.id]?.store) ? [{ title: "Files", url: "/app/files", icon: "page", items: [] }] : []),
].filter((x) => !isHiddenUrl(x.url, HIDDEN));
{
  const owner = new Map();
  for (const a of recordAreas) {
    if (owner.has(a.name)) fail(`packs/${a.pack}`, `record area ${a.name} is already pack ${owner.get(a.name)}'s (area names are unique in a build)`);
    else owner.set(a.name, a.pack);
  }
  for (const a of recordAreas) for (const l of linksOf(a)) {
    if (!owner.has(l.area)) fail(`packs/${a.pack}`, `record area ${a.name} links field ${l.field} to area ${l.area}, which no pack declares`);
    // A shared row is every workspace's: it may not point at one workspace's records (mold_v0-057).
    else if (a.scope === "platform" && recordAreas.find((x) => x.name === l.area)?.scope === "workspace")
      fail(`packs/${a.pack}`, `record area ${a.name} is shared (platform) and its field ${l.field} refers to ${l.area}, a workspace's own area: a shared area may refer to shared areas only`);
  }
  // A job kind's reference argument names an area of this build (mold_v0-057).
  for (const p of packs) for (const x of defsByPack[p.id]?.argRefs ?? [])
    if (!owner.has(x.to)) fail(`packs/${p.id}`, `job kind ${x.kind}'s argument ${x.arg} refers to area ${x.to}, which no pack declares`);
  // The run-results mapping (mold_v0-061) names the record areas a result's check is in.
  for (const p of packs) for (const c of defsByPack[p.id]?.resultChecks ?? [])
    if (!owner.has(c)) fail(`packs/${p.id}`, `run_results.check names ${c}, which is not a record area of this build`);
  // Metrics, charts and tabs were checked across the build with the definitions (src/metric-spec.ts checkViews).
}
refuse();

// ---------- the landing page (mold_v0-091) ----------

/**
 * The landing block the console's / shows (src/landing.ts): a pack's pack.json `landing` with the app's profile.json
 * `landing` over it section by section, and the source offer's footer items (src/source-offer.ts offerFooterItems: the
 * same sentences the install pages' footer says). Both are read through tsx, as the packs' definitions are, and only when
 * there is something to read: with no block, no upstream and no source_offer the page is the neutral one and its footer
 * offers nothing. A pack's own block was checked with its pack.json (src/pack-manifest.ts); the profile's is checked here.
 */
function readLanding() {
  const declaring = packs.filter((p) => p.json && p.json.landing !== undefined);
  if (declaring.length > 1) fail("packs", `packs ${declaring.map((p) => p.id).join(" and ")} both declare a landing block: at most one pack of a build declares one (the app's profile.json landing changes it)`);
  const fromPack = declaring.length === 1 ? declaring[0].json.landing : null;
  const offerPacks = packs.filter((p) => p.manifest.upstream).map((p) => ({ id: p.id, manifest: { name: p.manifest.name, upstream: p.manifest.upstream }, definition: {} }));
  if (fromPack === null && profileLanding === undefined && !offerPacks.length && profile.source_offer === undefined) return { landing: null, offer: [] };
  const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) { fail("landing", `reading the landing block and the source offer needs tsx (${rel(tsx)}): run npm ci`); return { landing: null, offer: [] }; }
  const dir = mkdtempSync(path.join(tmpdir(), "gen-packs-landing-"));
  try {
    const script = path.join(dir, "landing.mts");
    writeFileSync(script, `import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
const [landingApi, offerApi, input] = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { landingProblems, mergeLanding } = await import(pathToFileURL(landingApi).href);
const { sourceOffer, offerFooterItems } = await import(pathToFileURL(offerApi).href);
const packBad = input.pack !== null && landingProblems(input.pack).length > 0;
const profileProblems = input.profile === null ? [] : landingProblems(input.profile);
const landing = packBad || profileProblems.length ? null : mergeLanding(input.pack, input.profile);
const offer = offerFooterItems(sourceOffer(input.packs, input.setting ?? undefined));
process.stdout.write("\\n" + process.argv[3] + " " + JSON.stringify({ profileProblems, landing, offer }) + "\\n");
`);
    const inputFile = path.join(dir, "input.json"), mark = `LANDING_${randomBytes(12).toString("hex")}`;
    writeFileSync(inputFile, JSON.stringify([path.join(ROOT, "src", "landing.ts"), path.join(ROOT, "src", "source-offer.ts"),
      { pack: fromPack, profile: profileLanding === undefined ? null : profileLanding, packs: offerPacks, setting: profile.source_offer ?? null }]));
    const r = spawnSync(tsx, [script, inputFile, mark], { cwd: ROOT, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    const line = (r.stdout ?? "").split("\n").findLast((l) => l.startsWith(`${mark} `));
    if (r.status !== 0 || !line) { fail("landing", `reading the landing block failed: ${((r.stderr ?? "") + (r.stdout ?? "")).trim().split("\n").slice(-6).join(" | ").slice(0, 1200)}`); return { landing: null, offer: [] }; }
    const got = JSON.parse(line.slice(mark.length + 1));
    for (const pr of got.profileProblems) fail(rel(PROFILE_FILE), pr);
    return { landing: got.landing, offer: got.offer };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const landingPage = readLanding();

/**
 * The AI clients the landing page may show (mold_v0-122: the hero's strip of logos, where_you_work): those the build's
 * install pages offer (src/connect-catalog.ts, narrowed by profile.json install_clients), in the catalog's order, each
 * with its short name ("Claude (web & desktop)" -> "Claude"). A where_you_work section that names a client the install
 * pages do not offer is refused: the page would send people to steps that are not there.
 */
const landingClients = [...readFileSync(path.join(ROOT, "src", "connect-catalog.ts"), "utf8").matchAll(/\{ id: "([a-z0-9-]+)", client: "([^"]+)", group: "(chat|agent|editor)"/g)]
  .filter((m) => m[1] !== "header" && (!profile.install_clients || profile.install_clients.includes(m[1])))
  .map((m) => ({ id: m[1], name: m[2].replace(/\s*\([^)]*\)\s*$/, ""), group: m[3] }));
for (const [i, s] of (landingPage.landing?.sections ?? []).entries()) {
  const off = (s.type === "where_you_work" ? s.clients ?? [] : []).filter((c) => !landingClients.some((k) => k.id === c));
  if (off.length) fail("landing", `sections[${i}] (where_you_work).clients: ${off.join(", ")} ${off.length > 1 ? "are" : "is"} not offered by this build's install pages (${landingClients.map((k) => k.id).join(", ")}; profile.json install_clients narrows them)`);
}
/** The hero section of the build's block, if it picks one (the welcome email's pitch is its subheadline). */
const landingHero = (landingPage.landing?.sections ?? []).find((s) => s.type === "hero") ?? null;
refuse();

// ---------- the share image (mold_v0-093) ----------

/**
 * What a shared link to this build shows (web/src/features/site/share-image.tsx draws it): the landing page's own words
 * (the hero's headline, else the profile's tagline; its sub-headline, else the console's description unless it only
 * repeats the headline: as web/src/features/site/landing.tsx resolves them) beside the profile's name, and an alternative
 * text in the same words. A brand that has its own picture (the factory's branding step copies it to brand/share-image.png:
 * a 1200x630 PNG of at most 1 MB) is served as it is instead, with the console's description as its alternative text.
 */
function readShareImage() {
  // The hero: the block's own (a block of ordered sections names it by its type).
  const block = landingPage.landing ?? {};
  const hero = block.hero ?? (Array.isArray(block.sections) ? block.sections.find((x) => x?.type === "hero") : null) ?? {};
  const headline = (hero.headline ?? profile.short_description).trim();
  const sub = hero.subheadline ?? (profile.console_description.toLowerCase().includes(headline.toLowerCase()) ? null : profile.console_description);
  const sentence = (t) => /[.!?…]$/.test(t) ? t : `${t}.`;
  const drawnAlt = [headline.toLowerCase().startsWith(profile.name.toLowerCase()) ? headline : `${profile.name}: ${headline}`, sub].filter(Boolean).map(sentence).join(" ");
  const spec = { alt: drawnAlt, name: profile.name, headline, subheadline: sub ?? null, brand: null };
  const file = path.resolve(opt("--share-image") ?? path.join(ROOT, "brand", "share-image.png"));
  const st = lstatOr(file), where = rel(file);
  if (!st) return spec;
  if (!st.isFile()) { fail(where, "the brand's share image must be a file (not a link or a directory)"); return spec; }
  if (st.size > 1024 * 1024) { fail(where, `the brand's share image is ${Math.ceil(st.size / 1024)} KB: at most 1024 KB`); return spec; }
  const png = readFileSync(file);
  const isPng = png.length > 24 && png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.subarray(12, 16).toString("latin1") === "IHDR";
  if (!isPng) { fail(where, "the brand's share image must be a PNG"); return spec; }
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (w !== 1200 || h !== 630) { fail(where, `the brand's share image is ${w}x${h}: it must be 1200x630`); return spec; }
  return { ...spec, alt: profile.console_description, brand: { png: png.toString("base64"), sha256: createHash("sha256").update(png).digest("hex") } };
}
function lstatOr(file) { try { return lstatSync(file); } catch { return null; } }
const shareImage = readShareImage();
refuse();

// ---------- output ----------

const HEADER = "// Generated by scripts/gen-packs.mjs from packs/*/pack.json and profile.json. Do not edit: run `npm run gen:packs`.\n";
const json = (v) => JSON.stringify(v, null, 2);
const importPath = (from, to) => { let r = posix(path.relative(path.dirname(from), to)).replace(/\.ts$/, ".js"); if (!r.startsWith(".")) r = `./${r}`; return r; };

const srcPacks = path.join(OUT, "src", "packs.generated.ts");
const files = new Map();
files.set(srcPacks, HEADER +
  packs.map((p, i) => p.manifest.entry === null ? "" : `import pack${i} from ${JSON.stringify(importPath(srcPacks, path.join(p.dir, p.manifest.entry)))};\n`).join("") +
  `\n/**\n * Every pack in this build, in pack order (by id): its pack.json, the definePack fields its declarations compile to\n` +
  ` * (mold_v0-057; null for none) and its code entry's definePack export (null for a pack.json alone). src/packs.ts merges and checks them.\n */\n` +
  `export const PACKS: readonly { readonly manifest: { id: string; name: string; version: string; entry: string | null; migrations: string | null; words: Record<string, string>; dir: string; upstream?: { repo: string; commit: string; license?: string } }; readonly declared: unknown; readonly definition: unknown }[] = [` +
  (packs.length ? `\n${packs.map((p, i) => `  { manifest: ${JSON.stringify(p.manifest)}, declared: ${Object.keys(defsByPack[p.id]?.declared ?? {}).length ? JSON.stringify(defsByPack[p.id].declared) : "null"}, definition: ${p.manifest.entry === null ? "null" : `pack${i}`} },`).join("\n")}\n` : "") + "];\n");
// The run tools the packs' agent kinds need (mold_v0-072; src/run-tools.ts): the runner image is built with exactly
// these (scripts/install-run-tools.ts, the Dockerfile), each at its pinned version and checksum.
files.set(path.join(OUT, "src", "run-tools.generated.json"), json({
  $comment: "Generated by scripts/gen-packs.mjs from the packs' agent job kinds (agent.tools). Do not edit: run npm run gen:packs. The runner image installs these (scripts/install-run-tools.ts).",
  tools: [...new Set(packs.flatMap((p) => (defsByPack[p.id]?.kinds ?? []).flatMap((k) => k.tools ?? [])))].sort(),
}) + "\n");
files.set(path.join(OUT, "src", "pack-migrations.generated.ts"), HEADER +
  "/** A host pack's own schema (mold_v0-049): its tables under their own names, its functions, the shell migrations it adopts. */\n" +
  "export interface HostSchema { readonly tables: readonly string[]; readonly functions: readonly string[]; readonly adopts: Readonly<Record<string, string>>; readonly platform_read: readonly string[]; readonly references: Readonly<Record<string, string>> }\n" +
  "/** Pack migration directories (relative to the codebase root), applied after the shell's in this order (src/migrate.ts). */\n" +
  `export const PACK_MIGRATION_DIRS: readonly { readonly pack: string; readonly dir: string; readonly schema?: HostSchema }[] = ${json(packs.filter((p) => p.migrationsDir).map((p) => ({ pack: p.id, dir: p.migrationsDir, ...(p.schema ? { schema: p.schema } : {}) })))};\n`);
// What the admin console's shared pages show for this build (mold_v0-104): the host pack's own tables (the console's
// copy of src/host-tables.ts reads them, so the session engine's sections show only in a build that has its tables)
// and every job kind the packs declare, with its label (the pack's runs, in its words, where those sections were).
files.set(path.join(OUT, "web", "src", "config", "build-facts.generated.ts"), HEADER +
  "/** A host pack's own tables (pack.json host.schema.tables), as src/pack-migrations.generated.ts lists them; none with zero packs. */\n" +
  `export const HOST_TABLES: readonly string[] = ${json(packs.flatMap((p) => p.schema?.tables ?? []))};\n` +
  "/** The packs' job kinds (jobKinds and agentJobKinds): the pack, the kind's name and its label (null: the name). */\n" +
  `export const JOB_KINDS: readonly { pack: string; name: string; label: string | null }[] = ${json(packs.flatMap((p) => (defsByPack[p.id]?.kinds ?? []).map((k) => ({ pack: p.id, name: k.name, label: k.label ?? null }))))};\n`);
// The host packs (mold_v0-039): their server entries, registered by src/hosts.ts (which a process's entry imports first).
const srcHosts = path.join(OUT, "src", "hosts.generated.ts");
const hostPacks = packs.filter((p) => p.host && p.host.entry);
files.set(srcHosts, HEADER +
  // First, before any host pack's module runs: the shell's env names under their old spelling too (src/host-env.ts).
  (hostPacks.length ? `import "./host-env.js";\n` : "") +
  hostPacks.map((p, i) => `import host${i} from ${JSON.stringify(importPath(srcHosts, path.join(p.dir, p.host.entry)))};\n`).join("") +
  (hostPacks.length ? "\n" : "") +
  "/** The host packs of this build (src/host.ts), in pack order; none with zero packs. */\n" +
  `export const HOSTS: readonly unknown[] = [${hostPacks.map((_p, i) => `host${i}`).join(", ")}];\n` +
  // Their pack.json engine.config (mold_v0-137), only when one declares it (a build without one writes what it did).
  (hostPacks.some((p) => p.engineConfig) ? "\n/** Each host pack's pack.json `engine.config` (mold_v0-137), by pack id: checked against its host entry's schema when it registers (src/host.ts). */\n" +
    `export const HOST_ENGINE_CONFIG: Readonly<Record<string, unknown>> = ${JSON.stringify(Object.fromEntries(hostPacks.filter((p) => p.engineConfig).map((p) => [p.id, p.engineConfig])), null, 2)};\n` : ""));
// Their console code (web/src/packs/<id>/index.ts) and orchestrator entries (orchestrator/packs/<id>/main.ts).
files.set(path.join(OUT, "web", "src", "config", "pack-web.generated.ts"), HEADER +
  "import type { HostWeb } from '@/features/packs/host-web';\n" +
  webPacks.map((id, i) => `import * as web${i} from '@/packs/${id}';\n`).join("") +
  "\n/** The host packs' console code (mold_v0-039): pages at their own URLs, sidebar entries, the landing page; none with zero packs. */\n" +
  `export const HOST_WEB: readonly HostWeb[] = [${webPacks.map((_id, i) => `web${i}.default`).join(", ")}];\n`);
// Their sidebar entries and the shell features they enable (web/src/packs/<id>/nav.ts), apart from their pages so the
// sidebar's bundle never carries the pages.
{
  const navs = webPacks.filter((id) => existsSync(path.join(WEB_PACKS, id, "nav.ts")));
  files.set(path.join(OUT, "web", "src", "config", "pack-host-nav.generated.ts"), HEADER +
    navs.map((id, i) => `import * as nav${i} from '@/packs/${id}/nav';\n`).join("") +
    "\n/** The host packs' sidebar entries and console features (mold_v0-039; features/packs/host-nav.ts); none with zero packs. */\n" +
    `export const HOST_NAV: readonly unknown[] = [${navs.map((_id, i) => `nav${i}`).join(", ")}];\n`);
}
// Their customer guides (web/src/packs/<id>/guide.ts: pure TS, relative imports only, as the docs corpus reads it), and
// the other packs' guide (mold_v0-106): their own pages (pack.json guide) and the facts the console writes its generated
// pages from, or null (zero packs, or a host pack's guide: the shell's or the host's guide, unchanged).
{
  const guides = webPacks.filter((id) => existsSync(path.join(WEB_PACKS, id, "guide.ts")));
  const packGuide = guides.length ? null : packGuideData();
  refuse();
  files.set(path.join(OUT, "web", "src", "config", "pack-guides.generated.ts"), HEADER +
    guides.map((id, i) => `import * as guide${i} from '../packs/${id}/guide';\n`).join("") +
    "\n/** The host packs' customer guides (mold_v0-039): the first replaces the shell's (src/content/customer-guide.ts). */\n" +
    `export const HOST_GUIDES: readonly unknown[] = [${guides.map((_id, i) => `guide${i}`).join(", ")}];\n\n` +
    "/**\n * The packs' customer guide (mold_v0-106; src/pack-guide.ts, web/src/content/customer-guide.ts PackGuideData): their own\n" +
    " * pages from pack.json `guide` and what the pages generated from their declarations say; null: no pack, or a host pack's guide.\n */\n" +
    `export const PACK_GUIDE: unknown = ${json(packGuide)};\n`);
}
/**
 * Flat console URLs (mold_v0-132): a pack's customer page and each tab with a page of its own (overview, area, runs,
 * reports) is at /app/<id> (web/src/app/app/[page]), not /app/packs/<pack>/<id>. So an id is refused when it is a shell
 * page's (a folder of web/src/app/app: activity, billing, records...), a host pack's own page (its routes.json), or
 * another pack's page or tab. The old nested address redirects to the flat one (below).
 */
const SHELL_APP_DIR = path.join(ROOT, "web", "src", "app", "app");
const SHELL_APP_SEGMENTS = new Set(existsSync(SHELL_APP_DIR) ? readdirSync(SHELL_APP_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !/^[[(@_]/.test(e.name)).map((e) => e.name) : []);
// The nested addresses of before (they redirect) and the host page route stay the shell's.
for (const x of ["packs", "host"]) SHELL_APP_SEGMENTS.add(x);
/** The flat address of a pack's customer page or tab page: /app/<id>. */
const appPageUrl = (id) => `/app/${id}`;
/** Every flat customer page of the build: the packs' app pages, then the shown tabs with a page of their own. */
function flatAppPages() {
  return [...packs.flatMap((p) => p.pages.filter((pg) => pg.area === "app").map((pg) => ({ pack: pg.pack, id: pg.id, what: `app page ${pg.id}` }))),
    ...shownTabs().filter((t) => TAB_OWN_PAGE.has(t.kind)).map((t) => ({ pack: t.pack, id: t.id, what: `tab ${t.id}` }))];
}
const TAB_OWN_PAGE = new Set(["overview", "area", "runs", "reports"]);
{
  const hostSegments = new Map();
  for (const id of webPacks) {
    const file = path.join(WEB_PACKS, id, "routes.json");
    const r = existsSync(file) ? readJson(file, `web/src/packs/${id}/routes.json`) : {};
    for (const x of Array.isArray(r?.app) ? r.app : []) if (typeof x === "string") hostSegments.set(x.split("/")[0], id);
  }
  const owner = new Map();
  for (const f of flatAppPages()) {
    const at = `packs/${f.pack}/pack.json`, url = appPageUrl(f.id);
    if (SHELL_APP_SEGMENTS.has(f.id)) fail(at, `${f.what} would be at ${url}, which is the shell's own page: give it another id`);
    else if (hostSegments.has(f.id)) fail(at, `${f.what} would be at ${url}, which host pack ${hostSegments.get(f.id)}'s page is at: give it another id`);
    else if (owner.has(f.id) && owner.get(f.id).pack !== f.pack) fail(at, `${f.what} would be at ${url}, which pack ${owner.get(f.id).pack}'s ${owner.get(f.id).what} is at: give it another id`);
    else if (!owner.has(f.id)) owner.set(f.id, f);
  }
  refuse();
}
/**
 * The whole /app sidebar from the app's profile (mold_v0-133): profile.json `console.sidebar` (its shape checked with the
 * profile, src/console-pages.ts), resolved here. Each item is a shown tab of a pack (by id, or `<pack>/<id>` when two
 * packs have that id) or a shell page by its kind. Refused: an item that is neither, one listed twice, a tab left out
 * (the sidebar is the whole of it), a shell page the build lacks or hides, a shell page a pack's tab already opens.
 * null: no declared sidebar (the tabs' groups, else the shell's own sidebar).
 */
const SHELL_SIDEBAR = { setup: { label: "Setup", icon: "rocket" }, usage: { label: "Activity", icon: "chartLine" }, billing: { label: "Billing", icon: "billing" },
  profile: { label: "Profile", icon: "account" }, team: { label: "Team", icon: "teams" }, keys: { label: "API keys", icon: "lock" },
  credentials: { label: "Credentials", icon: "lock" }, schedules: { label: "Schedules", icon: "calendar" }, notices: { label: "Notices", icon: "notification" } };
{
  // API keys need member keys (mold_v0-133). (Two packs' tabs that open one shell page are one sidebar entry: below.)
  for (const t of shownTabs())
    if (t.kind === "keys" && profile.member_keys === false) fail(`packs/${t.pack}/pack.json`, `tab ${t.id}: member API keys are off (profile.json member_keys), so there is no API keys page`);
  refuse();
}
const profileSidebar = (() => {
  const declared = profileConsole?.sidebar;
  if (!declared) return null;
  const at = `${rel(PROFILE_FILE)} console.sidebar`;
  const tabs = shownTabs(), listed = new Set(), out = [];
  const homeSetup = tabs.some((t) => t.kind === "overview" && (t.include ?? []).includes("setup"));
  const lacks = { credentials: !credentialFields.length && "the build declares no credential field", schedules: !jobKindCount && "the build has no job kind to schedule",
    notices: !dueAreaCount && "the build has no due dates", setup: homeSetup && "a home tab includes the Setup page's checklist (/app leads there): list that tab",
    keys: profile.member_keys === false && "member API keys are off (profile.json member_keys)" };
  declared.forEach((g, i) => {
    const items = [];
    for (const [j, x] of g.items.entries()) {
      const w = `${at}[${i}].items[${j}] ${JSON.stringify(x)}`;
      const [pk, id] = x.includes("/") ? x.split("/") : [null, x];
      const found = tabs.filter((t) => t.id === id && (pk === null || t.pack === pk));
      if (found.length > 1) { fail(w, `packs ${found.map((t) => t.pack).join(" and ")} both have a tab ${id}: name it as <pack>/${id}`); continue; }
      let item;
      if (found.length === 1) item = { tab: found[0] };
      else if (pk === null && SIDEBAR_SHELL_PAGES.includes(id)) {
        const opener = tabs.find((t) => t.kind === id);
        if (opener) { fail(w, `tab ${opener.id} of pack ${opener.pack} opens that page: list the tab (${opener.pack}/${opener.id})`); continue; }
        if (lacks[id]) { fail(w, `${lacks[id]}, so there is no ${SHELL_SIDEBAR[id].label} page to list`); continue; }
        if (TAB_KIND_PAGE[id] && HIDDEN.includes(TAB_KIND_PAGE[id])) { fail(w, `the build hides that page (console.hide)`); continue; }
        item = { shell: id };
      } else {
        const hiddenTab = packViews.tabs.find((t) => t.id === id && (pk === null || t.pack === pk));
        fail(w, hiddenTab ? `tab ${id} of pack ${hiddenTab.pack} is not shown in this build (its list tool is withheld, or the page it opens is hidden)` : `no pack has a tab ${id}, and it is not a shell page (${SIDEBAR_SHELL_PAGES.join(", ")})`);
        continue;
      }
      const key = item.tab ? `${item.tab.pack}/${item.tab.id}` : `shell:${item.shell}`;
      if (listed.has(key)) { fail(w, "listed twice: each entry is in the sidebar once"); continue; }
      listed.add(key);
      items.push(item);
    }
    out.push({ label: g.label, items });
  });
  for (const t of tabs) if (!listed.has(`${t.pack}/${t.id}`)) fail(at, `tab ${t.id} of pack ${t.pack} is not in it: the declared sidebar is the whole sidebar, so list it in a group`);
  refuse();
  return out;
})();
// Their console URLs (web/src/packs/<id>/routes.json): each rewritten to the shell's host page route, and their redirects.
{
  const rewrites = [], redirects = [], seenUrl = new Set();
  const ROUTE_PATH = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
  for (const id of webPacks) {
    const file = path.join(WEB_PACKS, id, "routes.json");
    const r = existsSync(file) ? readJson(file, `web/src/packs/${id}/routes.json`) : {};
    if (!r || typeof r !== "object") continue;
    for (const [area, prefix, to] of [["app", "/app/", `/app/host/${id}/`], ["admin", "/admin/", `/admin/host/${id}/`], ["site", "/", `/host/${id}/`]]) {
      for (const p of Array.isArray(r[area]) ? r[area] : []) {
        if (typeof p !== "string" || !ROUTE_PATH.test(p) || p.startsWith("host/") || p === "host") { fail(`web/src/packs/${id}/routes.json`, `${area}: ${JSON.stringify(p)} is not a page path`); continue; }
        const source = prefix + p;
        if (seenUrl.has(source)) fail(`web/src/packs/${id}/routes.json`, `${source} is claimed twice`);
        seenUrl.add(source);
        rewrites.push({ source, destination: to + p });
      }
    }
    for (const x of Array.isArray(r.redirects) ? r.redirects : []) {
      if (!x || typeof x.source !== "string" || typeof x.destination !== "string" || !x.source.startsWith("/") || !x.destination.startsWith("/")) { fail(`web/src/packs/${id}/routes.json`, "a redirect is {source, destination, permanent} with paths on this site"); continue; }
      redirects.push({ source: x.source, destination: x.destination, permanent: x.permanent !== false });
    }
  }
  // A home tab (mold_v0-134): an overview that includes the Setup page's checklist or the notices is where /app or
  // /app/notices (and every address under it) now leads; a hidden page (mold_v0-130) leads to the console's home.
  const home = Object.fromEntries(["setup", "notices"].map((x) => {
    const t = shownTabs().find((y) => y.kind === "overview" && (y.include ?? []).includes(x));
    return [x, t ? appPageUrl(t.id) : null];
  }));
  // The nested addresses pack pages and tabs had before mold_v0-132 lead to their flat ones (bookmarks, old links).
  for (const f of flatAppPages()) redirects.push({ source: `/app/packs/${f.pack}/${f.id}`, destination: appPageUrl(f.id), permanent: false });
  if (home.setup) redirects.push({ source: "/app", destination: home.setup, permanent: false });
  if (home.notices) redirects.push(...["/app/notices", "/app/notices/:path*"].map((source) => ({ source, destination: home.notices, permanent: false })));
  redirects.push(...hiddenRedirects(HIDDEN.filter((h) => !(h === "notices" && home.notices)), home.setup ?? "/app"));
  refuse();
  files.set(path.join(OUT, "web", "src", "config", "pack-routes.generated.json"), JSON.stringify({ $comment: "Generated by scripts/gen-packs.mjs from web/src/packs/*/routes.json (mold_v0-039). Do not edit: run npm run gen:packs.", rewrites, redirects }, null, 2) + "\n");
}
if (existsSync(path.join(OUT, "orchestrator")))
  files.set(path.join(OUT, "orchestrator", "packs.generated.ts"), HEADER +
    "/** The host packs' orchestrator entries (mold_v0-039), relative to orchestrator/: main.ts runs the first, else the deterministic worker. */\n" +
    `export const ORCHESTRATOR_ENTRIES: readonly string[] = ${JSON.stringify(orchPacks.map((id) => `./packs/${id}/main.ts`))};\n`);
files.set(path.join(OUT, "src", "deploy-facts.generated.ts"), HEADER +
  "/** The deploy facts the factory wrote into this build copy (deploy-facts.json, mold_v0-050), read by src/data-map.ts; null without them. */\n" +
  `export const DEPLOY_FACTS: unknown = ${deployFacts ? json(deployFacts) : "null"};\n`);
// The build's words (mold_v0-100): the profile's own layer for the server (which lays it over the packs it loads,
// src/vocabulary.ts), the resolved words for the console, and the engine's own source for the console to run.
const buildWords = resolveWords([appWords, hostWords, ...packs.map((p) => p.manifest.words)]);
files.set(path.join(OUT, "src", "vocabulary.generated.ts"), HEADER +
  "/** The app's own words (profile.json `words`), laid over the host pack's and the packs' by src/vocabulary.ts. */\n" +
  `export const PROFILE_WORDS: Readonly<Record<string, string>> = ${json(appWords)};\n` +
  "/** A host pack's words for its own engine (host.profile.words): the shared copy's, never the generic run engine's pages'. */\n" +
  `export const HOST_WORDS: Readonly<Record<string, string>> = ${json(hostWords)};\n`);
files.set(path.join(OUT, "web", "src", "config", "vocabulary.generated.ts"), HEADER +
  "/** The build's words (src/words.ts: the neutral BASE, under the packs' pack.json words, under the profile's), for the console. */\n" +
  `export const WORDS = ${json(buildWords)} as const;\n`);
files.set(path.join(OUT, "web", "src", "lib", "words.generated.ts"),
  HEADER.replace("from packs/*/pack.json and profile.json", "from src/words.ts (a copy, so the console runs the server's words engine)") + readFileSync(WORDS_ENGINE, "utf8"));
files.set(path.join(OUT, "src", "profile.generated.ts"), HEADER +
  "/** The profile (profile.json over the neutral default): the names the shell shows. Read through src/profile.ts. */\n" +
  `export const GENERATED_PROFILE = ${json(profile)} as const;\n`);
// The emails' pitch (mold_v0-101): the landing block's hero subheadline, in a module of its own so the landing block
// never reaches the profile modules (the MCP surface and the console's names).
files.set(path.join(OUT, "src", "email-pitch.generated.ts"), HEADER +
  "/** The landing block's hero subheadline (mold_v0-101): the welcome email's pitch when the profile has no email.pitch (src/email.ts); null without one. */\n" +
  `export const GENERATED_EMAIL_PITCH: string | null = ${JSON.stringify(landingHero?.subheadline ?? null)};\n`);

const nav = (area) => {
  const groups = new Map();
  for (const p of packs) for (const pg of p.pages.filter((x) => x.area === area)) {
    if (!groups.has(pg.nav_group)) groups.set(pg.nav_group, []);
    groups.get(pg.nav_group).push({ title: pg.title, url: packPageUrl(pg), ...(pg.icon ? { icon: pg.icon } : {}), items: [] });
  }
  return [...groups].map(([label, items]) => ({ label, items }));
};
const allPages = packs.flatMap((p) => p.pages);
/** A pack page's address: flat in the customer console (mold_v0-132), /admin/packs/<pack>/<id> in the admin console. */
function packPageUrl(pg) { return pg.area === "app" ? appPageUrl(pg.id) : `/admin/packs/${pg.pack}/${pg.id}`; }
files.set(path.join(OUT, "web", "src", "config", "pack-nav.generated.ts"), HEADER +
  "import type { NavGroup } from '@/types';\n\n" +
  "/**\n * A pack's console page: the shell's generic page (app/app/[page], flat since mold_v0-132; app/admin/packs/[pack]/[page])\n" +
  " * shows the rows its data route returns.\n */\n" +
  "export interface PackPage {\n  pack: string;\n  id: string;\n  area: 'app' | 'admin';\n  /** Its address: /app/<id>, or /admin/packs/<pack>/<id>. */\n  url: string;\n  title: string;\n  description: string | null;\n  data: string;\n  columns: { key: string; label: string }[];\n}\n\n" +
  `export const packPages: PackPage[] = ${json(allPages.map(({ nav_group: _g, icon: _i, ...pg }) => ({ ...pg, url: packPageUrl(pg) })))};\n\n` +
  "/** Sidebar groups the packs add to /app (after the shell's own). */\n" +
  `export const packPortalNav: NavGroup[] = ${json(nav("app"))};\n\n` +
  "/** Sidebar groups the packs add to /admin (after the shell's own). */\n" +
  `export const packAdminNav: NavGroup[] = ${json(nav("admin"))};\n\n` +
  "/** A record area a pack declares (mold_v0-047): the shell's generic list and detail pages (app/{app,admin}/records/[area]). */\n" +
  "export interface RecordAreaSpec {\n  pack: string;\n  name: string;\n  label: string;\n  description: string | null;\n  role: 'source' | 'check' | 'asset';\n" +
  "  scope: 'platform' | 'workspace';\n  fields: RecordFieldSpec[];\n  list_columns: string[];\n  links: { field: string; area: string }[];\n" +
  "  lifecycle: { field: string; initial: string; transitions: { from: '*' | string[]; to: string; label?: string; roles?: string[] }[] } | null;\n}\n\n" +
  "/** A field of a record area (typed by mold_v0-057). */\n" +
  "export interface RecordFieldSpec {\n  name: string;\n  label: string;\n  type: string;\n  help?: string;\n  required?: boolean;\n" +
  "  options?: (string | { value: string; label?: string })[];\n  to?: string;\n  multiple?: boolean;\n  min?: number;\n  max?: number;\n  max_length?: number;\n}\n\n" +
  `export const recordAreas: RecordAreaSpec[] = ${json(recordAreas.map((a) => ({ pack: a.pack, name: a.name, label: a.label, description: a.description ?? null, role: a.role,
    scope: a.scope, fields: a.fields, list_columns: a.list_columns ?? a.fields.slice(0, 4).map((f) => f.name), links: linksOf(a), lifecycle: a.lifecycle ?? null })))};\n\n` +
  "/** The /app sidebar's Records group: every area (a workspace reads shared areas and its own). */\n" +
  `export const recordPortalNav: NavGroup[] = ${json(recordAreas.some((a) => !listWithheld(a.name)) ? [{ label: "Records", items: recordAreas.filter((a) => !listWithheld(a.name)).map((a) => ({ title: a.label, url: `/app/records/${a.name}`, items: [] })) }] : [])};\n\n` +
  "/** The areas whose export_<area> tool a pack withholds (mold_v0-108, mold_v0-067): their console pages offer no Export CSV. */\n" +
  `export const exportWithheldAreas: string[] = ${json(recordAreas.filter((a) => listWithheld(a.name, "export")).map((a) => a.name))};\n\n` +
  "/** The /admin sidebar's Records group: the platform-scope areas staff maintain. */\n" +
  `export const recordAdminNav: NavGroup[] = ${json(recordAreas.some((a) => a.scope === "platform" && !listWithheld(a.name, "admin_list")) ? [{ label: "Records", items: recordAreas.filter((a) => a.scope === "platform" && !listWithheld(a.name, "admin_list")).map((a) => ({ title: a.label, url: `/admin/records/${a.name}`, items: [] })) }] : [])};\n\n` +
  "/** The /app sidebar's Workspace group: Credentials (mold_v0-034) when a pack declares a credential field, Schedules\n" +
  " * (mold_v0-035) when the build has a job kind, Notices when a check area declares due dates, Files (mold_v0-056)\n" +
  " * when a pack has a workspace store. */\n" +
  `export const workspacePortalNav: NavGroup[] = ${json(workspaceItems.length ? [{ label: "Workspace", items: workspaceItems }] : [])};\n\n` +
  "/** How many onboarding steps the packs declare (mold_v0-011): 0 leaves the Setup page exactly as the shell's. */\n" +
  `export const packOnboardingSteps = ${onboardingSteps.length};\n\n` +
  "/** How many data repositories the packs declare (mold_v0-129): the admin console's Data repositories page shows with one. */\n" +
  `export const repositoryCount = ${packs.reduce((n, p) => n + Object.keys(p.json?.repositories ?? defsByPack[p.id]?.repositories ?? {}).length, 0)};\n\n` +
  "/** The shell's customer pages this build hides (mold_v0-130, src/console-pages.ts): left out of the sidebar, redirected to /app. */\n" +
  `export const hiddenConsoleUrls: string[] = ${json(HIDDEN.map((h) => CONSOLE_PAGES[h]))};\n` +
  // The neutral Activity pages (mold_v0-008): tool calls and run spend per member, run and workspace, once a pack adds
  // tools or runs. With zero packs the sidebar is the shell's own.
  // A build that hides the customer's Activity page (mold_v0-130) keeps the staff's. A host pack's mcp block (mold_v0-137:
  // its server instructions and slash commands) adds no tool or run, so it alone does not count.
  (packs.some((p) => p.manifest.entry !== null || Object.keys(defsByPack[p.id]?.declared ?? {}).some((k) => !(p.host && k === "mcp"))) ? "\n/** The Activity pages (mold_v0-008): in the sidebar when the build has a pack (a pack with tools or declarations: a host pack's own pages are its own). */\n" +
    `export const usagePortalNav: NavGroup[] = ${json(HIDDEN.includes("activity") ? [] : [{ label: "Activity", items: [{ title: "Activity", url: "/app/activity", icon: "chartLine", items: [] }] }])};\n` +
    `export const usageAdminNav: NavGroup[] = ${json([{ label: "Activity", items: [{ title: "Activity", url: "/admin/activity", icon: "chartLine", items: [] }] }])};\n`
    : "\n/** The Activity pages (mold_v0-008): in the sidebar when the build has a pack (a pack with tools or declarations: a host pack's own pages are its own). */\nexport const usagePortalNav: NavGroup[] = [];\nexport const usageAdminNav: NavGroup[] = [];\n") +
  viewsModule());
// The share image (mold_v0-093; web/src/features/site/share-image.tsx): its words and alternative text, or the brand's own picture.
files.set(path.join(OUT, "web", "src", "config", "share-image.generated.ts"), HEADER +
  "import type { ShareImageSpec } from '@/features/site/share-image-types';\n\n" +
  "/** The share image (mold_v0-093): drawn from these words and the build's brand, or the brand's own picture (brand/share-image.png). */\n" +
  `export const shareImage: ShareImageSpec = ${json(shareImage)};\n`);
files.set(path.join(OUT, "web", "src", "config", "landing.generated.ts"), HEADER +
  "import type { LandingBlock, LandingClient, OfferFooterItem } from '@/features/site/landing-types';\n\n" +
  "/** The landing block (mold_v0-091, mold_v0-122; src/landing.ts): a pack's pack.json `landing` with profile.json `landing` over it, as sections; null: the neutral page. */\n" +
  `export const landing: LandingBlock | null = ${json(landingPage.landing)};\n\n` +
  "/** The AI clients the install pages offer (src/connect-catalog.ts, profile.json install_clients), for the landing page's logos (mold_v0-122). */\n" +
  `export const landingClients: readonly LandingClient[] = ${json(landingClients)};\n\n` +
  "/** The source offer's footer items (src/source-offer.ts offerFooterItems), as the install pages say them; [] when nothing is offered. */\n" +
  `export const sourceOfferItems: readonly OfferFooterItem[] = ${json(landingPage.offer)};\n`);
// The access-request form's own fields (mold_v0-102, src/access-request.ts), checked above; []: the shell's own fields only.
files.set(path.join(OUT, "src", "access-request.generated.ts"), HEADER +
  "import type { AccessField } from \"./access-request.js\";\n\n" +
  "/** The access-request form's own fields (mold_v0-102): the packs' pack.json access_request, or profile.json's; [] without. */\n" +
  `export const GENERATED_ACCESS_FIELDS: readonly AccessField[] = ${json(ACCESS_FIELDS)};\n`);
files.set(path.join(OUT, "web", "src", "config", "access-request.generated.ts"), HEADER +
  "import type { AccessField } from '@/lib/access-request.generated';\n\n" +
  "/** The access-request form's own fields (mold_v0-102, src/access-request.ts): the request form asks them, /admin/requests labels them. */\n" +
  `export const accessFields: readonly AccessField[] = ${json(ACCESS_FIELDS)};\n`);
files.set(path.join(OUT, "web", "src", "lib", "access-request.generated.ts"),
  HEADER.replace("from packs/*/pack.json and profile.json", "from src/access-request.ts (a copy, so the console runs the server's rules)") + readFileSync(ACCESS_REQUEST, "utf8"));
// The legal pages (mold_v0-109, src/legal.ts): the app's own `legal`, checked above; null: no legal pages, no links.
files.set(path.join(OUT, "src", "legal.generated.ts"), HEADER +
  "import type { Legal } from \"./legal.js\";\n\n" +
  "/** profile.json `legal` (mold_v0-109, src/legal.ts): the install pages' footer links; null: no legal pages. */\n" +
  `export const GENERATED_LEGAL: Legal | null = ${json(profileLegal)};\n`);
files.set(path.join(OUT, "web", "src", "config", "legal.generated.ts"), HEADER +
  "import type { Legal } from '@/features/site/legal-types';\n\n" +
  "/** profile.json `legal` (mold_v0-109, src/legal.ts): /terms, /privacy, their links and the sitemap; null: no legal pages. */\n" +
  `export const legal: Legal | null = ${json(profileLegal)};\n`);
files.set(path.join(OUT, "web", "src", "config", "profile.generated.ts"), HEADER +
  "/** The profile (profile.json over the neutral default), for the console's title and descriptions. */\n" +
  `export const profile = ${json((({ limits: _l, billing: _b, email: _e, entitlements: _n, ...p }) => p)(profile))} as const;\n`);

/**
 * The customer guide of a build whose packs bring no guide code (mold_v0-106): each pack's own pages (pack.json guide,
 * checked by src/pack-guide.ts) and the facts web/src/content/customer-guide.ts writes the generated pages from: what
 * the app is, its onboarding steps, the console's tabs, its record areas, the job kinds a workspace may start, its
 * credentials and schedules, and the generated MCP tools by what they reach. Only what a workspace is offered: an area
 * whose list tool, a kind whose start tool the pack withholds (mcp exclude, admin_only) is left out, with its schedules
 * and the credentials only such kinds use. Null with zero packs (the shell's own guide).
 */
function packGuideData() {
  if (!packs.length) return null;
  const facts = packs.map((p) => ({ p, f: defsByPack[p.id]?.facts ?? null, g: defsByPack[p.id]?.guide ?? null }));
  const pages = [], groups = [], seen = new Map();
  for (const { p, g } of facts) {
    for (const grp of g?.groups ?? []) if (!groups.includes(grp)) groups.push(grp);
    for (const pg of g?.pages ?? []) {
      if (seen.has(pg.slug)) { fail(`packs/${p.id}/pack.json`, `guide page ${JSON.stringify(pg.title)}: pack ${seen.get(pg.slug)} has a page at the same address (/app/docs/${pg.slug})`); continue; }
      seen.set(pg.slug, p.id);
      pages.push(pg);
    }
  }
  const areaLabel = (name) => recordAreas.find((a) => a.name === name)?.label ?? name;
  const tools = guideTools.tools;
  const startOf = (pack, kind) => tools.find((t) => t.pack === pack && t.op === "start" && t.kind === kind)?.name ?? null;
  const kinds = facts.flatMap(({ p, f }) => (f?.kinds ?? []).map((k) => ({ pack: p.id, ...k, start: startOf(p.id, k.name) })));
  const offered = kinds.filter((k) => k.start);
  const credentialLabel = (pack, name) => facts.find((x) => x.p.id === pack)?.f?.credentials.find((c) => c.name === name)?.label ?? name;
  const kindLabel = (k) => k.label ?? k.name.replace(/_/g, " ");
  const label = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const chartTitle = (name) => packViews.charts.find((c) => c.name === name)?.title ?? name;
  const optionOf = (o) => (typeof o === "string" ? { value: o, label: o } : { value: o.value, label: o.label ?? o.value });
  return {
    titles: GUIDE_TITLES,
    generated: !facts.some(({ g }) => g && g.generated === false),
    groups,
    pages,
    packs: facts.map(({ p, f }) => ({ id: p.id, name: f?.name ?? p.manifest.name, description: f?.description ?? null })),
    onboarding: facts.flatMap(({ f }) => (f?.onboarding ?? []).map((st) => ({ label: st.label, help: st.help, prompt: st.prompt }))),
    get_started: tools.filter((t) => t.op === "get_started").map((t) => t.name),
    tabs: shownTabs().map((t) => ({ group: t.group ?? "", label: t.label, kind: t.kind, description: t.description ?? null,
      ...(t.kind === "area" ? { area: t.area } : {}), charts: (t.charts ?? []).map(chartTitle), ...(t.include?.length ? { include: t.include } : {}) })),
    areas: recordAreas.filter((a) => !listWithheld(a.name)).map((a) => {
      const opts = (fl) => (fl?.options ?? []).map(optionOf);
      const lc = a.lifecycle, lcField = lc ? a.fields.find((fl) => fl.name === lc.field) : null;
      const state = (v) => opts(lcField).find((o) => o.value === v)?.label ?? v;
      return {
        name: a.name, label: a.label, description: a.description ?? null, scope: a.scope, role: a.role, sealed: a.sealed === true || a.role === "asset",
        fields: a.fields.map((fl) => ({ label: fl.label, type: fl.type, help: fl.help ?? null, required: fl.required === true,
          options: opts(fl).map((o) => o.label), to: fl.to ? areaLabel(fl.to) : linksOf(a).some((l) => l.field === fl.name) ? areaLabel(linksOf(a).find((l) => l.field === fl.name).area) : null, multiple: fl.multiple === true })),
        lifecycle: lc ? { field: lcField?.label ?? lc.field, initial: state(lc.initial), states: opts(lcField).map((o) => o.label),
          moves: lc.transitions.map((tr) => ({ label: tr.label ?? null, from: tr.from === "*" ? "*" : tr.from.map(state), to: state(tr.to) })) } : null,
        due: a.due ? { field: a.fields.find((fl) => fl.name === a.due.field)?.label ?? a.due.field, within_days: a.due.within_days ?? 7 } : null,
        tools: tools.filter((t) => t.area === a.name).map((t) => t.name),
      };
    }),
    kinds: offered.map((k) => ({ label: label(kindLabel(k)), description: k.description, credentials: k.credentials.map((c) => credentialLabel(k.pack, c)),
      report: k.report, start: k.start, approval: k.approval ? label(kindLabel(kinds.find((x) => x.pack === k.pack && x.name === k.approval) ?? { name: k.approval })) : null })),
    credentials: facts.flatMap(({ p, f }) => (f?.credentials ?? []).filter((c) => {
      const users = kinds.filter((k) => k.pack === p.id && k.credentials.includes(c.name));
      return !users.length || users.some((k) => k.start);
    }).map((c) => ({ label: c.label, help: c.help, bound_to: c.bound_to, area: c.area ? areaLabel(c.area) : null }))),
    schedules: facts.flatMap(({ p, f }) => (f?.schedules ?? []).flatMap((x) => {
      const k = offered.find((y) => y.pack === p.id && y.name === x.job_kind);
      return k ? [{ label: x.label ?? label(kindLabel(k)), kind: label(kindLabel(k)), cron: x.cron, area: x.area ? areaLabel(x.area) : null, enabled: x.enabled }] : [];
    })),
    tools: tools.map((t) => ({ name: t.name, op: t.op, area: t.area ? areaLabel(t.area) : null })),
    record_tools: guideTools.records,
  };
}

/** The declared tabs a workspace is shown: not one over an area or runs whose list tool the pack withholds (mold_v0-067). */
function shownTabs() {
  return packViews.tabs.filter((t) => !(t.kind === "area" && (t.areas ?? [{ area: t.area }]).some((a) => listWithheld(a.area))) && !(t.kind === "runs" && runsWithheld(t.pack))
    // nor one that opens a shell page the build hides (mold_v0-130)
    && !(TAB_KIND_PAGE[t.kind] && HIDDEN.includes(TAB_KIND_PAGE[t.kind])));
}

/**
 * The packs' metrics, charts and tabs for the console (mold_v0-063, 058): what each chart shows, and the declared tabs
 * as the /app sidebar (exactly those, in order, grouped) with each tab's page. With no tabs the sidebar is the shell's.
 */
function viewsModule() {
  const SHELL_PAGES = { credentials: "/app/credentials", usage: "/app/activity", schedules: "/app/schedules", notices: "/app/notices", setup: "/app", billing: "/app/billing", profile: "/app/profile", team: "/app/team", keys: "/app/keys" };
  const DEFAULT_ICONS = { overview: "dashboard", area: "kanban", runs: "play", reports: "page", credentials: "lock", usage: "chartLine", schedules: "calendar", notices: "notification", setup: "rocket", billing: "billing", profile: "account", team: "teams", keys: "lock", page: "page", files: "page" };
  // A tab over an area whose list tool, or over runs whose list tool, the pack withholds is not shown (mold_v0-067).
  const shown = shownTabs();
  const tabs = shown.map((t) => ({
    pack: t.pack, id: t.id, kind: t.kind, label: t.label, description: t.description ?? null, icon: t.icon ?? DEFAULT_ICONS[t.kind],
    url: t.kind === "files" ? `/app/files?store=${t.pack}` : SHELL_PAGES[t.kind] ?? appPageUrl(t.kind === "page" ? t.page : t.id), roles: t.roles,
    ...(t.kind === "area" ? { area: t.area, views: t.views ?? ["table", "detail"], board_by: t.board_by ?? (t.areas ? null : recordAreas.find((a) => a.name === t.area)?.lifecycle?.field ?? null), timeline_by: t.timeline_by ?? "updated",
      columns: t.columns, ...(t.areas ? { areas: t.areas.map((a) => ({ area: a.area, rows: a.rows, source: a.source ?? null })) } : {}) } : {}),
    charts: t.charts ?? [],
    ...(t.include?.length ? { include: t.include } : {}),
    ...(t.empty ? { empty: t.empty } : {}),
  }));
  const groups = [];
  // A declared sidebar (mold_v0-133): exactly its groups and entries, in order.
  if (profileSidebar) for (const g of profileSidebar) groups.push({ label: g.label, items: g.items.map((x) => {
    if (x.shell) return { title: SHELL_SIDEBAR[x.shell].label, url: SHELL_PAGES[x.shell], icon: SHELL_SIDEBAR[x.shell].icon, items: [], roles: ["viewer", "member", "billing", "owner"] };
    const t = tabs.find((y) => y.pack === x.tab.pack && y.id === x.tab.id);
    return { title: t.label, url: t.url, icon: t.icon, items: [], roles: t.roles };
  }) });
  // A page is in the sidebar once (mold_v0-133): packs written apart may each open the same shell page (Activity,
  // Billing); the first tab that opens it keeps its entry, a later one is left out of the sidebar.
  else for (const t of tabs.filter((x, i) => tabs.findIndex((y) => y.url === x.url) === i)) {
    const label = packViews.tabs.find((x) => x.pack === t.pack && x.id === t.id).group ?? "";
    // A group is one sidebar section: tabs of several packs naming it join it, in order of first appearance.
    let g = groups.find((x) => x.label === label);
    if (!g) { g = { label, items: [] }; groups.push(g); }
    g.items.push({ title: t.label, url: t.url, icon: t.icon, items: [], roles: t.roles });
  }
  return "\n/** A metric a pack declares (mold_v0-063): the console asks /api/metrics for its numbers. */\n" +
    "export interface PackMetricSpec {\n  pack: string;\n  name: string;\n  label: string;\n  unit: 'count' | 'number' | 'usd' | 'percent' | 'percent_100' | 'days' | 'hours';\n  roles: string[];\n}\n" +
    `export const packMetrics: PackMetricSpec[] = ${json(packViews.metrics)};\n\n` +
    "/** A chart of a pack's metrics (mold_v0-063), drawn by web/src/features/tabs/charts.tsx. */\n" +
    "export interface PackChartSpec {\n  pack: string;\n  name: string;\n  title: string;\n  description: string | null;\n  type: 'bar' | 'stacked_bar' | 'line' | 'area' | 'number' | 'table';\n  metrics: string[];\n  palette: 'categorical' | 'ordinal';\n}\n" +
    `export const packCharts: PackChartSpec[] = ${json(packViews.charts)};\n\n` +
    "/** A console tab a pack declares (mold_v0-058): its sidebar entry and its page (web/src/features/tabs/tab-page.tsx). */\n" +
    "export interface PackTabSpec {\n  pack: string;\n  id: string;\n  kind: 'overview' | 'area' | 'runs' | 'reports' | 'credentials' | 'usage' | 'schedules' | 'notices' | 'setup' | 'billing' | 'profile' | 'team' | 'keys' | 'page' | 'files';\n" +
    "  label: string;\n  description: string | null;\n  icon: string;\n  url: string;\n  roles: string[];\n  area?: string;\n  views?: ('table' | 'board' | 'timeline' | 'detail')[];\n" +
    "  /** An area tab's table columns: fields of its areas (a merged tab: also source). */\n  columns?: string[];\n" +
    "  /** A merged tab's areas (mold_v0-135), its own first: rows by key from each, fields from the first with a value. */\n" +
    "  areas?: { area: string; rows: 'all' | 'matched'; source: string | null }[];\n" +
    "  board_by?: string | null;\n  timeline_by?: string;\n  charts: string[];\n" +
    "  /** The shell's sections an overview shows above its charts, in order (mold_v0-134): the Setup page's checklist, the notices. */\n" +
    "  include?: ('setup' | 'notices')[];\n" +
    "  /** What the tab shows while it has nothing to show (mold_v0-107; src/metric-spec.ts tabEmpty): area, runs and reports tabs. */\n" +
    "  empty?: { title: string; text: string; cta: { label: string; href: string } | null };\n}\n" +
    `export const packTabs: PackTabSpec[] = ${json(tabs)};\n\n` +
    "/** The /app sidebar when packs declare tabs, or the profile the sidebar (mold_v0-133): exactly those, in order (empty: the shell's own sidebar). */\n" +
    `export const tabPortalNav: NavGroup[] = ${json(groups)};\n`;
}

let stale = 0;
for (const [file, text] of files) {
  const now = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (now === text) continue;
  if (CHECK) { stale++; console.error(`stale: ${posix(path.relative(OUT, file))}`); continue; }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote ${posix(path.relative(OUT, file))}`);
}
if (CHECK && stale) { console.error(`gen-packs: ${stale} generated file(s) differ from the packs and profile: run npm run gen:packs`); process.exit(1); }
console.log(`gen-packs: ${packs.length} pack(s)${packs.length ? ` (${packs.map((p) => p.id).join(", ")})` : ""}, ${allPages.length} page(s), ${recordAreas.length} record area(s), ${credentialFields.length} credential(s), ${onboardingSteps.length} onboarding step(s), ` +
  `${packs.filter((p) => p.manifest.migrations).length} with migrations${packViews.metrics.length + packViews.charts.length + packViews.tabs.length ? `, ${packViews.metrics.length} metric(s), ${packViews.charts.length} chart(s), ${packViews.tabs.length} tab(s)` : ""}; profile "${profile.name}"${CHECK ? "; generated files are current" : ""}`);
