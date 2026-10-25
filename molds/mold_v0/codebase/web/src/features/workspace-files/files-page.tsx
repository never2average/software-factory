'use client';
// /app/files (mold_v0-056; src/workspace-files.ts): the files a pack's runs keep in the workspace store. Each version is
// what one run left; pick one to browse its files, open a text file, download a file, or compare two versions.
// Everything is shown as text (React escapes it): a file's contents are never rendered as markup, and characters that
// change how text reads (direction overrides, invisible marks) are shown as visible codes. The server never lists or
// serves hidden files, credential files or anything the pack declares secret.
import { useMemo, useState, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Section } from '@/components/layout/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorState, LoadingCards, When, useOrgLoad } from '@/features/portal/shared';
import { cn } from '@/lib/utils';
import { httpError } from '@/features/status/from-error';

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
    <PageContainer pageTitle='Files' pageDescription='What your runs keep between runs: each version is what one run left. Browse a version, open or download a file, or compare two versions.'>
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={2} /> : !data.stores.length ? (
        <p className='text-muted-foreground text-sm'>There are no files your role can see here.</p>
      ) : (
        <div className='flex flex-col gap-8'>
          {data.stores.length > 1 && (
            <NativeSelect value={store!.store} onChange={(e) => setPicked(e.target.value)} aria-label='Which files'>
              {data.stores.map((s) => <NativeSelectOption key={s.store} value={s.store}>{s.label}</NativeSelectOption>)}
            </NativeSelect>
          )}
          <StoreView key={store!.store} store={store!} />
        </div>
      )}
    </PageContainer>
  );
}

function StoreView({ store }: { store: Store }) {
  const { data, error } = useOrgLoad(() => get<{ versions: Version[] }>(`/${seg(store.store)}/versions`), [store.store]);
  const [open, setOpen] = useState<number | null>(null);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  const versions = data.versions;
  const shown = open ?? versions[0]?.version ?? null;
  return (
    <div className='flex flex-col gap-8'>
      <Section title='Versions' description={retentionText(store.retention)}>
        {!versions.length ? <p className='text-muted-foreground text-sm'>No run has written files yet.</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead><TableHead>Written</TableHead><TableHead>By run</TableHead>
                <TableHead className='text-right'>Files</TableHead><TableHead className='text-right'>Size</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.version} data-state={shown === v.version ? 'selected' : undefined}>
                  <TableCell className='font-mono text-sm'>v{v.version}{v.version === versions[0]!.version && <Badge variant='secondary' className='ml-2'>latest</Badge>}</TableCell>
                  <TableCell><When d={v.committed_at} /></TableCell>
                  <TableCell className='font-mono text-xs'>{v.run_kind ? `${v.run_kind} · ` : ''}{v.run_id ?? '—'}</TableCell>
                  <TableCell className='text-right tabular-nums'>{v.files}</TableCell>
                  <TableCell className='text-right tabular-nums'>{size(v.bytes)}</TableCell>
                  <TableCell className='text-right'>
                    <Button variant='ghost' size='sm' aria-pressed={shown === v.version} onClick={() => setOpen(v.version)}>Browse</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      {shown !== null && <VersionFiles key={`${store.store}/${shown}`} store={store.store} version={shown} />}
      {versions.length > 1 && (
        <Section title='Compare versions' description='What changed between two versions; open a changed text file to see its lines.'>
          <div className='flex flex-wrap items-center gap-2'>
            <NativeSelect value={String(from ?? versions[1]!.version)} onChange={(e) => setFrom(Number(e.target.value))} aria-label='From version'>
              {versions.map((v) => <NativeSelectOption key={v.version} value={String(v.version)}>v{v.version}</NativeSelectOption>)}
            </NativeSelect>
            <span className='text-muted-foreground text-sm'>to</span>
            <NativeSelect value={String(to ?? versions[0]!.version)} onChange={(e) => setTo(Number(e.target.value))} aria-label='To version'>
              {versions.map((v) => <NativeSelectOption key={v.version} value={String(v.version)}>v{v.version}</NativeSelectOption>)}
            </NativeSelect>
          </div>
          <Compare key={`${from ?? versions[1]!.version}-${to ?? versions[0]!.version}`} store={store.store} from={from ?? versions[1]!.version} to={to ?? versions[0]!.version} />
        </Section>
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
            <summary className='cursor-pointer font-mono text-sm'>{name}/</summary>
            <DirView dir={d} onOpen={onOpen} openPath={openPath} />
          </details>
        </li>
      ))}
      {dir.files.map((f) => (
        <li key={f.path} className='flex items-center justify-between gap-4'>
          <button type='button' className={cn('truncate text-left font-mono text-sm hover:underline', openPath === f.path && 'font-semibold underline')} onClick={() => onOpen(f)}>
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
  return (
    <Section title={`Files of v${version}`} description={data?.hidden ? `${data.hidden} file(s) are not shown: hidden files, credentials and files marked secret never are.` : undefined}>
      {error ? <ErrorState error={error} /> : !data || !tree ? <LoadingCards count={1} /> : !data.files.length ? (
        <p className='text-muted-foreground text-sm'>No files to show in this version.</p>
      ) : (
        <div className='grid gap-6 lg:grid-cols-[minmax(14rem,22rem)_1fr]'>
          <nav aria-label={`Files of version ${version}`} className='max-h-[32rem] overflow-auto rounded-md border p-2'>
            <DirView dir={tree} onOpen={setOpen} openPath={open?.path ?? null} />
          </nav>
          <div className='min-w-0'>{open ? <FileView key={open.path} store={store} version={version} file={open} /> : <p className='text-muted-foreground text-sm'>Pick a file to see it.</p>}</div>
        </div>
      )}
    </Section>
  );
}

const downloadHref = (store: string, version: number, path: string) => `${BASE}/${seg(store)}/versions/${version}/download?${q(path)}`;

function FileView({ store, version, file }: { store: string; version: number; file: FileEntry }) {
  const { data, error } = useOrgLoad(() => get<Viewed>(`/${seg(store)}/versions/${version}/file?${q(file.path)}`), [store, version, file.path]);
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span className='truncate font-mono text-sm'><Visible text={file.path} /></span>
        <Button variant='outline' size='sm' render={<a href={downloadHref(store, version, file.path)} download />}>Download</Button>
      </div>
      {error ? <p className='text-muted-foreground text-sm'>{error.message}</p> : !data ? <LoadingCards count={1} /> : data.binary || data.text === null ? (
        <p className='text-muted-foreground text-sm'>Not a text file ({size(data.size)}): download it to open it.</p>
      ) : (
        <pre className='bg-muted max-h-[32rem] overflow-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre'><Visible text={data.text} /></pre>
      )}
    </div>
  );
}

function Compare({ store, from, to }: { store: string; from: number; to: number }) {
  const { data, error } = useOrgLoad(() => get<Changes>(`/${seg(store)}/diff?from=${from}&to=${to}`), [store, from, to]);
  const [open, setOpen] = useState<string | null>(null);
  if (from === to) return <p className='text-muted-foreground text-sm'>Pick two different versions.</p>;
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingCards count={1} />;
  const none = !data.added.length && !data.removed.length && !data.changed.length;
  const row = (path: string, kind: 'added' | 'removed' | 'changed', detail: string) => (
    <li key={`${kind}/${path}`} className='flex items-center justify-between gap-4'>
      <button type='button' className={cn('truncate text-left font-mono text-sm hover:underline', open === path && 'font-semibold underline')} onClick={() => setOpen(open === path ? null : path)}>
        <Badge variant={kind === 'removed' ? 'destructive' : 'secondary'} className='mr-2'>{kind}</Badge><Visible text={path} />
      </button>
      <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{detail}</span>
    </li>
  );
  return (
    <div className='flex flex-col gap-4'>
      {none ? <p className='text-muted-foreground text-sm'>No shown file differs between v{data.from} and v{data.to}.</p> : (
        <ul className='flex flex-col gap-1'>
          {data.changed.map((f) => row(f.path, 'changed', `${size(f.from_size)} → ${size(f.size)}`))}
          {data.added.map((f) => row(f.path, 'added', size(f.size)))}
          {data.removed.map((f) => row(f.path, 'removed', size(f.size)))}
        </ul>
      )}
      {open && <LineDiff key={open} store={store} from={data.from} to={data.to} path={open} />}
    </div>
  );
}

function LineDiff({ store, from, to, path }: { store: string; from: number; to: number; path: string }) {
  const { data, error } = useOrgLoad(() => get<FileDiff>(`/${seg(store)}/diff?from=${from}&to=${to}&${q(path)}`), [store, from, to, path]);
  if (error) return <p className='text-muted-foreground text-sm'>{error.message}</p>;
  if (!data) return <LoadingCards count={1} />;
  if (!data.hunks.length) return <p className='text-muted-foreground text-sm'>{data.note ? `The lines are the same: ${data.note}.` : 'The file is the same in both versions.'}</p>;
  return (
    <div className='flex flex-col gap-3' aria-label={`Changes to ${path}`}>
      {data.hunks.map((h, i) => (
        <pre key={i} className='bg-muted max-h-[32rem] overflow-auto rounded-md p-3 font-mono text-xs leading-5 whitespace-pre'>
          <span className='text-muted-foreground'>{`@@ -${h.from_start},${h.from_lines} +${h.to_start},${h.to_lines} @@`}</span>
          {'\n'}
          {h.lines.map((l, j) => (
            <span key={j} className={cn('block', l.op === '+' && 'bg-green-500/15', l.op === '-' && 'bg-red-500/15')}>
              <span aria-hidden className='text-muted-foreground select-none'>{l.op === ' ' ? '  ' : `${l.op} `}</span>
              <span className='sr-only'>{l.op === '+' ? 'added: ' : l.op === '-' ? 'removed: ' : ''}</span>
              <Visible text={l.text} />
            </span>
          ))}
        </pre>
      ))}
    </div>
  );
}
