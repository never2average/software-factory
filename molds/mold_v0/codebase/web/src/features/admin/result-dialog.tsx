'use client';
// What happens after approve / create / invite / issue-key / rotate: the Clerk invitation, or a legacy key shown once,
// with per-client setup and a ready-to-send email.
import { useEffect, useState } from 'react';
import { buttonVariants, Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import type { InviteResult } from './lib';
import { copyText, CopyField, Notice, When } from './ui';

export function ResultDialog({ result, title, onClose }: { result: InviteResult | null; title: string; onClose: () => void }) {
  const [client, setClient] = useState('0');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  useEffect(() => {
    if (result) {
      setClient('0');
      setSubject(result.email.subject);
      setBody(result.email.body);
    }
  }, [result]);
  const legacy = Boolean(result?.key);
  const c = result?.clients[Number(client)];
  // A mailto link is a URL (webmail opens it as an https one): the key never goes in it; paste it into the mail yourself.
  const mailBody = result?.key ? body.replaceAll(result.key, '[paste the API key here]') : body;
  const mailto = result?.email.to ? `mailto:${encodeURIComponent(result.email.to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody)}` : null;
  return (
    <Dialog open={Boolean(result)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Connector URL, client setup and an email you can send.</DialogDescription>
        </DialogHeader>
        {result && (
          <div className='grid gap-4'>
            {legacy && (
              <Notice>
                <b>Shown once.</b> Only a hash is stored. Copy the key or the email now; if it is lost, rotate the key. The key goes in a header (each client's setup below), never in the URL.
              </Notice>
            )}
            {result.invitation ? (
              <Notice tone='ok'>
                <b>Clerk sent an invitation to {result.invitation.email}</b>
                {result.invitation.expires_at && (
                  <>
                    {' '}(expires <When d={result.invitation.expires_at} />)
                  </>
                )}
                . The connector URL has no secret in it: they sign in when their client asks.
              </Notice>
            ) : (
              !legacy && (
                <Notice tone='ok'>
                  <b>Account created.</b> Nobody is invited yet: invite people from the account.
                </Notice>
              )
            )}
            <div className='grid gap-1.5'>
              <Label>Connector URL</Label>
              <CopyField value={result.connector_url} />
            </div>
            {result.key && (
              <div className='grid gap-1.5'>
                <Label>API key</Label>
                <CopyField value={result.key} />
              </div>
            )}
            <div className='grid gap-2'>
              <Label>Client setup</Label>
              <Tabs value={client} onValueChange={(v) => setClient(String(v))}>
                <TabsList className='h-auto flex-wrap'>
                  {result.clients.map((x, i) => (
                    <TabsTrigger key={x.client} value={String(i)}>
                      {x.client}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {c && (
                <div className='text-sm'>
                  <p>{c.steps}</p>
                  {c.snippet && <pre className='bg-muted mt-2 overflow-x-auto rounded-md p-3 font-mono text-xs'>{c.snippet}</pre>}
                </div>
              )}
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='rd-subject'>{legacy ? 'Email with the key (send it yourself)' : 'Optional follow-up email (Clerk already sent the invitation)'}</Label>
              <Input id='rd-subject' value={subject} onChange={(e) => setSubject(e.target.value)} />
              <Textarea aria-label='Email body' className='min-h-56 font-mono text-xs' value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant='outline' onClick={() => copyText(body, 'Email copied')}>
            Copy email
          </Button>
          {mailto && (
            <a className={buttonVariants()} href={mailto} target='_blank' rel='noopener noreferrer'>
              Open in email
            </a>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
