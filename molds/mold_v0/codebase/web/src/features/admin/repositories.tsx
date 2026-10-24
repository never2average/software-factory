'use client';
// /admin/repositories (mold_v0-129): the build's data repositories (src/data-repositories.ts) and, for an upstream catalog,
// its pin, when it was last indexed and at which commit, the rows in each area it feeds, the last error, and "Index now"
// (staff with the library permission; the same code path as the admin MCP's admin_sync_<repository>: src/repository-index.ts
// indexNow). An upstream catalog indexes itself whenever its pin changes (mold_v0-128) unless its pack says `index: manual`.
// RepositoryNotice is the line Health shows while a catalog could not be indexed at its pin.
import Link from 'next/link';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { adminDataApi } from '@/lib/api-client';
import { Gate, useAdminRole } from './role';
import { ConfirmButton, ErrorBox, LoadingCards, Mono, Notice, Section, StatusBadge, When, type Tone } from './ui';

interface AreaRows { name: string; label: string; scope: 'platform' | 'workspace'; rows: number | null }
interface IndexState {
  pin: string | null; indexed_at: string | null; rows: Record<string, number>; attempted_at: string | null; attempted_pin: string | null;
  attempted_by: string | null; last_error: string | null; last_error_at: string | null; indexing: boolean; current: boolean;
}
export interface RepositoryRow {
  pack: string; name: string; kind: string; indexedBy: string; area_rows: AreaRows[];
  upstream?: { repo: string; commit: string }; index?: 'automatic' | 'manual'; state?: IndexState | null;
}
interface Status { automatic: boolean; repositories: RepositoryRow[] }

const KIND: Record<string, string> = { shell_tables: 'Shell tables', workspace_files: "A workspace's files", upstream_catalog: 'Upstream catalog', http_api: 'External API' };
const BY: Record<string, string> = { none: 'Written through the console and tools', workspace_commit: "Each workspace's runs, after a commit", staff: 'Indexed at its pin' };
const TRIGGER: Record<string, string> = { startup: 'the server starting', first_read: 'a first read', deploy: 'the deploy', staff: 'staff' };
const short = (c: string | null | undefined) => (c ? c.slice(0, 12) : '');

export function useRepositories(enabled = true) {
  return useQuery<Status>({ queryKey: ['admin', 'data', '_repositories'], queryFn: () => adminDataApi<Status>('GET', '/_repositories'), enabled, staleTime: 10_000,
    // While an index runs, look again every few seconds.
    refetchInterval: (q) => (q.state.data?.repositories.some((r) => r.state?.indexing) ? 4000 : false) });
}

/** One catalog's state, in a word and a tone. */
function stateOf(r: RepositoryRow): { tone: Tone; text: string } {
  const s = r.state;
  if (s?.indexing) return { tone: 'info', text: 'Indexing now' };
  if (s?.current) return { tone: 'ok', text: 'Indexed at its pin' };
  if (s?.last_error) return { tone: 'bad', text: 'Could not be indexed' };
  if (s?.pin) return { tone: 'warn', text: r.index === 'manual' ? 'Indexed at an older pin' : 'Waiting for its new pin' };
  return { tone: 'warn', text: r.index === 'manual' ? 'Not indexed yet' : 'Not indexed yet (it starts on its own)' };
}

export function AdminRepositories() {
  const { data, error, isLoading } = useRepositories();
  const catalogs = data?.repositories.filter((r) => r.upstream) ?? [];
  const others = data?.repositories.filter((r) => !r.upstream) ?? [];
  return (
    <PageContainer pageTitle='Data repositories' pageDescription='Where the record areas get their rows. An upstream catalog is read at the commit its pack pins, and indexed into the shared areas every account reads.'>
      <ErrorBox error={error} />
      {isLoading || !data ? <LoadingCards count={2} /> : (
        <div className='flex max-w-5xl flex-col gap-8'>
          {!data.automatic && catalogs.some((c) => c.index === 'automatic') && (
            <Notice tone='info'>Automatic indexing is turned off on this server (APP_CATALOG_AUTOINDEX=off): catalogs are indexed only when staff press Index now, or by the deploy.</Notice>
          )}
          <Section title='Upstream catalogs' description='Each is indexed by the server whenever its pin changes, unless its pack indexes it by hand.'>
            {catalogs.length ? <div className='flex flex-col gap-4'>{catalogs.map((r) => <Catalog key={`${r.pack}/${r.name}`} r={r} />)}</div>
              : <p className='text-muted-foreground text-sm'>This build has no upstream catalog.</p>}
          </Section>
          {!!others.length && (
            <Section title='Other repositories'>
              <ul className='divide-y rounded-lg border'>
                {others.map((r) => (
                  <li key={`${r.pack}/${r.name}`} className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm'>
                    <span className='font-medium'><Mono>{r.name}</Mono></span>
                    <span className='text-muted-foreground'>{KIND[r.kind] ?? r.kind} · {BY[r.indexedBy] ?? r.indexedBy} · feeds {r.area_rows.map((a) => a.label).join(', ') || 'no area'}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </PageContainer>
  );
}

function Catalog({ r }: { r: RepositoryRow }) {
  const qc = useQueryClient();
  const { can } = useAdminRole();
  const st = stateOf(r), s = r.state;
  const sync = useMutation<{ index: { areas: { area: string; created: number; updated: number; unchanged: number; deleted: number }[] } }, Error, boolean>({
    mutationFn: (force) => adminDataApi('POST', `/_repositories/${encodeURIComponent(r.pack)}/${encodeURIComponent(r.name)}/sync`, force ? { force: true } : {}),
    onSuccess: (x) => {
      toast.success(`${r.name} indexed: ${x.index.areas.map((a) => `${a.area} ${a.created + a.updated + a.unchanged}`).join(', ')}`);
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
    onError: (e) => { toast.error(e.message); void qc.invalidateQueries({ queryKey: ['admin', 'data', '_repositories'] }); }
  });
  const busy = sync.isPending || !!s?.indexing;
  const refused = !!s?.last_error && /refused/.test(s.last_error);
  const headingId = `repo-${r.pack}-${r.name}`;
  return (
    <section aria-labelledby={headingId} className='rounded-lg border'>
      <div className='flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3'>
        <div className='flex min-w-0 flex-col gap-1'>
          <h3 id={headingId} className='flex flex-wrap items-center gap-2 font-medium'><Mono>{r.name}</Mono><StatusBadge tone={st.tone}>{st.text}</StatusBadge></h3>
          <p className='text-muted-foreground text-xs break-all'>
            {r.upstream!.repo} at <Mono>{short(r.upstream!.commit)}</Mono> · {r.index === 'manual' ? 'indexed by staff only' : 'indexes itself'} · pack {r.pack}
          </p>
        </div>
        <div className='flex flex-wrap gap-2'>
          {refused && can('delete') && (
            <ConfirmButton label='Index and allow removals' size='sm' variant='outline' disabled={busy}
              title={`Index ${r.name} and allow its removals?`}
              description='The last index was refused because it would remove many rows (or empty an area). Forcing it removes the rows the catalog no longer has, and takes back rows edited by hand.'
              confirmLabel='Index and remove' onConfirm={() => sync.mutate(true)} />
          )}
          <Gate need='library'>
            <Button size='sm' onClick={() => sync.mutate(false)} disabled={busy} aria-busy={busy}>
              {busy ? <Icons.spinner className='size-3.5 animate-spin' aria-hidden='true' /> : <Icons.refresh className='size-3.5' aria-hidden='true' />}
              {busy ? 'Indexing…' : 'Index now'}
            </Button>
          </Gate>
        </div>
      </div>
      <dl className='grid gap-x-6 gap-y-3 px-4 py-3 text-sm sm:grid-cols-2 lg:grid-cols-4'>
        <div><dt className='text-muted-foreground text-xs'>Last indexed</dt><dd>{s?.indexed_at ? <When d={s.indexed_at} /> : 'Never'}</dd></div>
        <div><dt className='text-muted-foreground text-xs'>At commit</dt><dd>{s?.pin ? <Mono>{short(s.pin)}</Mono> : '—'}</dd></div>
        <div><dt className='text-muted-foreground text-xs'>Last attempt</dt><dd>{s?.attempted_at ? <><When d={s.attempted_at} />{s.attempted_by ? <span className='text-muted-foreground'> by {TRIGGER[s.attempted_by] ?? s.attempted_by}</span> : null}</> : '—'}</dd></div>
        <div>
          <dt className='text-muted-foreground text-xs'>Rows</dt>
          <dd>{r.area_rows.map((a) => <span key={a.name} className='block'>{a.label}: {a.rows ?? '—'}</span>)}</dd>
        </div>
      </dl>
      {s?.last_error && !s.current && (
        <div className='px-4 pb-3'>
          <div role='alert' className='border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm'>
            <span className='font-medium'>Last error</span>{s.last_error_at ? <> (<When d={s.last_error_at} />)</> : null}: <span className='break-words'>{s.last_error}</span>
          </div>
        </div>
      )}
    </section>
  );
}

/** Health's line while an upstream catalog could not be indexed at its pin (a build with catalogs only). */
export function RepositoryNotice() {
  const { data } = useRepositories();
  const bad = data?.repositories.filter((r) => r.upstream && r.state?.last_error && !r.state.current && !r.state.indexing) ?? [];
  if (!bad.length) return null;
  return (
    <div className='px-4 pt-2 md:px-6 md:pt-4'>
      <Notice tone='warn'>
        {bad.length === 1 ? `The catalog ${bad[0]!.name} could not be indexed at its pin` : `${bad.length} catalogs could not be indexed at their pins`}
        {': '}{bad[0]!.state!.last_error}{' '}
        <Link href='/admin/repositories' className='font-medium underline underline-offset-4'>Open Data repositories</Link>
      </Notice>
    </div>
  );
}
