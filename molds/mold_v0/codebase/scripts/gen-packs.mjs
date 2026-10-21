#!/usr/bin/env node
// The pack registry generator (mold_v0-038; molds/mold_v0/MOLD.md "Pack and record-area contract"). Reads every
// packs/<id>/pack.json in this build copy and profile.json, checks them, and writes what the server and the console
// import, so nothing in the shell names a pack:
//
//   src/packs.generated.ts               each pack's manifest and its entry module (definePack), in pack order
//   src/pack-migrations.generated.ts     the ordered list of pack migration directories (no pack code imported)
//   src/profile.generated.ts             the profile: product name, MCP server name, console title, email sender
//   web/src/config/pack-nav.generated.ts the packs' console pages and their sidebar entries (/app and /admin), and the
//                                        record areas they declare (mold_v0-047) with their list pages' sidebar entries
//   web/src/config/profile.generated.ts  the profile, for the console
//
// It refuses (exit 1, every problem listed) a pack whose files would get past the seam:
//   - pack.json: unknown fields, an id that is not the directory's, a missing entry, badly named or numbered migrations
//   - code: an import of any shell module other than src/pack-api.ts, of a database driver or a process API; any
//     mention of asPlatform, SET/RESET ROLE, set_config or the tenant setting (leaving the workspace's scope)
//   - SQL: a table, index or statement outside the pack's own `<id>_` names; GRANT, REVOKE, policies, roles, DO blocks,
//     functions, views, triggers, rules, SECURITY DEFINER, extensions, default privileges, disabling row-level
//     security; and any table created without row-level security: each CREATE TABLE must be followed, in the pack's
//     migrations, by SELECT shell_pack_tenant_table('<table>') (a workspace table: org_id NOT NULL, a policy that
//     limits the tenant role to its own workspace, fails closed) or shell_pack_private_table('<table>') (no tenant
//     access at all). src/migrate.ts checks the same again in the database when it applies them.
//
// Record areas are declared in code (definePack({ recordAreas })), so once every check above passes, each pack's entry
// is loaded once (through tsx, as the server loads it) to read them; with no packs nothing is loaded.
//
//   node scripts/gen-packs.mjs            write the files (npm run gen:packs)
//   node scripts/gen-packs.mjs --check    exit 1 when a written file differs from what the packs say (npm run check:packs)
//   --packs <dir> --out <dir> --profile <file>   another packs directory, output root or profile (tests)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const ROOT = path.resolve(HERE, "..");
const PACKS_DIR = path.resolve(opt("--packs") ?? path.join(ROOT, "packs"));
const OUT = path.resolve(opt("--out") ?? ROOT);
const PROFILE_FILE = path.resolve(opt("--profile") ?? path.join(ROOT, "profile.json"));
const CHECK = argv.includes("--check");
const PACK_API = path.join(ROOT, "src", "pack-api.ts");

/** The neutral profile: what a build with no profile.json shows. No product's words. */
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
const MANIFEST_KEYS = new Set(["id", "name", "version", "description", "entry", "migrations", "pages", "words", "upstream"]);
const PAGE_KEYS = new Set(["id", "area", "title", "description", "data", "columns", "nav_group", "icon"]);
/** What a pack's code may import besides its own files and src/pack-api.ts. */
const ALLOWED_BARE = new Set(["zod", "node:crypto", "node:path", "node:url", "node:util", "node:buffer", "node:events", "node:fs", "node:fs/promises",
  "@modelcontextprotocol/sdk/types.js"]);
const CODE_EXT = /\.(m?[jt]sx?|cjs|cts)$/;

const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const posix = (p) => p.split(path.sep).join("/");

function readJson(file, where) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (e) { fail(where, `not valid JSON (${e.message})`); return null; }
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// ---------- code: the import boundary ----------

const SPECIFIERS = /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;
const BANNED_CODE = [
  [/\basPlatform\b/, "asPlatform (leaves the workspace's scope)"],
  [/\b(SET|RESET)\s+(LOCAL\s+|SESSION\s+)?ROLE\b/i, "SET/RESET ROLE (leaves the tenant role)"],
  [/\bset_config\b/i, "set_config (changes the tenant setting)"],
  [/octillion\.org_id/, "the tenant setting"],
  [/\bSESSION\s+AUTHORIZATION\b/i, "SET SESSION AUTHORIZATION"],
  // Ways to load a module the import list below cannot see.
  [/\brequire\b/, "require (a pack is an ES module: use import)"],
  [/\bcreateRequire\b|\bgetBuiltinModule\b|\bprocess\s*(\.|\[)\s*["'`]?(binding|_linkedBinding|dlopen|mainModule)\b/, "a module loader outside import"],
  [/\beval\s*\(|\bFunction\s*\(|\bnew\s+Function\b|\bglobalThis\b|\bReflect\b|\bimport\.meta\.resolve\b/, "eval, Function, globalThis or Reflect"],
];
/** Every dynamic import must be a single string literal: import("…"). */
const DYNAMIC_IMPORT = /\bimport\s*\(/g;
const LITERAL_IMPORT = /^import\s*\(\s*(["'])[^"'`$]*\1\s*\)/;

function checkCode(packDir, id) {
  for (const file of walk(packDir).filter((f) => CODE_EXT.test(f))) {
    const where = `pack ${id}: ${posix(path.relative(packDir, file))}`;
    const src = readFileSync(file, "utf8");
    for (const [re, what] of BANNED_CODE) if (re.test(src)) fail(where, `uses ${what}`);
    for (const m of src.matchAll(DYNAMIC_IMPORT)) if (!LITERAL_IMPORT.test(src.slice(m.index))) fail(where, "a dynamic import of anything but one string literal");
    for (const m of src.matchAll(SPECIFIERS)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts");
        if (target === PACK_API) continue;
        const inside = path.relative(packDir, target);
        if (inside.startsWith("..") || path.isAbsolute(inside)) fail(where, `imports ${spec}: a pack may import its own files and src/pack-api.ts only`);
      } else if (!ALLOWED_BARE.has(spec)) fail(where, `imports ${spec}: not allowed in a pack (allowed: ${[...ALLOWED_BARE].join(", ")}, src/pack-api.ts, its own files)`);
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
function lex(sql, where) {
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
    if (ch === "$" && /^\$[a-z_0-9]*\$/i.test(sql.slice(i))) { fail(where, "uses dollar-quoted bodies (DO blocks, functions): not allowed in a pack migration"); return null; }
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

const NAME = String.raw`"?([a-z_][a-z0-9_]*)"?`;
const unq = (s) => s.replace(/"/g, "").toLowerCase();

function checkMigrations(dir, id, where) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const prefix = `${id}_`;
  const own = (t) => unq(t).replace(/^public\./, "").startsWith(prefix);
  const created = []; // [table, file]
  const secured = new Map(); // table -> "tenant" | "private"
  const order = [];
  files.forEach((f, i) => {
    const m = MIGRATION.exec(f);
    if (!m) return fail(`${where}/${f}`, "name it NNNN_lowercase_words.sql");
    if (Number(m[1]) !== i + 1) fail(`${where}/${f}`, `expected version ${String(i + 1).padStart(4, "0")} (no gaps or duplicates)`);
    const sql = readFileSync(path.join(dir, f), "utf8");
    const lexed = lex(sql, `${where}/${f}`);
    if (!lexed) return;
    for (const [re, what] of BANNED_SQL) if (re.test(lexed.blank)) fail(`${where}/${f}`, `uses ${what}: not allowed in a pack migration`);
    for (const st of statements(lexed.code)) {
      const at = `${where}/${f}: ${st.slice(0, 80)}`;
      let x;
      if ((x = new RegExp(String.raw`^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?(?:public\.)?${NAME} ?\((.*)\)$`, "i").exec(st))) {
        const t = unq(x[1]);
        if (!own(t)) { fail(at, `table ${t} must be named ${prefix}…`); continue; }
        created.push({ t, f, body: x[2], i: order.length });
        order.push({ kind: "create", t });
      } else if ((x = new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${NAME} )?ON (?:ONLY )?(?:public\.)?${NAME}\b`, "i").exec(st))) {
        if (x[1] && !own(x[1])) fail(at, `index ${unq(x[1])} must be named ${prefix}…`);
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
  const entry = m.entry ?? "index.ts";
  if (typeof entry !== "string" || !/^[a-z0-9_\-/]+\.ts$/i.test(entry) || entry.includes("..")) fail(where, "entry must be a .ts file inside the pack");
  else if (!existsSync(path.join(dir, entry))) fail(where, `entry ${entry} does not exist`);
  let migrations = null;
  if (m.migrations !== undefined) {
    if (typeof m.migrations !== "string" || !/^[a-z0-9_\-/]+$/i.test(m.migrations) || m.migrations.includes("..")) fail(where, "migrations must be a directory inside the pack");
    else if (!existsSync(path.join(dir, m.migrations)) || !statSync(path.join(dir, m.migrations)).isDirectory()) fail(where, `migrations directory ${m.migrations} does not exist`);
    else if (checkMigrations(path.join(dir, m.migrations), id, `packs/${dirName}/${m.migrations}`) === 0) fail(where, `migrations directory ${m.migrations} has no .sql files`);
    else migrations = m.migrations;
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
  if (id && ID.test(id)) checkCode(dir, id);
  return { id, dir, migrationsDir: migrations && posix(path.relative(ROOT, path.join(dir, migrations))), manifest: { id, name: m.name, version: m.version, entry, migrations, words }, pages };
}

const packDirs = existsSync(PACKS_DIR) ? readdirSync(PACKS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
const packs = [];
for (const d of packDirs) {
  if (!existsSync(path.join(PACKS_DIR, d, "pack.json"))) { fail(`packs/${d}`, "a pack directory needs a pack.json"); continue; }
  const p = loadPack(d);
  if (p) packs.push(p);
}

// Nor may it name a shell table: pack "api" would own api_keys, and its migrations could then alter or re-secure it.
const SHELL_TABLES = new Set(["pack_schema_migrations", "schema_migrations"]);
for (const f of existsSync(path.join(ROOT, "sql", "migrations")) ? readdirSync(path.join(ROOT, "sql", "migrations")).filter((x) => x.endsWith(".sql")) : [])
  for (const m of readFileSync(path.join(ROOT, "sql", "migrations", f), "utf8").matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)/gi))
    SHELL_TABLES.add(m[1].toLowerCase());
for (const p of packs) {
  const clash = [...SHELL_TABLES].filter((t) => t.startsWith(`${p.id}_`));
  if (clash.length) fail(`packs/${p.id}`, `its table prefix ${p.id}_ is taken by the shell's ${clash.join(", ")}: choose another id`);
}
// One pack's table prefix may not be another's (pack "a" would own "a_b_…", pack "a_b"'s tables).
for (const a of packs) for (const b of packs) if (a !== b && `${b.id}_`.startsWith(`${a.id}_`)) fail(`packs/${b.id}`, `its id starts with pack ${a.id}'s table prefix ${a.id}_`);

let profile = { ...DEFAULT_PROFILE };
if (existsSync(PROFILE_FILE)) {
  const pf = readJson(PROFILE_FILE, rel(PROFILE_FILE));
  if (pf && typeof pf === "object" && !Array.isArray(pf)) {
    for (const [k, v] of Object.entries(pf)) {
      if (k === "$comment") continue;
      if (!PROFILE_KEYS.includes(k)) fail(rel(PROFILE_FILE), `unknown field ${k} (known: ${PROFILE_KEYS.join(", ")})`);
      else if (typeof v !== "string" || !v.trim()) fail(rel(PROFILE_FILE), `${k} must be text`);
      else profile[k] = v;
    }
  }
}
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile.mcp_server_name)) fail("profile", "mcp_server_name: lowercase letters, digits and -");
if (/[<>"\r\n]/.test(profile.email_sender_name)) fail("profile", "email_sender_name may not contain < > \" or line breaks");
if (!/^[^\s@<>]+@[^\s@<>]+$/.test(profile.email_from_address)) fail("profile", "email_from_address must be an address");

const refuse = () => {
  if (!problems.length) return;
  console.error(`gen-packs: refused (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n  ${problems.join("\n  ")}`);
  process.exit(1);
};
refuse();

// ---------- record areas (mold_v0-047): read from each pack's definePack, checked across packs ----------

/** Each pack's record areas, parsed by src/pack-api.ts RecordAreaSchema (defaults filled in), by pack id. */
function readRecordAreas() {
  if (!packs.length) return {};
  const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
  if (!existsSync(tsx)) { fail("record areas", `reading the packs' definitions needs tsx (${rel(tsx)}): run npm ci`); return {}; }
  const dir = mkdtempSync(path.join(tmpdir(), "gen-packs-"));
  try {
    const script = path.join(dir, "areas.mts");
    writeFileSync(script, `import { pathToFileURL } from "node:url";
const [api, entries] = JSON.parse(process.argv[2]);
const { RecordAreaSchema } = await import(pathToFileURL(api).href);
const out = {};
for (const [id, file] of entries) {
  try {
    const m = await import(pathToFileURL(file).href);
    const def = m.default?.default ?? m.default;
    out[id] = (def?.recordAreas ?? []).map((a) => RecordAreaSchema.parse(a));
  } catch (e) { out[id] = { error: String(e?.message ?? e).slice(0, 1500) }; }
}
process.stdout.write("\\nRECORD_AREAS " + JSON.stringify(out) + "\\n");
`);
    const arg = JSON.stringify([PACK_API, packs.map((p) => [p.id, path.join(p.dir, p.manifest.entry)])]);
    const r = spawnSync(tsx, [script, arg], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RECORD_AREAS "));
    if (r.status !== 0 || !line) { fail("record areas", `loading the packs' definitions failed: ${((r.stderr ?? "") + (r.stdout ?? "")).trim().split("\n").slice(-6).join(" | ").slice(0, 1200)}`); return {}; }
    const got = JSON.parse(line.slice("RECORD_AREAS ".length));
    for (const [id, v] of Object.entries(got)) if (!Array.isArray(v)) { fail(`packs/${id}`, `its definition does not load: ${v.error}`); got[id] = []; }
    return got;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const areasByPack = readRecordAreas();
const recordAreas = packs.flatMap((p) => (areasByPack[p.id] ?? []).map((a) => ({ pack: p.id, ...a })));
{
  const owner = new Map();
  for (const a of recordAreas) {
    if (owner.has(a.name)) fail(`packs/${a.pack}`, `record area ${a.name} is already pack ${owner.get(a.name)}'s (area names are unique in a build)`);
    else owner.set(a.name, a.pack);
  }
  for (const a of recordAreas) for (const l of a.links ?? [])
    if (!owner.has(l.area)) fail(`packs/${a.pack}`, `record area ${a.name} links field ${l.field} to area ${l.area}, which no pack declares`);
}
refuse();

// ---------- output ----------

const HEADER = "// Generated by scripts/gen-packs.mjs from packs/*/pack.json and profile.json. Do not edit: run `npm run gen:packs`.\n";
const json = (v) => JSON.stringify(v, null, 2);
const importPath = (from, to) => { let r = posix(path.relative(path.dirname(from), to)).replace(/\.ts$/, ".js"); if (!r.startsWith(".")) r = `./${r}`; return r; };

const srcPacks = path.join(OUT, "src", "packs.generated.ts");
const files = new Map();
files.set(srcPacks, HEADER +
  packs.map((p, i) => `import pack${i} from ${JSON.stringify(importPath(srcPacks, path.join(p.dir, p.manifest.entry)))};\n`).join("") +
  `\n/** Every pack in this build, in pack order (by id): its pack.json and its definePack export (src/packs.ts checks both). */\n` +
  `export const PACKS: readonly { readonly manifest: { id: string; name: string; version: string; entry: string; migrations: string | null; words: Record<string, string> }; readonly definition: unknown }[] = [` +
  (packs.length ? `\n${packs.map((p, i) => `  { manifest: ${JSON.stringify(p.manifest)}, definition: pack${i} },`).join("\n")}\n` : "") + "];\n");
files.set(path.join(OUT, "src", "pack-migrations.generated.ts"), HEADER +
  "/** Pack migration directories (relative to the codebase root), applied after the shell's in this order (src/migrate.ts). */\n" +
  `export const PACK_MIGRATION_DIRS: readonly { readonly pack: string; readonly dir: string }[] = ${json(packs.filter((p) => p.migrationsDir).map((p) => ({ pack: p.id, dir: p.migrationsDir })))};\n`);
files.set(path.join(OUT, "src", "profile.generated.ts"), HEADER +
  "/** The profile (profile.json over the neutral default): the names the shell shows. Read through src/profile.ts. */\n" +
  `export const GENERATED_PROFILE = ${json(profile)} as const;\n`);

const nav = (area) => {
  const groups = new Map();
  for (const p of packs) for (const pg of p.pages.filter((x) => x.area === area)) {
    if (!groups.has(pg.nav_group)) groups.set(pg.nav_group, []);
    groups.get(pg.nav_group).push({ title: pg.title, url: `/${area}/packs/${pg.pack}/${pg.id}`, ...(pg.icon ? { icon: pg.icon } : {}), items: [] });
  }
  return [...groups].map(([label, items]) => ({ label, items }));
};
const allPages = packs.flatMap((p) => p.pages);
files.set(path.join(OUT, "web", "src", "config", "pack-nav.generated.ts"), HEADER +
  "import type { NavGroup } from '@/types';\n\n" +
  "/** A pack's console page: the shell's generic page (app/{app,admin}/packs/[pack]/[page]) shows the rows its data route returns. */\n" +
  "export interface PackPage {\n  pack: string;\n  id: string;\n  area: 'app' | 'admin';\n  title: string;\n  description: string | null;\n  data: string;\n  columns: { key: string; label: string }[];\n}\n\n" +
  `export const packPages: PackPage[] = ${json(allPages.map(({ nav_group: _g, icon: _i, ...pg }) => pg))};\n\n` +
  "/** Sidebar groups the packs add to /app (after the shell's own). */\n" +
  `export const packPortalNav: NavGroup[] = ${json(nav("app"))};\n\n` +
  "/** Sidebar groups the packs add to /admin (after the shell's own). */\n" +
  `export const packAdminNav: NavGroup[] = ${json(nav("admin"))};\n\n` +
  "/** A record area a pack declares (mold_v0-047): the shell's generic list and detail pages (app/{app,admin}/records/[area]). */\n" +
  "export interface RecordAreaSpec {\n  pack: string;\n  name: string;\n  label: string;\n  description: string | null;\n  role: 'source' | 'check' | 'asset';\n" +
  "  scope: 'platform' | 'workspace';\n  fields: { name: string; label: string; type: string }[];\n  list_columns: string[];\n  links: { field: string; area: string }[];\n}\n\n" +
  `export const recordAreas: RecordAreaSpec[] = ${json(recordAreas.map((a) => ({ pack: a.pack, name: a.name, label: a.label, description: a.description ?? null, role: a.role,
    scope: a.scope, fields: a.fields, list_columns: a.list_columns ?? a.fields.slice(0, 4).map((f) => f.name), links: a.links ?? [] })))};\n\n` +
  "/** The /app sidebar's Records group: every area (a workspace reads shared areas and its own). */\n" +
  `export const recordPortalNav: NavGroup[] = ${json(recordAreas.length ? [{ label: "Records", items: recordAreas.map((a) => ({ title: a.label, url: `/app/records/${a.name}`, items: [] })) }] : [])};\n\n` +
  "/** The /admin sidebar's Records group: the platform-scope areas staff maintain. */\n" +
  `export const recordAdminNav: NavGroup[] = ${json(recordAreas.some((a) => a.scope === "platform") ? [{ label: "Records", items: recordAreas.filter((a) => a.scope === "platform").map((a) => ({ title: a.label, url: `/admin/records/${a.name}`, items: [] })) }] : [])};\n`);
files.set(path.join(OUT, "web", "src", "config", "profile.generated.ts"), HEADER +
  "/** The profile (profile.json over the neutral default), for the console's title and descriptions. */\n" +
  `export const profile = ${json(profile)} as const;\n`);

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
console.log(`gen-packs: ${packs.length} pack(s)${packs.length ? ` (${packs.map((p) => p.id).join(", ")})` : ""}, ${allPages.length} page(s), ${recordAreas.length} record area(s), ` +
  `${packs.filter((p) => p.manifest.migrations).length} with migrations; profile "${profile.name}"${CHECK ? "; generated files are current" : ""}`);
