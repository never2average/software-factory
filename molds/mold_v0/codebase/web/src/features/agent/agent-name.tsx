'use client';
// An agent's name with its purpose's icon (mold_v0-295; src/agent-purpose.ts): wherever a message, a step or a child run comes
// from an agent (the trace, the run tree, Active runs, the dock's panels). The purpose is said to a screen reader and on hover.
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { isPurpose, PURPOSE_ICON, PURPOSE_WORDS, type AgentPurpose } from '@/lib/agent-purpose';

export function PurposeIcon({ purpose, className }: { purpose: AgentPurpose | string | null | undefined; className?: string }) {
  const p: AgentPurpose = isPurpose(purpose) ? purpose : 'general';
  const I = (Icons as unknown as Record<string, typeof Icons.agent>)[PURPOSE_ICON[p]] ?? Icons.agent;
  return <I className={cn('size-3.5 shrink-0', className)} aria-hidden data-purpose-icon={p} />;
}

/** The agent's name, its purpose's icon before it, centred on one line. */
export function AgentName({ name, purpose, className, muted = true }: { name: string; purpose: AgentPurpose | string | null | undefined; className?: string; muted?: boolean }) {
  const p: AgentPurpose = isPurpose(purpose) ? purpose : 'general';
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1 text-xs leading-none', muted && 'text-muted-foreground', className)} title={`${name} (${PURPOSE_WORDS[p]})`} data-agent-name={p}>
      <PurposeIcon purpose={p} />
      <span className='min-w-0 truncate'>{name}</span>
      <span className='sr-only'>, {PURPOSE_WORDS[p].toLowerCase()}</span>
    </span>
  );
}
