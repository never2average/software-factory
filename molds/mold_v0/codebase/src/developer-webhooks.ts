/**
 * Webhooks out (mold_v0-193), as the Standard Webhooks specification has them (https://www.standardwebhooks.com/):
 *
 *   endpoints   a workspace's destinations (webhook_endpoints): an https address, the events it takes (none listed:
 *               every declared event), a signing secret `whsec_<base64>` sealed with the workspace's data key, shown
 *               when made; read again only through revealWebhookSecret (recorded on the endpoint and to the platform
 *               audit hook), rotated with the old secret still signing beside the new one for 24 hours
 *   events      the build's declared events (pack.json developer_surface.events): record.created / updated /
 *               state_changed / deleted (src/record-areas.ts onRecordChange), run.finished (the runs that ended, read
 *               by the tick, src/runs.ts untouched), clock.overdue (emitEvent, for mold_v0-191's clocks); webhook.test
 *               on request. A sealed area's events carry its key, never its title or fields
 *   deliveries  one per event per endpoint (webhook_deliveries; the same event twice is queued once): POSTed with
 *               webhook-id, webhook-timestamp and webhook-signature (v1, HMAC-SHA256 of "id.timestamp.body"),
 *               within 15 seconds, no redirect followed; anything but a 2xx is retried after RETRY_SCHEDULE; each
 *               attempt is logged on the delivery; an endpoint whose last DISABLE_AFTER attempts all failed is
 *               disabled (enable it again to resume; its pending deliveries wait meanwhile)
 *   addresses   https only, and never a private, loopback or link-local address (resolved before each attempt); a
 *               preview server (APP_PREVIEW=1, `npm run dev`) also takes http://localhost and http://127.0.0.1
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { auditPlatform } from "./developer-audit.js";
import { EVENT_CATALOG, TEST_EVENT, type EventName } from "./developer-config.js";
import { actorLabel, ApiProblem, currentApiActor, developerSurface } from "./developer-surface.js";
import { getDb } from "./db.js";
import { ENV } from "./env-names.js";
import { open, seal } from "./orgcrypto.js";
import { onRecordChange, recordAreas, type RecordChange } from "./record-areas.js";
import { asPlatform } from "./tenant-scope.js";

/** Seconds to wait before each retry (attempt 2, 3, ...): 8 attempts over about 27 hours. */
const DEFAULT_SCHEDULE = [5, 300, 1800, 7200, 18000, 36000, 36000];
let RETRY_SCHEDULE = DEFAULT_SCHEDULE;
/** An endpoint is disabled after so many failed attempts in a row (no success between). */
let DISABLE_AFTER = 30;
export const ATTEMPT_TIMEOUT_MS = 15_000;
/** Tests only: a shorter schedule and threshold. */
export function setWebhookPolicyForTest(p: { schedule?: number[]; disableAfter?: number } | null) {
  RETRY_SCHEDULE = p?.schedule ?? DEFAULT_SCHEDULE;
  DISABLE_AFTER = p?.disableAfter ?? 30;
}

// ---------- Standard Webhooks signing ----------

export const SECRET_PREFIX = "whsec_";
export const newSecret = () => `${SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
const secretBytes = (secret: string) => Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, "base64");
/** The v1 signature of a message: base64 HMAC-SHA256 of "<id>.<timestamp>.<body>" under the secret's bytes. */
export const signature = (secret: string, id: string, timestamp: number, body: string) =>
  `v1,${createHmac("sha256", secretBytes(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
/** The webhook-* headers of a message, signed by each secret (a rotation signs with both). */
export function signedHeaders(secrets: string[], id: string, timestamp: number, body: string): Record<string, string> {
  return { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": secrets.map((s) => signature(s, id, timestamp, body)).join(" ") };
}
/** Verify a signed message (webhooks in): a v1 signature under `secret`, a timestamp within `toleranceSeconds`. */
export function verifySigned(secret: string, headers: Record<string, string | string[] | undefined>, body: string, toleranceSeconds = 300): { id: string } {
  const h = (n: string) => { const v = headers[n]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const id = h("webhook-id"), ts = Number(h("webhook-timestamp")), sigs = h("webhook-signature");
  if (!id || !sigs || !Number.isInteger(ts)) throw new ApiProblem(400, "invalid_signature", "webhook-id, webhook-timestamp and webhook-signature are required");
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) throw new ApiProblem(400, "invalid_signature", "webhook-timestamp is too old or too new");
  const want = Buffer.from(signature(secret, id, ts, body).slice(3));
  const ok = sigs.split(" ").some((s) => {
    const [v, sig] = s.split(",");
    if (v !== "v1" || !sig) return false;
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  });
  if (!ok) throw new ApiProblem(400, "invalid_signature", "no signature matches");
  return { id };
}

// ---------- addresses ----------

const preview = () => ENV.APP_PREVIEW === "1";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("::ffff:") && privateAddress(x.slice(7));
}
/** An endpoint's address, checked: https (a preview server also http on localhost), no credentials, at most 2000 characters. */
export function checkUrl(v: unknown): string {
  let u: URL;
  try { u = new URL(String(v ?? "")); } catch { throw new ApiProblem(400, "invalid_url", "url: an https address like https://hooks.example.com/app"); }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.username || u.password || String(v).length > 2000) throw new ApiProblem(400, "invalid_url", "url: no user name or password in it, at most 2000 characters");
  if (u.protocol === "https:" && !local) return u.toString();
  if (preview() && local && (u.protocol === "http:" || u.protocol === "https:")) return u.toString();
  throw new ApiProblem(400, "invalid_url", "url: an https address on the internet (a local address only on a preview server)");
}
/** Refused before an attempt: an address that resolves to a private network (unless it is a preview's local one). */
async function addressProblem(url: string): Promise<string | null> {
  const u = new URL(url);
  if (preview() && LOCAL_HOSTS.has(u.hostname)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length) return "its host does not resolve";
  return ips.some(privateAddress) ? "it resolves to a private address" : null;
}

// ---------- endpoints ----------

export interface EndpointView {
  id: string; url: string; description: string | null; events: string[]; status: "enabled" | "disabled"; disabled_reason: string | null;
  failure_streak: number; secret_rotated_at: string | null; secret_revealed_at: string | null; secret_reveals: number; created_at: string; updated_at: string;
}
type EndpointRaw = Omit<EndpointView, "created_at" | "updated_at" | "secret_rotated_at" | "secret_revealed_at"> & {
  org_id: number; secret_sealed: string; previous_secret_sealed: string | null; previous_secret_until: Date | null;
  created_at: Date; updated_at: Date; secret_rotated_at: Date | null; secret_revealed_at: Date | null };
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const view = (r: EndpointRaw): EndpointView => ({
  id: r.id, url: r.url, description: r.description, events: r.events, status: r.status, disabled_reason: r.disabled_reason, failure_streak: r.failure_streak,
  secret_rotated_at: iso(r.secret_rotated_at), secret_revealed_at: iso(r.secret_revealed_at), secret_reveals: r.secret_reveals,
  created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)!,
});
const ECOLS = `id, org_id, url, description, events, status, disabled_reason, failure_streak, secret_sealed, previous_secret_sealed, previous_secret_until,
  secret_rotated_at, secret_revealed_at, secret_reveals, created_at, updated_at`;

/** The events an app declares (what an endpoint may take). */
export const declaredEvents = (): string[] => (developerSurface()?.events ?? []).map((e) => e.name);
function checkEvents(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ApiProblem(400, "invalid_request", "events: a list of event names (none: every event)");
  const declared = declaredEvents();
  for (const e of v as string[]) if (!declared.includes(e)) throw new ApiProblem(400, "invalid_event", `${e.slice(0, 80)} is not an event of this app (${declared.join(", ")})`);
  return [...new Set(v as string[])];
}
const desc = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) || null : null);

async function endpointRow(orgId: number, id: string): Promise<EndpointRaw> {
  const [r] = await asPlatform(async () => (await getDb()).query<EndpointRaw>(`SELECT ${ECOLS} FROM webhook_endpoints WHERE org_id = $1 AND id = $2`, [orgId, String(id)]));
  if (!r) throw new ApiProblem(404, "not_found", "No such webhook endpoint");
  return r;
}

export async function createEndpoint(orgId: number, input: { url?: unknown; events?: unknown; description?: unknown }, by: string | null) {
  const url = checkUrl(input.url), events = checkEvents(input.events), description = desc(input.description);
  const secret = newSecret(), id = `we_${randomBytes(12).toString("base64url")}`;
  const sealed = await asPlatform(() => seal(orgId, secret));
  const [r] = await asPlatform(async () => {
    const db = await getDb();
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_endpoints WHERE org_id = $1", [orgId]);
    if (n >= 20) throw new ApiProblem(409, "too_many_endpoints", "at most 20 webhook endpoints a workspace");
    return db.query<EndpointRaw>(`INSERT INTO webhook_endpoints (id, org_id, url, description, events, secret_sealed, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${ECOLS}`,
      [id, orgId, url, description, events, sealed, by]);
  });
  return { ...view(r!), secret };
}
export async function listEndpoints(orgId: number): Promise<EndpointView[]> {
  return (await asPlatform(async () => (await getDb()).query<EndpointRaw>(`SELECT ${ECOLS} FROM webhook_endpoints WHERE org_id = $1 ORDER BY created_at, id`, [orgId]))).map(view);
}
export const getEndpoint = async (orgId: number, id: string) => view(await endpointRow(orgId, id));
/** Change an endpoint's address, events, description, or status (enabling one clears its failure streak). */
export async function updateEndpoint(orgId: number, id: string, input: { url?: unknown; events?: unknown; description?: unknown; status?: unknown }) {
  const cur = await endpointRow(orgId, id);
  if (input.status !== undefined && input.status !== "enabled" && input.status !== "disabled") throw new ApiProblem(400, "invalid_request", "status: enabled or disabled");
  const url = input.url !== undefined ? checkUrl(input.url) : cur.url;
  const events = input.events !== undefined ? checkEvents(input.events) : cur.events;
  const description = input.description !== undefined ? desc(input.description) : cur.description;
  const status = (input.status as string | undefined) ?? cur.status;
  const [r] = await asPlatform(async () => (await getDb()).query<EndpointRaw>(
    `UPDATE webhook_endpoints SET url = $3, events = $4, description = $5, status = $6,
            disabled_reason = CASE WHEN $6 = 'disabled' THEN coalesce(CASE WHEN status = 'disabled' THEN disabled_reason END, 'disabled by the workspace') END,
            failure_streak = CASE WHEN $6 = 'enabled' AND status = 'disabled' THEN 0 ELSE failure_streak END,
            first_failure_at = CASE WHEN $6 = 'enabled' AND status = 'disabled' THEN NULL ELSE first_failure_at END, updated_at = now()
      WHERE org_id = $1 AND id = $2 RETURNING ${ECOLS}`, [orgId, String(id), url, events, description, status]));
  if (status === "enabled" && cur.status === "disabled") kick();
  return view(r!);
}
export async function deleteEndpoint(orgId: number, id: string): Promise<boolean> {
  return (await asPlatform(async () => (await getDb()).query("DELETE FROM webhook_endpoints WHERE org_id = $1 AND id = $2 RETURNING id", [orgId, String(id)]))).length > 0;
}
/** A new signing secret, answered once; the old one keeps signing beside it for `grace_hours` (0 to 168, default 24). */
export async function rotateEndpointSecret(orgId: number, id: string, input: { grace_hours?: unknown }, by: string | null) {
  const grace = input.grace_hours === undefined || input.grace_hours === null ? 24 : Number(input.grace_hours);
  if (!Number.isInteger(grace) || grace < 0 || grace > 168) throw new ApiProblem(400, "invalid_request", "grace_hours: 0 to 168");
  await endpointRow(orgId, id);
  const secret = newSecret();
  const sealed = await asPlatform(() => seal(orgId, secret));
  const [r] = await asPlatform(async () => (await getDb()).query<EndpointRaw>(
    `UPDATE webhook_endpoints SET previous_secret_sealed = CASE WHEN $4::int > 0 THEN secret_sealed END,
            previous_secret_until = CASE WHEN $4::int > 0 THEN now() + make_interval(hours => $4::int) END,
            secret_sealed = $3, secret_rotated_at = now(), updated_at = now()
      WHERE org_id = $1 AND id = $2 RETURNING ${ECOLS}`, [orgId, String(id), sealed, grace]));
  auditPlatform({ orgId, action: "webhook.secret_rotate", actor: by, target: id });
  return { ...view(r!), secret };
}
/** The endpoint's signing secret, read again: recorded on the endpoint (when, by whom, how many times) and to the audit hook. */
export async function revealWebhookSecret(orgId: number, id: string, by: string | null): Promise<{ secret: string }> {
  const r = await endpointRow(orgId, id);
  const secret = await asPlatform(() => open(orgId, r.secret_sealed));
  await asPlatform(async () => (await getDb()).query(
    "UPDATE webhook_endpoints SET secret_revealed_at = now(), secret_revealed_by = $3, secret_reveals = secret_reveals + 1 WHERE org_id = $1 AND id = $2", [orgId, String(id), by]));
  auditPlatform({ orgId, action: "webhook.secret_reveal", actor: by, target: id });
  return { secret };
}

// ---------- events and deliveries ----------

/** The envelope Standard Webhooks recommends: {type, timestamp, data}. */
const envelope = (type: string, data: Record<string, unknown>) => ({ type, timestamp: new Date().toISOString(), data });

/**
 * Queue an event of workspace `orgId` for every enabled endpoint that takes it (one delivery per endpoint; `dedupe`
 * names the event so it is queued once whatever calls this again). An event the app does not declare is not sent.
 * The hook point for other emitters (mold_v0-191's clock.overdue).
 */
export async function emitEvent(orgId: number, type: EventName, data: Record<string, unknown>, dedupe?: string): Promise<number> {
  const cfg = developerSurface();
  if (!cfg) return 0;
  const decl = cfg.events.find((e) => e.name === type);
  if (!decl) return 0;
  if (decl.areas?.length && typeof data.area === "string" && !decl.areas.includes(data.area)) return 0;
  const key = dedupe ?? `${type}:${randomBytes(9).toString("base64url")}`;
  const payload = envelope(type, data);
  const rows = await asPlatform(async () => (await getDb()).query<{ id: string }>(
    `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, event_type, dedupe_key, payload, next_attempt_at)
     SELECT 'msg_' || substr(md5(random()::text || clock_timestamp()::text || e.id), 1, 24), e.org_id, e.id, $2, $3, $4, now() FROM webhook_endpoints e
      WHERE e.org_id = $1 AND e.status = 'enabled' AND (cardinality(e.events) = 0 OR $2 = ANY (e.events))
     ON CONFLICT (endpoint_id, dedupe_key) DO NOTHING RETURNING id`, [orgId, type, key, JSON.stringify(payload)]));
  if (rows.length) kick();
  return rows.length;
}

/** A record change as its event (src/record-areas.ts onRecordChange): a sealed area's carries its key only. */
async function onChange(c: RecordChange) {
  if (!developerSurface()) return;
  const type = `record.${c.change}` as EventName;
  const area = recordAreas().find((a) => a.name === c.area);
  const sealed = area?.sealed === true || area?.role === "asset";
  const r = c.record;
  const data: Record<string, unknown> = {
    area: c.area, key: c.key,
    ...(r && !sealed ? { title: r.title, data: r.data, updated_at: r.updated_at } : {}),
    ...(r && sealed ? { updated_at: r.updated_at, sealed: true } : {}),
    ...(c.change === "state_changed" ? { from: c.from ?? null, to: c.to ?? null } : {}),
    actor: actorLabel(currentApiActor()),
  };
  await emitEvent(c.orgId, type, data, `${type}:${c.area}:${c.key}:${r?.updated_at ?? Date.now()}:${randomBytes(4).toString("hex")}`);
}
onRecordChange(onChange);

/** The runs that ended since the last scan, as run.finished (the runs table read, src/runs.ts untouched). */
export async function scanFinishedRuns(): Promise<number> {
  if (!declaredEvents().includes("run.finished")) return 0;
  return asPlatform(async () => {
    const db = await getDb();
    const [mark] = await db.query<{ at: Date }>("SELECT at FROM developer_marks WHERE name = 'run.finished'");
    if (!mark) { await db.query("INSERT INTO developer_marks (name, at) VALUES ('run.finished', now()) ON CONFLICT DO NOTHING"); return 0; }
    // A minute's overlap: a run whose end was written in a transaction that committed late is still seen (queued once).
    const runs = await db.query<{ id: string; org_id: number; pack: string; kind: string; status: string; error_kind: string | null; cost_usd: string; attempt: number; ended_at: Date; created_at: Date }>(
      `/* tenant: the runs of every workspace with an enabled endpoint, each queued for its own workspace */
       SELECT r.id, r.org_id, r.pack, r.kind, r.status, r.error_kind, r.cost_usd, r.attempt, r.ended_at, r.created_at FROM runs r
        WHERE r.ended_at >= $1::timestamptz - interval '1 minute' AND r.status IN ('succeeded', 'failed', 'cancelled')
          AND EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.org_id = r.org_id AND e.status = 'enabled')
        ORDER BY r.ended_at LIMIT 1000`, [mark.at]);
    let n = 0;
    for (const r of runs) n += await emitEvent(r.org_id, "run.finished", { run: { id: r.id, pack: r.pack, kind: r.kind, status: r.status, error_kind: r.error_kind,
      cost_usd: Number(r.cost_usd), attempt: r.attempt, created_at: iso(r.created_at), ended_at: iso(r.ended_at) } }, `run.finished:${r.id}:${r.attempt}`);
    const last = runs.length === 1000 ? runs[runs.length - 1]!.ended_at : null;
    await db.query("UPDATE developer_marks SET at = coalesce($1::timestamptz, now()) WHERE name = 'run.finished'", [last]);
    return n;
  });
}

interface DeliveryRaw {
  id: string; org_id: number; endpoint_id: string; event_type: string; payload: Record<string, unknown>; status: "pending" | "succeeded" | "failed";
  attempts: number; attempt_log: { at: string; status: number | null; ms: number; error?: string }[]; next_attempt_at: Date | null;
  last_status: number | null; last_error: string | null; created_at: Date; delivered_at: Date | null;
}
const DCOLS = "id, org_id, endpoint_id, event_type, payload, status, attempts, attempt_log, next_attempt_at, last_status, last_error, created_at, delivered_at";
export const deliveryView = (d: DeliveryRaw) => ({
  id: d.id, endpoint_id: d.endpoint_id, event_type: d.event_type, status: d.status, attempts: d.attempts, attempt_log: d.attempt_log,
  next_attempt_at: d.status === "pending" ? iso(d.next_attempt_at) : null, last_status: d.last_status, last_error: d.last_error,
  created_at: iso(d.created_at)!, delivered_at: iso(d.delivered_at), payload: d.payload,
});

/** One attempt of one delivery (claimed by deliverDue or asked for): sends, logs, schedules the retry or the end. */
async function attempt(d: DeliveryRaw): Promise<void> {
  const db = await getDb();
  const [e] = await db.query<EndpointRaw>(`SELECT ${ECOLS} FROM webhook_endpoints WHERE org_id = $1 AND id = $2`, [d.org_id, d.endpoint_id]);
  if (!e) return;
  const secrets = [await open(d.org_id, e.secret_sealed)];
  if (e.previous_secret_sealed && e.previous_secret_until && +new Date(e.previous_secret_until) > Date.now()) secrets.push(await open(d.org_id, e.previous_secret_sealed));
  const body = JSON.stringify(d.payload);
  const ts = Math.floor(Date.now() / 1000);
  const t0 = Date.now();
  let status: number | null = null, error: string | undefined;
  const blocked = await addressProblem(e.url);
  if (blocked) error = `not sent: ${blocked}`;
  else {
    try {
      const r = await fetch(e.url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        headers: { "content-type": "application/json", "user-agent": "webhooks/1", ...signedHeaders(secrets, d.id, ts, body) }, body });
      status = r.status;
      await r.arrayBuffer().catch(() => null);
      if (status < 200 || status > 299) error = `answered ${status}`;
    } catch (x) { error = ((x as Error).name === "TimeoutError" ? `no answer within ${ATTEMPT_TIMEOUT_MS / 1000} s` : (x as Error).message).slice(0, 300); }
  }
  const ok = !error;
  const n = d.attempts + 1;
  const wait = RETRY_SCHEDULE[n - 1];
  const entry = { at: new Date(t0).toISOString(), status, ms: Date.now() - t0, ...(error ? { error } : {}) };
  await db.query(
    `UPDATE webhook_deliveries SET attempts = $3, attempt_log = attempt_log || $4::jsonb, last_status = $5, last_error = $6,
            status = CASE WHEN $7 THEN 'succeeded' WHEN $8::int IS NULL THEN 'failed' ELSE 'pending' END,
            delivered_at = CASE WHEN $7 THEN now() ELSE delivered_at END,
            next_attempt_at = CASE WHEN $7 OR $8::int IS NULL THEN NULL ELSE now() + make_interval(secs => $8::int) END
      WHERE org_id = $1 AND id = $2`, [d.org_id, d.id, n, JSON.stringify([entry]), status, error ?? null, ok, ok ? null : wait ?? null]);
  if (ok) await db.query("UPDATE webhook_endpoints SET failure_streak = 0, first_failure_at = NULL WHERE org_id = $1 AND id = $2", [d.org_id, e.id]);
  else {
    const [x] = await db.query<{ failure_streak: number }>(
      `UPDATE webhook_endpoints SET failure_streak = failure_streak + 1, first_failure_at = coalesce(first_failure_at, now()) WHERE org_id = $1 AND id = $2 RETURNING failure_streak`, [d.org_id, e.id]);
    if (x && x.failure_streak >= DISABLE_AFTER)
      await db.query(`UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = $3, updated_at = now() WHERE org_id = $1 AND id = $2 AND status = 'enabled'`,
        [d.org_id, e.id, `disabled after ${x.failure_streak} failed attempts in a row (the last: ${error})`.slice(0, 500)]);
  }
}

/** Claim and send the deliveries that are due (enabled endpoints only), at most `limit`. */
export async function deliverDue(limit = 50): Promise<{ attempted: number }> {
  if (!developerSurface()) return { attempted: 0 };
  return asPlatform(async () => {
    const db = await getDb();
    // Claimed by moving their next attempt two minutes on: another instance skips them; a crash retries them then.
    const due = await db.query<DeliveryRaw>(
      `/* tenant: due deliveries of every workspace, each sent to its own endpoint */
       UPDATE webhook_deliveries SET next_attempt_at = now() + interval '2 minutes'
        WHERE id IN (SELECT d.id FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id AND e.org_id = d.org_id
                      WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND e.status = 'enabled'
                      ORDER BY d.next_attempt_at LIMIT $1 FOR UPDATE OF d SKIP LOCKED)
        RETURNING ${DCOLS}`, [limit]);
    for (const d of due.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))) await attempt(d).catch((e) => console.error(`webhook delivery ${d.id}: ${(e as Error).message}`));
    return { attempted: due.length };
  });
}

let kicking: Promise<unknown> | null = null, again = false;
/** Send what is due now, in the background (one sender per process at a time). */
export function kick(): Promise<unknown> {
  if (kicking) { again = true; return kicking; }
  kicking = (async () => {
    do { again = false; await deliverDue().catch((e) => console.error(`webhooks: ${(e as Error).message}`)); } while (again);
  })().finally(() => { kicking = null; });
  return kicking;
}
/** Wait for the background sender (tests). */
export const settled = async () => { while (kicking) await kicking; };

/** A test ping to one endpoint, sent now: the delivery as it ended (or as it waits for its retry). */
export async function testEndpoint(orgId: number, id: string) {
  const e = await endpointRow(orgId, id);
  if (e.status !== "enabled") throw new ApiProblem(409, "endpoint_disabled", "This endpoint is disabled: enable it first");
  const did = `msg_${randomBytes(12).toString("hex")}`;
  const [d] = await asPlatform(async () => (await getDb()).query<DeliveryRaw>(
    `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, event_type, dedupe_key, payload, next_attempt_at) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '2 minutes') RETURNING ${DCOLS}`,
    [did, orgId, e.id, TEST_EVENT, `test:${did}`, JSON.stringify(envelope(TEST_EVENT, { endpoint_id: e.id, actor: actorLabel(currentApiActor()) }))]));
  await asPlatform(() => attempt(d!));
  return getDelivery(orgId, did);
}
export async function getDelivery(orgId: number, id: string) {
  const [d] = await asPlatform(async () => (await getDb()).query<DeliveryRaw>(`SELECT ${DCOLS} FROM webhook_deliveries WHERE org_id = $1 AND id = $2`, [orgId, String(id)]));
  if (!d) throw new ApiProblem(404, "not_found", "No such delivery");
  return deliveryView(d);
}
/** Send a delivery again now (a failed one is queued again with its attempts kept in the log). */
export async function redeliver(orgId: number, id: string) {
  const [d] = await asPlatform(async () => (await getDb()).query<DeliveryRaw>(
    `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now() + interval '2 minutes' WHERE org_id = $1 AND id = $2 AND status <> 'pending' RETURNING ${DCOLS}`, [orgId, String(id)]));
  if (!d) { await getDelivery(orgId, id); throw new ApiProblem(409, "delivery_pending", "This delivery is still being sent: wait for it"); }
  await asPlatform(() => attempt(d));
  return getDelivery(orgId, id);
}
/** An endpoint's deliveries, newest first, a page at a time (`after`: the previous page's `next`). */
export async function listDeliveries(orgId: number, endpointId: string, q: { limit?: unknown; after?: unknown; status?: unknown }) {
  await endpointRow(orgId, endpointId);
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiProblem(400, "invalid_request", "limit: 1 to 200");
  const after = q.after === undefined ? null : decodeCursor(String(q.after));
  const status = q.status === undefined ? null : String(q.status);
  if (status !== null && !["pending", "succeeded", "failed"].includes(status)) throw new ApiProblem(400, "invalid_request", "status: pending, succeeded or failed");
  const rows = await asPlatform(async () => (await getDb()).query<DeliveryRaw>(
    `SELECT ${DCOLS} FROM webhook_deliveries WHERE org_id = $1 AND endpoint_id = $2 AND ($3::text IS NULL OR status = $3)
        AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::text)) ORDER BY created_at DESC, id DESC LIMIT $6`,
    [orgId, endpointId, status, after?.at ?? null, after?.id ?? null, limit + 1]));
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { data: page.map(deliveryView), next: more ? encodeCursor(page[page.length - 1]!.created_at, page[page.length - 1]!.id) : null };
}

/** A keyset cursor (created_at, id), opaque to callers. */
export const encodeCursor = (at: Date | string, id: string) => Buffer.from(JSON.stringify([new Date(at).toISOString(), id])).toString("base64url");
export function decodeCursor(s: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as [string, string];
    if (typeof at !== "string" || typeof id !== "string" || Number.isNaN(Date.parse(at))) throw new Error();
    return { at, id };
  } catch { throw new ApiProblem(400, "invalid_cursor", "after: the next value of the previous page"); }
}

// ---------- the tick ----------

/** The run-finished scan, the due deliveries, and pruning (idempotency keys after 24 hours, deliveries after 30 days). */
export async function webhookTick() {
  if (!developerSurface()) return null;
  const finished = await scanFinishedRuns().catch((e) => ({ error: (e as Error).message }));
  const sent = await deliverDue(200).catch((e) => ({ error: (e as Error).message }));
  await asPlatform(async () => {
    const db = await getDb();
    await db.query("/* tenant: internal: expired idempotency keys of every workspace */ DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'");
    await db.query("/* tenant: internal: old deliveries of every workspace */ DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < now() - interval '30 days'");
    await db.query("/* tenant: internal: expired client sessions of every workspace */ DELETE FROM developer_client_sessions WHERE expires_at < now() - interval '1 day'");
  }).catch((e) => console.error(`webhooks prune: ${(e as Error).message}`));
  return { finished, sent };
}
let timer: NodeJS.Timeout | null = null;
/** A server's loop (every 15 seconds); on Vercel the cron calls webhookTick. Started only with a developer surface. */
export function startWebhookLoop(): boolean {
  if (!developerSurface() || timer) return false;
  timer = setInterval(() => void webhookTick().catch((e) => console.error(`webhooks: ${(e as Error).message}`)), 15_000);
  timer.unref();
  return true;
}
export function stopWebhookLoop() { if (timer) clearInterval(timer); timer = null; }

/** What every event the app declares carries (the OpenAPI document's webhooks, the guide). */
export const eventCatalog = () => (developerSurface()?.events ?? []).map((e) => ({ ...e, about: EVENT_CATALOG[e.name as EventName]?.about ?? "" }));
