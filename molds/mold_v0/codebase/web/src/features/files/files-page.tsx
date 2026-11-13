'use client';
// /app/files (mold_v0-056; src/workspace-files.ts): the files a pack's runs keep in the workspace store. Each version is
// what one run left. mold_v0-298: the versions are the standard list (RecordView: search row, Actions ▾, a row opens
// the side panel), each named by when it was saved and what saved it (never a version number or a run id); the panel
// holds that version's files (open a text file, download one) and what changed against another version, shown as
// lines added and removed (no diff hunk headers). Empty states say what puts files here and where to go next.
// Everything is shown as text (React escapes it): a file's contents are never rendered as markup, and characters that
// change how text reads (direction overrides, invisible marks) are shown as visible codes. The server never lists or
// serves hidden files, credential files or anything the pack declares secret.
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { packTabs } from '@/config/pack-nav.generated';
import { kindLabel } from '@/features/admin/engine';
import { runHref } from '@/features/portal/home-cards';
import { ErrorState, LoadingCards, useOrgLoad } from '@/features/portal/shared';
import { EmptyState } from '@/features/tabs/empty';
import { httpError } from '@/features/status/from-error';
import { fill } from '@/lib/vocabulary';
import { cn } from '@/lib/utils';

interface Retention { keep_last: number | null; keep_days: number | null; source: 'pack' | 'platform' }
interface Store { store: string; label: string; retention: Retention }
interface Version { version: number; committed_at: string | null; run_id: string | null; run_kind: string | null; files: number; bytes: number; manifest_sha256: string }
interface FileEntry { path: string; size: number }
interface Tree { version: number; files: FileEntry[]; hidden: number }
interface Viewed { path: string; version: number; size: number; sha256: string; binary: boolean; text: string | null }
interface Changes { from: number; to: number; added: { path: string; size: number }[]; removed: { path: string; size: number }[]; changed: { path: string; from_size: number; size: number }[] }
interface DiffLine { op: ' ' | '-' | '+'; text: string }
interface Hunk { from_start: number; from_lines: number; to_start: number; to_lines: number; lines: DiffLine[] }
interface FileDiff { path: string; from: number; to: number; hunks: Hunk[]; note: string | null }

const BASE = '/api/workspace-files';
async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401 && typeof window !== 'undefined') window.location.href = `/auth/sign-in?redirect_url=${encodeURIComponent(window.location.pathname)}`;
  if (!res.ok) throw httpError(res.status, json);
  return json;
}
const seg = (s: string) => encodeURIComponent(s);
const q = (p: string) => `path=${encodeURIComponent(p)}`;

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const retentionText = (r: Retention) => {
  const parts = [r.keep_last !== null ? `the newest ${r.keep_last}` : null, r.keep_days !== null ? `those from the last ${r.keep_days} days` : null].filter(Boolean);
  return `Old versions are kept while they are ${parts.join(' or ')}; the latest, and any version a result or a report points to, are always kept.`;
};

/** The store's runs tab (a pack's store is named after the pack), for an empty state's next step. */
const runsTabOf = (store: string) => packTabs.find((t) => t.pack === store && t.kind === 'runs') ?? null;

/** What saved a version, in the pack's words: its run's kind (the job kind's label), never the run's id. */
const writerOf = (v: Version, store: string) => {
  // A kind the packs do not label reads 'A run', never its raw id.
  const label = v.run_kind ? kindLabel(v.run_kind, store) : null;
  return label && label !== v.run_kind ? label : v.run_id ? fill('A {run}') : fill('Not from a {run}');
};

/**
 * mold_v0-298: each version's name, by when it was saved and what saved it ("12 Nov 2026, 14:05 · Nightly check").
 * Names that would read the same get their seconds; any still the same are told apart as "(2)", "(3)", oldest first.
 */
function versionNames(versions: readonly Version[], store: string): Map<number, string> {
  const when = (v: Version, seconds: boolean) => v.committed_at
    ? new Date(v.committed_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: seconds ? 'medium' : 'short' })
    : 'Not finished';
  const short = versions.map((v) => `${when(v, false)} · ${writerOf(v, store)}`);
  const long = versions.map((v, i) => (short.filter((s) => s === short[i]).length > 1 ? `${when(v, true)} · ${writerOf(v, store)}` : short[i]));
  const names = new Map<number, string>();
  const oldestFirst = versions.map((v, i) => ({ v, name: long[i] })).sort((a, b) => a.v.version - b.v.version);
  const seen = new Map<string, number>();
  for (const { v, name } of oldestFirst) {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    names.set(v.version, n > 1 ? `${name} (${n})` : name);
  }
  return names;
}

/** Characters that change how text reads without showing (bidirectional overrides, zero-width marks): shown as codes. */
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const HAS_INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;
function Visible({ text }: { text: string }) {
  if (!HAS_INVISIBLE.test(text)) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INVISIBLE)) {
    out.push(text.slice(last, m.index));
    out.push(<mark key={m.index} className='bg-amber-200 text-amber-900 dark:bg-amber-900 dark:text-amber-100' title='An invisible character'>{`<U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`}</mark>);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

export function FilesPage({ initialStore }: { initialStore: string | null }) {
  const { data, error } = useOrgLoad(() => get<{ stores: Store[] }>('/'));
  const [picked, setPicked] = useState<string | null>(initialStore);
  const store = data?.stores.find((s) => s.store === picked) ?? data?.stores[0] ?? null;
  return (
    <PageContainer pageTitle='Files' pageDescription={fill('What your {runs} keep between {runs}: each version is what one {run} saved. Open a version to see its files, download one, or see what changed.')}>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : !data.stores.length || !store ? (
        // mold_v0-298: an empty state with what puts files here, not a bare line.
        <EmptyState id='empty-files' empty={{ title: 'No files yet.', text: fill('Files show up here once a {run} saves some, or someone adds them for your {workspace}. If you expected some, ask an owner whether your role can see them.'), cta: null }} />
      ) : (
        <StoreView key={store.store} store={store} stores={data.stores} onPick={setPicked} />
      )}
    </PageContainer>
  );
}

function StoreView({ store, stores, onPick }: { store: Store; stores: Store[]; onPick: (s: string) => void }) {
  const { data, error } = useOrgLoad(() => get<{ versions: Version[] }>(`/${seg(store.store)}/versions`), [store.store]);
  const versions = useMemo(() => data?.versions ?? [], [data]);
  const names = useMemo(() => versionNames(versions, store.store), [versions, store.store]);
  const latest = versions[0]?.version ?? null;
  if (error) return <ErrorState error={error} />;
  const runs = runsTabOf(store.store);
  const cols: RecordCol<Version>[] = [
    {
      key: 'saved', label: 'Saved', title: true, keep: true, type: 'date', value: (v) => v.committed_at,
      render: (v) => (
        <span className='flex items-center gap-2'>
          <span>{v.committed_at ? new Date(v.committed_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not finished'}</span>
          {v.version === latest && <Badge variant='secondary'>Latest</Badge>}
        </span>
      )
    },
    { key: 'by', label: 'Saved by', type: 'select', value: (v) => writerOf(v, store.store), render: (v) => writerOf(v, store.store) },
    { key: 'files', label: 'Files', type: 'number', value: (v) => v.files, render: (v) => <span className='tabular-nums'>{v.files}</span>, className: 'text-right' },
    { key: 'size', label: 'Size', type: 'number', value: (v) => v.bytes, render: (v) => <span className='tabular-nums'>{size(v.bytes)}</span>, className: 'text-right' }
  ];
  return (
    <RecordView<Version>
      id={`app-files-${store.store}`} noun='versions' exportName='file-versions' loading={!data}
      rows={versions} rowKey={(v) => String(v.version)} cols={cols} defaultSort={[{ key: 'saved', dir: 'desc' }]}
      searchText={(v) => names.get(v.version) ?? ''} searchPlaceholder='Search versions'
      summary={<p className='text-muted-foreground text-sm'>{retentionText(store.retention)}</p>}
      filters={stores.length > 1 ? (
        <NativeSelect value={store.store} onChange={(e) => onPick(e.target.value)} aria-label='Which files'>
          {stores.map((s) => <NativeSelectOption key={s.store} value={s.store}>{s.label}</NativeSelectOption>)}
        </NativeSelect>
      ) : undefined}
      empty={{
        title: 'No files saved yet.',
        text: fill('Each time a {run} finishes, the files it keeps are saved here as a new version. Start a {run} and its files show up here.'),
        action: runs ? { label: fill('Go to {runs}'), href: runs.url } : undefined
      }}
      panelKind='editor'
      detailTitle={(v) => names.get(v.version) ?? 'A version'}
      detail={(v) => <VersionPanel key={`${store.store}/${v.version}`} store={store.store} version={v} versions={versions} names={names} />}
    />
  );
}

/** mold_v0-298: a version's side panel: what saved it, its files, and what changed against another version. */
function VersionPanel({ store, version, versions, names }: { store: string; version: Version; versions: Version[]; names: Map<number, string> }) {
  const others = versions.filter((v) => v.version !== version.version);
  // By default: against the version saved just before this one (else the one after, for the oldest).
  const before = versions.find((v) => v.version < version.version) ?? others[0] ?? null;
  const [against, setAgainst] = useState<number | null>(before?.version ?? null);
  const run = version.run_id ? runHref({ id: version.run_id, pack: store }) : null;
  return (
    <div className='flex flex-col gap-6'>
      <div className='text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm'>
        <span>{version.files} {version.files === 1 ? 'file' : 'files'} · {size(version.bytes)}</span>
        {run && <Link href={run} className='text-foreground underline underline-offset-2'>{fill('Open the {run} that saved it')}</Link>}
      </div>
      <section className='flex flex-col gap-3'>
        <h3 className='text-sm font-semibold'>Files</h3>
        <VersionFiles store={store} version={version.version} />
      </section>
      {against !== null && (
        <section className='flex flex-col gap-3'>
          <h3 className='text-sm font-semibold'>What changed</h3>
          <label className='flex flex-wrap items-center gap-2 text-sm'>
            <span className='text-muted-foreground'>Compared with</span>
            <NativeSelect className='max-w-full min-w-0' value={String(against)} onChange={(e) => setAgainst(Number(e.target.value))} aria-label='Compared with'>
              {others.map((v) => <NativeSelectOption key={v.version} value={String(v.version)}>{names.get(v.version) ?? ''}</NativeSelectOption>)}
            </NativeSelect>
          </label>
          {/* Older on the left, so "added" means added since the older version. */}
          <Compare key={`${against}-${version.version}`} store={store} from={Math.min(against, version.version)} to={Math.max(against, version.version)} names={names} />
        </section>
      )}
    </div>
  );
}

/** A version's files as a tree: directories first, each opened or closed. */
interface Dir { dirs: Map<string, Dir>; files: FileEntry[] }
const treeOf = (files: FileEntry[]) => {
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) { if (!d.dirs.has(p)) d.dirs.set(p, { dirs: new Map(), files: [] }); d = d.dirs.get(p)!; }
    d.files.push(f);
  }
  return root;
};

function DirView({ dir, onOpen, openPath }: { dir: Dir; onOpen: (f: FileEntry) => void; openPath: string | null }) {
  return (
    <ul className='flex flex-col gap-0.5 pl-3'>
      {[...dir.dirs].sort(([a], [b]) => a.localeCompare(b)).map(([name, d]) => (
        <li key={`d/${name}`}>
          <details open>
            <summary className='cursor-pointer text-sm'><Visible text={name} />/</summary>
            <DirView dir={d} onOpen={onOpen} openPath={openPath} />
          </details>
        </li>
      ))}
      {dir.files.map((f) => (
        <li key={f.path} className='flex items-center justify-between gap-4'>
          <button type='button' aria-pressed={openPath === f.path} className={cn('border-border hover:bg-muted/50 truncate rounded-md border px-2 py-1 text-left text-sm hover:underline', openPath === f.path && 'bg-muted font-semibold')} onClick={() => onOpen(f)}>
            <Visible text={f.path.split('/').pop()!} />
          </button>
          <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{size(f.size)}</span>
        </li>
      ))}
    </ul>
  );
}

function VersionFiles({ store, version }: { store: string; version: number }) {
  const { data, error } = useOrgLoad(() => get<Tree>(`/${seg(store)}/versions/${version}/files`), [store, version]);
  const [open, setOpen] = useState<FileEntry | null>(null);
  const tree = useMemo(() => (data ? treeOf(data.files) : null), [data]);
  if (error) return <ErrorState error={error} />;
  if (!data || !tree) return <LoadingCards count={1} />;
  return (
    <div className='flex flex-col gap-4'>
      {data.hidden > 0 && <p className='text-muted-foreground text-sm'>{data.hidden} {data.hidden === 1 ? 'file is' : 'files are'} not shown: hidden files, passwords and keys, and files marked secret never are.</p>}
      {!data.files.length ? <p className='text-muted-foreground text-sm'>This version has no files you can see.</p> : (
        <>
          <nav aria-label='Files of this version' className='max-h-72 overflow-auto rounded-md border p-2'>
            <DirView dir={tree} onOpen={setOpen} openPath={open?.path ?? null} />
          </nav>
          {open ? <FileView key={open.path} store={store} version={version} file={open} /> : <p className='text-muted-foreground text-sm'>Pick a file to see what is in it.</p>}
        </>
      )}
    </div>
  );
}

const downloadHref = (store: string, version: number, path: string) => `${BASE}/${seg(store)}/versions/${version}/download?${q(path)}`;

function FileView({ store, version, file }: { store: string; version: number; file: FileEntry }) {
  const { data, error } = useOrgLoad(() => get<Viewed>(`/${seg(store)}/versions/${version}/file?${q(file.path)}`), [store, version, file.path]);
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span className='truncate text-sm font-medium'><Visible text={file.path} /></span>
        <Button variant='outline' size='sm' data-file-download='' render={<a href={downloadHref(store, version, file.path)} download />}>Download</Button>
      </div>
      {error ? <p className='text-muted-foreground text-sm'>{error.message}</p> : !data ? <LoadingCards count={1} /> : data.binary || data.text === null ? (
        <p className='text-muted-foreground text-sm'>This file cannot be shown here ({size(data.size)}): download it to open it.</p>
      ) : (
        <pre className='bg-muted max-h-[32rem] overflow-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre'><Visible text={data.text} /></pre>
      )}
    </div>
  );
}

function Compare({ store, from, to, names }: { store: string; from: number; to: number; names: Map<number, string> }) {
  const { data, error } = useOrgLoad(() => get<Changes>(`/${seg(store)}/diff?from=${from}&to=${to}`), [store, from, to]);
  const [open, setOpen] = useState<string | null>(null);
  if (from === to) return <p className='text-muted-foreground text-sm'>Pick a different version to compare with.</p>;
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  const none = !data.added.length && !data.removed.length && !data.changed.length;
  const row = (path: string, kind: 'added' | 'removed' | 'changed', detail: string) => (
    <li key={`${kind}/${path}`} className='flex items-center justify-between gap-4'>
      <button type='button' aria-expanded={open === path} className={cn('border-border hover:bg-muted/50 truncate rounded-md border px-2 py-1 text-left text-sm hover:underline', open === path && 'bg-muted font-semibold')} onClick={() => setOpen(open === path ? null : path)}>
        <Badge variant={kind === 'removed' ? 'destructive' : 'secondary'} className='mr-2'>{kind === 'added' ? 'Added' : kind === 'removed' ? 'Removed' : 'Changed'}</Badge><Visible text={path} />
      </button>
      <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{detail}</span>
    </li>
  );
  return (
    <div className='flex flex-col gap-4'>
      {none ? <p className='text-muted-foreground text-sm'>No file you can see differs between {names.get(data.from) ?? 'the older version'} and {names.get(data.to) ?? 'the newer one'}.</p> : (
        <>
          <p className='text-muted-foreground text-sm'>From {names.get(data.from) ?? 'the older version'} to {names.get(data.to) ?? 'the newer one'}. Open a changed file to see its lines.</p>
          <ul className='flex flex-col gap-1'>
            {data.changed.map((f) => row(f.path, 'changed', `${size(f.from_size)} → ${size(f.size)}`))}
            {data.added.map((f) => row(f.path, 'added', size(f.size)))}
            {data.removed.map((f) => row(f.path, 'removed', size(f.size)))}
          </ul>
        </>
      )}
      {open && <LineDiff key={open} store={store} from={data.from} to={data.to} path={open} />}
    </div>
  );
}

/**
 * A changed file's lines (mold_v0-298): the added lines on green, the removed ones on red, a few unchanged lines around
 * them; the stretches of unchanged lines between are a plain "unchanged lines" mark, never a diff hunk header.
 */
function LineDiff({ store, from, to, path }: { store: string; from: number; to: number; path: string }) {
  const { data, error } = useOrgLoad(() => get<FileDiff>(`/${seg(store)}/diff?from=${from}&to=${to}&${q(path)}`), [store, from, to, path]);
  if (error) return <p className='text-muted-foreground text-sm'>{error.message}</p>;
  if (!data) return <LoadingCards count={1} />;
  if (!data.hunks.length) return <p className='text-muted-foreground text-sm'>{data.note ? `The lines are the same: ${data.note}.` : 'The file is the same in both versions.'}</p>;
  return (
    <div className='flex flex-col gap-2' aria-label={`Changes to ${path}`}>
      <p className='text-muted-foreground text-xs'>Added lines are green, removed lines are red.</p>
      <pre className='bg-muted max-h-[32rem] overflow-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre'>
        {data.hunks.map((h, i) => (
          <Fragment key={i}>
            {(i > 0 || h.from_start > 1) && <span className='text-muted-foreground block py-1 font-sans italic select-none'>⋯ unchanged lines</span>}
            {h.lines.map((l, j) => (
              <span key={j} className={cn('block', l.op === '+' && 'bg-green-500/15', l.op === '-' && 'bg-red-500/15')}>
                <span aria-hidden className='text-muted-foreground select-none'>{l.op === ' ' ? '  ' : `${l.op} `}</span>
                <span className='sr-only'>{l.op === '+' ? 'added: ' : l.op === '-' ? 'removed: ' : ''}</span>
                <Visible text={l.text} />
              </span>
            ))}
          </Fragment>
        ))}
      </pre>
    </div>
  );
}
