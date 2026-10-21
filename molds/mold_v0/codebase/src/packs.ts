/**
 * The pack registry (mold_v0-038): every pack in the build copy, from the generated src/packs.generated.ts
 * (scripts/gen-packs.mjs), checked once, then used by the MCP server (pack tools, after the shell's own), the HTTP
 * server (src/pack-routes.ts) and the migration runner (src/migrate.ts reads src/pack-migrations.generated.ts, which
 * imports no pack code). With zero packs every list here is empty and the shell is exactly what it was.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { accountRefusal, canAccount } from "./account-roles.js";
import { recordMcpEvent } from "./analytics.js";
import type { Org } from "./auth.js";
import { getDb } from "./db.js";
import { PackDefinitionError, PackError, validatePack, type PackDb, type PackDefinition, type PackTool, type Workspace } from "./pack-api.js";
import { PACKS } from "./packs.generated.js";
import { RECORD_TOOL_NAMES, registerRecordTools, workspaceRecords } from "./record-areas.js";
import { currentTenant, withTenant } from "./tenant-scope.js";

/** What gen-packs copies from a pack's pack.json into the registry. */
export interface PackManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  migrations: string | null;
  words: Record<string, string>;
  /** The pack's directory, relative to the codebase root (absolute in tests): where a run's programs are (mold_v0-041). */
  dir?: string;
}
export interface GeneratedPack { manifest: PackManifest; definition: unknown }
export interface InstalledPack { id: string; manifest: PackManifest; definition: PackDefinition }

/**
 * Check a set of packs together: each definition, its id against its pack.json, and names that must be unique across
 * packs (pack ids, tool names, record area names). `reservedTools` are the shell's own tool names, which a pack may not
 * take; nor may it take the record areas' tools (list_records, get_record), which the shell adds when an area exists.
 */
export function installPacks(list: readonly GeneratedPack[], reservedTools: readonly string[] = []): InstalledPack[] {
  const problems: string[] = [];
  const out: InstalledPack[] = [];
  const ids = new Set<string>();
  const toolOwner = new Map<string, string>([...reservedTools, ...RECORD_TOOL_NAMES].map((t) => [t, "the shell"]));
  const areaOwner = new Map<string, string>();
  for (const g of list) {
    const m = g.manifest;
    const def = ((g.definition as { default?: unknown })?.default ?? g.definition) as PackDefinition;
    try { validatePack(def); } catch (e) { problems.push((e as Error).message); continue; }
    if (def.id !== m.id) { problems.push(`pack ${m.id}: its entry (${m.entry}) defines pack ${JSON.stringify(def.id)}; the ids must match`); continue; }
    if (ids.has(m.id)) { problems.push(`pack ${m.id} is installed twice`); continue; }
    ids.add(m.id);
    if (def.migrations !== undefined && def.migrations !== m.migrations)
      problems.push(`pack ${m.id}: definePack names migrations ${JSON.stringify(def.migrations)} but pack.json names ${JSON.stringify(m.migrations)}`);
    for (const t of def.tools ?? []) {
      const owner = toolOwner.get(t.name);
      if (owner) problems.push(`pack ${m.id}: tool ${t.name} is already ${owner === "the shell" ? "a shell tool" : `pack ${owner}'s`}`);
      else toolOwner.set(t.name, m.id);
    }
    for (const a of def.recordAreas ?? []) {
      const owner = areaOwner.get(a.name);
      if (owner) problems.push(`pack ${m.id}: record area ${a.name} is already pack ${owner}'s (area names are unique in a build)`);
      else areaOwner.set(a.name, m.id);
    }
    out.push({ id: m.id, manifest: m, definition: def });
  }
  // An onboarding step's tool:<name> names a tool of this build: the shell's, the record tools, or a pack's (mold_v0-011).
  for (const p of out) for (const st of p.definition.onboarding ?? []) {
    const [what, arg] = st.done_when.split(":", 2);
    if (what === "tool" && arg && !toolOwner.has(arg)) problems.push(`pack ${p.id}: onboarding step ${st.id} names no tool ${arg} (not the shell's nor any pack's)`);
  }
  // A link names an area some pack in this build declares.
  for (const p of out) for (const a of p.definition.recordAreas ?? []) for (const l of a.links ?? [])
    if (!areaOwner.has(l.area)) problems.push(`pack ${p.id}: record area ${a.name} links field ${l.field} to area ${l.area}, which no pack declares`);
  if (problems.length) throw new PackDefinitionError(`packs refused:\n  ${problems.join("\n  ")}`);
  return out;
}

/** A pack's directory on disk: its pack.json's `dir` from the generated registry, else packs/<id> in the codebase. */
export function packDir(id: string): string {
  const p = packs().find((x) => x.id === id);
  if (!p) throw new PackDefinitionError(`no pack ${id}`);
  return path.resolve(ROOT, p.manifest.dir ?? path.join("packs", id));
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let installed: InstalledPack[] | null = null;
let reserved: readonly string[] = [];
/** The shell's own tool names, set by src/server.ts before any pack is used, so a pack cannot shadow one. */
export function reserveShellTools(names: readonly string[]) { reserved = names; installed = null; }
/** The installed packs (the generated registry, checked on first use; a bad pack fails the process at start). */
export const packs = (): InstalledPack[] => (installed ??= installPacks(PACKS as readonly GeneratedPack[], reserved));
/** Tests only: install another set of packs (a fixture) in place of the generated registry; null goes back to it. */
export function setPacksForTest(list: readonly GeneratedPack[] | null) { installed = list ? installPacks(list, reserved) : null; }

/** Everything the packs declare, by kind: what is wired today and what later tickets pick up. */
export function packRegistry() {
  const all = packs();
  const flat = <K extends "jobKinds" | "recordAreas" | "credentials" | "schedules" | "onboarding">(k: K) =>
    all.flatMap((p) => (p.definition[k] ?? []).map((x) => ({ pack: p.id, ...(x as object) })));
  return {
    packs: all.map((p) => ({ id: p.id, name: p.manifest.name, version: p.manifest.version })),
    tools: all.flatMap((p) => (p.definition.tools ?? []).map((t) => ({ pack: p.id, name: t.name }))),
    routes: all.flatMap((p) => (p.definition.routes ?? []).map((r) => ({ pack: p.id, scope: r.scope, method: r.method, path: r.path }))),
    words: Object.fromEntries(all.map((p) => [p.id, p.manifest.words])),
    // Every kind is wired: recordAreas (src/record-areas.ts, mold_v0-047), jobKinds (src/runs.ts, mold_v0-041), credentials
    // (src/credentials.ts, mold_v0-034), onboarding (src/onboarding.ts, mold_v0-011), schedules (src/schedules.ts, mold_v0-035).
    jobKinds: flat("jobKinds"), recordAreas: flat("recordAreas"), credentials: flat("credentials"), schedules: flat("schedules"), onboarding: flat("onboarding"),
  };
}

/**
 * The database for work done for one workspace: the shell's own handle (src/db.ts), whose queries run as the tenant
 * role inside withTenant. It refuses a query that has somehow left that workspace's scope (a callback that lost it).
 */
export function workspaceDb(workspaceId: number): PackDb {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      if (currentTenant() !== workspaceId) throw new Error("a pack query ran outside its workspace's scope: refused");
      return (await getDb()).query<T>(sql, params);
    },
  };
}

export const workspaceOf = (org: Org): Workspace => ({ id: org.orgId, slug: org.slug, name: org.name || null, userId: org.userId ?? null, role: org.role ?? null });

/** A handler's value as an MCP tool result: passed through when it already is one, else JSON text plus structured content. */
export function toToolResult(v: unknown): CallToolResult {
  if (v && typeof v === "object" && Array.isArray((v as { content?: unknown }).content)) return v as CallToolResult;
  const data = v === undefined ? null : JSON.parse(JSON.stringify(v));
  const structured = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }], ...(structured ? { structuredContent: structured } : {}) };
}

/** What a tool call needs: its own `needs`, else nothing for a read-only tool and "edit" for anything else. */
const toolNeeds = (t: PackTool) => t.needs ?? (t.annotations?.readOnlyHint ? undefined : "edit");

/** One pack tool call for one workspace: permission, row-level security, the activity log, errors without row values. */
export async function runPackTool(org: Org, pack: string, t: PackTool, args: Record<string, unknown>): Promise<CallToolResult> {
  const t0 = performance.now();
  try {
    const needs = toolNeeds(t);
    if (needs && org.role && !canAccount(org.role, needs)) throw new PackError(accountRefusal(needs).message, 403);
    const ws = workspaceOf(org);
    // The run engine (src/runs.ts) reaches the gateway and much of the server: loaded on first use, not at start.
    const { workspaceRuns } = await import("./runs.js");
    const ctx = { pack, workspace: ws, db: workspaceDb(org.orgId), records: workspaceRecords(pack, org.orgId), runs: workspaceRuns(pack, org.orgId, org.userId ?? null, org) };
    const value = await withTenant(org.orgId, () => t.handler(ws, args ?? {}, ctx));
    recordMcpEvent(org, { method: "tools/call", name: t.name, ms: performance.now() - t0 });
    return toToolResult(value);
  } catch (err) {
    // As for the shell's tools (src/server.ts runToolInner): a database error can echo another row's values, so the
    // caller gets its code, never its text.
    const e = err as Error & { code?: unknown };
    if (e.code === "42501") console.error(`pack ${pack} tool ${t.name}: refused by the database: ${e.message}`);
    const message = typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)
      ? `The request could not be completed (database error ${e.code}). Check the arguments and try again.` : e.message;
    recordMcpEvent(org, { method: "tools/call", name: t.name, ok: false, error: message, ms: performance.now() - t0 });
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/**
 * Register every pack's tools on a customer MCP server bound to one workspace, after the shell's own; then, when any
 * pack declares a record area, the shell's list_records and get_record (src/record-areas.ts). With no packs nothing
 * is added: the surface is exactly the shell's.
 */
export function registerPackTools(server: McpServer, org: Org) {
  for (const p of packs()) {
    for (const t of p.definition.tools ?? []) {
      server.registerTool(t.name, {
        ...(t.title ? { title: t.title } : {}),
        description: t.description,
        inputSchema: t.inputSchema ?? {},
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        ...(t.annotations ? { annotations: t.annotations } : {}),
        ...(t._meta ? { _meta: t._meta } : {}),
      }, (args: Record<string, unknown>) => runPackTool(org, p.id, t, args));
    }
  }
  registerRecordTools(server, (t, args) => runPackTool(org, "records", t, args));
}
