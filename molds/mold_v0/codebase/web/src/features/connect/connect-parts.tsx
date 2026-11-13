'use client';
// The connection's parts (mold_v0-277), shared by the customer Overview's Connect card (features/portal/setup.tsx) and
// the staff console's invite result (features/admin/result-dialog.tsx): the connection URL (copy; show and hide when it
// holds a key), the AI client dropdown from the client catalogue (src/connect-catalog.ts), the chosen client's own way
// in (one-click install, command, config snippet or its settings steps), and the setup email: one client from the
// dropdown or several by checkbox, its subject and body built by the server for those clients only, previewed first.
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { CopyButton } from '@/features/portal/shared';

/** One AI client of the catalogue (src/connect-catalog.ts ClientEntry), as the API sends it. */
export interface ConnectClient {
  id: string; client: string; group: 'chat' | 'agent' | 'editor'; method: 'ui' | 'cli' | 'config' | 'link'; steps: string;
  command?: string; snippet?: string; file?: string; install_url?: string; verified?: boolean; share?: number | null;
}
/** The setup email the server built for the chosen clients (src/setup-email.ts). */
export interface SetupEmailText { subject: string; body: string; clients: string[] }

/** The most clients one email carries (src/setup-email.ts MAX_SETUP_CLIENTS). */
export const MAX_EMAIL_CLIENTS = 5;
const GROUPS: [ConnectClient['group'], string][] = [['chat', 'Chat apps'], ['agent', 'Coding agents'], ['editor', 'Editors']];

/**
 * A URL with its secret masked: a key or token in the query, a key in the path, any key-shaped word (mold_v0-298: not
 * tied to one build's key prefix; the same masking as portal/setup.tsx maskConnectionUrl).
 */
export const maskUrl = (url: string) => url
  .replace(/([?&#](?:key|api_key|apikey|token|access_token|secret|k)=)[^&#]+/gi, '$1••••••••')
  .replace(/(\/mcp\/)([^/?#]{12,})/i, '$1••••••••')
  .replace(/\b([A-Za-z][A-Za-z0-9]{1,11}_[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{12,}/g, '$1••••••••');

/** The connection URL in a box: copy it; when it holds a key, show or hide it (hidden at first). */
export function UrlField({ url, secret, className }: { url: string; secret: boolean; className?: string }) {
  const [show, setShow] = useState(!secret);
  return (
    <div className={cn('bg-background flex min-w-0 items-center gap-1 rounded-md border py-1 pr-1 pl-2.5', className)} data-connect-url>
      <code className='min-w-0 flex-1 truncate font-mono text-xs select-all' title={show ? url : undefined}>{show ? url : maskUrl(url)}</code>
      {secret && (
        <Button variant='outline' size='icon-sm' onClick={() => setShow(!show)} aria-label={show ? 'Hide the URL' : 'Show the URL'} title={show ? 'Hide' : 'Show'}>
          {show ? <Icons.eyeOff className='size-4' /> : <Icons.eye className='size-4' />}
        </Button>
      )}
      <CopyButton text={url} label='Copy URL' />
    </div>
  );
}

/** The AI client dropdown: every client of the catalogue, by group. */
export function ClientSelect({ clients, value, onChange, id, className }: { clients: ConnectClient[]; value: string | undefined; onChange: (id: string) => void; id?: string; className?: string }) {
  return (
    <NativeSelect id={id} aria-label='Your AI client' value={value} onChange={(e) => onChange(e.target.value)} className={cn('bg-background w-full', className)} data-connect-client>
      {GROUPS.map(([g, label]) => {
        const xs = clients.filter((x) => x.group === g);
        return xs.length ? (
          <NativeSelectOptGroup key={g} label={label}>
            {xs.map((x) => <NativeSelectOption key={x.id} value={x.id}>{x.client}</NativeSelectOption>)}
          </NativeSelectOptGroup>
        ) : null;
      })}
    </NativeSelect>
  );
}

/** The chosen client's own way in: its steps, then its one-click install, command and config snippet, as it has them. */
export function ClientWay({ c }: { c: ConnectClient }) {
  return (
    <div className='flex min-w-0 flex-col gap-3 text-sm' data-client-way={c.id}>
      <p className='text-muted-foreground select-text'>{c.steps}</p>
      {c.install_url && (
        <div><Button size='sm' variant='outline' render={<a href={c.install_url} />}><Icons.add /> Add to {c.client}</Button></div>
      )}
      {c.command && (
        <div className='flex min-w-0 items-start gap-2'>
          <code className='bg-background min-w-0 flex-1 overflow-x-auto rounded-md border px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap' aria-label='Command'>{c.command}</code>
          <CopyButton text={c.command} />
        </div>
      )}
      {c.snippet && (
        <div className='flex min-w-0 flex-col gap-1'>
          {c.file && <div className='text-muted-foreground text-xs'>{c.command || c.install_url ? 'Or add to ' : 'In '}<code className='font-mono'>{c.file}</code></div>}
          <div className='relative'>
            <pre className='bg-background max-h-56 overflow-auto rounded-md border p-2.5 pr-20 font-mono text-xs break-all whitespace-pre-wrap'>{c.snippet}</pre>
            <div className='absolute top-1 right-1'><CopyButton text={c.snippet} /></div>
          </div>
        </div>
      )}
      {c.verified === false && <p className='text-muted-foreground text-xs'>If your version of {c.client} differs, follow its own MCP docs with the URL above.</p>}
    </div>
  );
}

/**
 * The setup email: the dropdown's client is chosen (and follows the dropdown until a box is changed by hand); tick
 * more, up to MAX_EMAIL_CLIENTS. Preview asks the server for the subject and body for exactly those clients; the
 * caller's `actions` (send, copy, open in mail) act on that preview, and a change of choice clears it.
 */
export function SetupEmail({ clients, current, preview, actions, note }: {
  clients: ConnectClient[]; current: string | undefined;
  preview: (ids: string[]) => Promise<SetupEmailText>;
  actions: (email: SetupEmailText) => React.ReactNode;
  note?: React.ReactNode;
}) {
  const [chosen, setChosen] = useState<string[]>(current ? [current] : []);
  const [touched, setTouched] = useState(false);
  const [email, setEmail] = useState<SetupEmailText | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  useEffect(() => { if (!touched && current) { setChosen([current]); setEmail(null); } }, [current, touched]);
  const toggle = (id: string, on: boolean) => {
    setTouched(true); setEmail(null); setError(null);
    setChosen((xs) => (on ? (xs.includes(id) || xs.length >= MAX_EMAIL_CLIENTS ? xs : [...xs, id]) : xs.filter((x) => x !== id)));
  };
  const names = chosen.map((id) => clients.find((c) => c.id === id)?.client ?? id);
  const run = () => {
    setBusy(true); setError(null);
    preview(chosen).then(setEmail, (e: Error) => { setEmail(null); setError(e.message); }).finally(() => setBusy(false));
  };
  return (
    <div className='flex min-w-0 flex-col gap-3' data-setup-email>
      <fieldset className='min-w-0'>
        <legend className='text-muted-foreground mb-2 text-xs'>
          {chosen.length ? <>For {names.join(', ')}{chosen.length >= MAX_EMAIL_CLIENTS ? ` (at most ${MAX_EMAIL_CLIENTS})` : ''}</> : 'Tick the clients the email is for'}
        </legend>
        <div className='grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 2xl:grid-cols-3'>
          {clients.map((c) => {
            const on = chosen.includes(c.id), id = `${uid}-${c.id}`;
            return (
              <label key={c.id} htmlFor={id} className={cn('flex min-w-0 items-center gap-2 text-sm', !on && chosen.length >= MAX_EMAIL_CLIENTS && 'opacity-50')}>
                {/* A visible box while unticked too: the theme's input line is too faint on a white card. */}
                <Checkbox id={id} checked={on} disabled={!on && chosen.length >= MAX_EMAIL_CLIENTS} onCheckedChange={(v) => toggle(c.id, Boolean(v))}
                  className='border-muted-foreground/60 bg-background dark:border-muted-foreground/70' data-client={c.id} data-client-name={c.client} />
                <span className='truncate'>{c.client}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className='flex flex-wrap items-center gap-2'>
        <Button variant='outline' size='sm' onClick={run} disabled={busy || !chosen.length} data-email-preview-button>
          {busy ? <Icons.spinner className='animate-spin' /> : <Icons.eye />} Preview email
        </Button>
        {note}
      </div>
      {error && <p className='text-destructive text-sm' role='alert'>{error}</p>}
      {email && (
        <div className='bg-muted/40 flex min-w-0 flex-col rounded-md border' data-email-preview aria-live='polite'>
          <div className='border-b px-3 py-2 text-sm'>
            <span className='text-muted-foreground'>Subject: </span><span className='font-medium' data-email-subject>{email.subject}</span>
          </div>
          <pre className='max-h-80 overflow-auto px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap select-text' data-email-body>{email.body}</pre>
          <div className='flex flex-wrap items-center gap-2 border-t px-3 py-2'>{actions(email)}</div>
        </div>
      )}
    </div>
  );
}
