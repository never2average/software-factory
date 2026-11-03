'use client';
// The access log (mold_v0-197; src/audit-trail.ts): the audit trails on the records pages' own table (mold_v0-205). Each
// trail is a read-only system area (no pack declares it, nothing writes it from here) drawn by RecordTableView, the
// component every record area's page and tab draws, through its data adapter (features/records/record-pages.tsx
// RecordSource): the search row with the trail's four cards under it (GET /api/audit/<trail>/sparklines), filters on
// who, action, area, door and the date range, the column picker, Download CSV (the server's own file: every entry,
// not only the loaded pages) and a row drawer with the entry's details. Billing's Access log tab (/app/billing?tab=access-log,
// mold_v0-209; features/portal/billing.tsx) is one workspace's, for its owners (GET /api/audit/data, /api/audit/platform:
// its data trail and its slice of the platform trail);
// /admin/access-log is the platform trail fleet-wide and any workspace's data trail, for platform staff
// (GET /api/admin/audit/*). Never a record's values: the trails hold none.
import { useEffect, useMemo, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RecordAreaSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { LIST_MAX, RecordTableView, type RecordRow, type RecordSource } from '@/features/records/record-pages';
import { Sparklines } from '@/features/tabs/sparklines';
import { useAccountRole } from '@/features/portal/role';
import { dataTrailOn, platformTrailOn } from './config';

interface DataEntry { seq: number; at: string; actor_kind: string; actor_id: string | null; key_id: number | null; action: string; target: string; pack: string | null; area: string | null; record_key: string | null; rows: number | null; channel: string }
interface PlatformEntry { seq: number; at: string; org_id: number | null; workspace: string | null; kind: string; channel: string; method: string; path: string; key_id: number | null; key_prefix: string | null;
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
const who = (kind: string, id: string | null) => (kind === 'system' ? 'System' : kind === 'agent_run' ? `Agent run ${id ?? ''}` : id ?? kind);
const opts = (xs: string[]) => xs.map((value) => ({ value }));
const CHANNELS = opts(['console', 'api', 'mcp', 'admin_console', 'admin_mcp', 'run', 'system']);
const ACTOR_KINDS = opts(['user', 'key', 'staff', 'agent_run', 'system']);
const f = (name: string, label: string, type: string, extra: Partial<RecordFieldSpec> = {}): RecordFieldSpec => ({ name, label, type, ...extra });
/** A trail as a read-only system area: its fields typed as an area's are (an enum filters by its values). */
const systemArea = (name: string, label: string, fields: RecordFieldSpec[], list: string[]): RecordAreaSpec =>
  ({ pack: '_system', name, label, description: null, role: 'source', scope: 'workspace', fields, list_columns: list, links: [], lifecycle: null });

const DATA_AREA = systemArea('access_log', 'Access log', [
  f('actor', 'Who', 'enum'),
  f('action', 'Action', 'enum', { options: ['list', 'read', 'reveal', 'export', 'create', 'update', 'move', 'delete'] }),
  f('area', 'Area', 'enum'),
  f('record_key', 'Record or file', 'text'),
  f('rows', 'Rows', 'number'),
  f('channel', 'Through', 'enum', { options: CHANNELS }),
  f('target', 'Kind', 'enum', { options: ['record', 'file', 'run_result'] }),
  f('pack', 'Pack', 'enum'),
  f('actor_kind', 'Actor kind', 'enum', { options: ACTOR_KINDS }),
  f('key_id', 'Key', 'text'),
], ['actor', 'action', 'area', 'record_key', 'rows', 'channel']);
const dataRow = (e: DataEntry): RecordRow => ({
  key: `#${e.seq}`, title: when(e.at), updated_at: e.at,
  data: { at: e.at, actor: who(e.actor_kind, e.actor_id), action: e.action, area: e.area, record_key: e.record_key, rows: e.rows, channel: e.channel,
    target: e.target, pack: e.pack, actor_kind: e.actor_kind, key_id: e.key_id == null ? null : `#${e.key_id}` }
});

const platformArea = (fleet: boolean) => systemArea(fleet ? 'platform_trail' : 'request_log', 'Requests', [
  ...(fleet ? [f('workspace', 'Workspace', 'enum')] : []),
  f('kind', 'Kind', 'enum', { options: ['request', 'sign_in', 'staff'] }),
  f('request', 'Request', 'text'),
  f('actor', 'Who', 'enum'),
  f('key', 'Key', 'text'),
  f('status', 'Result', 'number'),
  f('latency_ms', 'Latency (ms)', 'number'),
  f('channel', 'Through', 'enum', { options: CHANNELS }),
  f('scopes', 'Scopes', 'text'),
  f('actor_kind', 'Actor kind', 'enum', { options: ACTOR_KINDS }),
  ...(fleet ? [f('ip', 'Address', 'text')] : []),
], [...(fleet ? ['workspace'] : []), 'kind', 'request', 'actor', 'key', 'status', 'latency_ms']);
const platformRow = (e: PlatformEntry): RecordRow => ({
  key: `#${e.seq}${e.ip !== undefined && e.workspace ? ` · ${e.workspace}` : ''}`, title: when(e.at), updated_at: e.at,
  data: { at: e.at, workspace: e.workspace, kind: e.kind, request: `${e.method} ${e.path}`, actor: who(e.actor_kind, e.actor_id), key: e.key_prefix ? `${e.key_prefix}…` : null,
    status: e.status, latency_ms: e.latency_ms, channel: e.channel, scopes: e.scopes.join(', ') || null, actor_kind: e.actor_kind, ...(e.ip !== undefined ? { ip: e.ip } : {}) }
});

function CsvLink({ href }: { href: string }) {
  return <Button variant='outline' size='sm' render={<a href={href} download />}>Download CSV</Button>;
}

/** One trail on the records table: its rows through the data adapter, its four cards under the search row. */
function TrailTable({ area, base, url, csv, cards, row, hidden, noun, id }: {
  area: RecordAreaSpec; base: 'app' | 'admin'; url: string; csv: string; cards: string; row: (e: never) => RecordRow; hidden: string[]; noun: string; id: string;
}) {
  const source = useMemo<RecordSource>(() => ({
    key: url, load: () => loadAll(url, row), primary: <CsvLink href={csv} />, noun, hidden, updated: false,
    title: { label: 'When', type: 'date', value: (r) => String(r.data.at ?? r.updated_at) }, defaultSort: [{ key: '_record', dir: 'desc' }]
  }), [url, csv, row, noun, hidden]);
  return (
    <RecordTableView key={url} area={area} base={base} url={url} id={id} open={false} source={source}
      summary={<Sparklines url={cards} tag={`audit/${area.name}`} />}
      empty={<p className='text-muted-foreground py-10 text-center text-sm'>Nothing here yet.</p>} />
  );
}

const DATA_HIDDEN = ['target', 'pack', 'actor_kind', 'key_id'];
const PLATFORM_HIDDEN = ['channel', 'scopes', 'actor_kind'];
const PLATFORM_HIDDEN_FLEET = [...PLATFORM_HIDDEN, 'ip'];

type Tab = 'data' | 'platform';
function Tabs({ tab, set }: { tab: Tab; set: (t: Tab) => void }) {
  if (!(dataTrailOn() && platformTrailOn())) return null;
  return (
    <div className='flex gap-2'>
      <Button size='sm' variant={tab === 'data' ? 'default' : 'outline'} onClick={() => set('data')}>Data access</Button>
      <Button size='sm' variant={tab === 'platform' ? 'default' : 'outline'} onClick={() => set('platform')}>Requests</Button>
    </div>
  );
}

/** Billing's Access log tab (mold_v0-209): this workspace's trails, for its owners. No page title of its own (the tab
 *  strip is the page's heading); with both trails on, a Data access / Requests switch above the trail's table. */
export function WorkspaceAccessLog() {
  const [tab, setTab] = useState<Tab>(dataTrailOn() ? 'data' : 'platform');
  const { role, loaded } = useAccountRole();
  const platform = useMemo(() => platformArea(false), []);
  if (!loaded) return null;
  if (role !== 'owner') return <p className='text-muted-foreground text-sm'>Only the workspace&apos;s owners read its access log.</p>;
  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <p className='text-muted-foreground text-sm'>{tab === 'data'
          ? 'Who listed, read, revealed, exported or changed which records, files and run results, when and through which door. Never their contents.'
          : 'Every API and MCP request and sign-in in this workspace, with the key, the person, the result and how long it took, and staff actions on it.'}</p>
        <Tabs tab={tab} set={setTab} />
      </div>
      {tab === 'data'
        ? <TrailTable area={DATA_AREA} base='app' url='/api/audit/data' csv='/api/audit/data.csv' cards='/api/audit/data/sparklines' row={dataRow as (e: never) => RecordRow}
            hidden={DATA_HIDDEN} noun='entries' id='app-access-log-data' />
        : <TrailTable area={platform} base='app' url='/api/audit/platform' csv='/api/audit/platform.csv' cards='/api/audit/platform/sparklines' row={platformRow as (e: never) => RecordRow}
            hidden={PLATFORM_HIDDEN} noun='requests' id='app-access-log-platform' />}
    </div>
  );
}

/** /admin/access-log: the platform trail across every workspace, and one workspace's data trail by its slug. */
export function OperatorAccessLogPage() {
  const [tab, setTab] = useState<Tab>(platformTrailOn() ? 'platform' : 'data');
  const [slug, setSlug] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => { if (tab === 'platform') setShown(null); }, [tab]);
  const fleet = useMemo(() => platformArea(true), []);
  return (
    <PageContainer pageTitle='Access log' pageHeaderAction={<Tabs tab={tab} set={setTab} />}
      pageDescription={tab === 'platform' ? 'Every API and MCP request and sign-in across every workspace, and every staff action on an account.'
        : "A workspace's data trail: who read or changed which records, files and run results. Never their contents."}>
      {tab === 'platform'
        ? <TrailTable area={fleet} base='admin' url='/api/admin/audit/platform' csv='/api/admin/audit/platform.csv' cards='/api/admin/audit/platform/sparklines'
            row={platformRow as (e: never) => RecordRow} hidden={PLATFORM_HIDDEN_FLEET} noun='requests' id='admin-access-log-platform' />
        : (
          <div className='flex flex-col gap-4'>
            <form className='flex max-w-md gap-2' onSubmit={(e) => { e.preventDefault(); setShown(slug.trim() || null); }}>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder='Workspace slug' aria-label='Workspace slug' />
              <Button type='submit' size='sm'>Show</Button>
            </form>
            {shown && <TrailTable area={DATA_AREA} base='admin' url={`/api/admin/audit/data/${encodeURIComponent(shown)}`} csv={`/api/admin/audit/data/${encodeURIComponent(shown)}/csv`}
              cards={`/api/admin/audit/data/${encodeURIComponent(shown)}/sparklines`} row={dataRow as (e: never) => RecordRow} hidden={DATA_HIDDEN} noun='entries' id='admin-access-log-data' />}
          </div>
        )}
    </PageContainer>
  );
}
