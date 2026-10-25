'use client';
/**
 * Asking for access (mold_v0-098): the shell's request form, posting to POST /api/access-requests (src/http.ts), which
 * stores it for the platform's staff (/admin, Requests: approving one makes the account and invites the person), emails
 * the person a receipt when email is on, and tells the operator. Used on the public /request-access page and on the
 * portal's page for a signed-in person with no account (web/src/features/portal/no-account.tsx), where the address and
 * name come filled in. After sending it says so in place of the form, in a live region.
 *
 * Besides the shell's own fields it asks the build's own questions (mold_v0-102, src/access-request.ts): the packs' pack.json
 * `access_request.fields` (or the app's profile.json), after the company and before the message, each sent under `answers`.
 */
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { fill } from '@/lib/vocabulary';
import { accessFields } from '@/config/access-request.generated';
import { UTM, visitSource } from './visit-source';
import { maxLengthOf, type AccessAnswer, type AccessField } from '@/lib/access-request.generated';

/** The fields a form asks: every declared one but those marked `ask: false` (mold_v0-138). */
const asked = accessFields.filter((f) => f.ask !== false);

export interface RequestAccessDefaults { email?: string; name?: string; company?: string }

/**
 * Where the request came from, as the admin's Requests list shows it (source.landing): the form's page, then what the
 * visit noted when it began (mold_v0-110, VisitSource: its first page, the site it came from, its utm tags), the tags on
 * this page's own address winning.
 */
const sourceOf = (from: string) => {
  const q = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const utm = Object.fromEntries(UTM.flatMap((k) => (q.get(k) ? [[k, q.get(k)!.slice(0, 200)]] : [])));
  const visit = typeof window === 'undefined' ? {} : visitSource();
  // The page before this one, only when it is another site's (a click inside this one is not where they came from).
  const external = typeof document !== 'undefined' && document.referrer && (() => { try { return new URL(document.referrer).origin !== window.location.origin; } catch { return false; } })();
  return { landing: from, ...(external ? { referrer: document.referrer } : {}), ...visit, ...utm };
};

export function RequestAccessForm({ defaults = {}, from, onSent }: { defaults?: RequestAccessDefaults; from: string; onSent?: (email: string) => void }) {
  const id = useId();
  const [email, setEmail] = useState(defaults.email ?? '');
  const [name, setName] = useState(defaults.name ?? '');
  const [company, setCompany] = useState(defaults.company ?? '');
  const [message, setMessage] = useState('');
  const [answers, setAnswers] = useState<Record<string, AccessAnswer>>({});
  const answer = (key: string, v: AccessAnswer) => setAnswers((a) => ({ ...a, [key]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A required choice of several has no check of the browser's own: say so here (the server checks every field again).
    const missing = asked.find((f) => f.required && f.type === 'multi_select' && !((answers[f.key] as string[] | undefined)?.length));
    if (missing) { setError(`${missing.label}: choose at least one.`); return; }
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/access-requests', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), name: name.trim(), company: company.trim(), message: message.trim(), answers, source: sourceOf(from) })
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
          {fill('Thank you. The {product} team will look at it')} and, once it is approved, send an invitation to <span className='text-foreground font-medium break-all'>{sent}</span>. Nothing else is needed from you for now.
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
      {asked.map((f) => <AccessFieldInput key={f.key} id={`${id}-f-${f.key}`} field={f} value={answers[f.key]} onChange={(v) => answer(f.key, v)} disabled={busy} />)}
      <div className='grid gap-1.5'>
        <Label htmlFor={`${id}-message`}>{fill('What would you like to use {product} for?')} <span className='text-muted-foreground font-normal'>(optional)</span></Label>
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

const optional = <span className='text-muted-foreground font-normal'>(optional)</span>;

/** One of the build's own questions (src/access-request.ts): a line, a box, an address, one choice or several. */
function AccessFieldInput({ id, field: f, value, onChange, disabled }: { id: string; field: AccessField; value: AccessAnswer | undefined; onChange: (v: AccessAnswer) => void; disabled: boolean }) {
  const help = f.help ? <p id={`${id}-help`} className='text-muted-foreground text-xs break-words'>{f.help}</p> : null;
  const described = f.help ? `${id}-help` : undefined;
  const label = <>{f.label}{f.required ? null : <> {optional}</>}</>;
  if (f.type === 'multi_select') {
    const chosen = Array.isArray(value) ? value : [];
    return (
      <fieldset className='grid min-w-0 gap-1.5' aria-describedby={described} data-field={f.key}>
        <legend className='mb-1.5 text-sm leading-none font-medium select-none'>{label}</legend>
        {help}
        <div className='flex flex-wrap gap-x-4 gap-y-1'>
          {(f.options ?? []).map((o) => (
            <label key={o.value} className='flex min-h-6 cursor-pointer items-center gap-2 text-sm'>
              <input type='checkbox' name={f.key} value={o.value} checked={chosen.includes(o.value)} disabled={disabled} className='size-4 accent-[var(--primary)]'
                onChange={(e) => onChange(e.target.checked ? [...chosen, o.value] : chosen.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <div className='grid min-w-0 gap-1.5' data-field={f.key}>
      <Label htmlFor={id}>{label}</Label>
      {f.type === 'select' ? (
        <NativeSelect id={id} name={f.key} required={f.required} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} className='w-full'>
          <NativeSelectOption value=''>{f.placeholder ?? 'Choose one'}</NativeSelectOption>
          {(f.options ?? []).map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
        </NativeSelect>
      ) : f.type === 'long_text' ? (
        <Textarea id={id} name={f.key} required={f.required} maxLength={maxLengthOf(f)} rows={3} placeholder={f.placeholder} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} />
      ) : (
        <Input id={id} name={f.key} required={f.required} maxLength={maxLengthOf(f)} placeholder={f.placeholder} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} className='h-10'
          {...(f.type === 'email' ? { type: 'email' } : f.type === 'url' ? { type: 'text', inputMode: 'url' as const, autoComplete: 'url' } : {})} />
      )}
      {help}
    </div>
  );
}
