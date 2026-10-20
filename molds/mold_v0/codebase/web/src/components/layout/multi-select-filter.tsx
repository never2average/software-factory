'use client';
// A dropdown that picks any number of options (people, accounts, …): search, select all / clear, checkboxes. The
// trigger reads "All <noun>", the one picked, or "N <noun>". Empty selection means no filter. An option's `count` (the
// records it matches) shows right-aligned after its hint.
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface FilterOption { value: string; label: string; hint?: string; count?: number }

export function MultiSelectFilter({ options, value, onChange, noun, icon, className }: {
  options: FilterOption[]; value: string[]; onChange: (v: string[]) => void; noun: string; icon?: ReactNode; className?: string;
}) {
  const [q, setQ] = useState('');
  const shown = options.filter((o) => !q || `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const label = !value.length ? `All ${noun}` : value.length === 1 ? (options.find((o) => o.value === value[0])?.label ?? `1 ${noun}`) : `${value.length} ${noun}`;
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='outline' className={cn('max-w-56 justify-start', value.length > 0 && 'text-primary', className)} />}>
        {icon}<span className='truncate'>{label}</span>
      </PopoverTrigger>
      <PopoverContent align='end' className='flex w-80 flex-col gap-2'>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${options.length} ${noun}`} aria-label={`Search ${noun}`} className='h-8 text-sm' />
        <div className='flex items-center gap-3 text-xs leading-none'>
          <button type='button' className='text-primary hover:underline' onClick={() => onChange([...new Set([...value, ...shown.map((o) => o.value)])])}>Select {q ? 'matches' : 'all'}</button>
          {value.length > 0 && <button type='button' className='text-muted-foreground hover:text-foreground' onClick={() => onChange([])}>Clear</button>}
        </div>
        <ul className='flex max-h-72 flex-col gap-0.5 overflow-y-auto'>
          {!shown.length && <li className='text-muted-foreground py-2 text-xs leading-none'>{options.length ? 'No match.' : `No ${noun} yet.`}</li>}
          {shown.map((o) => (
            <li key={o.value}>
              <label className='hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-1.5 py-1.5 text-sm leading-none'>
                <Checkbox checked={value.includes(o.value)} onCheckedChange={(c) => onChange(c ? [...value, o.value] : value.filter((v) => v !== o.value))} />
                <span className='min-w-0 flex-1 truncate'>{o.label}</span>
                {o.hint && <span className='text-muted-foreground shrink-0 text-xs'>{o.hint}</span>}
              </label>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
