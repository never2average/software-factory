'use client';
// A record's change history (mold_v0-256, flag record_pages; the server's src/record-history.ts, through
// GET /api/records/_page/<area>/<key>): newest first, each change as who did what and when (the exact time on hover),
// then each field that changed: its label, its value before (struck through) and after, formatted as the record's own
// fields are; a long text as a line diff (added and removed lines marked, unchanged runs folded); an encrypted field only
// "changed", never a value. Show more reads the older ones. No count beside the title; light and dark alike.
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { cn } from '@/lib/utils';
import { diffCounts, foldDiff, isLongText, lineDiff } from './code-text';
import { CHANGE_WORDS, columnUnit, dateWords, numberWords, type FieldChange, type HistoryData, type RecordChangeView } from './detail-layout';
import { fieldText, refTarget, refWords } from './record-pages';

const ACTION_ICON: Record<RecordChangeView['action'], keyof typeof import('@/components/icons').Icons> = { created: 'add', updated: 'edit', moved: 'arrowRight', deleted: 'trash' };

/** mold_v0-300: the titles of the records a reference names, {field: {key: title}} (the record's own, then those looked up). */
type Titles = Record<string, Record<string, string>>;

/** A value as the record's fields read: an option's label, a date, Yes or No, a list joined, a long value whole. */
function ValueText({ area, field, v, titles }: { area: RecordAreaSpec; field: string; v: unknown; titles?: Titles }) {
  const f = area.fields.find((x) => x.name === field);
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return <span className='text-muted-foreground italic'>empty</span>;
  if (v && typeof v === 'object' && '$truncated' in (v as object)) return <span className='text-muted-foreground italic'>a long value (not kept in full)</span>;
  // mold_v0-300: a reference reads as the named records' titles, never their keys ("crud-workspace").
  if (refTarget(area, f)) return <>{refWords(v, titles?.[field])}</>;
  // A number with the unit its page gives it (a duration in seconds in words), as the record's own facts read.
  if (f?.type === 'number') { const unit = columnUnit(area, field); if (unit) return <>{numberWords(v, unit)}</>; }
  return <>{fieldText(f, v) || String(v)}</>;
}

/** A long text's change as a line diff. */
function TextDiff({ before, after }: { before: string; after: string }) {
  const lines = lineDiff(before, after);
  const n = diffCounts(lines);
  return (
    <div className='flex flex-col gap-1.5' data-history-diff=''>
      <p className='text-muted-foreground text-xs'><span className='text-emerald-700 dark:text-emerald-400'>+{n.added}</span> <span className='text-destructive'>−{n.removed}</span> lines</p>
      <pre className='bg-muted/30 dark:bg-muted/20 max-h-80 overflow-auto rounded-md border py-1.5 font-mono text-xs leading-5'>
        {foldDiff(lines).map((l, i) => ('skip' in l ? (
          <div key={i} className='text-muted-foreground bg-muted/50 px-3 text-center italic select-none' data-diff-skip={l.skip}>{l.skip} unchanged {l.skip === 1 ? 'line' : 'lines'}</div>
        ) : (
          <div key={i} data-diff={l.kind} className={cn('flex whitespace-pre-wrap',
            l.kind === 'added' && 'bg-emerald-500/10 text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-200',
            l.kind === 'removed' && 'bg-destructive/10 text-destructive dark:text-red-300')}>
            <span className='w-6 shrink-0 text-center select-none' aria-hidden>{l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ''}</span>
            <span className='sr-only'>{l.kind === 'added' ? 'Added: ' : l.kind === 'removed' ? 'Removed: ' : ''}</span>
            <span className='min-w-0 flex-1 pr-3 break-words'>{l.text || ' '}</span>
          </div>
        )))}
      </pre>
    </div>
  );
}

function FieldRow({ area, c, action, titles }: { area: RecordAreaSpec; c: FieldChange; action: RecordChangeView['action']; titles?: Titles }) {
  const label = area.fields.find((f) => f.name === c.field)?.label ?? c.label ?? c.field;
  if (c.redacted) return (
    <div className='grid gap-1 sm:grid-cols-[minmax(8rem,12rem)_1fr] sm:gap-4' data-history-field={c.field} data-redacted=''>
      <dt className='text-muted-foreground text-xs font-medium sm:pt-0.5'>{label}</dt>
      <dd className='text-muted-foreground flex items-center gap-1.5 text-sm'><Icons.lock aria-hidden className='size-3.5' />Changed · encrypted, so its values are not shown</dd>
    </div>
  );
  const long = isLongText(c.before, c.after) && typeof (c.before ?? '') === 'string' && typeof (c.after ?? '') === 'string';
  return (
    <div className='grid gap-1 sm:grid-cols-[minmax(8rem,12rem)_1fr] sm:gap-4' data-history-field={c.field}>
      <dt className='text-muted-foreground text-xs font-medium sm:pt-0.5'>{label}</dt>
      <dd className='min-w-0 text-sm'>
        {/* A new record's values: each at most three lines (a long log or manifest is the record's own to read). */}
        {action === 'created' ? <span className='line-clamp-3 break-words' title={typeof c.after === 'string' && c.after.length > 200 ? `${c.after.slice(0, 200)}…` : undefined}><ValueText area={area} field={c.field} v={c.after} titles={titles} /></span>
          : long ? <TextDiff before={String(c.before ?? '')} after={String(c.after ?? '')} />
          : (
            <span className='flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words'>
              <span className='text-muted-foreground line-through decoration-1' data-history-before=''><span className='sr-only'>From </span><ValueText area={area} field={c.field} v={c.before} titles={titles} /></span>
              <Icons.arrowRight aria-hidden className='text-muted-foreground size-3.5 shrink-0 self-center' />
              <span className='font-medium' data-history-after=''><span className='sr-only'>to </span><ValueText area={area} field={c.field} v={c.after} titles={titles} /></span>
            </span>
          )}
      </dd>
    </div>
  );
}

/** A reference's keys in a change's values. */
const keysIn = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((k): k is string => typeof k === 'string' && k !== '');

/**
 * mold_v0-300: the titles of every record the shown changes name by reference: the record's own (ref_titles), and for a
 * key it no longer names, one look-up through the record picker (GET /api/records/_page/_pick/<area>?q=<key>, read as
 * the person: a record they may not read stays its key). At most 20 look-ups, each once.
 */
function useChangeTitles(area: RecordAreaSpec, changes: readonly RecordChangeView[], own: Titles | undefined): Titles {
  const [found, setFound] = useState<Titles>({});
  const missing = useMemo(() => {
    const out: { field: string; to: string; key: string }[] = [];
    for (const h of changes) for (const c of h.changes) {
      const f = area.fields.find((x) => x.name === c.field), to = refTarget(area, f);
      if (!to || c.redacted) continue;
      for (const k of [...keysIn(c.before), ...keysIn(c.after)])
        if (!own?.[c.field]?.[k] && !out.some((m) => m.field === c.field && m.key === k)) out.push({ field: c.field, to, key: k });
    }
    return out.slice(0, 20);
  }, [area, changes, own]);
  const ask = missing.filter((m) => found[m.field]?.[m.key] === undefined).map((m) => `${m.field}\u0000${m.to}\u0000${m.key}`).join('\n');
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void Promise.all(ask.split('\n').map(async (line) => {
      const [field, to, key] = line.split('\u0000') as [string, string, string];
      try {
        const res = await fetch(`/api/records/_page/_pick/${encodeURIComponent(to)}?q=${encodeURIComponent(key)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
        const body = (await res.json().catch(() => ({}))) as { records?: { key: string; title: string | null }[] };
        return { field, key, title: (res.ok && body.records?.find((r) => r.key === key)?.title) || key };
      } catch { return { field, key, title: key }; }
    })).then((got) => {
      if (!live) return;
      setFound((was) => { const next = { ...was }; for (const g of got) next[g.field] = { ...next[g.field], [g.key]: g.title }; return next; });
    });
    return () => { live = false; };
  }, [ask]);
  return useMemo(() => {
    const out: Titles = { ...found };
    for (const [field, t] of Object.entries(own ?? {})) out[field] = { ...out[field], ...t };
    return out;
  }, [found, own]);
}

export function HistoryList({ area, data, url, empty, titles: own }: { area: RecordAreaSpec; data: HistoryData; url: string; empty: string;
  /** mold_v0-300: the record's own reference titles (its ref_titles), so a change names records by title. */
  titles?: Titles }) {
  const [older, setOlder] = useState<RecordChangeView[]>([]);
  const [more, setMore] = useState(data.more);
  const [busy, setBusy] = useState(false);
  const all = [...data.changes, ...older];
  const titles = useChangeTitles(area, all, own);
  const loadMore = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${url}&before=${all[all.length - 1]!.id}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const body = (await res.json().catch(() => ({}))) as HistoryData & { error?: string };
      if (!res.ok) throw httpError(res.status, body);
      setOlder((o) => [...o, ...body.changes]); setMore(body.more);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  if (!all.length) return (
    <div className='flex items-center gap-3 px-6 py-5' data-section-empty=''>
      <Icons.history aria-hidden className='text-muted-foreground size-5 shrink-0' />
      <p className='text-muted-foreground text-sm'>{empty}</p>
    </div>
  );
  return (
    <div className='flex flex-col' data-history=''>
      <ol className='flex flex-col'>
        {all.map((h, i) => {
          const Icon = (Icons as Record<string, React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>>)[ACTION_ICON[h.action]]!;
          const when = dateWords(h.at);
          const fields = [...(h.title ? [{ field: '$title', label: 'Title', before: h.title.before, after: h.title.after }] : []), ...h.changes];
          return (
            <li key={h.id} className='relative flex gap-3 px-4 py-4 sm:px-6' data-history-change={h.action}>
              {i < all.length - 1 && <span aria-hidden className='bg-border absolute top-11 bottom-0 left-[calc(1rem+0.875rem)] w-px sm:left-[calc(1.5rem+0.875rem)]' />}
              <span className={cn('bg-background relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border',
                h.action === 'deleted' && 'text-destructive border-destructive/40', h.action === 'created' && 'text-emerald-700 dark:text-emerald-400 border-emerald-600/30')}>
                <Icon aria-hidden className='size-3.5' />
              </span>
              <div className='flex min-w-0 flex-1 flex-col gap-3'>
                <p className='text-sm leading-7'>
                  <span className='font-medium'>{h.by}</span>{' '}
                  <span className='text-muted-foreground'>{h.action === 'created' ? 'added it' : h.action === 'deleted' ? 'deleted it' : h.action === 'moved' ? 'moved it' : `changed ${fields.length === 1 ? 'one field' : `${fields.length} fields`}`}</span>
                  {when && <> <span className='text-muted-foreground'>·</span> <time dateTime={when.iso} title={when.absolute} className='text-muted-foreground'>{when.relative}</time></>}
                  <span className='sr-only'> ({CHANGE_WORDS[h.action]})</span>
                </p>
                {!!fields.length && h.action !== 'deleted' && (
                  <dl className='flex flex-col gap-3 rounded-lg border px-3 py-3 sm:px-4'>
                    {fields.map((c) => c.field === '$title'
                      ? <FieldRow key='$title' area={{ ...area, fields: [...area.fields, { name: '$title', label: 'Title', type: 'text' }] }} c={c} action={h.action} />
                      : <FieldRow key={c.field} area={area} c={c} action={h.action} titles={titles} />)}
                  </dl>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {more && (
        <div className='border-t px-4 py-3 sm:px-6'>
          <Button type='button' variant='outline' size='sm' onClick={() => void loadMore()} disabled={busy} data-history-more=''>
            <Icons.chevronDown aria-hidden data-icon='inline-start' />{busy ? 'Loading…' : 'Show older changes'}
          </Button>
        </div>
      )}
    </div>
  );
}
