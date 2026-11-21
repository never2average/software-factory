/**
 * Truthful connection health (mold_v0-332; molds/mold_v0/MOLD.md "Connection health"): what a workspace's connection
 * record says about itself stays true when its keys or its target change, when a test could not run, as time passes,
 * and when it is used. Pack config only (a test_connection probe's keys, src/connection-test-config.ts; an
 * object_storage declaration's fields, src/pack-api.ts ObjectStorageDeclSchema; a connection_env entry's only_one and
 * last_used, src/connection-env-config.ts).
 *
 *   the test     testOutcome: what a test writes: working or failing from the service's answer; "could not test"
 *                (cannot_test) when nothing was asked of the service (the vault locked, a field empty, no test for
 *                this provider, a key that does not open), needs_key when the key it sends is empty; the time
 *                (tested_at), its own words (result), failing_since and failures in a row. An undeclared could-not-test
 *                value leaves the status (and the tested day) as it was: it never blames the account
 *   the reset    healthWrite, in the record store's write (src/record-areas.ts putWorkspaceNow, every door: a person, an
 *                import, an agent, an action): a write that types or clears a key, or changes a field the test reads
 *                or a key is bound to, resets the status to untested (needs_key when it emptied a key) and clears the
 *                tested and result fields, in the same write. A new record starts untested
 *   one only     checkOnlyOne, in the record store's save checks: a connection_env entry with only_one refuses a save
 *                that turns its `use` on while another record (of its `where`) has it on, naming that record
 *   the view     withHealth, on every read of the area: {state, stale, days, attention, reasons}, worked out now (no
 *                write): a working status older than stale_after_days is stale; needs attention when failing, could not
 *                test, needs its key, stale, its key expiring within EXPIRING_DAYS (expires_on), or more than one record
 *                marked where only one may be. A metric (`needs_attention: true`) counts those records; the console's
 *                lists filter by them ("Needs attention")
 *   last used    stampLastUsed, at a wake's delivery (src/connection-env.ts): the entry's last_used field set to now,
 *                at most once an hour per record (a stamp of the app's own: no history line, the record's updated time
 *                kept)
 */
import { createHash } from "node:crypto";
import { bodyStrings, ConnectionTestSchema, isHttpProbe, outcomeOf, outcomeValue, placeholders, type HealthDecl, type HealthOutcome } from "./connection-test-config.js";
import { ConnectionEnvSchema } from "./connection-env-config.js";
import { ObjectStorageDeclSchema, PackError } from "./pack-api.js";
import { packs } from "./packs.js";
import { bindingsOf } from "./secret-binding.js";

/** A key whose expiry date is this close (or past) needs attention. */
export const EXPIRING_DAYS = 14;
/** A record's last-used time is written at most this often. */
export const LAST_USED_EVERY_MS = 3600_000;

type Field = { name: string; label?: string; type?: string; encrypted?: boolean; options?: readonly (string | { value: string; label?: string })[] };
interface AreaLike { pack: string; name: string; label?: string; fields: readonly Field[]; detail?: { actions?: readonly { kind?: string; probe?: unknown }[] } }

/** An area's declared health: its fields and outcomes, and what its test reads (a change of one resets it). */
export interface Health { decl: HealthDecl; status?: Field; reads: string[]; sealed: string[] }
/** A connection_env entry keeping one record marked: its flag, where, and the flag's label. */
export interface OnlyOne { use: string; where: Record<string, unknown>; label: string }

const cache = new WeakMap<object, Map<string, { health: Health | null; onlyOne: OnlyOne[] }>>();
function declOf(area: AreaLike) {
  const key = packs();
  let byArea = cache.get(key);
  if (!byArea) { byArea = new Map(); cache.set(key, byArea); }
  const id = `${area.pack}/${area.name}`;
  const hit = byArea.get(id);
  if (hit) return hit;
  const sealedOf = (n: string) => area.fields.some((f) => f.name === n && f.encrypted);
  let health: Health | null = null;
  const reads = new Set<string>();
  for (const a of area.detail?.actions ?? []) {
    if (a?.kind !== "test_connection") continue;
    const t = ConnectionTestSchema.safeParse(a.probe);
    if (!t.success) continue;
    if (t.data.by) reads.add(t.data.by);
    for (const p of Object.values(t.data.probes)) {
      if (!isHttpProbe(p)) { for (const f of Object.values(p.fields as Record<string, string | undefined>)) if (f) reads.add(f); continue; }
      for (const s of [p.url, p.if_empty?.url ?? "", ...Object.values(p.headers ?? {}), p.basic_auth?.user ?? "", p.basic_auth?.password ?? "", ...bodyStrings(p.body)]) for (const n of placeholders(s)) reads.add(n);
      if (p.if_empty) reads.add(p.if_empty.field);
      for (const n of p.binds ?? []) reads.add(n);
    }
    const { by: _by, probes: _p, ...decl } = t.data;
    health = { decl, reads: [], sealed: [] };
    break;
  }
  for (const p of packs()) {
    if (p.id !== area.pack) continue;
    const os = (p.definition as { objectStorage?: unknown }).objectStorage;
    if (!health && os) {
      const d = ObjectStorageDeclSchema.safeParse(os);
      if (d.success && d.data.area === area.name) {
        const f = d.data.fields;
        for (const n of [f.bucket, f.endpoint, f.access_key_id, f.secret_access_key]) reads.add(n);
        health = { decl: { status: f.status, tested: f.tested, tested_at: f.tested_at, result: f.result, failing_since: f.failing_since, failures: f.failures, expires_on: f.expires_on,
          outcomes: d.data.outcomes, stale_after_days: d.data.stale_after_days }, reads: [], sealed: [] };
      }
    }
  }
  // Whatever a kept key is bound to decides where it goes: a change there is a change of what was tested.
  for (const b of bindingsOf(area)) for (const n of [...b.decide, ...b.secrets]) reads.add(n);
  if (health) {
    const fields = new Set(area.fields.map((f) => f.name));
    health.reads = [...reads].filter((n) => fields.has(n));
    health.sealed = health.reads.filter(sealedOf);
    health.status = health.decl.status ? area.fields.find((f) => f.name === health!.decl.status) : undefined;
  }
  const onlyOne = new Map<string, OnlyOne>();
  for (const p of packs()) if (p.id === area.pack)
    for (const prof of (p.definition.agentProfiles ?? []) as { connection_env?: unknown[] }[])
      for (const raw of prof.connection_env ?? []) {
        const c = ConnectionEnvSchema.safeParse(raw);
        if (!c.success || c.data.area !== area.name || !c.data.only_one || !c.data.use) continue;
        const where = c.data.where ?? {};
        onlyOne.set(JSON.stringify([c.data.use, where]), { use: c.data.use, where, label: area.fields.find((f) => f.name === c.data.use)?.label ?? c.data.use });
      }
  const out = { health, onlyOne: [...onlyOne.values()] };
  byArea.set(id, out);
  return out;
}
/** The area's declared health (a test_connection's, else the object storage's), or null. */
export const healthOf = (area: AreaLike): Health | null => declOf(area).health;
/** The area's one-only flags (connection_env entries with only_one). */
export const onlyOneOf = (area: AreaLike): OnlyOne[] => declOf(area).onlyOne;

const blank = (v: unknown) => v === undefined || v === null || v === "";
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const matches = (where: Record<string, unknown>, data: Record<string, unknown>) => Object.entries(where).every(([k, v]) => data[k] === v);

// ---------------------------------------------------------------- the test's write

/** What a test found, as the health fields take it. */
export interface TestFinding { ok: boolean; outcome: string; words: string; keyEmpty?: boolean }
/** The outcome of a test: working, failing (the service answered no or never answered), or could-not-test / needs its key. */
export const findingOutcome = (r: TestFinding): HealthOutcome => (r.ok ? "working" : r.outcome !== "not_ready" ? "failing" : r.keyEmpty ? "needs_key" : "cannot_test");
export const RESULT_MAX = 300;

/**
 * The fields a test writes on a record whose stored values are `stored`: the status (its outcome's value; a
 * needs_key with no such option falls back to could-not-test; a could-not-test with none leaves the status and the
 * tested day as they were), tested (the day), tested_at (the time), result (its words), failing_since and failures.
 */
export function testOutcome(area: AreaLike, stored: Record<string, unknown>, r: TestFinding, now = new Date()): Record<string, unknown> {
  const h = healthOf(area);
  if (!h) return {};
  const d = h.decl, out: Record<string, unknown> = {};
  let o = findingOutcome(r);
  let value = d.status ? outcomeValue(h.status, o, d.outcomes) : null;
  if (d.status && value === null && o === "needs_key") { o = "cannot_test"; value = outcomeValue(h.status, o, d.outcomes); }
  const written = !d.status || value !== null;
  if (d.status && value !== null) out[d.status] = value;
  if (written && d.tested) out[d.tested] = now.toISOString().slice(0, 10);
  if (written && d.tested_at) out[d.tested_at] = now.toISOString();
  if (d.result) out[d.result] = r.words.slice(0, RESULT_MAX);
  if (o === "working") {
    if (d.failures) out[d.failures] = 0;
    if (d.failing_since) out[d.failing_since] = null;
  } else if (o === "failing") {
    const was = d.status ? outcomeOf(h.status, stored[d.status], d.outcomes) : null;
    if (d.failures) out[d.failures] = (was === "failing" && typeof stored[d.failures] === "number" ? (stored[d.failures] as number) : 0) + 1;
    if (d.failing_since) out[d.failing_since] = was === "failing" && !blank(stored[d.failing_since]) ? stored[d.failing_since] : now.toISOString();
  }
  return out;
}

// ---------------------------------------------------------------- the reset (the record store's write)

/**
 * mold_v0-332, in the record store's write (src/record-areas.ts putWorkspaceNow): `given` is the write's input after
 * its encrypted fields were split (a key in it was typed again or cleared), `carried` what the write keeps of the stored
 * row (a key left out, the app's own fields), after the binding cleared what it clears. A write that types or clears a
 * key, or changes a field the test reads (or a key is bound to), resets the status (needs_key when it emptied a key,
 * else untested) and clears the tested and result fields, whoever writes, in this same write. A new record without a
 * status starts untested. Returns the input to write (`carried` is changed in place).
 */
export function healthWrite(area: AreaLike, prev: Record<string, unknown> | null, given: unknown, carried: Record<string, unknown>): unknown {
  const h = healthOf(area);
  if (!h || !isObj(given)) return given;
  const d = h.decl;
  const untested = d.status ? outcomeValue(h.status, "untested", d.outcomes) : null;
  if (!prev) {
    if (d.status && untested !== null && blank(given[d.status]) && blank(carried[d.status])) carried[d.status] = untested;
    return given;
  }
  const g = { ...given };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(g, k);
  let changed = false, emptied = false;
  for (const f of h.reads) {
    if (h.sealed.includes(f)) {
      const typed = has(f) && !blank(g[f]);
      const kept = typed || (!has(f) && !blank(carried[f]));
      if (typed) changed = true;
      if (!blank(prev[f]) && !kept) { changed = true; emptied = true; }
    } else if (!same(has(f) ? g[f] : carried[f], prev[f])) changed = true;
  }
  if (!changed) return given;
  for (const k of [d.tested, d.tested_at, d.result, d.failing_since, d.failures]) if (k) { delete g[k]; delete carried[k]; }
  if (d.status) {
    delete g[d.status];
    const v = (emptied ? outcomeValue(h.status, "needs_key", d.outcomes) : null) ?? untested;
    if (v !== null) carried[d.status] = v; else delete carried[d.status];
  }
  return g;
}

/**
 * mold_v0-332, in the record store's save checks (src/record-areas.ts onSaveChecks: every write and an import's
 * preview): a record saved with a one-only flag on, which was not on (or not of that `where`) before, is refused
 * while another record of the workspace has it on, naming that record (one the writer may not read: "another record").
 */
export async function checkOnlyOne(orgId: number, area: AreaLike & { scope?: string }, key: string, data: Record<string, unknown>, actor: { role: unknown; userId: string | null }): Promise<void> {
  const list = area.scope === "workspace" ? onlyOneOf(area) : [];
  if (!list.length) return;
  const mine = list.filter((o) => data[o.use] === true && matches(o.where, data));
  if (!mine.length) return;
  const { getDb } = await import("./db.js");
  const { withTenant, withViewer } = await import("./tenant-scope.js");
  const { getFor } = await import("./record-areas.js");
  const { auditQuiet } = await import("./audit-trail.js");
  for (const o of mine) {
    const rows = await withViewer(null, () => withTenant(orgId, async () => (await getDb()).query<{ key: string; title: string | null; data: Record<string, unknown> | string }>(
      "SELECT key, title, data FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND data -> $4 = 'true'::jsonb ORDER BY updated_at DESC, key LIMIT 50",
      [orgId, area.pack, area.name, o.use])));
    const dataOf = (r: { data: Record<string, unknown> | string }) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
    if (rows.some((r) => r.key === key && matches(o.where, dataOf(r)))) continue; // already on: not this write's doing
    const other = rows.find((r) => r.key !== key && matches(o.where, dataOf(r)));
    if (!other) continue;
    const seen = await auditQuiet(() => getFor(orgId, area.name, other.key, actor as never)).catch(() => null);
    const name = seen ? `"${seen.title || seen.key}"` : "another record (one you cannot see)";
    throw new PackError(`${area.label ?? area.name}: ${name} is already marked "${o.label}", and only one may be: turn it off there first`, 409);
  }
}

// ---------------------------------------------------------------- the view (on every read)

export type AttentionReason = "failing" | "cannot_test" | "needs_key" | "stale" | "expiring" | "more_than_one";
/** What a read says of a record's health, worked out now (never written). */
export interface HealthView {
  /** The status field, and which outcome its value is. */
  field?: string; state: HealthOutcome | null;
  /** When it was last tested (tested_at, else the tested day), and how many whole days ago. */
  tested_at?: string; days?: number;
  /** A working status older than stale_after_days: shown as "Tested N days ago", neutral. */
  stale?: true;
  attention: boolean; reasons: AttentionReason[];
}
const DAY = 86_400_000;
const dayOf = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(t) ? null : t;
};

/** A record's health now: `dup` says another record has a one-only flag this one has on. */
export function healthView(area: AreaLike, data: Record<string, unknown>, now: Date, dup: boolean): HealthView | null {
  const h = healthOf(area);
  if (!h && !dup && !onlyOneOf(area).length) return null;
  const reasons: AttentionReason[] = [];
  const view: HealthView = { state: null, attention: false, reasons };
  if (h) {
    const d = h.decl;
    if (d.status) { view.field = d.status; view.state = outcomeOf(h.status, data[d.status], d.outcomes); }
    const at = (d.tested_at && !blank(data[d.tested_at]) ? data[d.tested_at] : d.tested ? data[d.tested] : undefined) as string | undefined;
    const t = dayOf(at);
    if (t !== null) { view.tested_at = at; view.days = Math.max(0, Math.floor((now.getTime() - t) / DAY)); }
    if (view.state === "failing" || view.state === "cannot_test" || view.state === "needs_key") reasons.push(view.state);
    if (view.state === "working" && d.stale_after_days !== undefined && view.days !== undefined && view.days > d.stale_after_days) { view.stale = true; reasons.push("stale"); }
    const exp = d.expires_on ? dayOf(data[d.expires_on]) : null;
    if (exp !== null && exp <= now.getTime() + EXPIRING_DAYS * DAY) reasons.push("expiring");
  }
  if (dup) reasons.push("more_than_one");
  view.attention = reasons.length > 0;
  return view;
}

/** The keys of the workspace's records with a one-only flag on beside another (of the same `where`). */
async function duplicates(orgId: number, area: AreaLike): Promise<Set<string>> {
  const out = new Set<string>();
  const list = onlyOneOf(area);
  if (!list.length) return out;
  const { getDb } = await import("./db.js");
  const { withTenant, withViewer } = await import("./tenant-scope.js");
  for (const o of list) {
    const rows = await withViewer(null, () => withTenant(orgId, async () => (await getDb()).query<{ key: string; data: Record<string, unknown> | string }>(
      "SELECT key, data FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND data -> $4 = 'true'::jsonb LIMIT 200",
      [orgId, area.pack, area.name, o.use])));
    const on = rows.filter((r) => matches(o.where, (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>));
    if (on.length > 1) for (const r of on) out.add(r.key);
  }
  return out;
}

/** Whether the area's reads carry a health view (a declared test, or a one-only flag). */
export const showsHealth = (area: AreaLike & { scope?: string }) => area.scope === "workspace" && (healthOf(area) !== null || onlyOneOf(area).length > 0);

/** The records with their health (`health`), as read now; the same list for an area that declares none. */
export async function withHealth<R extends { key: string; data: Record<string, unknown> }>(orgId: number, area: AreaLike & { scope?: string }, records: R[], now = new Date()): Promise<(R & { health?: HealthView })[]> {
  if (!records.length || !showsHealth(area)) return records;
  const dup = await duplicates(orgId, area).catch(() => new Set<string>());
  return records.map((r) => { const v = healthView(area, r.data, now, dup.has(r.key)); return v ? { ...r, health: v } : r; });
}

/** mold_v0-332: the rows of an area that need attention now (a metric's `needs_attention`). */
export async function needingAttention<R extends { key?: string; data: Record<string, unknown> }>(orgId: number, area: AreaLike & { scope?: string }, rows: R[], now = new Date()): Promise<R[]> {
  if (!showsHealth(area)) return [];
  const dup = await duplicates(orgId, area).catch(() => new Set<string>());
  return rows.filter((r) => healthView(area, r.data, now, r.key !== undefined && dup.has(r.key))?.attention === true);
}

// ---------------------------------------------------------------- last used (a wake's delivery)

const stamped = new Map<string, number>();
/**
 * mold_v0-332: the entry's `last_used` field of the delivered record set to now, at most once an hour per record (in
 * this process, and in the database: a value newer than an hour is left as it is, whichever instance wrote it). A
 * stamp of the app's own: no history line and the record's updated time kept (the frozen version reads other fields).
 * Never throws.
 */
export async function stampLastUsed(orgId: number, areaName: string, key: string, field: string, now = new Date()): Promise<void> {
  const id = createHash("sha256").update(JSON.stringify([orgId, areaName, key, field])).digest("hex");
  const at = now.getTime();
  if ((stamped.get(id) ?? 0) > at - LAST_USED_EVERY_MS) return;
  stamped.set(id, at);
  if (stamped.size > 10_000) for (const [k, t] of stamped) if (t < at - LAST_USED_EVERY_MS) stamped.delete(k);
  try {
    const { findArea, isSealedArea } = await import("./record-areas.js");
    const area = findArea(areaName);
    if (!area || area.scope !== "workspace" || isSealedArea(area) || area.chain === true || !area.fields.some((f) => f.name === field && f.type === "date")) return;
    const { getDb } = await import("./db.js");
    const { withTenant, withViewer } = await import("./tenant-scope.js");
    await withViewer(null, () => withTenant(orgId, async () => (await getDb()).query(
      `UPDATE workspace_records SET data = jsonb_set(data, ARRAY[$5::text], to_jsonb($6::text))
        WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4 AND (data ->> $5 IS NULL OR data ->> $5 < $7)`,
      [orgId, area.pack, area.name, key, field, now.toISOString(), new Date(at - LAST_USED_EVERY_MS).toISOString()])));
  } catch (e) { console.error(`connection health: last used was not written to ${areaName} ${key}: ${String((e as Error).message).slice(0, 200)}`); }
}
/** Tests only: forget this process's last-used stamps. */
export const resetLastUsedForTest = () => stamped.clear();
