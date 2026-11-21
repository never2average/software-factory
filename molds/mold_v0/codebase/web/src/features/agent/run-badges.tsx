'use client';
// The badges of the one run vocabulary (mold_v0-334; web/src/lib/run-status.ts): a run's status (saying whose decision it
// waits for), the outcome of what it made, and its attention mark (a failure escalated to a person).
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { OUTCOME_TONE, OUTCOME_WORDS, STATUS_TONE, statusWords, type RunNeeds, type RunOutcomeBadge, type RunStatus } from '@/lib/run-status';

export function RunStatusBadge({ status, needs, why, pulse }: { status: RunStatus; needs?: RunNeeds | null; why?: string | null; pulse?: boolean }) {
  return (
    <Badge variant='outline' className={cn('shrink-0 gap-1.5 font-normal', STATUS_TONE[status])} data-run-status={status} title={why ?? undefined}>
      {pulse && status === 'running' && <span className='size-1.5 motion-safe:animate-pulse rounded-full bg-current' aria-hidden />}
      {statusWords(status, needs)}{status === 'failed' && why ? <span className='sr-only'>: {why}</span> : null}
    </Badge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: RunOutcomeBadge }) {
  return <Badge variant='outline' className={cn('shrink-0 font-normal', OUTCOME_TONE[outcome])} data-run-outcome={outcome}>{OUTCOME_WORDS[outcome]}</Badge>;
}

/** A failure escalated to a person (a child's failure policy "escalate"): drawn wherever the run is listed. */
export function AttentionMark({ on }: { on: boolean }) {
  if (!on) return null;
  return <span className='text-amber-600 dark:text-amber-400 inline-flex items-center gap-1 text-xs' data-run-attention='' title='A step failed and needs someone to look at it'><Icons.warning className='size-3.5' aria-hidden />Needs attention</span>;
}
