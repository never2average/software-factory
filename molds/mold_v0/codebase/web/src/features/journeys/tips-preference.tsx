'use client';
// The person's in-chat tips switch (mold_v0-277: moved here from the Overview, whose tips block is gone): a row of the
// profile page's list, only when the build turns tips on (pack.json tips). The in-chat tip's last line points here.
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { appApi } from '@/lib/api-client';
import { tipsOn } from './config';

export function TipsPreference() {
  const on = tipsOn();
  const [muted, setMuted] = useState<boolean | null>(null);
  useEffect(() => { if (on) appApi<{ muted: boolean }>('GET', '/nudges/preference').then((r) => setMuted(r.muted), () => setMuted(null)); }, [on]);
  if (!on || muted === null) return null;
  const set = (show: boolean) => appApi('POST', '/nudges/preference', { muted: !show })
    .then(() => { setMuted(!show); toast.success(show ? 'Tips on in your AI client' : 'Tips off in your AI client'); }, (e: Error) => toast.error(e.message));
  return (
    <div className='flex items-center justify-between gap-4 py-3 leading-none'>
      <dt className='text-muted-foreground'><label htmlFor='tips-in-client'>Tips in my AI client</label></dt>
      <dd><Switch id='tips-in-client' checked={!muted} onCheckedChange={(v) => void set(Boolean(v))} /></dd>
    </div>
  );
}
