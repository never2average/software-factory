// What a record area's list page says while it has no rows (mold_v0-170): a title, what fills the area and, for platform
// staff, the way to fill it now. Never the area's raw key pattern: the words come from the area's label and from where
// its rows come from (its data repository, src/data-repositories.ts, as /api/admin/data/_repositories reports it).
// Pure, so a test can read it without a browser (scripts/record-pages-test.ts); features/tabs/empty.tsx draws it.
import type { RecordAreaSpec } from '../../config/pack-nav.generated';
import { fill } from '../../lib/vocabulary';

export interface EmptyText { title: string; text: string; cta: { label: string; href: string } | null }

/** The part of a data repository's status this needs (features/admin/repositories.tsx RepositoryRow). */
export interface RepoState {
  name: string;
  kind: string;
  index?: 'automatic' | 'manual';
  upstream?: { repo: string; commit: string };
  state?: { indexing: boolean; current: boolean; last_error: string | null; pin: string | null } | null;
}

/** Where staff fill an area from its repository: the Data repositories page (mold_v0-129). */
export const REPOSITORIES_URL = '/admin/repositories';

/** The repository that feeds `area`, from the repositories' status (each lists the areas it feeds). */
export const repoOf = (area: string, repos: readonly (RepoState & { area_rows: { name: string }[] })[] | undefined) =>
  repos?.find((r) => r.area_rows.some((a) => a.name === area)) ?? null;

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The empty state of `area`'s list page. `base` is the console area (admin: platform staff, who can fill it); `repo` the
 * repository that feeds it, when known (null: written through the console, the tools and the data API).
 */
export function recordEmptyText(area: Pick<RecordAreaSpec, 'label' | 'scope'>, base: 'app' | 'admin', repo: RepoState | null): EmptyText {
  const title = `No records in ${area.label} yet`;
  if (base === 'app') {
    return {
      title,
      text: area.scope === 'platform'
        ? fill(`${area.label} is shared by every {workspace} and kept up to date by the platform. Its records appear here once they are published.`)
        : fill("Records appear here as this {workspace}'s {runs}, tools and team add them."),
      cta: null
    };
  }
  if (repo?.upstream) {
    const s = repo.state;
    const where = `Its records come from an upstream catalog, ${repo.upstream.repo.replace(/^https?:\/\//, '')} (data repository ${repo.name}), indexed into this area at the commit its pack pins.`;
    const now = s?.indexing ? 'An index is running now: this page fills when it finishes.'
      : s?.last_error ? `The last index failed: ${s.last_error}. Open Data repositories to see why and index again.`
      : repo.index === 'manual' ? 'This catalog is indexed by hand: open Data repositories and press Index now.'
      : 'It indexes itself when its pin changes; to fill it now, open Data repositories and press Index now.';
    return { title, text: `${where} ${now} The admin MCP server does the same with admin_sync_${repo.name}.`, cta: { label: 'Open Data repositories', href: REPOSITORIES_URL } };
  }
  if (repo) {
    const from: Record<string, string> = {
      workspace_files: fill("each {workspace}'s files, after its {runs} commit them"),
      http_api: 'an external API, read when the page opens',
      shell_tables: 'the console, the tools and the data API'
    };
    return { title, text: `Its records come from the ${repo.name} repository: ${from[repo.kind] ?? lower(repo.kind.replace(/_/g, ' '))}.`, cta: { label: 'Open Data repositories', href: REPOSITORIES_URL } };
  }
  return { title, text: 'Records are added by the packs and by staff through the admin MCP server and the data API (/api/admin/records).', cta: null };
}
