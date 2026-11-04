'use client';
// The full in-page card a Settings tab opens in its list's place (mold_v0-218): "Add mailbox" and "Set sender" on
// Settings › Email. The record details card's style (mold_v0-217): a way back to the list, the title and what it is for,
// then the form; Escape or Back returns to the list. (A row's own details open through RecordView's `detail`.)
import { useEffect, useRef, type ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Icons } from '@/components/icons';

export function SettingsCard({ title, description, onBack, children }: { title: string; description?: ReactNode; onBack: () => void; children: ReactNode }) {
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return (
    <Card className='w-full max-w-4xl gap-0 py-0' data-settings-card='' role='region' aria-label={title}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onBack(); } }}>
      <CardHeader className='border-b py-4 [.border-b]:pb-4'>
        <CardDescription>
          <button type='button' className='inline-flex items-center gap-1 underline-offset-4 hover:underline' onClick={onBack}>
            <Icons.chevronLeft className='size-3.5' />Back to the list
          </button>
        </CardDescription>
        <CardTitle ref={heading} tabIndex={-1} className='text-lg leading-snug break-words outline-none'>{title}</CardTitle>
        {description && <p className='text-muted-foreground text-sm'>{description}</p>}
      </CardHeader>
      <CardContent className='flex flex-col gap-4 py-4'>{children}</CardContent>
    </Card>
  );
}

/** Plain-text status words in a table cell or a card (mold_v0-217: cell badges are plain text). */
export const ago = (d: string | null | undefined, days: number) => !!d && Date.now() - new Date(d).getTime() < days * 86_400_000;
/** Who changed it, as the API names a person ("customer:<email>"): the person alone. */
export const who = (by: string | null | undefined) => (by ? by.replace(/^customer:/, '') : null);
