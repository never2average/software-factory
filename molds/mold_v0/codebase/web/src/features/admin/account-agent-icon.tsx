'use client';
// An account's agent icon (mold_v0-262, flag agent_harness; src/agent-icon.ts, src/agent-routes.ts agentAdminRoutes):
// set by platform staff on the account's page (Admin › Accounts › <account>), never by the workspace. The icon in use
// (the account's own, else the app's from its brand, else the console's default) on a light and a dark surface; Upload,
// Replace and Reset (back to the app's), for the staff roles that manage accounts; each change in the staff log. A
// picture is resized here to a 64 px PNG before it is sent; an SVG is sent as it is and cleaned by the server; at most
// 256 KB.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { AgentIcon, appAgentIcon, type WorkspaceAgentIcon } from '@/components/layout/agent-icon';
import { ADMIN_HEADERS } from '@/lib/env-names';
import { httpError } from '@/features/status/from-error';
import { Gate } from './role';
import { Section, When } from './ui';

const MAX_BYTES = 256 * 1024;
const PX = 64;
const ACCEPT = '.svg,.png,.jpg,.jpeg,.webp,image/svg+xml,image/png,image/jpeg,image/webp';

/** A picture -> a PNG fitted inside 64 px (the browser decodes the JPG or WebP); an SVG as it is. */
async function prepare(file: File): Promise<{ body: Blob; type: string }> {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return { body: file, type: 'image/svg+xml' };
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error('That picture could not be read: choose an SVG, PNG, JPG or WebP.'); });
  const k = Math.min(1, PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * k)); canvas.height = Math.max(1, Math.round(bitmap.height * k));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize the picture.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const body = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!body) throw new Error('The picture could not be resized.');
  return { body, type: 'image/png' };
}

const formatOf = (i: WorkspaceAgentIcon) => i.content_type === 'image/svg+xml' ? (i.follows_color ? 'SVG, in the text colour' : 'SVG, in its own colours') : `${i.content_type === 'image/png' ? 'PNG' : i.content_type === 'image/jpeg' ? 'JPG' : 'WebP'}, ${i.width}×${i.height} px`;

export function AccountAgentIcon({ slug }: { slug: string }) {
  const url = `/api/admin/onboarding/agent-icon/${encodeURIComponent(slug)}`;
  const [icon, setIcon] = useState<WorkspaceAgentIcon | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    const body = (await res.json().catch(() => ({}))) as { icon?: WorkspaceAgentIcon | null; error?: string };
    if (!res.ok) throw httpError(res.status, body);
    setIcon(body.icon ?? null);
  }, [url]);
  useEffect(() => { load().catch(() => setIcon(null)); }, [load]);
  const send = async (method: 'PUT' | 'DELETE', body?: Blob, type?: string) => {
    const res = await fetch(url, { method, credentials: 'same-origin', body,
      headers: { accept: 'application/json', ...ADMIN_HEADERS, ...(body ? { 'content-type': 'application/octet-stream', 'x-file-type': type ?? '' } : {}) } });
    const got = (await res.json().catch(() => ({}))) as { icon?: WorkspaceAgentIcon | null; error?: string };
    if (!res.ok) throw new Error(got.error ?? `The icon could not be saved (${res.status}).`);
    setIcon(got.icon ?? null);
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) { toast.error(`That file is ${Math.ceil(file.size / 1024)} KB: an icon is at most ${MAX_BYTES / 1024} KB.`); return; }
    setBusy(true);
    try { const { body, type } = await prepare(file); await send('PUT', body, type); toast.success("This account's agent icon is changed."); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const reset = async () => {
    setBusy(true);
    try { await send('DELETE'); toast.success("This account shows the app's agent icon again."); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  const brand = appAgentIcon();
  const own = icon ?? null;
  return (
    <Section title='Agent icon' description={own ? "This account's own icon, over the app's." : brand ? "The app's icon, from its brand: this account has none of its own." : "The console's default icon: this account has none of its own."}
      action={
        <div className='flex flex-wrap gap-2' data-account-agent-icon-actions=''>
          <input ref={input} type='file' accept={ACCEPT} className='sr-only' tabIndex={-1} aria-label='Choose an agent icon' data-account-agent-icon-input='' onChange={(e) => void upload(e.target.files?.[0])} />
          <Gate need='accounts'>
            <Button type='button' variant='outline' size='sm' disabled={busy || icon === undefined} onClick={() => input.current?.click()} data-account-agent-icon='upload'>
              <Icons.upload aria-hidden />{busy ? 'Saving…' : own ? 'Replace' : 'Upload'}
            </Button>
          </Gate>
          {own && <Gate need='accounts'>
            <Button type='button' variant='outline' size='sm' disabled={busy} onClick={() => void reset()} data-account-agent-icon='reset'>Reset to the app&apos;s icon</Button>
          </Gate>}
        </div>
      }>
      <div className='flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-8' data-account-agent-icon={own ? 'own' : 'app'}>
        <div className='flex gap-3'>
          {(['light', 'dark'] as const).map((t) => (
            <div key={t} className={`flex size-20 flex-col items-center justify-center gap-2 rounded-lg border ${t === 'light' ? 'border-neutral-200 bg-white text-neutral-900' : 'border-neutral-700 bg-neutral-900 text-neutral-50'}`} data-account-agent-icon-preview={t}>
              <AgentIcon override={own ?? 'app'} theme={t} className='size-6' />
              <span className='text-xs opacity-75'>{t === 'light' ? 'Light' : 'Dark'}</span>
            </div>
          ))}
        </div>
        <dl className='grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm'>
          <dt className='text-muted-foreground'>From</dt><dd>{own ? 'This account' : brand ? "The app's brand" : 'The console default'}</dd>
          <dt className='text-muted-foreground'>Format</dt><dd>{own ? formatOf(own) : brand ? (brand.light.includes('.png') ? 'PNG' : 'SVG') : 'SVG'}</dd>
          <dt className='text-muted-foreground'>Changed</dt><dd>{own ? <><When d={own.updated_at} />{own.updated_by ? ` by ${own.updated_by.replace(/^staff:/, '')}` : ''}</> : 'Never'}</dd>
          <dt className='text-muted-foreground'>Rules</dt><dd className='text-muted-foreground max-w-prose'>An SVG, PNG, JPG or WebP of at most {MAX_BYTES / 1024} KB: a picture is resized to {PX} px, an SVG is cleaned of anything but its drawing and, in one colour, follows the theme. Only platform staff change it; every change is in the staff log.</dd>
        </dl>
      </div>
    </Section>
  );
}
