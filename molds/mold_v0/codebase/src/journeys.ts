/**
 * Journeys (mold_v0-143; molds/mold_v0/MOLD.md "Journeys and tips"): a component of the shell any app turns on from
 * pack.json `journeys` (src/host.ts JourneysConfig; one pack's per build). Off (zero packs, or no pack declares it)
 * nothing of it is served: no route, no page, no seeding, no progress kept.
 *
 * A journey is a real use case as a pipeline a customer replicates in their AI client, one prompt at a time: each stage
 * names the prompt to paste (its placeholders filled with the account's own values: the host pack's `journeys.values`
 * hook), the tools that complete it and what the person will see. What it keeps, in the shell's own tables
 * (sql/migrations/0026_journeys_and_tips.sql):
 *  - templates (journey_templates, org_id NULL): the platform's, written and promoted on /admin; the pack's built-in
 *    ones (pack.json journeys.templates) are seeded once each through a ledger (journey_seed), so one an admin deleted
 *    stays deleted, one still untouched follows the pack when its stages change, one an admin edited is left alone;
 *  - an account's own use cases (journey_templates with its org_id), added, imported and removed on /app/journeys;
 *  - progress (journey_progress): a stage is done when one of its tools ran successfully for the account after the
 *    previous stage was done (so re-running a pipeline counts again only from where it restarted); an /app page's
 *    action that does the same as a tool counts as that tool (src/analytics.ts recordPageAction); stages with no tool
 *    are marked by the person. Each first completion is sent once as an event (journey_started,
 *    journey_stage_completed, journey_completed);
 *  - help requests between teammates (adoption_help): someone stuck asks, a teammate picks it up, either closes it.
 * Its routes are the portal's /api/app/journeys and /api/app/adoption (journeyRoutes, src/app.ts) and the admin
 * console's /api/admin/onboarding/playbooks (journeyAdminRoutes, src/http.ts); its pages /app/journeys, /admin/journeys
 * and the journey picker on /app Setup (web/src/features/journeys, web/src/features/portal/setup.tsx).
 *
 * Every text is a word (pack.json journeys.words over src/journeys-words.ts), its placeholders the build's words for a
 * journey ({guide}: the shell texts journeys.one and journeys.many) and its product's name.
 */
import type { Request, Response, Router } from "express";
import express from "express";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { capture, keepAlive } from "./telemetry.js";
import { hostToolNames, hosts, journeysConfig, memoryToolNames, setupWorkflow, type AdminHelpers, type JourneyStage, type JourneyTemplate, type JourneysConfig, type PortalHelpers } from "./host.js";
import { JOURNEY_WORDS, MAX_IMPORT, MAX_STAGES, type JourneyWord } from "./journeys-words.js";
import { shellText } from "./texts.js";
import { PROFILE } from "./profile.js";
import { reportRange } from "./insights.js";

export class JourneyError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/** The component's config, or null: off. */
export const journeysOn = (): boolean => journeysConfig() !== null;
const config = (): JourneysConfig => journeysConfig() ?? {};
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
/** The build's words for a journey and the product's name, as a word's placeholders read them. */
export const journeyNouns = (): Record<string, string> => {
  const one = shellText("journeys.one"), many = shellText("journeys.many");
  return { guide: one, guides: many, Guide: cap(one), Guides: cap(many), product: PROFILE.name };
};
/** One word, the pack's or the shell's, its placeholders filled once (a value's own braces are never read as one). */
export function word(k: JourneyWord, vars: Record<string, string | number> = {}): string {
  const all: Record<string, string> = { ...journeyNouns(), ...Object.fromEntries(Object.entries(vars).map(([a, b]) => [a, String(b)])) };
  return (config().words?.[k] ?? JOURNEY_WORDS[k]).replace(/\{([A-Za-z_]+)\}/g, (m, n: string) => (Object.hasOwn(all, n) ? all[n]! : m));
}
const fail = (k: JourneyWord, status = 400, vars: Record<string, string | number> = {}) => new JourneyError(word(k, vars), status);

/** The tools a stage may name: the product's own (every host pack's) and the memory component's (src/host.ts). */
export const journeyToolNames = (): string[] => [...hostToolNames(), ...memoryToolNames()];
/** The built-in templates' ids (pack.json journeys.templates): the console tells them from ones written by hand. */
export const builtInIds = (): string[] => (config().templates ?? []).map((t) => t.id);

// ---------- templates in the database (managed on /admin) ----------

interface Row { id: string; name: string; outcome: string; who: string; time: string; example_title: string; example_result: string;
  stages: JourneyStage[]; promoted: boolean; position: number; updated_at: Date; updated_by: string | null; org_id: number | null }
export type Template = JourneyTemplate & { promoted: boolean; position: number; updated_at: Date; updated_by: string | null; own: boolean };

const toTemplate = (r: Row): Template => ({
  id: r.id, name: r.name, outcome: r.outcome, who: r.who, time: r.time, example: { title: r.example_title, result: r.example_result },
  stages: r.stages, promoted: r.promoted, position: r.position, updated_at: r.updated_at, updated_by: r.updated_by, own: r.org_id != null,
});

let seeded = false;
/** Tests: seed again on the next read, as a fresh server would. */
export const __resetSeed = () => { seeded = false; };

/**
 * The pack's built-in templates, through a ledger (journey_seed): each is added once, so one an admin deleted stays
 * deleted; one still untouched (updated_by 'built-in') follows the pack when its stages change; one an admin edited is
 * left alone. A database that has templates but no ledger (seeded before it) has the `seeded_before_ledger` ones.
 */
async function ensureSeeded() {
  // Shared rows, the platform's (src/tenant-scope.ts).
  return asPlatform(async () => {
    if (seeded) return;
    const db = await getDb();
    const builtIns = config().templates ?? [];
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*) AS n FROM journey_seed");
    if (!Number(n)) {
      const [{ t }] = await db.query<{ t: number }>("SELECT count(*) AS t FROM journey_templates");
      if (Number(t)) for (const id of config().seeded_before_ledger ?? []) await db.query("INSERT INTO journey_seed (id) VALUES ($1) ON CONFLICT DO NOTHING", [id]);
    }
    const done = new Set((await db.query<{ id: string }>("SELECT id FROM journey_seed")).map((r) => r.id));
    for (const p of builtIns) {
      if (done.has(p.id)) {
        await db.query("UPDATE journey_templates SET stages = $2, updated_at = now() WHERE id = $1 AND updated_by = 'built-in' AND org_id IS NULL AND stages::text <> $2::jsonb::text",
          [p.id, JSON.stringify(p.stages)]);
        continue;
      }
      const [{ next }] = await db.query<{ next: number }>("SELECT coalesce(max(position), -1) + 1 AS next FROM journey_templates WHERE org_id IS NULL");
      await db.query(
        `INSERT INTO journey_templates (id, name, outcome, who, time, example_title, example_result, stages, promoted, position, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, 'built-in') ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.outcome, p.who, p.time, p.example.title, p.example.result, JSON.stringify(p.stages), Number(next)]);
      await db.query("INSERT INTO journey_seed (id) VALUES ($1) ON CONFLICT DO NOTHING", [p.id]);
    }
    seeded = true;
  });
}

/** Global templates (promoted only, if asked), plus with `orgId` that account's own use cases. */
export async function listTemplates(opts: { promotedOnly?: boolean; orgId?: number } = {}): Promise<Template[]> {
  await ensureSeeded();
  const global = `org_id IS NULL${opts.promotedOnly ? " AND promoted" : ""}`;
  const rows = await (await getDb()).query<Row>(
    `SELECT * FROM journey_templates WHERE (${global})${opts.orgId != null ? " OR org_id = $1" : ""} ORDER BY org_id NULLS FIRST, position, name`,
    opts.orgId != null ? [opts.orgId] : []);
  return rows.map(toTemplate);
}

/**
 * An account's own use case (Add use case on /app/journeys): a name, the outcome and its steps, each a prompt to type,
 * optionally tied to the product's tools that complete it (a step without tools is marked done by hand).
 */
export async function createUseCase(org: { orgId: number; slug: string }, actor: string, b: Record<string, any>) {
  const stages = (Array.isArray(b.stages) ? b.stages : []).filter((st: any) => String(st?.title ?? "").trim() || String(st?.prompt ?? "").trim())
    .map((st: any) => ({ ...st, title: String(st.title ?? "").trim() || String(st.prompt ?? "").trim().slice(0, 80), expect: String(st.expect ?? "").trim() || word("default_expect") }));
  const t = cleanTemplate({ ...b, stages });
  const db = await getDb();
  const base = `${org.slug}-${slug(t.name)}`.slice(0, 60);
  let id = base;
  for (let i = 2; (await db.query("SELECT 1 FROM journey_templates WHERE id = $1", [id])).length; i++) id = `${base}-${i}`;
  await db.query(
    `INSERT INTO journey_templates (id, name, outcome, who, time, example_title, example_result, stages, promoted, position, updated_by, org_id)
     VALUES ($1, $2, $3, '', '', '', '', $4, false, 0, $5, $6)`, [id, t.name, t.outcome, JSON.stringify(t.stages), actor, org.orgId]);
  return id;
}

/** Remove an account's own use case: whoever added it, or an account admin. Global templates are managed on /admin. */
export async function deleteUseCase(orgId: number, id: string, actor: string, isAdmin: boolean) {
  const db = await getDb();
  const [r] = await db.query<{ updated_by: string | null }>("SELECT updated_by FROM journey_templates WHERE id = $1 AND org_id = $2", [id, orgId]);
  if (!r) throw fail("no_own_use_case", 404);
  if (!isAdmin && r.updated_by !== actor) throw fail("remove_own_only", 403);
  await db.query("DELETE FROM journey_progress WHERE org_id = $1 AND journey_id = $2", [orgId, id]);
  await db.query("DELETE FROM journey_templates WHERE id = $1 AND org_id = $2", [id, orgId]);
}

const slug = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
const txt = (v: unknown, max: number, field: string, required = true) => {
  const s = String(v ?? "").trim().slice(0, max);
  if (required && !s) throw new JourneyError(`${field} is required`);
  return s;
};

/** Check and normalise a template from the admin editor or a use case. `tools` must be the product's tool names. */
export function cleanTemplate(b: Record<string, any>, toolNames: readonly string[] = journeyToolNames()) {
  const stagesIn = Array.isArray(b.stages) ? b.stages : [];
  if (!stagesIn.length || stagesIn.length > MAX_STAGES) throw fail("stages_count", 400, { max: MAX_STAGES });
  const ids = new Set<string>();
  const stages: JourneyStage[] = stagesIn.map((st: any, i: number) => {
    const id = slug(st.id || st.title) || `stage-${i + 1}`;
    if (ids.has(id)) throw fail("stage_twice", 400, { id });
    ids.add(id);
    const tools = (Array.isArray(st.tools) ? st.tools : []).map(String).filter(Boolean);
    const bad = tools.find((t: string) => !toolNames.includes(t));
    if (bad) throw fail("not_a_tool", 400, { n: i + 1, tool: bad });
    const manual = Boolean(st.manual) || tools.length === 0;
    return { id, title: txt(st.title, 120, `Stage ${i + 1} title`), why: txt(st.why, 500, `Stage ${i + 1} why`, false),
             prompt: txt(st.prompt, 600, `Stage ${i + 1} prompt`), tools, expect: txt(st.expect, 500, `Stage ${i + 1} "you'll see"`), ...(manual ? { manual: true } : {}),
             ...(typeof st.link?.href === "string" && /^\/app(\/[a-z0-9/-]*)?$/.test(st.link.href) ? { link: { href: st.link.href, label: txt(st.link.label, 60, `Stage ${i + 1} link label`, false) || "Open" } } : {}) };
  });
  return {
    name: txt(b.name, 80, "name"), outcome: txt(b.outcome, 300, "outcome"), who: txt(b.who, 200, "who", false), time: txt(b.time, 80, "time", false),
    example_title: txt(b.example?.title ?? b.example_title, 120, "example title", false), example_result: txt(b.example?.result ?? b.example_result, 600, "example result", false),
    stages,
  };
}

export async function createTemplate(actor: string, b: Record<string, any>) {
  await ensureSeeded();
  const t = cleanTemplate(b);
  const id = slug(b.id || t.name);
  if (!id) throw fail("needs_name");
  const db = await getDb();
  const [{ next }] = await db.query<{ next: number }>("SELECT coalesce(max(position), -1) + 1 AS next FROM journey_templates");
  try {
    await db.query(
      `INSERT INTO journey_templates (id, name, outcome, who, time, example_title, example_result, stages, promoted, position, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, t.name, t.outcome, t.who, t.time, t.example_title, t.example_result, JSON.stringify(t.stages), Boolean(b.promoted), Number(next), actor]);
  } catch (e) {
    if (/duplicate|unique/i.test((e as Error).message)) throw fail("exists", 409, { id });
    throw e;
  }
  return id;
}

export async function updateTemplate(actor: string, id: string, b: Record<string, any>) {
  await ensureSeeded();
  const t = cleanTemplate(b);
  const r = await (await getDb()).query(
    `UPDATE journey_templates SET name = $2, outcome = $3, who = $4, time = $5, example_title = $6, example_result = $7, stages = $8,
            updated_at = now(), updated_by = $9 WHERE id = $1 RETURNING id`,
    [id, t.name, t.outcome, t.who, t.time, t.example_title, t.example_result, JSON.stringify(t.stages), actor]);
  if (!r.length) throw fail("no_such", 404);
}

export async function setPromoted(actor: string, id: string, promoted: boolean) {
  const r = await (await getDb()).query("UPDATE journey_templates SET promoted = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING id", [id, promoted, actor]);
  if (!r.length) throw fail("no_such", 404);
}

export async function reorder(actor: string, ids: unknown) {
  if (!Array.isArray(ids) || !ids.length) throw fail("reorder_ids");
  const db = await getDb();
  for (const [i, id] of ids.entries()) await db.query("UPDATE journey_templates SET position = $2, updated_by = $3 WHERE id = $1", [String(id), i, actor]);
}

export async function deleteTemplate(id: string) {
  const r = await (await getDb()).query("DELETE FROM journey_templates WHERE id = $1 RETURNING id", [id]);
  if (!r.length) throw fail("no_such", 404);
}

// ---------- progress, events and analytics ----------

/**
 * Record newly done stages for an account and send the journey events once each: journey_started (first stage of a
 * journey), journey_stage_completed, journey_completed. Runs after tool calls and when /app loads journeys.
 */
export async function syncProgress(org: { orgId: number; slug: string }, distinctId?: string) {
  const db = await getDb();
  const templates = await listTemplates({ promotedOnly: true, orgId: org.orgId });
  const progress = await progressFor(org.orgId, templates);
  const have = new Set((await db.query<{ journey_id: string; stage_id: string }>(
    "SELECT journey_id, stage_id FROM journey_progress WHERE org_id = $1", [org.orgId])).map((r) => `${r.journey_id}/${r.stage_id}`));
  const actor = { distinctId: distinctId ?? `org:${org.slug}`, orgSlug: org.slug };
  for (const p of progress) {
    const before = p.stages.filter((x) => have.has(`${p.id}/${x.id}`)).length;
    let added = 0;
    for (const [i, st] of p.stages.entries()) {
      if (!st.done || st.manual || have.has(`${p.id}/${st.id}`)) continue; // manual stages are recorded when marked
      const r = await db.query("INSERT INTO journey_progress (org_id, journey_id, stage_id, done_at, source) VALUES ($1, $2, $3, $4, 'tool') ON CONFLICT DO NOTHING RETURNING stage_id",
        [org.orgId, p.id, st.id, st.at]);
      if (!r.length) continue;
      if (before + added === 0) capture(actor, "journey_started", { journey: p.id });
      added++;
      capture(actor, "journey_stage_completed", { journey: p.id, stage: st.id, stage_index: i + 1, stages: p.total, source: "tool" });
    }
    if (added && p.done === p.total) capture(actor, "journey_completed", { journey: p.id, stages: p.total });
  }
  return progress;
}

const pending = new Map<number, ReturnType<typeof setTimeout>>();
/** After a tool call: sync this account's journey progress a few seconds later (calls in a burst sync once). Off: nothing. */
export function scheduleSync(org: { orgId: number; slug: string }, distinctId?: string) {
  if (!journeysOn()) return;
  if (process.env.VERCEL) { keepAlive(syncProgress(org, distinctId).catch((e) => console.error("progress sync:", (e as Error).message))); return; }
  if (pending.has(org.orgId)) return;
  pending.set(org.orgId, setTimeout(() => {
    pending.delete(org.orgId);
    syncProgress(org, distinctId).catch((e) => console.error("progress sync:", (e as Error).message));
  }, 3000).unref());
}

/** A person marks a stage with no tool (e.g. "ship the fix") done, or undoes it. */
export async function markStage(org: { orgId: number; slug: string }, userId: string | null, journeyId: string, stageId: string, done: boolean) {
  const t = (await listTemplates({ orgId: org.orgId })).find((x) => x.id === journeyId);
  const st = t?.stages.find((x) => x.id === stageId);
  if (!t || !st) throw fail("no_such_stage", 404);
  if (!st.manual) throw fail("stage_by_tools");
  const db = await getDb();
  const actor = { distinctId: userId ?? `org:${org.slug}`, orgSlug: org.slug };
  if (done) {
    const r = await db.query("INSERT INTO journey_progress (org_id, journey_id, stage_id, source, user_id) VALUES ($1, $2, $3, 'manual', $4) ON CONFLICT DO NOTHING RETURNING stage_id",
      [org.orgId, journeyId, stageId, userId]);
    if (r.length) capture(actor, "journey_stage_completed", { journey: journeyId, stage: stageId, stage_index: t.stages.indexOf(st) + 1, stages: t.stages.length, source: "manual" });
  } else {
    await db.query("DELETE FROM journey_progress WHERE org_id = $1 AND journey_id = $2 AND stage_id = $3 AND source = 'manual'", [org.orgId, journeyId, stageId]);
  }
  return syncProgress(org, userId ?? undefined);
}

/**
 * For /admin: every template with its funnel across accounts: how many reached each stage, started, completed, the
 * median time from first stage to completion, and the stage where most accounts stopped.
 */
export async function templatesWithAdoption() {
  const templates = await listTemplates();
  const rows = await (await getDb()).query<{ org_id: number; journey_id: string; stage_id: string; done_at: Date }>(
    "SELECT org_id, journey_id, stage_id, done_at FROM journey_progress");
  const [{ n: active }] = await (await getDb()).query<{ n: number }>("SELECT count(DISTINCT org_id) AS n FROM mcp_events WHERE method = 'tools/call'");
  return templates.map((t) => {
    const mine = rows.filter((r) => r.journey_id === t.id);
    const byOrg = new Map<number, Map<string, Date>>();
    for (const r of mine) { const m = byOrg.get(r.org_id) ?? new Map(); m.set(r.stage_id, r.done_at); byOrg.set(r.org_id, m); }
    const stageIds = t.stages.map((s) => s.id);
    const funnel = t.stages.map((s) => ({ id: s.id, title: s.title, reached: [...byOrg.values()].filter((m) => m.has(s.id)).length }));
    const completedOrgs = [...byOrg.values()].filter((m) => stageIds.every((id) => m.has(id)));
    const hours = completedOrgs.map((m) => {
      const ts = stageIds.map((id) => new Date(m.get(id)!).getTime());
      return (Math.max(...ts) - Math.min(...ts)) / 3_600_000;
    }).sort((a, b) => a - b);
    const median = hours.length ? hours[Math.floor(hours.length / 2)] : null;
    // Where accounts stop: the stage with the biggest drop from the one before it.
    let dropoff: { id: string; title: string; lost: number } | null = null;
    for (let i = 1; i < funnel.length; i++) {
      const lost = funnel[i - 1]!.reached - funnel[i]!.reached;
      if (lost > 0 && (!dropoff || lost > dropoff.lost)) dropoff = { id: funnel[i]!.id, title: funnel[i]!.title, lost };
    }
    const last = mine.reduce<Date | null>((a, r) => (!a || new Date(r.done_at) > new Date(a) ? r.done_at : a), null);
    return { ...t, adoption: { started: byOrg.size, completed: completedOrgs.length, median_hours_to_complete: median, dropoff, last_activity: last, funnel },
             accounts_active: Number(active) };
  });
}

/** Every promoted journey with its stages marked from this account's tool calls, prompts filled in with its values. */
export async function journeysFor(orgId: number) {
  return progressFor(orgId, await listTemplates({ promotedOnly: true, orgId }));
}

/** The values a stage's placeholders read for one account: the host pack's (src/host.ts journeys.values), else none. */
async function valuesFor(orgId: number): Promise<Record<string, string>> {
  const h = hosts().find((x) => x.journeys?.values);
  return h ? h.journeys!.values(orgId) : {};
}

async function progressFor(orgId: number, templates: Template[]) {
  const db = await getDb();
  const marked = new Map((await db.query<{ journey_id: string; stage_id: string; done_at: Date }>(
    "SELECT journey_id, stage_id, done_at FROM journey_progress WHERE org_id = $1 AND source = 'manual'", [orgId])).map((r) => [`${r.journey_id}/${r.stage_id}`, r.done_at]));
  const events = await db.query<{ name: string; at: Date }>(
    "SELECT name, at FROM mcp_events WHERE org_id = $1 AND method IN ('tools/call', 'page/action') AND ok ORDER BY at", [orgId]); // page/action: the /app pages' equivalent of a tool
  const values = await valuesFor(orgId);
  const fill = (t: string) => t.replace(/\{([a-z_]+)\}/g, (m, n: string) => (Object.hasOwn(values, n) ? values[n]! : m));
  return templates.map((p) => {
    let since = 0; // a stage only counts tool calls after the previous stage was done
    const stages = p.stages.map((st) => {
      const manualAt = st.manual ? marked.get(`${p.id}/${st.id}`) ?? null : null;
      const hit = st.manual ? null : events.find((e) => st.tools.includes(e.name) && new Date(e.at).getTime() >= since);
      const at = hit?.at ?? manualAt;
      if (at) since = Math.max(since, new Date(at).getTime());
      return { ...st, prompt: fill(st.prompt), why: fill(st.why), expect: fill(st.expect), done: Boolean(at), at };
    });
    const own = Boolean(p.own); // the account's own use case, not a global template
    return { id: p.id, name: p.name, outcome: p.outcome, who: p.who, time: p.time, example: { ...p.example }, stages,
             done: stages.filter((x) => x.done).length, total: stages.length, manualCount: stages.filter((x) => x.manual).length,
             own, added_by: own ? (p.updated_by ?? null) : null };
  });
}

// ---------- adoption per person (/app/journeys) ----------

export interface PersonProgress {
  user_id: string; done: number; total: number; calls: number; errors: number; last_error: string | null;
  stuck: string | null; at: string | null; finished: boolean;
}

/**
 * Each use case, person by person: the same stage rules as the account's progress (a stage counts tool calls after the
 * previous one), on that person's own tool calls; plus their calls and failures on the use case's tools, where they
 * are stuck, and who can help (whoever finished it, else got furthest).
 */
export async function adoptionByPerson(orgId: number, opts: { start?: Date; end?: Date; users?: string[] } = {}) {
  const db = await getDb();
  // Progress counts all time (a stage done last quarter is still done); the range picks who shows up (anyone active in
  // it) and what their calls and errors count. users narrows to those people.
  const inRange = (at: Date) => (!opts.start || new Date(at) >= opts.start) && (!opts.end || new Date(at) < opts.end);
  const only = opts.users?.length ? new Set(opts.users) : null;
  const journeys = await journeysFor(orgId);
  const events = await db.query<{ user_id: string; name: string; ok: boolean; error: string | null; at: Date }>(
    "SELECT user_id, name, ok, error, at FROM mcp_events WHERE org_id = $1 AND method IN ('tools/call', 'page/action') AND user_id IS NOT NULL ORDER BY at", [orgId]);
  const marked = await db.query<{ journey_id: string; stage_id: string; user_id: string | null; done_at: Date }>(
    "SELECT journey_id, stage_id, user_id, done_at FROM journey_progress WHERE org_id = $1 AND source = 'manual'", [orgId]);
  const byUser = new Map<string, typeof events>();
  for (const e of events) (byUser.get(e.user_id) ?? byUser.set(e.user_id, []).get(e.user_id)!).push(e);
  return journeys.map((j) => {
    const tools = new Set(j.stages.flatMap((s) => s.tools));
    const people: PersonProgress[] = [];
    const users = new Set([...byUser.keys(), ...marked.filter((m) => m.journey_id === j.id && m.user_id).map((m) => m.user_id!)]);
    for (const user of users) {
      if (only && !only.has(user)) continue;
      const mine = (byUser.get(user) ?? []).filter((e) => tools.has(e.name));
      const marks = marked.filter((m) => m.journey_id === j.id && m.user_id === user);
      if (!mine.length && !marks.length) continue; // never touched this use case
      const recent = mine.filter((e) => inRange(e.at));
      if (!recent.length && !marks.some((m) => inRange(m.done_at))) continue; // nothing in the range
      let since = 0, done = 0, stuck: string | null = null, lastMs = 0;
      for (const st of j.stages) {
        const at = st.manual ? marks.find((m) => m.stage_id === st.id)?.done_at ?? null
          : mine.find((e) => e.ok && st.tools.includes(e.name) && new Date(e.at).getTime() >= since)?.at ?? null;
        if (at) { done++; since = Math.max(since, new Date(at).getTime()); lastMs = Math.max(lastMs, new Date(at).getTime()); }
        else stuck ??= st.title;
      }
      const failed = recent.filter((e) => !e.ok);
      const lastAt = mine.reduce((m, e) => Math.max(m, new Date(e.at).getTime()), lastMs);
      people.push({ user_id: user, done, total: j.stages.length, calls: recent.length, errors: failed.length, last_error: failed.at(-1)?.error ?? null,
        stuck: done < j.stages.length ? stuck : null, at: lastAt ? new Date(lastAt).toISOString() : null, finished: done === j.stages.length });
    }
    people.sort((a, b) => b.done - a.done || b.calls - a.calls);
    const helper = people.find((x) => x.finished) ?? people.find((x) => x.done > 0) ?? null;
    return { id: j.id, name: j.name, outcome: j.outcome, own: j.own, added_by: j.added_by, total: j.stages.length, people, helper: helper?.user_id ?? null };
  });
}

// ---------- import ----------

/** Import use cases from a file (the page's export, or any list of { name, outcome, stages: [{ title, prompt }] }). A
 *  name the account already has (its own or a template) is skipped, so importing the same file twice adds nothing. */
export async function importUseCases(org: { orgId: number; slug: string }, actor: string, items: unknown) {
  if (!Array.isArray(items)) throw fail("import_list");
  if (items.length > MAX_IMPORT) throw fail("import_max", 400, { max: MAX_IMPORT });
  const taken = new Set((await journeysFor(org.orgId)).map((j) => j.name.trim().toLowerCase()));
  let imported = 0, skipped = 0;
  const errors: string[] = [];
  for (const it of items as Record<string, any>[]) {
    const name = String(it?.name ?? "").trim();
    if (!name || taken.has(name.toLowerCase())) { skipped++; continue; }
    try {
      await createUseCase(org, actor, { name, outcome: it.outcome, stages: it.stages });
      taken.add(name.toLowerCase()); imported++;
    } catch (e) { skipped++; if (errors.length < 5) errors.push(`${name}: ${(e as Error).message}`); }
  }
  return { imported, skipped, errors };
}

// ---------- help requests ----------
// Someone stuck on a use case asks the team; a teammate picks it up (and gets the asker's email and where they are
// stuck), then either of them marks it done. One live request per person per use case.

export interface HelpRequest { id: number; journey_id: string; requester: string; helper: string | null; note: string; status: "open" | "picked" | "done"; created_at: string; picked_at: string | null }

export async function helpRequests(orgId: number): Promise<HelpRequest[]> {
  const db = await getDb();
  return db.query<HelpRequest>(
    `SELECT id::int AS id, journey_id, requester, helper, note, status, created_at, picked_at FROM adoption_help
      WHERE org_id = $1 AND (status <> 'done' OR closed_at > now() - interval '14 days') ORDER BY created_at DESC LIMIT 500`, [orgId]);
}

export async function askForHelp(orgId: number, journeyId: string, requester: string, note: unknown) {
  const db = await getDb();
  if (!(await journeysFor(orgId)).some((j) => j.id === journeyId)) throw fail("no_use_case", 404);
  const [live] = await db.query<{ id: number }>(
    "SELECT id::int AS id FROM adoption_help WHERE org_id = $1 AND journey_id = $2 AND requester = $3 AND status <> 'done'", [orgId, journeyId, requester]);
  if (live) return live.id;
  const [r] = await db.query<{ id: number }>(
    "INSERT INTO adoption_help (org_id, journey_id, requester, note) VALUES ($1, $2, $3, $4) RETURNING id::int AS id",
    [orgId, journeyId, requester, String(note ?? "").trim().slice(0, 500)]);
  return r!.id;
}

async function helpRow(orgId: number, id: number) {
  const db = await getDb();
  const [r] = await db.query<HelpRequest>("SELECT id::int AS id, journey_id, requester, helper, status FROM adoption_help WHERE org_id = $1 AND id = $2", [orgId, id]);
  if (!r) throw fail("no_help", 404);
  return r;
}

/** Pick up someone else's open request. */
export async function pickUpHelp(orgId: number, id: number, helper: string) {
  const r = await helpRow(orgId, id);
  if (r.requester === helper) throw fail("own_request");
  if (r.status !== "open") throw fail(r.status === "picked" ? "picked_already" : "closed", 409);
  const db = await getDb();
  await db.query("UPDATE adoption_help SET helper = $3, status = 'picked', picked_at = now() WHERE org_id = $1 AND id = $2 AND status = 'open'", [orgId, id, helper]);
  return r;
}

/** done: the asker or the helper closes it. release: the helper hands it back. cancel: the asker withdraws it. */
export async function updateHelp(orgId: number, id: number, actor: string, action: "done" | "release" | "cancel") {
  const r = await helpRow(orgId, id);
  const db = await getDb();
  if (action === "cancel") {
    if (r.requester !== actor) throw fail("withdraw_own", 403);
    await db.query("DELETE FROM adoption_help WHERE org_id = $1 AND id = $2", [orgId, id]);
  } else if (action === "release") {
    if (r.helper !== actor) throw fail("release_helper", 403);
    await db.query("UPDATE adoption_help SET helper = NULL, status = 'open', picked_at = NULL WHERE org_id = $1 AND id = $2", [orgId, id]);
  } else {
    if (r.requester !== actor && r.helper !== actor) throw fail("close_who", 403);
    await db.query("UPDATE adoption_help SET status = 'done', closed_at = now() WHERE org_id = $1 AND id = $2", [orgId, id]);
  }
}

// ---------- routes ----------

/** The portal's import parses its own (larger) body. */
export const journeysLargeBody = (req: Request) => journeysOn() && req.path === "/journeys/import";

/**
 * /api/app/journeys and /api/app/adoption (src/app.ts, after the host packs' portal routes): the journeys with this
 * account's progress (the Setup page's picker, /app/journeys), its own use cases (anyone who may edit adds; whoever
 * added one or an admin removes it), their import, adoption person by person with help requests, a journey viewed, a
 * manual stage marked. Only when the component is on.
 */
export function journeyRoutes(api: Router, h: PortalHelpers) {
  if (!journeysOn()) return;
  const { S, need, can, actor, AppError } = h;
  const team = async (slug: string) => (await import("./admin.js")).team(slug);
  const who = (res: Response) => ({ distinctId: S(res).user ?? `org:${S(res).slug}`, orgSlug: S(res).slug });
  // Journeys on Setup and /app/journeys: pipelines with real progress.
  api.get("/journeys", async (_req, res) => {
    await syncProgress({ orgId: S(res).org, slug: S(res).slug }, S(res).user ?? undefined).catch((e) => console.error("progress sync:", e.message));
    res.json({ journeys: await journeysFor(S(res).org) });
  });
  api.post("/journeys", async (req, res) => {
    need(res, "edit");
    const id = await createUseCase({ orgId: S(res).org, slug: S(res).slug }, actor(res), req.body ?? {});
    capture(who(res), "use_case_added", { journey: id });
    res.status(201).json({ id });
  });
  api.delete("/journeys/:id", async (req, res) => {
    need(res, "edit");
    await deleteUseCase(S(res).org, String(req.params.id), actor(res), can(res, "manage"));
    res.status(204).end();
  });
  // Import use cases from a file: up to MAX_IMPORT, names the account already has are skipped.
  api.post("/journeys/import", express.json({ limit: "1mb" }), async (req, res) => {
    need(res, "edit");
    const r = await importUseCases({ orgId: S(res).org, slug: S(res).slug }, actor(res), req.body?.items);
    capture(who(res), "use_cases_imported", { imported: r.imported, skipped: r.skipped });
    res.json(r);
  });
  // Adoption person by person: who uses each use case, how far they got, where they are stuck, who can help, the open
  // help requests, and who used each part of the Setup page's workflow. from/to (YYYY-MM-DD) pick who was active;
  // user=a,b narrows to those people.
  api.get("/adoption", async (req, res) => {
    const s = S(res);
    const range = req.query.from || req.query.to ? reportRange(req.query) : null;
    const users = String(req.query.user ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 200);
    const [rows, t, help, calls] = await Promise.all([adoptionByPerson(s.org, { start: range?.start, end: range?.end, users }), team(s.slug), helpRequests(s.org),
      // Who used each workflow part: tool calls by person (null = a connector key, not a signed-in person).
      (await getDb()).query<{ user_id: string | null; name: string; calls: number; last: Date }>(
        `SELECT user_id, name, count(*)::int AS calls, max(at) AS last FROM mcp_events
          WHERE org_id = $1 AND method = 'tools/call' AND name IS NOT NULL AND ($2::timestamptz IS NULL OR at >= $2) AND ($3::timestamptz IS NULL OR at < $3)
          GROUP BY user_id, name`, [s.org, range?.start ?? null, range?.end ?? null])]);
    const whoIs = new Map(t.members.map((m) => [m.user_id, m.email ?? m.name ?? null]));
    const label = (id: string | null) => (id ? (id === s.user ? "You" : whoIs.get(id) ?? "Former member") : null);
    res.json({ me: s.user, use_cases: rows.map((r) => ({ ...r, helper_label: label(r.helper), helper_email: r.helper ? whoIs.get(r.helper) ?? null : null,
      people: r.people.map((x) => ({ ...x, label: label(x.user_id), email: whoIs.get(x.user_id) ?? null })) })),
      help: help.map((x) => ({ ...x, requester_label: label(x.requester), requester_email: whoIs.get(x.requester) ?? null,
        helper_label: label(x.helper), helper_email: x.helper ? whoIs.get(x.helper) ?? null : null })),
      members: t.members.filter((m) => m.user_id).map((m) => ({ user_id: m.user_id, label: label(m.user_id),
        calls: calls.reduce((n, c) => n + (c.user_id === m.user_id ? Number(c.calls) : 0), 0) })),
      workflow: setupWorkflow().map((g) => {
        const byUser = new Map<string | null, { used: Set<string>; calls: number; last: Date | null }>();
        for (const c of calls) {
          if (!(g.tools as readonly string[]).includes(c.name) || (users.length && (!c.user_id || !users.includes(c.user_id)))) continue;
          const u = byUser.get(c.user_id) ?? { used: new Set<string>(), calls: 0, last: null };
          u.used.add(c.name); u.calls += Number(c.calls); u.last = !u.last || c.last > u.last ? c.last : u.last;
          byUser.set(c.user_id, u);
        }
        return { id: g.id, people: [...byUser].map(([id, u]) => ({ user_id: id, label: id ? label(id) : "Connector key", email: id ? whoIs.get(id) ?? null : null,
          used: u.used.size, total: g.tools.length, calls: u.calls, last: u.last })).sort((a, b) => b.used - a.used || b.calls - a.calls) };
      }) });
  });
  // Help requests: ask the team, pick one up, close it (asker or helper), hand it back (helper) or withdraw it (asker).
  api.post("/adoption/help", async (req, res) => {
    need(res, "edit");
    const s = S(res);
    if (!s.user) throw new AppError(word("ask_signed_in"));
    const id = await askForHelp(s.org, String(req.body?.journey_id ?? ""), s.user, req.body?.note);
    capture({ distinctId: s.user, orgSlug: s.slug }, "help_requested", { journey: String(req.body?.journey_id ?? "") });
    res.status(201).json({ id });
  });
  api.post("/adoption/help/:id/:action", async (req, res) => {
    const s = S(res), id = Number(req.params.id), action = String(req.params.action);
    if (!s.user) throw new AppError(word("help_signed_in"));
    need(res, "edit");
    if (action === "pick") await pickUpHelp(s.org, id, s.user);
    else if (action === "done" || action === "release" || action === "cancel") await updateHelp(s.org, id, s.user, action);
    else throw new AppError(word("help_action"), 404);
    capture({ distinctId: s.user, orgSlug: s.slug }, `help_${action === "pick" ? "picked_up" : action}`, { request: id });
    res.status(204).end();
  });
  api.post("/journeys/:id/view", async (req, res) => {
    capture(who(res), "journey_viewed", { journey: String(req.params.id) });
    res.status(204).end();
  });
  // Stages with no tool (shipping a docs change) are marked by the person; recorded for everyone in the account.
  api.post("/journeys/:id/stages/:stage", async (req, res) => {
    need(res, "edit");
    await markStage({ orgId: S(res).org, slug: S(res).slug }, S(res).user, String(req.params.id), String(req.params.stage), req.body?.done !== false);
    res.status(204).end();
  });
}

/**
 * /api/admin/onboarding/playbooks (src/http.ts, after the host packs' console routes): the templates customers see on
 * /app Setup and /app/journeys. Admins write them (`library`), promote the ones customers see and order them, delete
 * them (`delete`); each with its adoption across accounts, and the tools a stage may name. Only when the component is on.
 */
export function journeyAdminRoutes(ob: Router, h: AdminHelpers) {
  if (!journeysOn()) return;
  const { need, actor } = h;
  ob.get("/playbooks", async (_req, res) => void res.json({ playbooks: await templatesWithAdoption(), tools: journeyToolNames() }));
  ob.post("/playbooks", need("library"), async (req, res) => void res.status(201).json({ id: await createTemplate(actor(req, res), req.body ?? {}) }));
  ob.put("/playbooks/:id", need("library"), async (req, res) => { await updateTemplate(actor(req, res), String(req.params.id), req.body ?? {}); res.status(204).end(); });
  ob.post("/playbooks/:id/promote", need("library"), async (req, res) => { await setPromoted(actor(req, res), String(req.params.id), req.body?.promoted !== false); res.status(204).end(); });
  ob.post("/playbooks/reorder", need("library"), async (req, res) => { await reorder(actor(req, res), req.body?.ids); res.status(204).end(); });
  ob.delete("/playbooks/:id", need("delete"), async (req, res) => { await deleteTemplate(String(req.params.id)); res.status(204).end(); });
}
