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
import { Field, type RowAction } from '@/components/layout/record-view';
import { Icons } from '@/components/icons';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { LIST_MAX, RecordTableView, type RecordRow, type RecordSource } from '@/features/records/record-pages';
import { toast } from 'sonner';
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

/** The masked request's JSON as the panel shows it (and Copy payload copies): its tool calls and body. */
const payloadOf = (r: RequestView) => JSON.stringify(r.tools?.length ? { tools: r.tools, body: r.body } : r.body ?? null, null, 2);

/** Copy payload (the row's and the panel's ⋯ menu): the entry's masked request, fetched, onto the clipboard. */
async function copyPayload(api: string, e: Entry, fleet: boolean) {
  if (!e.has_request) { toast.message('No request was kept for this entry.'); return; }
  const { entry } = await getJson<{ entry: { request: RequestView | null } }>(entryUrl(api, e, fleet));
  const r = entry.request;
  if (!r || r.withheld) { toast.message(r?.withheld ?? 'No request was kept for this entry.'); return; }
  await navigator.clipboard.writeText(payloadOf(r));
  toast.success('Payload copied');
}

/**
 * The side panel's body: one card (operator, 2026-11-09), every fact a row of one list: the plain words, then the
 * request's technical facts, its masked headers and its JSON payload. Copy payload and Export entry are in the ⋯ menu.
 */
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
  const who = row.data.email && row.data.email !== row.data.who ? `${row.data.who} (${row.data.email})` : row.data.who;
  const facts: [string, unknown][] = [['When', row.title], ['Who', who], ['What', e.what], ['Workspace', row.data.workspace], ['Result', row.data.result], ['Through', row.data.door],
    ...(e.trail === 'platform'
      ? [['Method', e.method], ['Path', e.path], ['Status code', e.status], ['Latency', e.latency_ms != null ? `${e.latency_ms} ms` : null], ['Address', e.ip],
        ['Key', e.key_prefix ? `${e.key_prefix}…` : null], ['Scopes', e.scopes.join(', ') || null]] as [string, unknown][]
      : [['Area', e.area], ['Record', e.record_key], ['Rows', e.rows]] as [string, unknown][]),
    ['Request ID', r?.request_id ?? null]];
  const mono = (v: unknown) => <span className='font-mono text-xs break-all'>{String(v)}</span>;
  return (
    <dl data-access-entry=''>
      {facts.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <Field key={k} label={k}>{['Method', 'Path', 'Address', 'Key', 'Request ID', 'Status code'].includes(k) ? mono(v) : String(v)}</Field>
      ))}
      {!req && <Field label='Request'><span className='text-muted-foreground text-xs'>Loading…</span></Field>}
      {req && 'error' in req && <Field label='Request'><span className='text-destructive text-xs'>{req.error}</span></Field>}
      {req && 'request' in req && !r && <Field label='Request'><span className='text-muted-foreground text-xs'>None kept (made by the system, or before requests were kept)</span></Field>}
      {r?.withheld && <Field label='Request'><span className='text-muted-foreground text-xs'>{r.withheld}</span></Field>}
      {/* Each header its own row of the card: its name in the label column, its (masked) value beside it, two columns. */}
      {r && !r.withheld && r.headers && Object.entries(r.headers).map(([k, v]) => (
        <Field key={`h:${k}`} label={k}>{mono(v)}</Field>
      ))}
      {r && !r.withheld && (
        <Field label='Payload'>
          <pre className='max-h-80 overflow-auto font-mono text-xs leading-snug whitespace-pre-wrap break-all'>{payloadOf(r)}</pre>
          {r.note && <span className='text-muted-foreground mt-1 block text-xs'>{r.note}</span>}
        </Field>
      )}
    </dl>
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

/** Download logs, an item of the list's Actions ▾ menu (mold_v0-294): the file is the same CSV, every entry. */
function csvItem(href: string): RowAction {
  // Operator, 2026-11-09: the spreadsheet icon and "Download logs".
  return { label: 'Download logs', icon: <Icons.spreadsheet />, testId: 'download-logs', onSelect: () => { const a = document.createElement('a'); a.href = href; a.download = ''; document.body.append(a); a.click(); a.remove(); } };
}

/** The access log on the records table: the rows through the data adapter, the four cards above the search row. */
function TrailTable({ api, base, fleet, id }: { api: string; base: 'app' | 'admin'; fleet: boolean; id: string }) {
  const both = dataTrailOn() && platformTrailOn();
  const which = both ? 'all' : dataTrailOn() ? 'data' : 'platform';
  const area = useMemo(() => accessArea(fleet), [fleet]);
  const csv = `${api}/${which}.csv`, cards = `${api}/${which}/sparklines`;
  const source = useMemo<RecordSource>(() => ({
    key: `${api}/${which}`, load: () => loadEntries(api), exports: [csvItem(csv)], noun: 'entries', hidden: HIDDEN, updated: false,
    title: { label: 'When', type: 'date', value: (r) => String(r.data.at ?? r.updated_at) }, defaultSort: [{ key: '_record', dir: 'desc' }],
    render: (r) => <span className='text-sm whitespace-nowrap tabular-nums'>{r.title}</span>,
    detailTitle: (r) => String(r.data.what ?? ''),
    detail: (r) => <EntryPanel row={r} api={api} fleet={fleet} />, properties: false,
    actions: (r) => [
      { label: 'Copy payload', icon: <Icons.copy />, onSelect: () => void copyPayload(api, entryOf(r), fleet).catch(() => toast.error('Could not copy the payload')) },
      { label: 'Export entry', icon: <Icons.download />, onSelect: () => void exportEntry(api, entryOf(r), fleet).catch(() => undefined) }]
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
