'use client';
// A compose window docked bottom-right, Gmail-style (minimise, close), for forms that sit beside a page.
import { useEffect, useState } from 'react';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

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
