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
 * mold_v0-266: every field, its words and order, the button and the thank-you words are the form in force (./access-form.ts):
 * what staff saved in Admin › Access requests › Request form, else the build's own (the form exactly as it was).
 */
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Icons } from '@/components/icons';
import { UTM, visitSource } from './visit-source';
import { answersOf, askedFields, isShellFormKey, maxLengthOf, thanksLine, type AccessAnswer, type AccessField, type AccessFormConfig, type FormField, type ShellFormKey } from '@/lib/access-request.generated';
import { requestAccessDefaults, useLiveRequestForm } from './access-form';

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

export function RequestAccessForm({ defaults = {}, from, onSent, config, preview }: {
  defaults?: RequestAccessDefaults; from: string; onSent?: (email: string) => void;
  /** The form in force (mold_v0-266, ./access-form.ts): a saved form, null for the build's own; left out, it is asked for. */
  config?: AccessFormConfig | null;
  /** The staff editor's preview: drawn the same, never sent. */
  preview?: boolean;
}) {
  const id = useId();
  const live = useLiveRequestForm(config);
  const form = useMemo(() => live ?? requestAccessDefaults(), [live]);
  const [shell, setShellValues] = useState<Record<ShellFormKey, string>>({ email: defaults.email ?? '', name: defaults.name ?? '', company: defaults.company ?? '', message: '' });
  const setShell = (k: ShellFormKey, v: string) => setShellValues((s) => ({ ...s, [k]: v }));
  const [answers, setAnswers] = useState<Record<string, AccessAnswer>>({});
  const answer = (key: string, v: AccessAnswer) => setAnswers((a) => ({ ...a, [key]: v }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const asked = askedFields(form);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // A required choice of several has no check of the browser's own: say so here (the server checks every field again).
    const missing = asked.find((f) => f.required && f.type === 'multi_select' && !((answers[f.key] as string[] | undefined)?.length));
    if (missing) { setError(`${missing.label}: choose at least one.`); return; }
    // Every other data type's rules, the server's own (src/access-request.ts), so a bad answer is said before anything is sent.
    const checked = answersOf({ answers }, asked.filter((f) => !isShellFormKey(f.key)));
    if (checked.problem) { setError(checked.problem); return; }
    if (preview) { setError(null); setSent(shell.email.trim() || 'you@example.com'); return; }
    setBusy(true); setError(null);
    try {
      const own = Object.fromEntries(Object.entries(answers).filter(([k]) => asked.some((f) => f.key === k && !isShellFormKey(k))));
      const r = await fetch('/api/access-requests', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: shell.email.trim(), name: shell.name.trim(), company: shell.company.trim(), message: shell.message.trim(), answers: live ? own : answers, source: sourceOf(from) })
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error || (r.status === 429 ? 'Too many requests from this network. Try again in an hour.' : `The request did not go through (${r.status}). Try again.`));
      setSent(shell.email.trim());
      onSent?.(shell.email.trim());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div role='status' className='bg-card flex flex-col gap-2 rounded-xl border p-5' data-testid='request-access-sent'>
        <p className='flex items-center gap-2 font-semibold'><Icons.circleCheck aria-hidden='true' className='text-primary size-5 shrink-0' /> {form.thanks.title}</p>
        {form.thanks.lines.map((line, i) => (
          <p key={i} className='text-muted-foreground text-sm break-words'>{withEmail(thanksLine(line.replace(/\{email\}/g, '\u0000'), shell.company.trim(), ''), sent)}</p>
        ))}
      </div>
    );
  }

  /** One of the shell's own fields (its own column), drawn as the form always drew it; another kind as a question is. */
  const shellField = (f: FormField) => {
    const k = f.key as ShellFormKey;
    const fid = `${id}-${k}`;
    const lineKind = f.type === 'text' || f.type === 'email' || (f.type === 'long_text' && k === 'message');
    if (!lineKind) return <AccessFieldInput key={k} id={fid} field={f} value={shell[k]} onChange={(v) => setShell(k, String(v))} disabled={busy} />;
    const help = f.help ? <p id={`${fid}-help`} className='text-muted-foreground text-xs break-words'>{f.help}</p> : null;
    const common = {
      id: fid, name: k, required: f.required || undefined, maxLength: maxLengthOf(f), placeholder: f.placeholder, value: shell[k], disabled: busy,
      'aria-describedby': f.help ? `${fid}-help` : undefined
    };
    return (
      <div key={k} className='grid gap-1.5'>
        <Label htmlFor={fid}>{shellLabel(f)}</Label>
        {f.type === 'long_text' ? <Textarea {...common} rows={3} onChange={(e) => setShell(k, e.target.value)} />
          : <Input {...common} {...(f.type === 'email' ? { type: 'email' } : {})} autoComplete={AUTOCOMPLETE[k]} onChange={(e) => setShell(k, e.target.value)} className='h-10' />}
        {help}
      </div>
    );
  };
  const draw = (f: FormField) => (isShellFormKey(f.key) ? shellField(f) : <AccessFieldInput key={f.key} id={`${id}-f-${f.key}`} field={f} value={answers[f.key]} onChange={(v) => answer(f.key, v)} disabled={busy} />);
  // The address and the name side by side, as the form began before mold_v0-266, while they still come first.
  const pair = asked[0]?.key === 'email' && asked[1]?.key === 'name' && asked[1].type === 'text';

  return (
    <form onSubmit={submit} className='flex flex-col gap-4' aria-describedby={error ? `${id}-error` : undefined} data-testid='request-access-form'>
      {error ? <p id={`${id}-error`} role='alert' className='text-destructive text-sm'>{error}</p> : null}
      {pair ? <div className='grid gap-4 sm:grid-cols-2'>{asked.slice(0, 2).map(draw)}</div> : null}
      {(pair ? asked.slice(2) : asked).map(draw)}
      <div>
        <Button type='submit' disabled={busy} className='h-10 px-4'>
          {busy ? <Icons.spinner aria-hidden='true' className='animate-spin' /> : <Icons.send aria-hidden='true' />} {busy ? 'Sending…' : form.submit}
        </Button>
      </div>
    </form>
  );
}

const AUTOCOMPLETE: Record<ShellFormKey, string | undefined> = { email: 'email', name: 'name', company: 'organization', message: undefined };
/** A label with "(optional)" after it unless the field is required. */
const shellLabel = (f: FormField) => (f.required ? f.label : <>{`${f.label} `}{optional}</>);
/** A thank-you line with the address in its place (\u0000), as the form showed it. */
const withEmail = (line: string, email: string) => {
  const parts = line.split('\u0000');
  return parts.length === 1 ? line : parts.flatMap((p, i) => (i ? [<span key={i} className='text-foreground font-medium break-all'>{email}</span>, p] : [p]));
};

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
      {f.type === 'select' || f.type === 'boolean' ? (
        <NativeSelect id={id} name={f.key} required={f.required} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} className='w-full'>
          <NativeSelectOption value=''>{f.placeholder ?? 'Choose one'}</NativeSelectOption>
          {(f.type === 'boolean' ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] : f.options ?? []).map((o) => <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>)}
        </NativeSelect>
      ) : f.type === 'long_text' ? (
        <Textarea id={id} name={f.key} required={f.required} maxLength={maxLengthOf(f)} rows={3} placeholder={f.placeholder} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} />
      ) : (
        <Input id={id} name={f.key} required={f.required} maxLength={maxLengthOf(f)} placeholder={f.placeholder} value={text} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-describedby={described} className='h-10'
          {...(f.type === 'email' ? { type: 'email' } : f.type === 'url' ? { type: 'text', inputMode: 'url' as const, autoComplete: 'url' } : f.type === 'number' ? { type: 'text', inputMode: 'decimal' as const } : f.type === 'date' ? { type: 'date' } : {})} />
      )}
      {help}
    </div>
  );
}
