/**
 * check:tenancy's CROSS-WORKSPACE-READER rule, run against request paths it must catch and system paths it must leave
 * alone.
 *
 * The principle: workspaces are not aware of each other. No code a person's request runs may list the workspaces or
 * read every workspace's scope (`acrossOrgDbs`, `acrossOrgsRls`, `listWorkspaceIds`, a `.listOrgs()` reader, or a bare
 * `select … from orgs`). A cron, a backfill or a deploy step may; a route handler, a model tool, an agent hook or
 * channel, a page, the proxy, may not — directly or through any chain of calls. Each fixture below is written into a
 * scratch tree that the REAL script (scripts/check-tenancy.mjs) runs over, exactly as CI runs it.
 *
 * Function-level, not file-level: a module the request path imports may still hold a system function that sweeps, as
 * long as nothing on the request path calls it. And a function that sweeps ONLY when its workspace argument is missing
 * (`orgId ? withOrgDb(orgId, …) : acrossOrgDbs(…)`) is reached only by a call that leaves that argument out.
 *
 *   npm run test:check-cross-workspace
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-tenancy.mjs");

/** Support modules: the readers themselves, and a scoped handle. Never reported on their own. */
const SUPPORT = {
  "lib/ops-db.ts": `export function getOpsDb() { return null; }
export async function withOrgRls<T>(orgId: string, fn: (tx: unknown) => Promise<T>) { return fn(orgId); }
export async function acrossOrgsRls<T>(fn: (tx: unknown, orgId: string) => Promise<T[]>): Promise<T[]> { return fn(null, "x"); }
export async function listWorkspaceIds(): Promise<string[]> { return []; }`,
  "agent/lib/db/index.ts": `export function getDb() { return null; }
export async function withOrgDb<T>(orgId: string, fn: (tx: unknown) => Promise<T>) { return fn(orgId); }
export async function acrossOrgDbs<T>(fn: (tx: unknown, orgId: string) => Promise<T[]>): Promise<T[]> { return fn(null, "x"); }`,
  "agent/lib/sweeps.ts": `import { acrossOrgDbs, withOrgDb } from "./db/index.ts";
/** A request-path function and a system function, side by side in one module. */
export async function ownRows(orgId: string) { return withOrgDb(orgId, async () => [1]); }
export async function everyRow() { return acrossOrgDbs(async () => [1]); }
/** Sweeps ONLY when no workspace is named. */
export async function dualRows(customerId: string, orgId?: string | null) {
  const run = <T,>(fn: (tx: unknown) => Promise<T[]>) => (orgId ? withOrgDb(orgId, fn) : acrossOrgDbs(fn));
  return run(async () => [customerId]);
}
export async function twoHops() { return everyRow(); }`,
  "lib/leaky.ts": `import { acrossOrgsRls } from "./ops-db";
export async function listEverything() { return acrossOrgsRls(async () => [1]); }`,
  "lib/gate-like.ts": `export interface Db { listOrgs(): Promise<string[]>; inOrg<T>(o: string, f: () => Promise<T>): Promise<T> }
export async function scanAll(db: Db) { for (const o of await db.listOrgs()) await db.inOrg(o, async () => 1); }
export async function oneWorkspace(db: Db, org: string) { return db.inOrg(org, async () => 1); }`,
  "lib/orgs-table.ts": `const orgs = { orgId: "org_id" };
export async function everyWorkspace(db: { select(x: unknown): { from(t: unknown): Promise<unknown[]> } }) { return db.select({ id: orgs.orgId }).from(orgs); }
export async function oneWorkspaceRow(db: { select(x: unknown): { from(t: unknown): { where(w: unknown): Promise<unknown[]> } } }, id: string) { return db.select({ id: orgs.orgId }).from(orgs).where(id); }`,
  "agent/lib/org-context.ts": `export async function orgForSession(_ctx: unknown): Promise<string> { return "org-a"; }`,
};

/** Request paths that reach a cross-workspace reader. Every one must be reported. */
const REACHES = {
  "app/api/ops/leak/route.ts": `import { getOpsDb } from "@/lib/ops-db";
import { listEverything } from "@/lib/leaky";
export async function GET() { void getOpsDb; return Response.json(await listEverything()); }`,
  "agent/tools/sweep_tool.ts": `import { everyRow } from "#lib/sweeps.js";
export default { async execute() { return everyRow(); } };`,
  "agent/tools/two_hops.ts": `import { twoHops } from "../lib/sweeps.ts";
export default { execute: async () => twoHops() };`,
  "agent/tools/dual_missing.ts": `import { dualRows } from "../lib/sweeps.ts";
export default { execute: async (input: { id: string }) => dualRows(input.id) };`,
  "agent/tools/dual_undefined.ts": `import { dualRows } from "../lib/sweeps.ts";
export default { execute: async (input: { id: string }) => dualRows(input.id, undefined) };`,
  "agent/tools/namespace.ts": `import * as sweeps from "../lib/sweeps.ts";
export default { execute: async () => sweeps.everyRow() };`,
  "agent/hooks/on-turn.ts": `export async function onTurn() { const m = await import("../lib/sweeps.ts"); return m.everyRow(); }`,
  "app/api/ops/scan/route.ts": `import { scanAll, type Db } from "@/lib/gate-like";
export async function POST() { return Response.json(await scanAll({} as Db)); }`,
  "app/api/ops/workspaces-table/route.ts": `import { everyWorkspace } from "@/lib/orgs-table";
export async function GET() { return Response.json(await everyWorkspace({} as never)); }`,
  "app/api/cron/open-door/route.ts": `import { everyRow } from "@/agent/lib/sweeps";
export async function GET() { return Response.json(await everyRow()); } // no CRON_SECRET: anyone may call it`,
  "agent/tools/opaque_import.ts": `export default { execute: async (input: { mod: string }) => (await import(input.mod)).run() };`,
  "setup/mcp-server.mjs": `import { everyRow } from "../agent/lib/sweeps.ts";
export async function handleTool() { return everyRow(); }`,
  "app/workspaces/page.tsx": `import { listWorkspaceIds } from "@/lib/ops-db";
export default async function Page() { return (await listWorkspaceIds()).join(","); }`,
};

/** Paths that must NOT be reported: system entry points, and request paths that stay in one workspace. */
const CLEAN = {
  "app/api/cron/sweep/route.ts": `import { everyRow } from "@/agent/lib/sweeps";
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== \`Bearer \${process.env.CRON_SECRET}\`) return new Response(null, { status: 401 });
  return Response.json(await everyRow());
}`,
  "agent/schedules/nightly.ts": `import { everyRow } from "../lib/sweeps.ts";
export default { run: () => everyRow() };`,
  "agent/tools/own_rows.ts": `import { ownRows } from "../lib/sweeps.ts";
import { orgForSession } from "../lib/org-context.ts";
export default { execute: async (_i: unknown, ctx: unknown) => ownRows(await orgForSession(ctx)) };`,
  "agent/tools/dual_named.ts": `import { dualRows } from "../lib/sweeps.ts";
import { orgForSession } from "../lib/org-context.ts";
export default { execute: async (input: { id: string }, ctx: unknown) => dualRows(input.id, await orgForSession(ctx)) };`,
  "app/api/ops/one/route.ts": `import { oneWorkspace, type Db } from "@/lib/gate-like";
import { oneWorkspaceRow } from "@/lib/orgs-table";
export async function GET() { return Response.json([await oneWorkspace({} as Db, "a"), await oneWorkspaceRow({} as never, "a")]); }`,
  "scripts/backfill-everything.mjs": `import { everyRow } from "../agent/lib/sweeps.ts";
await everyRow();`,
};

/** The sink each REACHES fixture must be reported at (file of the reader call). */
const EXPECTED_SINK = {
  "app/api/ops/leak/route.ts": "lib/leaky.ts",
  "agent/tools/sweep_tool.ts": "agent/lib/sweeps.ts",
  "agent/tools/two_hops.ts": "agent/lib/sweeps.ts",
  "agent/tools/dual_missing.ts": "agent/lib/sweeps.ts",
  "agent/tools/dual_undefined.ts": "agent/lib/sweeps.ts",
  "agent/tools/namespace.ts": "agent/lib/sweeps.ts",
  "agent/hooks/on-turn.ts": "agent/lib/sweeps.ts",
  "app/api/ops/scan/route.ts": "lib/gate-like.ts",
  "app/api/ops/workspaces-table/route.ts": "lib/orgs-table.ts",
  "app/workspaces/page.tsx": "app/workspaces/page.tsx",
  "app/api/cron/open-door/route.ts": "agent/lib/sweeps.ts",
  // The local MCP server (setup/) serves a person: a reader it reaches is a person's read.
  "setup/mcp-server.mjs": "agent/lib/sweeps.ts",
  // `await import(<variable>)` could load anything: it is reported as an unknown module, not assumed safe.
  "agent/tools/opaque_import.ts": "agent/tools/opaque_import.ts",
};

const root = mkdtempSync(join(tmpdir(), "check-cross-workspace-"));
let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `\n      ${detail}`}`);
  }
};
try {
  for (const [file, src] of Object.entries({ ...SUPPORT, ...REACHES, ...CLEAN })) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), `${src}\n`);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ imports: { "#*": "./agent/*" } }));
  let out = "";
  let status = 0;
  try {
    out = execFileSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    status = error.status ?? 1;
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  // One line per finding:   cross-workspace <sink file>:<line> <reader> ← <request entry file> (via …)
  const findings = out
    .split("\n")
    .map((l) => /^\s+cross-workspace (\S+?):\d+ .*← (\S+)/.exec(l))
    .filter(Boolean)
    .map((m) => ({ sink: m[1], root: m[2] }));
  console.log("\nRequest paths that reach a cross-workspace reader — each must be reported:");
  for (const [file, sink] of Object.entries(EXPECTED_SINK)) {
    check(`${file} (reader in ${sink})`, findings.some((f) => f.root === file && f.sink === sink), `not reported. Output:\n${out}`);
  }
  console.log("\nSystem entry points, and request paths that stay in one workspace — none may be reported:");
  for (const file of Object.keys(CLEAN)) check(file, !findings.some((f) => f.root === file), "reported");
  check("a request path importing a module is not blamed for that module's OTHER, system-only functions", !findings.some((f) => f.root === "agent/tools/own_rows.ts"));
  check("and it fails the run when it finds one", status !== 0);
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(failures === 0 ? "\ntest-check-cross-workspace: all assertions passed" : `\ntest-check-cross-workspace: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
