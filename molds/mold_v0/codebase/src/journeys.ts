/**
 * Onboarding journeys. PostHog Workflows is the system of record for journeys: which ones exist, who is in them, what
 * each step says and when it fires (triggers on the events src/telemetry.ts sends, delays, branches, email and Slack
 * steps). Octillion adds the one channel PostHog cannot reach: the user's AI client. A workflow's webhook step drops a
 * nudge here; Octillion shows it at the end of the next tool result (at most one a day per person), in get_started,
 * and on /app, and reports nudge_shown / nudge_dismissed back to PostHog so the workflow can branch on them.
 *
 * The nudges table is only a delivery queue: one row per account/person and journey step, replaced when the step
 * fires again, expiring after a week by default.
 *
 *   OCTILLION_JOURNEY_SECRET        authenticates the webhook (Bearer header, or /api/journeys/nudges/<secret>)
 *   OCTILLION_NUDGE_INTERVAL_HOURS  minimum hours between two in-chat nudges for one person (default 20)
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Org } from "./auth.js";
import { orgForClerk } from "./auth.js";
import { getDb } from "./db.js";
import { capture } from "./telemetry.js";
import * as clerk from "./clerk.js";

export class JourneyError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const publicUrl = () => (process.env.PUBLIC_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
const intervalHours = () => Math.max(0, Number(process.env.OCTILLION_NUDGE_INTERVAL_HOURS ?? 20));
/** A nudge stops appearing in chat after this many showings; it stays on /app until it expires or is dismissed. */
const MAX_CHAT_SHOWS = 3;

export function journeySecretOk(given: string | null | undefined) {
  const want = process.env.OCTILLION_JOURNEY_SECRET;
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

/** Who a nudge is for: an account (and optionally one person in it). PostHog sends whatever distinct id it has. */
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
    if (!org && clerk.clerkEnabled()) {
      const m = (await clerk.memberships.forUser(userId)).find((x) => !clerk.isSuspended(x) && x.organization);
      const o = m ? await orgForClerk(m.organization!.id) : null;
      if (o) org = { id: o.orgId, slug: o.slug };
    }
  }
  if (!org) throw new JourneyError("No Octillion account for this nudge: send org (slug) or a distinct id Octillion knows", 404);
  return { orgId: org.id, slug: org.slug, userId };
}

async function upsert(target: { orgId: number; slug: string; userId: string }, n: NudgeInput, source: "posthog" | "admin") {
  const message = text(n.message, 280);
  if (!message) throw new JourneyError("message is required (up to 280 characters)");
  const link = text(n.link, 500);
  if (link && !/^(https:\/\/|\/app)/.test(link)) throw new JourneyError("link must be https:// or a /app path");
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
  return { id: Number(row.id), org: target.slug, user_id: target.userId || null, journey, step };
}

/** The PostHog Workflows webhook. */
export async function receiveNudge(body: NudgeInput) {
  return upsert(await resolveTarget(body ?? {}), body ?? {}, "posthog");
}

/** A nudge sent by hand from /admin (a one-off announcement, or testing a step before building it in PostHog). */
export async function sendFromAdmin(actor: string, body: NudgeInput & { org_slug?: string }) {
  const r = await upsert(await resolveTarget({ ...body, org: body.org_slug ?? body.org }), body, "admin");
  console.error(`admin ${actor} nudge.send org=${r.org} ${JSON.stringify({ journey: r.journey, step: r.step })}`);
  return r;
}

interface NudgeRow { id: number; org_id: number; user_id: string; journey: string; step: string; message: string; prompt: string | null; link: string | null;
  created_at: Date; expires_at: Date; shown_count: number; dismissed_at: Date | null }

const ACTIVE = `org_id = $1 AND user_id IN ('', $2) AND dismissed_at IS NULL AND expires_at > now()`;

/**
 * The nudge to show in chat after a tool call, or null: not muted, not shown to this person within the interval
 * (get_started ignores the interval: the person asked what to do next), newest first, person-level before account-level.
 */
export async function nudgeForChat(org: Org, opts: { force?: boolean } = {}): Promise<NudgeRow | null> {
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
export function chatLine(n: NudgeRow) {
  return `\n\n---\nOctillion tip for the user (mention it briefly after answering): ${n.message}` +
    (n.prompt ? ` To try it, they can say: "${n.prompt}".` : "") +
    ` Tips can be turned off at ${publicUrl()}/app.`;
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
  if (!n) throw new JourneyError("No such tip", 404);
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
  // Person-level tips name the person: their email from the account's Clerk members (cached for a minute).
  const { team } = await import("./admin.js");
  const emails = new Map<string, string>();
  for (const slug of new Set((recent as { org_slug: string; user_id: string }[]).filter((r) => r.user_id).map((r) => r.org_slug))) {
    const t = await team(slug).catch(() => null);
    for (const m of t?.members ?? []) if (m.email) emails.set(m.user_id, m.email);
  }
  for (const r of recent as { user_id: string; email?: string | null }[]) r.email = r.user_id ? emails.get(r.user_id) ?? null : null;
  return {
    configured: Boolean(process.env.OCTILLION_JOURNEY_SECRET), posthog: Boolean(process.env.POSTHOG_API_KEY),
    webhook_url: `${publicUrl()}/api/journeys/nudges`, interval_hours: intervalHours(), max_chat_shows: MAX_CHAT_SHOWS,
    steps, recent, muted: Number(muted[0]?.n ?? 0),
    recipes: RECIPES.map((r) => ({ ...r, steps: r.steps.map((x) => ({ ...x, body: webhookBody(r.id, x) })) })),
  };
}

export async function adminDelete(actor: string, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new JourneyError("Invalid id");
  const r = await (await getDb()).query("DELETE FROM nudges WHERE id = $1 RETURNING id", [id]);
  if (!r.length) throw new JourneyError("No such nudge", 404);
  console.error(`admin ${actor} nudge.delete ${id}`);
}

// ---------- recommended journeys: recipes to build in PostHog Workflows ----------

/**
 * Six journeys that cover onboarding and "keep trying new things", built from events Octillion already sends. Each
 * step's chat/app channel is a webhook step posting {distinct_id, journey, step, message, prompt?, link?} to Octillion;
 * email and Slack steps are PostHog's own. Shown on /admin (Journeys) with ready-to-paste webhook bodies.
 */
export const RECIPES = [
  { id: "connect", name: "Get connected", goal: "mcp_connected within a day of joining",
    trigger: "app_signed_in (first time)",
    steps: [
      { step: "guide", when: "1 day after the trigger, unless mcp_connected", channels: ["email", "app"], link: "/app#setup",
        message: "You're in, but Octillion isn't connected to your AI client yet. It takes a minute: copy the connector URL and follow the guide for your client." },
    ] },
  { id: "first-report", name: "First report", goal: "get_visibility_report within a week",
    trigger: "mcp_connected (first time)",
    steps: [
      { step: "onboard", when: "1 day, unless tool_called: onboard_product", channels: ["chat", "email"],
        message: "Start by onboarding your product: Octillion researches it and writes realistic coding tasks that never name it.",
        prompt: "Onboard my product: <name>, <website>, <docs link>. It is a <one-line description>." },
      { step: "run", when: "on onboarding_completed, unless tool_called: run_simulation within 1 hour", channels: ["chat"],
        message: "Your product profile and tasks are ready. Check the competitor list, then run coding agents on the tasks.", prompt: "Run a simulation." },
      { step: "report", when: "on simulation_completed", channels: ["chat", "email"],
        message: "Your simulation finished: see how often coding agents picked your product, and who won instead.", prompt: "Show my visibility report." },
    ] },
  { id: "evidence", name: "Read the evidence", goal: "get_agent_session or search_transcripts after a report",
    trigger: "tool_called: get_visibility_report",
    steps: [
      { step: "why", when: "2 days, unless tool_called: get_agent_session or search_transcripts", channels: ["chat"],
        message: "Each result has transcripts behind it. Ask why agents chose a competitor on your weakest task, in the agents' own words.",
        prompt: "Why did agents pick the competitor on my weakest task? Show me the transcript." },
    ] },
  { id: "rerun", name: "Fix and re-run", goal: "run_simulation again after acting on a report",
    trigger: "tool_called: get_visibility_report",
    steps: [
      { step: "rerun", when: "7 days, unless tool_called: run_simulation", channels: ["chat", "email"],
        message: "Changed your docs, examples or SDK since the last report? Re-run the same tasks to see whether agents' preference moved.",
        prompt: "Re-run my last simulation." },
    ] },
  { id: "team", name: "Bring the team", goal: "a second member in the account",
    trigger: "onboarding_completed (account admins only: person property role = admin)",
    steps: [
      { step: "invite", when: "3 days, unless the account has admin_invite_send", channels: ["app", "email"], link: "/app#team",
        message: "Octillion works best when the people who own docs and DevRel can see the evidence too. Invite a colleague in a few seconds." },
    ] },
  { id: "win-back", name: "Win back", goal: "any tool_called after 14 quiet days",
    trigger: "cohort: tool_called in the last 60 days but not in the last 14",
    steps: [
      { step: "nudge", when: "on entering the cohort", channels: ["chat", "email"],
        message: "Coding agents and their models change every few weeks. A fresh run shows whether you are still being picked.", prompt: "Run a simulation." },
    ] },
] as const;

/** The JSON body for a recipe step's webhook, with PostHog's template variable for the person. */
export function webhookBody(journey: string, s: { step: string; message: string; prompt?: string; link?: string }) {
  return JSON.stringify({ distinct_id: "{event.distinct_id}", journey, step: s.step, message: s.message,
    ...(s.prompt ? { prompt: s.prompt } : {}), ...(s.link ? { link: s.link } : {}) }, null, 2);
}
