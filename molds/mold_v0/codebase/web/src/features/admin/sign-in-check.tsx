'use client';
// Health › Sign-in (mold_v0-270; GET /api/admin/onboarding/health/sign-in, src/sign-in-check.ts): every sign-in and
// connection the app sends people through, its exact return address against the app's front door, pass / fail /
// unknown, and where to click to fix it. At most an hour old; "Check again" asks now (at most once a minute).
// Staff only, read only; no secret and no client id (a fingerprint) is ever on the page.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Box } from '@/components/layout/chart-grid';
import { StatStrip } from '@/components/layout/section';
import { adminApi } from '@/lib/api-client';
import { useAdmin } from './lib';
import { CopyField, ErrorBox, Mono, StatusBadge, When, type Tone } from './ui';

export type SignInResult = 'pass' | 'fail' | 'unknown';
export interface SignInFlow { id: string; label: string; provider: string; redirect_uri: string | null; result: SignInResult; detail: string; where: string; steps: string[]; client: string | null }
export interface SignInReport { checked_at: string; front_door: string; front_door_since: string; flows: SignInFlow[]; totals: Record<SignInResult, number>; next_check_at: string; throttled?: boolean }

const TONE: Record<SignInResult, Tone> = { pass: 'ok', fail: 'bad', unknown: 'warn' };
const WORD: Record<SignInResult, string> = { pass: 'Pass', fail: 'Fail', unknown: 'Unknown' };
const ORDER: Record<SignInResult, number> = { fail: 0, unknown: 1, pass: 2 };

/** The tab: the report, and "Check again". */
export function SignInTab() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useAdmin<SignInReport>('/health/sign-in');
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { qc.setQueryData(['admin', '/health/sign-in'], await adminApi<SignInReport>('GET', '/health/sign-in?refresh=1')); }
    finally { setBusy(false); }
  };
  return (
    <>
      <ErrorBox error={error} />
      {isLoading || !data ? <Skeleton className='h-64 rounded-lg' /> : <SignInView data={data} onRefresh={refresh} refreshing={busy} />}
    </>
  );
}

/** The report as cards: failures first, then the ones that could not be told, then the ones that work. */
export function SignInView({ data, onRefresh, refreshing }: { data: SignInReport; onRefresh?: () => void; refreshing?: boolean }) {
  const flows = [...data.flows].sort((a, b) => ORDER[a.result] - ORDER[b.result]);
  return (
    <div className='flex min-w-0 flex-col gap-3' data-sign-in>
      <StatStrip quad items={[
        { label: 'Front door', value: <span className='font-mono text-sm break-all'>{data.front_door.replace(/^https?:\/\//, '')}</span>, hint: 'Every return address below is made from it.' },
        { label: 'Pass', value: String(data.totals.pass) },
        { label: 'Fail', value: String(data.totals.fail), hint: data.totals.fail ? 'Sign-in or connecting breaks there.' : undefined },
        { label: 'Unknown', value: String(data.totals.unknown), hint: data.totals.unknown ? 'The provider checks only after someone signs in.' : undefined }
      ]} />
      <div className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs'>
        <span>Checked <When d={data.checked_at} className='inline' />; checked again at most hourly{data.throttled ? ' (just checked: asked again within a minute, so this is the last check)' : ''}.</span>
        {onRefresh && <Button size='sm' variant='outline' onClick={onRefresh} disabled={refreshing} className='ml-auto'>{refreshing ? 'Checking…' : 'Check again'}</Button>}
      </div>
      <div className='grid border-t border-l md:grid-cols-2'>
        {flows.map((f) => <FlowCard key={f.id} f={f} />)}
      </div>
      {!flows.length && <p className='text-muted-foreground text-sm'>This app sends nobody through another sign-in.</p>}
    </div>
  );
}

function FlowCard({ f }: { f: SignInFlow }) {
  return (
    <Box title={f.label} action={<StatusBadge tone={TONE[f.result]}>{WORD[f.result]}</StatusBadge>} className='gap-2'>
      <div className='flex flex-col gap-2 text-sm' data-flow={f.id} data-result={f.result}>
        <p>{f.detail}</p>
        {f.redirect_uri && (
          <div className='flex flex-col gap-1'>
            <span className='text-muted-foreground text-xs'>{f.result === 'pass' ? 'Return address' : 'Address to register, exactly'}</span>
            <CopyField value={f.redirect_uri} />
          </div>
        )}
        <p className='text-muted-foreground text-xs'>Where: {f.where}{f.client ? <> · client <Mono>{f.client}</Mono></> : null}</p>
        {f.result !== 'pass' && f.steps.length > 0 && (
          <ol className='text-muted-foreground list-decimal space-y-0.5 pl-5 text-xs'>
            {stepsOf(f.steps).map((s, i) => <li key={i}>{s.text}{s.paste && <div className='text-foreground mt-0.5 font-mono break-all'>{s.paste}</div>}</li>)}
          </ol>
        )}
      </div>
    </Box>
  );
}

/** The server's steps: an indented line is what to paste, shown under the step before it. */
function stepsOf(steps: string[]) {
  const out: { text: string; paste?: string }[] = [];
  for (const s of steps) {
    if (/^\s{2,}/.test(s) && out.length) out[out.length - 1]!.paste = s.trim();
    else out.push({ text: s });
  }
  return out;
}
