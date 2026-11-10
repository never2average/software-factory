// A record's page, laid out as its area declares (mold_v0-253, flag record_pages; the area's `detail`, checked by the
// build: src/pack-api.ts RecordDetailSchema and detailProblems). What the page decides without drawing anything: which
// notices hold, which tab is open, how a fact reads (a date relative with the exact date beside it, a number with its
// unit), a badge's colour classes, which fields no part of the layout names. Pure, so scripts/record-pages-test.ts reads
// it without a browser; ./detail-page.tsx draws it.
import type { RecordAreaSpec, RecordFieldSpec } from '../../config/pack-nav.generated';

/** The theme tokens a badge may take (src/pack-api.ts BADGE_COLORS, the same list). */
export const BADGE_COLORS = ['neutral', 'info', 'success', 'warning', 'danger', 'viz-1', 'viz-2', 'viz-3', 'viz-4', 'viz-5', 'viz-6', 'viz-7', 'viz-8'] as const;
export type BadgeColor = (typeof BADGE_COLORS)[number];
export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';
type Scalar = string | number | boolean;

/** One test (mold_v0-253), or (mold_v0-256) a date against today, a clock's state, all or any of several. */
export interface DetailLeafCondition {
  field?: string; equals?: Scalar; in?: Scalar[]; not_in?: Scalar[]; empty?: boolean;
  before?: 'today'; after?: 'today'; within_days?: number; clock?: string; is?: 'overdue' | 'due_soon';
}
export interface DetailCondition extends DetailLeafCondition { all?: DetailLeafCondition[]; any?: DetailLeafCondition[] }
/** A record's clocks as the page has them (./clocks.tsx ClockView): each one's state. */
export type ClockStates = Record<string, { status?: string; overdue?: boolean }> | null | undefined;
export interface DetailNotice { when: DetailCondition; tone: NoticeTone; title?: string; text: string }
export interface DetailGroup { title?: string; fields: string[] }
export interface DetailSection {
  /** mold_v0-292 (flag nested_runs): the program runs that targeted this record and the versions they made. */
  versions?: Record<string, never>;
  title: string; columns?: 1 | 2 | 3; fields?: string[]; groups?: DetailGroup[]; empty?: string; related?: DetailRelated; runs?: DetailRuns;
  /** mold_v0-256: a field's lines in the log viewer. */
  log?: { field: string; live_when?: DetailCondition };
  /** mold_v0-256: the record's change history. */
  history?: { fields?: string[]; limit?: number };
  /** mold_v0-256: a field as highlighted JSON, YAML or text. */
  code?: { field: string; language?: 'json' | 'yaml' | 'text' };
  /** mold_v0-256: a json list field as a table. */
  table?: { field: string; columns?: string[] };
  /** mold_v0-256: the record's documents and files as a tree with a preview. */
  files?: { fields?: string[] };
  /** mold_v0-262: shown only while this condition holds on the record. */
  when?: DetailCondition;
}
/** A related list (mold_v0-254): another area's records that point back here, through `via`. */
export interface DetailRelated {
  area: string; via?: string; sort?: { field: string; direction?: 'asc' | 'desc' }; limit?: number;
  /** mold_v0-256: a column is a field's name or {field, label} (its own heading). */
  columns?: (string | { field: string; label: string })[];
  /** mold_v0-256: their via holds this record's match_field value (not its key). */
  match_field?: string;
}
/** The record's runs (mold_v0-254). */
export interface DetailRuns { kinds?: string[]; limit?: number }
export type PageActionKind = 'start_run' | 'move' | 'edit' | 'delete' | 'link' | 'copy_link' | 'create_record' | 'start_agent' | 'open_url';
export type PageActionPlace = 'primary' | 'secondary' | 'more';
/** A page action as declared (src/pack-api.ts DetailActionSchema); the server says who may take it, and when (PageAction). */
export interface DetailActionSpec {
  kind: PageActionKind; place?: PageActionPlace; label?: string; job_kind?: string; input?: Record<string, string>; to?: string; field?: string;
  roles?: string[]; unavailable?: { when: DetailCondition; reason: string }[]; confirm?: string;
  /** mold_v0-256: a create_record action's area. */
  area?: string;
  /** mold_v0-256: a start_run on the record a link field names. */
  target?: { via: string };
  /** mold_v0-261: a start_agent action's agent profile and first message (a template filled from the record). */
  profile?: string; first_message?: string;
}
export interface DetailTab { label: string; sections: DetailSection[] }
/** A fact computed from related records (mold_v0-256): the server evaluates it as the person reading. */
export interface DetailComputed { area: string; via?: string; op: 'count' | 'latest'; field?: string; sort?: { field: string; direction?: 'asc' | 'desc' }; where?: DetailCondition }
export interface DetailFact { field?: string; label?: string; unit?: string; computed?: DetailComputed }
export interface DetailBadge { field: string; colors?: Record<string, BadgeColor> }
/** An area's page layout as the build passes it on (pack.json record_areas[].detail). */
export interface DetailLayout {
  header?: { title?: string; subtitle?: string; badges?: DetailBadge[]; creator?: boolean; facts?: DetailFact[] };
  notices?: DetailNotice[];
  tabs: DetailTab[];
  unplaced?: 'show' | 'hide';
  actions?: DetailActionSpec[];
  /** mold_v0-262: false hides the automatic Linked records card. */
  linked?: boolean;
}
/** The console's area spec with its layout (the generated type names `detail` only in a build with record_pages on). */
export type LaidOutArea = RecordAreaSpec & { detail?: DetailLayout };
export type LaidOutField = RecordFieldSpec & { copyable?: boolean };

/** The area's layout, when it has one (the caller asks the flag: features.ts featureOn('record_pages')). */
export const layoutOf = (area: RecordAreaSpec): DetailLayout | null => (area as LaidOutArea).detail ?? null;

/** A value with nothing in it: null, '', an empty list or an empty object. */
export const isEmptyValue = (v: unknown) =>
  v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

const same = (a: unknown, b: Scalar) => a === b || (typeof a !== 'object' && a != null && String(a) === String(b));
/**
 * Whether a condition holds on the record (the server's src/pack-api.ts conditionHolds is the same): a list field by any
 * of its values; mold_v0-256: a date by its UTC day against today's (before, after, within N days), a clock's state
 * (overdue, due soon), all or any of several tests.
 */
export function conditionHolds(when: DetailCondition, data: Record<string, unknown>, clocks: ClockStates = null, now = Date.now()): boolean {
  if (when.all) return when.all.every((c) => conditionHolds(c, data, clocks, now));
  if (when.any) return when.any.some((c) => conditionHolds(c, data, clocks, now));
  if (when.clock) { const c = clocks?.[when.clock]; return !!c && (when.is === 'overdue' ? c.status === 'overdue' || c.overdue === true : c.status === 'due_soon'); }
  const v = when.field ? data[when.field] : undefined;
  const values = Array.isArray(v) ? v : [v];
  if (when.empty !== undefined) return isEmptyValue(v) === when.empty;
  if (when.equals !== undefined) return values.some((x) => same(x, when.equals!));
  if (when.in) return values.some((x) => when.in!.some((y) => same(x, y)));
  if (when.not_in) return !isEmptyValue(v) && !values.some((x) => when.not_in!.some((y) => same(x, y)));
  if (when.before || when.after || when.within_days !== undefined) {
    const t = asTime(v);
    if (t == null) return false;
    const day = Math.floor(t / DAY), today = Math.floor(now / DAY);
    return when.before ? day < today : when.after ? day > today : day >= today && day <= today + when.within_days!;
  }
  return false;
}
/** The notices to show, in their declared order. */
export const shownNotices = (layout: DetailLayout, data: Record<string, unknown>, clocks: ClockStates = null) => (layout.notices ?? []).filter((n) => conditionHolds(n.when, data, clocks));

/** A tab's address (?tab=<id>): the same as the build's (src/pack-api.ts detailTabId). */
export const tabId = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tab';
/** The open tab: the one the address names, else the first. */
export const openTab = (layout: DetailLayout, asked: string | null | undefined) => layout.tabs.find((t) => tabId(t.label) === asked) ?? layout.tabs[0]!;

/** A section's field groups (its `fields` are one group with no heading). */
export const sectionGroups = (s: DetailSection): DetailGroup[] => s.groups ?? [{ fields: s.fields ?? [] }];
/** Every field a section shows. */
export const sectionFields = (s: DetailSection) => sectionGroups(s).flatMap((g) => g.fields);
/** Whether a section has nothing to show on this record: every field it names is empty (then it shows its empty state). */
export const sectionEmpty = (s: DetailSection, data: Record<string, unknown>) => sectionFields(s).every((n) => isEmptyValue(data[n]));
/** The grid classes of a section's columns: one on a phone, up to its count on wider screens. */
export const columnsClass = (n: 1 | 2 | 3 | undefined) => (n === 1 ? 'grid-cols-1' : n === 3 ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2');

/** The fields no part of the layout names (header, facts, sections): the "Other details" section, unless hidden. */
export function unplacedFields(area: RecordAreaSpec, layout: DetailLayout): RecordFieldSpec[] {
  if (layout.unplaced === 'hide') return [];
  const h = layout.header ?? {};
  const placed = new Set([h.title, h.subtitle, ...(h.badges ?? []).map((b) => b.field), ...(h.facts ?? []).map((f) => f.field),
    ...layout.tabs.flatMap((t) => t.sections.flatMap((s) => [...sectionFields(s), s.log?.field, s.code?.field, s.table?.field, ...(s.files?.fields ?? [])]))].filter(Boolean) as string[]);
  // mold_v0-256: a file browser with no fields of its own lists every file and document field.
  const allFiles = layout.tabs.some((t) => t.sections.some((s) => s.files && !s.files.fields?.length));
  return area.fields.filter((f) => !placed.has(f.name) && !(allFiles && (f.type === 'file' || f.preview === 'document')));
}

// ---------------------------------------------------------------- values

const DAY = 86_400_000;
/** A date field's value as a day (YYYY-MM-DD, read as UTC midnight) or a time; null when it is not a date. */
function asTime(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = typeof v === 'number' ? v : /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/**
 * A date relative to now ("today", "yesterday", "in 3 days", "2 months ago") and exactly ("6 Nov 2026"; a time also
 * "6 Nov 2026, 14:05 UTC"). A day is compared by calendar day in UTC, as the record stores it.
 */
export function dateWords(v: unknown, now = Date.now()): { relative: string; absolute: string; iso: string } | null {
  const t = asTime(v);
  if (t == null) return null;
  const dayOnly = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(t);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const absolute = dayOnly ? day : `${day}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  const days = Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Math.floor(now / DAY) * DAY) / DAY);
  let relative: string;
  if (!dayOnly && Math.abs(now - t) < DAY && days === 0) {
    const mins = Math.round((t - now) / 60_000);
    relative = Math.abs(mins) < 1 ? 'just now' : Math.abs(mins) < 60 ? (mins > 0 ? `in ${plural(mins, 'minute')}` : `${plural(-mins, 'minute')} ago`)
      : mins > 0 ? `in ${plural(Math.round(mins / 60), 'hour')}` : `${plural(Math.round(-mins / 60), 'hour')} ago`;
  } else if (days === 0) relative = 'today';
  else if (days === 1) relative = 'tomorrow';
  else if (days === -1) relative = 'yesterday';
  else {
    const n = Math.abs(days);
    const span = n < 14 ? plural(n, 'day') : n < 60 ? plural(Math.round(n / 7), 'week') : n < 730 ? plural(Math.round(n / 30.44), 'month') : plural(Math.round(n / 365.25), 'year');
    relative = days > 0 ? `in ${span}` : `${span} ago`;
  }
  return { relative, absolute, iso: dayOnly ? (v as string) : d.toISOString() };
}

/** The units of time a number may carry (mold_v0-256): such a number reads as a duration ("21m 52s"), not a count. */
const TIME_UNITS: Record<string, number> = { ms: 0.001, s: 1, sec: 1, secs: 1, second: 1, seconds: 1, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600 };
/** Whether a unit is one of time (its number reads as a duration). */
export const isTimeUnit = (unit?: string) => !!unit && unit.trim().toLowerCase() in TIME_UNITS;
/** A duration in seconds in words: "45s", "21m 52s", "3h 4m", "2d 5h" (under a second: "0.4s"). */
export function durationWords(seconds: number): string {
  const s = Math.abs(seconds), sign = seconds < 0 ? '-' : '';
  if (s < 1) return `${sign}${Math.round(s * 10) / 10}s`;
  const t = Math.round(s);
  if (t < 60) return `${sign}${t}s`;
  if (t < 3600) return `${sign}${Math.floor(t / 60)}m ${t % 60}s`;
  if (t < 86400) return `${sign}${Math.floor(t / 3600)}h ${Math.floor((t % 3600) / 60)}m`;
  return `${sign}${Math.floor(t / 86400)}d ${Math.floor((t % 86400) / 3600)}h`;
}
/**
 * A number with its unit: grouped digits, a unit after a space ("%" and "×" close up); a unit of time (s, min, h, ms)
 * as a duration in words (mold_v0-256: "21m 52s", never 1312).
 */
export function numberWords(v: unknown, unit?: string): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return v == null ? '' : String(v);
  if (unit && isTimeUnit(unit)) return durationWords(n * TIME_UNITS[unit.trim().toLowerCase()]!);
  const text = n.toLocaleString('en', { maximumFractionDigits: 2 });
  if (!unit) return text;
  return /^[%×‰°]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

/** An enum value's label (its option's label, else the value). */
export const optionWords = (f: RecordFieldSpec | undefined, v: unknown) => {
  const o = f?.options?.find((x) => (typeof x === 'string' ? x : x.value) === v);
  return o && typeof o !== 'string' ? o.label ?? o.value : String(v);
};
/** The colour of an enum value's badge: the layout's badge for that field, else neutral. */
export const badgeColor = (layout: DetailLayout | null, field: string, v: unknown): BadgeColor =>
  layout?.header?.badges?.find((b) => b.field === field)?.colors?.[String(v)] ?? 'neutral';

/**
 * Each token's chip: a tint of the colour, its text mixed toward the foreground so it reads in light and dark alike
 * (the tones as the console's status badges, features/admin/ui.tsx StatusBadge; the chart colours from --viz-N). Written
 * out whole so the stylesheet keeps every class.
 */
export const BADGE_CLASS: Record<BadgeColor, string> = {
  neutral: 'bg-muted/60 text-muted-foreground ring-border',
  info: 'bg-primary/10 text-primary ring-primary/25',
  success: 'bg-emerald-500/10 text-emerald-700 ring-emerald-600/20 dark:text-emerald-400 dark:ring-emerald-400/25',
  warning: 'bg-amber-500/10 text-amber-800 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-400/25',
  danger: 'bg-destructive/10 text-destructive ring-destructive/25',
  'viz-1': 'bg-[color:color-mix(in_oklab,var(--viz-1)_14%,transparent)] text-[color:color-mix(in_oklab,var(--viz-1)_62%,var(--foreground))] ring-[color:color-mix(in_oklab,var(--viz-1)_35%,transparent)]',
  'viz-2': 'bg-[color:color-mix(in_oklab,var(--viz-2)_14%,transparent)] text-[color:color-mix(in_oklab,var(--viz-2)_62%,var(--foreground))] ring-[color:color-mix(in_oklab,var(--viz-2)_35%,transparent)]',
  'viz-3': 'bg-[color:color-mix(in_oklab,var(--viz-3)_14%,transparent)] text-[color:color-mix(in_oklab,var(--viz-3)_62%,var(--foreground))] ring-[color:color-mix(in_oklab,var(--viz-3)_35%,transparent)]',
  'viz-4': 'bg-[color:color-mix(in_oklab,var(--viz-4)_14%,transparent)] text-[color:color-mix(in_oklab,var(--viz-4)_62%,var(--foreground))] ring-[color:color-mix(in_oklab,var(--viz-4)_35%,transparent)]',
  'viz-5': 'bg-[color:color-mix(in_oklab,var(--viz-5)_14%,transparent)] text-[color:color-mix(in_oklab,var(--viz-5)_62%,var(--foreground))] ring-[color:color-mix(in_oklab,var(--viz-5)_35%,transparent)]',
  'viz-6': 'bg-[color:color-mix(in_oklab,var(--viz-6)_14%,transparent)] text-[color:color-mix(in_oklab,var(--viz-6)_62%,var(--foreground))] ring-[color:color-mix(in_oklab,var(--viz-6)_35%,transparent)]',
  'viz-7': 'bg-[color:color-mix(in_oklab,var(--viz-7)_14%,transparent)] text-[color:color-mix(in_oklab,var(--viz-7)_62%,var(--foreground))] ring-[color:color-mix(in_oklab,var(--viz-7)_35%,transparent)]',
  'viz-8': 'bg-[color:color-mix(in_oklab,var(--viz-8)_14%,transparent)] text-[color:color-mix(in_oklab,var(--viz-8)_62%,var(--foreground))] ring-[color:color-mix(in_oklab,var(--viz-8)_35%,transparent)]'
};
/** A notice's banner: its edge and icon in the tone, its words in the foreground (legible in both themes). */
export const NOTICE_CLASS: Record<NoticeTone, string> = {
  info: 'border-primary/40 bg-primary/5 *:[svg]:text-primary',
  warning: 'border-amber-500/50 bg-amber-500/5 *:[svg]:text-amber-600 dark:*:[svg]:text-amber-400',
  danger: 'border-destructive/60 bg-destructive/5 *:[svg]:text-destructive',
  // mold_v0-256: a success notice, green (the console's status green, legible in both themes).
  success: 'border-emerald-600/45 bg-emerald-500/5 *:[svg]:text-emerald-600 dark:border-emerald-400/40 dark:*:[svg]:text-emerald-400'
};

/** A value as one line to copy: a list joined with ", ", an enum's stored value, a number as written. */
export const copyText = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).join(', ') : v == null ? '' : String(v));

// ---------------------------------------------------------------- part 2 (mold_v0-254): related lists, runs, actions

/** A field of a form as the server sends it (src/tab-actions.ts FormField). */
export interface PageFormField {
  name: string; label: string; type: string; help: string | null; required: boolean; options: { value: string; label: string }[] | null;
  multiple: boolean; min: number | null; max: number | null; max_length: number | null; to: string | null; preview?: 'document';
}
/** A page action as this person may take it on this record (src/record-page-routes.ts ActionView). */
export interface PageAction {
  id: string; kind: PageActionKind; place: PageActionPlace; label: string;
  /** Why it cannot be taken now (on hover and focus), or null. */
  disabled: string | null;
  confirm: string | null;
  run?: { kind: string; label: string; description: string | null; args: PageFormField[]; values: Record<string, unknown>; environments: string[] | null;
    /** mold_v0-260 (flag record_run_inputs): the arguments the kind takes from the record (shown, never sent). */
    from_record?: string[];
    /** mold_v0-256: the linked record it runs on. */
    target?: { area: string; key: string; title: string | null } | null };
  moves?: { to: string; label: string; disabled: string | null }[];
  fields?: PageFormField[];
  target?: { area: string; key: string } | null;
  /** create_record (mold_v0-256): the area, its fields filled from this record, its form (on the record's own page). */
  create?: { area: string; label: string; values: Record<string, unknown>; fields?: PageFormField[]; upload_max?: number | null; key_from_title?: boolean };
  /** start_agent (mold_v0-261, flag agent_harness): the profile it starts, and the first message filled from this record. */
  agent?: { profile: string; name: string; version: number; message: string };
  /** open_url (mold_v0-262): the web address it opens in a new tab. */
  url?: string | null;
}
/** A related list's rows (GET /api/records/_page/<area>/<key>), or hidden: a role that may not read its area. */
export type RelatedData = { hidden: true } | { hidden?: false; area: string; via: string; more: boolean;
  /** mold_v0-256: the value matched (this record's key, or its match_field's value); null: nothing to match. */
  match?: string | null;
  records: { key: string; title: string | null; data: Record<string, unknown>; updated_at: string; actions: PageAction[]; ref_titles?: Record<string, Record<string, string>> }[] };
/** A record's runs: the newest, and how many in all. */
export interface RecordRun { id: string; pack: string; kind: string; status: string; error: string | null; cost_usd: number; created_at: string; started_at: string | null; ended_at: string | null; by: string }
export type RunsData = { total: number; runs: RecordRun[];
  /** mold_v0-261 (flag agent_harness): the workspace agent sessions started from the record. */
  sessions?: { total: number; rows: { id: string; title: string; phase: string; profile: { id: string; name: string; version: number } | null; started_by: string | null;
    spent_usd: number; budget_usd: number; created_at: string; last_activity_at: string }[] } };
export interface PageData { actions: PageAction[]; sections: Record<string, RelatedData | RunsData | HistoryData | undefined>;
  /** mold_v0-256: the header's computed facts, by their place among the facts. */
  facts?: Record<string, ComputedFact> }

/** A section's key in the page's data: its tab's and its own place. */
export const sectionKey = (tab: number, section: number) => `${tab}-${section}`;
/** The header's actions by place: the primary (one at most), the secondary buttons, the rest for More (declared order). */
export function placed(actions: readonly PageAction[]): { primary: PageAction | null; secondary: PageAction[]; more: PageAction[] } {
  const primary = actions.find((a) => a.place === 'primary') ?? null;
  return { primary, secondary: actions.filter((a) => a.place === 'secondary'), more: actions.filter((a) => a.place === 'more' || (a.place === 'primary' && a !== primary)) };
}
/** Whether the page draws its own actions: the area declares some (else Copy ID and Copy link, as part 1). */
export const declaresActions = (layout: DetailLayout) => (layout.actions?.length ?? 0) > 0;
/** Whether the copy-link action is among the declared (then More does not add its own). */
export const declaresCopyLink = (layout: DetailLayout) => (layout.actions ?? []).some((a) => a.kind === 'copy_link');
/** A related list's columns: its own, else the target area's list columns (at most 8). */
export const relatedColumns = (target: RecordAreaSpec, related: DetailRelated): { field: string; label: string | null }[] =>
  (related.columns ?? target.list_columns).map((c) => (typeof c === 'string' ? { field: c, label: null } : { field: c.field, label: c.label }))
    .filter((c) => target.fields.some((f) => f.name === c.field)).slice(0, 8);

/** The address param of a list narrowed to the records pointing at one (Show all): `?linked=<field>:<key>`. */
export const LINKED_PARAM = 'linked';
export const showAllHref = (base: 'app' | 'admin', area: string, via: string, key: string) => `/${base}/records/${area}?${LINKED_PARAM}=${encodeURIComponent(`${via}:${key}`)}`;
/** `?linked=` read back: the field and the key, when the field is one of the area's. */
export function parseLinked(v: string | null | undefined, area: Pick<RecordAreaSpec, 'fields'>): { field: string; key: string } | null {
  if (!v) return null;
  const i = v.indexOf(':');
  if (i < 1) return null;
  const field = v.slice(0, i), key = v.slice(i + 1);
  return key && area.fields.some((f) => f.name === field) ? { field, key } : null;
}

/** A run's state as a badge's colour (the console's status tones). */
export const RUN_STATUS_COLOR: Record<string, BadgeColor> = { queued: 'neutral', running: 'info', succeeded: 'success', failed: 'danger', cancelled: 'warning' };

/**
 * A number column's unit in a related list (mold_v0-256): the unit its own area's page gives the field (a fact's unit),
 * so a duration in seconds reads "21m 52s" and a coverage "87.4%", as on that record's page.
 */
export const columnUnit = (target: RecordAreaSpec, field: string) => ((target as LaidOutArea).detail?.header?.facts ?? []).find((f) => f.field === field)?.unit;

/**
 * A link's address cut where it may wrap (mold_v0-256): after each "/" (and "?", "&", "="), never inside a word. Each
 * piece is drawn whole, a piece longer than its box truncated with the whole address on hover.
 */
export function linkPieces(address: string): string[] {
  const out: string[] = [];
  const m = /^([a-z][a-z0-9+.-]*:\/\/)?(.*)$/i.exec(address)!;
  let rest = m[2] ?? '';
  let first = m[1] ?? '';
  for (const piece of rest.split(/(?<=[/?&=])/)) { out.push(first + piece); first = ''; }
  if (first) out.push(first);
  return out.filter(Boolean);
}

// ---------------------------------------------------------------- part 3 (mold_v0-256): logs, history, code, files, computed facts

/** Whether a layout reads a section kind that needs the page's own route (history, computed facts). */
export const readsHistory = (layout: DetailLayout) => layout.tabs.some((t) => t.sections.some((s) => !!s.history));
export const readsComputed = (layout: DetailLayout) => (layout.header?.facts ?? []).some((f) => !!f.computed);
/** A computed fact's value as the server answers it: a count, the latest record's value (and that record), or hidden. */
export type ComputedFact = { hidden: true } | { hidden?: false; op: 'count'; value: number; capped: boolean; area: string; via?: string }
  | { hidden?: false; op: 'latest'; value: unknown; area: string; field: string; record: { key: string; title: string | null } | null };
/** One field's change: before and after (an encrypted field: neither, only that it changed). */
export interface FieldChange { field: string; label?: string; before?: unknown; after?: unknown; redacted?: boolean }
/** One change of a record (src/record-history.ts): what, who, when, each field's before and after. */
export interface RecordChangeView { id: number; at: string; action: 'created' | 'updated' | 'moved' | 'deleted'; by: string; title: { before: string | null; after: string | null } | null; changes: FieldChange[] }
export type HistoryData = { changes: RecordChangeView[]; more: boolean; since: string | null };
/** A computed fact's value in words: a count grouped ("1,000+" when it stopped counting), a latest value as its field reads. */
export const countWords = (n: number, capped: boolean, unit?: string) => `${n.toLocaleString('en')}${capped ? '+' : ''}${unit ? ` ${unit}` : ''}`;
/** The words of a change's action. */
export const CHANGE_WORDS: Record<RecordChangeView['action'], string> = { created: 'Added', updated: 'Changed', moved: 'Moved', deleted: 'Deleted' };
/** Whether a log section follows its record (reads it again every few seconds) now: its live_when holds. */
export const logLive = (s: DetailSection, data: Record<string, unknown>, clocks: ClockStates = null) => !!s.log?.live_when && conditionHolds(s.log.live_when, data, clocks);
/** How often a live log section reads its record again. */
export const LOG_POLL_MS = 4000;

/**
 * Where a create_record action (mold_v0-256) opens away from its record's page (a row's menu, an open row): that area's
 * list with its Add form open and the fields filled in (?new=1&<field>=<value>; a list field's values comma-separated).
 */
export function createHref(a: Pick<PageAction, 'create'>): string | null {
  if (!a.create) return null;
  const q = new URLSearchParams({ new: '1' });
  for (const [k, v] of Object.entries(a.create.values)) q.set(k, Array.isArray(v) ? v.join(',') : String(v));
  return `/app/records/${encodeURIComponent(a.create.area)}?${q.toString()}`;
}
/** Whether a layout declares Add <related record> actions (the list's open row offers them: ./row-create.tsx). */
export const declaresCreate = (layout: DetailLayout | null) => (layout?.actions ?? []).some((a) => a.kind === 'create_record');

/** Whether a section is drawn on this record (mold_v0-262: its `when` holds, or it has none). */
export const sectionShown = (s: DetailSection, data: Record<string, unknown>, clocks: ClockStates = null) => !s.when || conditionHolds(s.when, data, clocks);
/**
 * The link and reference fields the Linked records card lists (mold_v0-262): none when the layout says `linked: false`;
 * else those the page does not show already (placed as a fact, or as a field of a section of any tab).
 */
export function linkedShown(layout: DetailLayout, fields: string[]): string[] {
  if (layout.linked === false) return [];
  const placed = new Set<string>([...(layout.header?.facts ?? []).map((f) => f.field).filter((x): x is string => !!x),
    ...layout.tabs.flatMap((t) => t.sections.flatMap((s) => [...(s.fields ?? []), ...(s.groups ?? []).flatMap((g) => g.fields)]))]);
  return fields.filter((f) => !placed.has(f));
}
