// A record's page, laid out as its area declares (mold_v0-253, flag record_pages; the area's `detail`, checked by the
// build: src/pack-api.ts RecordDetailSchema and detailProblems). What the page decides without drawing anything: which
// notices hold, which tab is open, how a fact reads (a date relative with the exact date beside it, a number with its
// unit), a badge's colour classes, which fields no part of the layout names. Pure, so scripts/record-pages-test.ts reads
// it without a browser; ./detail-page.tsx draws it.
import type { RecordAreaSpec, RecordFieldSpec } from '../../config/pack-nav.generated';

/** The theme tokens a badge may take (src/pack-api.ts BADGE_COLORS, the same list). */
export const BADGE_COLORS = ['neutral', 'info', 'success', 'warning', 'danger', 'viz-1', 'viz-2', 'viz-3', 'viz-4', 'viz-5', 'viz-6', 'viz-7', 'viz-8'] as const;
export type BadgeColor = (typeof BADGE_COLORS)[number];
export type NoticeTone = 'info' | 'warning' | 'danger';
type Scalar = string | number | boolean;

export interface DetailCondition { field: string; equals?: Scalar; in?: Scalar[]; not_in?: Scalar[]; empty?: boolean }
export interface DetailNotice { when: DetailCondition; tone: NoticeTone; title?: string; text: string }
export interface DetailGroup { title?: string; fields: string[] }
export interface DetailSection { title: string; columns?: 1 | 2 | 3; fields?: string[]; groups?: DetailGroup[]; empty?: string; related?: DetailRelated; runs?: DetailRuns }
/** A related list (mold_v0-254): another area's records that point back here, through `via`. */
export interface DetailRelated { area: string; via?: string; columns?: string[]; sort?: { field: string; direction?: 'asc' | 'desc' }; limit?: number }
/** The record's runs (mold_v0-254). */
export interface DetailRuns { kinds?: string[]; limit?: number }
export type PageActionKind = 'start_run' | 'move' | 'edit' | 'delete' | 'link' | 'copy_link';
export type PageActionPlace = 'primary' | 'secondary' | 'more';
/** A page action as declared (src/pack-api.ts DetailActionSchema); the server says who may take it, and when (PageAction). */
export interface DetailActionSpec {
  kind: PageActionKind; place?: PageActionPlace; label?: string; job_kind?: string; input?: Record<string, string>; to?: string; field?: string;
  roles?: string[]; unavailable?: { when: DetailCondition; reason: string }[]; confirm?: string;
}
export interface DetailTab { label: string; sections: DetailSection[] }
export interface DetailFact { field: string; label?: string; unit?: string }
export interface DetailBadge { field: string; colors?: Record<string, BadgeColor> }
/** An area's page layout as the build passes it on (pack.json record_areas[].detail). */
export interface DetailLayout {
  header?: { title?: string; subtitle?: string; badges?: DetailBadge[]; creator?: boolean; facts?: DetailFact[] };
  notices?: DetailNotice[];
  tabs: DetailTab[];
  unplaced?: 'show' | 'hide';
  actions?: DetailActionSpec[];
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
/** Whether a notice's condition holds on the record's data (a list field: any of its values). */
export function conditionHolds(when: DetailCondition, data: Record<string, unknown>): boolean {
  const v = data[when.field];
  const values = Array.isArray(v) ? v : [v];
  if (when.empty !== undefined) return isEmptyValue(v) === when.empty;
  if (when.equals !== undefined) return values.some((x) => same(x, when.equals!));
  if (when.in) return values.some((x) => when.in!.some((y) => same(x, y)));
  if (when.not_in) return !isEmptyValue(v) && !values.some((x) => when.not_in!.some((y) => same(x, y)));
  return false;
}
/** The notices to show, in their declared order. */
export const shownNotices = (layout: DetailLayout, data: Record<string, unknown>) => (layout.notices ?? []).filter((n) => conditionHolds(n.when, data));

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
    ...layout.tabs.flatMap((t) => t.sections.flatMap(sectionFields))].filter(Boolean) as string[]);
  return area.fields.filter((f) => !placed.has(f.name));
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

/** A number with its unit: grouped digits, a unit after a space ("%" and "×" close up). */
export function numberWords(v: unknown, unit?: string): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return v == null ? '' : String(v);
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
  danger: 'border-destructive/60 bg-destructive/5 *:[svg]:text-destructive'
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
  run?: { kind: string; label: string; description: string | null; args: PageFormField[]; values: Record<string, unknown>; environments: string[] | null };
  moves?: { to: string; label: string; disabled: string | null }[];
  fields?: PageFormField[];
  target?: { area: string; key: string } | null;
}
/** A related list's rows (GET /api/records/_page/<area>/<key>), or hidden: a role that may not read its area. */
export type RelatedData = { hidden: true } | { hidden?: false; area: string; via: string; more: boolean;
  records: { key: string; title: string | null; data: Record<string, unknown>; updated_at: string; actions: PageAction[] }[] };
/** A record's runs: the newest, and how many in all. */
export interface RecordRun { id: string; pack: string; kind: string; status: string; error: string | null; cost_usd: number; created_at: string; started_at: string | null; ended_at: string | null; by: string }
export type RunsData = { total: number; runs: RecordRun[] };
export interface PageData { actions: PageAction[]; sections: Record<string, RelatedData | RunsData | undefined> }

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
export const relatedColumns = (target: RecordAreaSpec, related: DetailRelated) => (related.columns ?? target.list_columns).filter((c) => target.fields.some((f) => f.name === c)).slice(0, 8);

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
/** The words of a list of runs' count: "1 run", "12 runs", the latest shown of them when not all are. */
export const runsCountWords = (shown: number, total: number) => (total <= shown ? `${total} ${total === 1 ? 'run' : 'runs'}` : `Latest ${shown} of ${total} runs`);
/** A related list's count words: "3 builds", or "Newest 5" when there are more. */
export const relatedCountWords = (n: number, more: boolean, label: string) => (more ? `First ${n} shown` : `${n} ${n === 1 ? singularOf(label).toLowerCase() : label.toLowerCase()}`);
const singularOf = (label: string) =>
  /ies$/i.test(label) ? label.replace(/ies$/i, 'y') : /(ss|us)$/i.test(label) ? label : /(ches|shes|xes|sses)$/i.test(label) ? label.replace(/es$/i, '') : label.replace(/s$/i, '');
