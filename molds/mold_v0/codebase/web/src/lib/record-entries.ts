// A record's log or timeline value as entries (mold_v0-298): a json list of objects, or of JSON lines (each item a
// string holding one object), or a text value with one JSON object per line, read as rows of time, level or status,
// message and source, so a record's page and an open row draw a compact table rather than raw JSON
// (features/records/record-detail-entries.tsx draws it). Which key plays which part is read from the entries' own keys;
// a list whose items have no such keys is not a log and is drawn as before (features/records/json-value.tsx). A list
// only counts as a log when its entries carry a real time (a timestamp, never a step counter) or a log level (error, warn,
// info): milestones with a title and a date, or a checklist with a title and a status, stay readable lines. Pure, with
// no imports but the json words (features/records/json-text.ts), so a script can read it without a browser.

import { jsonLine, keyLabel } from '../features/records/json-text';

export type EntryObject = Record<string, unknown>;
/** The key each part reads from (null: the entries have none). */
export interface EntryColumns { time: string | null; level: string | null; message: string | null; source: string | null }
export interface EntryRow { time: unknown; level: string | null; message: string; source: string | null }
export interface EntriesView { columns: EntryColumns; rows: EntryRow[] }

const isObj = (v: unknown): v is EntryObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The keys that may hold each part, in the order they are preferred. */
const TIME_KEYS = ['at', 'time', 'timestamp', 'ts', 'datetime', 'date', 'created_at', 'createdAt', 'occurred_at', 'occurredAt', 'logged_at', 'loggedAt', 'when'];
const LEVEL_KEYS = ['level', 'severity', 'status', 'state', 'outcome', 'result'];
const MESSAGE_KEYS = ['message', 'msg', 'text', 'line', 'summary', 'event', 'description', 'detail', 'details', 'note', 'title'];
const SOURCE_KEYS = ['source', 'actor', 'by', 'step', 'component', 'service', 'user'];
/** Time keys too common outside a log ("date" of a milestone, "when" of a reminder): a log only with a log's message key. */
const LOOSE_TIME_KEYS = new Set(['date', 'when']);
/** Message keys that say "a log line" on their own (a title or a note does not). */
const LOG_MESSAGE_KEYS = new Set(['message', 'msg', 'text', 'line', 'event']);
/** A log level: what a logger writes, never a task's status. */
const LOG_LEVEL = /^(trace|debug|info|information|notice|warn|warning|error|err|fatal|critical|crit|alert|emerg|emergency|panic)$/i;
/** Keys that are bookkeeping, never shown (as json-text.ts hides them): $schema, _id, schema_version, kind. */
const BOOKKEEPING = new Set(['schemaversion', 'schema_version', 'schema', 'kind', 'apiversion', 'api_version', 'typename']);
const bookkeeping = (k: string) => /^[$@_]/.test(k) || BOOKKEEPING.has(k.toLowerCase());

/** One JSON object from a line of text, or null. */
function objectOf(s: string): EntryObject | null {
  const t = s.trim();
  if (!t.startsWith('{')) return null;
  try { const o = JSON.parse(t) as unknown; return isObj(o) ? o : null; } catch { return null; }
}

/**
 * The value's entries when every item is an object: a list of objects, a list of JSON lines, or a text value whose every
 * non-empty line is one JSON object. Null for anything else (a list of plain words, a single object, mixed items).
 */
export function entryObjects(v: unknown): EntryObject[] | null {
  if (Array.isArray(v)) {
    if (!v.length) return null;
    const out: EntryObject[] = [];
    for (const x of v) {
      const o = isObj(x) ? x : typeof x === 'string' ? objectOf(x) : null;
      if (!o) return null;
      out.push(o);
    }
    return out;
  }
  if (typeof v === 'string' && v.trimStart().startsWith('{')) {
    const lines = v.split('\n').map((l) => l.trim()).filter(Boolean);
    const out = lines.map(objectOf);
    return lines.length && out.every(Boolean) ? (out as EntryObject[]) : null;
  }
  return null;
}

/** Whether a value says something on one line: a word, a number, a yes or no. */
const scalarish = (v: unknown) => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number' || typeof v === 'boolean';
/** The first of the keys that at least half the entries fill with a short value (that `ok` accepts, when given). */
function keyOf(objs: readonly EntryObject[], keys: readonly string[], taken: readonly (string | null)[], ok: (v: unknown) => boolean = scalarish): string | null {
  for (const k of keys) {
    if (taken.includes(k)) continue;
    const n = objs.filter((o) => scalarish(o[k]) && ok(o[k])).length;
    if (n > 0 && n * 2 >= objs.length) return k;
  }
  return null;
}

/** A value on one line: a nested value in words (json-text.ts), never raw JSON (the mold_v0-240 rule). */
const line = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : jsonLine(v));

/**
 * The value as a log or timeline: its entries and which key gives each column, when the entries read as one (a message
 * with a time or a level, or a time with a level); else null and the value is drawn as any json value.
 */
export function entriesView(v: unknown): EntriesView | null {
  const objs = entryObjects(v);
  if (!objs) return null;
  // mold_v0-298: a time column only when its values are real times; a log only with a real time or a log level.
  const time = keyOf(objs, TIME_KEYS, [], (x) => entryTime(x) != null);
  const level = keyOf(objs, LEVEL_KEYS, [time]);
  const message = keyOf(objs, MESSAGE_KEYS, [time, level]);
  const strongTime = !!time && !LOOSE_TIME_KEYS.has(time);
  const logLevel = !!level && objs.filter((o) => typeof o[level] === 'string' && LOG_LEVEL.test((o[level] as string).trim())).length * 2 >= objs.length;
  const logMessage = !!message && LOG_MESSAGE_KEYS.has(message);
  if (!((strongTime && (message || level)) || (time && logMessage) || (logLevel && (message || time)))) return null;
  const source = keyOf(objs, SOURCE_KEYS, [time, level, message]);
  const used = new Set([time, level, message, source].filter(Boolean) as string[]);
  const rows = objs.map((o): EntryRow => {
    // An entry with no message of its own: its other fields in words, bookkeeping left out, so no row reads blank.
    const rest = Object.entries(o).filter(([k, x]) => !used.has(k) && !bookkeeping(k) && x != null && x !== '')
      .map(([k, x]) => [keyLabel(k), line(x)] as const).filter(([, t]) => t !== '').map(([k, t]) => `${k}: ${t}`).join(' · ');
    const msg = message && o[message] != null && o[message] !== '' ? line(o[message]) : rest;
    const lv = level && o[level] != null && o[level] !== '' ? line(o[level]) : null;
    const src = source && o[source] != null && o[source] !== '' ? line(o[source]) : null;
    return { time: time ? o[time] ?? null : null, level: lv, message: msg, source: src };
  });
  return { columns: { time, level, message, source }, rows };
}

/** The tone of a level or status word: a failure red, a warning amber, a success green, work in progress blue. */
export type EntryTone = 'danger' | 'warning' | 'success' | 'info' | 'neutral';
export function entryTone(word: string | null): EntryTone {
  const w = (word ?? '').trim().toLowerCase();
  if (!w) return 'neutral';
  if (/^(error|err|fatal|critical|panic|failed|failure|fail|denied|refused|rejected|blocked|cancelled|canceled|aborted|timed[ _-]?out)$/.test(w)) return 'danger';
  if (/^(warn|warning|retry|retrying|skipped|degraded|paused|on[ _-]?hold|pending[ _-]?review)$/.test(w)) return 'warning';
  if (/^(ok|success|succeeded|passed|pass|done|complete|completed|approved|resolved|healthy|live|ready)$/.test(w)) return 'success';
  if (/^(info|notice|running|started|start|in[ _-]?progress|queued|deploying|building|active)$/.test(w)) return 'info';
  return 'neutral';
}

/** Seconds and milliseconds since 1970 that read as a real time (2001 to 2286), never a step counter. */
const EPOCH_S: readonly [number, number] = [1e9, 1e10];
const EPOCH_MS: readonly [number, number] = [1e12, 1e13];
/**
 * A time value in milliseconds: an ISO-like date or time (with a four-digit year), or a number in a plausible range of
 * seconds or milliseconds since 1970 (mold_v0-298: a small number under a time key is no 1970 date); else null.
 */
export function entryTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (v >= EPOCH_S[0] && v < EPOCH_S[1]) return v * 1000;
    if (v >= EPOCH_MS[0] && v < EPOCH_MS[1]) return v;
    return null;
  }
  if (typeof v === 'string' && /\d{4}/.test(v)) { const t = Date.parse(v.trim()); return Number.isFinite(t) ? t : null; }
  return null;
}

/**
 * The list cell's short line: how many entries, and (only when the entries carry a time, so "latest" means something)
 * the newest one's message. Only what a cell draws: search, filters and CSV read entriesText.
 */
export function entriesLine(view: EntriesView): string {
  const n = view.rows.length;
  const head = `${n} ${n === 1 ? 'entry' : 'entries'}`;
  if (!view.columns.time) return head;
  let last: EntryRow | undefined, at = -Infinity;
  for (const r of view.rows) { const t = entryTime(r.time) ?? -Infinity; if (!last || t >= at) { last = r; at = t; } }
  return last?.message ? `${head} · latest: ${last.message.length > 80 ? `${last.message.slice(0, 79)}…` : last.message}` : head;
}

/** Every entry in words, for search, filters and CSV: time, level, message and source of each, "; "-joined. */
export function entriesText(view: EntriesView): string {
  return view.rows.map((r) => [r.time == null ? '' : line(r.time), r.level ?? '', r.message, r.source ?? ''].filter(Boolean).join(' ')).filter(Boolean).join('; ');
}

/** The raw value, as it is stored, for Show raw: a list or object pretty-printed, JSON lines kept one per line. */
export function entriesRaw(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join('\n');
  return JSON.stringify(v, null, 2);
}
