'use client';
/**
 * Asking for access (mold_v0-098): the shell's request form, posting to POST /api/access-requests (src/http.ts), which
 * stores it for the platform's staff (/admin, Requests: approving one makes the account and invites the person), emails
 * the person a receipt when email is on, and tells the operator. Used on the public /request-access page and on the
 * portal's page for a signed-in person with no account (web/src/features/portal/no-account.tsx), where the address and
 * name come filled in. After sending it says so in place of the form, in a live region.
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { profile } from '@/config/profile.generated';

export interface RequestAccessDefaults { email?: string; name?: string; company?: string }

/** Where the request came from, as the admin's Requests list shows it (source.landing). */
const sourceOf = (from: string) => {
  const q = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const utm = Object.fromEntries(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].flatMap((k) => (q.get(k) ? [[k, q.get(k)!]] : [])));
  return { landing: from, ...(typeof document !== 'undefined' && document.referrer ? { referrer: document.referrer } : {}), ...utm };
};

export function RequestAccessForm({ defaults = {}, from, onSent }: { defaults?: RequestAccessDefaults; from: string; onSent?: (email: string) => void }) {
  const id = useId();
  const [email, setEmail] = useState(defaults.email ?? '');
  const [name, setName] = useState(defaults.name ?? '');
  const [company, setCompany] = useState(defaults.company ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/access-requests', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), name: name.trim(), company: company.trim(), message: message.trim(), source: sourceOf(from) })
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || (r.status === 429 ? 'Too many requests from this network. Try again in an hour.' : `The request did not go through (${r.status}). Try again.`));
      setSent(email.trim());
      onSent?.(email.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div role='status' className='bg-card flex flex-col gap-2 rounded-xl border p-5' data-testid='request-access-sent'>
        <p className='flex items-center gap-2 font-semibold'><Icons.circleCheck aria-hidden='true' className='text-primary size-5 shrink-0' /> Request sent</p>
        <p className='text-muted-foreground text-sm break-words'>
          Thank you. The {profile.name} team will look at it and, once it is approved, send an invitation to <span className='text-foreground font-medium break-all'>{sent}</span>. Nothing else is needed from you for now.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className='flex flex-col gap-4' aria-describedby={error ? `${id}-error` : undefined} data-testid='request-access-form'>
      {error ? <p id={`${id}-error`} role='alert' className='text-destructive text-sm'>{error}</p> : null}
      <div className='grid gap-4 sm:grid-cols-2'>
        <div className='grid gap-1.5'>
          <Label htmlFor={`${id}-email`}>Work email</Label>
          <Input id={`${id}-email`} name='email' type='email' autoComplete='email' required maxLength={200} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} className='h-10' />
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor={`${id}-name`}>Your name <span className='text-muted-foreground font-normal'>(optional)</span></Label>
          <Input id={`${id}-name`} name='name' autoComplete='name' maxLength={120} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} className='h-10' />
        </div>
      </div>
      <div className='grid gap-1.5'>
        <Label htmlFor={`${id}-company`}>Company</Label>
        <Input id={`${id}-company`} name='company' autoComplete='organization' required maxLength={200} value={company} onChange={(e) => setCompany(e.target.value)} disabled={busy} className='h-10' />
      </div>
      <div className='grid gap-1.5'>
        <Label htmlFor={`${id}-message`}>What would you like to use {profile.name} for? <span className='text-muted-foreground font-normal'>(optional)</span></Label>
        <Textarea id={`${id}-message`} name='message' maxLength={4000} rows={3} value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy} />
      </div>
      <div>
        <Button type='submit' disabled={busy} className='h-10 px-4'>
          {busy ? <Icons.spinner aria-hidden='true' className='animate-spin' /> : <Icons.send aria-hidden='true' />} {busy ? 'Sending…' : 'Request access'}
        </Button>
      </div>
    </form>
  );
}
