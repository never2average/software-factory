'use client';
// A record page's file browser (mold_v0-256, flag record_pages): the record's documents and files (its file fields'
// stored files and its documents by address, GET /api/records/<area>/<key>/files, as the document cards read them:
// mold_v0-220) as a tree, a folder per field when the section lists several (a name with "/" in it nests further), and
// the open one previewed with its own document card (type, size, Download, the preview). On a phone the tree, then the
// preview below it. The tree is an ARIA tree: arrow keys move, Left and Right close and open a folder, Enter opens a file.
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '@/components/icons';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { cn } from '@/lib/utils';
import { fileTree, folderPaths, sizeWords, treeRows, type TreeNode } from './code-text';
import { DocumentCard, useRecordFiles, type FileCard } from './documents';

export function FileBrowser({ area, base, recordKey, fields, empty }: { area: RecordAreaSpec; base: 'app' | 'admin'; recordKey: string; fields?: string[]; empty: string }) {
  const { wanted, cards, error } = useRecordFiles(area, base, recordKey);
  const kept = useMemo(() => (cards ?? []).filter((c) => !fields?.length || fields.includes(c.field)), [cards, fields]);
  const byField = new Set(kept.map((c) => c.field)).size > 1;
  const tree = useMemo(() => fileTree(kept.map((c) => ({ path: `${byField ? `${c.label}/` : ''}${c.name}`, item: c }))), [kept, byField]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => { setOpen(new Set(folderPaths(tree))); }, [tree]);
  const rows = treeRows(tree, open);
  const first = rows.find((r) => r.node.item)?.node.path ?? null;
  const current = rows.find((r) => r.node.path === (chosen ?? first))?.node.item ?? kept[0] ?? null;
  if (!wanted) return null;
  if (error) return <p className='text-muted-foreground px-6 py-5 text-sm'>{error}</p>;
  if (!cards) return <div className='flex flex-col gap-2 px-6 py-4' aria-busy='true' data-section-loading=''>{[0, 1].map((i) => <div key={i} className='bg-muted h-5 animate-pulse rounded' style={{ width: `${70 - i * 20}%` }} />)}</div>;
  if (!kept.length) return (
    <div className='flex items-center gap-3 px-6 py-5' data-section-empty=''>
      <Icons.folder aria-hidden className='text-muted-foreground size-5 shrink-0' />
      <p className='text-muted-foreground text-sm'>{empty}</p>
    </div>
  );
  const toggle = (n: TreeNode<FileCard>) => setOpen((s) => { const x = new Set(s); if (x.has(n.path)) x.delete(n.path); else x.add(n.path); return x; });
  const act = (n: TreeNode<FileCard>) => (n.item ? setChosen(n.path) : toggle(n));
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const r = rows[i]!, n = r.node;
    const go = (j: number) => { const t = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (t) { setFocus(t.node.path); document.getElementById(`ft-${encodeURIComponent(t.node.path)}`)?.focus(); } };
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'ArrowRight' && !n.item && !open.has(n.path)) { e.preventDefault(); toggle(n); }
    else if (e.key === 'ArrowLeft' && !n.item && open.has(n.path)) { e.preventDefault(); toggle(n); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(n); }
  };
  return (
    <div className='grid min-w-0 md:grid-cols-[minmax(14rem,18rem)_1fr]' data-file-browser=''>
      <ul role='tree' aria-label={`${area.label}: files`} className='flex flex-col gap-px border-b p-2 md:border-r md:border-b-0' data-file-tree=''>
        {rows.map(({ node: n, depth }, i) => {
          const selected = !!n.item && n.item === current;
          const tabbable = (focus ?? rows.find((r) => r.node.item === current)?.node.path ?? rows[0]?.node.path) === n.path;
          return (
            <li key={n.path} id={`ft-${encodeURIComponent(n.path)}`} role='treeitem' aria-selected={n.item ? selected : undefined} aria-expanded={n.item ? undefined : open.has(n.path)}
              aria-level={depth + 1} tabIndex={tabbable ? 0 : -1} onClick={() => act(n)} onKeyDown={(e) => onKey(e, i)} onFocus={() => setFocus(n.path)}
              data-file-node={n.item ? 'file' : 'folder'} data-path={n.path}
              className={cn('flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-muted/60')}
              style={{ paddingLeft: `${0.5 + depth * 1}rem` }}>
              {n.item ? <Icons.file aria-hidden className='text-muted-foreground size-4 shrink-0' />
                : open.has(n.path) ? <Icons.folderOpen aria-hidden className='size-4 shrink-0 text-amber-600 dark:text-amber-400' /> : <Icons.folder aria-hidden className='size-4 shrink-0 text-amber-600 dark:text-amber-400' />}
              <span className='min-w-0 flex-1 truncate' title={n.name}>{n.name}</span>
              {n.item?.size != null && <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{sizeWords(n.item.size)}</span>}
            </li>
          );
        })}
      </ul>
      <div className='min-w-0 p-3 sm:p-4' data-file-preview={current?.id ?? ''} aria-live='polite'>
        {current ? <ul className='flex flex-col'><DocumentCard c={current} /></ul> : null}
      </div>
    </div>
  );
}
