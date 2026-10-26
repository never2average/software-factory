/**
 * Account context and memory (mold_v0-142; molds/mold_v0/MOLD.md "Account context and memory"): a component of the
 * shell any app turns on from pack.json `memory` (src/host.ts MemoryConfig; one pack's per build). Off (zero packs, or no
 * pack declares it) nothing of it is served: no route, no tool, nothing added to the instructions, no page.
 *
 * What it keeps, in the shell's own tables (sql/migrations/0024_account_context_memory.sql):
 *  - the company's context (account_context: what it does, who it serves, names it tracks, its own terms, notes for the
 *    AI client), set by the account's owners;
 *  - each person's own (user_context: role, focus, interests, answer style, notes), set by that person (or an owner);
 *  - memory (context_memories): short items about the company, one person, or one subject (scope `product`: one of
 *    the account's own, which a host pack's `context.subjects` hook lists, else any name as written), saved on the
 *    /app/context pages or by the AI client.
 * The company's and the person's context, with the latest memory, are appended to the MCP server's instructions when a
 * client connects (contextFor; src/http.ts). The AI client saves and searches memory with the two tools pack.json
 * `memory.tools` names (src/account-context-tools.ts). The portal's routes are contextRoutes (src/app.ts), the pages
 * the console's /app/context/<section> (web/src/features/context).
 *
 * Every text it shows or tells the AI client is a word of pack.json `memory.words` (MEMORY_WORDS: each with its neutral
 * default), so a product says it in its own words and the shell in none.
 */
import type { Request, Response, Router } from "express";
import express from "express";
import type { Org } from "./auth.js";
import { getDb } from "./db.js";
import { hosts, memoryConfig, type MemoryConfig, type PortalHelpers } from "./host.js";
import { ANSWER_STYLE_HINTS, ANSWER_STYLES, MEMORY_KINDS, MEMORY_SCOPES, MEMORY_WORDS, type MemoryScope, type MemoryWord } from "./account-context-words.js";

export { ANSWER_STYLES, MEMORY_KINDS, MEMORY_SCOPES, MEMORY_WORDS, type MemoryScope, type MemoryWord };

export class ContextError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** The component's config, or null: off. */
export const contextConfig = (): MemoryConfig | null => memoryConfig();
export const contextOn = (): boolean => contextConfig() !== null;
/** The build's scopes, in order (company, user, product: those pack.json memory.scopes names). */
export const scopesOn = (): MemoryScope[] => (contextConfig()?.scopes ?? []).filter((s): s is MemoryScope => (MEMORY_SCOPES as readonly string[]).includes(s));
export const word = (k: MemoryWord): string => contextConfig()?.words?.[k] ?? MEMORY_WORDS[k];
/** A word with its placeholders filled once (a value's own braces are never read as a placeholder). */
export const fillWord = (k: MemoryWord, vars: Record<string, string>): string => word(k).replace(/\{([a-z_]+)\}/g, (m, n: string) => (Object.hasOwn(vars, n) ? vars[n]! : m));
const styleHint = (s: string): string | undefined =>
  (ANSWER_STYLES as readonly string[]).includes(s) ? contextConfig()?.answer_styles?.[s as (typeof ANSWER_STYLES)[number]] ?? ANSWER_STYLE_HINTS[s as (typeof ANSWER_STYLES)[number]] : undefined;
/** "a, b or c". */
const orList = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

const text = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);
const list = (v: unknown, max: number) =>
  [...new Set((Array.isArray(v) ? v : String(v ?? "").split(/[\n,]/)).map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, max);

// ---------- the subjects of the `product` scope (a host pack's hook, else any name) ----------

export interface Subject { id?: number | string; slug: string; name: string }
/** The account's subjects in the order a person reads them, or null when no host pack lists them (any name is kept as written). */
export async function subjectsOf(orgId: number): Promise<Subject[] | null> {
  const h = hosts().find((x) => x.context?.subjects);
  return h ? h.context!.subjects(orgId) : null;
}
const nameMap = async (orgId: number) => new Map((await subjectsOf(orgId) ?? []).map((s) => [s.slug, s.name]));

// ---------- company and person context ----------

export interface CompanyContext { about: string | null; audience: string | null; competitors: string[]; terms: string | null; notes_for_ai: string | null;
  updated_at: Date | null; updated_by: string | null }
export interface PersonContext { title: string | null; focus_product: string | null; interests: string | null; answer_style: string | null; notes: string | null; updated_at: Date | null }

export async function getCompany(orgId: number): Promise<CompanyContext> {
  const [r] = await (await getDb()).query<CompanyContext>("SELECT about, audience, competitors, terms, notes_for_ai, updated_at, updated_by FROM account_context WHERE org_id = $1", [orgId]);
  return r ? { ...r, competitors: r.competitors ?? [] } : { about: null, audience: null, competitors: [], terms: null, notes_for_ai: null, updated_at: null, updated_by: null };
}

export async function saveCompany(orgId: number, actor: string, b: Record<string, unknown>) {
  const v = { about: text(b.about, 2000), audience: text(b.audience, 1000), competitors: list(b.competitors, 30), terms: text(b.terms, 1000), notes_for_ai: text(b.notes_for_ai, 2000) };
  await (await getDb()).query(
    `INSERT INTO account_context (org_id, about, audience, competitors, terms, notes_for_ai, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
     ON CONFLICT (org_id) DO UPDATE SET about = $2, audience = $3, competitors = $4, terms = $5, notes_for_ai = $6, updated_at = now(), updated_by = $7`,
    [orgId, v.about, v.audience, JSON.stringify(v.competitors), v.terms, v.notes_for_ai, actor]);
  return getCompany(orgId);
}

const NO_PERSON: PersonContext = { title: null, focus_product: null, interests: null, answer_style: null, notes: null, updated_at: null };

export async function getPerson(orgId: number, userId: string): Promise<PersonContext> {
  const [r] = await (await getDb()).query<PersonContext>("SELECT title, focus_product, interests, answer_style, notes, updated_at FROM user_context WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
  return r ?? { ...NO_PERSON };
}

/** Several people's context at once, keyed by user id (people with none get the empty context). */
export async function getPeople(orgId: number, userIds: string[]): Promise<Record<string, PersonContext>> {
  const rows = userIds.length ? await (await getDb()).query<PersonContext & { user_id: string }>(
    "SELECT user_id, title, focus_product, interests, answer_style, notes, updated_at FROM user_context WHERE org_id = $1 AND user_id = ANY($2)", [orgId, userIds]) : [];
  return Object.fromEntries(userIds.map((id) => { const r = rows.find((x) => x.user_id === id); if (!r) return [id, { ...NO_PERSON }]; const { user_id: _, ...c } = r; return [id, c]; }));
}

export async function savePerson(orgId: number, userId: string, b: Record<string, unknown>) {
  const style = text(b.answer_style, 20);
  if (style && !(ANSWER_STYLES as readonly string[]).includes(style)) throw new ContextError(`answer_style must be one of ${ANSWER_STYLES.join(", ")}`);
  const focus = text(b.focus_product, 80);
  // A focus names one of the account's subjects where a host pack lists them; any name otherwise.
  const subjects = focus ? await subjectsOf(orgId) : null;
  if (focus && subjects && !subjects.some((s) => s.slug === focus)) throw new ContextError(word("focus_unknown"), 404);
  await (await getDb()).query(
    `INSERT INTO user_context (org_id, user_id, title, focus_product, interests, answer_style, notes, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (org_id, user_id) DO UPDATE SET title = $3, focus_product = $4, interests = $5, answer_style = $6, notes = $7, updated_at = now()`,
    [orgId, userId, text(b.title, 120), focus, text(b.interests, 1000), style, text(b.notes, 1000)]);
  return getPerson(orgId, userId);
}

// ---------- memory ----------

export interface Memory { id: number; scope: MemoryScope; subject: string; kind: string; body: string; created_by: string | null; created_at: Date }

const SCOPE_ERROR = () => `scope must be ${orList(scopesOn())}`;
export const scopeOn = (s: string): s is MemoryScope => (scopesOn() as string[]).includes(s);

/** One subject's memory; for the `product` scope an empty subject lists every subject's (each item carries its name). */
export async function listMemories(orgId: number, scope: MemoryScope, subject: string, limit = 5000): Promise<(Memory & { subject_name: string })[]> {
  const all = scope === "product" && !subject;
  const rows = await (await getDb()).query<Memory>(
    `SELECT m.id::int AS id, m.scope, m.subject, m.kind, m.body, m.created_by, m.created_at
       FROM context_memories m
      WHERE m.org_id = $1 AND m.scope = $2 ${all ? "" : "AND m.subject = $3"} ORDER BY m.created_at DESC, m.id DESC LIMIT ${all ? "$3" : "$4"}`,
    all ? [orgId, scope, limit] : [orgId, scope, subject, limit]);
  const names = scope === "product" ? await nameMap(orgId) : new Map<string, string>();
  return rows.map((m) => ({ ...m, subject_name: names.get(m.subject) ?? m.subject }));
}

/** How many memory items each subject of a scope has (the Users page's person picker shows it). */
export async function memoryCounts(orgId: number, scope: MemoryScope): Promise<Record<string, number>> {
  const rows = await (await getDb()).query<{ subject: string; n: unknown }>(
    "SELECT subject, count(*) AS n FROM context_memories WHERE org_id = $1 AND scope = $2 GROUP BY subject", [orgId, scope]);
  return Object.fromEntries(rows.map((r) => [r.subject, Number(r.n) || 0]));
}

/**
 * A `product` memory's subject from the portal: one of the account's subjects (by key or name, any case) is kept by its
 * key, any other name as written, so memory can start before the subject exists and joins up when it does.
 */
export async function productSubject(orgId: number, name: unknown): Promise<string> {
  const n = String(name ?? "").trim().slice(0, 120);
  if (!n) throw new ContextError(word("subject_required"));
  const hit = (await subjectsOf(orgId) ?? []).find((s) => s.slug === n || s.name.toLowerCase() === n.toLowerCase());
  return hit?.slug ?? n;
}

export async function addMemory(orgId: number, actor: string | null, b: Record<string, unknown>, subject: string): Promise<Memory> {
  const scope = String(b.scope ?? "") as MemoryScope;
  if (!scopeOn(scope)) throw new ContextError(`scope must be one of ${scopesOn().join(", ")}`);
  const kind = String(b.kind ?? "note");
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) throw new ContextError(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  const body = text(b.body, 1000);
  if (!body) throw new ContextError("Write something to remember");
  if (scope === "product") subject = await productSubject(orgId, subject);
  const [m] = await (await getDb()).query<Memory>(
    `INSERT INTO context_memories (org_id, scope, subject, kind, body, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::int AS id, scope, subject, kind, body, created_by, created_at`, [orgId, scope, scope === "company" ? "" : subject, kind, body, actor]);
  return m!;
}

/** Bulk add (import): each item is { kind?, body }; an unknown kind becomes a note, empty bodies are skipped. */
export async function importMemories(orgId: number, actor: string | null, scope: MemoryScope, subject: string, items: unknown): Promise<{ imported: number; skipped: number }> {
  if (!Array.isArray(items)) throw new ContextError("items must be a list of { kind, body }");
  if (items.length > 1000) throw new ContextError("Import at most 1,000 items at a time");
  let imported = 0, skipped = 0;
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, unknown>;
    const body = text(it.body ?? it.memory, 1000);
    if (!body) { skipped++; continue; }
    const kind = (MEMORY_KINDS as readonly string[]).includes(String(it.kind ?? "").toLowerCase()) ? String(it.kind).toLowerCase() : "note";
    const about = scope === "product" ? String(it.product ?? "").trim() || subject : subject;
    if (scope === "product" && !about) { skipped++; continue; }
    await addMemory(orgId, actor, { scope, kind, body }, about);
    imported++;
  }
  return { imported, skipped };
}

export async function getMemory(orgId: number, id: number): Promise<Memory | null> {
  const [m] = await (await getDb()).query<Memory>(
    "SELECT id::int AS id, scope, subject, kind, body, created_by, created_at FROM context_memories WHERE org_id = $1 AND id = $2", [orgId, id]);
  return m ?? null;
}

export async function updateMemory(orgId: number, id: number, b: Record<string, unknown>): Promise<Memory | null> {
  const kind = String(b.kind ?? "note");
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) throw new ContextError(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  const body = text(b.body, 1000);
  if (!body) throw new ContextError("Write something to remember");
  await (await getDb()).query("UPDATE context_memories SET kind = $3, body = $4 WHERE org_id = $1 AND id = $2", [orgId, id, kind, body]);
  return getMemory(orgId, id);
}

export async function deleteMemory(orgId: number, id: number) {
  await (await getDb()).query("DELETE FROM context_memories WHERE org_id = $1 AND id = $2", [orgId, id]);
}

// ---------- what the AI client is told when it connects ----------

/**
 * The account's and the person's context and the latest memory, appended to the server's instructions. Empty when
 * nothing is set, or the component is off. It is context, not commands: names and preferences, phrased as background.
 */
export async function contextFor(org: Org): Promise<string> {
  if (!contextOn()) return "";
  const c = await getCompany(org.orgId);
  const p = org.userId ? await getPerson(org.orgId, org.userId) : null;
  const lines: string[] = [];
  const v = (k: MemoryWord, value: string) => lines.push(fillWord(k, { value }));
  if (c.about) v("context_about", c.about);
  if (c.audience) v("context_audience", c.audience);
  if (c.competitors.length) v("context_competitors", c.competitors.join(", "));
  if (c.terms) v("context_terms", c.terms);
  if (c.notes_for_ai) v("context_notes_for_ai", c.notes_for_ai);
  if (p) {
    const who = [p.title && fillWord("person_title", { value: p.title }), p.focus_product && fillWord("person_focus", { value: p.focus_product })].filter(Boolean).join("; ");
    if (who) v("person", who);
    if (p.interests) v("person_interests", p.interests);
    const hint = p.answer_style ? styleHint(p.answer_style) : undefined;
    if (hint) lines.push(hint);
    if (p.notes) v("person_notes", p.notes);
  }
  // Memory: the company's latest items, this person's, and their focus's (newest first, capped).
  const said = (m: Memory) => `${m.kind === "note" ? "" : `${m.kind}: `}${m.body}`;
  const on = scopesOn();
  const company = on.includes("company") ? await listMemories(org.orgId, "company", "", 20) : [];
  if (company.length) lines.push(`${word("memory_company")}\n  - ${company.map(said).join("\n  - ")}`);
  if (org.userId && on.includes("user")) {
    const mine = await listMemories(org.orgId, "user", org.userId, 10);
    if (mine.length) lines.push(`${word("memory_user")}\n  - ${mine.map(said).join("\n  - ")}`);
  }
  if (p?.focus_product && on.includes("product")) {
    const prod = await listMemories(org.orgId, "product", p.focus_product, 10);
    if (prod.length) lines.push(`${fillWord("memory_product", { value: p.focus_product })}\n  - ${prod.map(said).join("\n  - ")}`);
  }
  return lines.length ? `\n\n${fillWord("context_header", { account: org.name })}\n- ${lines.join("\n- ")}` : "";
}

/**
 * Everything appended to the customer MCP server's instructions for this caller (src/http.ts): the account context
 * (contextFor), then each host pack's own (src/host.ts mcp.context). Empty with zero packs.
 */
export async function connectContext(org: Org): Promise<string> {
  const own = await contextFor(org).catch(() => "");
  const theirs = (await Promise.all(hosts().map((h) => h.mcp?.context?.(org).catch(() => "") ?? ""))).join("");
  return own + theirs;
}

// ---------- the portal's routes (/api/app/context..., src/app.ts) ----------

/** The import route takes a larger body than the portal's 16 kB (its own parser): src/app.ts asks this first. */
export const contextLargeBody = (req: Request) => contextOn() && req.path === "/context/memories/import";

/**
 * /api/app/context: the company's context (owners edit), the person's own (anyone who may edit), memory (anyone who
 * may edit adds company and subject memory and their own; owners add to anyone's and delete any item, everyone else
 * what they added; viewers read), and everyone's context for owners (/context/users). Mounted only when the component
 * is on, after the host packs' routes.
 */
export function contextRoutes(api: Router, h: PortalHelpers & { perms(res: Response): readonly string[] }) {
  if (!contextOn()) return;
  const { S, need, can, actor, orgOf, AppError } = h;
  const team = async (slug: string) => (await import("./admin.js")).team(slug);
  api.get("/context", async (_req, res) => {
    const s = S(res), org = await orgOf(res);
    res.json({ company: await getCompany(s.org), person: s.user ? await getPerson(s.org, s.user) : null,
               products: (await subjectsOf(s.org) ?? []).map((p) => ({ slug: p.slug, name: p.name })), styles: ANSWER_STYLES,
               can_manage: can(res, "manage"), permissions: h.perms(res), preview: await contextFor(org) });
  });
  api.put("/context/company", async (req, res) => { need(res, "manage"); res.json(await saveCompany(S(res).org, actor(res), req.body ?? {})); });
  api.put("/context/me", async (req, res) => {
    need(res, "edit");
    res.json(await savePerson(S(res).org, S(res).user!, req.body ?? {}));
  });
  const memorySubject = async (res: Response, scope: string, subject: unknown) => {
    const s = S(res);
    if (scope !== "user") return String(subject ?? "");
    const id = String(subject || s.user || "");
    if (!id) throw new AppError("Sign in as a person to keep personal memory");
    if (id !== s.user) {
      need(res, "manage");
      if (!(await team(s.slug)).members.some((m) => m.user_id === id)) throw new AppError("Not a member of this account", 404);
    }
    return id;
  };
  api.get("/context/memories", async (req, res) => {
    const scope = String(req.query.scope ?? "");
    if (!scopeOn(scope)) throw new AppError(SCOPE_ERROR());
    const me = actor(res), admin_ = can(res, "manage"), edit = can(res, "edit");
    const memories = await listMemories(S(res).org, scope, scope === "product" && !req.query.subject ? "" : await memorySubject(res, scope, req.query.subject));
    // Items saved from chat (the save tool) are by "ai:<user id>": shown as the AI client, editable by that person.
    const mineAi = `ai:${S(res).user ?? ""}`;
    res.json({ memories: memories.map((m) => ({ ...m, created_by: m.created_by?.startsWith("ai:") ? "AI client" : m.created_by?.replace(/^customer:/, "") ?? null,
      can_delete: admin_ || (edit && (m.created_by === me || (!!S(res).user && m.created_by === mineAi))) })), kinds: MEMORY_KINDS, permissions: h.perms(res) });
  });
  api.post("/context/memories", async (req, res) => {
    need(res, "edit");
    const scope = String(req.body?.scope ?? "");
    res.status(201).json(await addMemory(S(res).org, actor(res), req.body ?? {}, await memorySubject(res, scope, req.body?.subject)));
  });
  api.post("/context/memories/import", express.json({ limit: "2mb" }), async (req, res) => {
    need(res, "edit");
    const scope = String(req.body?.scope ?? "");
    if (!scopeOn(scope)) throw new AppError(SCOPE_ERROR());
    res.json(await importMemories(S(res).org, actor(res), scope, await memorySubject(res, scope, req.body?.subject), req.body?.items));
  });
  const ownOrManage = (res: Response, m: Memory) => {
    need(res, "edit");
    if (m.created_by !== actor(res) && !(S(res).user && m.created_by === `ai:${S(res).user}`)) need(res, "manage");
  };
  api.put("/context/memories/:id", async (req, res) => {
    const m = await getMemory(S(res).org, Number(req.params.id));
    if (!m) throw new AppError("Not found", 404);
    ownOrManage(res, m);
    res.json(await updateMemory(S(res).org, m.id, req.body ?? {}));
  });
  api.delete("/context/memories/:id", async (req, res) => {
    const m = await getMemory(S(res).org, Number(req.params.id));
    if (!m) throw new AppError("Not found", 404);
    ownOrManage(res, m);
    await deleteMemory(S(res).org, m.id);
    res.status(204).end();
  });
  // Users: owners see and edit everyone's context; everyone else only their own.
  api.get("/context/users", async (_req, res) => {
    const s = S(res);
    const t = await team(s.slug);
    const members = t.members.filter((m) => can(res, "manage") || m.user_id === s.user)
      .map((m) => ({ user_id: m.user_id, email: m.email, name: m.name, role: m.role, account_role: m.account_role, active: m.status === "active" }));
    if (s.user && !members.some((m) => m.user_id === s.user)) members.unshift({ user_id: s.user, email: null, name: null, role: s.role, account_role: s.accountRole, active: true });
    const [ctx, counts] = await Promise.all([getPeople(s.org, members.map((m) => m.user_id)), memoryCounts(s.org, "user")]);
    res.json({ users: members.map((m) => ({ ...m, me: m.user_id === s.user, context: ctx[m.user_id], memories: counts[m.user_id] ?? 0 })), can_manage: can(res, "manage"), permissions: h.perms(res) });
  });
  api.put("/context/users/:userId", async (req, res) => {
    const s = S(res), id = String(req.params.userId);
    need(res, "edit");
    if (id !== s.user) {
      need(res, "manage");
      if (!(await team(s.slug)).members.some((m) => m.user_id === id)) throw new AppError("Not a member of this account", 404);
    }
    res.json(await savePerson(s.org, id, req.body ?? {}));
  });
}
