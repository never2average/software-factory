'use client';
// A service connected where you find it (mold_v0-344; pack.json `tabs[].connect`, src/pack-api.ts TabConnectSchema,
// src/tab-connect.ts): a catalog tab lists each service once, with this workspace's state for it; a service's panel holds
// the Connect form right there (the key, usually alone; the rest under More options) and, once connected, each account
// with its own actions. Every write is the connection area's own: the data API's create (POST /api/data/<area>) and its
// record page's actions (test, edit, delete, toggles: POST /api/records/_page/<area>/<key>/actions/<id>), with their
// permissions, contract, guards, rate limits and audit; a key typed here goes to the server once and is never shown again.
//   ConnectCards     the list's three cards: Connected, Needs attention, Services
//   ConnectSection   a service's panel, above its catalog page: its accounts, then Connect (or who may connect it), and
//                    once connected the receiver it feeds (mold_v0-347, connect-receiver.tsx)
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Icons } from '@/components/icons';
import { StatStrip } from '@/components/layout/section';
import type { PackTabSpec, RecordFieldSpec } from '@/config/pack-nav.generated';
import { ConfirmDialog } from '@/features/admin/ui';
import { useOrgLoad, When } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ToneBadge } from '@/features/records/detail-page';
import { optionWords, type BadgeColor, type PageAction } from '@/features/records/detail-layout';
import { takeAction } from '@/features/records/page-actions';
import { findRecordArea } from '@/features/records/registry';
import { FieldsForm, fieldValues, type FormField } from './tab-action';
import { keyFromTitle } from './form-prefill';
import { CONNECT_FLAG, CONNECT_STATE, CONNECT_STATE_OPTIONS, CONNECT_TESTED } from './merged';
import { ReceiverSection } from './connect-receiver';

type Health = { state?: string | null; attention?: boolean; tested_at?: string };
export type ConnectionView = { key: string; title: string | null; data: Record<string, unknown>; updated_at: string; health?: Health };
/** A catalog row's own part (src/tab-connect.ts ConnectRow): whether it may be connected here, and its connections. */
export type RowConnect = { connectable: boolean; connections: ConnectionView[] } | { hidden: true };
/** What the Connect form needs, as the server says this person may use it (src/tab-connect.ts connectSpec). */
export interface ConnectSpec {
  allowed: boolean; readable: boolean;
  area: { name: string; label: string; key_from_title: boolean };
  fields: FormField[]; ask: string[]; more: string[];
  flag: { name: string; label: string } | null;
  health: { status: string | null; tested_at: string | null; result: string | null; expires_on: string | null } | null;
  who: string;
}
type ConnectTab = Pick<PackTabSpec, 'pack' | 'id' | 'connect'>;
type Service = NonNullable<NonNullable<PackTabSpec['connect']>['services']>[string];
type Row = { key: string; title: string | null; data: Record<string, unknown>; areas?: string[]; connect?: RowConnect };

const STATE_COLOR: Record<string, BadgeColor> = { connected: 'success', needs_attention: 'danger', not_tested: 'warning', not_connected: 'neutral', unavailable: 'neutral' };
const stateLabel = (s: unknown) => CONNECT_STATE_OPTIONS.find((o) => o.value === s)?.label ?? 'Not connected';
/** A state as the table and the panel draw it: its word, in its colour. */
export function StateBadge({ state }: { state: unknown }) {
  const s = typeof state === 'string' ? state : 'not_connected';
  return <span data-connect-state={s}><ToneBadge color={STATE_COLOR[s] ?? 'neutral'}>{stateLabel(s)}</ToneBadge></span>;
}
/** Whether a column is one of a connect tab's own (its cell is drawn here). */
export const isConnectColumn = (name: string) => name === CONNECT_STATE;

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

/** The Connect form's spec for a tab (null while loading, or when the server answers none). */
export function useConnectSpec(tab: ConnectTab | null) {
  const url = tab?.connect ? `/api/records/tabs/${encodeURIComponent(tab.pack)}/${encodeURIComponent(tab.id)}/connect` : null;
  return useOrgLoad(() => (url ? send<ConnectSpec>('GET', url).catch(() => null) : Promise.resolve(null)), [url]);
}

/** The list's three cards: the services connected, those needing attention, and how many services the list has. */
export function ConnectCards({ rows }: { rows: Row[] | null }) {
  const services = rows?.filter((r) => !r.areas?.length) ?? null;
  const count = (s: string) => (services ? services.filter((r) => r.data[CONNECT_STATE] === s).length : null);
  const n = (v: number | null) => (v === null ? <span className='bg-muted inline-block h-7 w-10 animate-pulse rounded-md align-bottom' /> : v.toLocaleString('en'));
  const items = [
    { label: 'Connected', value: n(count('connected')), said: `${count('connected') ?? 0} connected` },
    { label: 'Needs attention', value: n(count('needs_attention')), said: `${count('needs_attention') ?? 0} need attention` },
    { label: 'Services', value: n(services ? services.length : null), said: `${services?.length ?? 0} services` }
  ];
  return <section aria-label='This workspace’s connections' data-connect-cards='' className='max-sm:overflow-x-auto'><StatStrip quad strip items={items} /></section>;
}

/** The service entry for a catalog row (its own, else "*"). */
const serviceOf = (tab: ConnectTab, key: string): Service | null => tab.connect?.services?.[key] ?? tab.connect?.services?.['*'] ?? null;
/** A stored value as a form's input holds it (fieldValues types it back); a sealed one stays the mask (kept unless replaced). */
const asInput = (v: unknown) => (v == null ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
/** A field's value in an account's facts: an option's words, Yes / No, a date, the mask's words. */
function factValue(f: FormField | RecordFieldSpec | undefined, v: unknown): ReactNode {
  if (v == null || v === '') return null;
  if ((f as { secret?: boolean } | undefined)?.secret || (f as { encrypted?: boolean } | undefined)?.encrypted || v === '[encrypted]') return 'Saved and hidden';
  if (f?.type === 'enum') return optionWords(f as RecordFieldSpec, v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (f?.type === 'date' && typeof v === 'string') return <When d={v} />;
  return Array.isArray(v) ? v.join(', ') : String(v);
}

type Said = { tone: 'good' | 'bad' | 'neutral'; words: string };
/** Run a connection's test (its page's test action), and say what it found: never a key, the provider's own words. */
async function testAndSay(area: string, key: string): Promise<Said> {
  const page = await send<{ actions?: PageAction[] }>('GET', `/api/records/_page/${encodeURIComponent(area)}/${encodeURIComponent(key)}`);
  const test = (page.actions ?? []).find((a) => a.kind === 'test_connection' || a.kind === 'test_storage');
  if (!test) return { tone: 'neutral', words: 'Saved. There is no automatic test for it here.' };
  if (test.disabled) return { tone: 'neutral', words: `Saved. ${test.disabled.replace(/\.?$/, '.')}` };
  const r = await takeAction<{ ok: boolean; words: string }>(area, key, test.id);
  return { tone: r.ok ? 'good' : 'bad', words: r.words };
}
const SaidLine = ({ said }: { said: Said | null }) => !said ? null : (
  <p role='status' data-connect-said={said.tone} className={said.tone === 'good' ? 'text-sm text-emerald-700 dark:text-emerald-400' : said.tone === 'bad' ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
    {said.tone === 'good' ? <Icons.circleCheck className='mr-1 inline size-4 align-text-bottom' aria-hidden /> : said.tone === 'bad' ? <Icons.alertCircle className='mr-1 inline size-4 align-text-bottom' aria-hidden /> : null}
    {said.words}
  </p>
);
const errorWords = (e: unknown) => (e as Error)?.message || String(e);

/**
 * A service's panel above its catalog page: this workspace's accounts for it (each with its actions), then Connect for the
 * people who may (a form right there), or one line saying who may. `flagTaken`: another service of the tab already has the
 * flag on (the first connection turns it on, and only then).
 */
export function ConnectSection({ tab, row, spec, onChanged, flagTaken }: { tab: ConnectTab; row: Row; spec: ConnectSpec | null; onChanged: () => void; flagTaken: boolean }) {
  const c = row.connect;
  const [adding, setAdding] = useState(false);
  const [said, setSaid] = useState<{ key: string | null; said: Said } | null>(null);
  // A test that failed right after Connect: the form stays, filled, for that account (its key sealed: type a new one).
  const [retry, setRetry] = useState<string | null>(null);
  useEffect(() => { setAdding(false); setSaid(null); setRetry(null); }, [row.key]);
  if (!c) return null;
  if ('hidden' in c) return <p className='text-muted-foreground text-sm' data-connect-section='hidden'>Your role can’t see this workspace’s connections.</p>;
  const accounts = c.connections;
  const state = row.data[CONNECT_STATE];
  const service = serviceOf(tab, row.key);
  const formOpen = !!spec?.allowed && c.connectable && (adding || !accounts.length || retry !== null);
  return (
    <section className='flex flex-col gap-4 border-b pb-5' data-connect-section={row.key} aria-label={`${row.title || row.key}: this workspace’s connection`}>
      <div className='flex flex-wrap items-center gap-2'>
        <h3 className='text-[13.5px] font-medium'>{accounts.length > 1 ? 'Your accounts' : 'Your account'}</h3>
        <StateBadge state={state} />
      </div>
      {accounts.map((a) => (
        <Account key={a.key} tab={tab} spec={spec} conn={a} said={said?.key === a.key ? said.said : null}
          onSaid={(s) => setSaid({ key: a.key, said: s })} onChanged={onChanged} />
      ))}
      {!c.connectable ? (
        <p className='text-muted-foreground text-sm' data-connect-none=''>No account to connect for this one: it is not a hosted service with a key of its own.</p>
      ) : !spec ? null : !spec.allowed ? (
        <p className='text-muted-foreground text-sm' data-connect-who=''>{accounts.length ? '' : 'Not connected. '}{spec.who}</p>
      ) : formOpen ? (
        <ConnectForm tab={tab} row={row} spec={spec} service={service} retry={retry ? accounts.find((a) => a.key === retry) ?? null : null}
          flagOn={!!spec.flag && !flagTaken && !accounts.length} said={said?.key === null ? said.said : null}
          onSaid={(key, s) => { setSaid({ key, said: s }); if (s.tone === 'bad' && key) setRetry(key); else { setRetry(null); setAdding(false); } onChanged(); }}
          onCancel={accounts.length ? () => { setAdding(false); setRetry(null); } : undefined} />
      ) : (
        <div><Button type='button' variant='outline' size='sm' onClick={() => setAdding(true)} data-connect-another=''><Icons.add aria-hidden data-icon='inline-start' />Connect another account</Button></div>
      )}
      {/* mold_v0-347: the receiver this service feeds (its request logs, say), set up here once an account is connected. */}
      {accounts.length > 0 && service?.receiver && <ReceiverSection receiver={service.receiver} />}
    </section>
  );
}

/** One account: its facts (IDs, region, the flag, health, last tested, what the last test said, when its key expires) and its actions. */
function Account({ tab, spec, conn, said, onSaid, onChanged }: { tab: ConnectTab; spec: ConnectSpec | null; conn: ConnectionView; said: Said | null; onSaid: (s: Said) => void; onChanged: () => void }) {
  const area = tab.connect!.area;
  const spec_area = findRecordArea('app', area);
  const url = `/api/records/_page/${encodeURIComponent(area)}/${encodeURIComponent(conn.key)}`;
  const page = useOrgLoad(() => send<{ actions?: PageAction[] }>('GET', url).catch(() => ({ actions: [] as PageAction[] })), [url, conn.updated_at]);
  const actions = page.data?.actions ?? [];
  const [mode, setMode] = useState<'edit' | 'replace' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PageAction | null>(null);
  const field = (n: string | null | undefined) => (n ? spec?.fields.find((f) => f.name === n) ?? spec_area?.fields.find((f) => f.name === n) : undefined);
  const h = spec?.health;
  // Not repeated as facts: the service itself, the fields it fills (its provider), the flag and the health fields (said below).
  const set = tab.connect!.services?.[String(conn.data[tab.connect!.via] ?? '')]?.set ?? {};
  const fixed = new Set([tab.connect!.via, ...Object.keys(set), ...(spec?.flag ? [spec.flag.name] : []), ...Object.values(h ?? {}).filter((x): x is string => !!x)]);
  // The account's own facts: the form's fields with a value (a key as "Saved and hidden"), then its health.
  const facts: [string, ReactNode][] = [];
  for (const f of spec?.fields ?? []) if (!fixed.has(f.name)) { const v = factValue(f, conn.data[f.name]); if (v !== null) facts.push([f.label, v]); }
  if (spec?.flag) facts.push([spec.flag.label, conn.data[spec.flag.name] === true ? 'Yes' : 'No']);
  if (h?.status) facts.push(['Health', factValue(field(h.status), conn.data[h.status]) ?? 'Not tested']);
  if (conn.health?.tested_at) facts.push(['Last tested', <When key='t' d={conn.health.tested_at} />]);
  if (h?.result && conn.data[h.result] && !said) facts.push(['Last test said', String(conn.data[h.result])]);
  if (h?.expires_on && conn.data[h.expires_on]) facts.push(['Key expires on', factValue(field(h.expires_on), conn.data[h.expires_on])]);
  const test = actions.find((a) => a.kind === 'test_connection' || a.kind === 'test_storage');
  const edit = actions.find((a) => a.kind === 'edit');
  const del = actions.find((a) => a.kind === 'delete');
  const toggles = actions.filter((a) => a.kind === 'toggle');
  const sealed = (edit?.fields ?? []).filter((f) => f.secret);
  const run = async (id: string, fn: () => Promise<void>) => { setBusy(id); try { await fn(); } catch (e) { onSaid({ tone: 'bad', words: errorWords(e) }); } finally { setBusy(null); } };
  return (
    <div className='flex flex-col gap-3 rounded-md border p-3' data-connect-account={conn.key}>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-sm font-medium'>{conn.title || conn.key}</span>
        {conn.health?.attention ? <ToneBadge color='danger'>Needs attention</ToneBadge> : null}
      </div>
      {facts.length > 0 && (
        <dl className='grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm'>
          {facts.map(([k, v]) => <div key={k} className='contents'><dt className='text-muted-foreground'>{k}</dt><dd className='min-w-0 break-words'>{v}</dd></div>)}
        </dl>
      )}
      <SaidLine said={said} />
      {mode && edit ? (
        <EditForm fields={mode === 'replace' ? sealed : edit.fields ?? []} conn={conn} all={edit.fields ?? []} replace={mode === 'replace'}
          onCancel={() => setMode(null)}
          onSave={(body) => run('edit', async () => {
            await takeAction(area, conn.key, edit.id, body);
            setMode(null);
            onSaid(await testAndSay(area, conn.key));
            onChanged();
          })} busy={busy === 'edit'} />
      ) : (
        <div className='flex flex-wrap items-center gap-2' data-connect-actions=''>
          {test && <Button type='button' size='sm' variant='outline' disabled={!!test.disabled || !!busy} title={test.disabled ?? undefined}
            onClick={() => void run('test', async () => { onSaid(await testAndSay(area, conn.key)); onChanged(); })}>
            <Icons.circleCheck aria-hidden data-icon='inline-start' />{busy === 'test' ? 'Testing…' : test.label}</Button>}
          {edit && sealed.length > 0 && <Button type='button' size='sm' variant='outline' disabled={!!edit.disabled || !!busy} onClick={() => setMode('replace')} data-connect-replace=''>
            <Icons.lock aria-hidden data-icon='inline-start' />Replace key</Button>}
          {edit && <Button type='button' size='sm' variant='outline' disabled={!!edit.disabled || !!busy} onClick={() => setMode('edit')}>
            <Icons.edit aria-hidden data-icon='inline-start' />{edit.label}</Button>}
          {del && <Button type='button' size='sm' variant='outline' className='text-destructive' disabled={!!del.disabled || !!busy} onClick={() => setConfirm(del)} data-connect-disconnect=''>
            <Icons.trash aria-hidden data-icon='inline-start' />Disconnect</Button>}
          {toggles.map((t) => (
            <label key={t.id} className='flex items-center gap-2 text-sm' title={t.disabled ?? undefined}>
              <Checkbox checked={!!t.on} disabled={!!t.disabled || !!busy}
                onCheckedChange={(on) => void run(t.id, async () => { await takeAction(area, conn.key, t.id, { on: !!on }); onChanged(); })} />{t.label}
            </label>
          ))}
        </div>
      )}
      {confirm && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirm(null); }} destructive title={`Disconnect ${conn.title || conn.key}?`}
          description={confirm.confirm ?? ''} confirmLabel='Disconnect'
          onConfirm={() => void run('delete', async () => { await takeAction(area, conn.key, confirm.id); onChanged(); })} />
      )}
    </div>
  );
}

/** An account's edit (every field the edit offers) or its Replace key (the sealed ones alone): saved, then tested again. */
function EditForm({ fields, all, conn, replace, busy, onSave, onCancel }: { fields: FormField[]; all: FormField[]; conn: ConnectionView; replace: boolean; busy: boolean;
  onSave: (body: { title: string | null; data: Record<string, unknown> }) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((f) => [f.name, f.secret ? (replace ? '' : '[encrypted]') : asInput(conn.data[f.name])])));
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    const { values: typed, problem: p } = fieldValues(fields.map((f) => (replace ? { ...f, required: true } : f)), values);
    if (p) return void setProblem(p);
    // The edit replaces the fields it offers: the ones this form leaves out are sent as stored (a sealed one as its mask: kept).
    const stored = fieldValues(all.filter((f) => !fields.some((x) => x.name === f.name)), Object.fromEntries(all.map((f) => [f.name, f.secret ? '[encrypted]' : asInput(conn.data[f.name])]))).values;
    onSave({ title: conn.title, data: { ...stored, ...typed } });
  };
  return (
    <form className='flex flex-col gap-3' onSubmit={(e) => { e.preventDefault(); submit(); }} data-connect-edit={replace ? 'replace' : 'edit'}>
      <FieldsForm fields={fields} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix={`connect-edit-${conn.key}`} />
      {problem && <p role='alert' className='text-destructive text-sm'>{problem}</p>}
      <div className='flex flex-wrap gap-2'>
        <Button type='submit' size='sm' disabled={busy}>{busy ? 'Saving…' : 'Save & test'}</Button>
        <Button type='button' size='sm' variant='outline' onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/**
 * The Connect form: the fields this provider truly needs (the area's required ones and the tab's `fields`, less what the
 * service fills), its Get a key link, More options (the name and the rest), and one button: Connect & test. On a failed
 * test the form stays filled for that account (its key sealed: a new one replaces it) with the provider's own words.
 */
function ConnectForm({ tab, row, spec, service, retry, flagOn, said, onSaid, onCancel }: { tab: ConnectTab; row: Row; spec: ConnectSpec; service: Service | null;
  retry: ConnectionView | null; flagOn: boolean; said: Said | null; onSaid: (key: string | null, s: Said) => void; onCancel?: () => void }) {
  const c = tab.connect!;
  const set = service?.set ?? {};
  const shown = (n: string) => !(n in set);
  const hint = (f: FormField): FormField => (service?.hints?.[f.name] ? { ...f, help: service.hints[f.name]! } : f);
  const ask = spec.ask.filter(shown).map((n) => spec.fields.find((f) => f.name === n)!).filter(Boolean).map(hint);
  const more = spec.more.filter(shown).map((n) => spec.fields.find((f) => f.name === n)!).filter(Boolean).map(hint);
  const base = row.title || row.key;
  const others = row.connect && !('hidden' in row.connect) ? row.connect.connections.length : 0;
  const [title, setTitle] = useState(retry?.title ?? (others ? `${base} ${others + 1}` : base));
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (retry) return Object.fromEntries([...ask, ...more].map((f) => [f.name, f.secret ? '[encrypted]' : asInput(retry.data[f.name])]));
    return Object.fromEntries(Object.entries(service?.defaults ?? {}).map(([k, v]) => [k, asInput(v)]));
  });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { if (retry) setValues((s) => ({ ...s, ...Object.fromEntries([...ask, ...more].filter((f) => f.secret).map((f) => [f.name, '[encrypted]'])) })); }, [retry?.key, retry?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => [...ask, ...more], [ask, more]);
  const submit = async () => {
    setProblem(null);
    const { values: typed, problem: p } = fieldValues(all, values);
    if (p) return void setProblem(p);
    const data: Record<string, unknown> = { ...typed, ...set, [c.via]: row.key };
    setBusy(true);
    try {
      if (retry) {
        // The account saved a moment ago: its edit (a sealed key left as it is is kept), then its test again.
        const page = await send<{ actions?: PageAction[] }>('GET', `/api/records/_page/${encodeURIComponent(c.area)}/${encodeURIComponent(retry.key)}`);
        const edit = (page.actions ?? []).find((a) => a.kind === 'edit');
        if (!edit) throw new Error('Your role can’t change this account.');
        const keep = Object.fromEntries((edit.fields ?? []).filter((f) => !(f.name in data)).map((f) => [f.name, f.secret ? '[encrypted]' : retry.data[f.name] ?? null]));
        await takeAction(c.area, retry.key, edit.id, { title: title.trim() || retry.title, data: { ...keep, ...data } });
        onSaid(retry.key, await testAndSay(c.area, retry.key));
        return;
      }
      // The first connection of the tab turns on the flag builds read (a refusal of it, only one may be on: saved without).
      let key = keyFromTitle(title) || keyFromTitle(base) || 'connection';
      let withFlag = flagOn && !!spec.flag;
      for (let i = 2; ; i++) {
        try {
          await send('POST', `/api/data/${encodeURIComponent(c.area)}`, { key, title: title.trim() || base, data: { ...data, ...(withFlag ? { [spec.flag!.name]: true } : {}) } });
          break;
        } catch (e) {
          const status = (e as { status?: number }).status, words = errorWords(e);
          if (status === 409 && withFlag && spec.flag && words.includes(spec.flag.label)) { withFlag = false; continue; }
          if (status === 409 && i <= 6) { key = `${keyFromTitle(title) || keyFromTitle(base) || 'connection'}-${i}`; continue; }
          throw e;
        }
      }
      onSaid(key, await testAndSay(c.area, key));
    } catch (e) { setProblem(errorWords(e)); } finally { setBusy(false); }
  };
  const get = service?.get_key;
  return (
    <form className='flex flex-col gap-3' data-connect-form={row.key} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h4 className='text-[13.5px] font-medium'>{retry ? `Fix ${retry.title || retry.key}` : others ? 'Connect another account' : `Connect ${base}`}</h4>
      {get && (
        <p className='text-sm' data-connect-get-key=''>
          <a href={get.href} target='_blank' rel='noopener noreferrer' className='text-primary inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline'>
            {get.label ?? 'Get a key'}<Icons.externalLink className='size-3.5' aria-hidden />
          </a>
          {get.scopes && <span className='text-muted-foreground'> · {get.scopes}</span>}
        </p>
      )}
      <FieldsForm fields={ask} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix={`connect-${row.key}`} />
      <details className='text-sm' data-connect-more=''>
        <summary className='text-muted-foreground cursor-pointer'>More options</summary>
        <div className='mt-3 flex flex-col gap-3'>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor={`connect-${row.key}-title`}>Name</Label>
            <Input id={`connect-${row.key}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
            <p className='text-muted-foreground text-xs'>What this account is called here.</p>
          </div>
          <FieldsForm fields={more} values={values} set={(n, v) => setValues((s) => ({ ...s, [n]: v }))} idPrefix={`connect-${row.key}-more`} />
        </div>
      </details>
      {flagOn && spec.flag && <p className='text-muted-foreground text-xs' data-connect-flag=''>Your first account: {spec.flag.label} turns on with it.</p>}
      {problem && <p role='alert' className='text-destructive text-sm' data-connect-problem=''>{problem}</p>}
      <SaidLine said={said} />
      <div className='flex flex-wrap gap-2'>
        <Button type='submit' disabled={busy} data-connect-submit=''>{busy ? 'Connecting…' : retry ? 'Save & test' : 'Connect & test'}</Button>
        {onCancel && <Button type='button' variant='outline' onClick={onCancel}>Cancel</Button>}
      </div>
      <p className='text-muted-foreground text-xs'>The key is sent to the server once, kept sealed and never shown again.</p>
    </form>
  );
}

export { CONNECT_FLAG, CONNECT_TESTED };
