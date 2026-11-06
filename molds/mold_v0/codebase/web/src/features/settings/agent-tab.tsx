'use client';
// Settings › Workspace agent (mold_v0-252; the agent_harness flag of the features registry, src/agent-icon.ts): the
// agent's icon in this workspace, as the standard full-area table: four cards (the icon shown, where it comes from, its
// format, when it changed), the search row with Upload icon (its primary action, an owner's), the table of the two icons
// in play (the workspace's own and the app's) and a row's full card with the icon in light and dark, Upload and Reset.
// The workspace's own overrides the app's for this workspace only; Reset goes back to the app's. Every picture is
// resized here to a 64 px PNG before it is sent (an SVG is sent as it is and cleaned by the server); at most 256 KB.
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { AgentIcon, appAgentIcon, reloadWorkspaceAgentIcon, useWorkspaceAgentIcon, type WorkspaceAgentIcon } from '@/components/layout/agent-icon';
import { LoadingCards, When, fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ToolbarAction } from '@/features/tabs/tab-action';

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

async function send(method: 'PUT' | 'DELETE', body?: Blob, type?: string): Promise<void> {
  const res = await fetch('/api/agent/icon', {
    method, credentials: 'same-origin', body,
    headers: { accept: 'application/json', 'x-pack-request': '1', ...(body ? { 'content-type': 'application/octet-stream', 'x-file-type': type ?? '' } : {}) }
  });
  if (!res.ok) throw httpError(res.status, (await res.json().catch(() => ({}))) as { error?: string });
}

interface Row { key: 'workspace' | 'app'; label: string; inUse: boolean; status: string; format: string; changed: string | null; by: string | null }

const formatOf = (i: WorkspaceAgentIcon) => i.content_type === 'image/svg+xml' ? (i.follows_color ? 'SVG, in the text colour' : 'SVG, in its own colours') : `${i.content_type === 'image/png' ? 'PNG' : i.content_type === 'image/jpeg' ? 'JPG' : 'WebP'}, ${i.width}×${i.height} px`;

/** The icon on a light and on a dark surface, as each theme shows it. */
function Swatches({ which, icon }: { which: Row['key']; icon: WorkspaceAgentIcon | null }) {
  const show = which === 'workspace' ? icon ?? null : 'app';
  if (which === 'workspace' && !icon) return <p className='text-muted-foreground text-sm'>Not set: this workspace shows the app's icon.</p>;
  return (
    <div className='flex flex-wrap gap-3' data-agent-icon-swatches=''>
      {(['light', 'dark'] as const).map((t) => (
        <div key={t} className={`flex size-20 flex-col items-center justify-center gap-2 rounded-lg border ${t === 'light' ? 'border-neutral-200 bg-white text-neutral-900' : 'border-neutral-700 bg-neutral-900 text-neutral-50'}`}>
          <AgentIcon override={show} theme={t} className='size-5' />
          <span className='text-xs opacity-75'>{t === 'light' ? 'Light' : 'Dark'}</span>
        </div>
      ))}
    </div>
  );
}

export function AgentTab() {
  const answer = useWorkspaceAgentIcon();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!answer) return <LoadingCards count={2} />;
  const own = answer.icon, brand = appAgentIcon(), can = answer.can_change;
  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) { toast.error(`That file is ${Math.ceil(file.size / 1024)} KB: an icon is at most ${MAX_BYTES / 1024} KB.`); return; }
    setBusy(true);
    try { const { body, type } = await prepare(file); await send('PUT', body, type); await reloadWorkspaceAgentIcon(); toast.success('The agent icon is changed for this workspace.'); }
    catch (e) { fail(e); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const reset = async () => {
    setBusy(true);
    try { await send('DELETE'); await reloadWorkspaceAgentIcon(); toast.success("This workspace shows the app's agent icon again."); }
    catch (e) { fail(e); }
    finally { setBusy(false); }
  };
  const pick = () => input.current?.click();
  const rows: Row[] = [
    { key: 'workspace', label: "This workspace's icon", inUse: !!own, status: own ? 'In use' : 'Not set', format: own ? formatOf(own) : '—', changed: own?.updated_at ?? null, by: own?.updated_by ?? null },
    { key: 'app', label: "The app's icon", inUse: !own, status: own ? 'Replaced here' : 'In use', format: brand ? (brand.mask ? 'SVG, in the text colour' : brand.light.includes('.png') ? 'PNG' : 'SVG, in its own colours') : 'The default icon', changed: null, by: null }
  ];
  const cols: RecordCol<Row>[] = [
    { key: 'icon', label: 'Icon', title: true, keep: true, type: 'text', value: (r) => r.label,
      render: (r) => <span className='flex items-center gap-2.5'>{r.key === 'workspace' && !own ? <span className='text-muted-foreground size-5 text-center'>—</span> : <AgentIcon override={r.key === 'workspace' ? own : 'app'} className='size-5' />}<span className='font-medium'>{r.label}</span></span> },
    { key: 'status', label: 'Status', type: 'text', keep: true, value: (r) => r.status, render: (r) => <span className={r.inUse ? '' : 'text-muted-foreground'}>{r.status}</span> },
    { key: 'format', label: 'Format', type: 'text', value: (r) => r.format, render: (r) => r.format },
    { key: 'changed', label: 'Changed', type: 'date', value: (r) => r.changed ?? '', render: (r) => (r.changed ? <When d={r.changed} /> : '—') },
    { key: 'by', label: 'By', type: 'text', value: (r) => r.by ?? '', render: (r) => <span className='break-all'>{r.by ?? '—'}</span> }
  ];
  return (
    <div className='flex flex-col gap-4'>
      <input ref={input} type='file' accept={ACCEPT} className='sr-only' tabIndex={-1} aria-label='Choose an agent icon' data-agent-icon-input='' onChange={(e) => void upload(e.target.files?.[0])} />
      <RecordView<Row>
        id='settings-agent' compact noun='icons' properties
        rows={rows} rowKey={(r) => r.key} cols={cols} openKey={open} onOpenChange={setOpen}
        summary={<StatStrip quad items={[
          { label: 'Shown', value: <span className='flex h-7 items-center'><AgentIcon className='size-5' /></span>, said: own ? "this workspace's own icon" : "the app's icon" },
          { label: 'From', value: own ? 'This workspace' : brand ? 'The app' : 'The default', said: own ? 'set in this workspace' : "the app's brand" },
          { label: 'Format', value: own ? formatOf(own).split(',')[0]! : brand ? (brand.light.includes('.png') ? 'PNG' : 'SVG') : 'SVG', said: 'its format' },
          { label: 'Changed', value: own ? <When d={own.updated_at} /> : 'Never', said: own ? `changed by ${own.updated_by ?? 'an owner'}` : 'never changed here' }
        ]} />}
        searchText={(r) => `${r.label} ${r.status} ${r.format} ${r.by ?? ''}`}
        searchPlaceholder='Search icons'
        toolbarAction={can ? <div className='ml-auto flex shrink-0'><ToolbarAction label={busy ? 'Uploading…' : 'Upload icon'} icon={<Icons.upload />} onClick={pick} /></div> : undefined}
        empty={<p className='text-muted-foreground text-sm'>No icon.</p>}
        detailTitle={(r) => r.label}
        detailActions={(r) => r.key === 'workspace' && can ? (
          <div className='flex flex-wrap gap-2'>
            <Button variant='outline' size='sm' disabled={busy} onClick={pick}><Icons.upload />{own ? 'Replace' : 'Upload icon'}</Button>
            {own && <Button variant='outline' size='sm' disabled={busy} onClick={() => void reset()}>Reset to the app's icon</Button>}
          </div>
        ) : null}
        detail={(r) => (
          <div className='grid gap-4 text-sm'>
            <Swatches which={r.key} icon={own} />
            <p className='text-muted-foreground'>
              {r.key === 'workspace'
                ? `The icon on the top bar's agent button and the agent's page, for this workspace only, over the app's. An SVG, PNG, JPG or WebP of at most ${MAX_BYTES / 1024} KB: a picture is resized to ${PX} px, an SVG is cleaned of anything but its drawing and, in one colour, follows the theme.${can ? '' : " Only the workspace's owners change it."}`
                : brand ? "The app's own agent icon, from its brand: every workspace shows it unless it brings its own." : "The console's default agent icon: every workspace shows it unless it brings its own."}
            </p>
          </div>
        )}
      />
    </div>
  );
}
