/**
 * A record's change history (mold_v0-256, flag record_pages; sql/migrations/0049_record_changes.sql): each change of a
 * workspace record whose area's page lays out a history section (`detail`, a section with `history`), written in the
 * change's own transaction by the record store's transaction listener (src/record-areas.ts registers writeHistory), and
 * read by the record's page (src/record-page-routes.ts) as the person reading it.
 *
 *   kept      only while the flag is on, only for a workspace area whose layout has a history section: an app that
 *             declares none writes exactly as before (no transaction of its own, no line).
 *   a line    the action (created, updated, moved, deleted), who ("<kind>:<who>" as workspace_records.updated_by), when,
 *             the title before and after when it changed, and each declared field that changed with its value before and
 *             after. A write that changes nothing writes no line.
 *   redacted  an encrypted field (mold_v0-194) is only ever {field, redacted: true}: that it changed, never a value (its
 *             sealed envelope neither). Read back, a field that is encrypted now is redacted in older lines too.
 *
 * The data trail (mold_v0-197, src/audit-trail.ts) stays as it is: it never holds a value; this does, for these areas.
 */
import type { Queryable } from "./db.js";
import { getDb } from "./db.js";
import { featureOn } from "./features.js";
import { HISTORY_LIMIT_MAX, type RecordDetailLayout } from "./pack-api.js";
import type { RecordArea, RecordChange } from "./record-areas.js";
import { withTenant } from "./tenant-scope.js";

const layoutOf = (a: RecordArea): RecordDetailLayout | null => (a as RecordArea & { detail?: RecordDetailLayout }).detail ?? null;
/** Whether a change of `area`'s records is kept: the flag on, a workspace area, a history section on its page. */
export const historyKept = (area: RecordArea | null | undefined): boolean =>
  !!area && area.scope === "workspace" && featureOn("record_pages") && !!layoutOf(area)?.tabs.some((t) => t.sections.some((s) => !!s.history));

/** The largest value a line keeps of a field (as JSON): past it, how long it was. */
const VALUE_MAX = 100_000;
const kept = (v: unknown) => { const j = JSON.stringify(v ?? null); return j.length > VALUE_MAX ? { $truncated: j.length } : v ?? null; };
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && !v.length);

export interface StoredChange { field: string; before?: unknown; after?: unknown; redacted?: true }
/** What changed between two versions of a record's data: each declared field that differs (encrypted: redacted). */
export function fieldChanges(area: Pick<RecordArea, "fields">, before: Record<string, unknown> | null, after: Record<string, unknown> | null): StoredChange[] {
  const out: StoredChange[] = [];
  for (const f of area.fields) {
    const b = before?.[f.name], a = after?.[f.name];
    if (same(b, a) || (empty(b) && empty(a))) continue;
    if (f.encrypted) { out.push({ field: f.name, redacted: true }); continue; }
    out.push({ field: f.name, ...(before ? { before: kept(b) } : {}), ...(after ? { after: kept(a) } : {}) });
  }
  return out;
}

const ACTION: Record<RecordChange["change"], string> = { created: "created", updated: "updated", state_changed: "moved", deleted: "deleted" };
/** Write a change's line on its own transaction `tx` (the record store's listener; nothing when it changed nothing). */
export async function writeHistory(area: RecordArea, c: RecordChange, tx: Queryable): Promise<void> {
  const h = c.history;
  if (!h) return;
  const action = ACTION[c.change];
  const changes = action === "deleted" ? [] : fieldChanges(area, h.before?.data ?? null, h.after?.data ?? null);
  const title = h.before && h.after && (h.before.title ?? null) !== (h.after.title ?? null) ? { before: h.before.title ?? null, after: h.after.title ?? null } : null;
  if (action === "updated" && !changes.length && !title) return;
  await tx.query(
    "INSERT INTO record_changes (org_id, pack, area, key, action, by, title, changes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    [c.orgId, area.pack, area.name, c.key, action, h.by?.slice(0, 200) ?? null, title ? JSON.stringify(title) : null, JSON.stringify(changes)]);
}

/** A line as the page reads it. */
export interface HistoryLine { id: number; at: string; action: "created" | "updated" | "moved" | "deleted"; by: string | null; title: { before: string | null; after: string | null } | null; changes: StoredChange[] }

/**
 * A record's history in workspace `orgId`, newest first: at most `limit` lines (1 to 100) older than `before` (a line's
 * id), each keeping only the changes of `fields` when given (a line left with none is left out), every field that is
 * encrypted now redacted. `more` when there are older ones. Read under the workspace's row-level security.
 */
export async function recordHistory(orgId: number, area: RecordArea, key: string, opts: { limit?: number; before?: number | null; fields?: string[] | null } = {}): Promise<{ lines: HistoryLine[]; more: boolean }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), HISTORY_LIMIT_MAX);
  const enc = new Set(area.fields.filter((f) => f.encrypted).map((f) => f.name));
  const want = opts.fields?.length ? new Set(opts.fields) : null;
  const lines: HistoryLine[] = [];
  let before = opts.before ?? null, more = false;
  // A field filter can leave lines out: read pages of the table until the page is full or the record's lines end.
  for (let pages = 0; pages < 20 && lines.length <= limit; pages++) {
    const rows = await withTenant(orgId, async () => (await getDb()).query<{ id: string | number; at: Date; action: HistoryLine["action"]; by: string | null; title: HistoryLine["title"]; changes: StoredChange[] }>(
      `SELECT id, at, action, by, title, changes FROM record_changes WHERE org_id = $1 AND pack = $2 AND area = $3 AND key = $4 AND ($5::bigint IS NULL OR id < $5)
        ORDER BY id DESC LIMIT ${limit + 1}`, [orgId, area.pack, area.name, key, before]));
    for (const r of rows) {
      const changes = (r.changes ?? []).filter((x) => !want || want.has(x.field)).map((x) => (enc.has(x.field) ? { field: x.field, redacted: true as const } : x));
      if (want && !changes.length && r.action === "updated") continue;
      lines.push({ id: Number(r.id), at: new Date(r.at).toISOString(), action: r.action, by: r.by, title: want ? null : r.title, changes });
    }
    if (rows.length <= limit) break;
    before = Number(rows[rows.length - 1]!.id);
  }
  if (lines.length > limit) { more = true; lines.length = limit; }
  return { lines, more };
}

/** Who made a change, in words: a person (by the caller's lookup), staff, a run, the intake, a data source, the shell. */
export function changedByWords(by: string | null, person: (id: string) => string): string {
  if (!by) return "Someone (not recorded)";
  const i = by.indexOf(":"), kind = i < 0 ? by : by.slice(0, i), who = i < 0 ? "" : by.slice(i + 1);
  switch (kind) {
    case "people": return who ? person(who) : "A person of this workspace";
    case "staff": return "Platform staff";
    case "run": return /^run_[A-Za-z0-9_-]+$/.test(who) ? `Run ${who}` : "The app's own automation";
    case "intake": return "The email intake";
    case "repository": return "Its data source";
    case "shell": return who.startsWith("clock") ? "A deadline clock" : "The app itself";
    default: return "The app itself";
  }
}
