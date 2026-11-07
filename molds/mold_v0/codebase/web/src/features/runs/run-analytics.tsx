'use client';
// Run analytics (mold_v0-260, flag run_analytics; src/run-analytics.ts): a period's runs broken down by record, person,
// model, tool and failure reason, with tokens by model. A workspace's own at /app/run-analytics (GET
// /api/analytics/runs, its billing managers and owners) and staff's across the workspaces at /admin/run-analytics (GET
// /api/admin/onboarding/run-analytics, with a workspace filter and a breakdown by workspace). Its filters (period, kind,
// status, workspace) are kept in the address while the flag filters_in_address is on (src/hooks/use-dashboard-filter.ts).
import { useEffect, useState, type ReactNode } from 'react';
import PageContainer from '@/components/layout/page-container';
import { Box, RankBars } from '@/components/layout/chart-grid';
import { DateRangePicker, rangeQuery } from '@/components/layout/date-range-picker';
import { StatStrip } from '@/components/layout/section';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDashboardRange, useDashboardText } from '@/hooks/use-dashboard-filter';
import { adminApi } from '@/lib/api-client';
import { num, usd } from '@/lib/display-format';

interface Breakdown { runs: number; cost_usd: number; failed: number }
export interface RunAnalytics {
  range: { from: string; to: string }; more: boolean;
  totals: { runs: number; queued: number; running: number; succeeded: number; failed: number; cancelled: number; cost_usd: number; input_tokens: number; output_tokens: number };
  daily: { day: string; runs: number; failed: number; cost_usd: number }[];
  kinds: (Breakdown & { kind: string; label: string })[];
  by_record: (Breakdown & { area: string; key: string | null; label: string })[];
  by_person: (Breakdown & { person: string })[];
  by_model: { model: string | null; provider: string | null; requests: number; input_tokens: number; output_tokens: number; cost_usd: number; runs: number }[];
  by_tool: { tool: string; calls: number; errors: number; runs: number }[];
  by_failure: (Breakdown & { reason: string })[];
  by_workspace?: (Breakdown & { workspace: string; slug: string | null })[];
}

async function customerLoad(q: string): Promise<RunAnalytics> {
  const res = await fetch(`/api/analytics/runs?${q}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Run analytics could not be read (${res.status})`);
  return body as RunAnalytics;
}

const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const STATUSES = ['succeeded', 'failed', 'running', 'queued', 'cancelled'];

/** A small table of a breakdown: its label, runs, failed and spend. */
function Breakdown<T extends Breakdown>({ rows, label, name, empty }: { rows: T[]; label: string; name: (r: T) => ReactNode; empty: string }) {
  if (!rows.length) return <p className='text-muted-foreground py-6 text-center text-sm'>{empty}</p>;
  return (
    <Table label={label}>
      <TableHeader><TableRow><TableHead>{label}</TableHead><TableHead className='text-right'>Runs</TableHead><TableHead className='text-right'>Failed</TableHead><TableHead className='text-right'>Spend</TableHead></TableRow></TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell className='max-w-64 truncate'>{name(r)}</TableCell>
            <TableCell className='text-right tabular-nums'>{num(r.runs)}</TableCell>
            <TableCell className='text-right tabular-nums'>{r.failed ? num(r.failed) : '—'}</TableCell>
            <TableCell className='text-right tabular-nums'>{usd(r.cost_usd)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function RunAnalyticsView({ staff = false }: { staff?: boolean }) {
  const [range, setRange] = useDashboardRange();
  const [kind, setKind] = useDashboardText('kind');
  const [status, setStatus] = useDashboardText('status');
  const [workspace, setWorkspace] = useDashboardText('workspace');
  const [typed, setTyped] = useState(workspace);
  useEffect(() => setTyped(workspace), [workspace]);
  const q = `${rangeQuery(range)}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}${staff && workspace ? `&workspace=${encodeURIComponent(workspace)}` : ''}`;
  const [state, setState] = useState<{ q?: string; data?: RunAnalytics; error?: Error }>({});
  useEffect(() => {
    let live = true;
    (staff ? adminApi<RunAnalytics>('GET', `/run-analytics?${q}`) : customerLoad(q))
      .then((data) => { if (live) setState({ q, data }); }).catch((error: Error) => { if (live) setState({ q, error }); });
    return () => { live = false; };
  }, [q, staff]);
  const d = state.q === q ? state.data : undefined;
  const kinds = d?.kinds ?? [];
  const filters = (
    <div className='flex flex-wrap items-center justify-end gap-2' data-run-filters=''>
      {staff && (
        <form onSubmit={(e) => { e.preventDefault(); setWorkspace(typed.trim()); }}>
          <Input aria-label='Workspace (its address name)' placeholder='All workspaces' value={typed} onChange={(e) => setTyped(e.target.value)} onBlur={() => setWorkspace(typed.trim())} className='h-8 w-40' />
        </form>
      )}
      <NativeSelect aria-label='Kind' value={kind} onChange={(e) => setKind(e.target.value)} className='h-8'>
        <NativeSelectOption value=''>Every kind</NativeSelectOption>
        {[...new Map([...kinds.map((k) => [k.kind, k.label] as const), ...(kind && !kinds.some((k) => k.kind === kind) ? [[kind, kind.split('/').pop()!] as const] : [])]).entries()].map(([k, l]) => <NativeSelectOption key={k} value={k}>{l}</NativeSelectOption>)}
      </NativeSelect>
      <NativeSelect aria-label='Status' value={status} onChange={(e) => setStatus(e.target.value)} className='h-8'>
        <NativeSelectOption value=''>Every status</NativeSelectOption>
        {STATUSES.map((s) => <NativeSelectOption key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</NativeSelectOption>)}
      </NativeSelect>
      <DateRangePicker value={range} onChange={setRange} />
    </div>
  );
  return (
    <PageContainer pageTitle='Run analytics' pageHeaderAction={filters}
      pageDescription={staff ? 'Runs across every workspace: by workspace, record, person, model, tool and failure reason, with tokens by model.' : 'Your runs by record, person, model, tool and failure reason, with tokens by model.'}>
      {state.error && state.q === q ? <p className='text-destructive text-sm'>{state.error.message}</p> : !d ? <p className='text-muted-foreground text-sm' aria-busy='true'>Loading…</p> : (
        <div className='flex flex-col gap-6' data-run-analytics=''>
          <StatStrip quad items={[
            { label: 'Runs', value: num(d.totals.runs), hint: `${num(d.totals.succeeded)} succeeded, ${num(d.totals.failed)} failed` },
            { label: 'Spend', value: usd(d.totals.cost_usd) },
            { label: 'Tokens in', value: tokens(d.totals.input_tokens) },
            { label: 'Tokens out', value: tokens(d.totals.output_tokens) },
          ]} />
          {d.more && <p className='text-muted-foreground text-xs'>The latest 5,000 runs of the period are counted: narrow the period or the kind for the rest.</p>}
          <div className='grid gap-4 lg:grid-cols-2'>
            <Box title='Tokens by model' description='Each run’s own report, else the gateway’s meter by provider.'>
              {d.by_model.length ? (
                <Table label='Tokens by model'>
                  <TableHeader><TableRow><TableHead>Model</TableHead><TableHead className='text-right'>Runs</TableHead><TableHead className='text-right'>In</TableHead><TableHead className='text-right'>Out</TableHead><TableHead className='text-right'>Spend</TableHead></TableRow></TableHeader>
                  <TableBody>{d.by_model.map((m) => (
                    <TableRow key={m.model ?? m.provider ?? '?'}><TableCell className='max-w-56 truncate font-mono text-xs'>{m.model}</TableCell><TableCell className='text-right tabular-nums'>{num(m.runs)}</TableCell>
                      <TableCell className='text-right tabular-nums'>{tokens(m.input_tokens)}</TableCell><TableCell className='text-right tabular-nums'>{tokens(m.output_tokens)}</TableCell><TableCell className='text-right tabular-nums'>{usd(m.cost_usd)}</TableCell></TableRow>
                  ))}</TableBody>
                </Table>
              ) : <p className='text-muted-foreground py-6 text-center text-sm'>No model use in this period.</p>}
            </Box>
            <Box title='Failure reasons' description='Failed runs, by what went wrong.'>
              <Breakdown rows={d.by_failure} label='Reason' name={(r) => r.reason} empty='No run failed in this period.' />
            </Box>
            <Box title='By record' description='The record each run ran on, or the asset it targeted.'>
              <Breakdown rows={d.by_record} label='Record' name={(r) => r.label} empty='No run ran on a record in this period.' />
            </Box>
            <Box title='By person' description='Who started each run.'>
              <Breakdown rows={d.by_person} label='Person' name={(r) => r.person} empty='No runs in this period.' />
            </Box>
            <Box title='Tools' description='Tool calls the runs made, and how many failed.'>
              <RankBars data={d.by_tool.map((t) => ({ name: t.tool, value: t.calls }))} label='Calls' color='var(--chart-2)' format={num} mono empty='No tool calls in this period.' />
            </Box>
            {staff && d.by_workspace ? (
              <Box title='By workspace' description='Each workspace’s runs and spend.'>
                <Breakdown rows={d.by_workspace} label='Workspace' name={(r) => r.workspace} empty='No runs in this period.' />
              </Box>
            ) : (
              <Box title='By kind' description='Each kind of run.'>
                <Breakdown rows={d.kinds} label='Kind' name={(r) => r.label} empty='No runs in this period.' />
              </Box>
            )}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
