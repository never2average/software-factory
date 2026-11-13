'use client';
// One credential in the customer's words, and its full in-page card to set, replace or clear it (mold_v0-239). Shared
// by Settings › Credentials (the workspace's own) and a record's own page (its Credentials card: the record's, then one
// group per environment). On a record's page the card takes the page's place; on Settings › Credentials (mold_v0-298)
// it opens in the list's side panel (`panel`: the same form without its own frame, title or Back), never a dialog.
// Its address keeps it (?credential=<id>&do=set|clear, and &environment=<name> for one of a record's environments), so
// Back returns.
// A value is typed into a hidden field, sent once and never shown again: owners see its last 4 characters.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryStates, parseAsString } from 'nuqs';
import { toast } from 'sonner';
import { Field } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { When, fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { who } from '@/features/settings/words';
import { envWord, stepPieces, type Credential, type CredField, type SlotState } from './model';

export async function credentialsCall<T>(method: string, body?: unknown, query = ''): Promise<T> {
  const res = await fetch(`/api/credentials${query}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return null as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

/** The open card, kept in the address: which credential, set or clear, and (on a record's page) which environment. */
export function useCredentialCard() {
  // mold_v0-260: &entry=<label>, one of a credential's several values (replaced or removed on its own).
  const [q, setQ] = useQueryStates({ credential: parseAsString, do: parseAsString, environment: parseAsString, entry: parseAsString });
  return {
    open: q.credential ? { id: q.credential, mode: (q.do === 'clear' ? 'clear' : 'set') as 'set' | 'clear', environment: q.environment ?? null, entry: q.entry ?? null } : null,
    show: (id: string, mode: 'set' | 'clear', environment: string | null = null, entry: string | null = null) => void setQ({ credential: id, do: mode, environment, entry }, { history: 'push' }),
    close: () => void setQ({ credential: null, do: null, environment: null, entry: null }, { history: 'replace' })
  };
}

/** Its status, in words: Set, Missing (in red when it is needed) or Optional; a pair half set says so. */
export function StatusText({ state }: { state: SlotState }) {
  return (
    <span data-credential-status={state.status} className={state.status === 'Missing' ? 'text-destructive font-medium' : state.status === 'Set' ? 'font-medium' : 'text-muted-foreground'}>
      {state.status}{state.partial ? ' (only part of it is set)' : ''}
    </span>
  );
}

/** How to get it: numbered steps, web addresses as links (opened in a new tab). */
export function HowToGet({ steps }: { steps: string[] }) {
  if (!steps.length) return null;
  return (
    <ol className='flex list-decimal flex-col gap-1.5 pl-5 text-sm leading-snug' data-credential-steps=''>
      {steps.map((s, i) => (
        <li key={i}>{stepPieces(s).map((p, j) => p.href
          ? <a key={j} className='break-all underline underline-offset-4' href={p.href} target='_blank' rel='noopener noreferrer nofollow'>{p.text}</a>
          : <span key={j}>{p.text}</span>)}</li>
      ))}
    </ol>
  );
}

/** The last 4 characters of each part (owners), as today: "ends in ••••abcd". */
const endsIn = (c: Credential, state: SlotState) => c.parts.map((p) => state.last4[p.name]
  ? `${c.parts.length > 1 ? `${p.label}: ` : ''}ends in ••••${state.last4[p.name]}` : null).filter(Boolean).join(' · ');

/** Everything a customer needs to know about one credential in one place, as the details card's rows. */
export function CredentialFacts({ c, state, where }: { c: Credential; state: SlotState; where?: ReactNode }) {
  const ends = endsIn(c, state);
  return (
    <dl data-credential-facts=''>
      <Field label='What it is for'>{c.purpose || '—'}</Field>
      {where && <Field label='For'>{where}</Field>}
      <Field label='Status'><StatusText state={state} /></Field>
      {c.without && <Field label='Without it'>{c.without}</Field>}
      <Field label='Set on'>{state.set_at ? <><When d={state.set_at} />{state.set_by ? ` by ${who(state.set_by)}` : ''}</> : 'Not yet'}</Field>
      <Field label='Last used'>{state.last_used_at ? <When d={state.last_used_at} /> : 'Not yet'}</Field>
      {ends && <Field label='Value'><span className='font-mono text-xs'>{ends}</span></Field>}
      {c.steps.length > 0 && <Field label='How to get it'><HowToGet steps={c.steps} /></Field>}
    </dl>
  );
}

/** A file's text (a key, a kubeconfig): pasted with its line breaks into a field that hides it, or chosen from the computer. */
function SecretFile({ id, label, value, set }: { id: string; label: string; value: string; set: (v: string) => void }) {
  const [file, setFile] = useState<string | null>(null);
  return (
    <div className='flex flex-col gap-2'>
      <Textarea id={id} className='min-h-24 font-mono text-xs [-webkit-text-security:disc]' rows={4} autoComplete='off' spellCheck={false}
        placeholder='Paste the file, or choose it below' value={value} onChange={(e) => { setFile(null); set(e.target.value); }} aria-label={label} data-secret-input='' />
      <div className='flex flex-wrap items-center gap-2 text-sm'>
        <Input type='file' className='w-full max-w-72' aria-label={`Choose the ${label} file`}
          onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; void f.text().then((t) => { set(t); setFile(f.name); }); e.target.value = ''; }} />
        {file && <span className='text-muted-foreground'>{file} read ({value.length.toLocaleString('en')} characters)</span>}
      </div>
    </div>
  );
}

/** What the card does, in one word (its title's and its button's): Set, Replace, Clear; with several values Add, Replace, Remove. */
export function credentialVerb(c: Credential, state: SlotState | null, mode: 'set' | 'clear', entry: string | null = null) {
  const set = c.entries ? !!entry : state?.status === 'Set' || !!state?.partial;
  return c.entries ? (mode === 'clear' ? 'Remove' : entry ? 'Replace' : 'Add') : mode === 'clear' ? 'Clear' : set ? 'Replace' : 'Set';
}

/** The card's title: the verb and the credential (or the one of its several values). */
export function credentialCardTitle(c: Credential, state: SlotState | null, mode: 'set' | 'clear', entry: string | null = null) {
  const verb = credentialVerb(c, state, mode, entry);
  return `${verb} ${c.entries ? (entry ? `${entry} (${c.label})` : `a ${c.entries.label.toLowerCase()} to ${c.label}`) : c.label}`;
}

/**
 * Set, replace or clear one credential: a full card in the page's place (`panel`: the form alone, for a side panel that
 * shows the title and closes itself; mold_v0-298). `environments` (a record's environments, for
 * one set per environment) is picked from, never typed. `back` names where Back returns ("the list", the record).
 */
export function CredentialCard({ c, state, mode, back, forWhat, noun = 'record', asset, environment, environments, onEnvironment, onClose, onDone, entry = null, panel = false }: {
  c: Credential; state: SlotState | null; mode: 'set' | 'clear'; back: string; forWhat: string; noun?: string;
  /** mold_v0-298: inside a side panel (its title and close are the panel's): no frame, no title, no Back. */
  panel?: boolean;
  /** mold_v0-260: one of a credential's labelled values (replace or remove it); null with entries: add one. */
  entry?: string | null;
  asset: string | null; environment: string | null; environments: string[] | null; onEnvironment?: (e: string) => void;
  onClose: () => void; onDone: () => unknown;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [label, setLabel] = useState(entry ?? '');
  const entryWord = c.entries?.label.toLowerCase() ?? '';
  const [busy, setBusy] = useState(false);
  const title = useRef<HTMLDivElement>(null);
  // mold_v0-298: in a side panel (no title of its own) focus goes to the form's first field, or the form itself to clear.
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!panel) { title.current?.focus(); return; }
    const first = form.current?.querySelector<HTMLElement>('input:not([readonly]):not([type=hidden]), select, textarea');
    (first ?? form.current)?.focus();
  }, [panel]);
  const set = c.entries ? !!entry : state?.status === 'Set' || !!state?.partial;
  const verb = credentialVerb(c, state, mode, entry);
  const needsEnv = c.place === 'record-environment';
  const slot = { pack: c.pack, ...(c.place !== 'settings' ? { asset } : {}), ...(needsEnv ? { environment } : {}) };
  const missing = c.parts.filter((p) => !values[p.name]);
  const submit = async () => {
    if (needsEnv && !environment) return toast.error('Pick the environment first');
    setBusy(true);
    try {
      if (mode === 'clear') {
        await credentialsCall('DELETE', c.group ? { ...slot, group: c.group } : { ...slot, name: c.parts[0]!.name, ...(c.entries && entry ? { entry } : {}) });
        toast.success(c.entries && entry ? `${entry} removed from ${c.label}` : `${c.label} cleared`);
      } else {
        if (missing.length) { toast.error(`${missing[0]!.label} is empty`); return; }
        if (c.entries) {
          // mold_v0-260: one labelled value: its label (typed when it is added) and its value.
          if (!label.trim()) { toast.error(`The ${entryWord} is empty`); return; }
          await credentialsCall('PUT', { ...slot, name: c.parts[0]!.name, entry: label.trim(), value: values[c.parts[0]!.name] });
          toast.success(`${label.trim()} ${entry ? 'replaced' : 'added'}`);
        } else if (c.group) await credentialsCall('PUT', { ...slot, group: c.group, values });
        else await credentialsCall('PUT', { ...slot, name: c.parts[0]!.name, value: values[c.parts[0]!.name] });
        toast.success(`${c.label} ${set ? 'replaced' : 'set'}`);
      }
      // The values leave memory with the card: nothing typed is kept or shown again.
      setValues({});
      await onDone();
      onClose();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const input = (p: CredField) => {
    const id = `credential-${p.pack}-${p.name}`;
    const v = values[p.name] ?? '';
    const put = (x: string) => setValues((o) => ({ ...o, [p.name]: x }));
    return (
      <div key={p.name} className='flex flex-col gap-1.5'>
        <Label htmlFor={id}>{c.entries ? 'Value' : c.parts.length > 1 || !c.file(p) ? p.label : `${p.label} (the whole file)`}</Label>
        {c.file(p) ? <SecretFile id={id} label={p.label} value={v} set={put} />
          : <Input id={id} className='w-full max-w-md font-mono' type='password' autoComplete='new-password' spellCheck={false} placeholder='Paste it here'
              value={v} onChange={(e) => put(e.target.value)} data-secret-input='' />}
      </div>
    );
  };
  const body = (
    <>
      {c.purpose && <section className='flex flex-col gap-1'><h3 className='text-sm font-medium'>What it is for</h3><p className='text-sm'>{c.purpose}</p></section>}
      {mode === 'set' && c.steps.length > 0 && <section className='flex flex-col gap-2'><h3 className='text-sm font-medium'>How to get it</h3><HowToGet steps={c.steps} /></section>}
      {c.without && <section className='flex flex-col gap-1'><h3 className='text-sm font-medium'>Without it</h3><p className='text-sm'>{c.without}</p></section>}
      {needsEnv && (
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor='credential-environment'>Environment</Label>
          {environments?.length ? (
            <NativeSelect id='credential-environment' className='w-full max-w-xs' value={environment ?? ''} onChange={(e) => onEnvironment?.(e.target.value)} disabled={mode === 'clear'}>
              {!environment && <NativeSelectOption value=''>Pick one</NativeSelectOption>}
              {environments.map((x) => <NativeSelectOption key={x} value={x}>{envWord(x)}</NativeSelectOption>)}
            </NativeSelect>
          ) : <p className='text-sm'>This {noun} lists no environments yet: they appear here once it does.</p>}
        </div>
      )}
      {state && !c.entries && (state.status === 'Set' || state.partial) && (
        <p className='text-sm' data-credential-now=''>Now: {endsIn(c, state) || 'set'}, set <When d={state.set_at} />{state.last_used_at ? <>, last used <When d={state.last_used_at} /></> : ', not used yet'}.</p>
      )}
      {mode === 'set' ? (
        <div className='flex flex-col gap-4' data-credential-inputs={c.parts.length}>
          {c.entries && (
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='credential-entry'>{c.entries.label}</Label>
              <Input id='credential-entry' className='w-full max-w-md' value={label} onChange={(e) => setLabel(e.target.value)} readOnly={!!entry}
                autoComplete='off' spellCheck={false} placeholder={`The ${entryWord} this value is for`} data-credential-entry='' />
            </div>
          )}
          {c.parts.map(input)}
          <p className='text-muted-foreground text-xs'>Hidden as you type, sent once and never shown again{c.parts.length > 1 ? `: both are ${set ? 'replaced' : 'set'} together` : ''}.</p>
        </div>
      ) : c.entries && entry ? <p className='text-sm'>Removing it deletes the value for {entry} at once: the runs receive the others only.</p>
        : <p className='text-sm'>Clearing it removes the stored value{c.parts.length > 1 ? 's' : ''} at once: nothing receives {c.parts.length > 1 ? 'them' : 'it'} from then on.</p>}
    </>
  );
  const buttons = (
    <>
      <Button type='submit' variant={mode === 'clear' ? 'destructive' : 'default'} disabled={busy || (mode === 'set' && missing.length > 0) || (needsEnv && !environment)}>{verb}</Button>
      <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
    </>
  );
  const keys = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
  // mold_v0-298: in Settings › Credentials' side panel, the form alone (the panel has its title and its close).
  if (panel) return (
    <form ref={form} tabIndex={-1} className='flex min-w-0 flex-col gap-5 outline-none' data-credential-card={mode} data-credential-panel='' onSubmit={(e) => { e.preventDefault(); void submit(); }} onKeyDown={keys}>
      <p className='text-muted-foreground text-sm'>{forWhat}{needsEnv && environment ? ` · ${envWord(environment)}` : ''}</p>
      {body}
      <div className='flex flex-wrap gap-2'>{buttons}</div>
    </form>
  );
  return (
    <Card className='w-full max-w-4xl gap-0 py-0' data-action-card='' data-credential-card={mode}>
      <form className='flex flex-col' onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onKeyDown={keys}>
        <CardHeader className='border-b py-4 [.border-b]:pb-4'>
          <CardDescription>
            <Button variant='outline' size='sm' onClick={onClose}>
              <Icons.chevronLeft className='size-3.5' />Back to {back}
            </Button>
          </CardDescription>
          <CardTitle ref={title} tabIndex={-1} className='text-lg leading-snug break-words outline-none'>{credentialCardTitle(c, state, mode, entry)}</CardTitle>
          <p className='text-muted-foreground text-sm'>{forWhat}{needsEnv && environment ? ` · ${envWord(environment)}` : ''}</p>
        </CardHeader>
        <CardContent className='flex flex-col gap-5 py-4'>
          {body}
        </CardContent>
        <CardFooter data-card-footer='' className='gap-2 border-t py-4 [.border-t]:pt-4'>
          {buttons}
        </CardFooter>
      </form>
    </Card>
  );
}
