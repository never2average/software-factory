import { gunzipSync, gzipSync } from "node:zlib";
import { getDb } from "./db.js";
import { researchJobs, sessionEngine } from "./host-tables.js";
import { getObject, keys, putObject, s3Ready } from "./storage.js";
import { baseTranscripts, type StoredEvent } from "./transcripts.js";
import { ENV } from "./env-names.js";

/**
 * Off-machine archive of what the live stores hold (docs/storage.md). ClickHouse Cloud is a trial that can lapse, so
 * every finished session's full trace is copied to R2 as gzipped JSONL, and every onboarding research result as JSON.
 *
 *  - archiveSession: one object per session, `transcripts/org-<id>/<yyyy-mm>/<session>.jsonl.gz`. The first line is a
 *    header ({"_session": {...}}: org, product, simulation, scenario, agent, model, status, verdict, cost); every
 *    following line is a stored event exactly as the transcript store returns it.
 *  - The sweeper (startArchiver) claims unarchived finished sessions and research with FOR UPDATE SKIP LOCKED, so
 *    several server replicas never double-write, and a failed upload is retried after 15 minutes. Its first passes are
 *    the backfill of everything recorded before archiving existed.
 *  - Read-through: when the live store has no events for an archived session (ClickHouse gone and the server moved to
 *    the Postgres store, or a fresh store), transcripts are served from the archive, so reports and evidence links keep
 *    working. scripts/restore-transcripts.ts loads archives back into whichever store is configured.
 */

const BATCH = () => Math.max(1, Number(ENV.APP_ARCHIVE_BATCH ?? 25));
const INTERVAL_MS = () => Math.max(10, Number(ENV.APP_ARCHIVE_INTERVAL_SECONDS ?? 300)) * 1000;
const FINAL = ["completed", "failed", "timeout", "cancelled"];

async function allLiveEvents(orgId: number, sessionId: string): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await baseTranscripts().read(orgId, sessionId, offset, 1000);
    out.push(...page.events);
    if (page.events.length < 1000) return out;
  }
}

/** Archive one finished session's trace. Returns the object key, or null when the session has nothing to archive. */
export async function archiveSession(sessionId: string): Promise<{ key: string; events: number } | null> {
  if (!sessionEngine()) return null; // no session engine tables in this build (mold_v0-049)
  const db = await getDb();
  const [s] = await db.query<any>(
    `SELECT s.id, s.org_id, s.product_id, s.simulation_id, s.scenario_id, s.profile_id, s.agent_id, s.harness, s.model, s.status,
            s.completed_reason, s.verdict, s.winner, s.cost_usd, s.tokens_in, s.tokens_out, s.started_at, s.ended_at, s.queued_at
       FROM agent_sessions s WHERE s.id = $1`, [sessionId]);
  if (!s || !FINAL.includes(s.status)) return null;
  const events = await allLiveEvents(s.org_id, s.id);
  const endedAt = new Date(s.ended_at ?? s.queued_at ?? Date.now());
  const key = keys.transcript(s.org_id, s.id, endedAt);
  const body = [JSON.stringify({ _session: { ...s, archived_at: new Date().toISOString(), events: events.length } }),
                ...events.map((e) => JSON.stringify(e))].join("\n") + "\n";
  await putObject(key, gzipSync(Buffer.from(body, "utf8")), "application/gzip",
                  { session: s.id, org: String(s.org_id), events: String(events.length) });
  await db.query("/* tenant: internal archive sweep, session id from the claim below */ UPDATE agent_sessions SET archive_key = $2, archived_at = now(), archive_events = $3 WHERE id = $1", [s.id, key, events.length]);
  return { key, events: events.length };
}

/** Archive one finished research job (its full result, sources included). */
export async function archiveResearch(researchId: string): Promise<string | null> {
  if (!researchJobs()) return null;
  const db = await getDb();
  const [r] = await db.query<any>(
    "SELECT id, org_id, product_id, status, input, result, error, simulation_id, created_at, finished_at FROM product_research WHERE id = $1", [researchId]);
  if (!r || !["completed", "failed"].includes(r.status)) return null;
  const key = keys.research(r.org_id, r.id);
  await putObject(key, JSON.stringify({ ...r, archived_at: new Date().toISOString() }, null, 1), "application/json", { research: r.id, org: String(r.org_id) });
  await db.query("/* tenant: internal archive sweep, research id from the claim below */ UPDATE product_research SET archive_key = $2, archived_at = now() WHERE id = $1", [r.id, key]);
  return key;
}

/** One sweep: claim and archive up to BATCH sessions and research jobs. Returns what it archived. */
export async function archiveSweep(): Promise<{ sessions: number; research: number; failed: number }> {
  // The session engine's tables are a host pack's (mold_v0-049): with none, nothing of it to archive.
  if (!sessionEngine() || !(await s3Ready())) return { sessions: 0, research: 0, failed: 0 };
  const db = await getDb();
  const sessions = await db.query<{ id: string }>(
    `/* tenant: internal archive sweep across all orgs (rows keep their org_id) */ UPDATE agent_sessions SET archive_claimed_at = now()
      WHERE id IN (SELECT id FROM agent_sessions
                    WHERE archive_key IS NULL AND status = ANY($2) AND coalesce(ended_at, queued_at) < now() - interval '2 minutes'
                      AND (archive_claimed_at IS NULL OR archive_claimed_at < now() - interval '15 minutes')
                    ORDER BY coalesce(ended_at, queued_at) LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id`, [BATCH(), FINAL]);
  const research = !researchJobs() ? [] : await db.query<{ id: string }>(
    `/* tenant: internal archive sweep across all orgs (rows keep their org_id) */ UPDATE product_research SET archive_claimed_at = now()
      WHERE id IN (SELECT id FROM product_research
                    WHERE archive_key IS NULL AND status IN ('completed', 'failed')
                      AND (archive_claimed_at IS NULL OR archive_claimed_at < now() - interval '15 minutes')
                    ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id`, [BATCH()]);
  let ok = 0, rok = 0, failed = 0;
  for (const { id } of sessions) {
    try { await archiveSession(id); ok++; }
    catch (e) { failed++; console.error(`archive: session ${id}: ${(e as Error).message}`); }
  }
  for (const { id } of research) {
    try { await archiveResearch(id); rok++; }
    catch (e) { failed++; console.error(`archive: research ${id}: ${(e as Error).message}`); }
  }
  return { sessions: ok, research: rok, failed };
}

let timer: NodeJS.Timeout | null = null;
/**
 * Background sweeper (every APP_ARCHIVE_INTERVAL_SECONDS, 300), in a build with the session engine unless APP_ARCHIVE=off.
 * Each sweep archives only while a bucket is configured (the environment's R2_* or the key vault's Object storage,
 * src/storage.ts), so one added on Key vault later is picked up without a restart. Returns whether it runs.
 */
export function startArchiver(log: (m: string) => void = (m) => console.error(m)): boolean {
  if (timer) return true;
  if (!sessionEngine() || (ENV.APP_ARCHIVE ?? "on").toLowerCase() === "off") return false;
  const loop = async () => {
    try {
      // Keep sweeping while a sweep is full (the backfill), then fall back to the interval.
      for (let i = 0; i < 40; i++) {
        const r = await archiveSweep();
        if (r.sessions || r.research || r.failed) log(`archive: ${r.sessions} session(s), ${r.research} research job(s) to the bucket${r.failed ? `, ${r.failed} failed (retried later)` : ""}`);
        if (r.sessions < BATCH() && r.research < BATCH()) break;
      }
    } catch (e) { log(`archive: sweep failed: ${(e as Error).message}`); }
    timer = setTimeout(loop, INTERVAL_MS());
    timer.unref();
  };
  timer = setTimeout(loop, 20_000);
  timer.unref();
  return true;
}
export function stopArchiver() { if (timer) clearTimeout(timer); timer = null; }

// ---------- read-through ----------

/** Parse an archived session object into its header and events. */
export function parseArchive(gz: Buffer): { header: Record<string, unknown> | null; events: StoredEvent[] } {
  const lines = gunzipSync(gz).toString("utf8").split("\n").filter(Boolean);
  let header: Record<string, unknown> | null = null;
  const events: StoredEvent[] = [];
  for (const l of lines) {
    const o = JSON.parse(l);
    if (o && typeof o === "object" && "_session" in o) header = o._session;
    else events.push(o as StoredEvent);
  }
  return { header, events };
}

const cache = new Map<string, StoredEvent[]>();
/** Drop an organization's cached archived sessions (organization deletion). */
export function forgetArchivedOrg(orgId: number): void {
  for (const k of [...cache.keys()]) if (k.startsWith(`${orgId}:`)) cache.delete(k);
}
/** The archived events of a session (org-checked), or null when it has no archive. Small LRU of 20 sessions. */
export async function archivedEvents(orgId: number, sessionId: string): Promise<StoredEvent[] | null> {
  if (!sessionEngine() || !(await s3Ready())) return null;
  const ck = `${orgId}:${sessionId}`; // org in the key: the cache must never answer another org
  const hit = cache.get(ck);
  if (hit) { cache.delete(ck); cache.set(ck, hit); return hit; }
  const db = await getDb();
  const [s] = await db.query<{ archive_key: string | null }>("SELECT archive_key FROM agent_sessions WHERE id = $1 AND org_id = $2", [sessionId, orgId]);
  if (!s?.archive_key) return null;
  const gz = await getObject(s.archive_key);
  if (!gz) return null;
  const { events } = parseArchive(gz);
  cache.set(ck, events);
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return events;
}

// ---------- restore ----------

/**
 * Load archived sessions back into the live store (a new ClickHouse service, or Postgres after ClickHouse lapsed).
 * Sessions the store already has events for are skipped, so it is safe to re-run. `orgId` limits it to one org.
 */
export async function restoreArchives(opts: { orgId?: number; dryRun?: boolean; log?: (m: string) => void } = {}) {
  const { listKeys } = await import("./storage.js");
  const log = opts.log ?? ((m: string) => console.error(m));
  const prefix = opts.orgId != null ? keys.orgPrefix("transcripts", opts.orgId) : "transcripts/";
  const base = baseTranscripts();
  let restored = 0, skipped = 0, events = 0, failed = 0;
  for (const o of await listKeys(prefix)) {
    try {
      const gz = await getObject(o.key);
      if (!gz) continue;
      const { header, events: ev } = parseArchive(gz);
      const h = header as { id: string; org_id: number; product_id: number; simulation_id: string; model: string } | null;
      if (!h?.id) { failed++; log(`restore: ${o.key}: no session header`); continue; }
      if ((await base.read(h.org_id, h.id, 0, 1)).total > 0 || !ev.length) { skipped++; continue; }
      if (!opts.dryRun)
        for (let i = 0; i < ev.length; i += 500)
          await base.append({ id: h.id, org_id: h.org_id, product_id: h.product_id, simulation_id: h.simulation_id, model: h.model }, ev.slice(i, i + 500));
      restored++; events += ev.length;
    } catch (e) { failed++; log(`restore: ${o.key}: ${(e as Error).message}`); }
  }
  log(`restore${opts.dryRun ? " (dry run)" : ""}: ${restored} session(s), ${events} event(s) into ${base.kind}; ${skipped} already present; ${failed} failed`);
  return { restored, skipped, events, failed, store: base.kind };
}
