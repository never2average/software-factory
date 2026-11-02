'use client';
// A secret answered once (mold_v0-201): a new API key, a webhook endpoint's signing secret (made, rotated or revealed), an
// inbound source's secret. Shown in a dialog with Copy until the person says they have it; never kept by the page after.
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CopyButton } from '@/features/portal/shared';

export interface Once { title: string; description: string; secret: string; label: string; extra?: { label: string; value: string }[] }

export function OnceDialog({ once, onClose }: { once: Once | null; onClose: () => void }) {
  if (!once) return null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-xl' data-once-secret=''>
        <DialogHeader>
          <DialogTitle>{once.title}</DialogTitle>
          <DialogDescription>{once.description}</DialogDescription>
        </DialogHeader>
        <div className='grid gap-3'>
          {(once.extra ?? []).map((x) => (
            <div key={x.label} className='grid gap-1'>
              <span className='text-muted-foreground text-xs font-medium'>{x.label}</span>
              <div className='flex items-start gap-2'>
                <code className='bg-muted min-w-0 flex-1 rounded px-2 py-1.5 font-mono text-xs break-all'>{x.value}</code>
                <CopyButton text={x.value} />
              </div>
            </div>
          ))}
          <div className='grid gap-1'>
            <span className='text-muted-foreground text-xs font-medium'>{once.label}</span>
            <div className='flex items-start gap-2'>
              <code className='bg-muted min-w-0 flex-1 rounded px-2 py-1.5 font-mono text-xs break-all' data-secret-value=''>{once.secret}</code>
              <CopyButton text={once.secret} label='Copy' variant='default' />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>I have copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
