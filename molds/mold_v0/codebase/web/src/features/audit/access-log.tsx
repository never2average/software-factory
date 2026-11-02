'use client';
// The access log (mold_v0-197; src/audit-trail.ts): the audit trails as the console's database table (RecordView, the
// records pages' style: search, filters, sort, a pager, a side peek). /app/access-log is one workspace's, for its owners
// (GET /api/audit/data, /api/audit/platform: its data trail and its slice of the platform trail); /admin/access-log is
// the platform trail fleet-wide and any workspace's data trail, for platform staff (GET /api/admin/audit/*). Download
// CSV is the server's own file (every entry, not only the loaded pages). Never a record's values: there are none here.
import { useEffect, useMemo, useState } from 'react';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useOrgLoad, ErrorState } from '@/features/portal/shared';
import { useAccountRole } from '@/features/portal/role';
import { dataTrailOn, platformTrailOn } from './config';

interface DataEntry { seq: number; at: string; actor_kind: string; actor_id: string | null; key_id: number | null; action: string; target: string; pack: string | null; area: string | null; record_key: string | null; rows: number | null; channel: string }
interface PlatformEntry { seq: number; at: string; org_id: number | null; workspace: string | null; kind: string; channel: string; method: string; path: string; key_id: number | null; key_prefix: string | null;
  actor_kind: string; actor_id: string | null; scopes: string[]; status: number | null; latency_ms: number | null; ip?: string | null }
type Page<T> = { entries: T[]; next: number | string | null };

/** At most this many entries in the table (the CSV holds them all). */
const LOAD_MAX = 2000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body;
}
async function loadAll<T>(url: string): Promise<{ entries: T[]; more: boolean }> {
  const entries: T[] = [];
  let before: number | string | null = null;
  for (;;) {
    const page: Page<T> = await getJson<Page<T>>(`${url}${url.includes('?') ? '&' : '?'}limit=500${before !== null ? `&before=${encodeURIComponent(String(before))}` : ''}`);
    entries.push(...page.entries);
    if (!page.next || entries.length >= LOAD_MAX) return { entries, more: !!page.next };
    before = page.next;
  }
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });
const who = (kind: string, id: string | null) => (kind === 'system' ? 'System' : kind === 'agent_run' ? `Agent run ${id ?? ''}` : id ?? kind);
const CHANNELS = ['console', 'api', 'mcp', 'admin_console', 'admin_mcp', 'run', 'system'].map((v) => ({ value: v }));

const dataCols: RecordCol<DataEntry>[] = [
  { key: 'at', label: 'When', title: true, type: 'date', value: (r) => r.at, render: (r) => when(r.at), keep: true },
  { key: 'actor', label: 'Who', type: 'text', value: (r) => who(r.actor_kind, r.actor_id), render: (r) => <span className='font-mono text-xs'>{who(r.actor_kind, r.actor_id)}</span> },
  { key: 'action', label: 'Action', type: 'select', value: (r) => r.action, render: (r) => r.action,
    options: ['list', 'read', 'reveal', 'export', 'create', 'update', 'move', 'delete'].map((v) => ({ value: v })) },
  { key: 'area', label: 'Area', type: 'select', value: (r) => r.area ?? '', render: (r) => r.area ?? '—' },
  { key: 'record_key', label: 'Record or file', type: 'text', value: (r) => r.record_key ?? '', render: (r) => <span className='font-mono text-xs'>{r.record_key ?? '—'}</span> },
  { key: 'rows', label: 'Rows', type: 'number', value: (r) => r.rows ?? 0, render: (r) => (r.rows == null ? '—' : r.rows.toLocaleString('en')) },
  { key: 'channel', label: 'Through', type: 'select', value: (r) => r.channel, render: (r) => r.channel, options: CHANNELS },
  { key: 'target', label: 'Kind', type: 'select', value: (r) => r.target, render: (r) => r.target, hidden: true },
  { key: 'seq', label: 'Entry', type: 'number', value: (r) => r.seq, render: (r) => `#${r.seq}`, hidden: true },
];
const platformCols = (fleet: boolean): RecordCol<PlatformEntry>[] => [
  { key: 'at', label: 'When', title: true, type: 'date', value: (r) => r.at, render: (r) => when(r.at), keep: true },
  ...(fleet ? [{ key: 'workspace', label: 'Workspace', type: 'select' as const, value: (r: PlatformEntry) => r.workspace ?? '', render: (r: PlatformEntry) => r.workspace ?? '—' }] : []),
  { key: 'kind', label: 'Kind', type: 'select', value: (r) => r.kind, render: (r) => r.kind, options: ['request', 'sign_in', 'staff'].map((v) => ({ value: v })) },
  { key: 'request', label: 'Request', type: 'text', value: (r) => `${r.method} ${r.path}`, render: (r) => <span className='font-mono text-xs'>{r.method} {r.path}</span> },
  { key: 'actor', label: 'Who', type: 'text', value: (r) => who(r.actor_kind, r.actor_id), render: (r) => <span className='font-mono text-xs'>{who(r.actor_kind, r.actor_id)}</span> },
  { key: 'key', label: 'Key', type: 'text', value: (r) => r.key_prefix ?? '', render: (r) => (r.key_prefix ? <span className='font-mono text-xs'>{r.key_prefix}…</span> : '—') },
  { key: 'status', label: 'Result', type: 'number', value: (r) => r.status ?? 0, render: (r) => r.status ?? '—' },
  { key: 'latency', label: 'Latency', type: 'number', value: (r) => r.latency_ms ?? 0, render: (r) => (r.latency_ms == null ? '—' : `${r.latency_ms} ms`) },
  { key: 'channel', label: 'Through', type: 'select', value: (r) => r.channel, render: (r) => r.channel, options: CHANNELS, hidden: true },
  { key: 'scopes', label: 'Scopes', type: 'text', value: (r) => r.scopes.join(' '), render: (r) => r.scopes.join(', ') || '—', hidden: true },
  ...(fleet ? [{ key: 'ip', label: 'Address', type: 'text' as const, value: (r: PlatformEntry) => r.ip ?? '', render: (r: PlatformEntry) => r.ip ?? '—', hidden: true }] : []),
];

function CsvLink({ href }: { href: string }) {
  return <Button variant='outline' size='sm' render={<a href={href} download />}>Download CSV</Button>;
}

function TrailTable<T extends { seq: number; at: string }>({ url, csv, cols, id, noun, search }: { url: string; csv: string; cols: RecordCol<T>[]; id: string; noun: string; search: (r: T) => string }) {
  const { data, error } = useOrgLoad(() => loadAll<T>(url), [url]);
  const key = useMemo(() => (r: T) => `${r.at}|${r.seq}|${(r as { org_id?: number | null }).org_id ?? ''}`, []);
  if (error) return <ErrorState error={error} />;
  return (
    <RecordView<T>
      id={id} noun={noun} properties rows={data?.entries ?? []} rowKey={key} cols={cols} loading={!data}
      searchText={search} searchPlaceholder={`Search ${noun}`} defaultSort={[{ key: 'at', dir: 'desc' }]}
      filters={data?.more ? <span className='text-muted-foreground text-xs'>The latest {LOAD_MAX.toLocaleString('en')} entries: Download CSV has every one</span> : undefined}
      primary={<CsvLink href={csv} />}
      empty={<p className='text-muted-foreground py-10 text-center text-sm'>Nothing here yet.</p>}
    />
  );
}

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

/** /app/access-log: this workspace's trails, for its owners. */
export function WorkspaceAccessLogPage() {
  const [tab, setTab] = useState<Tab>(dataTrailOn() ? 'data' : 'platform');
  const { role, loaded } = useAccountRole();
  return (
    <PageContainer pageTitle='Access log' pageHeaderAction={<Tabs tab={tab} set={setTab} />}
      pageDescription={tab === 'data'
        ? 'Who listed, read, revealed, exported or changed which records, files and run results, when and through which door. Never their contents.'
        : 'Every API and MCP request and sign-in in this workspace, with the key, the person, the result and how long it took, and staff actions on it.'}>
      {loaded && role !== 'owner' ? <p className='text-muted-foreground text-sm'>Only the workspace&apos;s owners read its access log.</p>
        : tab === 'data'
          ? <TrailTable<DataEntry> url='/api/audit/data' csv='/api/audit/data.csv' cols={dataCols} id='app-access-log-data' noun='entries'
              search={(r) => `${r.actor_id ?? ''} ${r.action} ${r.area ?? ''} ${r.record_key ?? ''} ${r.channel}`} />
          : <TrailTable<PlatformEntry> url='/api/audit/platform' csv='/api/audit/platform.csv' cols={platformCols(false)} id='app-access-log-platform' noun='requests'
              search={(r) => `${r.actor_id ?? ''} ${r.method} ${r.path} ${r.key_prefix ?? ''} ${r.status ?? ''}`} />}
    </PageContainer>
  );
}

/** /admin/access-log: the platform trail across every workspace, and one workspace's data trail by its slug. */
export function OperatorAccessLogPage() {
  const [tab, setTab] = useState<Tab>(platformTrailOn() ? 'platform' : 'data');
  const [slug, setSlug] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => { if (tab === 'platform') setShown(null); }, [tab]);
  return (
    <PageContainer pageTitle='Access log' pageHeaderAction={<Tabs tab={tab} set={setTab} />}
      pageDescription={tab === 'platform' ? 'Every API and MCP request and sign-in across every workspace, and every staff action on an account.'
        : "A workspace's data trail: who read or changed which records, files and run results. Never their contents."}>
      {tab === 'platform'
        ? <TrailTable<PlatformEntry> url='/api/admin/audit/platform' csv='/api/admin/audit/platform.csv' cols={platformCols(true)} id='admin-access-log-platform' noun='requests'
            search={(r) => `${r.workspace ?? ''} ${r.actor_id ?? ''} ${r.method} ${r.path} ${r.key_prefix ?? ''} ${r.status ?? ''}`} />
        : (
          <div className='flex flex-col gap-4'>
            <form className='flex max-w-md gap-2' onSubmit={(e) => { e.preventDefault(); setShown(slug.trim() || null); }}>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder='Workspace slug' aria-label='Workspace slug' />
              <Button type='submit' size='sm'>Show</Button>
            </form>
            {shown && <TrailTable<DataEntry> url={`/api/admin/audit/data/${encodeURIComponent(shown)}`} csv={`/api/admin/audit/data/${encodeURIComponent(shown)}/csv`} cols={dataCols}
              id='admin-access-log-data' noun='entries' search={(r) => `${r.actor_id ?? ''} ${r.action} ${r.area ?? ''} ${r.record_key ?? ''} ${r.channel}`} />}
          </div>
        )}
    </PageContainer>
  );
}
