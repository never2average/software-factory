'use client';
// Publish to Octillion's library (src/contributions.ts), shared by /app/personas and /app/tasks: the Published column's
// value, the confirm dialog in plain words, and Withdraw. Only the account's own personas and tasks can be published;
// Octillion reviews each, and an accepted one earns a credit on the next invoice.
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { appApi } from '@/lib/api-client';
import { usd } from '@/lib/octillion-format';
import { StatusBadge } from '@/features/admin/ui';
import { Allowed } from './role';
import { fail } from './shared';

export interface Publication { id: string; status: 'submitted' | 'accepted' | 'declined'; reason: string | null; submitted_at: string; decided_at: string | null; credit_usd: number | null }
export type PublishedLabel = 'Published' | 'Submitted' | 'Declined' | '—';
export const PUBLISHED_OPTIONS: { value: PublishedLabel }[] = [{ value: 'Published' }, { value: 'Submitted' }, { value: 'Declined' }, { value: '—' }];

/** The Published column's value: accepted into the library, waiting for review, declined, or never published (—). */
export const publishedLabel = (p: Publication | null | undefined): PublishedLabel =>
  !p ? '—' : p.status === 'accepted' ? 'Published' : p.status === 'declined' ? 'Declined' : 'Submitted';

export function PublishedBadge({ p }: { p: Publication | null | undefined }) {
  const label = publishedLabel(p);
  if (label === '—') return <span className='text-muted-foreground'>—</span>;
  return <StatusBadge tone={label === 'Published' ? 'ok' : label === 'Declined' ? 'bad' : 'info'} title={p?.status === 'declined' && p.reason ? p.reason : undefined}>{label}</StatusBadge>;
}

/** The peek's line: the same value, with the decline reason or the credit. */
export function PublishedLine({ p }: { p: Publication | null | undefined }) {
  if (!p) return <span className='text-muted-foreground'>Not published</span>;
  return (
    <span className='flex flex-col gap-1.5'>
      <span><PublishedBadge p={p} /></span>
      {p.status === 'submitted' && <span className='text-muted-foreground text-xs'>Waiting for Octillion&apos;s review. You can withdraw it until then.</span>}
      {p.status === 'accepted' && <span className='text-muted-foreground text-xs'>In Octillion&apos;s library{p.credit_usd ? `; ${usd(p.credit_usd)} credit on your next invoice` : ''}. Your copy stays yours.</span>}
      {p.status === 'declined' && <span className='text-xs'>Reason: {p.reason}</span>}
    </span>
  );
}

export const withdrawPublication = (p: Publication, reload: () => unknown) =>
  appApi('POST', `/submissions/${encodeURIComponent(p.id)}/withdraw`).then(() => { toast.success('Submission withdrawn'); return reload(); }).catch(fail);

/** The confirm dialog: what gets shared, the review, what acceptance means, and the credit. */
export function PublishDialog({ kind, title, path, creditUsd, onClose, onDone }: {
  kind: 'persona' | 'task'; title: string; path: string; creditUsd: number | null | undefined; onClose: () => void; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const noun = kind === 'persona' ? 'persona' : 'task';
  const go = () => {
    setErr(''); setBusy(true);
    appApi('POST', path).then(() => { toast.success('Submitted to Octillion’s library'); onDone(); })
      .catch((x: Error) => setErr(x.message)).finally(() => setBusy(false));
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>Publish “{title}” to Octillion&apos;s library?</DialogTitle>
          <DialogDescription>Octillion keeps a shared library of {noun}s it uses to test coding agents for all its customers.</DialogDescription>
        </DialogHeader>
        <ul className='list-disc space-y-2 pl-5 text-sm leading-relaxed'>
          <li><span className='font-medium'>What is shared:</span> this {noun}&apos;s content as it is now ({kind === 'persona' ? 'its name, summary, attributes and instructions' : 'its title, prompt, language, tags and repository'}). Never your account&apos;s name.</li>
          <li><span className='font-medium'>Octillion reviews it</span> before anything is shared. You can withdraw it until then.</li>
          <li><span className='font-medium'>If it is accepted,</span> Octillion may use it in runs for every customer. Your own copy stays yours, unchanged.</li>
          <li><span className='font-medium'>You earn {creditUsd != null ? usd(creditUsd) : 'a credit'}</span> off your next invoice for each accepted {noun}.</li>
        </ul>
        {err && <p className='text-destructive text-sm'>{err}</p>}
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>Cancel</Button>
          <Allowed need='edit'><Button disabled={busy} onClick={go}>Publish</Button></Allowed>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
