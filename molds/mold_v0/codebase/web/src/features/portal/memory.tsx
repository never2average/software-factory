'use client';
// Institutional memory on /app/context: the pieces the context table uses: item kinds and a Gmail-style
// compose window docked bottom-right (minimise, close) where memory items are saved and changed.
import { useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

export type MemoryScope = 'company' | 'user' | 'product';
export type Kind = 'fact' | 'decision' | 'preference' | 'note';
export interface MemoryItem { id: number; kind: Kind; body: string; created_by: string | null; created_at: string; can_delete: boolean; subject?: string; subject_name?: string }

export const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'fact', label: 'Fact', hint: 'e.g. Our Python SDK is in beta; the Node SDK is GA.' },
  { id: 'decision', label: 'Decision', hint: 'e.g. We stopped competing on price with Postmark in 2026.' },
  { id: 'preference', label: 'Preference', hint: 'e.g. Always compare against Resend first.' },
  { id: 'note', label: 'Note', hint: 'Anything the team should not have to explain twice.' }
];
export const TYPE_STYLE: Record<string, string> = {
  fact: 'bg-primary/10 text-primary ring-primary/25',
  decision: 'bg-amber-500/10 text-amber-800 ring-amber-600/25 dark:text-amber-300 dark:ring-amber-400/25',
  preference: 'bg-sky-500/10 text-sky-700 ring-sky-600/25 dark:text-sky-300 dark:ring-sky-400/25',
  note: 'bg-muted/60 text-muted-foreground ring-border'
};

/** A compose window docked bottom-right, Gmail-style: title bar that minimises, close, and the form inside. */
export function Dock({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const [min, setMin] = useState(false);
  useEffect(() => setMin(false), [title]);
  return (
    <div role='dialog' aria-label={title}
      className='bg-card fixed right-4 bottom-0 z-50 flex w-[min(460px,calc(100vw-2rem))] flex-col overflow-hidden rounded-t-xl border border-b-0 shadow-2xl shadow-black/50 sm:right-6'>
      <div className='bg-muted/60 flex items-center gap-2 px-4 py-2.5'>
        <button type='button' onClick={() => setMin((v) => !v)} className='min-w-0 flex-1 truncate text-left text-sm font-medium'>{title}</button>
        <button type='button' aria-label={min ? 'Expand' : 'Minimise'} onClick={() => setMin((v) => !v)} className='text-muted-foreground hover:text-foreground rounded p-1'>
          <Icons.minus className='size-4' />
        </button>
        <button type='button' aria-label='Close' onClick={onClose} className='text-muted-foreground hover:text-foreground rounded p-1'>
          <Icons.close className='size-4' />
        </button>
      </div>
      <div className={cn(min && 'hidden')}>{children}</div>
    </div>
  );
}
