'use client';
// A record's log or timeline value as a compact table (mold_v0-298; web/src/lib/record-entries.ts reads it): time, level
// or status (a coloured badge), message and source, the columns its entries' own keys give, oldest first as stored. The
// first rows, then Show all; the value as stored behind Show raw. Drawn wherever a record's field is (./record-pages.tsx
// FieldValue: a record's page, an open row, a laid-out page's section).
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { entriesRaw, entryTime, entryTone, type EntriesView } from '@/lib/record-entries';
import { BADGE_CLASS, dateWords } from './detail-layout';
import { keyLabel } from './json-text';

/** How many entries show before Show all. */
const FIRST_ROWS = 20;

/** A column's heading: the part it plays, in words ("Status" when the entries say status, "Time", "Message"). */
const heading = (part: 'time' | 'level' | 'message' | 'source', key: string) =>
  part === 'time' ? 'Time' : part === 'message' && /^(message|msg|text|line)$/.test(key) ? 'Message' : keyLabel(key);

function EntryTimeText({ v }: { v: unknown }) {
  const t = entryTime(v);
  const w = t == null ? null : dateWords(typeof v === 'string' ? v : new Date(t).toISOString());
  if (!w) return <>{v == null ? '' : String(v)}</>;
  return <time dateTime={w.iso} title={w.relative} className='whitespace-nowrap tabular-nums'>{w.absolute}</time>;
}

export function EntriesTable({ view, raw, label }: { view: EntriesView; raw: unknown; label: string }) {
  const [all, setAll] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const { columns: c, rows } = view;
  const shown = all ? rows : rows.slice(0, FIRST_ROWS);
  const th = 'text-muted-foreground h-8 px-2 text-left align-middle text-xs font-medium whitespace-nowrap first:pl-0';
  const td = 'px-2 py-1.5 align-top first:pl-0';
  return (
    <div className='flex w-full min-w-0 flex-col gap-2 whitespace-normal' data-json-entries=''>
      {showRaw ? (
        <pre className='bg-muted/40 max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed whitespace-pre' data-json-raw=''>{entriesRaw(raw)}</pre>
      ) : (
        <div className='w-full overflow-x-auto'>
          <table className='w-full border-collapse text-sm' aria-label={label}>
            <thead>
              <tr className='border-b'>
                {c.time && <th scope='col' className={th}>{heading('time', c.time)}</th>}
                {c.level && <th scope='col' className={th}>{heading('level', c.level)}</th>}
                <th scope='col' className={th}>{c.message ? heading('message', c.message) : 'Details'}</th>
                {c.source && <th scope='col' className={th}>{heading('source', c.source)}</th>}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i} className='border-b last:border-b-0' data-json-entry=''>
                  {c.time && <td className={cn(td, 'text-muted-foreground text-xs')}><EntryTimeText v={r.time} /></td>}
                  {c.level && (
                    <td className={td}>
                      {r.level ? (
                        <Badge variant='secondary' data-badge-color={entryTone(r.level)} className={cn('gap-1.5 ring-1 ring-inset', BADGE_CLASS[entryTone(r.level)])}>
                          <span aria-hidden className='size-1.5 shrink-0 rounded-full bg-current opacity-80' />
                          {r.level.charAt(0).toUpperCase() + r.level.slice(1)}
                        </Badge>
                      ) : <span className='text-muted-foreground'>—</span>}
                    </td>
                  )}
                  <td className={cn(td, 'min-w-48 break-words')}>{r.message || <span className='text-muted-foreground'>—</span>}</td>
                  {c.source && <td className={cn(td, 'text-muted-foreground text-xs whitespace-nowrap')}>{r.source ?? '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className='flex flex-wrap items-center gap-2'>
        {!showRaw && rows.length > FIRST_ROWS && (
          <Button type='button' variant='outline' size='xs' onClick={() => setAll((x) => !x)} data-json-entries-all=''>
            {all ? `Show the first ${FIRST_ROWS}` : `Show all ${rows.length.toLocaleString('en')}`}
          </Button>
        )}
        <Button type='button' variant='outline' size='xs' aria-pressed={showRaw} onClick={() => setShowRaw((x) => !x)} data-json-entries-raw=''>
          {/* One label, its state in aria-pressed (a screen reader reads "Show raw, pressed"). */}
          Show raw
        </Button>
      </div>
    </div>
  );
}
