'use client';
/**
 * The request page's form (mold_v0-138, after the first product's early-access form): what is needed first (a work email
 * and the company) and the build's own questions (src/access-request.ts, the packs' pack.json `access_request`) above a
 * fold; the fields marked `more`, the name and the message folded under it (the landing block's request_page.form.more);
 * fields marked `ask: false` are not asked. It checks the addresses before sending and says what is missing beside each
 * field, then posts to POST /api/access-requests, as the shell's /request-access form does, and says what happens next in
 * place of the form. Where the visitor came from goes with it: the visit's first page as `landing` (VisitSource, in the
 * root layout, notes it in sessionStorage), the site before it and the utm_* tags (this page's own winning).
 */
import { useId, useState } from 'react';
import { IconArrowRight, IconChevronDown, IconCircleCheck } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { accessFields } from '@/config/access-request.generated';
import { fill } from '@/lib/vocabulary';
import { maxLengthOf, normalizeUrl, type AccessAnswer, type AccessField } from '@/lib/access-request.generated';
import type { RequestPage } from './landing-types';
import { UTM, visitSource } from './visit-source';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const asked = accessFields.filter((f) => f.ask !== false);

/** Where the request came from: the visit's first page (else this one), the site before it, the utm tags (this page's first). */
function sourceOf(): Record<string, string> {
  try {
    const visit = visitSource();
    const q = new URLSearchParams(window.location.search);
    const out: Record<string, string> = { landing: visit.first_page ?? window.location.pathname };
    const external = document.referrer && (() => { try { return new URL(document.referrer).origin !== window.location.origin; } catch { return false; } })();
    const referrer = visit.referrer ?? (external ? document.referrer : '');
    if (referrer) out.referrer = referrer;
    for (const k of UTM) { const v = q.get(k)?.slice(0, 200) ?? visit[k]; if (v) out[k] = v; }
    return out;
  } catch { return {}; }
}

/** A line said once sent, with the sender's company and address in it. */
const said = (line: string, company: string, email: string) =>
  line.replace(/\{company\}/g, company || 'your company').replace(/\{email\}/g, email || 'you');

type Shell = 'email' | 'company' | 'name' | 'message';

export function RequestPageForm({ form = {} }: { form?: RequestPage['form'] }) {
  const id = useId();
  const [v, setV] = useState<Record<Shell, string>>({ email: '', company: '', name: '', message: '' });
  const [answers, setAnswers] = useState<Record<string, AccessAnswer>>({});
  const [more, setMore] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');
  const fid = (k: string) => `${id}-f-${k}`;
  const clear = (k: string) => { if (errs[k]) setErrs({ ...errs, [k]: '' }); };
  const setShell = (k: Shell) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setV({ ...v, [k]: e.target.value }); clear(k); };
  const answer = (k: string, a: AccessAnswer) => { setAnswers({ ...answers, [k]: a }); clear(k); };
  const text = (k: string) => (typeof answers[k] === 'string' ? (answers[k] as string) : '');
  const folded = form.more ? asked.filter((f) => f.more) : [];
  const shown = asked.filter((f) => !folded.includes(f));

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.email.trim()) e.email = 'Enter your email.';
    else if (!EMAIL.test(v.email.trim())) e.email = 'Enter a valid email address.';
    if (!v.company.trim()) e.company = 'Enter your company name.';
    for (const f of asked) {
      const a = answers[f.key];
      const t = typeof a === 'string' ? a.trim() : '';
      if (f.type === 'multi_select') { if (f.required && !(Array.isArray(a) && a.length)) e[f.key] = `${f.label}: choose at least one.`; continue; }
      if (!t) { if (f.required) e[f.key] = `${f.label} is required.`; continue; }
      if (f.type === 'url' && !normalizeUrl(t)) e[f.key] = `Enter a valid URL${f.placeholder ? `, e.g. ${f.placeholder}` : '.'}`;
      if (f.type === 'email' && !EMAIL.test(t)) e[f.key] = 'Enter a valid email address.';
    }
    setErrs(e);
    const first = Object.keys(e)[0];
    if (first) {
      // A field in the fold is shown before it is pointed at.
      if (folded.some((f) => f.key === first)) setMore(true);
      setTimeout(() => document.getElementById(fid(first))?.focus(), 0);
    }
    return !first;
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setError('');
    if (!validate()) return;
    setStatus('sending');
    try {
      const sent: Record<string, AccessAnswer> = {};
      for (const f of asked) {
        const a = answers[f.key];
        if (Array.isArray(a)) { if (a.length) sent[f.key] = a; continue; }
        const t = (a ?? '').trim();
        if (t) sent[f.key] = f.type === 'url' ? (normalizeUrl(t) ?? t) : t;
      }
      const res = await fetch('/api/access-requests', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: v.email.trim(), company: v.company.trim(), name: v.name.trim(), message: v.message.trim(), answers: sent, source: sourceOf() })
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (res.ok) return setStatus('done');
      setError((data && typeof data.error === 'string' && data.error) || (res.status === 429 ? 'Too many requests. Please try again in a minute.' : `Something went wrong (HTTP ${res.status}). Please try again.`));
    } catch {
      setError('Network error. Check your connection and try again.');
    }
    setStatus('idle');
  };

  if (status === 'done') {
    const steps = form.done?.steps ?? [fill('The {product} team looks at your request.'), 'Once it is approved, an invitation goes to {email}.'];
    return (
      <div className='flex flex-col items-start gap-3 py-6' role='status' tabIndex={-1}>
        <IconCircleCheck className='text-primary size-10' aria-hidden='true' />
        <h3 className='text-lg font-semibold'>{form.done?.title ?? 'Request sent'}</h3>
        <ol className='text-muted-foreground mt-1 space-y-2 text-sm'>
          {steps.map((s, i) => (
            <li key={i}><span className='text-foreground font-medium'>{i + 1}.</span> {said(s, v.company.trim(), v.email.trim())}</li>
          ))}
        </ol>
      </div>
    );
  }

  /** A line of text with its label and, under it, what is wrong with it. */
  const line = (k: string, label: string, value: string, onChange: React.ChangeEventHandler<HTMLInputElement>, props: React.ComponentProps<'input'>) => (
    <div className='space-y-1.5' key={k}>
      <Label htmlFor={fid(k)}>{label}</Label>
      <Input id={fid(k)} name={k} value={value} onChange={onChange} aria-invalid={Boolean(errs[k]) || undefined} aria-describedby={`${id}-e-${k}`} {...props} />
      <p id={`${id}-e-${k}`} className='text-destructive min-h-4 text-xs'>{errs[k]}</p>
    </div>
  );

  /** One of the build's own questions. */
  const ask = (f: AccessField) => {
    if (f.type === 'multi_select') {
      const chosen = Array.isArray(answers[f.key]) ? (answers[f.key] as string[]) : [];
      return (
        <fieldset key={f.key} className='space-y-2 pb-4' aria-describedby={f.help ? `${id}-h-${f.key}` : undefined}>
          <legend className='text-sm font-medium'>{f.label}</legend>
          {f.help ? <p id={`${id}-h-${f.key}`} className='text-muted-foreground text-xs'>{f.help}</p> : null}
          <div className='flex flex-wrap gap-1.5 pt-1.5'>
            {(f.options ?? []).map((o) => {
              const on = chosen.includes(o.value);
              return (
                <button key={o.value} type='button' aria-pressed={on} onClick={() => answer(f.key, on ? chosen.filter((x) => x !== o.value) : [...chosen, o.value])}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${on ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'}`}>{o.label}</button>
              );
            })}
          </div>
          {errs[f.key] ? <p className='text-destructive text-xs'>{errs[f.key]}</p> : null}
        </fieldset>
      );
    }
    if (f.type === 'select') return (
      <div key={f.key} className='space-y-1.5 pb-5'>
        <Label htmlFor={fid(f.key)}>{f.label}</Label>
        <NativeSelect id={fid(f.key)} name={f.key} value={text(f.key)} onChange={(e) => answer(f.key, e.target.value)} className='w-full'
          aria-invalid={Boolean(errs[f.key]) || undefined} aria-describedby={errs[f.key] ? `${id}-e-${f.key}` : f.help ? `${id}-h-${f.key}` : undefined}>
          <NativeSelectOption value=''>{f.placeholder ?? 'Choose'}</NativeSelectOption>
          {(f.options ?? []).map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
        </NativeSelect>
        {f.help ? <p id={`${id}-h-${f.key}`} className='text-muted-foreground text-xs'>{f.help}</p> : null}
        {errs[f.key] ? <p id={`${id}-e-${f.key}`} className='text-destructive text-xs'>{errs[f.key]}</p> : null}
      </div>
    );
    if (f.type === 'long_text') return (
      <div key={f.key} className='space-y-1.5 pb-5'>
        <Label htmlFor={fid(f.key)}>{f.label}</Label>
        <Textarea id={fid(f.key)} name={f.key} rows={3} maxLength={maxLengthOf(f)} placeholder={f.placeholder} value={text(f.key)} onChange={(e) => answer(f.key, e.target.value)}
          aria-invalid={Boolean(errs[f.key]) || undefined} aria-describedby={`${id}-e-${f.key}`} />
        <p id={`${id}-e-${f.key}`} className='text-destructive min-h-4 text-xs'>{errs[f.key] || f.help}</p>
      </div>
    );
    return line(f.key, f.label, text(f.key), (e) => answer(f.key, e.target.value), {
      maxLength: maxLengthOf(f), placeholder: f.placeholder,
      ...(f.type === 'url' ? { type: 'url', inputMode: 'url' as const, autoComplete: 'url' } : f.type === 'email' ? { type: 'email' } : {})
    });
  };

  const name = line('name', 'Your name', v.name, setShell('name'), { autoComplete: 'name', maxLength: 120 });
  const message = (
    <div className='space-y-1.5' key='message'>
      <Label htmlFor={fid('message')}>{form.message_label ?? fill('What would you like to use {product} for?')}</Label>
      <Textarea id={fid('message')} name='message' rows={3} maxLength={4000} value={v.message} onChange={setShell('message')} />
    </div>
  );

  return (
    <form onSubmit={submit} noValidate className='space-y-2'>
      {/* What is needed first; everything else is optional, and what the build marks `more` is folded away. */}
      <div className='grid'>
        {line('email', 'Work email', v.email, setShell('email'), { type: 'email', autoComplete: 'email', placeholder: 'you@company.com', maxLength: 254, required: true, autoFocus: true })}
        {line('company', 'Company', v.company, setShell('company'), { autoComplete: 'organization', placeholder: 'Acme', maxLength: 200, required: true })}
      </div>
      {folded.length ? (
        <>
          {shown.map(ask)}
          <details className='group border-y py-3 [&_summary::-webkit-details-marker]:hidden' open={more} onToggle={(e) => setMore((e.target as HTMLDetailsElement).open)}>
            <summary className='text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center justify-between text-sm'>
              <span>{form.more}</span>
              <IconChevronDown className='size-4 transition-transform group-open:rotate-180' aria-hidden='true' />
            </summary>
            <div className='grid pt-4'>
              {name}
              {folded.map(ask)}
              {message}
            </div>
          </details>
        </>
      ) : (
        <>
          {name}
          {shown.map(ask)}
          {message}
        </>
      )}

      {error && <p className='text-destructive text-sm' role='alert'>{error}</p>}
      <div className='pt-3'>
        <Button type='submit' size='lg' disabled={status === 'sending'} aria-busy={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : <>{form.submit ?? 'Request access'} <IconArrowRight aria-hidden='true' /></>}
        </Button>
      </div>
    </form>
  );
}
