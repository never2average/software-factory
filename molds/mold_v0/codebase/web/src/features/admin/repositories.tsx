'use client';
// /admin/repositories (mold_v0-129): the build's data repositories (src/data-repositories.ts) and the areas each feeds.
// mold_v0-283: a page of the build only with a workspace_files repository (files an agent writes into a workspace, turned
// into that workspace's rows: scripts/gen-packs.mjs leaves the page and its sidebar entry out otherwise). There are no
// upstream catalogs: shared lists are platform records staff keep with New, Edit and Import on their own pages.
import { PageFrame } from '@/components/layout/page-container';
import { useQuery } from '@tanstack/react-query';
import { adminDataApi } from '@/lib/api-client';
import { ErrorBox, LoadingCards, Section } from './ui';

interface AreaRows { name: string; label: string; scope: 'platform' | 'workspace'; rows: number | null }
export interface RepositoryRow {
  /** label: the pack's, else its id in words; pack_name: its pack's name (mold_v0-169: what staff read, not the ids). */
  pack: string; name: string; label: string; pack_name: string; kind: string; indexedBy: string; area_rows: AreaRows[];
}
interface Status { repositories: RepositoryRow[] }

const KIND: Record<string, string> = { shell_tables: 'Shell tables', workspace_files: "A workspace's files", http_api: 'External API' };
const BY: Record<string, string> = { none: 'Written through the console and tools', workspace_commit: "Each workspace's runs, after a commit" };

export function useRepositories(enabled = true) {
  return useQuery<Status>({ queryKey: ['admin', 'data', '_repositories'], queryFn: () => adminDataApi<Status>('GET', '/_repositories'), enabled, staleTime: 10_000 });
}

/** `bare` (mold_v0-281): drawn as an in-page tab of a staff Records entry, without its own page frame. */
export function AdminRepositories({ bare = false }: { bare?: boolean } = {}) {
  const { data, error, isLoading } = useRepositories();
  return (
    <PageFrame bare={bare} pageTitle='Data repositories' pageDescription="Where the record areas get their rows: each workspace's files, after its runs commit them, and any other repository the packs declare.">
      <ErrorBox error={error} />
      {isLoading || !data ? <LoadingCards count={2} /> : (
        <div className='flex max-w-5xl flex-col gap-8'>
          <Section title='Repositories'>
            {data.repositories.length ? (
              <ul className='divide-y rounded-lg border'>
                {data.repositories.map((r) => (
                  <li key={`${r.pack}/${r.name}`} className='flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm'>
                    <span className='font-medium' title={r.name}>{r.label}</span>
                    <span className='text-muted-foreground'>{KIND[r.kind] ?? r.kind} · {BY[r.indexedBy] ?? r.indexedBy} · feeds {r.area_rows.map((a) => a.label).join(', ') || 'no area'} · from {r.pack_name}</span>
                  </li>
                ))}
              </ul>
            ) : <p className='text-muted-foreground text-sm'>This build has no data repository.</p>}
          </Section>
        </div>
      )}
    </PageFrame>
  );
}
