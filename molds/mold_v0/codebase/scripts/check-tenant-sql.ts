// Tenant-SQL check (docs/security.md): every SQL query in src/ that touches a tenant table must filter by organization
// (mention org_id) or say how it is scoped with a /* tenant: ... */ note (e.g. "by session id from a job token").
// Queries that existed when the check was added are listed in scripts/tenant-sql-baseline.json, pending review;
// anything new that is unscoped fails.
//   npm run check:tenant-sql              check
//   npm run check:tenant-sql -- --update  rewrite the baseline (only after reviewing what changed)
// Packs (mold_v0-038): every pack's code under packs/ is checked the same way, with the tables its own migrations create
// as tenant tables too (a pack table is a workspace table: scripts/gen-packs.mjs refuses one without org_id or RLS).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SHELL_TENANT_TABLES = ["agent_sessions", "simulations", "products", "scenarios", "product_research", "org_task_sets",
  "org_harnesses", "transcript_events", "gateway_usage", "mcp_events", "worker_tokens", "api_keys", "library_submissions", "visibility_reports",
  // mold_v0-047 record areas, mold_v0-041 runs, mold_v0-033 workspace store
  "workspace_records", "runs", "run_events", "run_results", "workspace_snapshots", "workspace_leases",
  // mold_v0-034 the workspace credential vault
  "workspace_credentials",
  // mold_v0-035 schedules per workspace and due-date notices
  "workspace_schedules", "workspace_notices",
  // mold_v0-019 price per run: the run charges ledger
  "run_charges",
  // mold_v0-004 the built-in sign-in's memberships and invitations (platform-only tables that carry org_id)
  "auth_memberships", "auth_invitations",
  // mold_v0-013 the built-in MCP authorization server's grants (a person in one workspace; platform-only, carries org_id)
  "oauth_grants",
  // mold_v0-079 approvals of previews, mold_v0-075 a company's egress hosts
  "run_approvals", "workspace_egress_hosts"];
const BASELINE = path.join(ROOT, "scripts/tenant-sql-baseline.json");

const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.name === "node_modules" || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const PACKS = path.join(ROOT, "packs");
const packFiles = existsSync(PACKS) ? walk(PACKS) : [];
const PACK_TABLES = [...new Set(packFiles.filter((f) => f.endsWith(".sql")).flatMap((f) =>
  [...readFileSync(f, "utf8").matchAll(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]!.toLowerCase())))];
// A host pack's own tables under the names they had in the shell's base schema (pack.json host.schema, mold_v0-049)
// keep the scope this check always gave them: its workspace tables are named in SHELL_TENANT_TABLES above (their queries
// in the shell's session engine and in the pack are checked wherever they are), its libraries are not tenant tables.
const HOST_TABLES = new Set(existsSync(PACKS) ? readdirSync(PACKS).flatMap((id) => {
  try { return JSON.parse(readFileSync(path.join(PACKS, id, "pack.json"), "utf8")).host?.schema?.tables ?? []; } catch { return []; }
}) : []);
const TENANT_TABLES = [...SHELL_TENANT_TABLES, ...PACK_TABLES.filter((t) => !HOST_TABLES.has(t))];
// A host pack's operator scripts and tests (pack.json host.scripts, mold_v0-039) are left out, as the shell's scripts/ are.
const scriptDirs = existsSync(PACKS) ? readdirSync(PACKS).flatMap((id) => {
  try { const h = JSON.parse(readFileSync(path.join(PACKS, id, "pack.json"), "utf8")).host; return h?.scripts ? [path.join(PACKS, id, h.scripts) + path.sep] : []; } catch { return []; }
}) : [];
const packCode = packFiles.filter((f) => /\.(m?[jt]sx?)$/.test(f) && !scriptDirs.some((d) => f.startsWith(d)));

const files = [
  ...readdirSync(path.join(ROOT, "src")).filter((f) => f.endsWith(".ts")).map((f) => path.join("src", f)),
  ...packCode.map((f) => path.relative(ROOT, f)),
];
const offenders: { file: string; line: number; hash: string; sql: string }[] = [];
const literal = /`([^`]*)`|"((?:[^"\\]|\\.)*)"/g;
for (const file of files) {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  // A file-level note constant (const TENANT = "/* tenant: ... */") counts where a query interpolates it.
  const notes = [...src.matchAll(/const (\w+) = "(\/\*\s*tenant:[^"]*)"/g)];
  for (const m of src.matchAll(literal)) {
    const sql = notes.reduce((q, [, name, note]) => q.replaceAll(`\${${name}}`, note), m[1] ?? m[2] ?? "");
    if (!/\b(SELECT|UPDATE|DELETE|INSERT)\b/.test(sql) || !/\b(FROM|INTO|UPDATE|JOIN)\b/i.test(sql)) continue;
    const touched = TENANT_TABLES.filter((t) => new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`, "i").test(sql));
    if (!touched.length || /\borg_id\b/.test(sql) || /\/\*\s*tenant:/.test(sql)) continue;
    const norm = sql.replace(/\s+/g, " ").trim();
    offenders.push({ file, line: src.slice(0, m.index).split("\n").length, hash: createHash("sha256").update(`${file}\n${norm}`).digest("hex").slice(0, 16), sql: norm.slice(0, 160) });
  }
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, JSON.stringify({
    note: "Queries on tenant tables without an org_id filter that existed when scripts/check-tenant-sql.ts was added (2026-10-15). Pending review: annotate each with /* tenant: how it is scoped */ or add an org filter, then remove it here.",
    pending: offenders.map(({ file, hash, sql }) => ({ file, hash, sql })),
  }, null, 2) + "\n");
  console.log(`baseline written: ${offenders.length} pending quer${offenders.length === 1 ? "y" : "ies"}`);
  process.exit(0);
}
const known = new Set((JSON.parse(readFileSync(BASELINE, "utf8")).pending as { hash: string }[]).map((x) => x.hash));
const fresh = offenders.filter((o) => !known.has(o.hash));
if (fresh.length) {
  console.error(`TENANT SQL CHECK FAIL: ${fresh.length} new quer${fresh.length === 1 ? "y" : "ies"} on tenant tables without an org filter:`);
  for (const o of fresh) console.error(`  ${o.file}:${o.line}  ${o.sql}`);
  console.error("Add an org_id filter, or a /* tenant: <how it is scoped> */ note if it is scoped another way.");
  process.exit(1);
}
console.log(`TENANT SQL CHECK PASS (${offenders.length} baseline quer${offenders.length === 1 ? "y" : "ies"} pending review, 0 new)${packCode.length ? `; packs: ${PACK_TABLES.length} pack table(s) checked${HOST_TABLES.size ? ` (${HOST_TABLES.size} a host pack's own, scoped as in the shell)` : ""}` : ""}`);
