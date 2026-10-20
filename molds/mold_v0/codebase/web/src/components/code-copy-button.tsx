'use client';
import { useRef, useState } from 'react';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { cn } from '@/lib/utils';

/**
 * Copies the code block it sits in. It reads the text from the page (the `pre` next to it) rather than taking it as a
 * prop, so a server-rendered block's text is not sent to the browser a second time.
 */
export function CodeCopyButton({ className }: { className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = ref.current?.closest('[data-code-block]')?.querySelector('pre')?.innerText ?? '';
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };
  return (
    <button ref={ref} type='button' onClick={copy} aria-label={copied ? 'Copied' : 'Copy code'}
      className={cn('text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring inline-flex size-7 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none', className)}>
      {copied ? <IconCheck className='size-3.5' /> : <IconCopy className='size-3.5' />}
    </button>
  );
}
