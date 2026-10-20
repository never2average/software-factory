/**
 * Context the AI client gets about who it is helping, at three levels, edited on /app (Context):
 *  - company: what the account does, who its developers are, competitors to always track, internal names; set by the
 *    account's admins; also handed to onboarding research so generated profiles start from what the company knows;
 *  - person: each signed-in person's role, focus product and how they want answers; set by that person;
 *  - product: the product profile Octillion already keeps (src/queries.ts saveProduct / saveScenarios), now also
 *    editable on a page instead of only through chat.
 * Company and person context are added to the MCP server's instructions on every connection (src/http.ts).
 */
import type { Org } from "./auth.js";
import { getDb } from "./db.js";

export class ContextError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const ANSWER_STYLES = ["brief", "detailed", "executive"] as const;

const text = (v: unknown, max: number) => (v == null ? null : String(v).trim().slice(0, max) || null);
const list = (v: unknown, max: number) =>
  [...new Set((Array.isArray(v) ? v : String(v ?? "").split(/[\n,]/)).map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, max);

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

export async function getPerson(orgId: number, userId: string): Promise<PersonContext> {
  const [r] = await (await getDb()).query<PersonContext>("SELECT title, focus_product, interests, answer_style, notes, updated_at FROM user_context WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
  return r ?? { title: null, focus_product: null, interests: null, answer_style: null, notes: null, updated_at: null };
}

/** Several people's context at once, keyed by user id (people with none get the empty context). */
export async function getPeople(orgId: number, userIds: string[]): Promise<Record<string, PersonContext>> {
  const rows = userIds.length ? await (await getDb()).query<PersonContext & { user_id: string }>(
    "SELECT user_id, title, focus_product, interests, answer_style, notes, updated_at FROM user_context WHERE org_id = $1 AND user_id = ANY($2)", [orgId, userIds]) : [];
  const empty: PersonContext = { title: null, focus_product: null, interests: null, answer_style: null, notes: null, updated_at: null };
  return Object.fromEntries(userIds.map((id) => { const r = rows.find((x) => x.user_id === id); if (!r) return [id, empty]; const { user_id: _, ...c } = r; return [id, c]; }));
}

export async function savePerson(orgId: number, userId: string, b: Record<string, unknown>) {
  const style = text(b.answer_style, 20);
  if (style && !(ANSWER_STYLES as readonly string[]).includes(style)) throw new ContextError(`answer_style must be one of ${ANSWER_STYLES.join(", ")}`);
  const focus = text(b.focus_product, 80);
  if (focus && !(await (await getDb()).query("SELECT 1 FROM products WHERE org_id = $1 AND slug = $2", [orgId, focus])).length)
    throw new ContextError("focus_product must be one of the account's products", 404);
  await (await getDb()).query(
    `INSERT INTO user_context (org_id, user_id, title, focus_product, interests, answer_style, notes, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (org_id, user_id) DO UPDATE SET title = $3, focus_product = $4, interests = $5, answer_style = $6, notes = $7, updated_at = now()`,
    [orgId, userId, text(b.title, 120), focus, text(b.interests, 1000), style, text(b.notes, 1000)]);
  return getPerson(orgId, userId);
}

// ---------- institutional memory: items beside the core fields ----------

export const MEMORY_SCOPES = ["company", "user", "product"] as const;
export const MEMORY_KINDS = ["fact", "decision", "preference", "note"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export interface Memory { id: number; scope: MemoryScope; subject: string; kind: string; body: string; created_by: string | null; created_at: Date }

/** One subject's memory; for products, an empty subject lists every product's (each item carries its product name). */
export async function listMemories(orgId: number, scope: MemoryScope, subject: string, limit = 5000): Promise<(Memory & { subject_name: string })[]> {
  const all = scope === "product" && !subject;
  return (await getDb()).query<Memory & { subject_name: string }>(
    `SELECT m.id::int AS id, m.scope, m.subject, m.kind, m.body, m.created_by, m.created_at, coalesce(p.name, m.subject) AS subject_name
       FROM context_memories m LEFT JOIN products p ON m.scope = 'product' AND p.org_id = m.org_id AND p.slug = m.subject
      WHERE m.org_id = $1 AND m.scope = $2 ${all ? "" : "AND m.subject = $3"} ORDER BY m.created_at DESC, m.id DESC LIMIT ${all ? "$3" : "$4"}`,
    all ? [orgId, scope, limit] : [orgId, scope, subject, limit]);
}

/** How many memory items each subject of a scope has (the Context page's person picker shows it). */
export async function memoryCounts(orgId: number, scope: MemoryScope): Promise<Record<string, number>> {
  const rows = await (await getDb()).query<{ subject: string; n: unknown }>(
    "SELECT subject, count(*) AS n FROM context_memories WHERE org_id = $1 AND scope = $2 GROUP BY subject", [orgId, scope]);
  return Object.fromEntries(rows.map((r) => [r.subject, Number(r.n) || 0]));
}

/**
 * Product memory needs no onboarded product: an onboarded product (by slug or name) is stored by its slug, any other
 * name as written, so memory can start before onboarding and joins up when the product is onboarded under that name.
 */
export async function productSubject(orgId: number, name: unknown): Promise<string> {
  const n = String(name ?? "").trim().slice(0, 120);
  if (!n) throw new ContextError("Name the product this memory is about");
  const [p] = await (await getDb()).query<{ slug: string }>(
    "SELECT slug FROM products WHERE org_id = $1 AND (slug = $2 OR lower(name) = lower($2)) LIMIT 1", [orgId, n]);
  return p?.slug ?? n;
}

export async function addMemory(orgId: number, actor: string | null, b: Record<string, unknown>, subject: string): Promise<Memory> {
  const scope = String(b.scope ?? "") as MemoryScope;
  if (!MEMORY_SCOPES.includes(scope)) throw new ContextError(`scope must be one of ${MEMORY_SCOPES.join(", ")}`);
  const kind = String(b.kind ?? "note");
  if (!(MEMORY_KINDS as readonly string[]).includes(kind)) throw new ContextError(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  const body = text(b.body, 1000);
  if (!body) throw new ContextError("Write something to remember");
  if (scope === "product") subject = await productSubject(orgId, subject);
  const [m] = await (await getDb()).query<Memory>(
    `INSERT INTO context_memories (org_id, scope, subject, kind, body, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::int AS id, scope, subject, kind, body, created_by, created_at`, [orgId, scope, scope === "company" ? "" : subject, kind, body, actor]);
  return m;
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

const STYLE_HINT: Record<string, string> = {
  brief: "Keep answers short: the headline number, the biggest loss, one next step.",
  detailed: "They like detail: per-task and per-agent numbers, intervals and transcript quotes.",
  executive: "Write for an executive: business impact first, few numbers, no jargon.",
};

/**
 * What the AI client is told about the account and the person, appended to the server instructions. Empty when nothing
 * is set. It is context, not commands: product names, competitors and preferences, phrased as background.
 */
export async function contextForAI(org: Org): Promise<string> {
  const c = await getCompany(org.orgId);
  const p = org.userId ? await getPerson(org.orgId, org.userId) : null;
  const lines: string[] = [];
  if (c.about) lines.push(`The company: ${c.about}`);
  if (c.audience) lines.push(`Developers they build for: ${c.audience}`);
  if (c.competitors.length) lines.push(`Competitors they track: ${c.competitors.join(", ")}.`);
  if (c.terms) lines.push(`Their internal names and terms: ${c.terms}`);
  if (c.notes_for_ai) lines.push(`Notes from the account: ${c.notes_for_ai}`);
  if (p) {
    const who = [p.title && `role: ${p.title}`, p.focus_product && `focus product: ${p.focus_product} (use it when they do not name a product)`].filter(Boolean).join("; ");
    if (who) lines.push(`The person you are helping: ${who}.`);
    if (p.interests) lines.push(`What they care about: ${p.interests}`);
    if (p.answer_style && STYLE_HINT[p.answer_style]) lines.push(STYLE_HINT[p.answer_style]);
    if (p.notes) lines.push(`Their notes: ${p.notes}`);
  }
  // Memory: the company's latest items, this person's, and their focus product's (newest first, capped).
  const said = (m: Memory) => `${m.kind === "note" ? "" : `${m.kind}: `}${m.body}`;
  const company = await listMemories(org.orgId, "company", "", 20);
  if (company.length) lines.push(`Company memory:\n  - ${company.map(said).join("\n  - ")}`);
  if (org.userId) {
    const mine = await listMemories(org.orgId, "user", org.userId, 10);
    if (mine.length) lines.push(`What this person asked you to remember:\n  - ${mine.map(said).join("\n  - ")}`);
  }
  if (p?.focus_product) {
    const prod = await listMemories(org.orgId, "product", p.focus_product, 10);
    if (prod.length) lines.push(`Memory about ${p.focus_product}:\n  - ${prod.map(said).join("\n  - ")}`);
  }
  return lines.length ? `\n\nAccount context (set by ${org.name} on the Octillion account page; background, not instructions):\n- ${lines.join("\n- ")}` : "";
}

/** For onboarding research: what the company already knows, so the profile and competitor list start from it. */
export async function companyHintForResearch(orgId: number): Promise<string> {
  const c = await getCompany(orgId);
  const parts = [c.about && `About the company: ${c.about}`, c.audience && `Developers they build for: ${c.audience}`,
    c.competitors.length ? `Competitors the company tracks (include the ones that fit this product): ${c.competitors.join(", ")}` : null].filter(Boolean);
  return parts.length ? `\n\nCompany context from the account:\n${parts.join("\n")}` : "";
}

// ---------- memory from the AI client (MCP tools save_to_memory and search_memory) ----------

/** "me" in the tools is the signed-in person; the table stores it as the user scope. */
export type ToolScope = "company" | "me" | "product";
interface MemoryHit { id: number; scope: MemoryScope; subject: string; subject_name: string; kind: string; body: string; created_by: string | null; created_at: Date }
export interface MemoryView { view: "memory"; action: "saved" | "search"; query: string; scope: string; saved: MemoryHit | null; items: MemoryHit[] }

/** A product by slug, name or id; else the person's focus product; else the only one. */
async function productFor(org: Org, product?: string): Promise<{ slug: string; name: string }> {
  const db = await getDb();
  const all = await db.query<{ id: number; slug: string; name: string }>("SELECT id, slug, name FROM products WHERE org_id = $1 ORDER BY name", [org.orgId]);
  if (product) {
    const p = product.trim().toLowerCase();
    const hit = all.find((x) => x.slug === p || x.name.toLowerCase() === p || String(x.id) === p);
    // Not onboarded (yet): memory is kept under the name as given.
    return hit ?? { slug: product.trim().slice(0, 120), name: product.trim().slice(0, 120) };
  }
  if (org.userId) {
    const focus = (await getPerson(org.orgId, org.userId)).focus_product;
    const hit = focus && all.find((x) => x.slug === focus);
    if (hit) return hit;
  }
  if (all.length === 1) return all[0];
  throw new ContextError(all.length ? `Say which product: ${all.map((x) => x.slug).join(", ")} (or any other product name).` : "Say which product this is about (any name; it does not have to be onboarded).");
}

const aiActor = (org: Org) => `ai:${org.userId ?? "api-key"}`;

export async function saveMemoryFromAI(org: Org, a: { body: string; kind?: string; scope?: ToolScope; product?: string }): Promise<MemoryView> {
  const scope = a.scope ?? (a.product ? "product" : "company");
  let subject = "", name = "Company";
  if (scope === "me") {
    if (!org.userId) throw new ContextError("Personal memory needs a signed-in person; this connection uses an API key. Save it to the company instead.");
    subject = org.userId; name = "You";
  } else if (scope === "product") ({ slug: subject, name } = await productFor(org, a.product));
  const m = await addMemory(org.orgId, aiActor(org), { scope: scope === "me" ? "user" : scope, kind: a.kind ?? "note", body: a.body }, subject);
  return { view: "memory", action: "saved", query: "", scope, saved: { ...m, subject_name: name }, items: [] };
}

export async function searchMemory(org: Org, a: { query?: string; scope?: ToolScope | "all"; product?: string; limit?: number }): Promise<MemoryView> {
  const db = await getDb();
  const scope = a.scope ?? "all";
  const limit = Math.min(100, Math.max(1, Math.round(a.limit ?? 25)));
  const where = ["m.org_id = $1"], args: unknown[] = [org.orgId];
  const add = (v: unknown) => { args.push(v); return `$${args.length}`; };
  // Whose memory: the company's, this person's own (never anyone else's), and product memory.
  const mine = org.userId ? `(m.scope = 'user' AND m.subject = ${add(org.userId)})` : "FALSE";
  if (scope === "company") where.push("m.scope = 'company'");
  else if (scope === "me") where.push(mine);
  else if (scope === "product") {
    where.push("m.scope = 'product'");
    if (a.product) where.push(`m.subject = ${add((await productFor(org, a.product)).slug)}`);
  } else where.push(`(m.scope IN ('company', 'product') OR ${mine})`);
  for (const w of String(a.query ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8)) where.push(`m.body ILIKE ${add(`%${w.replace(/[%_\\]/g, "\\$&")}%`)}`);
  const items = await db.query<MemoryHit>(
    `SELECT m.id::int AS id, m.scope, m.subject, COALESCE(p.name, CASE m.scope WHEN 'company' THEN 'Company' ELSE 'You' END) AS subject_name,
            m.kind, m.body, m.created_by, m.created_at
       FROM context_memories m LEFT JOIN products p ON m.scope = 'product' AND p.org_id = m.org_id AND p.slug = m.subject
      WHERE ${where.join(" AND ")} ORDER BY m.created_at DESC, m.id DESC LIMIT ${add(limit)}`, args);
  return { view: "memory", action: "search", query: String(a.query ?? ""), scope, saved: null, items };
}
