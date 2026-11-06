// The event/log viewer's lines (mold_v0-256, flag record_pages; ./log-viewer.tsx draws them): a record's log field (a
// text field's lines, or a json field's list of {at, level, source, message} entries) and a run's events (its timeline:
// src/run-page.ts gives each event its level, source and words) as one list of lines, each with its number, time, level,
// source and text; what the filters keep and what search finds; the text a download or a copy takes. Pure, so
// scripts/record-pages-test.ts reads it without a browser. Relative imports only.

export const LOG_LEVELS = ['error', 'warning', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LEVEL_WORDS: Record<LogLevel, string> = { error: 'Error', warning: 'Warning', info: 'Info', debug: 'Debug' };

/** One line of the viewer: its number (1-based, as written), its time (ISO) when it has one, level, source and text. */
export interface LogLine { n: number; at: string | null; level: LogLevel; source: string | null; text: string; id?: string | number }

const TIME = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+/;
const SOURCE = /^\[([A-Za-z0-9_.:/@-]{1,40})\]\s*/;
const LEVEL_WORD = /^(?:(ERROR|ERR|FATAL|CRITICAL|PANIC)|(WARN|WARNING)|(INFO|NOTICE)|(DEBUG|TRACE))(?::|\s|\]|$)\s*/i;

/** A line's level from its words: a leading level word wins, else what it says (failed, error, warning, ...). */
export function levelOf(text: string): LogLevel {
  const m = LEVEL_WORD.exec(text.replace(/^\[/, ''));
  if (m) return m[1] ? 'error' : m[2] ? 'warning' : m[3] ? 'info' : 'debug';
  if (/\b(error|errors|fatal|exception|traceback|panic|FAIL|failed|failure|refused|denied)\b/.test(text)) return 'error';
  if (/\b(warn|warning|deprecated|retry|retrying|skipped|timeout|timed out)\b/i.test(text)) return 'warning';
  if (/^\s*(debug|trace)\b/i.test(text)) return 'debug';
  return 'info';
}
const asLevel = (v: unknown): LogLevel | null => {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return s === 'warn' ? 'warning' : s === 'err' || s === 'fatal' || s === 'critical' ? 'error' : s === 'trace' ? 'debug' : (LOG_LEVELS as readonly string[]).includes(s) ? (s as LogLevel) : null;
};

/** A text log's line: its time, then [source], then the level read from what is left. */
export function parseLine(raw: string, n: number): LogLine {
  let text = raw.replace(/\r$/, '');
  let at: string | null = null, source: string | null = null;
  const t = TIME.exec(text);
  if (t) { at = t[1]!.replace(' ', 'T'); text = text.slice(t[0].length); }
  const s = SOURCE.exec(text);
  if (s && !LEVEL_WORD.test(`${s[1]}:`)) { source = s[1]!; text = text.slice(s[0].length); }
  return { n, at, level: levelOf(text), source, text };
}

/**
 * A record's log field as lines: a text field split on its line breaks (a last empty line dropped), a json field's list
 * of entries ({at|time|timestamp, level, source, message|text|msg}; a plain string an entry of its own).
 */
export function linesOf(v: unknown): LogLine[] {
  if (v == null || v === '') return [];
  if (typeof v === 'string') {
    const raw = v.split('\n');
    if (raw.length && raw[raw.length - 1] === '') raw.pop();
    return raw.map((l, i) => parseLine(l, i + 1));
  }
  if (Array.isArray(v)) return v.map((e, i) => {
    if (typeof e === 'string') return parseLine(e, i + 1);
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const text = String(o.message ?? o.text ?? o.msg ?? o.line ?? JSON.stringify(o));
    const at = [o.at, o.time, o.timestamp].find((x) => typeof x === 'string') as string | undefined;
    return { n: i + 1, at: at ?? null, level: asLevel(o.level) ?? levelOf(text), source: typeof o.source === 'string' ? o.source : null, text };
  });
  return linesOf(JSON.stringify(v, null, 2));
}

/** The sources lines name, in the order they first show, with how many lines each. */
export function sourcesOf(lines: readonly LogLine[]): { source: string; n: number }[] {
  const m = new Map<string, number>();
  for (const l of lines) if (l.source) m.set(l.source, (m.get(l.source) ?? 0) + 1);
  return [...m].map(([source, n]) => ({ source, n }));
}
/** How many lines of each level. */
export const levelCounts = (lines: readonly LogLine[]) => {
  const c: Record<LogLevel, number> = { error: 0, warning: 0, info: 0, debug: 0 };
  for (const l of lines) c[l.level]++;
  return c;
};

export interface LogFilter { levels: readonly LogLevel[]; source: string | null; search: string }
export const ALL_LEVELS: LogFilter = { levels: LOG_LEVELS, source: null, search: '' };
/** The lines the filters keep, in order (search: every word, any case, in its text or source). */
export function filterLines(lines: readonly LogLine[], f: LogFilter): LogLine[] {
  const words = f.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return lines.filter((l) => f.levels.includes(l.level) && (!f.source || l.source === f.source)
    && words.every((w) => l.text.toLowerCase().includes(w) || (l.source ?? '').toLowerCase().includes(w)));
}
/** Where search's words are in a line's text, as [start, end) ranges, merged and in order (the highlight). */
export function matchRanges(text: string, search: string): [number, number][] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const low = text.toLowerCase(), out: [number, number][] = [];
  for (const w of words) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) out.push([i, i + w.length]);
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of out) { const last = merged[merged.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
  return merged;
}

/** A line as one line of text to copy or download: its time, level, [source] and text. */
export const lineText = (l: LogLine) => [l.at, l.level === 'info' ? null : l.level.toUpperCase(), l.source ? `[${l.source}]` : null, l.text].filter(Boolean).join(' ');
/** The whole download: one line per line kept, ending with a line break. */
export const logText = (lines: readonly LogLine[]) => (lines.length ? `${lines.map(lineText).join('\n')}\n` : '');
/** A download's file name: the words given, lowercased and joined, .log. */
export const logFileName = (...parts: (string | null | undefined)[]) =>
  `${parts.filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'log'}.log`;

/**
 * The rows the window shows (virtualised): the first and last index within [top - overscan, top + height + overscan],
 * by each row's height (`heights`, measured or estimated) and its offset (`offsets`, their running sum).
 */
export function visibleRange(offsets: readonly number[], heights: readonly number[], top: number, height: number, overscan = 400): [number, number] {
  const n = heights.length;
  if (!n) return [0, -1];
  const lo = Math.max(0, top - overscan), hi = top + height + overscan;
  let a = 0, b = n - 1;
  while (a < b) { const m = (a + b) >> 1; if (offsets[m]! + heights[m]! <= lo) a = m + 1; else b = m; }
  let end = a;
  while (end < n - 1 && offsets[end + 1]! < hi) end++;
  return [a, end];
}
/** Running offsets of rows of the given heights. */
export function offsetsOf(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length);
  let y = 0;
  for (let i = 0; i < heights.length; i++) { out[i] = y; y += heights[i]!; }
  return out;
}
/** A row's height before it is measured: one line, or (wrapping) its text's length over the line's width in characters. */
export const estimateHeight = (text: string, wrap: boolean, charsPerLine: number, lineHeight = 20) =>
  !wrap ? lineHeight : Math.max(1, Math.ceil(text.length / Math.max(20, charsPerLine))) * lineHeight;
