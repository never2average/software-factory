'use client';
// What happens after approve / create / invite / issue-key / rotate: the Clerk invitation, or a legacy key shown once,
// then the connection (mold_v0-277, features/connect/connect-parts.tsx): the connector URL with the AI client dropdown
// beside it and that client's own way in, and the setup email for the client or clients chosen, built by the server for
// those clients only (POST /setup-email; the key's place a placeholder, pasted over here), previewed, then copied or
// opened in the staff member's own mail app.
import { useState } from 'react';
import { buttonVariants, Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { ClientSelect, ClientWay, SetupEmail, UrlField } from '@/features/connect/connect-parts';
import { post, type InviteResult } from './lib';
import { copyText, CopyField, Notice, When } from './ui';

/** Where the API key goes in the server's text (src/admin.ts KEY_PLACEHOLDER): a mailto link never carries the key. */
const KEY_PLACEHOLDER = '[paste the API key here]';

export function ResultDialog({ result, title, onClose }: { result: InviteResult | null; title: string; onClose: () => void }) {
  return (
    <Dialog open={Boolean(result)} onOpenChange={(o) => !o && onClose()}>
      {/* Content never wider than the popup (operator, 2026-11-08: the invite popup overflowed): long URLs, keys and emails wrap. */}
      <DialogContent className='max-h-[90vh] overflow-x-hidden overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>The connector URL, the setup for the AI client you choose, and an email for those clients.</DialogDescription>
        </DialogHeader>
        {result && <ResultBody key={`${result.org.slug}:${result.connector_url}:${result.key ?? ''}`} result={result} />}
      </DialogContent>
    </Dialog>
  );
}

function ResultBody({ result }: { result: InviteResult }) {
  const legacy = Boolean(result.key);
  const [pick, setPick] = useState(result.clients[0]?.id ?? '');
  const c = result.clients.find((x) => x.id === pick) ?? result.clients[0];
  const withKey = (t: string) => (result.key ? t.replaceAll(KEY_PLACEHOLDER, result.key) : t);
  return (
    <div className='grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 [overflow-wrap:anywhere]'>
      {legacy && (
        <Notice>
          <b>Shown once.</b> Only a hash is stored. Copy the key or the email now; if it is lost, rotate the key. The key goes in a header (each client's setup below), never in the URL.
        </Notice>
      )}
      {result.invitation ? (
        <Notice tone='ok'>
          <b>Clerk sent an invitation to {result.invitation.email}</b>
          {result.invitation.expires_at && <> (expires <When d={result.invitation.expires_at} />)</>}
          . The connector URL has no secret in it: they sign in when their client asks.
        </Notice>
      ) : (
        !legacy && result.created !== undefined && (
          <Notice tone='ok'>
            <b>Account created.</b> Nobody is invited yet: invite people from the account.
          </Notice>
        )
      )}
      <div className='grid min-w-0 gap-1.5'>
        <Label htmlFor='rd-client'>Connector URL</Label>
        <div className='flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center'>
          <UrlField url={result.connector_url} secret={false} className='sm:flex-1' />
          <ClientSelect clients={result.clients} value={c?.id} onChange={setPick} id='rd-client' className='sm:w-52 sm:shrink-0' />
        </div>
      </div>
      {result.key && (
        <div className='grid min-w-0 gap-1.5'>
          <Label>API key</Label>
          <CopyField value={result.key} />
        </div>
      )}
      {c && <ClientWay c={c} />}
      <div className='grid min-w-0 gap-1.5 border-t pt-4'>
        <Label>Setup email{result.email.to ? ` to ${result.email.to}` : ''}</Label>
        <SetupEmail clients={result.clients} current={c?.id}
          preview={(ids) => post('/setup-email', { clients: ids, ...(legacy ? { key: true } : {}) })}
          actions={(e) => (
            <>
              <Button variant='outline' size='sm' onClick={() => copyText(withKey(`Subject: ${e.subject}\n\n${e.body}`), 'Email copied')}>Copy email</Button>
              {result.email.to && (
                <a className={buttonVariants({ variant: 'outline', size: 'sm' })} target='_blank' rel='noopener noreferrer'
                  href={`mailto:${encodeURIComponent(result.email.to)}?subject=${encodeURIComponent(e.subject)}&body=${encodeURIComponent(e.body)}`}>
                  Open in email
                </a>
              )}
              {legacy && <span className='text-muted-foreground text-xs'>Open in email leaves the key out: paste it over {KEY_PLACEHOLDER}.</span>}
            </>
          )} />
      </div>
    </div>
  );
}

/** Result state + dialog for pages that create invitations or keys. */
export function useResult() {
  const [state, setState] = useState<{ result: InviteResult; title: string } | null>(null);
  return {
    show: (result: InviteResult, title: string) => setState({ result, title }),
    dialog: <ResultDialog result={state?.result ?? null} title={state?.title ?? ''} onClose={() => setState(null)} />
  };
}
