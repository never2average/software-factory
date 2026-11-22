'use client';
// A log drain's state above the pages that read its records (mold_v0-325; src/log-drain-health.ts, GET
// /api/log-drains/status): not connected yet (what to do), waiting for the first logs, silent for hours (a warning), or a
// quiet line saying when logs last arrived. Only on the tabs the build lists (developerConsole.drains.tabs: an overview
// whose charts read a drain's records, an area tab over them) and, when silent, on the home page. Nothing in a build
// without a log-drain receiver (no request is made).
import Link from 'next/link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { developerConsole } from '@/config/pack-nav.generated';
import { useOrgLoad } from '@/features/portal/shared';
import { dateTimeText } from '@/lib/display-format';

type DrainState = 'not_connected' | 'waiting' | 'receiving' | 'silent';
export interface Drain { receiver: string; areas: string[]; state: DrainState; sources: number; last_received_at: string | null; silent_hours: number; hours_since: number | null }

const drains = (developerConsole as { drains?: { areas: string[]; tabs: string[] } }).drains ?? null;
/** The tabs that show a drain's state (`<pack>/<tab id>`), from the build. */
export const drainTab = (pack: string, id: string) => !!drains?.tabs.includes(`${pack}/${id}`);
export const drainsInBuild = () => !!drains;

async function load(): Promise<Drain[]> {
  const res = await fetch('/api/log-drains/status', { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) return [];
  return ((await res.json().catch(() => ({}))) as { drains?: Drain[] }).drains ?? [];
}

const when = (iso: string) => dateTimeText(iso);
const ago = (h: number | null, iso: string | null) => {
  if (!iso) return '';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 60 ? `${m} minute${m === 1 ? '' : 's'} ago` : h !== null && h < 48 ? `${h} hour${h === 1 ? '' : 's'} ago` : `on ${when(iso)}`;
};
const INTEGRATIONS = '/app/settings?tab=integrations';

/** The state of the drains that fill this page's records (`areas`: those it reads; none: every drain). */
export function DrainStatus({ areas, silentOnly = false }: { areas?: string[]; silentOnly?: boolean }) {
  const { data } = useOrgLoad(() => (drains ? load() : Promise.resolve([])), []);
  const list = (data ?? []).filter((d) => !areas || d.areas.some((a) => areas.includes(a))).filter((d) => !silentOnly || d.state === 'silent');
  if (!list.length) return null;
  return (
    <div className='flex flex-col gap-2' data-drain-status=''>
      {list.map((d) => <DrainNotice key={d.receiver} d={d} />)}
    </div>
  );
}

/** One drain's state in words (exported for a drawn check of each state). */
export function DrainNotice({ d }: { d: Drain }) {
  if (d.state === 'receiving')
    return <p className='text-muted-foreground text-xs' data-drain-state='receiving'>Request logs last arrived {ago(d.hours_since, d.last_received_at)}. The numbers below fill in as they come.</p>;
  if (d.state === 'silent')
    return (
      <Alert variant='destructive' data-drain-state='silent'>
        <AlertTitle>No request logs for {d.hours_since ?? d.silent_hours} hours</AlertTitle>
        <AlertDescription>
          {d.last_received_at ? `The last ones arrived ${when(d.last_received_at)}, so the numbers below stop there. ` : 'None have arrived since the source was added. '}
          Open the hosting provider&apos;s log drain settings and check that the drain is not paused or failing, and that it still sends to this app&apos;s address.
          {' '}<Link className='underline underline-offset-4' href={INTEGRATIONS}>See the source</Link>
        </AlertDescription>
      </Alert>
    );
  if (d.state === 'waiting')
    return (
      <Alert data-drain-state='waiting'>
        <AlertTitle>Waiting for the first request logs</AlertTitle>
        <AlertDescription>
          The source is set up, but no request logs have arrived yet. Once the hosting provider&apos;s log drain sends to its address, the numbers below fill in within minutes.
          {' '}<Link className='underline underline-offset-4' href={INTEGRATIONS}>See the source</Link>
        </AlertDescription>
      </Alert>
    );
  return (
    <Alert data-drain-state='not_connected'>
      <AlertTitle>Request logs are not connected yet</AlertTitle>
      <AlertDescription>
        These numbers come from your hosting provider&apos;s request logs, counted per hour: never a log line, an address or a visitor.
        To start them, add a source on Settings, Connections, Inbound webhooks, then create a log drain at the hosting provider that sends to the source&apos;s address.
        {' '}<Link className='underline underline-offset-4' href={INTEGRATIONS}>Open Inbound webhooks</Link>
      </AlertDescription>
    </Alert>
  );
}
