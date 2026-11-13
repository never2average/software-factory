'use client';
// A home tab's recent records card (mold_v0-298: pack.json rail recent:<area>): a cell of the home grid's rail, as the
// Due soon card is, listing the newest records of one of the build's areas (the last changed first), each opening its
// record page, and a link to the area's tab. Read through the data API as the person (GET /api/data/<area>, sorted by
// the last change): a role that may not read the area gets a refusal, and the card then draws nothing. With no records,
// the compact empty note of its sibling cards (features/portal/home-cards.tsx), in the words of the area tab's own empty
// state (src/metric-spec.ts tabEmpty) and its next step as a link. The list scrolls inside the card, so a short rail
// never cuts it off.
import Link from 'next/link';
import { Icons } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { packTabs } from '@/config/pack-nav.generated';
import { GridCell } from '@/features/portal/grid-cell';
import { ErrorState, useOrgLoad } from '@/features/portal/shared';
import { findRecordArea } from '@/features/records/registry';
import { httpError } from '@/features/status/from-error';

/** How many records the card lists. */
const SHOWN = 5;

type Row = { key: string; title: string | null; updated_at: string };

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

/** The rail's compact empty note (as home-cards.tsx's), with the area tab's next step as a link when it has one. */
function EmptyNote({ title, text, cta }: { title: string; text: string; cta: { label: string; href: string } | null }) {
  return (
    <div className='flex items-start gap-3 rounded-lg border border-dashed px-3 py-4'>
      <Icons.circleCheck aria-hidden className='text-muted-foreground mt-0.5 size-5 shrink-0' />
      <div className='flex min-w-0 flex-col gap-1'>
        <p className='text-sm font-medium'>{title}</p>
        <p className='text-muted-foreground text-xs'>{text}</p>
        {cta && <Link href={cta.href} className='text-primary self-start text-xs font-medium hover:underline'>{cta.label}</Link>}
      </div>
    </div>
  );
}

export function RecentRecordsCard({ area: name }: { area: string }) {
  const area = findRecordArea('app', name);
  // The area's own tab (one over this area alone, not narrowed): its address and its empty state.
  const tab = packTabs.find((t) => t.kind === 'area' && t.area === name && !t.areas && !t.filtered);
  const url = `/api/data/${encodeURIComponent(name)}?limit=${SHOWN}&sort=-updated_at`;
  const { data, error } = useOrgLoad(async () => {
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as { records?: Row[]; error?: string };
    // Not this person's to read (or switched off for the workspace): no card, as a chart card a role may not read.
    if (res.status === 403 || res.status === 404) return { refused: true as const, rows: [] as Row[] };
    if (!res.ok) throw httpError(res.status, body);
    return { refused: false as const, rows: body.records ?? [] };
  }, [url]);
  if (!area || data?.refused) return null;
  const rows = data?.rows ?? null;
  const label = tab?.label ?? area.label;
  // "Findings" -> "Recent findings"; an initialism ("API keys") keeps its capitals.
  const words = /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
  const title = `Recent ${words}`;
  const empty = tab?.empty ?? { title: `No ${words} yet.`, text: 'They show here as soon as one is added.', cta: null };
  return (
    <GridCell title={title} icon={<Icons.clock />}
      action={tab && rows && rows.length > 0 ? <Link href={tab.url} className='text-primary text-xs font-medium hover:underline'>View all</Link> : undefined}>
      {error ? <ErrorState error={error} />
        : rows === null ? (
          <div className='flex flex-col gap-2' aria-busy='true' aria-label={`Loading ${title.toLowerCase()}`}>
            {Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className='h-10 w-full' />)}
          </div>
        ) : !rows.length ? <EmptyNote title={empty.title} text={empty.text} cta={empty.cta ?? null} />
        : (
          <ul className='flex max-h-72 flex-col gap-0.5 overflow-y-auto overscroll-contain' aria-label={title} data-recent-records={name}>
            {rows.map((r) => (
              <li key={r.key}>
                <Link href={`/app/records/${encodeURIComponent(name)}/${encodeURIComponent(r.key)}`} className='hover:bg-muted/60 flex items-center gap-3 rounded-lg px-2 py-2 text-sm'>
                  <span className='flex min-w-0 flex-1 flex-col'>
                    <span className='truncate font-medium'>{r.title || r.key}</span>
                    <span className='text-muted-foreground truncate text-xs'>{ago(r.updated_at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
    </GridCell>
  );
}
