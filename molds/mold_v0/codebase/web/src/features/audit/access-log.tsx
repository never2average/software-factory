'use client';
// The access log (mold_v0-197; src/audit-trail.ts): the audit trails on the records pages' own table (mold_v0-205). Each
// trail is a read-only system area (no pack declares it, nothing writes it from here) drawn by RecordTableView, the
// component every record area's page and tab draws, through its data adapter (features/records/record-pages.tsx
// RecordSource): the search row with the trail's four cards under it (the list tabs' order, cards above search where the
// table draws them so), an Action and an Actor column on both trails (mold_v0-209: what was done, and who did it in words,
// from the server: src/audit-trail.ts actorLabel, platformAction; each filtered and sorted, both in the CSV and the
// drawer) (GET /api/audit/<trail>/sparklines), filters on
// who, action, area, door and the date range, the column picker, Download CSV (the server's own file: every entry,
// not only the loaded pages) and a row drawer with the entry's details. Billing's Access log tab (/app/billing?tab=access-log,
// mold_v0-209; features/portal/billing.tsx) is one workspace's, for its owners (GET /api/audit/data, /api/audit/platform:
// its data trail and its slice of the platform trail);
// /admin/access-log is the platform trail fleet-wide and any workspace's data trail, for platform staff
// (GET /api/admin/audit/*). Never a record's values: the trails hold none.
// One table, no tabs (mold_v0-270): with both trails on, both are one list, newest first, with a Kind column (Platform
// call / Data access) filtered in the Filter menu, both trails' four cards above the search row, and Download CSV of
// both (GET .../all.csv); with one trail on, that trail's table, without the Kind column. Staff see every workspace's
// entries of both trails (a Workspace column, filtered like the rest).
import { useMemo } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { LIST_MAX, RecordTableView, type RecordRow, type RecordSource } from '@/features/records/record-pages';
import { Sparklines } from '@/features/tabs/sparklines';
import { useAccountRole } from '@/features/portal/role';
import { dataTrailOn, platformTrailOn } from './config';

interface DataEntry { seq: number; at: string; actor_kind: string; actor_id: string | null; key_id: number | null; action: string; actor: string; target: string; pack: string | null; area: string | null; record_key: string | null; rows: number | null; channel: string }
interface PlatformEntry { seq: number; at: string; org_id: number | null; workspace: string | null; kind: string; action: string; actor: string; channel: string; method: string; path: string; key_id: number | null; key_prefix: string | null;
  actor_kind: string; actor_id: string | null; scopes: string[]; status: number | null; latency_ms: number | null; ip?: string | null }
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
const CHANNELS = opts(['console', 'api', 'mcp', 'admin_console', 'admin_mcp', 'run', 'system']);
const ACTOR_KINDS = opts(['user', 'key', 'staff', 'agent_run', 'system']);
const f = (name: string, label: string, type: string, extra: Partial<RecordFieldSpec> = {}): RecordFieldSpec => ({ name, label, type, ...extra });
/** A trail as a read-only system area: its fields typed as an area's are (an enum filters by its values). */
const systemArea = (name: string, label: string, fields: RecordFieldSpec[], list: string[]): RecordAreaSpec =>
  ({ pack: '_system', name, label, description: null, icon: 'shield', role: 'source', scope: 'workspace', fields, list_columns: list, links: [], lifecycle: null });

const DATA_AREA = systemArea('access_log', 'Access log', [
  f('action', 'Action', 'enum', { options: ['list', 'read', 'reveal', 'export', 'create', 'update', 'move', 'delete'] }),
  f('actor', 'Actor', 'enum'),
  f('area', 'Area', 'enum'),
  f('record_key', 'Record or file', 'text'),
  f('rows', 'Rows', 'number'),
  f('channel', 'Through', 'enum', { options: CHANNELS }),
  f('target', 'Target', 'enum', { options: ['record', 'file', 'run_result'] }),
  f('pack', 'Pack', 'enum'),
  f('actor_kind', 'Actor kind', 'enum', { options: ACTOR_KINDS }),
  f('key_id', 'Key', 'text'),
], ['action', 'actor', 'area', 'record_key', 'rows', 'channel']);
const dataRow = (e: DataEntry & { workspace?: string | null }): RecordRow => ({
  key: `#${e.seq}${e.workspace ? ` · ${e.workspace}` : ''}`, title: when(e.at), updated_at: e.at,
  data: { at: e.at, ...(e.workspace !== undefined ? { workspace: e.workspace } : {}), action: e.action, actor: e.actor, area: e.area, record_key: e.record_key, rows: e.rows, channel: e.channel,
    target: e.target, pack: e.pack, actor_kind: e.actor_kind, key_id: e.key_id == null ? null : `#${e.key_id}` }
});

const platformArea = (fleet: boolean) => systemArea(fleet ? 'platform_trail' : 'request_log', 'Requests', [
  ...(fleet ? [f('workspace', 'Workspace', 'enum')] : []),
  f('action', 'Action', 'enum', { options: opts(['read', 'change', 'delete', 'tool call', 'MCP request', 'sign-in', 'check']) }),
  f('actor', 'Actor', 'enum'),
  f('request', 'Request', 'text'),
  f('key', 'Key', 'text'),
  f('status', 'Result', 'number'),
  f('latency_ms', 'Latency (ms)', 'number'),
  f('channel', 'Through', 'enum', { options: CHANNELS }),
  f('scopes', 'Scopes', 'text'),
  f('actor_kind', 'Actor kind', 'enum', { options: ACTOR_KINDS }),
  ...(fleet ? [f('ip', 'Address', 'text')] : []),
], [...(fleet ? ['workspace'] : []), 'action', 'actor', 'request', 'key', 'status', 'latency_ms']);
const platformRow = (e: PlatformEntry): RecordRow => ({
  key: `#${e.seq}${e.ip !== undefined && e.workspace ? ` · ${e.workspace}` : ''}`, title: when(e.at), updated_at: e.at,
  data: { at: e.at, workspace: e.workspace, action: e.action, actor: e.actor, request: `${e.method} ${e.path}`, key: e.key_prefix ? `${e.key_prefix}…` : null,
    status: e.status, latency_ms: e.latency_ms, channel: e.channel, scopes: e.scopes.join(', ') || null, actor_kind: e.actor_kind, ...(e.ip !== undefined ? { ip: e.ip } : {}) }
});

function CsvLink({ href }: { href: string }) {
  return <Button variant='outline' size='sm' render={<a href={href} download />}>Download CSV</Button>;
}

/** Both trails as one list (mold_v0-270): each trail's newest LIST_MAX entries, tagged with their kind, newest first. */
async function loadBoth(dataUrl: string, platformUrl: string) {
  const tag = (kind: string, prefix: string) => (r: RecordRow): RecordRow => ({ ...r, key: `${prefix} ${r.key}`, data: { ...r.data, kind } });
  const [d, p] = await Promise.all([loadAll(dataUrl, (e: DataEntry) => tag('Data access', 'Data')(dataRow(e))), loadAll(platformUrl, (e: PlatformEntry) => tag('Platform call', 'Call')(platformRow(e)))]);
  const all = [...d.records, ...p.records].sort((x, y) => String(y.data.at).localeCompare(String(x.data.at)));
  return { records: all.slice(0, LIST_MAX), more: d.more || p.more || all.length > LIST_MAX };
}

/** Both trails' fields on one area: Kind first, then what both have (Action, Actor), then each trail's own. */
const bothArea = (fleet: boolean) => systemArea(fleet ? 'access_log_fleet' : 'access_log_both', 'Access log', [
  f('kind', 'Kind', 'enum', { options: opts(['Platform call', 'Data access']) }),
  ...(fleet ? [f('workspace', 'Workspace', 'enum')] : []),
  f('action', 'Action', 'enum', { options: opts(['read', 'change', 'delete', 'tool call', 'MCP request', 'sign-in', 'check', 'list', 'reveal', 'export', 'create', 'update', 'move']) }),
  f('actor', 'Actor', 'enum'),
  f('request', 'Request', 'text'),
  f('area', 'Area', 'enum'),
  f('record_key', 'Record or file', 'text'),
  f('status', 'Result', 'number'),
  f('rows', 'Rows', 'number'),
  f('latency_ms', 'Latency (ms)', 'number'),
  f('channel', 'Through', 'enum', { options: CHANNELS }),
  f('key', 'Key', 'text'),
  f('key_id', 'Key number', 'text'),
  f('target', 'Target', 'enum', { options: ['record', 'file', 'run_result'] }),
  f('pack', 'Pack', 'enum'),
  f('scopes', 'Scopes', 'text'),
  f('actor_kind', 'Actor kind', 'enum', { options: ACTOR_KINDS }),
  ...(fleet ? [f('ip', 'Address', 'text')] : []),
], ['kind', ...(fleet ? ['workspace'] : []), 'action', 'actor', 'request', 'area', 'record_key', 'status']);
const BOTH_HIDDEN = ['rows', 'latency_ms', 'channel', 'key', 'key_id', 'target', 'pack', 'scopes', 'actor_kind'];

/** The trail(s) on the records table: the rows through the data adapter, the four cards above the search row. */
function TrailTable({ area, base, url, load, csv, cards, hidden, noun, id }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; url: string; load: () => Promise<{ records: RecordRow[]; more: boolean }>; csv: string; cards: string; hidden: string[]; noun: string; id: string;
}) {
  const source = useMemo<RecordSource>(() => ({
    key: url, load, primary: <CsvLink href={csv} />, noun, hidden, updated: false,
    title: { label: 'When', type: 'date', value: (r) => String(r.data.at ?? r.updated_at) }, defaultSort: [{ key: '_record', dir: 'desc' }]
  }), [url, load, csv, noun, hidden]);
  return (
    <RecordTableView key={url} area={area} base={base} url={url} id={id} open={false} source={source}
      summary={<Sparklines url={cards} tag={`audit/${area.name}`} />}
      empty={<p className='text-muted-foreground py-10 text-center text-sm'>Nothing here yet.</p>} />
  );
}

const DATA_HIDDEN = ['target', 'pack', 'actor_kind', 'key_id'];
const PLATFORM_HIDDEN = ['channel', 'scopes', 'actor_kind'];
const PLATFORM_HIDDEN_FLEET = [...PLATFORM_HIDDEN, 'ip'];

/** Which table a page draws: both trails as one (with Kind), or the one trail that is on. */
function AccessTable({ api, base, fleet, idPrefix }: { api: string; base: 'app' | 'admin'; fleet: boolean; idPrefix: string }) {
  const both = dataTrailOn() && platformTrailOn();
  const area = useMemo(() => (both ? bothArea(fleet) : dataTrailOn() ? DATA_AREA : platformArea(fleet)), [both, fleet]);
  const load = useMemo(() => (both ? () => loadBoth(`${api}/data`, `${api}/platform`)
    : dataTrailOn() ? () => loadAll(`${api}/data`, dataRow) : () => loadAll(`${api}/platform`, platformRow)), [both, api]);
  if (both)
    return <TrailTable area={area} base={base} url={`${api}/all`} load={load} csv={`${api}/all.csv`} cards={`${api}/all/sparklines`}
      hidden={[...BOTH_HIDDEN, ...(fleet ? ['ip'] : [])]} noun='entries' id={`${idPrefix}-access-log`} />;
  return dataTrailOn()
    ? <TrailTable area={area} base={base} url={`${api}/data`} load={load} csv={`${api}/data.csv`} cards={`${api}/data/sparklines`}
        hidden={DATA_HIDDEN} noun='entries' id={`${idPrefix}-access-log-data`} />
    : <TrailTable area={area} base={base} url={`${api}/platform`} load={load} csv={`${api}/platform.csv`} cards={`${api}/platform/sparklines`}
        hidden={fleet ? PLATFORM_HIDDEN_FLEET : PLATFORM_HIDDEN} noun='requests' id={`${idPrefix}-access-log-platform`} />;
}

/** Billing's Access log tab (mold_v0-209): this workspace's trails, for its owners. No page title of its own (the tab
 *  strip is the page's heading) and no description above the list (mold_v0-231); one table (mold_v0-270). The trails'
 *  addresses: /api/audit/data/sparklines, /api/audit/platform/sparklines, /api/audit/all/sparklines. */
export function WorkspaceAccessLog() {
  const { role, loaded } = useAccountRole();
  if (!loaded) return null;
  if (role !== 'owner') return <p className='text-muted-foreground text-sm'>Only the workspace&apos;s owners read its access log.</p>;
  return <AccessTable api='/api/audit' base='app' fleet={false} idPrefix='app' />;
}

/** /admin/access-log: both trails across every workspace, one table (mold_v0-270). A list page (mold_v0-231): no title
 *  or description above it; the cards, the search row, the table. The trails' addresses: /api/admin/audit/platform/sparklines,
 *  /api/admin/audit/data/sparklines, /api/admin/audit/all/sparklines. */
export function OperatorAccessLogPage() {
  return (
    <PageContainer>
      <AccessTable api='/api/admin/audit' base='admin' fleet idPrefix='admin' />
    </PageContainer>
  );
}
