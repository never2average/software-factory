'use client';
/**
 * The request page's form (mold_v0-138, after the first product's early-access form): what is needed first (a work email
 * and the company), then the build's own questions (src/access-request.ts, the packs' pack.json `access_request`) the page
 * picks by key (the landing block's request_page.form: `fields` above a fold, default every declared one not in it; the
 * fold `more` {label, fields}, which also holds the name and the message). It checks the addresses before sending and says
 * what is missing beside each field, then posts to POST /api/access-requests, as the shell's /request-access form does,
 * and says what happens next in place of the form. mold_v0-266: its fields (the shell's own too), their words and order,
 * its button and what it says once sent are the form in force (./access-form.ts): what staff saved, else the page's own,
 * drawn exactly as before. Where the visitor came from goes with it: the visit's first page as `landing` (VisitSource, in the
 * root layout, notes it in sessionStorage), the site before it and the utm_* tags (this page's own winning).
 */
import { useId, useMemo, useState } from 'react';
import { IconArrowRight, IconChevronDown, IconCircleCheck } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { askedFields, isShellFormKey, maxLengthOf, normalizeUrl, thanksLine, type AccessAnswer, type AccessFormConfig, type FormField, type ShellFormKey } from '@/lib/access-request.generated';
import { requestPageDefaults, useLiveRequestForm } from './access-form';
import type { RequestPage } from './landing-types';
import { UTM, visitSource } from './visit-source';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

type Shell = ShellFormKey;

export function RequestPageForm({ form = {}, config, preview }: {
  form?: RequestPage['form'];
  /** The form in force (mold_v0-266, ./access-form.ts): a saved form, null for the page's own; left out, it is asked for. */
  config?: AccessFormConfig | null;
  /** The staff editor's preview: drawn the same, never sent. */
  preview?: boolean;
}) {
  const id = useId();
  const live = useLiveRequestForm(config);
  const cfg = useMemo(() => live ?? requestPageDefaults(form), [live, form]);
  const [v, setV] = useState<Record<Shell, string>>({ email: '', company: '', name: '', message: '' });
  const [answers, setAnswers] = useState<Record<string, AccessAnswer>>({});
  const [more, setMore] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');
  const fid = (k: string) => `${id}-f-${k}`;
  const clear = (k: string) => { if (errs[k]) setErrs({ ...errs, [k]: '' }); };
  const setShell = (k: Shell) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setV({ ...v, [k]: e.target.value }); clear(k); };
  const answer = (k: string, a: AccessAnswer) => { if (isShellFormKey(k)) setV({ ...v, [k]: String(a) }); else setAnswers({ ...answers, [k]: a }); clear(k); };
  const valueOf = (k: string): AccessAnswer | undefined => (isShellFormKey(k) ? v[k] : answers[k]);
  const text = (k: string) => { const a = valueOf(k); return typeof a === 'string' ? a : ''; };
  const asked = askedFields(cfg);
  // The page's fold (request_page.form.more) holds its fields, the name and the message, wherever the form puts them.
  const foldKeys = form.more ? new Set(['name', 'message', ...(form.more.fields ?? [])]) : null;
  const above = asked.filter((f) => !foldKeys?.has(f.key));
  const folded = asked.filter((f) => foldKeys?.has(f.key));
  // What is needed first (the address and the company), one block, while they lead the form.
  const lead: FormField[] = [];
  for (const f of above) { if ((f.key === 'email' || f.key === 'company') && (f.type === 'text' || f.type === 'email')) lead.push(f); else break; }

  const validate = () => {
    const e: Record<string, string> = {};
    if (!v.email.trim()) e.email = 'Enter your email.';
    else if (!EMAIL.test(v.email.trim())) e.email = 'Enter a valid email address.';
    for (const f of asked) {
      if (f.key === 'email') continue;
      const a = valueOf(f.key);
      const t = typeof a === 'string' ? a.trim() : '';
      if (f.type === 'multi_select') { if (f.required && !(Array.isArray(a) && a.length)) e[f.key] = `${f.label}: choose at least one.`; continue; }
      if (!t) { if (f.required) e[f.key] = f.key === 'company' && f.label === 'Company' ? 'Enter your company name.' : `${f.label} is required.`; continue; }
      if (f.type === 'url' && !normalizeUrl(t)) e[f.key] = `Enter a valid URL${f.placeholder ? `, e.g. ${f.placeholder}` : '.'}`;
      if (f.type === 'email' && !EMAIL.test(t)) e[f.key] = 'Enter a valid email address.';
      if (f.type === 'number' && !/^-?\d{1,15}(\.\d{1,6})?$/.test(t)) e[f.key] = `${f.label}: enter a number, such as 12 or 4.5.`;
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
    if (preview) return setStatus('done');
    setStatus('sending');
    try {
      const sent: Record<string, AccessAnswer> = {};
      for (const f of asked) {
        if (isShellFormKey(f.key)) continue;
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
    return (
      <div className='flex flex-col items-start gap-3 py-6' role='status' tabIndex={-1}>
        <IconCircleCheck className='text-primary size-10' aria-hidden='true' />
        <h3 className='text-lg font-semibold'>{cfg.thanks.title}</h3>
        <ol className='text-muted-foreground mt-1 space-y-2 text-sm'>
          {cfg.thanks.lines.map((s, i) => (
            <li key={i}><span className='text-foreground font-medium'>{i + 1}.</span> {thanksLine(s, v.company.trim(), v.email.trim())}</li>
          ))}
        </ol>
      </div>
    );
  }

  /** A line of text with its label and, under it, what is wrong with it (or its help). */
  const line = (k: string, label: string, value: string, onChange: React.ChangeEventHandler<HTMLInputElement>, props: React.ComponentProps<'input'>, help?: string) => (
    <div className='space-y-1.5' key={k}>
      <Label htmlFor={fid(k)}>{label}</Label>
      <Input id={fid(k)} name={k} value={value} onChange={onChange} aria-invalid={Boolean(errs[k]) || undefined} aria-describedby={`${id}-e-${k}`} {...props} />
      <p id={`${id}-e-${k}`} className='text-destructive min-h-4 text-xs'>{errs[k] || (help ? <span className='text-muted-foreground'>{help}</span> : null)}</p>
    </div>
  );

  /** One of the form's questions (one of the build's, or one of the shell's drawn as another kind). */
  const ask = (f: FormField) => {
    if (f.type === 'multi_select') {
      const a = answers[f.key];
      const chosen = Array.isArray(a) ? a : [];
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
      ...(f.type === 'url' ? { type: 'url', inputMode: 'url' as const, autoComplete: 'url' } : f.type === 'email' ? { type: 'email' } : f.type === 'number' ? { inputMode: 'decimal' as const } : {})
    }, live ? f.help : undefined); // a line's help: only in a saved form (the page's own never showed it)
  };

  /** One of the shell's own fields, drawn as the page always drew it (another kind: as a question). */
  const shellField = (f: FormField) => {
    const k = f.key as Shell;
    if (k === 'message' && f.type === 'long_text') return (
      <div className='space-y-1.5' key='message'>
        <Label htmlFor={fid('message')}>{f.label}</Label>
        <Textarea id={fid('message')} name='message' rows={3} maxLength={maxLengthOf(f)} placeholder={f.placeholder} value={v.message} onChange={setShell('message')}
          required={f.required || undefined} aria-describedby={f.help ? `${id}-h-message` : undefined} />
        {f.help ? <p id={`${id}-h-message`} className='text-muted-foreground text-xs'>{f.help}</p> : null}
      </div>
    );
    if (f.type !== 'text' && f.type !== 'email') return ask(f);
    const own: Record<Shell, React.ComponentProps<'input'>> = {
      email: { type: 'email', autoComplete: 'email', required: true, autoFocus: true },
      company: { autoComplete: 'organization' },
      name: { autoComplete: 'name' },
      message: {}
    };
    return line(k, f.label, v[k], setShell(k), {
      ...(f.type === 'email' ? { type: 'email' } : {}), ...own[k], ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      maxLength: maxLengthOf(f), ...(f.required ? { required: true } : {})
    }, live ? f.help : undefined);
  };
  const draw = (f: FormField) => (isShellFormKey(f.key) ? shellField(f) : ask(f));

  return (
    <form onSubmit={submit} noValidate className='space-y-2'>
      {/* What is needed first; the rest is optional, and what the page puts in its fold is folded away. */}
      {lead.length ? <div className='grid'>{lead.map(draw)}</div> : null}
      {form.more ? (
        <>
          {above.slice(lead.length).map(draw)}
          <details className='group border-y py-3 [&_summary::-webkit-details-marker]:hidden' open={more} onToggle={(e) => setMore((e.target as HTMLDetailsElement).open)}>
            <summary className='text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center justify-between text-sm'>
              <span>{form.more.label}</span>
              <IconChevronDown className='size-4 transition-transform group-open:rotate-180' aria-hidden='true' />
            </summary>
            <div className='grid pt-4'>
              {folded.map(draw)}
            </div>
          </details>
        </>
      ) : (
        <>
          {above.slice(lead.length).map(draw)}
        </>
      )}

      {error && <p className='text-destructive text-sm' role='alert'>{error}</p>}
      <div className='pt-3'>
        <Button type='submit' size='lg' disabled={status === 'sending'} aria-busy={status === 'sending'}>
          {status === 'sending' ? 'Sending…' : <>{cfg.submit} <IconArrowRight aria-hidden='true' /></>}
        </Button>
      </div>
    </form>
  );
}
