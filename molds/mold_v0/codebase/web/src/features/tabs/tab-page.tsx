'use client';
// A tab a pack declares (mold_v0-058), at /app/<tab> (mold_v0-132): the shell draws it from pack.json alone.
//   overview   the tab's charts (mold_v0-063; ./charts.tsx). One that includes setup is the build's home (mold_v0-134,
//              mold_v0-172): the Setup page's own layout (the checklist, the connection card and the cards of its
//              pack.json rail on the right; the notices it includes below the checklist unless a card shows them), its
//              charts below both columns
//   area       a record area's records: a table, a board (a column per state), a timeline (by a date); the tab's charts
//              above. The table is the console's database table (mold_v0-176: RecordTableView, as the record pages and
//              Accounts): a row opens the record beside the list, with Open record for its page when the tab has the
//              detail view. A merged tab (mold_v0-135: pack.json `areas`) draws several areas as one list, rows merged
//              by key on the server (./merged.ts)
//   runs       the workspace's runs; reports: finished runs and their results (./runs.tsx: the same database table)
//   sections   one page of several area tabs (mold_v0-175: pack.json `sections`), an in-page tab strip above the
//              selected one's charts, views and table (?tab=<id>)
// An area tab offers Export CSV (mold_v0-108; ./export.tsx): every row it reads, as the generated export_<area> tool writes it.
// Records come from /api/records (src/record-routes.ts), runs from /api/runs (src/view-routes.ts): read only, for this
// workspace, as the person's role may read them. The sidebar shows a tab only to the roles that may read what it shows;
// the server refuses the rest whatever the page asks.
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQueryState } from 'nuqs';
import PageContainer from '@/components/layout/page-container';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { packCharts, packTabs, type PackChartSpec, type PackTabSpec, type RecordAreaSpec } from '@/config/pack-nav.generated';
import { useAccountRole } from '@/features/portal/role';
import { FloatPanel, SetupPage } from '@/features/portal/setup';
import { DueSoonCard, DueSoonSection } from '@/features/schedules/notices-page';
import { SchedulesBody } from '@/features/schedules/schedules-page';
import { Icons } from '@/components/icons';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { RecordTableView } from '@/features/records/record-pages';
import { BoardColumns, TimelineList, type Page } from './board';
import { ChartCell, ChartTiles, type MetricResult } from './charts';
import { EmptyState, type EmptySpec } from './empty';
import { ExportCsvButton } from './export';
import { tabRecordsUrl, viewArea, withSource } from './merged';
import { tabCharts } from './registry';
import { RunsTable } from './runs';
import { httpError } from '@/features/status/from-error';
import { StatusPage } from '@/features/status/status-page';


async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, body);
  return body;
}


/** The numbers of some charts, from one request for all their metrics (keyed by metric name; null while loading). */
function useChartMetrics(charts: PackChartSpec[]) {
  const names = useMemo(() => [...new Set(charts.flatMap((c) => c.metrics))], [charts]);
  const url = `/api/metrics?names=${encodeURIComponent(names.join(','))}`;
  return useOrgLoad(async () => {
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as { metrics?: MetricResult[]; error?: string };
    if (!res.ok) throw httpError(res.status, body);
    return new Map((body.metrics ?? []).map((m) => [m.name, m]));
  }, [url]);
}

/** The charts of a tab, from one request for all their metrics. */
function ChartGrid({ charts, whole = false }: { charts: PackChartSpec[]; whole?: boolean }) {
  const { data, error } = useChartMetrics(charts);
  if (!charts.length) return null;
  if (error) return <ErrorState error={error} />;
  const results = data ?? new Map<string, MetricResult>();
  // A tab that is only charts, every one hidden from this role (each metric refused, 403): the status page that says
  // so (mold_v0-131), never an empty page.
  const refused = (c: PackChartSpec) => c.metrics.some((n) => { const r = results.get(n); return !!r && 'error' in r && r.status === 403; });
  if (whole && data && charts.every(refused)) return <StatusPage kind='denied' area='app' />;
  return (
    <div className='grid border-t border-l lg:grid-cols-2'>
      {charts.map((c) => <ChartCell key={`${c.pack}/${c.name}`} chart={c} results={results} />)}
    </div>
  );
}

/** An overview tab: its charts (one that includes setup is the home page: HomeTab). */
function OverviewTab({ tab }: { tab: PackTabSpec }) {
  const charts = tabCharts(tab);
  // Charts alone: every one refused is the denied status page (mold_v0-131), never an empty grid.
  if (!tab.include?.length) return <ChartGrid charts={charts} whole />;
  return (
    <div className='flex flex-col gap-8'>
      {tab.include.map((x) => <DueSoonSection key={x} />)}
      {charts.length > 0 && <ChartGrid charts={charts} />}
    </div>
  );
}

/**
 * A number chart as a card of the home page's right column (mold_v0-172: pack.json rail chart:<name>): its tiles, two
 * a row, and a link to the pack's overview tab that shows it beside the other charts, when there is one. Hidden from a
 * role that may not read one of its metrics, as on that tab.
 */
function ChartCard({ chart, home }: { chart: PackChartSpec; home: PackTabSpec }) {
  const charts = useMemo(() => [chart], [chart]);
  const { data, error } = useChartMetrics(charts);
  const results = data ?? new Map<string, MetricResult>();
  if (chart.metrics.some((n) => { const r = results.get(n); return !!r && 'error' in r && r.status === 403; })) return null;
  const more = packTabs.find((t) => t.pack === home.pack && t.kind === 'overview' && t.id !== home.id && t.charts.includes(chart.name));
  return (
    <FloatPanel title={chart.title} icon={<Icons.chartBar />} description={chart.description ?? undefined}>
      {error ? <ErrorState error={error} /> : <ChartTiles chart={chart} results={results} compact />}
      {more && <Link href={more.url} className='text-primary self-start text-xs font-medium hover:underline'>Open {more.label}</Link>}
    </FloatPanel>
  );
}

/**
 * The build's home (mold_v0-134, mold_v0-172): an overview tab that includes setup draws the Setup page's layout, the
 * same for every build. Its rail's cards follow the connection card (journeys, notices, chart:<name>); the notices it
 * includes and no card shows follow the checklist; its charts come below both columns (under its charts_title, when it
 * has one: mold_v0-175). It has no title of its own (the Setup page has none): its sections name themselves. It is drawn
 * at /app itself (mold_v0-175, web/src/app/app/page.tsx).
 */
function HomeTab({ tab }: { tab: PackTabSpec }) {
  const charts = tabCharts(tab);
  const rail = tab.rail;
  const notices = (tab.include ?? []).includes('notices');
  const cards: Record<string, React.ReactNode> = {};
  for (const x of rail ?? []) {
    if (x === 'notices') cards[x] = <DueSoonCard />;
    else if (x.startsWith('chart:')) {
      const c = packCharts.find((y) => y.pack === tab.pack && y.name === x.slice(6));
      if (c) cards[x] = <ChartCard chart={c} home={tab} />;
    }
  }
  return (
    <SetupPage rail={rail} cards={cards}
      main={notices && !(rail ?? []).includes('notices') ? <DueSoonSection /> : undefined}
      below={charts.length ? (tab.charts_title
        ? <section aria-labelledby='home-charts' className='mt-10 flex flex-col gap-4'><h2 id='home-charts' className='text-lg font-semibold tracking-tight'>{tab.charts_title}</h2><ChartGrid charts={charts} /></section>
        : <div className='mt-10'><ChartGrid charts={charts} /></div>) : undefined} />
  );
}

// ---------- the area views ----------

/** What an area view reads: the area as the tab shows it, where its rows come from, and how they are completed. */
type Source = { area: RecordAreaSpec; url: string; rows: (p: Page) => Page };

/** Up to 200 records of an area at once (a board or a timeline), and whether there are more. */
function useMany({ url: base, rows }: Source) {
  const url = `${base}?limit=200`;
  const loaded = useOrgLoad(() => getJson<Page>(url), [url]);
  return { ...loaded, data: loaded.data && rows(loaded.data) };
}

function BoardView({ src, by, detail, empty, merged }: { src: Source; by: string; detail: boolean; empty?: EmptySpec; merged: boolean }) {
  const { area } = src;
  const { data, error, reload } = useMany(src);
  const { role } = useAccountRole();
  const [moveError, setMoveError] = useState<string | null>(null);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.records.length) return <EmptyState empty={empty} id={`empty-${area.name}`} />;
  // Moves go through the generic data API (mold_v0-059: the record store's move, with its roles and transitions).
  // A merged tab's board only shows (its rows are several areas' records).
  const movable = !merged && area.scope === 'workspace' && area.lifecycle?.field === by;
  const onMove = async (key: string, to: string) => {
    setMoveError(null);
    const res = await fetch(`/api/data/${area.name}/${encodeURIComponent(key)}/move`, {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'X-Pack-Request': '1' }, body: JSON.stringify({ to })
    });
    if (!res.ok) setMoveError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The move failed (${res.status})`);
    await reload();
  };
  return (
    <div className='flex flex-col gap-2'>
      {moveError && <p role='alert' className='text-destructive text-sm'>{moveError}</p>}
      <BoardColumns area={area} by={by} detail={detail} data={data} role={role} onMove={movable ? (k, t) => void onMove(k, t) : undefined} />
    </div>
  );
}


function TimelineView({ src, by, badge, detail, empty }: { src: Source; by: string; badge: string | null; detail: boolean; empty?: EmptySpec }) {
  const { area } = src;
  const { data, error } = useMany(src);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  if (!data.records.length) return <EmptyState empty={empty} id={`empty-${area.name}`} />;
  return <TimelineList area={area} by={by} badge={badge} detail={detail} data={data} />;
}

const VIEW_LABELS = { table: 'Table', board: 'Board', timeline: 'Timeline' } as const;

function AreaTab({ tab }: { tab: PackTabSpec }) {
  const area = useMemo(() => viewArea(tab), [tab]);
  const src = useMemo(() => area && { area, url: tabRecordsUrl(tab, area), rows: (p: Page) => withSource(tab, p) }, [tab, area]);
  const views = (tab.views ?? ['table', 'detail']).filter((v): v is 'table' | 'board' | 'timeline' => v !== 'detail');
  const detail = (tab.views ?? ['table', 'detail']).includes('detail');
  const [view, setView] = useState<'table' | 'board' | 'timeline'>(views[0] ?? 'table');
  if (!area || !src) return <p className='text-muted-foreground text-sm'>This area is not in this build.</p>;
  const exportAreas = tab.areas ? tab.areas.map((a) => a.area) : [area.name];
  const table = !(view === 'board' && tab.board_by) && view !== 'timeline';
  return (
    <div className='flex flex-col gap-6'>
      <ChartGrid charts={tabCharts(tab)} />
      {/* The views' switch, and Export CSV for the board and the timeline (the table has its own, in its toolbar). */}
      {(views.length > 1 || !table) && (
      <div className='flex min-w-0 flex-wrap items-center justify-between gap-3'>
      {views.length > 1 ? (
        <div role='tablist' aria-label='Views' className='bg-muted text-muted-foreground inline-flex w-fit items-center rounded-lg p-[3px]'
          onKeyDown={(e) => {
            // Arrow keys move between the views, as a tab list does.
            const i = views.indexOf(view), d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            const v = views[(i + d + views.length) % views.length]!;
            setView(v);
            (e.currentTarget.querySelector(`[data-view='${v}']`) as HTMLElement | null)?.focus();
          }}>
          {views.map((v) => (
            <button key={v} type='button' role='tab' data-view={v} id={`view-tab-${v}`} aria-controls='view-panel' tabIndex={view === v ? 0 : -1}
              aria-selected={view === v} onClick={() => setView(v)}
              className={`rounded-md px-3 py-1 text-sm ${view === v ? 'bg-background text-foreground shadow-sm' : ''}`}>{VIEW_LABELS[v]}</button>
          ))}
        </div>
      ) : <span />}
        {!table && <ExportCsvButton url={src.url} area={area} rows={src.rows} name={`${tab.pack}-${tab.id}`} areas={exportAreas} />}
      </div>
      )}
      <div role={views.length > 1 ? 'tabpanel' : undefined} id='view-panel' aria-labelledby={views.length > 1 ? `view-tab-${view}` : undefined}>
      {view === 'board' && tab.board_by ? <BoardView src={src} by={tab.board_by} detail={detail} empty={tab.empty} merged={!!tab.areas} />
        : view === 'timeline' ? <TimelineView src={src} by={tab.timeline_by ?? 'updated'} badge={area.lifecycle?.field ?? (tab.areas ? tab.board_by ?? null : null)} detail={detail} empty={tab.empty} />
        : views.length ? (
          <RecordTableView area={area} base='app' url={src.url} rows={src.rows} id={`app-tab-${tab.pack}-${tab.id}`} open={detail} compact={!tab.charts.length}
            exportName={`${tab.pack}-${tab.id}`} exportAreas={exportAreas}
            empty={<div className='sticky left-0 max-w-[min(36rem,calc(100vw-5rem))] text-left sm:mx-auto'><EmptyState empty={tab.empty} id={`empty-${area.name}`} /></div>} />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A sections tab (mold_v0-175): its in-page tabs, each one of the pack's tabs (area, runs, reports, schedules) under its
 * own label, the ones this role may read; the selected one (?tab=<id>, the first by default) draws as its own page
 * would, below the strip.
 */
function SectionsTab({ tab, role }: { tab: PackTabSpec; role: string | null }) {
  const subs = (tab.sections ?? []).map((id) => packTabs.find((t) => t.pack === tab.pack && t.id === id))
    .filter((t): t is PackTabSpec => !!t && (role === null || t.roles.includes(role)));
  const [selected, setSelected] = useQueryState('tab', { defaultValue: subs[0]?.id ?? '' });
  const current = subs.find((t) => t.id === selected) ?? subs[0];
  if (!current) return null;
  return (
    <Tabs value={current.id} onValueChange={(v) => void setSelected(String(v))} className='gap-6'>
      <TabsList variant='line' className='gap-6 p-0'>
        {subs.map((t) => <TabsTrigger key={t.id} value={t.id} className='flex-none px-0'>{t.label}</TabsTrigger>)}
      </TabsList>
      <TabsContent value={current.id}>
        {current.kind === 'area' ? <AreaTab key={current.id} tab={current} />
          : current.kind === 'runs' || current.kind === 'reports' ? <RunsTable key={current.id} tab={current} reports={current.kind === 'reports'} />
          : current.kind === 'schedules' ? <SchedulesBody key={current.id} /> : null}
      </TabsContent>
    </Tabs>
  );
}

/** An overview tab that includes setup: the build's home page (mold_v0-134), every member's. */
export const isHomeTab = (tab: PackTabSpec) => tab.kind === 'overview' && (tab.include ?? []).includes('setup');

export function TabPage({ tab }: { tab: PackTabSpec }) {
  const { role, loaded, error } = useAccountRole();
  // The home page is every role's (src/pack-api.ts: such a tab takes no roles) and draws its own page: the Setup page's.
  if (isHomeTab(tab)) return <HomeTab tab={tab} />;
  // Nothing is asked of the server until the role is known (the server refuses what the role may not read anyway).
  const allowed = role === null || tab.roles.includes(role);
  return (
    <PageContainer pageTitle={tab.label} pageDescription={tab.description ?? undefined}>
      {/* /me refused (no account, suspended, signed out) or a role the tab is not for: the status page (mold_v0-131). */}
      {error && !loaded ? <ErrorState error={error} /> : !loaded ? <LoadingCards count={1} /> : !allowed ? <StatusPage kind='denied' area='app' />
        : tab.kind === 'overview' ? <OverviewTab tab={tab} />
        : tab.kind === 'area' ? <AreaTab tab={tab} />
        : tab.kind === 'sections' ? <SectionsTab tab={tab} role={role} />
        : tab.kind === 'runs' || tab.kind === 'reports' ? <RunsTable tab={tab} reports={tab.kind === 'reports'} />
        : null}
    </PageContainer>
  );
}
