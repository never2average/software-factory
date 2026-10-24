'use client';
// Platform analytics and health across every account (src/insights.ts). PostHog and New Relic hold the full record;
// this replicates what staff check daily, from the records the app already keeps. Range and filters live in the URL,
// so a filtered view can be shared; both views share the toolbar, the Filters popover and the export.
import { Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { IconFilter } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, XAxis, YAxis } from 'recharts';
import PageContainer from '@/components/layout/page-container';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DateRangePicker, last30, rangeQuery, type DateRange } from '@/components/layout/date-range-picker';
import { TablePager, type Paged } from '@/components/layout/table-pager';
import { StatStrip } from '@/components/layout/section';
import { Box, RankBars, top } from '@/components/layout/chart-grid';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { downloadCsv, downloadJson, type CsvValue } from '@/lib/csv';
import { counted, num, usd } from '@/lib/display-format';
import { cn } from '@/lib/utils';
import { ErrorBox, LoadingCards, Mono, Section, StatusBadge, Trend, When } from './ui';
import { ComputeJobs } from './compute-jobs';
import { UrlTabs } from './compute-common';
import { ComputeSessions } from './compute-sessions';
import { PackRunKinds } from './compute-runs';
import { packRuns, sessionEngine } from './engine';
import { W } from '@/lib/vocabulary';
import { NS } from '@/lib/namespace';

type ErrorKind = 'tool' | 'session' | 'onboarding';
interface ErrorRow { at: string; account: string; slug: string; [k: string]: string | number | null }
interface Facets { users?: { id: string; email: string | null; name: string | null; account: string }[]; accounts: { slug: string; name: string }[]; products: string[]; tools: string[]; clients: string[]; plans: string[]; sub_statuses: string[]; stages: { id: string; label: string }[];
  /** Records per value: tool calls (account, user, tool), connections (client), accounts (product, plan, billing, stage). */
  counts?: Record<string, Record<string, number>> }

interface Analytics {
  range?: { from: string; to: string; days: number };
  days: number;
  links: { posthog: string | null; new_relic: string | null; posthog_events: boolean; tracing: boolean };
  totals: {
    active_accounts: number; active_people: number; calls: number; error_pct: number; p50_ms: number | null; p95_ms: number | null; new_accounts: number;
    change: { active_accounts: number | null; active_people: number | null; calls: number | null };
  };
  daily: { day: string; accounts: number; people: number; calls: number; errors: number; p95_ms?: number | null }[];
  /** The Health figures day by day (sparklines). */
  ops_daily?: OpsDay[];
  new_daily?: { day: string; n: number }[];
  tools: { name: string; accounts: number; people: number; calls: number; error_pct: number; p50_ms: number | null; p95_ms: number | null }[];
  clients: { client: string; accounts: number; people: number; connections: number }[];
  accounts: { slug: string; name: string; products: string | null; calls: number; prev_calls: number; errors: number; people: number; last_seen: string | null; trend: number | null; at_risk: boolean }[];
  accounts_total: number;
  retention: { cohort: string; size: number; weeks: (number | null)[] }[];
  ops: Record<string, number>;
  errors: ErrorRow[];
  errors_total: number;
  filters: Record<string, unknown>;
  facets: Facets;
  growth?: Growth;
}
/** The Growth block (src/insights.ts growth()): weekly series are ISO weeks (Monday, UTC); `partial` when the range ends mid-week. */
interface Growth {
  accounts_daily: { day: string; total: number }[];
  weekly: { week: string; accounts: number; people: number; calls: number; calls_per_person: number | null; change_pct: number | null; partial: boolean }[];
  stickiness: { day: string; dau: number; mau: number; pct: number | null }[];
  client_mix: { clients: string[]; weeks: { week: string; calls: number[] }[] };
  /** The session engine's runs per week, else the packs' runs (mold_v0-104); null when the build has neither. */
  sims_weekly: { week: string; completed: number; other: number }[] | null;
  /** null when the accounts listing could not load */
  funnel: { id: string; label: string; reached: number; pct: number | null }[] | null;
}
interface ErrorPage { rows: ErrorRow[]; total: number; offset: number; limit: number; kind: ErrorKind }

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const ms = (v: number | string | null | undefined) => (v == null ? '—' : `${num(Number(v))} ms`);
const callsConfig = { calls: { label: 'Tool calls', color: 'var(--chart-1)' }, errors: { label: 'Errors', color: 'var(--destructive)' } } satisfies ChartConfig;
const activeConfig = { accounts: { label: 'Accounts', color: 'var(--chart-2)' }, people: { label: 'People', color: 'var(--chart-4)' } } satisfies ChartConfig;

/** Every day of the period, zero-filled, oldest first. */
interface OpsDay {
  day: string; sims: number; sims_completed: number; sessions: number; sessions_failed: number; model_cost_usd: number;
  onboardings: number; onboardings_failed: number; gateway_errors: number; gateway_requests: number; queued: number;
}
/** ops_daily on every day of the range (missing days are 0), with the rates worked out per day. */
function fillOps(a: Analytics) {
  const by = new Map((a.ops_daily ?? []).map((r) => [r.day, r]));
  const rate = (x: number, of: number) => (of ? (x / of) * 100 : 0);
  return fillDays(a.daily, a.days, a.range?.from).map(({ day }) => {
    const r = by.get(day);
    return { sims_completed: r?.sims_completed ?? 0, sessions_failed_pct: rate(r?.sessions_failed ?? 0, r?.sessions ?? 0), queued: r?.queued ?? 0,
      onboardings_failed: r?.onboardings_failed ?? 0, gateway_error_pct: rate(r?.gateway_errors ?? 0, r?.gateway_requests ?? 0), model_cost_usd: r?.model_cost_usd ?? 0 };
  });
}

function fillDays(rows: Analytics['daily'], days: number, from?: string, created: Analytics['new_daily'] = []) {
  const by = new Map(rows.map((r) => [r.day, r])), born = new Map(created.map((r) => [r.day, r.n]));
  const start = from ? Date.parse(`${from}T00:00:00Z`) : Date.now() - (days - 1) * 86_400_000;
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const r = by.get(day);
    const calls = Number(r?.calls ?? 0), errors = Number(r?.errors ?? 0);
    return { day, calls, errors, accounts: Number(r?.accounts ?? 0), people: Number(r?.people ?? 0),
      error_pct: calls ? (errors / calls) * 100 : 0, p95: Number(r?.p95_ms ?? 0), created: Number(born.get(day) ?? 0) };
  });
}
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// ---------- filters in the URL ----------

const LISTS = [
  { key: 'user', label: 'User' }, { key: 'account', label: 'Account' }, { key: 'product', label: 'Product' }, { key: 'tool', label: 'Tool' }, { key: 'client', label: 'Client' },
  { key: 'plan', label: 'Plan' }, { key: 'sub_status', label: 'Subscription' }, { key: 'stage', label: 'Stage' }
] as const;
type ListKey = (typeof LISTS)[number]['key'];
const FLAGS = [{ key: 'errors', label: 'Errors only' }, { key: 'at_risk', label: 'At risk only' }] as const;
type FlagKey = (typeof FLAGS)[number]['key'];
type Filters = Record<ListKey, string[]> & Record<FlagKey, boolean>;

const split = (v: string | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const filterQuery = (f: Filters) =>
  LISTS.filter((l) => f[l.key].length).map((l) => `&${l.key}=${encodeURIComponent(f[l.key].join(','))}`).join('') +
  FLAGS.filter((x) => f[x.key]).map((x) => `&${x.key}=1`).join('');

/** Range and filters from the URL; writes replace the entry so Back leaves the page instead of undoing a filter. */
function useReportParams() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const s = params.toString();
  const { range, filters } = useMemo(() => {
    const p = new URLSearchParams(s);
    const from = p.get('from'), to = p.get('to');
    const range: DateRange = from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? { from, to } : last30();
    const filters = Object.fromEntries([...LISTS.map((l) => [l.key, split(p.get(l.key))]), ...FLAGS.map((x) => [x.key, p.get(x.key) === '1'])]) as Filters;
    return { range, filters };
  }, [s]);
  const write = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(s);
    for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  const setList = (k: ListKey, v: string[]) => write({ [k]: v.length ? v.join(',') : null });
  const setFlag = (k: FlagKey, on: boolean) => write({ [k]: on ? '1' : null });
  const setRange = (r: DateRange) => write({ from: r.from, to: r.to });
  const clear = () => write(Object.fromEntries([...LISTS, ...FLAGS].map((x) => [x.key, null])));
  const active = LISTS.reduce((n, l) => n + filters[l.key].length, 0) + FLAGS.filter((x) => filters[x.key]).length;
  return { range, filters, setList, setFlag, setRange, clear, active, base: rangeQuery(range) + filterQuery(filters) };
}

/** useAdmin with the previous result kept while a new filter loads, so the page does not flash skeletons. */
function useReport<T>(path: string | null) {
  return useQuery<T>({ queryKey: ['admin', path], queryFn: () => adminApi<T>('GET', path!), enabled: path != null, staleTime: 15_000, placeholderData: keepPreviousData });
}

type Option = { value: string; label: string; count?: number };
function facetOptions(f: Facets | undefined): Record<ListKey, Option[]> {
  const plain = (xs: string[] | undefined) => (xs ?? []).map((x) => ({ value: x, label: x }));
  const lists: Record<ListKey, Option[]> = {
    // people Clerk no longer knows (removed, or seeded demo activity) show as unknown with the end of their id
    user: (f?.users ?? []).map((u) => ({ value: u.id, label: `${u.email ?? u.name ?? `Unknown user …${u.id.slice(-6)}`} · ${u.account}` })),
    account: (f?.accounts ?? []).map((a) => ({ value: a.slug, label: a.name })), product: plain(f?.products), tool: plain(f?.tools), client: plain(f?.clients),
    plan: plain(f?.plans), sub_status: (f?.sub_statuses ?? []).map((x) => ({ value: x, label: x.replace('_', ' ') })), stage: (f?.stages ?? []).map((s) => ({ value: s.id, label: s.label }))
  };
  // Each value's count from the server (0 when it has none), once the report has loaded.
  const c = f?.counts;
  return c ? Object.fromEntries(Object.entries(lists).map(([k, xs]) => [k, xs.map((o) => ({ ...o, count: c[k]?.[o.value] ?? 0 }))])) as Record<ListKey, Option[]> : lists;
}

/** One checkbox list in the Filters popover; gets its own search once it is long. Selected values not offered (e.g. from a shared URL) still show. */
function FacetList({ label, options, value, onChange }: { label: string; options: Option[]; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const all: Option[] = [...options, ...value.filter((v) => !options.some((o) => o.value === v)).map((v) => ({ value: v, label: v }))];
  const shown = all.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className='flex flex-col gap-1.5'>
      <div className='flex items-center justify-between text-xs leading-none font-medium'>
        {label}
        {value.length > 0 && <button type='button' className='text-muted-foreground hover:text-foreground font-normal' onClick={() => onChange([])}>Clear</button>}
      </div>
      {all.length > 8 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${label.toLowerCase()}`} aria-label={`Search ${label.toLowerCase()}`} className='h-7 text-xs' />}
      <ul className='flex max-h-40 flex-col gap-0.5 overflow-y-auto'>
        {!shown.length && <li className='text-muted-foreground py-1 text-xs leading-none'>{all.length ? 'No match.' : 'None in this period.'}</li>}
        {shown.map((o) => {
          const on = value.includes(o.value);
          return (
            <li key={o.value}>
              <label className='hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm leading-none'>
                <Checkbox checked={on} onCheckedChange={(c) => onChange(c ? [...value, o.value] : value.filter((v) => v !== o.value))} />
                <span className='min-w-0 flex-1 truncate'>{o.label}</span>
                {o.count != null && <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{num(o.count)}</span>}
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * People to report on: any number, server-side (?user=id,id). A per-person view later hides this picker and pins the
 * filter to the signed-in user on the server, so the same report shows only their own activity.
 */
function UsersPicker({ p, facets }: { p: ReturnType<typeof useReportParams>; facets: Facets | undefined }) {
  const opts = facetOptions(facets).user, value = p.filters.user;
  const [q, setQ] = useState('');
  const shown = opts.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  const label = !value.length ? 'All users' : value.length === 1 ? (opts.find((o) => o.value === value[0])?.label.split(' · ')[0] ?? '1 user') : `${value.length} users`;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='outline' className={cn('max-w-56 justify-start', value.length && 'text-primary')} />}>
        <Icons.teams /> <span className='truncate'>{label}</span>
      </PopoverTrigger>
      <PopoverContent align='end' className='flex w-80 flex-col gap-2'>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${opts.length} people`} aria-label='Search people' className='h-8 text-sm' />
        <div className='flex items-center gap-3 text-xs leading-none'>
          <button type='button' className='text-primary hover:underline' onClick={() => p.setList('user', [...new Set([...value, ...shown.map((o) => o.value)])])}>Select {q ? 'matches' : 'all'}</button>
          {value.length > 0 && <button type='button' className='text-muted-foreground hover:text-foreground' onClick={() => p.setList('user', [])}>Clear ({value.length})</button>}
        </div>
        <ul className='flex max-h-72 flex-col gap-0.5 overflow-y-auto'>
          {!shown.length && <li className='text-muted-foreground py-2 text-xs leading-none'>{opts.length ? 'No match.' : 'Nobody was active in this period.'}</li>}
          {shown.map((o) => {
            const on = value.includes(o.value), [who, account] = o.label.split(' · ');
            return (
              <li key={o.value}>
                <label className='hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-sm leading-none'>
                  <Checkbox checked={on} onCheckedChange={(c) => p.setList('user', c ? [...value, o.value] : value.filter((v) => v !== o.value))} />
                  <span className='min-w-0 flex-1 truncate'>{who}</span>
                  <span className='text-muted-foreground max-w-24 shrink-0 truncate text-xs'>{account}</span>
                  {o.count != null && <span className='text-muted-foreground shrink-0 text-xs tabular-nums' title='Tool calls in this period'>{num(o.count)}</span>}
                </label>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function FiltersPopover({ p, facets }: { p: ReturnType<typeof useReportParams>; facets: Facets | undefined }) {
  const opts = facetOptions(facets);
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='outline' className={cn(p.active && 'text-primary')} />}>
        <IconFilter /> Filters {p.active > 0 && <Badge className='h-5 min-w-5 px-1.5 text-xs leading-none'>{p.active}</Badge>}
      </PopoverTrigger>
      <PopoverContent align='end' className='flex max-h-[75svh] w-80 flex-col gap-4 overflow-y-auto'>
        {LISTS.filter((l) => l.key !== 'user').map((l) => <FacetList key={l.key} label={l.label} options={opts[l.key]} value={p.filters[l.key]} onChange={(v) => p.setList(l.key, v)} />)}
        <div className='flex flex-col gap-2.5 border-t pt-3'>
          {FLAGS.map((x) => (
            <label key={x.key} className='flex cursor-pointer items-center justify-between text-sm leading-none'>
              {x.label}<Switch size='sm' checked={p.filters[x.key]} onCheckedChange={(on) => p.setFlag(x.key, on)} />
            </label>
          ))}
        </div>
        {p.active > 0 && <Button variant='ghost' size='sm' className='self-start' onClick={p.clear}>Clear all</Button>}
      </PopoverContent>
    </Popover>
  );
}

/** One chip per active value ("Tool: search_docs ✕"), then Clear all. Not rendered when nothing is active. */
function FilterChipRow({ p, facets }: { p: ReturnType<typeof useReportParams>; facets: Facets | undefined }) {
  if (!p.active) return null;
  const opts = facetOptions(facets);
  const chip = (key: string, text: ReactNode, remove: () => void) => (
    <span key={key} className='border-primary/40 bg-primary/10 text-primary flex h-7 items-center rounded-full border text-xs leading-none'>
      <span className='max-w-72 truncate py-1 pr-1 pl-2.5'>{text}</span>
      <button type='button' aria-label={`Remove ${key}`} className='hover:text-foreground pr-2 pl-0.5' onClick={remove}><Icons.close className='size-3' /></button>
    </span>
  );
  return (
    <div className='flex min-h-8 shrink-0 flex-wrap items-center gap-1.5'>
      {LISTS.flatMap((l) => p.filters[l.key].map((v) => chip(`${l.key}:${v}`, <><span className='font-medium'>{l.label}:</span> {opts[l.key].find((o) => o.value === v)?.label ?? v}</>,
        () => p.setList(l.key, p.filters[l.key].filter((x) => x !== v)))))}
      {FLAGS.filter((x) => p.filters[x.key]).map((x) => chip(x.key, <span className='font-medium'>{x.label}</span>, () => p.setFlag(x.key, false)))}
      <Button variant='ghost' size='xs' className='text-muted-foreground' onClick={p.clear}>Clear all</Button>
    </div>
  );
}

// ---------- export ----------

interface Sheet { header: string[]; rows: CsvValue[][] }
const ERROR_COLS: Record<ErrorKind, string[]> = {
  tool: ['at', 'account', 'slug', 'method', 'name', 'client', 'error', 'ms'],
  session: ['at', 'account', 'slug', 'product', 'simulation_id', 'model', 'harness', 'status', 'error', 'cost_usd'],
  onboarding: ['at', 'account', 'slug', 'product', 'stage', 'error']
};
const KINDS: { id: ErrorKind; label: string }[] = [{ id: 'tool', label: 'Tool call errors' }, { id: 'session', label: 'Failed agent sessions' }, { id: 'onboarding', label: 'Failed onboardings' }];
const SECTIONS = {
  analytics: [['summary', 'Summary'], ['growth-daily', 'Growth by day'], ['growth-weekly', 'Growth by week'], ['growth-funnel', 'Activation funnel'], ['daily', 'Daily'], ['tools', 'Tool adoption'], ['clients', 'Clients'], ['accounts', 'Accounts'], ['retention', 'Retention']],
  health: [['health-summary', 'Summary'], ['errors-tool', 'Tool call errors (all)'], ['errors-session', 'Agent session failures (all)'], ['errors-onboarding', 'Onboarding failures (all)']]
} as const;
const pause = () => new Promise((r) => setTimeout(r, 150)); // browsers drop back-to-back downloads

/** Every row of one error kind: pages through /analytics/errors 1000 at a time until `total`. */
async function allErrors(base: string, kind: ErrorKind) {
  const rows: ErrorRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await adminApi<ErrorPage>('GET', `/analytics/errors?${base}&kind=${kind}&limit=1000&offset=${offset}`);
    rows.push(...r.rows);
    if (!r.rows.length || rows.length >= r.total) return rows;
  }
}

// text fields only: a search for "5" should not match every row with 5 calls
const textOf = (r: object) => Object.values(r).filter((v) => typeof v === 'string').join(' ').toLowerCase();

function useExport(view: 'analytics' | 'health', a: Analytics | undefined, base: string, match: (r: object) => boolean) {
  const [busy, setBusy] = useState(false);
  const name = (section: string, ext = 'csv') => `${NS}-${view}-${section}-${a?.range?.from ?? ''}_${a?.range?.to ?? ''}.${ext}`;
  const sheet = async (id: string): Promise<Sheet> => {
    if (!a) return { header: [], rows: [] };
    const t = a.totals;
    switch (id) {
      case 'summary': return { header: ['metric', 'value', 'change_pct'], rows: [
        ['active_accounts', t.active_accounts, t.change.active_accounts], ['active_people', t.active_people, t.change.active_people], ['tool_calls', t.calls, t.change.calls],
        ['new_accounts', t.new_accounts, null], ['error_pct', t.error_pct, null], ['p50_ms', t.p50_ms, null], ['p95_ms', t.p95_ms, null],
        ['accounts_with_activity', a.accounts_total, null], ['errors', a.errors_total, null]] };
      case 'growth-daily': {
        const g = a.growth, st = new Map((g?.stickiness ?? []).map((d) => [d.day, d]));
        return { header: ['day', 'accounts_total', 'dau', 'mau', 'dau_mau_pct'],
          rows: (g?.accounts_daily ?? []).map((d) => [d.day, d.total, st.get(d.day)?.dau ?? 0, st.get(d.day)?.mau ?? 0, st.get(d.day)?.pct ?? null]) };
      }
      case 'growth-weekly': {
        const g = a.growth, clients = g?.client_mix.clients ?? [];
        const mix = new Map((g?.client_mix.weeks ?? []).map((w) => [w.week, w.calls])), sims = new Map((g?.sims_weekly ?? []).map((w) => [w.week, w]));
        return { header: ['week', 'active_accounts', 'active_people', 'calls', 'calls_change_pct', 'calls_per_person', 'sims_completed', 'sims_other', 'partial', ...clients.map((c) => `calls_${c}`)],
          rows: (g?.weekly ?? []).map((w) => [w.week, w.accounts, w.people, w.calls, w.change_pct, w.calls_per_person, sims.get(w.week)?.completed ?? 0, sims.get(w.week)?.other ?? 0, w.partial,
            ...clients.map((_, i) => mix.get(w.week)?.[i] ?? 0)]) };
      }
      case 'growth-funnel': return { header: ['step', 'label', 'count', 'pct_of_previous'], rows: (a.growth?.funnel ?? []).map((f) => [f.id, f.label, f.reached, f.pct]) };
      case 'daily': return { header: ['day', 'calls', 'errors', 'accounts', 'people'], rows: fillDays(a.daily, a.days, a.range?.from).map((d) => [d.day, d.calls, d.errors, d.accounts, d.people]) };
      case 'tools': return { header: ['tool', 'accounts', 'people', 'calls', 'error_pct', 'p50_ms', 'p95_ms'], rows: a.tools.filter(match).map((x) => [x.name, x.accounts, x.people, x.calls, x.error_pct, x.p50_ms, x.p95_ms]) };
      case 'clients': return { header: ['client', 'accounts', 'people', 'connections'], rows: a.clients.map((c) => [c.client, c.accounts, c.people, c.connections]) };
      case 'accounts': {
        // the page holds the top `limit` accounts; an export wants all of them
        const list = a.accounts_total > a.accounts.length ? (await adminApi<Analytics>('GET', `/analytics?${base}&limit=5000`)).accounts : a.accounts;
        return { header: ['account', 'slug', 'products', 'calls', 'prev_calls', 'trend_pct', 'people', 'errors', 'last_seen', 'at_risk'],
          rows: list.filter(match).map((r) => [r.name, r.slug, r.products, r.calls, r.prev_calls, r.trend, r.people, r.errors, r.last_seen, r.at_risk]) };
      }
      case 'retention': return { header: ['cohort', 'size', ...Array.from({ length: 8 }, (_, i) => `w${i}`)], rows: a.retention.map((c) => [c.cohort, c.size, ...c.weeks]) };
      case 'health-summary': return { header: ['metric', 'value'], rows: [
        ['tool_error_pct', t.error_pct], ['tool_p50_ms', t.p50_ms], ['tool_p95_ms', t.p95_ms], ['tool_errors', a.errors_total], ...Object.entries(a.ops).map(([k, v]) => [k, v])] };
      default: {
        const kind = id.replace('errors-', '') as ErrorKind;
        return { header: ERROR_COLS[kind], rows: (await allErrors(base, kind)).filter(match).map((r) => ERROR_COLS[kind].map((c) => r[c] as CsvValue)) };
      }
    }
  };
  const run = async (fn: () => Promise<number>) => {
    if (!a || busy) return;
    setBusy(true);
    try { const n = await fn(); toast.success(n === 1 ? 'Exported 1 file' : `Exported ${n} files`); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const one = (id: string) => run(async () => { const s = await sheet(id); downloadCsv(name(id), s.header, s.rows); return 1; });
  const every = () => run(async () => {
    const ids = SECTIONS[view].map(([id]) => id);
    for (const [i, id] of ids.entries()) { const s = await sheet(id); if (i) await pause(); downloadCsv(name(id), s.header, s.rows); }
    return ids.length;
  });
  const json = () => run(async () => {
    const full = view === 'health' ? Object.fromEntries(await Promise.all(KINDS.map(async (k) => [k.id, await allErrors(base, k.id)] as const))) : undefined;
    downloadJson(name('report', 'json'), { ...a, filters: a!.filters, ...(full ? { errors_full: full } : {}), exported_at: new Date().toISOString() });
    return 1;
  });
  return { busy, one, every, json };
}

function ExportButton({ view, a, x }: { view: 'analytics' | 'health'; a: Analytics | undefined; x: ReturnType<typeof useExport> }) {
  const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');
  return (
    <DropdownMenu>
        <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label='Export' title='Export' disabled={!a} />}>
          {x.busy ? <Icons.spinner className='animate-spin' /> : <Icons.download />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='w-60'>
          <DropdownMenuItem disabled={x.busy} onClick={x.every}><Icons.download /> Everything (CSV)</DropdownMenuItem>
          <DropdownMenuSeparator />
          {SECTIONS[view].map(([id, label]) => <DropdownMenuItem key={id} disabled={x.busy} onClick={() => x.one(id)}><Icons.download /> {label}</DropdownMenuItem>)}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={x.busy} onClick={x.json}><Icons.code /> Whole report (JSON)</DropdownMenuItem>
          {(a?.links.posthog || a?.links.new_relic) && <DropdownMenuSeparator />}
          {a?.links.posthog && <DropdownMenuItem onClick={() => open(a.links.posthog!)}><Icons.externalLink /> Open PostHog</DropdownMenuItem>}
          {a?.links.new_relic && <DropdownMenuItem onClick={() => open(a.links.new_relic!)}><Icons.externalLink /> Open New Relic</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
  );
}

// ---------- the page ----------

/** Product analytics (/admin/analytics) or the health of the machinery behind it (/admin/health), from one API. */
export function AdminAnalytics({ view = 'analytics' }: { view?: 'analytics' | 'health' }) {
  // useSearchParams needs a Suspense boundary for the static render
  return <Suspense fallback={<PageContainer><LoadingCards count={4} /></PageContainer>}><Report view={view} /></Suspense>;
}

/**
 * Health's tabs: errors (this report), and the session engine's Jobs and Sessions record tables (?section=jobs|sessions);
 * in a build without it, the packs' runs per job kind (?section=runs, mold_v0-104), or nothing more with no job kind.
 */
const HEALTH_TABS: readonly (readonly [string, string])[] = sessionEngine() ? [['errors', 'Errors'], ['jobs', 'Jobs'], ['sessions', 'Sessions']]
  : packRuns() ? [['errors', 'Errors'], ['runs', W.Runs]] : [['errors', 'Errors']];

function HealthTabs({ tab }: { tab: string }) {
  return HEALTH_TABS.length > 1 ? <UrlTabs tabs={HEALTH_TABS} tab={tab} base='/admin/health' /> : null;
}

function Report({ view }: { view: 'analytics' | 'health' }) {
  const section = useSearchParams().get('section');
  const tab = view === 'health' && section && section !== 'errors' && HEALTH_TABS.some(([id]) => id === section) ? section : 'errors';
  if (tab !== 'errors') {
    return (
      <PageContainer>
        <div className='flex min-w-0 flex-col gap-3'>
          <HealthTabs tab={tab} />
          {tab === 'jobs' ? <ComputeJobs /> : tab === 'runs' ? <PackRunKinds /> : <ComputeSessions />}
        </div>
      </PageContainer>
    );
  }
  return <ErrorsReport view={view} />;
}

function ErrorsReport({ view }: { view: 'analytics' | 'health' }) {
  const p = useReportParams();
  // Health's table shows one kind of failure at a time, picked on the search row.
  const [kind, setKind] = useState<ErrorKind>('tool');
  const [q, setQ] = useState('');
  const { data: a, error, isLoading } = useReport<Analytics>(`/analytics?${p.base}`);
  const w = q.trim().toLowerCase();
  const match = (r: object) => !w || textOf(r).includes(w);
  const x = useExport(view, a, p.base, match);

  return (
    <PageContainer>
      <div className='flex h-[calc(100svh-5.5rem)] min-h-[24rem] min-w-0 flex-col gap-3'>
        {view === 'health' && <HealthTabs tab='errors' />}
        <div className='flex flex-wrap items-center gap-2'>
          <div className='relative min-w-48 flex-1'>
            <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
            <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} className='h-9 pl-8'
              placeholder={view === 'health' ? 'Search errors' : 'Search accounts, products or tools'} aria-label='Search' />
          </div>
          {view === 'health' && (
            <NativeSelect aria-label='Errors from' value={kind} onChange={(e) => setKind(e.target.value as ErrorKind)}>
              {KINDS.map((k) => <NativeSelectOption key={k.id} value={k.id}>{counted(k.label, a && errorCounts(a)[k.id])}</NativeSelectOption>)}
            </NativeSelect>
          )}
          <DateRangePicker value={p.range} onChange={p.setRange} />
          <UsersPicker p={p} facets={a?.facets} />
          <FiltersPopover p={p} facets={a?.facets} />
          <ExportButton view={view} a={a} x={x} />
        </div>
        <FilterChipRow p={p} facets={a?.facets} />
        <ErrorBox error={error} />
        <div className='min-h-0 flex-1 overflow-y-auto'>
          {isLoading || !a ? (
            <div className='grid gap-4'>
              <LoadingCards count={4} />
              <div className='grid gap-8 lg:grid-cols-2 lg:gap-12'><Skeleton className='h-72 rounded-xl' /><Skeleton className='h-72 rounded-xl' /></div>
            </div>
          ) : view === 'analytics' ? <AnalyticsBody a={a} match={match} /> : <HealthBody a={a} base={p.base} match={match} kind={kind} />}
        </div>
      </div>
    </PageContainer>
  );
}

function AnalyticsBody({ a, match }: { a: Analytics; match: (r: object) => boolean }) {
  const series = useMemo(() => fillDays(a.daily, a.days, a.range?.from, a.new_daily), [a]);
  const tools = a.tools.filter(match), accounts = a.accounts.filter(match);
  const maxClient = Math.max(...a.clients.map((c) => c.accounts), 1);
  return (
    <div className='flex w-full flex-col pb-4'>
      <StatStrip className='border-x [&>div:first-child]:pl-4 max-sm:[&>div:nth-child(odd)]:pl-4' items={[
        { label: 'Active accounts', value: num(a.totals.active_accounts), spark: series.map((d) => d.accounts) },
        { label: 'Active people', value: num(a.totals.active_people), spark: series.map((d) => d.people) },
        { label: 'Tool calls', value: num(a.totals.calls), spark: series.map((d) => d.calls) },
        { label: 'New accounts', value: num(a.totals.new_accounts), spark: series.map((d) => d.created) }
      ]} />

      <div className='border-l'>
        {a.growth && <GrowthRows g={a.growth} />}
        <div className='grid lg:grid-cols-2'>
          <Box title='Tool calls per day' description='Errors in red.'>
          {a.totals.calls ? (
            <ChartContainer config={callsConfig} className='aspect-auto h-[240px] w-full'>
              <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id='fillCalls' x1='0' y1='0' x2='0' y2='1'>
                    <stop offset='5%' stopColor='var(--color-calls)' stopOpacity={0.6} />
                    <stop offset='95%' stopColor='var(--color-calls)' stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDay} />
                <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} indicator='dot' />} />
                <Area dataKey='calls' type='monotone' fill='url(#fillCalls)' stroke='var(--color-calls)' strokeWidth={2} />
                <Area dataKey='errors' type='monotone' fill='var(--color-errors)' fillOpacity={0.25} stroke='var(--color-errors)' strokeWidth={1.5} />
                <ChartLegend content={<ChartLegendContent />} />
              </AreaChart>
            </ChartContainer>
          ) : <p className='text-muted-foreground py-16 text-center text-sm'>No tool calls in this period.</p>}
        </Box>
          <Box title='Active accounts and people per day'>
          {a.totals.calls ? (
            <ChartContainer config={activeConfig} className='aspect-auto h-[240px] w-full'>
              <BarChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDay} />
                <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} indicator='dashed' />} />
                <Bar dataKey='accounts' fill='var(--color-accounts)' radius={3} />
                <Bar dataKey='people' fill='var(--color-people)' radius={3} />
                <ChartLegend content={<ChartLegendContent />} />
              </BarChart>
            </ChartContainer>
          ) : <p className='text-muted-foreground py-16 text-center text-sm'>No activity in this period.</p>}
        </Box>
        </div>
        <div className='grid lg:grid-cols-2'>
          <Box title='Calls by tool' description='The ten most called.'>
          <RankBars data={top(tools, (t) => Number(t.calls)).map((t) => ({ name: t.name, value: Number(t.calls) }))} color='var(--chart-1)' format={num} mono empty='No tool calls in this period.' />
        </Box>
          <Box title='Accounts reached' description='How many accounts use each tool.'>
          <RankBars data={top(tools, (t) => Number(t.accounts)).map((t) => ({ name: t.name, value: Number(t.accounts) }))} color='var(--chart-2)' format={num} mono empty='No tool calls in this period.' />
        </Box>
        </div>
        <div className='grid lg:grid-cols-2'>
          <Box title='Error rate by tool' description='Share of calls that failed.'>
          <RankBars data={top(tools.filter((t) => Number(t.error_pct) > 0), (t) => Number(t.error_pct)).map((t) => ({ name: t.name, value: Number(t.error_pct) }))} color='var(--destructive)' format={(v) => `${v}%`} mono empty='No tool errors in this period.' />
        </Box>
          <Box title='Latency by tool' description='p95 time per call, slowest first.'>
            <RankBars data={top(tools, (t) => Number(t.p95_ms ?? 0)).map((t) => ({ name: t.name, value: Number(t.p95_ms ?? 0) }))} color='var(--chart-5)' format={(v) => ms(v)} mono empty='No tool calls in this period.' />
          </Box>
        </div>
        <div className='grid lg:grid-cols-2'>
          <Box title='People per tool' description='How many people call each tool.'>
            <RankBars data={top(tools, (t) => Number(t.people)).map((t) => ({ name: t.name, value: Number(t.people) }))} color='var(--chart-3)' format={num} mono empty='No tool calls in this period.' />
          </Box>
          <Box title='Clients' description='AI clients that connected.'>
        {a.clients.length ? (
          <ul className='grid gap-3'>
            {a.clients.map((c) => (
              <li key={c.client} className='grid gap-1.5'>
                <div className='flex items-center justify-between gap-2 text-sm leading-none'>
                  <Mono>{c.client}</Mono>
                  <span className='text-muted-foreground text-xs'>{c.accounts} accounts · {c.people} people · {num(c.connections)} connections</span>
                </div>
                <div className='bg-muted h-2 overflow-hidden rounded-full'>
                  <div className='h-full rounded-full' style={{ width: `${(c.accounts / maxClient) * 100}%`, background: 'var(--chart-3)' }} />
                </div>
              </li>
            ))}
          </ul>
        ) : <p className='text-muted-foreground py-6 text-center text-sm'>No connections in this period.</p>}
      </Box>
        </div>
        <div className='grid lg:grid-cols-2'>
          <Box title='Calls by account' description='The ten busiest.'>
          <RankBars data={top(accounts, (r) => Number(r.calls)).map((r) => ({ name: r.name, value: Number(r.calls) }))} color='var(--chart-1)' format={num} empty='No account activity.' />
        </Box>
          <Box title='Errors by account' description='Failed tool calls.'>
          <RankBars data={top(accounts.filter((r) => Number(r.errors) > 0), (r) => Number(r.errors)).map((r) => ({ name: r.name, value: Number(r.errors) }))} color='var(--destructive)' format={num} empty='No errors in this period.' />
        </Box>
        </div>
        <div className='grid lg:grid-cols-2'>
          <Box title='People per account' description='Active people in each account.'>
            <RankBars data={top(accounts, (r) => Number(r.people)).map((r) => ({ name: r.name, value: Number(r.people) }))} color='var(--chart-3)' format={num} empty='No account activity.' />
          </Box>
          <Box title='Trend vs previous period' description='Accounts by how their calls changed.'>
          <RankBars data={trendBuckets(accounts)} color='var(--chart-4)' format={num} empty='No account activity.' />
        </Box>
        </div>
        <Box title='Weekly retention' description='Accounts by the week of their first tool call, and the share active in each week after.'>
        {a.retention.length ? (
          <div className='-mx-4 overflow-x-auto px-4'>
            <table className='w-full min-w-[640px] border-separate border-spacing-1 text-sm'>
              <thead>
                <tr className='text-muted-foreground text-xs'>
                  <th className='text-left font-medium'>Cohort</th>
                  <th className='font-medium'>Accounts</th>
                  {Array.from({ length: 8 }, (_, i) => <th key={i} className='font-medium'>W{i}</th>)}
                </tr>
              </thead>
              <tbody>
                {a.retention.map((c) => (
                  <tr key={c.cohort}>
                    <td className='pr-2 whitespace-nowrap'>{shortDay(c.cohort)}</td>
                    <td className='text-center tabular-nums'>{c.size}</td>
                    {c.weeks.map((v, i) => (
                      <td key={i} className='h-9 rounded-md text-center text-xs tabular-nums'
                        style={v == null ? { background: 'var(--muted)', opacity: 0.35 }
                          : { background: `color-mix(in oklch, var(--primary) ${Math.max(8, v)}%, transparent)`, color: v > 55 ? 'var(--primary-foreground)' : undefined }}>
                        {v == null ? '' : `${v}%`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className='text-muted-foreground py-6 text-center text-sm'>No cohorts in the last 8 weeks.</p>}
      </Box>
      </div>
    </div>
  );
}

// ---------- growth ----------

const weekAxis = <XAxis dataKey='week' tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />;
/** "Mar 2", or "Mar 2 (to date)" when the range ends before that week does. */
const weekLabel = (v: unknown, payload: readonly { payload?: { partial?: boolean } }[] = []) => `Week of ${shortDay(String(v))}${payload[0]?.payload?.partial ? ' (to date)' : ''}`;
const signedPct = (v: unknown) => (v == null || v === '' ? '' : `${Number(v) > 0 ? '+' : ''}${Number(v)}%`);
const tipRow = (label: ReactNode, value: ReactNode) => (
  <div className='flex w-full items-center justify-between gap-4'><span className='text-muted-foreground'>{label}</span><span className='text-foreground font-mono font-medium tabular-nums'>{value}</span></div>
);
const Empty = ({ children }: { children: ReactNode }) => <p className='text-muted-foreground py-16 text-center text-sm'>{children}</p>;
const CLIENT_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/** The Growth block: four rows of two at the top of the Analytics grid. */
function GrowthRows({ g }: { g: Growth }) {
  const weekly = useMemo(() => {
    const sims = new Map((g.sims_weekly ?? []).map((w) => [w.week, w])), mix = new Map(g.client_mix.weeks.map((w) => [w.week, w.calls]));
    return g.weekly.map((w) => ({ ...w, completed: sims.get(w.week)?.completed ?? 0, other: sims.get(w.week)?.other ?? 0,
      ...Object.fromEntries(g.client_mix.clients.map((_, i) => [`c${i}`, mix.get(w.week)?.[i] ?? 0])) }));
  }, [g]);
  const mixConfig = Object.fromEntries(g.client_mix.clients.map((c, i) => [`c${i}`, { label: c, color: c === 'Other' ? 'var(--muted-foreground)' : CLIENT_COLORS[i] }])) satisfies ChartConfig;
  const lastTotal = g.accounts_daily.at(-1)?.total ?? 0;
  const anyCalls = g.weekly.some((w) => w.calls > 0), labels = weekly.length <= 16;
  const funnelMax = Math.max(1, ...(g.funnel ?? []).map((f) => f.reached));
  return (
    <>
      <div className='grid lg:grid-cols-2'>
        <Box title='Accounts over time' description='Total accounts at the end of each day. Only the account and product filters apply.'>
          {lastTotal ? (
            <ChartContainer config={{ total: { label: 'Accounts', color: 'var(--chart-2)' } }} className='aspect-auto h-[240px] w-full'>
              <AreaChart data={g.accounts_daily} margin={{ left: 0, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id='fillAccountsTotal' x1='0' y1='0' x2='0' y2='1'>
                    <stop offset='5%' stopColor='var(--color-total)' stopOpacity={0.5} />
                    <stop offset='95%' stopColor='var(--color-total)' stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDay} />
                <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))} indicator='dot' />} />
                <Area dataKey='total' type='stepAfter' fill='url(#fillAccountsTotal)' stroke='var(--color-total)' strokeWidth={2} />
              </AreaChart>
            </ChartContainer>
          ) : <Empty>No accounts yet.</Empty>}
        </Box>
        <Box title='Weekly active accounts' description='Accounts with a tool call each week (Monday to Sunday, UTC).'>
          {anyCalls ? (
            <ChartContainer config={{ accounts: { label: 'Active accounts', color: 'var(--chart-2)' } }} className='aspect-auto h-[240px] w-full'>
              <BarChart data={weekly} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                {weekAxis}
                <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={weekLabel} indicator='dashed' />} />
                <Bar dataKey='accounts' fill='var(--color-accounts)' radius={3} />
              </BarChart>
            </ChartContainer>
          ) : <Empty>No tool calls in these weeks.</Empty>}
        </Box>
      </div>
      <div className='grid lg:grid-cols-2'>
        <Box title='Stickiness' description='People active that day as a share of people active in the 30 days to it (DAU/MAU).'>
          {g.stickiness.some((d) => d.mau > 0) ? (
            <ChartContainer config={{ pct: { label: 'DAU/MAU', color: 'var(--chart-4)' } }} className='aspect-auto h-[240px] w-full'>
              <AreaChart data={g.stickiness} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey='day' tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} tickFormatter={shortDay} />
                <YAxis width={40} tickLine={false} axisLine={false} domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => shortDay(String(v))}
                  formatter={(v, _n, item) => <div className='grid w-full gap-1'>{tipRow('DAU/MAU', `${v}%`)}{tipRow('Active that day', num(item.payload.dau))}{tipRow('Active in 30 days', num(item.payload.mau))}</div>} />} />
                <Area dataKey='pct' type='monotone' fill='var(--color-pct)' fillOpacity={0.15} stroke='var(--color-pct)' strokeWidth={2} />
              </AreaChart>
            </ChartContainer>
          ) : <Empty>Nobody was active in this period.</Empty>}
        </Box>
        <Box title='Week-over-week growth' description='Tool calls per week; the label is the change against the week before.'>
          {anyCalls ? (
            <ChartContainer config={{ calls: { label: 'Tool calls', color: 'var(--chart-1)' } }} className='aspect-auto h-[240px] w-full'>
              <BarChart data={weekly} margin={{ left: 0, right: 8, top: labels ? 20 : 8 }}>
                <CartesianGrid vertical={false} />
                {weekAxis}
                <YAxis width={40} tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={weekLabel}
                  formatter={(v, _n, item) => <div className='grid w-full gap-1'>{tipRow('Tool calls', num(v))}{tipRow('vs week before', signedPct(item.payload.change_pct) || '—')}</div>} />} />
                <Bar dataKey='calls' fill='var(--color-calls)' radius={3}>
                  {labels && <LabelList dataKey='change_pct' position='top' fontSize={10} fill='var(--muted-foreground)' formatter={signedPct} />}
                </Bar>
              </BarChart>
            </ChartContainer>
          ) : <Empty>No tool calls in these weeks.</Empty>}
        </Box>
      </div>
      <div className='grid lg:grid-cols-2'>
        <Box title='Calls per active person' description='Tool calls per week divided by the people who made them.'>
          {g.weekly.some((w) => w.calls_per_person != null) ? (
            <ChartContainer config={{ calls_per_person: { label: 'Calls per person', color: 'var(--chart-3)' } }} className='aspect-auto h-[240px] w-full'>
              <BarChart data={weekly} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                {weekAxis}
                <YAxis width={32} tickLine={false} axisLine={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={weekLabel}
                  formatter={(v, _n, item) => <div className='grid w-full gap-1'>{tipRow('Calls per person', v)}{tipRow('Tool calls', num(item.payload.calls))}{tipRow('People', num(item.payload.people))}</div>} />} />
                <Bar dataKey='calls_per_person' fill='var(--color-calls_per_person)' radius={3} />
              </BarChart>
            </ChartContainer>
          ) : <Empty>No tool calls in these weeks.</Empty>}
        </Box>
        <Box title='Client mix over time' description="Tool calls per week by the AI client of the caller's latest connection; the top five, the rest as Other.">
          {g.client_mix.clients.length ? (
            <ChartContainer config={mixConfig} className='aspect-auto h-[240px] w-full'>
              <BarChart data={weekly} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                {weekAxis}
                <YAxis width={40} tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={weekLabel} indicator='dot' />} />
                {g.client_mix.clients.map((_, i, all) => (
                  <Bar key={i} dataKey={`c${i}`} stackId='mix' fill={`var(--color-c${i})`} stroke='var(--background)' strokeWidth={1}
                    radius={i === all.length - 1 ? [3, 3, 0, 0] : 0} />
                ))}
                <ChartLegend content={<ChartLegendContent />} />
              </BarChart>
            </ChartContainer>
          ) : <Empty>No tool calls in these weeks.</Empty>}
        </Box>
      </div>
      <div className={cn('grid', g.sims_weekly && 'lg:grid-cols-2')}>
        {g.sims_weekly && (
        <Box title={`${W.Runs} per week`} description={`${W.Runs} created each week, completed and the rest. Tool and client filters do not apply.`}>
          {g.sims_weekly.some((w) => w.completed + w.other > 0) ? (
            <ChartContainer config={{ completed: { label: 'Completed', color: 'var(--chart-2)' }, other: { label: 'Not completed', color: 'var(--chart-4)' } }} className='aspect-auto h-[240px] w-full'>
              <BarChart data={weekly} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                {weekAxis}
                <YAxis width={32} tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={weekLabel} indicator='dot' />} />
                <Bar dataKey='completed' stackId='sims' fill='var(--color-completed)' stroke='var(--background)' strokeWidth={1} />
                <Bar dataKey='other' stackId='sims' fill='var(--color-other)' stroke='var(--background)' strokeWidth={1} radius={[3, 3, 0, 0]} />
                <ChartLegend content={<ChartLegendContent />} />
              </BarChart>
            </ChartContainer>
          ) : <Empty>No {W.runs} in these weeks.</Empty>}
        </Box>
        )}
        <Box title='Activation funnel' description='Access requests made in this period, then the accounts created in it and how far they got. Requests ignore the filters.'>
          {!g.funnel ? <Empty>Accounts could not be loaded.</Empty> : g.funnel.every((f) => !f.reached) ? <Empty>No access requests or new accounts in this period.</Empty> : (
            <ol className='grid gap-3'>
              {g.funnel.map((f, i) => (
                <li key={f.id} className='grid gap-1.5'>
                  <div className='flex items-center justify-between gap-2 text-sm leading-none'>
                    <span>{f.label}</span>
                    <span className='text-muted-foreground text-xs tabular-nums'>
                      <span className='text-foreground font-medium'>{num(f.reached)}</span>
                      {i > 0 && <> · {f.pct == null ? '—' : `${f.pct}%`} of the step before</>}
                    </span>
                  </div>
                  <div className='bg-muted h-2 overflow-hidden rounded-full'>
                    <div className='h-full rounded-full' style={{ width: `${(f.reached / funnelMax) * 100}%`, background: 'var(--chart-1)' }} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </Box>
      </div>
    </>
  );
}

/** Accounts by how their calls moved against the previous period of the same length. */
function trendBuckets(rows: readonly { trend: number | null; at_risk: boolean }[]) {
  const b = { Growing: 0, Steady: 0, Declining: 0, 'At risk': 0, New: 0 };
  for (const r of rows) {
    if (r.at_risk) b['At risk']++;
    else if (r.trend == null) b.New++;
    else if (r.trend > 10) b.Growing++;
    else if (r.trend < -10) b.Declining++;
    else b.Steady++;
  }
  return Object.entries(b).map(([name, value]) => ({ name, value }));
}

const ERROR_TABLE: Record<ErrorKind, { label: string; render: (r: ErrorRow) => ReactNode; className?: string }[]> = {
  tool: [
    { label: 'Call', render: (r) => <Mono>{r.name || r.method}</Mono> },
    { label: 'Client', render: (r) => <span className='text-muted-foreground text-xs'>{r.client ?? ''}</span> },
    { label: 'Time', render: (r) => <span className='text-xs whitespace-nowrap'>{ms(r.ms)}</span> }
  ],
  session: [
    { label: 'Product', render: (r) => r.product },
    { label: 'Model', render: (r) => <Mono>{r.model}</Mono> },
    { label: 'Harness', render: (r) => <span className='text-xs'>{r.harness}</span> },
    { label: 'Status', render: (r) => <StatusBadge tone={r.status === 'timeout' ? 'warn' : 'bad'}>{r.status}</StatusBadge> },
    { label: 'Cost', render: (r) => <span className='tabular-nums'>{usd(Number(r.cost_usd ?? 0))}</span> }
  ],
  onboarding: [
    { label: 'Product', render: (r) => r.product },
    { label: 'Stage', render: (r) => <span className='text-xs'>{r.stage ?? '—'}</span> }
  ]
};

const errorCounts = (a: Analytics): Record<ErrorKind, number> =>
  ({ tool: a.errors_total, session: a.ops.sessions_failed ?? 0, onboarding: a.ops.onboardings_failed ?? 0 });

function HealthBody({ a, base, match, kind }: { a: Analytics; base: string; match: (r: object) => boolean; kind: ErrorKind }) {
  const [page, setPage] = useState(1), [size, setSize] = useState(25);
  useEffect(() => setPage(1), [base, kind, size]);
  // paged on the server: the full set can be far larger than a page
  const { data, error, isFetching } = useReport<ErrorPage>(`/analytics/errors?${base}&kind=${kind}&limit=${size}&offset=${(page - 1) * size}`);
  const fresh = data?.kind === kind ? data : undefined; // keepPreviousData would show the last tab's rows under new headers
  const rows = (fresh?.rows ?? []).filter(match);
  const total = fresh?.total ?? 0;
  const pager: Paged<ErrorRow> = { rows, page, pages: Math.max(1, Math.ceil(total / size)), size, total, setPage, setSize };
  const series = useMemo(() => fillDays(a.daily, a.days, a.range?.from), [a]);
  const ops = useMemo(() => fillOps(a), [a]);
  const opsSpark = (k: keyof ReturnType<typeof fillOps>[number]) => ops.map((d) => d[k]);
  const cols = [{ label: 'When', render: (r: ErrorRow) => <When d={r.at} /> }, { label: 'Account', render: (r: ErrorRow) => <span className='leading-none'>{r.account}</span> },
    ...ERROR_TABLE[kind], { label: 'Error', render: (r: ErrorRow) => <span className='line-clamp-2 text-sm whitespace-normal' title={String(r.error ?? '')}>{r.error ?? '—'}</span>, className: 'min-w-64' }];
  return (
    <div className='flex h-full min-h-[32rem] flex-col gap-6'>
      <div className='flex shrink-0 flex-col gap-4'>
        <StatStrip items={[
          { label: 'Tool error rate', value: `${a.totals.error_pct}%`, spark: series.map((d) => d.error_pct) },
          { label: 'Tool latency, p95', value: ms(a.totals.p95_ms), spark: series.map((d) => d.p95) },
          { label: 'Agent sessions failed', value: pct(a.ops.sessions_failed, a.ops.sessions), spark: opsSpark('sessions_failed_pct') },
          { label: 'Gateway error rate', value: pct(a.ops.gateway_errors, a.ops.gateway_requests), spark: opsSpark('gateway_error_pct') }
        ]} />
      </div>
      <div className={cn('flex min-h-0 flex-1 flex-col gap-2', isFetching && 'opacity-70')}>
        <ErrorBox error={error} />
        <div className='flex min-h-[16rem] flex-1 flex-col border'>
          <div className='min-h-0 flex-1 overflow-auto'>
            <Table className='min-w-[760px]'>
              <TableHeader className='bg-background sticky top-0 z-10 shadow-[0_1px_0_var(--border)]'>
                <TableRow>{cols.map((c) => <TableHead key={c.label}>{c.label}</TableHead>)}</TableRow>
              </TableHeader>
              <TableBody>
                {!rows.length && (
                  <TableRow><TableCell colSpan={cols.length} className='text-muted-foreground py-10 text-center'>
                    {!fresh ? 'Loading…' : total ? 'Nothing on this page matches the search.' : 'No failures in this period.'}
                  </TableCell></TableRow>
                )}
                {rows.map((r, i) => (
                  <TableRow key={`${r.at}-${i}`}>
                    {cols.map((c) => <TableCell key={c.label} className={cn('align-top', 'className' in c && c.className)}>{c.render(r)}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <TablePager p={pager} noun={kind === 'tool' ? 'errors' : 'failures'} className='shrink-0 py-0' />
      </div>
    </div>
  );
}
