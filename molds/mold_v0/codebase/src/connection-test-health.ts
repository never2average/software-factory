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
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { bodyStrings, ConnectionTestSchema, isHttpProbe, outcomeOf, outcomeValue, placeholders, type HealthDecl, type HealthOutcome } from "./connection-test-config.js";
import { ConnectionEnvSchema, whereHolds } from "./connection-env-config.js";
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
// mold_v0-349: a list in `where` is one of its values (one marked per kind of network).
const matches = (where: Record<string, unknown>, data: Record<string, unknown>) => whereHolds(where, data);

// ---------------------------------------------------------------- the test's write

/** What a test found, as the health fields take it. */
export interface TestFinding { ok: boolean; outcome: string; words: string; keyEmpty?: boolean;
  /** The record's own key does not open with the workspace's key (not the vault locked): nothing it says is true any more. */
  keyBroken?: boolean }
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
  // A key that does not open with the workspace's key: the status it had is no longer true. With no could-not-test
  // option it goes back to untested (or is cleared), the tested day left as it was.
  if (d.status && value === null && o === "cannot_test" && r.keyBroken) { out[d.status] = outcomeValue(h.status, "untested", d.outcomes); if (d.result) out[d.result] = r.words.slice(0, RESULT_MAX); return out; }
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
export function healthWrite(area: AreaLike, prev: Record<string, unknown> | null, given: unknown, carried: Record<string, unknown>, key?: string): unknown {
  const h = healthOf(area);
  if (!h || !isObj(given)) return given;
  const d = h.decl;
  const untested = d.status ? outcomeValue(h.status, "untested", d.outcomes) : null;
  const own = [d.status, d.tested, d.tested_at, d.result, d.failing_since, d.failures].filter((k): k is string => !!k);
  const g = { ...given };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(g, k);
  // Only the record's own test writes its health (and only about the values it tested): any other write (a run, a
  // tool, an import, a clock, a repository's index, another page action) keeps what is stored, whatever it says.
  const test = testScope.getStore();
  // One-shot: the test's own write-back alone (what that write sets off, a listener or work after its commit, does not inherit it).
  const mine = !!test && !test.used && test.area === area.name && test.key === key;
  if (mine) test.used = true;
  const keep = () => { for (const k of own) { delete g[k]; if (prev && !blank(prev[k])) carried[k] = prev[k]; else delete carried[k]; } };
  if (!mine) keep();
  else if (prev && h.reads.some((f) => !same(test.snapshot[f], prev[f]))) keep(); // changed while it was tested: its result is about other values
  if (!prev) {
    if (d.status && untested !== null && blank(g[d.status]) && blank(carried[d.status])) carried[d.status] = untested;
    return g;
  }
  let changed = false, emptied = false;
  for (const f of h.reads) {
    if (h.sealed.includes(f)) {
      const typed = has(f) && !blank(g[f]);
      const kept = typed || (!has(f) && !blank(carried[f]));
      if (typed) changed = true;
      if (!blank(prev[f]) && !kept) { changed = true; emptied = true; }
    } else if (!same(has(f) ? g[f] : carried[f], prev[f])) changed = true;
  }
  if (!changed) return g;
  for (const k of [d.tested, d.tested_at, d.result, d.failing_since, d.failures]) if (k) { delete g[k]; delete carried[k]; }
  if (d.status) {
    delete g[d.status];
    const v = (emptied ? outcomeValue(h.status, "needs_key", d.outcomes) : null) ?? untested;
    if (v !== null) carried[d.status] = v; else delete carried[d.status];
  }
  return g;
}

/** The test in progress: the record it reads, and the values of the fields it reads as it read them. */
const testScope = new AsyncLocalStorage<{ area: string; key: string; snapshot: Record<string, unknown>; used?: boolean }>();
/**
 * Run a record's test (src/connection-test.ts, src/workspace-storage.ts): its write-back alone may set the health
 * fields, and only while the record still holds the values it tested (`stored`, as read before the call: plain values
 * and sealed envelopes); else the write keeps the stored health (a reset meanwhile stays).
 */
export function asTestOf<T>(area: AreaLike, key: string, stored: Record<string, unknown>, fn: () => T): T {
  const h = healthOf(area);
  const snapshot = Object.fromEntries((h?.reads ?? []).map((f) => [f, stored[f]]));
  return testScope.run({ area: area.name, key, snapshot: structuredClone(snapshot) }, fn);
}

/** Rows an import's preview is about to write (key: its data), so one-only marks are judged across the file. */
const pendingScope = new AsyncLocalStorage<Map<string, Record<string, unknown>>>();
export const withPendingRows = <T>(rows: Map<string, Record<string, unknown>>, fn: () => T): T => pendingScope.run(rows, fn);
/** mold_v0-337: an import preview's pending rows (key -> data), for the save checks that count siblings; null outside one. */
export const pendingRows = (): ReadonlyMap<string, Record<string, unknown>> | null => pendingScope.getStore() ?? null;

/**
 * A read of the workspace's records as the shell reads them for a save check (mold_v0-332; mold_v0-337 shares it):
 * every row, whoever may see it; in a batch on the write's own transaction (it sees what the batch wrote so far:
 * app.viewer "*" for this one read, then the writer's again), else on its own.
 */
export async function shellRead<R>(orgId: number, sql: string, params: unknown[]): Promise<R[]> {
  const { getDb } = await import("./db.js");
  const { withTenant, withViewer } = await import("./tenant-scope.js");
  const ra = await import("./record-areas.js");
  if (!ra.inRecordBatch()) return withViewer(null, () => withTenant(orgId, async () => (await getDb()).query<R & object>(sql, params))) as Promise<R[]>;
  return withTenant(orgId, async () => {
    const tx = await ra.recordQuery();
    const [was] = await tx.query<{ v: string | null }>("SELECT current_setting('app.viewer', true) AS v");
    await tx.query("SELECT set_config('app.viewer', '*', true)");
    let got: R[];
    try { got = await tx.query<R & object>(sql, params) as R[]; }
    catch (e) {
      // The read's own error is the one said (the transaction is then rolled back, the setting with it).
      await tx.query("SELECT set_config('app.viewer', $1, true)", [was?.v ?? ""]).catch(() => undefined);
      throw e;
    }
    await tx.query("SELECT set_config('app.viewer', $1, true)", [was?.v ?? ""]);
    return got;
  });
}

/**
 * The workspace's records of `area` with `use` on, as they stand for this write: every row (the shell's read: a row the
 * writer cannot see counts too; in a batch, as its transaction has them), and an import preview's pending rows over
 * them. Never limited: every marked row is counted.
 */
async function marked(orgId: number, area: AreaLike, use: string): Promise<{ key: string; title: string | null; data: Record<string, unknown> }[]> {
  const parse = (d: Record<string, unknown> | string) => (typeof d === "string" ? JSON.parse(d) : d) as Record<string, unknown>;
  const sql = "SELECT key, title, data FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND data -> $4 = 'true'::jsonb";
  type R = { key: string; title: string | null; data: Record<string, unknown> | string };
  const found = await shellRead<R>(orgId, sql, [orgId, area.pack, area.name, use]);
  const rows = new Map(found.map((r) => [r.key, { key: r.key, title: r.title, data: parse(r.data) }]));
  for (const [k, d] of pendingScope.getStore() ?? []) rows.set(k, { key: k, title: null, data: d });
  return [...rows.values()].filter((r) => r.data[use] === true);
}

/**
 * mold_v0-332, in the record store's save checks (src/record-areas.ts onSaveChecks: every write and an import's
 * preview): a record saved with a one-only flag on, which was not on (or not of that `where`) before, is refused
 * while another record of the workspace has it on, naming that record (one the writer may not read: "another record").
 */
export async function checkOnlyOne(orgId: number, area: AreaLike & { scope?: string }, key: string, data: Record<string, unknown>, actor: { role: unknown; userId: string | null }, prev?: Record<string, unknown> | null): Promise<void> {
  const list = area.scope === "workspace" ? onlyOneOf(area) : [];
  if (!list.length) return;
  const mine = list.filter((o) => data[o.use] === true && matches(o.where, data));
  if (!mine.length) return;
  const ra = await import("./record-areas.js");
  await lockOnlyOne(orgId, [area]);
  const { auditQuiet } = await import("./audit-trail.js");
  // The record as it stands before this write (in a batch: as the batch left it so far).
  let before = prev;
  if (before === undefined) {
    const { withTenant } = await import("./tenant-scope.js");
    const [r] = await withTenant(orgId, async () => (await ra.recordQuery()).query<{ data: Record<string, unknown> | string }>(
      "SELECT data FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4", [orgId, area.pack, area.name, key]));
    before = r ? ((typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>) : null;
  }
  for (const o of mine) {
    // Already on (and of that `where`) before this write: not this write's doing (two marked before the rule save as they are).
    if (before && before[o.use] === true && matches(o.where, before)) continue;
    const rows = await marked(orgId, area, o.use);
    const other = rows.find((r) => r.key !== key && matches(o.where, r.data));
    if (!other) continue;
    // A row of the import's own file is named by its key in that file; any other as the writer reads it (never a title read
    // as the shell, never one sealed: a record they cannot see is "another record").
    const inFile = pendingScope.getStore()?.has(other.key) === true;
    const seen = inFile ? null : await auditQuiet(() => ra.getFor(orgId, area.name, other.key, actor as never)).catch(() => null);
    const name = inFile ? `"${other.key}" (a row of this file)` : seen ? `"${seen.title || seen.key}"` : "another record (one you cannot see)";
    throw new PackError(`${area.label ?? area.name}: ${name} is ${inFile ? "also marked" : "already marked"} "${o.label}", and only one may be: turn it off there first`, 409);
  }
}

/** Orders a batch's writes so that those turning a one-only flag on come last (in place): a swap in one file saves. */
export function onlyOneLast(area: AreaLike, writes: { data: Record<string, unknown> }[]): void {
  const list = onlyOneOf(area);
  if (!list.length) return;
  const on = (w: { data: Record<string, unknown> }) => list.some((o) => w.data[o.use] === true);
  const sorted = [...writes.filter((w) => !on(w)), ...writes.filter(on)];
  writes.splice(0, writes.length, ...sorted);
}

/**
 * Writes to an area with a one-only flag take their turn (an advisory lock for the write's transaction: such an area's
 * writes always run in one), taken at the START of every write, move and delete, and once at a batch's start for
 * every such area it touches (in name order), whatever the write does to the flag: opposite swaps never wait on each
 * other half-way. Re-taking it in the same transaction is free.
 */
export async function lockOnlyOne(orgId: number, areas: readonly (AreaLike & { scope?: string })[]): Promise<void> {
  // mold_v0-337: and an area with a one-per-parent rule (src/record-unique.ts).
  const one = (a: AreaLike & { scope?: string; on_save?: readonly unknown[] }) => onlyOneOf(a).length > 0 || (a.on_save ?? []).some((r) => !!r && typeof r === "object" && "unique" in r);
  const mine = [...new Map(areas.filter((a) => a.scope === "workspace" && one(a)).map((a) => [`${a.pack}/${a.name}`, a])).values()]
    .sort((x, y) => `${x.pack}/${x.name}`.localeCompare(`${y.pack}/${y.name}`));
  if (!mine.length) return;
  const ra = await import("./record-areas.js");
  if (!ra.inRecordBatch()) return;
  const { withTenant } = await import("./tenant-scope.js");
  for (const a of mine) await withTenant(orgId, async () => (await ra.recordQuery()).query("SELECT pg_advisory_xact_lock(hashtext($1))", [`only-one/${orgId}/${a.pack}/${a.name}`]));
}
/** A deadlock the database broke (40P01) said as a plain refusal to try again. */
export function deadlockWords(e: unknown): never {
  if ((e as { code?: unknown })?.code === "40P01") throw new PackError("Another change to these records was saved at the same moment: try again", 409);
  throw e;
}

/** A move (src/record-areas.ts moveWorkspaceNow): the lifecycle's field changed alone; its health reset when the test reads it. */
export function healthMove(area: AreaLike, prev: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const h = healthOf(area);
  if (!h || !h.reads.some((f) => !same(prev[f], after[f]))) return after;
  const d = h.decl, out = { ...after };
  for (const k of [d.tested, d.tested_at, d.result, d.failing_since, d.failures]) if (k) delete out[k];
  if (d.status) { const v = outcomeValue(h.status, "untested", d.outcomes); if (v !== null) out[d.status] = v; else delete out[d.status]; }
  return out;
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

/**
 * The keys of the workspace's records with a one-only flag on beside another (of the same `where`), as the reader sees
 * them (the visibility in scope): a reader who cannot see the other marked record is not told it exists.
 */
async function duplicates(orgId: number, area: AreaLike): Promise<Set<string>> {
  const out = new Set<string>();
  const list = onlyOneOf(area);
  if (!list.length) return out;
  const ra = await import("./record-areas.js");
  const { withTenant } = await import("./tenant-scope.js");
  for (const o of list) {
    const rows = await withTenant(orgId, async () => (await ra.recordQuery()).query<{ key: string; data: Record<string, unknown> | string }>(
      "SELECT key, data FROM workspace_records WHERE org_id = $1 AND pack = $2 AND area = $3 AND data -> $4 = 'true'::jsonb",
      [orgId, area.pack, area.name, o.use]));
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
    if (!area || area.scope !== "workspace" || isSealedArea(area) || area.chain === true || !area.fields.some((f) => f.name === field && f.type === "date" && f.set_by === "action")) return;
    // Still an entry's declared last_used of this area (a frozen session's field name never writes another field).
    const declared = packs().some((p) => p.id === area.pack && ((p.definition.agentProfiles ?? []) as { connection_env?: unknown[] }[]).some((prof) => (prof.connection_env ?? []).some((raw) => {
      const c = ConnectionEnvSchema.safeParse(raw); return c.success && c.data.area === area.name && c.data.last_used === field; })));
    if (!declared) return;
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
