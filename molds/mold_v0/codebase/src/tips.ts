/**
 * In-chat tips (mold_v0-143; molds/mold_v0/MOLD.md "Journeys and tips"): a component of the shell any app turns on from
 * pack.json `tips` (src/host.ts TipsConfig; one pack's per build). Off (zero packs, or no pack declares it) nothing of
 * it is served: no route, no webhook, nothing added to a tool's answer.
 *
 * A workflow tool (PostHog Workflows: triggers on the events src/telemetry.ts sends, delays, branches, email and Slack
 * steps) is the system of record for which sequences exist and when each step fires. The shell adds the one channel it
 * cannot reach, the person's AI client: a workflow's webhook step (or an admin, by hand) queues a tip here; it is shown
 * at the end of the next tool answer (at most one a day per person, at most MAX_CHAT_SHOWS times; the tools pack.json
 * tips.always_after names always show it), on /app Setup until it expires or is dismissed, and its showing, dismissal
 * and the person's mute are sent back as events so the workflow can branch on them.
 *
 * The nudges table is only a delivery queue (sql/migrations/0026_journeys_and_tips.sql): one row per account/person and
 * sequence step, replaced when the step fires again, expiring after a week by default; nudge_prefs keeps each person's
 * mute and when a tip was last shown to them in chat.
 *
 *   APP_JOURNEY_SECRET          authenticates the webhook (Bearer header, or /api/journeys/nudges/<secret>)
 *   APP_NUDGE_INTERVAL_HOURS    minimum hours between two in-chat tips for one person (pack.json tips.interval_hours, else 20)
 *
 * Every text is a word (pack.json tips.words over src/journeys-words.ts TIP_WORDS).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request, type Response, type Router } from "express";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Org } from "./auth.js";
import { bearer, orgForClerk } from "./auth.js";
import { getDb } from "./db.js";
import { ENV } from "./env-names.js";
import { tipsConfig, type AdminHelpers, type PortalHelpers, type TipsConfig } from "./host.js";
import { journeyNouns } from "./journeys.js";
import { DEFAULT_INTERVAL_HOURS, MAX_CHAT_SHOWS, TIP_WORDS, type TipWord } from "./journeys-words.js";
import { people } from "./people.js";
import { isSuspended } from "./clerk.js";
import { capture } from "./telemetry.js";

export class TipError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export const tipsOn = (): boolean => tipsConfig() !== null;
const config = (): TipsConfig => tipsConfig() ?? {};
/** One word, the pack's or the shell's, its placeholders filled once. */
export function tipWord(k: TipWord, vars: Record<string, string> = {}): string {
  const all: Record<string, string> = { ...journeyNouns(), ...vars };
  return (config().words?.[k] ?? TIP_WORDS[k]).replace(/\{([A-Za-z_]+)\}/g, (m, n: string) => (Object.hasOwn(all, n) ? all[n]! : m));
}

const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
const intervalHours = () => Math.max(0, Number(ENV.APP_NUDGE_INTERVAL_HOURS ?? config().interval_hours ?? DEFAULT_INTERVAL_HOURS));

export function journeySecretOk(given: string | null | undefined) {
  const want = ENV.APP_JOURNEY_SECRET;
  if (!want || !given) return false;
  const h = (x: string) => createHash("sha256").update(x).digest();
  return timingSafeEqual(h(given), h(want));
}

export interface NudgeInput {
  distinct_id?: string; org?: string; user_id?: string; email?: string;
  journey?: string; step?: string; message?: string; prompt?: string; link?: string; ttl_days?: number;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const slugish = (v: unknown, fallback: string) => (text(v, 60).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || fallback);

/** Who a tip is for: an account (and optionally one person in it). The workflow tool sends whatever distinct id it has. */
async function resolveTarget(n: NudgeInput): Promise<{ orgId: number; slug: string; userId: string }> {
  const db = await getDb();
  const bySlug = async (slug: string) => (await db.query<{ id: number; slug: string }>("SELECT id, slug FROM organizations WHERE slug = $1", [slug]))[0];
  let userId = text(n.user_id, 80);
  const did = text(n.distinct_id, 200);
  if (!userId && did.startsWith("user_")) userId = did;
  let org = n.org ? await bySlug(text(n.org, 80)) : did.startsWith("org:") ? await bySlug(did.slice(4)) : undefined;
  if (!org && !userId && did.includes("@")) {
    // A landing-page lead or an invitee known only by email: the account their request was approved into.
    const [r] = await db.query<{ id: number; slug: string }>(
      "SELECT o.id, o.slug FROM access_requests q JOIN organizations o ON o.id = q.org_id WHERE lower(q.email) = lower($1) ORDER BY q.decided_at DESC NULLS LAST LIMIT 1", [did]);
    org = r;
  }
  if (!org && userId) {
    const [seen] = await db.query<{ id: number; slug: string }>(
      "SELECT o.id, o.slug FROM mcp_events e JOIN organizations o ON o.id = e.org_id WHERE e.user_id = $1 ORDER BY e.at DESC LIMIT 1", [userId]);
    org = seen;
    if (!org && people().enabled()) {
      const m = (await people().memberships.forUser(userId)).find((x) => !isSuspended(x) && x.organization);
      const o = m ? await orgForClerk(m.organization!.id) : null;
      if (o) org = { id: o.orgId, slug: o.slug };
    }
  }
  if (!org) throw new TipError(tipWord("no_account"), 404);
  return { orgId: org.id, slug: org.slug, userId };
}

async function upsert(target: { orgId: number; slug: string; userId: string }, n: NudgeInput, source: "posthog" | "admin") {
  const message = text(n.message, 280);
  if (!message) throw new TipError(tipWord("message_required"));
  const link = text(n.link, 500);
  if (link && !/^(https:\/\/|\/app)/.test(link)) throw new TipError(tipWord("bad_link"));
  const ttl = Math.min(30, Math.max(1, Number(n.ttl_days) || 7));
  const journey = slugish(n.journey, source === "admin" ? "manual" : "journey"), step = slugish(n.step, "step");
  const [row] = await (await getDb()).query<{ id: number }>(
    `INSERT INTO nudges (org_id, user_id, journey, step, message, prompt, link, source, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9))
     ON CONFLICT (org_id, user_id, journey, step) DO UPDATE SET message = EXCLUDED.message, prompt = EXCLUDED.prompt, link = EXCLUDED.link,
       source = EXCLUDED.source, created_at = now(), expires_at = EXCLUDED.expires_at, shown_count = 0, first_shown_at = NULL,
       last_shown_at = NULL, dismissed_at = NULL
     RETURNING id`,
    [target.orgId, target.userId, journey, step, message, text(n.prompt, 300) || null, link || null, source, ttl]);
  capture({ distinctId: target.userId || `org:${target.slug}`, orgSlug: target.slug }, "nudge_queued", { journey, step, source, scope: target.userId ? "person" : "account" });
  return { id: Number(row!.id), org: target.slug, user_id: target.userId || null, journey, step };
}

/** The workflow tool's webhook. */
export async function receiveNudge(body: NudgeInput) {
  return upsert(await resolveTarget(body ?? {}), body ?? {}, "posthog");
}

/** A tip sent by hand from /admin (a one-off announcement, or testing a step before building it in the workflow tool). */
export async function sendFromAdmin(actor: string, body: NudgeInput & { org_slug?: string }) {
  const r = await upsert(await resolveTarget({ ...body, org: body.org_slug ?? body.org }), body, "admin");
  console.error(`admin ${actor} nudge.send org=${r.org} ${JSON.stringify({ journey: r.journey, step: r.step })}`);
  return r;
}

export interface NudgeRow { id: number; org_id: number; user_id: string; journey: string; step: string; message: string; prompt: string | null; link: string | null;
  created_at: Date; expires_at: Date; shown_count: number; dismissed_at: Date | null }

const ACTIVE = `org_id = $1 AND user_id IN ('', $2) AND dismissed_at IS NULL AND expires_at > now()`;

/**
 * The tip to show in chat after a tool call, or null: not muted, not shown to this person within the interval (`force`:
 * the tools pack.json tips.always_after names ignore it: the person asked what to do next), newest first, person-level
 * before account-level. Off: always null.
 */
export async function nudgeForChat(org: Org, opts: { force?: boolean } = {}): Promise<NudgeRow | null> {
  if (!tipsOn()) return null;
  const db = await getDb();
  const who = org.userId ?? "";
  const [pref] = await db.query<{ muted: boolean; last_shown_at: Date | null }>(
    "SELECT muted, last_shown_at FROM nudge_prefs WHERE org_id = $1 AND user_id = $2", [org.orgId, who]);
  if (pref?.muted) return null;
  if (!opts.force && pref?.last_shown_at && Date.now() - new Date(pref.last_shown_at).getTime() < intervalHours() * 3_600_000) return null;
  const [n] = await db.query<NudgeRow>(
    `SELECT * FROM nudges WHERE ${ACTIVE} AND shown_count < $3 ORDER BY (user_id <> '') DESC, created_at DESC LIMIT 1`, [org.orgId, who, MAX_CHAT_SHOWS]);
  if (!n) return null;
  await db.query("UPDATE nudges SET shown_count = shown_count + 1, first_shown_at = coalesce(first_shown_at, now()), last_shown_at = now() WHERE id = $1", [n.id]);
  await db.query(`INSERT INTO nudge_prefs (org_id, user_id, last_shown_at) VALUES ($1, $2, now())
                  ON CONFLICT (org_id, user_id) DO UPDATE SET last_shown_at = now()`, [org.orgId, who]);
  capture({ distinctId: org.userId ?? `org:${org.slug}`, orgSlug: org.slug }, "nudge_shown", { journey: n.journey, step: n.step, channel: "chat" });
  return n;
}

/** The line appended to a tool result. Plain text: the model decides how to pass it on. */
export function chatLine(n: Pick<NudgeRow, "message" | "prompt">) {
  return `\n\n---\n${tipWord("chat_line", { message: n.message })}` + (n.prompt ? tipWord("chat_try", { prompt: n.prompt }) : "") + tipWord("chat_off", { url: `${publicUrl()}/app` });
}

/** Whether a tool's answer always carries the waiting tip (pack.json tips.always_after). */
export const alwaysTipAfter = (tool: string): boolean => (config().always_after ?? []).includes(tool);

/**
 * One tool answer with the waiting tip (if any) at the end of its text and in its structured content: what every tool
 * of the build does with a tip, the shell's own (the memory tools) here and a host pack's through src/pack-host.ts.
 * Off, or no tip waiting: the answer as it was.
 */
export async function withTip(org: Org, tool: string, result: CallToolResult): Promise<CallToolResult> {
  if (!tipsOn() || result.isError) return result;
  const nudge = await nudgeForChat(org, { force: alwaysTipAfter(tool) }).catch((e) => { console.error("nudge:", (e as Error).message); return null; });
  if (!nudge) return result;
  const first = result.content[0] as { type: "text"; text: string };
  return { ...result, content: [{ ...first, text: `${first.text}${chatLine(nudge)}` }, ...result.content.slice(1)],
    structuredContent: { ...result.structuredContent, nudge: { message: nudge.message, prompt: nudge.prompt } } };
}

// ---------- /app ----------

export async function nudgesForApp(orgId: number, userId: string | null) {
  const db = await getDb();
  const rows = await db.query<NudgeRow>(`SELECT * FROM nudges WHERE ${ACTIVE} ORDER BY (user_id <> '') DESC, created_at DESC LIMIT 10`, [orgId, userId ?? ""]);
  const [pref] = await db.query<{ muted: boolean }>("SELECT muted FROM nudge_prefs WHERE org_id = $1 AND user_id = $2", [orgId, userId ?? ""]);
  return { muted: Boolean(pref?.muted), nudges: rows.map((n) => ({ id: Number(n.id), journey: n.journey, step: n.step, message: n.message, prompt: n.prompt, link: n.link, created_at: n.created_at })) };
}

export async function dismiss(orgId: number, slug: string, userId: string | null, id: number) {
  const [n] = await (await getDb()).query<{ journey: string; step: string }>(
    `UPDATE nudges SET dismissed_at = now() WHERE id = $3 AND ${ACTIVE} RETURNING journey, step`, [orgId, userId ?? "", id]);
  if (!n) throw new TipError(tipWord("no_tip"), 404);
  capture({ distinctId: userId ?? `org:${slug}`, orgSlug: slug }, "nudge_dismissed", { journey: n.journey, step: n.step });
}

export async function setMuted(orgId: number, slug: string, userId: string | null, muted: boolean) {
  await (await getDb()).query(`INSERT INTO nudge_prefs (org_id, user_id, muted) VALUES ($1, $2, $3)
                               ON CONFLICT (org_id, user_id) DO UPDATE SET muted = $3`, [orgId, userId ?? "", muted]);
  capture({ distinctId: userId ?? `org:${slug}`, orgSlug: slug }, muted ? "nudges_muted" : "nudges_unmuted");
}

// ---------- /admin ----------

export async function adminView() {
  const db = await getDb();
  const [steps, recent, muted] = await Promise.all([
    db.query(`SELECT journey, step, count(*) AS queued, count(*) FILTER (WHERE shown_count > 0) AS shown,
                     count(*) FILTER (WHERE dismissed_at IS NOT NULL) AS dismissed,
                     count(*) FILTER (WHERE dismissed_at IS NULL AND expires_at > now()) AS active, max(created_at) AS last
                FROM nudges GROUP BY journey, step ORDER BY journey, max(created_at) DESC`),
    db.query(`SELECT n.id, o.slug AS org_slug, o.name AS org_name, n.user_id, n.journey, n.step, n.message, n.prompt, n.source,
                     n.created_at, n.expires_at, n.shown_count, n.last_shown_at, n.dismissed_at
                FROM nudges n JOIN organizations o ON o.id = n.org_id ORDER BY n.created_at DESC LIMIT 50`),
    db.query<{ n: number }>("SELECT count(*) AS n FROM nudge_prefs WHERE muted"),
  ]);
  // Person-level tips name the person: their email from the account's members (cached for a minute).
  const { team } = await import("./admin.js");
  const emails = new Map<string, string>();
  for (const slug of new Set((recent as { org_slug: string; user_id: string }[]).filter((r) => r.user_id).map((r) => r.org_slug))) {
    const t = await team(slug).catch(() => null);
    for (const m of t?.members ?? []) if (m.email) emails.set(m.user_id, m.email);
  }
  for (const r of recent as { user_id: string; email?: string | null }[]) r.email = r.user_id ? emails.get(r.user_id) ?? null : null;
  return {
    configured: Boolean(ENV.APP_JOURNEY_SECRET), posthog: Boolean(process.env.POSTHOG_API_KEY),
    webhook_url: `${publicUrl()}/api/journeys/nudges`, interval_hours: intervalHours(), max_chat_shows: MAX_CHAT_SHOWS,
    steps, recent, muted: Number(muted[0]?.n ?? 0),
    recipes: (config().recipes ?? []).map((r) => ({ ...r, steps: r.steps.map((x) => ({ ...x, body: webhookBody(r.id, x) })) })),
  };
}

export async function adminDelete(actor: string, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new TipError(tipWord("bad_id"));
  const r = await (await getDb()).query("DELETE FROM nudges WHERE id = $1 RETURNING id", [id]);
  if (!r.length) throw new TipError(tipWord("no_nudge"), 404);
  console.error(`admin ${actor} nudge.delete ${id}`);
}

/** The JSON body for a recipe step's webhook, with the workflow tool's template variable for the person. */
export function webhookBody(journey: string, s: { step: string; message: string; prompt?: string; link?: string }) {
  return JSON.stringify({ distinct_id: "{event.distinct_id}", journey, step: s.step, message: s.message,
    ...(s.prompt ? { prompt: s.prompt } : {}), ...(s.link ? { link: s.link } : {}) }, null, 2);
}

// ---------- routes ----------

/**
 * The webhook (src/http.ts, after the host packs' public routes): the workflow tool queues a tip. The secret goes in an
 * Authorization header, or in the path for webhook steps that cannot set headers. Only when the component is on.
 */
export function tipPublicRoutes(app: Express) {
  if (!tipsOn()) return;
  const nudgeHook = async (req: Request, res: Response, secret: string | null) => {
    if (!journeySecretOk(secret)) return void res.status(401).json({ error: tipWord("bad_secret") });
    try { res.status(201).json(await receiveNudge(req.body ?? {})); }
    catch (e) { if (!(e instanceof TipError)) throw e; res.status(e.status).json({ error: e.message }); }
  };
  app.post("/api/journeys/nudges", express.json({ limit: "32kb" }), (req, res) => nudgeHook(req, res, bearer(req.headers.authorization)));
  app.post("/api/journeys/nudges/:secret", express.json({ limit: "32kb" }), (req, res) => nudgeHook(req, res, String(req.params.secret)));
}

/** /api/app/nudges (src/app.ts): everything waiting for this person, dismiss one, or turn tips off. Only when on. */
export function tipRoutes(api: Router, h: PortalHelpers) {
  if (!tipsOn()) return;
  const { S } = h;
  api.get("/nudges", async (_req, res) => void res.json(await nudgesForApp(S(res).org, S(res).user)));
  api.post("/nudges/:id/dismiss", async (req, res) => { await dismiss(S(res).org, S(res).slug, S(res).user, Number(req.params.id)); res.status(204).end(); });
  api.post("/nudges/mute", async (req, res) => { await setMuted(S(res).org, S(res).slug, S(res).user, req.body?.muted !== false); res.status(204).end(); });
}

/**
 * /api/admin/onboarding/journeys (src/http.ts): what the workflow tool queued for the in-chat channel and tips sent by
 * hand, with the recipes; queue one (`journeys`) or remove one (`journeys`). Only when the component is on.
 */
export function tipAdminRoutes(ob: Router, h: AdminHelpers) {
  if (!tipsOn()) return;
  const { need, actor } = h;
  ob.get("/journeys", async (_req, res) => void res.json(await adminView()));
  ob.post("/journeys/nudges", need("journeys"), async (req, res) => void res.status(201).json(await sendFromAdmin(actor(req, res), req.body ?? {})));
  ob.delete("/journeys/nudges/:id", need("journeys"), async (req, res) => { await adminDelete(actor(req, res), Number(req.params.id)); res.status(204).end(); });
}
