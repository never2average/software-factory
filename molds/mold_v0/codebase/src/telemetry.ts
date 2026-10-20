/**
 * Product analytics: server-side events to PostHog, grouped by organization (PostHog group analytics), for funnels,
 * retention and feature adoption across accounts. PostHog is the system of record for analytics; Octillion keeps only
 * the operational connector log it already needed (mcp_events) for the console and the customer usage page.
 * Events carry names, ids, outcomes and timings, never tool arguments, results, transcripts or keys.
 * Off unless POSTHOG_API_KEY is set. Batched; a failed flush is dropped, never retried into memory forever.
 *
 *   POSTHOG_API_KEY=phc_...   POSTHOG_HOST=https://us.i.posthog.com (default; EU: https://eu.i.posthog.com)
 *
 * Distinct ids: the Clerk user id when someone signed in, `org:<slug>` for legacy API keys, `admin:<name>` for
 * console actions, the email for landing-page requests.
 */
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

export const posthogEnabled = () => Boolean(process.env.POSTHOG_API_KEY);
const host = () => (process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");

interface Captured { event: string; distinct_id: string; properties: Record<string, unknown>; timestamp: string }
let queue: Captured[] = [];
let timer: NodeJS.Timeout | null = null;

export interface Actor { distinctId: string; orgSlug?: string | null }

/** Queue one event. `orgSlug` puts it in the organization group, so it rolls up per account. */
export function capture(actor: Actor, event: string, properties: Record<string, unknown> = {}): void {
  if (!posthogEnabled()) return;
  queue.push({
    event, distinct_id: actor.distinctId, timestamp: new Date().toISOString(),
    properties: { ...properties, ...(actor.orgSlug ? { $groups: { organization: actor.orgSlug } } : {}), $lib: "octillion-server" },
  });
  // Serverless (Vercel): the function can be frozen as soon as the response is sent, so send now and keep it alive.
  if (process.env.VERCEL) { keepAlive(flush()); return; }
  if (queue.length >= 100) void flush();
  else if (!timer) timer = setTimeout(() => void flush(), 5000).unref();
}

/** On Vercel, keep the function running until `p` settles (waitUntil); elsewhere a no-op. */
export function keepAlive(p: Promise<unknown>): void {
  if (!process.env.VERCEL) return;
  void import("@vercel/functions").then((m) => m.waitUntil(p.catch(() => {}))).catch(() => {});
}

/** An account-level event when only the org id is at hand (workers, research): looks up the slug. Best effort. */
export async function orgEvent(orgId: number, event: string, properties: Record<string, unknown> = {}): Promise<void> {
  if (!posthogEnabled()) return;
  const { getDb } = await import("./db.js");
  const [o] = await (await getDb()).query<{ slug: string }>("SELECT slug FROM organizations WHERE id = $1", [orgId]).catch(() => []);
  if (o) capture({ distinctId: `org:${o.slug}`, orgSlug: o.slug }, event, properties);
}

/** Set a person's properties (email, account, role), so PostHog Workflows can email them and target by account. */
export function identifyPerson(distinctId: string, properties: Record<string, unknown>): void {
  capture({ distinctId }, "$set", { $set: properties });
}

/** Set an organization's properties in PostHog (name, plan, ...), for filtering and breakdowns. */
export function identifyOrg(slug: string, properties: Record<string, unknown>): void {
  capture({ distinctId: `org:${slug}` }, "$groupidentify", { $group_type: "organization", $group_key: slug, $group_set: properties });
}

export async function flush(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    const res = await fetch(`${host()}/batch/`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: process.env.POSTHOG_API_KEY, batch }), signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`posthog: batch of ${batch.length} rejected (${res.status})`);
  } catch (err) {
    console.error(`posthog: batch of ${batch.length} dropped: ${(err as Error).message}`);
  }
}

// ---------- OpenTelemetry spans (no-ops unless src/otel.ts started the SDK) ----------

const tracer = trace.getTracer("octillion");

/** Run fn in a span named `name`; records the error and marks the span failed when fn throws. */
export function span<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (s: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (s) => {
    try {
      return await fn(s);
    } catch (err) {
      s.recordException(err as Error);
      s.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      s.end();
    }
  });
}
