/**
 * The memory component's MCP tools (mold_v0-142; src/account-context.ts): the two tools pack.json `memory.tools` names
 * (a save and a search), registered on the customer MCP server right after the host packs' own tools (src/server.ts),
 * with the words and _meta of pack.json `memory.tool_words` and `memory.tool_meta`. None when the component is off or
 * names no tools.
 *
 *   save    one lasting item to the company's memory, the signed-in person's own ("me") or a subject's (`product`)
 *   search  the company's items, this person's own and the subjects' (never another person's), newest first; every word
 *           of the query must appear
 *
 * Each answer is a summary line for the model, then the structured result as JSON ({view: "memory", ...}), as the host
 * packs' tools answer; a host pack may add to it (src/host.ts mcp.decorate). Saving needs the `edit` permission.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { accountRefusal, canAccount } from "./account-roles.js";
import { errorClass, jsonBytes, recordMcpEvent } from "./analytics.js";
import type { Org } from "./auth.js";
import { getDb } from "./db.js";
import { hosts, type MemoryToolWords } from "./host.js";
import { withTenant } from "./tenant-scope.js";
import { withTip } from "./tips.js";
import { addMemory, contextConfig, ContextError, fillWord, getPerson, MEMORY_KINDS, scopesOn, subjectsOf, word, type MemoryScope } from "./account-context.js";

/** "me" in the tools is the signed-in person; the table stores it as the user scope. */
export type ToolScope = "company" | "me" | "product";
interface MemoryHit { id: number; scope: MemoryScope; subject: string; subject_name: string; kind: string; body: string; created_by: string | null; created_at: Date }
export interface MemoryView { view: "memory"; action: "saved" | "search"; query: string; scope: string; saved: MemoryHit | null; items: MemoryHit[] }

const toolScope = (s: MemoryScope): ToolScope => (s === "user" ? "me" : s);
const toolScopes = () => scopesOn().map(toolScope);

/** The tools' own words: pack.json memory.tool_words over these. */
function toolWords(which: "save" | "search"): Required<Omit<MemoryToolWords, "args">> & { args: Record<string, string> } {
  const scopes = toolScopes();
  const scopeHelp = (all: boolean) => all ? "Default all" : `${scopes.map((s, i) => `${s}${i === 0 ? " (default)" : ""}${s === "me" ? " (only this person)" : ""}`).join(", ")}`;
  const base = which === "save" ? {
    title: "Save to memory",
    description: "Save one lasting item to the account's memory: a fact, decision, preference or note about the company, the signed-in person ('me') or a product. " +
      "Use it when the user states something the team should not have to repeat, or says 'remember'. Keep each item to one self-contained sentence or two. " +
      "The team sees and edits memory on the Context pages.",
    status: ["Saving to memory…", "Saved to memory"] as [string, string],
    args: { body: "What to remember, self-contained", kind: "Default note", scope: scopeHelp(false), product: "Its key or name; optional when the account has one" } as Record<string, string>,
  } : {
    title: "Search memory",
    description: "Search the account's memory: the company's items, this person's own and product items, newest first. Every word of the query must appear; leave it empty to list the latest.",
    status: ["Searching memory…", "Memory searched"] as [string, string],
    args: { query: "Words to find", scope: scopeHelp(true), limit: "Max items (default 25)", product: "Its key or name; optional when the account has one" } as Record<string, string>,
  };
  const own = contextConfig()?.tool_words?.[which] ?? {};
  return { title: own.title ?? base.title, description: own.description ?? base.description, status: own.status ?? base.status, args: { ...base.args, ...own.args } };
}

/** The tools' _meta: pack.json memory.tool_meta, the status lines, and (MCP Apps) a widget's legacy key beside ui.resourceUri. */
function metaOf(which: "save" | "search"): Record<string, unknown> | undefined {
  const base = contextConfig()?.tool_meta;
  if (!base) return undefined;
  const w = toolWords(which);
  const out: Record<string, unknown> = { ...base, "openai/toolInvocation/invoking": w.status[0], "openai/toolInvocation/invoked": w.status[1] };
  const ui = (base as { ui?: { resourceUri?: string } }).ui;
  if (ui?.resourceUri && !("ui/resourceUri" in out)) out["ui/resourceUri"] = ui.resourceUri;
  return out;
}

/** A subject by key, name or id; else the person's focus; else the only one. Any other name is kept as written. */
async function subjectFor(org: Org, product?: string): Promise<{ slug: string; name: string }> {
  // In the hook's order (the account's own: src/host.ts context.subjects), which names them in a refusal.
  const all = await subjectsOf(org.orgId) ?? [];
  if (product) {
    const p = product.trim().toLowerCase();
    const hit = all.find((x) => x.slug === p || x.name.toLowerCase() === p || String(x.id) === p);
    return hit ? { slug: hit.slug, name: hit.name } : { slug: product.trim().slice(0, 120), name: product.trim().slice(0, 120) };
  }
  if (org.userId) {
    const focus = (await getPerson(org.orgId, org.userId)).focus_product;
    const hit = focus && all.find((x) => x.slug === focus);
    if (hit) return { slug: hit.slug, name: hit.name };
  }
  if (all.length === 1) return { slug: all[0]!.slug, name: all[0]!.name };
  throw new ContextError(all.length ? fillWord("ask_subject", { list: all.map((x) => x.slug).join(", ") }) : word("ask_subject_none"));
}

const aiActor = (org: Org) => `ai:${org.userId ?? "api-key"}`;

export async function saveFromAI(org: Org, a: { body: string; kind?: string; scope?: ToolScope; product?: string }): Promise<MemoryView> {
  const on = toolScopes();
  const scope = a.scope ?? (a.product && on.includes("product") ? "product" : on[0]!);
  if (!on.includes(scope)) throw new ContextError(`scope must be one of ${on.join(", ")}`);
  let subject = "", name = word("company_label");
  if (scope === "me") {
    if (!org.userId) throw new ContextError(word("personal_needs_person"));
    subject = org.userId; name = word("you_label");
  } else if (scope === "product") ({ slug: subject, name } = await subjectFor(org, a.product));
  const m = await addMemory(org.orgId, aiActor(org), { scope: scope === "me" ? "user" : scope, kind: a.kind ?? "note", body: a.body }, subject);
  return { view: "memory", action: "saved", query: "", scope, saved: { ...m, subject_name: name }, items: [] };
}

export async function searchFromAI(org: Org, a: { query?: string; scope?: ToolScope | "all"; product?: string; limit?: number }): Promise<MemoryView> {
  const db = await getDb();
  const on = scopesOn();
  const scope = a.scope ?? "all";
  const limit = Math.min(100, Math.max(1, Math.round(a.limit ?? 25)));
  const where = ["m.org_id = $1"], args: unknown[] = [org.orgId];
  const add = (v: unknown) => { args.push(v); return `$${args.length}`; };
  // Whose memory: the company's, this person's own (never anyone else's), and the subjects'.
  const mine = org.userId && on.includes("user") ? `(m.scope = 'user' AND m.subject = ${add(org.userId)})` : "FALSE";
  if (scope !== "all" && !toolScopes().includes(scope)) throw new ContextError(`scope must be one of all, ${toolScopes().join(", ")}`);
  if (scope === "company") where.push("m.scope = 'company'");
  else if (scope === "me") where.push(mine);
  else if (scope === "product") {
    where.push("m.scope = 'product'");
    if (a.product) where.push(`m.subject = ${add((await subjectFor(org, a.product)).slug)}`);
  } else {
    const shared = on.filter((s) => s !== "user").map((s) => `'${s}'`);
    where.push(`(${shared.length ? `m.scope IN (${shared.join(", ")})` : "FALSE"} OR ${mine})`);
  }
  for (const w of String(a.query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8)) where.push(`m.body ILIKE ${add(`%${w.replace(/[%_\\]/g, "\\$&")}%`)}`);
  const rows = await db.query<Omit<MemoryHit, "subject_name">>(
    `SELECT m.id::int AS id, m.scope, m.subject, m.kind, m.body, m.created_by, m.created_at
       FROM context_memories m
      WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.id DESC LIMIT ${add(limit)}`, args);
  // A subject's name where the account has it; otherwise the scope's own label (as the search has always shown).
  const names = rows.some((r) => r.scope === "product") ? new Map((await subjectsOf(org.orgId) ?? []).map((s) => [s.slug, s.name])) : new Map<string, string>();
  // subject_name right after subject, as the answer has always been laid out.
  const items = rows.map(({ id, scope, subject, ...rest }) => ({ id, scope, subject,
    subject_name: (scope === "product" ? names.get(subject) : undefined) ?? (scope === "company" ? word("company_label") : word("you_label")), ...rest }));
  return { view: "memory", action: "search", query: String(a.query ?? ""), scope, saved: null, items };
}

/** The model-readable line before the structured result. */
export function summarize(d: MemoryView): string {
  const line = (m: MemoryHit) => `#${m.id} [${m.scope === "product" ? m.subject_name : m.scope === "user" ? "you" : "company"}, ${m.kind}] ${m.body}`;
  const whose = d.saved?.scope === "user" ? "your" : d.saved?.scope === "company" ? "the company's" : `${d.saved?.subject_name}'s`;
  if (d.action === "saved") return `Saved to ${whose} memory: ${line(d.saved!)}${/[.!?]$/.test(d.saved!.body) ? "" : "."} ${word("saved_note")}`;
  const save = contextConfig()?.tools?.save ?? "the save tool";
  return d.items.length
    ? `${d.items.length} memory item(s)${d.query ? ` matching "${d.query}"` : ""}, newest first: ${d.items.map(line).join(" | ")}`
    : `Nothing in memory${d.query ? ` matches "${d.query}"` : " yet"}. Save what the team should not have to repeat with ${save}.`;
}

/** Run one of the two tools for a workspace, as the host packs' tools run (permission, tenant scope, size cap, record). */
export async function runMemoryTool(org: Org, which: "save" | "search", args: Record<string, unknown>): Promise<CallToolResult> {
  const name = (which === "save" ? contextConfig()?.tools?.save : contextConfig()?.tools?.search) ?? which;
  const t0 = performance.now();
  try {
    if (which === "save" && org.role && !canAccount(org.role, "edit")) throw new Error(accountRefusal("edit").message);
    const data = await withTenant(org.orgId, () => (which === "save" ? saveFromAI(org, args as never) : searchFromAI(org, args as never)));
    const { capResult, fitPayload } = await import("./server.js");
    const structured = fitPayload(JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
    const note = structured.truncated
      ? " (Result shortened to fit the host's size limit: page with offset/limit, lower limit, or narrow the filters for the rest.)"
      : "";
    let result: CallToolResult = { content: [{ type: "text", text: `${summarize(structured as unknown as MemoryView)}${note}\n\n${JSON.stringify(structured)}` }], structuredContent: structured };
    for (const h of hosts()) if (h.mcp?.decorate) result = await h.mcp.decorate(org, name, result).catch((e) => { console.error(`memory tool ${name}: ${h.id} decorate: ${(e as Error).message}`); return result; });
    // The in-chat tips component's waiting tip (mold_v0-143, src/tips.ts), as every tool of the build carries it.
    result = await withTip(org, name, result);
    return capResult(org, name, result, t0, args);
  } catch (err) {
    // A database error can echo other rows' values: the caller gets its code, never its text.
    const e = err as Error & { code?: unknown };
    if (e.code === "42501") console.error(`tool ${name}: refused by the database: ${e.message}`);
    const message = typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)
      ? `The request could not be completed (database error ${e.code}). Check the arguments and try again.` : e.message;
    recordMcpEvent(org, { method: "tools/call", name, ok: false, error: message, ms: performance.now() - t0, error_class: errorClass(err), req_bytes: jsonBytes(args) });
    return { isError: true, content: [{ type: "text", text: message }] };
  }
}

/** Register the two tools on a customer MCP server (src/server.ts createServer), right after the host packs' tools. */
export function registerMemoryTools(server: McpServer, org: Org) {
  const cfg = contextConfig();
  if (!cfg?.tools) return;
  const scopes = toolScopes();
  const hasSubject = scopes.includes("product");
  const save = toolWords("save"), search = toolWords("search");
  const subjectArg = (w: Record<string, string>): Record<string, z.ZodType> => (hasSubject ? { product: z.string().optional().describe(w.product!) } : {});
  const saveMeta = metaOf("save"), searchMeta = metaOf("search");
  server.registerTool(cfg.tools.save, {
    title: save.title,
    description: save.description,
    inputSchema: {
      body: z.string().min(1).max(1000).describe(save.args.body!),
      kind: z.enum(MEMORY_KINDS).optional().describe(save.args.kind!),
      scope: z.enum(scopes as [ToolScope, ...ToolScope[]]).optional().describe(save.args.scope!),
      ...subjectArg(save.args),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    ...(saveMeta ? { _meta: saveMeta } : {}),
  }, (a: Record<string, unknown>) => runMemoryTool(org, "save", a));
  server.registerTool(cfg.tools.search, {
    title: search.title,
    description: search.description,
    inputSchema: {
      query: z.string().optional().describe(search.args.query!),
      scope: z.enum(["all", ...scopes] as [string, ...string[]]).optional().describe(search.args.scope!),
      ...subjectArg(search.args),
      limit: z.number().int().min(1).max(100).optional().describe(search.args.limit!),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...(searchMeta ? { _meta: searchMeta } : {}),
  }, (a: Record<string, unknown>) => runMemoryTool(org, "search", a));
}
