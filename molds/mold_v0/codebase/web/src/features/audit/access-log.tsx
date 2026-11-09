'use client';
// The access log (mold_v0-197; src/audit-trail.ts): the audit trails on the records pages' own table (mold_v0-205),
// drawn by RecordTableView (features/records/record-pages.tsx) through its data adapter (RecordSource) over a read-only
// system area (no pack declares it). mold_v0-286: a plain activity feed. Columns When, Who, What, Workspace (staff only)
// and Result, every one in words from the server (src/audit-words.ts: who by name and email from the sign-in directory,
// a key by its name and owner, "Agent run for <email>", "Staff · <email>", System; what as one sentence; OK, Refused,
// Failed or Not found). No kind, no internal id or sequence in the table: each row's key is hidden. A row opens the
// shared side panel (mold_v0-278) with the sentence, the request that did it (its masked headers and JSON payload, a
// copy button; GET .../entry/<trail>/...: src/audit-trail.ts readTrailEntry) and a collapsed Technical details
// section (method, path, key prefix, latency, address, door, ids). Each row's ⋯ menu and the panel's have Export
// entry (that entry as JSON, masked as stored). Filters on who, what, workspace and the date range; the four cards
// above the search row (GET .../all/sparklines, or the one trail's); Download CSV (the server's file: every entry,
// every field, plus who, name, email, what and result).
// Billing's Access log tab (/app/billing?tab=access-log, mold_v0-209; features/portal/billing.tsx) is one workspace's,
// for its owners (GET /api/audit/data, /api/audit/platform); /admin/access-log is every workspace's, for platform staff
// (GET /api/admin/audit/*). With both trails on, both are one list, newest first (mold_v0-270).
import { useEffect, useMemo, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Field } from '@/components/layout/record-view';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { LIST_MAX, RecordTableView, type RecordRow, type RecordSource } from '@/features/records/record-pages';
import { CopyButton } from '@/features/portal/shared';
import { EmptyState } from '@/features/tabs/empty';
import { Sparklines } from '@/features/tabs/sparklines';
import { useAccountRole } from '@/features/portal/role';
import { dataTrailOn, platformTrailOn } from './config';

interface Who { label: string; name: string | null; email: string | null }
interface Plain { who?: Who; what?: string; result?: string; workspace_name?: string | null; has_request?: boolean }
interface DataEntry extends Plain { seq: number; at: string; org_id?: number; workspace?: string | null; actor_kind: string; actor_id: string | null; key_id: number | null; action: string; actor: string; target: string;
  pack: string | null; area: string | null; area_label?: string | null; record_key: string | null; title?: string | null; rows: number | null; channel: string }
interface PlatformEntry extends Plain { seq: number; scope_id?: number; at: string; org_id: number | null; workspace: string | null; kind: string; action: string; actor: string; channel: string; method: string; path: string;
  key_id: number | null; key_prefix: string | null; actor_kind: string; actor_id: string | null; scopes: string[]; status: number | null; latency_ms: number | null; ip?: string | null }
type Entry = ({ trail: 'data' } & DataEntry) | ({ trail: 'platform' } & PlatformEntry);
type Page<T> = { entries: T[]; next: number | string | null };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}
/** The newest LIST_MAX entries (pages of 500, the API's most), as the records table's rows. */
async function loadAll<T>(url: string, row: (e: T) => RecordRow): Promise<{ records: RecordRow[]; more: boolean }> {
  const entries: T[] = [];
  let before: number | string | null = null;
  for (;;) {
    const page: Page<T> = await getJson<Page<T>>(`${url}${url.includes('?') ? '&' : '?'}limit=500${before !== null ? `&before=${encodeURIComponent(String(before))}` : ''}`);
    entries.push(...page.entries);
    if (!page.next || entries.length >= LIST_MAX) return { records: entries.slice(0, LIST_MAX).map(row), more: !!page.next || entries.length > LIST_MAX };
    before = page.next;
  }
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
const opts = (xs: string[]) => xs.map((value) => ({ value }));
const f = (name: string, label: string, type: string, extra: Partial<RecordFieldSpec> = {}): RecordFieldSpec => ({ name, label, type, ...extra });
const RESULTS = opts(['OK', 'Refused', 'Failed', 'Not found']);
const DOORS: Record<string, string> = { console: 'Console', api: 'API', mcp: 'AI client (MCP)', admin_console: 'Staff console', admin_mcp: 'Staff AI client', run: 'Agent run', system: 'System' };

/** The Access log as a read-only system area: When (the first column), then Who, What, Workspace (staff) and Result. */
const accessArea = (fleet: boolean): RecordAreaSpec => ({
  pack: '_system', name: fleet ? 'access_log_fleet' : 'access_log', label: 'Access log', description: null, icon: 'shield', role: 'source', scope: 'workspace',
  fields: [
    f('who', 'Who', 'enum'),
    f('what', 'What', 'text'),
    ...(fleet ? [f('workspace', 'Workspace', 'enum')] : []),
    f('result', 'Result', 'enum', { options: RESULTS }),
    f('door', 'Through', 'enum', { options: opts(Object.values(DOORS)) }),
  ],
  list_columns: ['who', 'what', ...(fleet ? ['workspace'] : []), 'result'], links: [], lifecycle: null
});
const HIDDEN = ['door'];

/** One entry as a row: a hidden key (never shown), the time as its title, the plain words as its cells. */
const rowOf = (e: Entry): RecordRow => ({
  key: e.trail === 'data' ? `d-${e.org_id ?? 0}-${e.seq}` : `p-${e.scope_id ?? 0}-${e.seq}`, title: when(e.at), updated_at: e.at,
  data: { at: e.at, who: e.who?.label ?? e.actor, email: e.who?.email ?? null, what: e.what ?? e.action, workspace: e.workspace_name ?? e.workspace ?? null,
    result: e.result ?? 'OK', door: DOORS[e.channel] ?? e.channel, entry: e }
});
const entryOf = (r: RecordRow) => r.data.entry as Entry;

/** The entry's own address: the side panel's request and Export entry. */
const entryUrl = (api: string, e: Entry, fleet: boolean) => (e.trail === 'data'
  ? `${api}/entry/data/${fleet ? `${e.org_id ?? 0}/` : ''}${e.seq}`
  : `${api}/entry/platform/${fleet ? `${e.scope_id ?? 0}/` : ''}${e.seq}`);

/** Downloads one entry as JSON: everything the panel shows, the request masked as stored. */
async function exportEntry(api: string, e: Entry, fleet: boolean) {
  const { entry } = await getJson<{ entry: unknown }>(entryUrl(api, e, fleet));
  const blob = new Blob([`${JSON.stringify(entry, null, 2)}\n`], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `access-log-entry-${e.at.slice(0, 19).replace(/[:T]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

interface RequestView { method?: string; path?: string; headers?: Record<string, string>; body?: unknown; tools?: { name: string; arguments: unknown }[]; truncated?: boolean; note?: string; withheld?: string; request_id?: string }

/** The side panel's body: the sentence, the request (masked headers, the JSON payload, copy), then Technical details. */
function EntryPanel({ row, api, fleet }: { row: RecordRow; api: string; fleet: boolean }) {
  const e = entryOf(row);
  const [req, setReq] = useState<{ request: RequestView | null } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    setReq(null);
    if (!e.has_request) { setReq({ request: null }); return; }
    getJson<{ entry: { request: RequestView | null } }>(entryUrl(api, e, fleet))
      .then((d) => live && setReq({ request: d.entry.request }), (err: Error) => live && setReq({ error: err.message }));
    return () => { live = false; };
  }, [api, e, fleet]);
  const r = req && 'request' in req ? req.request : null;
  const payload = r ? JSON.stringify(r.tools?.length ? { tools: r.tools, body: r.body } : r.body ?? null, null, 2) : '';
  const tech: [string, unknown][] = e.trail === 'platform'
    ? [['Method', e.method], ['Path', e.path], ['Key prefix', e.key_prefix ? `${e.key_prefix}…` : null], ['Latency', e.latency_ms != null ? `${e.latency_ms} ms` : null],
      ['Status code', e.status], ['Address', e.ip], ['Through', e.channel], ['Entry type', e.kind], ['Scopes', e.scopes.join(', ') || null], ['Actor', `${e.actor_kind}${e.actor_id ? ` ${e.actor_id}` : ''}`],
      ['Key id', e.key_id], ['Workspace', e.workspace ? `${e.workspace} (${e.org_id})` : null], ['Entry', `platform trail, scope ${e.scope_id ?? '?'}, #${e.seq}`], ['Request id', r?.request_id ?? null]]
    : [['Action', e.action], ['Target', e.target], ['Pack', e.pack], ['Area', e.area], ['Record key', e.record_key], ['Rows', e.rows], ['Through', e.channel],
      ['Actor', `${e.actor_kind}${e.actor_id ? ` ${e.actor_id}` : ''}`], ['Key id', e.key_id], ['Workspace', e.workspace ? `${e.workspace} (${e.org_id})` : e.org_id ?? null],
      ['Entry', `data trail, #${e.seq}`], ['Request id', r?.request_id ?? null]];
  return (
    <div className='flex flex-col gap-4' data-access-entry=''>
      <p className='text-sm leading-relaxed'>{e.what}</p>
      <section className='flex flex-col gap-2' aria-label='Request'>
        <div className='flex items-center justify-between gap-2'>
          <h3 className='text-sm font-medium'>Request</h3>
          {r && !r.withheld && <CopyButton text={payload} label='Copy payload' />}
        </div>
        {!req && <p className='text-muted-foreground text-xs'>Loading…</p>}
        {req && 'error' in req && <p className='text-destructive text-xs'>{req.error}</p>}
        {req && 'request' in req && !r && <p className='text-muted-foreground text-xs'>No request was kept for this entry (made by the system, or before requests were kept).</p>}
        {r?.withheld && <p className='text-muted-foreground text-xs'>{r.withheld}</p>}
        {r && !r.withheld && (<>
          {r.method && <p className='font-mono text-xs break-all'>{r.method} {r.path}</p>}
          {r.headers && Object.keys(r.headers).length > 0 && (
            <dl className='bg-muted/40 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md p-2 font-mono text-xs'>
              {Object.entries(r.headers).map(([k, v]) => <div key={k} className='contents'><dt className='text-muted-foreground'>{k}</dt><dd className='break-all'>{v}</dd></div>)}
            </dl>
          )}
          <pre className='bg-muted/40 max-h-80 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-all'>{payload}</pre>
          {r.note && <p className='text-muted-foreground text-xs'>{r.note}</p>}
          <p className='text-muted-foreground text-xs'>Secrets, sign-in codes, file contents and sealed or encrypted fields are masked (••••) before anything is kept.</p>
        </>)}
      </section>
      <details className='rounded-md border p-2' data-technical-details=''>
        <summary className='cursor-pointer text-sm font-medium'>Technical details</summary>
        <dl className='mt-2'>
          {tech.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <Field key={k} label={k}><span className='font-mono text-xs break-all'>{String(v)}</span></Field>)}
        </dl>
      </details>
    </div>
  );
}

/** Both trails, or the one that is on, as one list, newest first (mold_v0-270). */
async function loadEntries(api: string) {
  const parts = await Promise.all([
    ...(dataTrailOn() ? [loadAll(`${api}/data`, (e: DataEntry) => rowOf({ ...e, trail: 'data' }))] : []),
    ...(platformTrailOn() ? [loadAll(`${api}/platform`, (e: PlatformEntry) => rowOf({ ...e, trail: 'platform' }))] : [])
  ]);
  const all = parts.flatMap((p) => p.records).sort((x, y) => String(y.data.at).localeCompare(String(x.data.at)));
  return { records: all.slice(0, LIST_MAX), more: parts.some((p) => p.more) || all.length > LIST_MAX };
}

function CsvLink({ href }: { href: string }) {
  return <Button variant='outline' size='sm' render={<a href={href} download />}>Download CSV</Button>;
}

/** The access log on the records table: the rows through the data adapter, the four cards above the search row. */
function TrailTable({ api, base, fleet, id }: { api: string; base: 'app' | 'admin'; fleet: boolean; id: string }) {
  const both = dataTrailOn() && platformTrailOn();
  const which = both ? 'all' : dataTrailOn() ? 'data' : 'platform';
  const area = useMemo(() => accessArea(fleet), [fleet]);
  const csv = `${api}/${which}.csv`, cards = `${api}/${which}/sparklines`;
  const source = useMemo<RecordSource>(() => ({
    key: `${api}/${which}`, load: () => loadEntries(api), primary: <CsvLink href={csv} />, noun: 'entries', hidden: HIDDEN, updated: false,
    title: { label: 'When', type: 'date', value: (r) => String(r.data.at ?? r.updated_at) }, defaultSort: [{ key: '_record', dir: 'desc' }],
    render: (r) => <span className='text-sm whitespace-nowrap tabular-nums'>{r.title}</span>,
    detailTitle: (r) => String(r.data.what ?? ''),
    detail: (r) => <EntryPanel row={r} api={api} fleet={fleet} />,
    actions: (r) => [{ label: 'Export entry', icon: <Icons.download />, onSelect: () => void exportEntry(api, entryOf(r), fleet).catch(() => undefined) }]
  }), [api, which, csv, fleet]);
  return (
    <RecordTableView key={source.key} area={area} base={base} url={source.key} id={id} open={false} source={source}
      summary={<Sparklines url={cards} tag={`audit/${area.name}`} />}
      empty={<EmptyState empty={{ title: 'No activity yet.', text: 'Sign-ins, page visits, tool calls and record changes show here as they happen.', cta: null }} id={`${id}-empty`} />} />
  );
}

/** Billing's Access log tab (mold_v0-209): this workspace's trails, for its owners. No page title of its own (the tab
 *  strip is the page's heading) and no description above the list (mold_v0-231); one table (mold_v0-270). The trails'
 *  addresses: /api/audit/data/sparklines, /api/audit/platform/sparklines, /api/audit/all/sparklines. */
export function WorkspaceAccessLog() {
  const { role, loaded } = useAccountRole();
  if (!loaded) return null;
  if (role !== 'owner') return <p className='text-muted-foreground text-sm'>Only the workspace&apos;s owners read its access log.</p>;
  return <TrailTable api='/api/audit' base='app' fleet={false} id='app-access-log' />;
}

/** /admin/access-log: both trails across every workspace, one table (mold_v0-270). A list page (mold_v0-231): no title
 *  or description above it; the cards, the search row, the table. The trails' addresses: /api/admin/audit/platform/sparklines,
 *  /api/admin/audit/data/sparklines, /api/admin/audit/all/sparklines. */
export function OperatorAccessLogPage() {
  return (
    <PageContainer>
      <TrailTable api='/api/admin/audit' base='admin' fleet id='admin-access-log' />
    </PageContainer>
  );
}
