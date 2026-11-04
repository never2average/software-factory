'use client';
// Settings › Email (mold_v0-192, mold_v0-218; src/email-routes.ts at /api/email): the workspace's own email, for its
// owners, as one full-page table in the standard list layout: four cards, the search row (its primary action Add mailbox,
// and Set sender until one is set), then the table. A row is the company's sender or one of the mailboxes the intake
// reads; opening one shows its full details card (status, the form, On, Test, Remove or Disconnect).
//   Sender    one per workspace (SMTP, Microsoft 365, Google Workspace): the app's emails to this workspace's people go
//             out through it while it is on; otherwise through the app's own sender.
//   Mailboxes the mailboxes the intake reads (IMAP, Microsoft 365, Google Workspace), each limited to the folder or label
//             the app declares, read only; every new message becomes a record.
// A secret (a password, a client secret, a key file) is typed once, sent once and never shown again, not even in part:
// the card says only that it is set, when and by whom, and offers Replace. Each has a Test button in its card.
import { useState } from 'react';
import { toast } from 'sonner';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ErrorState, FormRow, LoadingCards, When, fail, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ActionCard, CardForm, ToolbarAction } from '@/features/tabs/tab-action';
import { Icons } from '@/components/icons';

type Provider = 'smtp' | 'graph' | 'gmail';
type Settings = Record<string, string | number | string[] | null>;
interface Status {
  provider: Provider; provider_label: string; settings: Settings; enabled: boolean; secret_set: boolean; secret_set_at: string | null; secret_set_by: string | null;
  status: 'untested' | 'connected' | 'error' | 'paused'; last_error: string | null; hint: string | null;
}
interface Sender extends Status { last_tested_at: string | null; last_sent_at: string | null; sent: number; failed: number }
interface Inbox extends Status { id: string; pack: string; label: string; intake: { label: string | null; area: string; folder: string } | null; last_poll_at: string | null; poll_minutes: number; received: number }
interface View {
  offer: { sender: boolean; intakes: { pack: string; area: string; label: string | null; folder: string }[]; providers: { id: Provider; label: string }[] };
  can_manage: boolean; sender?: Sender | null; effective?: 'workspace' | 'app'; inboxes?: Inbox[];
}
interface TestResult { ok: boolean; error: string | null; hint: string | null; messages?: number | null; sent?: boolean; folder?: string }

async function call<T>(method: string, path = '', body?: unknown): Promise<T> {
  const res = await fetch(`/api/email${path}`, {
    method, credentials: 'same-origin',
    headers: { accept: 'application/json', ...(body !== undefined || method !== 'GET' ? { 'content-type': 'application/json', 'x-pack-request': '1' } : {}) },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body)
  });
  if (res.status === 204) return null as T;
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw httpError(res.status, json);
  return json;
}

const STATUS: Record<Status['status'], string> = { connected: 'Connected', untested: 'Not tested yet', error: 'Error', paused: 'Paused' };
const StatusText = ({ s }: { s: Status['status'] }) => <span className={s === 'error' ? 'text-destructive' : undefined}>{STATUS[s]}</span>;

/** One row of the table: the company's sender or one of its mailboxes. */
interface Row {
  key: string; kind: 'sender' | 'mailbox'; name: string; provider: string; address: string; folder: string; status: Status['status'];
  last_checked: string | null; messages: number | null; last_error: string | null; sender?: Sender; inbox?: Inbox;
}
function rowsOf(v: View): Row[] {
  const rows: Row[] = [];
  const s = v.sender;
  if (s) rows.push({ key: 'sender', kind: 'sender', name: 'Sender', provider: s.provider === 'smtp' ? 'SMTP' : s.provider_label, address: String(s.settings.from_address ?? ''),
    folder: '', status: s.status, last_checked: s.last_tested_at ?? s.last_sent_at, messages: null, last_error: s.status === 'error' ? s.last_error : null, sender: s });
  for (const b of v.inboxes ?? []) rows.push({ key: `mailbox:${b.id}`, kind: 'mailbox', name: b.label, provider: b.provider === 'smtp' ? 'IMAP' : b.provider_label,
    address: String(b.settings.mailbox ?? ''), folder: b.intake?.folder ?? '', status: b.status, last_checked: b.last_poll_at, messages: b.received,
    last_error: b.status === 'error' ? b.last_error : null, inbox: b });
  return rows;
}
const COLUMNS: RecordCol<Row>[] = [
  { key: 'name', label: 'Name', title: true, keep: true, type: 'text', className: 'min-w-40', value: (r) => r.name, render: (r) => <span className='leading-snug font-medium'>{r.name}</span> },
  { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'sender', label: 'Sender' }, { value: 'mailbox', label: 'Mailbox' }], value: (r) => r.kind, render: (r) => (r.kind === 'sender' ? 'Sender' : 'Mailbox') },
  { key: 'provider', label: 'Provider', type: 'text', value: (r) => r.provider, render: (r) => r.provider },
  { key: 'address', label: 'Address', type: 'text', value: (r) => r.address, render: (r) => <span className='break-all'>{r.address}</span> },
  { key: 'folder', label: 'Folder or label', type: 'text', value: (r) => r.folder, render: (r) => (r.folder ? <span className='font-mono text-xs'>{r.folder}</span> : '') },
  { key: 'status', label: 'Status', type: 'select', keep: true, options: Object.entries(STATUS).map(([value, label]) => ({ value, label })), value: (r) => r.status, render: (r) => <StatusText s={r.status} /> },
  { key: 'checked', label: 'Last checked', type: 'date', value: (r) => r.last_checked, render: (r) => (r.last_checked ? <When d={r.last_checked} /> : <span className='text-muted-foreground'>Never</span>) },
  { key: 'messages', label: 'Messages taken in', type: 'number', value: (r) => r.messages, render: (r) => (r.messages === null ? '' : String(r.messages)) },
  { key: 'error', label: 'Last error', type: 'text', className: 'max-w-xs', value: (r) => r.last_error, render: (r) => (r.last_error ? <span className='text-destructive line-clamp-2 text-sm'>{r.last_error}</span> : '') }
];

/** Settings › Email: the cards, the search row with Add mailbox (and Set sender), the table; a row opens its full card. */
export function EmailTab() {
  const { data, error, reload } = useOrgLoad(() => call<View>('GET'));
  const [adding, setAdding] = useState<'mailbox' | 'sender' | null>(null);
  if (error) return (error as { status?: number }).status === 404 ? <p className='text-muted-foreground text-sm'>This app has no email settings.</p> : <ErrorState error={error} />;
  if (!data) return <LoadingCards count={2} />;
  if (!data.can_manage) return <p className='text-muted-foreground text-sm'>An owner of this workspace sets up its email.</p>;
  const done = async () => { setAdding(null); await reload(); };
  const close = (open: boolean) => { if (!open) setAdding(null); };
  // Add mailbox and Set sender open the shell's full card in the list's place (mold_v0-217 ActionCard).
  if (adding === 'mailbox') return (
    <ActionCard open onOpenChange={close} title='Add mailbox' description={intakeWords(data)}>
      <InboxForm view={data} inbox={null} onDone={done} asCard />
    </ActionCard>
  );
  if (adding === 'sender') return (
    <ActionCard open onOpenChange={close} title='Set sender' description="Send this app's emails to your workspace's people from your own address. The secret is typed once and never shown again.">
      <SenderForm view={data} onChanged={done} asCard />
    </ActionCard>
  );
  const rows = rowsOf(data);
  const inboxes = data.inboxes ?? [];
  const taken = inboxes.reduce((n, b) => n + b.received, 0);
  const failing = rows.filter((r) => r.status === 'error').length;
  const s = data.sender;
  // The search row's primary action (mold_v0-217 ToolbarAction): Add mailbox; Set sender until one is set.
  const actions = (
    <div className='ml-auto flex shrink-0 gap-2'>
      {data.offer.sender && !s && <ToolbarAction label='Set sender' icon={<Icons.mail />} onClick={() => setAdding('sender')} />}
      {data.offer.intakes.length > 0 && <ToolbarAction label='Add mailbox' icon={<Icons.add />} onClick={() => setAdding('mailbox')} />}
    </div>
  );
  return (
    <RecordView<Row>
      id='settings-email' compact noun={rows.length === 1 ? 'entry' : 'entries'} properties
      rows={rows} rowKey={(r) => r.key} cols={COLUMNS}
      summary={<StatStrip quad items={[
        { label: 'Mailboxes', value: inboxes.length, said: `${inboxes.length} mailboxes` },
        { label: 'Messages taken in', value: taken, said: `${taken} messages taken in` },
        { label: 'With an error', value: failing, said: `${failing} with an error` },
        { label: 'Sender', value: !s ? 'Not set' : s.enabled ? 'On' : 'Off', said: `Sender ${!s ? 'not set' : s.enabled ? 'on' : 'off'}` }
      ]} />}
      searchText={(r) => `${r.name} ${r.kind === 'sender' ? 'sender' : 'mailbox'} ${r.provider} ${r.address} ${r.folder} ${STATUS[r.status]} ${r.last_error ?? ''}`}
      searchPlaceholder='Search senders and mailboxes'
      toolbarAction={actions}
      empty={<p className='text-muted-foreground text-sm'>{data.offer.intakes.length ? 'No mailbox connected yet: Add mailbox brings its new messages in as records.' : 'No sender set yet: until one is, this app sends from its own address.'}</p>}
      detailTitle={(r) => r.name}
      detail={(r) => r.kind === 'sender' ? <SenderForm view={data} onChanged={reload} /> : <InboxCard view={data} inbox={r.inbox!} onChanged={reload} />}
    />
  );
}

/** What a mailbox brings in, in words. */
function intakeWords(view: View): string {
  const intakes = view.offer.intakes;
  return `New messages become records${intakes.length === 1 ? ` (${intakes[0]!.label ?? intakes[0]!.area})` : ''}, once each, with their attachments. Only ${intakes.length === 1 ? `the ${intakes[0]!.folder} folder` : 'the folder this app names'} is read, and nothing in the mailbox is changed, moved or deleted.`;
}

function SecretState({ s }: { s: Status }) {
  return s.secret_set
    ? <span className='text-muted-foreground text-xs'>Secret: set{s.secret_set_at ? <> <When d={s.secret_set_at} /></> : null}{s.secret_set_by ? ` by ${s.secret_set_by.replace(/^customer:/, '')}` : ''}. It is never shown again; type a new one to replace it.</span>
    : <span className='text-muted-foreground text-xs'>No secret set.</span>;
}
function TestOutcome({ r }: { r: TestResult | null }) {
  if (!r) return null;
  return r.ok
    ? <p className='text-sm text-emerald-700 dark:text-emerald-400'>Works.{r.sent ? ' The test email was sent.' : ''}{typeof r.messages === 'number' ? ` ${r.folder} holds ${r.messages} message${r.messages === 1 ? '' : 's'}.` : ''}</p>
    : <div className='text-sm'><p className='text-destructive'>{r.error}</p>{r.hint && <p className='text-muted-foreground mt-1 text-xs'>{r.hint}</p>}</div>;
}

/** The provider's own fields (never the secret), for sending or for a mailbox. */
function ProviderFields({ provider, use, settings, set }: { provider: Provider; use: 'sender' | 'inbox'; settings: Settings; set: (k: string, v: string) => void }) {
  const f = (k: string, label: string, hint?: string, placeholder?: string) => (
    <FormRow label={label} htmlFor={`email-${use}-${k}`} hint={hint}>
      <Input id={`email-${use}-${k}`} value={String(settings[k] ?? '')} placeholder={placeholder} autoComplete='off' onChange={(e) => set(k, e.target.value)} />
    </FormRow>
  );
  return (
    <>
      {provider === 'smtp' && <>
        {f('host', use === 'sender' ? 'SMTP server' : 'IMAP server', undefined, use === 'sender' ? 'smtp.example.com' : 'imap.example.com')}
        {f('port', 'Port', use === 'sender' ? '587 (STARTTLS) or 465 (SSL/TLS)' : '993 (SSL/TLS) or 143 (STARTTLS)')}
        <FormRow label='Security' htmlFor={`email-${use}-security`}>
          <NativeSelect id={`email-${use}-security`} value={String(settings.security ?? '')} onChange={(e) => set('security', e.target.value)}>
            <NativeSelectOption value=''>From the port</NativeSelectOption>
            <NativeSelectOption value='tls'>SSL/TLS</NativeSelectOption>
            <NativeSelectOption value='starttls'>STARTTLS</NativeSelectOption>
          </NativeSelect>
        </FormRow>
        {f('username', 'User name', use === 'sender' ? 'Empty for a relay that accepts this service without signing in' : undefined)}
      </>}
      {provider === 'graph' && <>
        {f('tenant_id', 'Directory (tenant) id', 'Microsoft Entra admin center › App registrations › your app › Overview')}
        {f('client_id', 'Application (client) id')}
      </>}
      {(provider !== 'smtp' || use === 'inbox') && f('mailbox', 'Mailbox', provider === 'gmail' ? 'The Workspace user the service account acts as' : provider === 'graph' ? 'The mailbox the app uses (its primary address)' : 'The mailbox\'s address (shown on records)')}
    </>
  );
}
function SecretInput({ provider, use, value, set }: { provider: Provider; use: 'sender' | 'inbox'; value: string; set: (v: string) => void }) {
  const label = provider === 'gmail' ? 'Service-account key file (JSON)' : provider === 'graph' ? 'Client secret' : use === 'sender' ? 'Password' : 'Password (an app password where the mailbox needs one)';
  return (
    <FormRow label={label} htmlFor={`email-${use}-secret`}>
      {provider === 'gmail'
        ? <Textarea id={`email-${use}-secret`} className='font-mono text-xs' rows={4} autoComplete='off' spellCheck={false} placeholder='Paste the whole key file' value={value} onChange={(e) => set(e.target.value)} />
        : <Input id={`email-${use}-secret`} type='password' autoComplete='new-password' spellCheck={false} value={value} onChange={(e) => set(e.target.value)} />}
    </FormRow>
  );
}

function SenderForm({ view, onChanged, asCard }: { view: View; onChanged: () => unknown; asCard?: boolean }) {
  const s = view.sender ?? null;
  const [provider, setProvider] = useState<Provider>(s?.provider ?? 'smtp');
  const [settings, setSettings] = useState<Settings>(s ? { ...s.settings, reply_to: ((s.settings.reply_to as string[] | null) ?? []).join(', ') } : {});
  const [secret, setSecret] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const set = (k: string, v: string) => setSettings((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await call('PUT', '/sender', { provider, settings: { ...settings, port: settings.port ? Number(settings.port) : undefined, security: settings.security || undefined }, ...(secret ? { secret } : {}) });
      setSecret(''); toast.success('Saved'); await onChanged();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const fields = (<>
    <FormRow label='Provider' htmlFor='email-sender-provider'>
      <NativeSelect id='email-sender-provider' value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
        {view.offer.providers.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.id === 'smtp' ? 'SMTP' : p.label}</NativeSelectOption>)}
      </NativeSelect>
    </FormRow>
    <FormRow label='From address' htmlFor='email-sender-from_address'><Input id='email-sender-from_address' value={String(settings.from_address ?? '')} onChange={(e) => set('from_address', e.target.value)} placeholder='notices@yourcompany.com' /></FormRow>
    <FormRow label='From name' htmlFor='email-sender-from_name'><Input id='email-sender-from_name' value={String(settings.from_name ?? '')} onChange={(e) => set('from_name', e.target.value)} /></FormRow>
    <FormRow label='Reply-to' htmlFor='email-sender-reply_to' hint='Optional; up to 5 addresses, separated by commas'><Input id='email-sender-reply_to' value={String(settings.reply_to ?? '')} onChange={(e) => set('reply_to', e.target.value)} /></FormRow>
    <ProviderFields provider={provider} use='sender' settings={settings} set={set} />
    <SecretInput provider={provider} use='sender' value={secret} set={setSecret} />
    {s && <SecretState s={s} />}
  </>);
  // Set sender (mold_v0-218): the shell's full card (mold_v0-217 CardForm): the fields, then Set sender and Cancel.
  if (asCard) return <CardForm onSubmit={save} submit={<Button type='submit' disabled={busy}>Set sender</Button>}><div className='grid max-w-2xl gap-3'>{fields}</div></CardForm>;
  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center gap-3'>
        {s && <span className='text-sm'>Status: <StatusText s={s.status} /></span>}
        {s && <span className='text-muted-foreground text-xs'>{s.sent} sent, {s.failed} failed{s.last_sent_at ? <>; last <When d={s.last_sent_at} /></> : null}</span>}
        {s && <label className='ml-auto flex items-center gap-2 text-sm'>On
          <Switch checked={s.enabled} onCheckedChange={(v) => void call('PATCH', '/sender', { enabled: v }).then(onChanged).catch(fail)} /></label>}
      </div>
      <p className='text-muted-foreground text-sm'>{view.effective === 'workspace' ? "This app's emails to your workspace's people go out from your own sender." : "This app's emails go out from the app's own address until you set and switch on a sender here."}</p>
      {s?.status === 'error' && s.last_error && <div className='text-sm'><p className='text-destructive'>{s.last_error}</p>{s.hint && <p className='text-muted-foreground mt-1 text-xs'>{s.hint}</p>}</div>}
      <form className='grid max-w-2xl gap-3' onSubmit={(e) => { e.preventDefault(); void save(); }}>
        {fields}
        <div className='flex flex-wrap gap-2'>
          <Button type='submit' size='sm' disabled={busy}>{s ? 'Save' : 'Set sender'}</Button>
          {s && <Button type='button' size='sm' variant='ghost' onClick={() => void call('DELETE', '/sender').then(() => { toast.success("Removed: the app's own sender sends again"); return onChanged(); }).catch(fail)}>Remove</Button>}
        </div>
      </form>
      {s && (
        <form className='flex max-w-2xl flex-wrap items-end gap-2' onSubmit={(e) => { e.preventDefault(); setBusy(true); void call<TestResult>('POST', '/sender/test', to ? { to } : {}).then(async (r) => { setTest(r); await onChanged(); }).catch(fail).finally(() => setBusy(false)); }}>
          <FormRow label='Test' htmlFor='email-sender-test' hint='Signs in; with an address, also sends a test email to it'>
            <Input id='email-sender-test' className='w-72' type='email' placeholder='you@yourcompany.com (optional)' value={to} onChange={(e) => setTo(e.target.value)} />
          </FormRow>
          <Button type='submit' size='sm' variant='outline' disabled={busy}>Test</Button>
          <TestOutcome r={test} />
        </form>
      )}
    </div>
  );
}

/** One mailbox's details card: its status, On, Test, the edit form, Disconnect. */
function InboxCard({ view, inbox: b, onChanged }: { view: View; inbox: Inbox; onChanged: () => unknown }) {
  const [test, setTest] = useState<TestResult | null>(null);
  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center gap-3'>
        <span className='text-sm'>Status: <StatusText s={b.status} /></span>
        <span className='text-muted-foreground text-xs'>{b.received} taken in{b.last_poll_at ? <>; read <When d={b.last_poll_at} /></> : null}; every {b.poll_minutes} min</span>
        <label className='ml-auto flex items-center gap-2 text-sm'>On
          <Switch checked={b.enabled} onCheckedChange={(v) => void call('PATCH', `/inboxes/${b.id}`, { enabled: v }).then(onChanged).catch(fail)} /></label>
      </div>
      {b.status === 'error' && b.last_error && <div className='text-sm'><p className='text-destructive'>{b.last_error}</p>{b.hint && <p className='text-muted-foreground mt-1 text-xs'>{b.hint}</p>}</div>}
      <p className='text-muted-foreground text-sm'>{intakeWords(view)}</p>
      <div className='flex flex-wrap items-center gap-2'>
        <Button size='sm' variant='outline' onClick={() => void call<TestResult>('POST', `/inboxes/${b.id}/test`).then(async (r) => { setTest(r); await onChanged(); }).catch(fail)}>Test</Button>
        <Button size='sm' variant='ghost' onClick={() => { if (window.confirm(`Disconnect ${b.label}? Its records stay; no new messages come in from it.`)) void call('DELETE', `/inboxes/${b.id}`).then(() => { toast.success('Disconnected'); return onChanged(); }).catch(fail); }}>Disconnect</Button>
        <TestOutcome r={test} />
      </div>
      <InboxForm view={view} inbox={b} onDone={onChanged} />
    </div>
  );
}

function InboxForm({ view, inbox, onDone, asCard }: { view: View; inbox: Inbox | null; onDone: () => unknown; asCard?: boolean }) {
  const intakes = view.offer.intakes;
  const [pack, setPack] = useState(inbox?.pack ?? intakes[0]?.pack ?? '');
  const [provider, setProvider] = useState<Provider>(inbox?.provider ?? 'smtp');
  const [settings, setSettings] = useState<Settings>(inbox ? { ...inbox.settings, label: inbox.label } : { label: '' });
  const [minutes, setMinutes] = useState(String(inbox?.poll_minutes ?? 5));
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: string) => setSettings((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await call('PUT', '/inboxes', { ...(inbox ? { id: inbox.id } : {}), pack, provider, poll_minutes: Number(minutes),
        settings: { ...settings, port: settings.port ? Number(settings.port) : undefined, security: settings.security || undefined }, ...(secret ? { secret } : {}) });
      toast.success('Saved'); await onDone();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const fields = (<>
      {intakes.length > 1 && (
        <FormRow label='Brings messages into' htmlFor='email-inbox-pack'>
          <NativeSelect id='email-inbox-pack' value={pack} onChange={(e) => setPack(e.target.value)}>
            {intakes.map((i) => <NativeSelectOption key={i.pack} value={i.pack}>{i.label ?? i.area} (folder {i.folder})</NativeSelectOption>)}
          </NativeSelect>
        </FormRow>
      )}
      <FormRow label='Name' htmlFor='email-inbox-label' hint='How this mailbox is named here and on its records'><Input id='email-inbox-label' value={String(settings.label ?? '')} onChange={(e) => set('label', e.target.value)} /></FormRow>
      <FormRow label='Provider' htmlFor='email-inbox-provider'>
        <NativeSelect id='email-inbox-provider' value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
          {view.offer.providers.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.id === 'smtp' ? 'IMAP' : p.label}</NativeSelectOption>)}
        </NativeSelect>
      </FormRow>
      <ProviderFields provider={provider} use='inbox' settings={settings} set={set} />
      <SecretInput provider={provider} use='inbox' value={secret} set={setSecret} />
      {inbox && <SecretState s={inbox} />}
      <FormRow label='Check every (minutes)' htmlFor='email-inbox-minutes'><Input id='email-inbox-minutes' className='w-28' type='number' min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></FormRow>
  </>);
  // Add mailbox (mold_v0-218): the shell's full card (mold_v0-217 CardForm): the fields, then Connect and Cancel.
  if (asCard) return <CardForm onSubmit={save} submit={<Button type='submit' disabled={busy}>Connect</Button>}><div className='grid max-w-2xl gap-3'>{fields}</div></CardForm>;
  return (
    <form className='grid max-w-2xl gap-3' onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {fields}
      <div className='flex gap-2'>
        <Button type='submit' size='sm' disabled={busy}>Save</Button>
      </div>
    </form>
  );
}
