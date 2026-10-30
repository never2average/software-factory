'use client';
// The Key vault: every key the app uses, one row per provider. Keys live in the vault only (keys once set as server
// environment variables were imported on boot); add, import, disable and delete; keys are only ever shown as hints.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import PageContainer from '@/components/layout/page-container';
import { Field, RecordView, type RecordCol } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate, useAdminRole } from './role';
import { ErrorBox, FormRow, Mono, Notice, StatusBadge, When } from './ui';
import { AdminGithubApp } from './github-app';
import { AdminOAuthProviders } from './oauth-providers';

// ---------- key vault ----------

interface Provider { slug: string; mode: 'gateway' | 'direct'; backend: string; enabled: boolean; keys: number; enabled_keys: number; last_used_at: string | null; env_set?: string[]; in_use?: StoreSource }
/** What the object store uses now (src/storage.ts): the environment's R2_*, the vault's entry, APP_STORAGE_DIR, or none. */
type StoreSource = 'env' | 'vault' | 'dir' | 'none';
/** Display names for the vault's provider ids (and TYPE below: src/vault-providers.ts keeps the server's copy for operator:vault-status). */
const NAME: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google Gemini', cloudflare: 'Cloudflare Workers AI', dashscope: 'Alibaba DashScope',
  vertex: 'Vertex AI (Google Cloud)', boat: 'boat.dev', exa: 'Exa', libraries_io: 'Libraries.io', resend: 'Resend', amp: 'Amp', cursor: 'Cursor', factory: 'Factory', github_copilot: 'GitHub Copilot',
  // The packs' own stores (mold_v0-169: listed only in a build whose packs declare them, src/platform-keys.ts providerInBuild).
  oauth_clients: 'OAuth app clients', pack_credentials: 'Staff-held run credentials',
  // The bucket's four settings, one entry (mold_v0-181: src/storage.ts uses it when the server has no R2_*).
  object_storage: 'Object storage (R2 / S3)'
};
const nameOf = (slug: string) => NAME[slug] ?? slug;
interface Credential { id: number; provider: string; label: string; hint: string; enabled: boolean; uses: number; last_used_at: string | null; project_id?: string | null; client_email?: string; bucket?: string; endpoint?: string; access_key_hint?: string | null }
const TYPE: Record<string, string> = {
  anthropic: 'Inference', openai: 'Inference', google: 'Inference', cloudflare: 'Inference', dashscope: 'Inference', vertex: 'Inference',
  boat: 'Sandbox', exa: 'Search', libraries_io: 'Search', resend: 'Email',
  amp: 'Coding agent', cursor: 'Coding agent', factory: 'Coding agent', github_copilot: 'Coding agent',
  oauth_clients: 'Connection', pack_credentials: 'Run credential', object_storage: 'Storage'
};
const TYPES = ['Inference', 'Sandbox', 'Storage', 'Search', 'Email', 'Coding agent', 'Connection', 'Run credential', 'Other'];
/** What a provider's keys are for, where its name alone does not say (on hover, and as the Add a key form's hint). */
const ABOUT: Record<string, string> = {
  oauth_clients: 'The client id and secret of each OAuth provider workspaces connect to, under the labels OAuth providers (below) names',
  pack_credentials: "Logins the platform's staff hold for a pack's runs, each labelled <pack>.<name>; never shown to a workspace",
  object_storage: "The bucket the app keeps workspace files and archives in, used when the server's environment has no R2_* settings"
};
const OBJECT_STORAGE = 'object_storage';
const typeOf = (slug: string) => TYPE[slug] ?? 'Other';
/** Server-only keys (email) are used by the API itself; never by orchestrators or agents. */
const SERVER_ONLY = new Set(['resend', 'object_storage']);
const useOf = (p: { slug: string; mode: string }) => (SERVER_ONLY.has(p.slug) ? 'Server only' : p.mode === 'gateway' ? 'Gateway' : 'Orchestrator');
/** 12400 → "12.4k". */
const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Every key the app uses, one row per provider; keys are added, disabled and deleted from the row's ⋯ menu. */
export function AdminKeyVault() {
  const { lock } = useAdminRole();
  const { data, error, isLoading } = useAdmin<{ unlocked: boolean; providers: Provider[]; credentials: Credential[] }>('/compute/keys');
  const [adding, setAdding] = useState<string | null>(null);
  const [del, setDel] = useState<Credential | null>(null);
  const [importing, setImporting] = useState(false);
  const [storing, setStoring] = useState(false);
  const store = useStoreTest();
  const keyOn = useAdminAction((v: { id: number; enabled: boolean }) => post(`/compute/keys/${v.id}/enabled`, { enabled: v.enabled }), { success: 'Key updated' });
  const remove = useAdminAction((id: number) => adminApi('DELETE', `/compute/keys/${id}`), { success: 'Key deleted' });
  const provOn = useAdminAction((v: { slug: string; enabled: boolean }) => post(`/compute/providers/${encodeURIComponent(v.slug)}/enabled`, { enabled: v.enabled }), { success: 'Provider updated' });
  const creds = data?.credentials ?? [];
  // The GitHub App's settings (mold_v0-014) are one sealed entry managed in their own section below, not a key to add here.
  const providers = (data?.providers ?? []).filter((p) => p.slug !== 'github_app');
  const keysOf = (p: Provider) => creds.filter((c) => c.provider === p.slug);
  const cols: RecordCol<Provider>[] = [
    { key: 'provider', label: 'Provider', keep: true, type: 'text', value: (p) => nameOf(p.slug), render: (p) => (
      <span className='flex flex-col gap-0.5'><span className='font-medium' title={ABOUT[p.slug] ?? p.slug}>{nameOf(p.slug)}</span><span className='text-muted-foreground text-xs'>{typeOf(p.slug)}</span></span>
    ) },
    { key: 'type', label: 'Type', hidden: true, type: 'select', value: (p) => typeOf(p.slug), options: TYPES.map((t) => ({ value: t })), render: (p) => typeOf(p.slug) },
    { key: 'use', label: 'Access', hidden: true, type: 'select', value: useOf,
      render: (p) => <span className='text-muted-foreground'>{useOf(p)}{p.backend !== 'direct' && ` · ${p.backend}`}</span> },
    { key: 'keys', label: 'Keys', className: 'w-72 max-w-72', type: 'number', value: (p) => keysOf(p).length, render: (p) => {
      const mine = keysOf(p);
      if (p.slug === OBJECT_STORAGE) return <ObjectStorageCell p={p} entry={mine[0] ?? null} unlocked={data?.unlocked !== false} test={store} onEdit={() => setStoring(true)} />;
      return (
        <span className='flex flex-col gap-1'>
          {!mine.length && <span className='text-amber-700 dark:text-amber-400'>no key</span>}
          {mine.map((c) => (
            // One line per key, cut short to the column's width; the full text is on hover.
            <span key={c.id} className={cn('block truncate', !c.enabled && 'text-muted-foreground line-through')}
              title={c.client_email ? `${c.client_email}${c.project_id ? ` · project ${c.project_id}` : ''} · ${c.label}` : `${c.hint} · ${c.label}`}>
              <span className='font-mono text-xs'>{c.client_email ?? c.hint}</span> <span className='text-muted-foreground'>{c.label}</span>
            </span>
          ))}
        </span>
      );
    } },
    { key: 'uses', label: 'Uses', hidden: true, className: 'text-right', type: 'number', value: (p) => keysOf(p).reduce((t, c) => t + c.uses, 0),
      render: (p) => <span className='tabular-nums'>{keysOf(p).reduce((t, c) => t + c.uses, 0).toLocaleString()}</span> },
    { key: 'last', label: 'Last used', type: 'date', value: (p) => p.last_used_at ?? undefined, render: (p) => (
      <span className='flex flex-col gap-0.5'>{p.last_used_at ? <When d={p.last_used_at} /> : <span className='text-muted-foreground'>never</span>}
        <span className='text-muted-foreground text-xs tabular-nums'>{COMPACT.format(keysOf(p).reduce((t, c) => t + c.uses, 0))} uses</span></span>
    ) },
    { key: 'on', label: 'On', className: 'w-16 text-right', keep: true,
      render: (p) => <span onClick={(e) => e.stopPropagation()}><Gate need='keys'><Switch aria-label={`${p.slug} on`} checked={p.enabled} disabled={provOn.isPending} onCheckedChange={(c) => provOn.mutate({ slug: p.slug, enabled: c })} /></Gate></span> }
  ];
  return (
    <PageContainer>
      <ErrorBox error={error} />
      {data && !data.unlocked && <Notice>The key vault is locked: set <Mono>APP_VAULT_KEY</Mono> on the server to add keys.</Notice>}
      <RecordView id='key-vault' rows={providers} loading={isLoading} rowKey={(p) => p.slug} cols={cols} noun='providers'
        searchText={(p) => `${p.slug} ${nameOf(p.slug)} ${typeOf(p.slug)} ${keysOf(p).map((c) => `${c.label} ${c.hint} ${c.project_id ?? ''}`).join(' ')}`}
        searchPlaceholder='Search providers and keys · encrypted at rest; agents get scoped gateway tokens, never these keys'
        // The first four kinds this build has a provider of (a build without the session engine has no sandbox or search).
        views={[{ id: 'all', label: 'All' }, ...TYPES.filter((t) => providers.some((p) => typeOf(p.slug) === t)).slice(0, 4).map((t) => ({ id: t, label: t, match: (p: Provider) => typeOf(p.slug) === t }))]}
        defaultSort={[{ key: 'type', dir: 'asc' }]}
        primary={<Gate need='keys'><Button onClick={() => setAdding(providers.find((p) => p.slug !== OBJECT_STORAGE)?.slug ?? null)} disabled={data?.unlocked === false}><Icons.add /> Add a key</Button></Gate>}
        primaryMenu={[lock({ label: 'Import keys…', icon: <Icons.upload />, disabled: data?.unlocked === false, onSelect: () => setImporting(true) }, 'keys')]}
        actions={(p) => [
          ...(p.slug === OBJECT_STORAGE
            ? [{ label: keysOf(p).length ? 'Edit…' : 'Set up…', icon: keysOf(p).length ? <Icons.edit /> : <Icons.add />, disabled: data?.unlocked === false, onSelect: () => setStoring(true) },
               ...(keysOf(p).length ? [{ label: 'Test', icon: <Icons.play />, disabled: store.isPending, onSelect: () => store.mutate() }] : [])]
            : [{ label: 'Add a key…', icon: <Icons.add />, disabled: data?.unlocked === false, onSelect: () => setAdding(p.slug) }]),
          ...keysOf(p).flatMap((c, i) => [
            { label: `${c.enabled ? 'Disable' : 'Enable'} ${c.label} (${c.hint})`, icon: c.enabled ? <Icons.eyeOff /> : <Icons.check />, separator: i === 0, onSelect: () => keyOn.mutate({ id: c.id, enabled: !c.enabled }) },
            { label: `Delete ${c.label}…`, icon: <Icons.trash />, destructive: true, onSelect: () => setDel(c) }
          ])
        ].map((a) => lock(a, 'keys'))}
        exportName='key-vault-providers' empty='No providers.' />
      {importing && <ImportKeys providers={providers} onClose={() => setImporting(false)} />}
      {adding && <AddKey providers={providers} initial={adding} onClose={() => setAdding(null)} onObjectStorage={() => { setAdding(null); setStoring(true); }} />}
      {storing && <ObjectStorageForm onClose={() => setStoring(false)} onSaved={(test) => { setStoring(false); if (test) store.mutate(); }} />}
      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the {del && nameOf(del.provider)} key {del?.label}?</AlertDialogTitle>
            <AlertDialogDescription>Calls stop using it at once. This cannot be undone: to use it again, add it again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { if (del) remove.mutate(del.id); setDel(null); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AdminGithubApp />
      <AdminOAuthProviders />
    </PageContainer>
  );
}

/** A key is posted once and the form is cleared; a failed save asks for it again rather than keeping it on screen. */
function AddKey({ providers, initial, onClose, onObjectStorage }: { providers: Provider[]; initial: string; onClose: () => void; onObjectStorage: () => void }) {
  const [f, setF] = useState({ provider: initial, label: '', secret: '' });
  const [err, setErr] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [drag, setDrag] = useState(false);
  // A key file read in the browser: the BOM some editors add is dropped so the JSON parses; the text never renders.
  const readFile = (fl: File | undefined) => { if (fl) void fl.text().then((t) => { setFile(fl.name); setErr(''); setF((x) => ({ ...x, secret: t.replace(/^\uFEFF/, '').trim() })); }); };
  const add = useAdminAction(() => post<{ hint: string; project_id?: string }>('/compute/keys', { provider: f.provider, label: f.label.trim() || undefined, secret: f.secret }),
    { success: (r) => `Key saved (${r.project_id ? `${r.project_id} · ` : ''}${r.hint})` });
  const vertex = f.provider === 'vertex' || (f.provider === 'anthropic' && f.label.trim() === 'vertex');
  const sa = vertex && f.secret.trim() ? checkServiceAccount(f.secret) : null;
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (sa && 'error' in sa) return setErr(sa.error);
    add.mutate(undefined, { onSuccess: onClose, onError: (x) => { setErr(x.message); setF({ ...f, secret: '' }); } });
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid min-w-0 gap-4 [&>*]:min-w-0' autoComplete='off'>
          <DialogHeader>
            <DialogTitle>Add a key</DialogTitle>
            <DialogDescription>Encrypted at rest and shown only as a hint once saved.</DialogDescription>
          </DialogHeader>
          <FormRow id='ak-provider' label='Provider'>
            <NativeSelect id='ak-provider' value={f.provider} onChange={(e) => (e.target.value === OBJECT_STORAGE ? onObjectStorage() : setF({ ...f, provider: e.target.value }))} className='w-full'>
              {providers.map((p) => <NativeSelectOption key={p.slug} value={p.slug}>{nameOf(p.slug)} · {typeOf(p.slug)}</NativeSelectOption>)}
            </NativeSelect>
          </FormRow>
          <FormRow id='ak-label' label='Label (optional)' hint={f.provider === 'vertex' ? 'A Google Cloud service-account JSON key; Claude on Vertex AI uses it (project from the key, region from Agent configuration).' : ABOUT[f.provider] ? `${ABOUT[f.provider]}.` : 'A new label adds to the pool; the same label replaces that key.'}>
            <Input id='ak-label' maxLength={60} placeholder={f.provider === 'vertex' ? 'vertex' : 'default'} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} />
          </FormRow>
          <FormRow id='ak-secret' label={vertex ? 'Service-account JSON' : 'Key'}>
            {vertex
              ? <div className='grid min-w-0 gap-2'>
                  {!f.secret ? (
                    <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                      onDrop={(e) => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files?.[0]); }}
                      className={cn('flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-4 py-6 text-center text-sm', drag ? 'border-primary bg-primary/5' : 'hover:bg-muted/40')}>
                      <Icons.upload className='text-muted-foreground size-5' />
                      <span className='font-medium'>Drop the key file here, or choose it</span>
                      <span className='text-muted-foreground text-xs'>The .json file Google Cloud downloads. It is checked here and never shown.</span>
                      <input type='file' accept='.json,application/json' className='sr-only' aria-label='Choose the service-account JSON file' onChange={(e) => { readFile(e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                  ) : (
                    <div className={cn('flex min-w-0 items-start gap-3 overflow-hidden rounded-md border px-3 py-2.5 text-sm', sa && 'error' in sa ? 'border-destructive/40' : 'border-emerald-500/40')}>
                      {sa && 'error' in sa ? <Icons.warning className='text-destructive mt-0.5 size-4 shrink-0' /> : <Icons.circleCheck className='mt-0.5 size-4 shrink-0 text-emerald-600' />}
                      <div className='min-w-0 flex-1 space-y-0.5'>
                        <div className='truncate font-medium' title={file ?? undefined}>{file ?? 'Pasted key'}</div>
                        {sa && ('error' in sa
                          ? <p className='text-destructive text-xs'>{sa.error}</p>
                          : <p className='text-muted-foreground truncate text-xs'><Mono>{sa.project_id}</Mono> · <Mono>{sa.client_email}</Mono></p>)}
                      </div>
                      <Button type='button' variant='ghost' size='xs' className='shrink-0' onClick={() => { setF({ ...f, secret: '' }); setFile(null); setPasting(false); }}>Replace</Button>
                    </div>
                  )}
                  {!f.secret && (pasting
                    ? <Textarea id='ak-secret' rows={3} spellCheck={false} autoComplete='off' className='font-mono text-xs [-webkit-text-security:disc]' placeholder='Paste the whole key file' value={f.secret}
                        onChange={(e) => { setFile(null); setF({ ...f, secret: e.target.value.replace(/^\uFEFF/, '').trim() }); }} />
                    : <button type='button' className='text-muted-foreground hover:text-foreground self-start text-xs underline-offset-2 hover:underline' onClick={() => setPasting(true)}>Or paste the JSON instead</button>)}
                </div>
              : <Input id='ak-secret' type='password' autoComplete='new-password' spellCheck={false} required value={f.secret} onChange={(e) => setF({ ...f, secret: e.target.value })} />}
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Gate need='keys'><Button type='submit' disabled={add.isPending || !f.secret.trim() || (!!sa && 'error' in sa)}>Save key</Button></Gate>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The same checks the server makes on a Vertex AI key (src/keyvault.ts checkServiceAccount); never shows the key. */
function checkServiceAccount(text: string): { project_id: string; client_email: string } | { error: string } {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text); } catch { return { error: 'That is not valid JSON: paste the whole service-account key file from Google Cloud' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'That is not a service-account key file' };
  if (j.type !== 'service_account') return { error: 'That is not a service-account key: "type" must be "service_account"' };
  for (const k of ['project_id', 'client_email', 'private_key']) if (typeof j[k] !== 'string' || !(j[k] as string).trim()) return { error: `The service-account key has no ${k}` };
  return { project_id: j.project_id as string, client_email: j.client_email as string };
}

/** Environment variable names the app knows, to the vault provider that holds them. */
const ENV_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: 'anthropic', OPENAI_API_KEY: 'openai', CODEX_API_KEY: 'openai', GEMINI_API_KEY: 'google', GOOGLE_API_KEY: 'google',
  CLOUDFLARE_API_TOKEN: 'cloudflare', CF_API_TOKEN: 'cloudflare', DASHSCOPE_API_KEY: 'dashscope', BOAT_API_KEY: 'boat', EXA_API_KEY: 'exa',
  LIBRARIES_IO_API_KEY: 'libraries_io', RESEND_API_KEY: 'resend', AMP_API_KEY: 'amp', CURSOR_API_KEY: 'cursor', FACTORY_API_KEY: 'factory', COPILOT_GITHUB_TOKEN: 'github_copilot'
};
interface Parsed { provider: string; label: string; secret: string; source: string; status?: 'saved' | 'failed'; error?: string }
const R2_FIELDS: Record<string, string> = { R2_BUCKET: 'bucket', R2_ENDPOINT: 'endpoint', R2_ACCESS_KEY_ID: 'access_key_id', R2_SECRET_ACCESS_KEY: 'secret_access_key' };
const hint = (s: string) => (s.trim().startsWith('{') ? (s.includes('"secret_access_key"') ? 'bucket settings' : 'service-account JSON') : s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : '••••');

/**
 * Keys from a .env file (KNOWN_NAME=value), a CSV (provider,label,key) or a Google service-account JSON (Claude on
 * Vertex). Parsed in the browser, shown by hint only, then saved one by one; lines it does not recognise are listed.
 */
function parseKeys(text: string, slugs: Set<string>): { keys: Parsed[]; skipped: string[] } {
  const t = text.trim(), keys: Parsed[] = [], skipped: string[] = [];
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      if (j.type === 'service_account') return { keys: [{ provider: slugs.has('vertex') ? 'vertex' : 'anthropic', label: 'vertex', secret: t, source: `service-account JSON${j.client_email ? ` (${j.client_email})` : ''}` }], skipped };
    } catch { /* not JSON */ }
  }
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const csv = /^provider\s*,/i.test(lines[0] ?? '');
  // The object store's four R2_* variables (mold_v0-181) become its one entry, when all four are there.
  const r2: Record<string, string> = {};
  for (const line of csv ? lines.slice(1) : lines) {
    if (csv) {
      const [provider, label, ...rest] = line.split(',').map((x) => x.trim());
      const secret = rest.join(',').replace(/^["']|["']$/g, '');
      if (slugs.has(provider) && secret) keys.push({ provider, label: label || 'imported', secret, source: line.slice(0, 24) });
      else skipped.push(line.slice(0, 40));
      continue;
    }
    const m = line.replace(/^export\s+/, '').match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    const r2Field = m && R2_FIELDS[m[1].toUpperCase()];
    if (m && r2Field && slugs.has(OBJECT_STORAGE)) { r2[r2Field] = m[2].trim().replace(/^["']|["']$/g, ''); continue; }
    const provider = m && (ENV_PROVIDER[m[1].toUpperCase()] ?? (slugs.has(m[1].toLowerCase()) ? m[1].toLowerCase() : null));
    const secret = m?.[2].trim().replace(/^["']|["']$/g, '') ?? '';
    if (m && provider && secret) keys.push({ provider, label: 'imported', secret, source: m[1] });
    else skipped.push(m ? m[1] : line.slice(0, 40));
  }
  const got = Object.keys(r2);
  if (got.length === 4) keys.push({ provider: OBJECT_STORAGE, label: 'default', secret: JSON.stringify(r2), source: 'R2_* (4 settings)' });
  else if (got.length) skipped.push(`R2_* (${got.length} of 4: add Object storage by hand)`);
  return { keys, skipped };
}

function ImportKeys({ providers, onClose }: { providers: Provider[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Parsed[] | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const slugs = new Set(providers.map((p) => p.slug));
  const read = (t: string) => { const r = parseKeys(t, slugs); setRows(r.keys); setSkipped(r.skipped); setText(''); };
  const save = async () => {
    if (!rows) return;
    setBusy(true);
    const out: Parsed[] = [];
    for (const k of rows) {
      try { await post('/compute/keys', { provider: k.provider, label: k.label, secret: k.secret }); out.push({ ...k, secret: '', status: 'saved' }); }
      catch (e) { out.push({ ...k, secret: '', status: 'failed', error: (e as Error).message }); }
    }
    setRows(out); setBusy(false);
    void qc.invalidateQueries({ queryKey: ['admin'] });
  };
  const done = rows?.some((r) => r.status);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Import keys</DialogTitle>
          <DialogDescription>Paste or choose a .env file (ANTHROPIC_API_KEY=…, CLOUDFLARE_API_TOKEN=…), a CSV with provider,label,key, or a Google service-account JSON. Nothing is saved until you confirm; keys are shown only as hints.</DialogDescription>
        </DialogHeader>
        {!rows ? (<>
          <Textarea rows={8} spellCheck={false} autoComplete='off' className='font-mono text-xs' placeholder={'ANTHROPIC_API_KEY=sk-ant-…\nCLOUDFLARE_API_TOKEN=…'} value={text} onChange={(e) => setText(e.target.value)} />
          <div className='flex items-center gap-3'>
            <Input type='file' accept='.env,.txt,.csv,.json,text/plain,application/json' className='max-w-xs' onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(read); }} />
            <Button className='ml-auto' disabled={!text.trim()} onClick={() => read(text)}>Read keys</Button>
          </div>
        </>) : (<>
          <div className='max-h-72 overflow-y-auto border'>
            <table className='w-full text-sm [&_td]:border-r [&_td:last-child]:border-r-0 [&_th]:border-r [&_th:last-child]:border-r-0'>
              <thead><tr className='text-muted-foreground border-b text-xs'><th className='px-3 py-2 text-left font-normal'>From</th><th className='px-3 py-2 text-left font-normal'>Provider</th><th className='px-3 py-2 text-left font-normal'>Label</th><th className='px-3 py-2 text-left font-normal'>Key</th><th className='px-3 py-2 text-left font-normal'>Status</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className='border-t'>
                    <td className='px-3 py-2'><Mono>{r.source}</Mono></td>
                    <td className='px-3 py-2'>{nameOf(r.provider)}</td>
                    <td className='px-3 py-2'>
                      {done ? r.label : <Input aria-label='Label' value={r.label} maxLength={60} className='h-7 w-32' onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />}
                    </td>
                    <td className='px-3 py-2'><Mono>{r.status ? '—' : hint(r.secret)}</Mono></td>
                    <td className={cn('px-3 py-2', r.status === 'failed' && 'text-destructive')}>{r.status === 'saved' ? 'saved' : r.status === 'failed' ? r.error : 'ready'}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={5} className='text-muted-foreground px-3 py-6 text-center'>No keys recognised.</td></tr>}
              </tbody>
            </table>
          </div>
          {skipped.length > 0 && <p className='text-muted-foreground text-xs'>Skipped (not a known key): {skipped.join(', ')}</p>}
        </>)}
        <DialogFooter>
          <Button variant='outline' disabled={busy} onClick={onClose}>{done ? 'Close' : 'Cancel'}</Button>
          {rows && !done && <Button variant='ghost' onClick={() => setRows(null)}>Back</Button>}
          {rows && !done && <Gate need='keys'><Button disabled={busy || !rows.length} onClick={() => void save()}>{busy ? 'Saving…' : `Import ${rows.length} key${rows.length === 1 ? '' : 's'}`}</Button></Gate>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ---------- object storage (mold_v0-181) ----------

interface StoreView {
  unlocked: boolean; configured: boolean; enabled: boolean | null; id: number | null; bucket: string | null; endpoint: string | null;
  access_key_hint: string | null; set: { access_key_id: boolean; secret_access_key: boolean }; in_use: StoreSource; env_set: string[];
}
interface StoreTest { ok: boolean; bucket: string; endpoint: string; ms: number; steps: { step: string; ok: boolean }[]; error: string | null; at?: number }
const hostOf = (u?: string | null) => { try { return u ? new URL(u).host : ''; } catch { return u ?? ''; } };

/** The row's Test: write, read and delete one small object in the bucket; the last result stays on the row. */
function useStoreTest() {
  const [last, setLast] = useState<StoreTest | null>(null);
  const m = useMutation<StoreTest, Error, void>({
    mutationFn: () => post<StoreTest>('/compute/object-storage/test'),
    onSuccess: (r) => {
      setLast({ ...r, at: Date.now() });
      if (r.ok) toast.success(`Object storage works: wrote, read and deleted a test object in ${r.bucket} (${r.ms} ms)`);
      else toast.error(`Object storage test failed: ${r.error}`);
    },
    onError: (e) => toast.error(e.message)
  });
  return { ...m, last };
}

/** The Keys cell of the Object storage row: the bucket and endpoint (never a key), what the server uses, and Test. */
function ObjectStorageCell({ p, entry, unlocked, test, onEdit }: { p: Provider; entry: Credential | null; unlocked: boolean; test: ReturnType<typeof useStoreTest>; onEdit: () => void }) {
  const envWins = p.in_use === 'env';
  if (!entry) return (
    <span className='flex flex-col items-start gap-1'>
      {envWins ? <span className='text-muted-foreground'>set in the server&apos;s environment (R2_*)</span> : <span className='text-amber-700 dark:text-amber-400'>not set</span>}
      <span onClick={(e) => e.stopPropagation()}><Gate need='keys'><Button size='xs' variant='outline' disabled={!unlocked} onClick={onEdit}><Icons.add /> Set up</Button></Gate></span>
    </span>
  );
  const t = test.last;
  return (
    <span className='flex min-w-0 flex-col gap-1'>
      <span className={cn('block truncate', !entry.enabled && 'text-muted-foreground line-through')} title={`${entry.bucket ?? entry.hint} · ${entry.endpoint ?? ''}`}>
        <span className='font-mono text-xs'>{entry.bucket ?? entry.hint}</span> <span className='text-muted-foreground'>{hostOf(entry.endpoint)}</span>
      </span>
      <span className='text-muted-foreground block truncate text-xs'>access key <Mono>{entry.access_key_hint ?? 'set'}</Mono> · secret set</span>
      <span className='flex flex-wrap items-center gap-1.5'>
        {envWins ? <StatusBadge tone='neutral' title="All four R2_* are set on the server: they are used, not this entry">environment wins</StatusBadge>
          : p.in_use === 'vault' ? <StatusBadge tone='ok'>in use</StatusBadge> : <StatusBadge tone='warn' title='Turned off: the server does not use it'>not in use</StatusBadge>}
        {t && (t.ok ? <StatusBadge tone='ok' title={`${t.steps.map((s) => s.step).join(', ')} in ${t.ms} ms`}>test ok</StatusBadge>
          : <StatusBadge tone='bad' title={t.error ?? ''}>test failed</StatusBadge>)}
      </span>
      {t && !t.ok && <span className='text-destructive text-xs whitespace-normal'>{t.error}</span>}
      <span className='flex gap-1.5' onClick={(e) => e.stopPropagation()}>
        <Gate need='keys'><Button size='xs' variant='outline' disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Icons.spinner className='animate-spin' /> : <Icons.play />} Test</Button></Gate>
        <Gate need='keys'><Button size='xs' variant='ghost' disabled={!unlocked} onClick={onEdit}><Icons.edit /> Edit</Button></Gate>
      </span>
    </span>
  );
}

const STORE_EMPTY = { bucket: '', endpoint: '', access_key_id: '', secret_access_key: '' };

/**
 * Set up or edit Object storage: the bucket, its endpoint, and an access key with read and write access. The keys are
 * posted once and never shown again; editing leaves a blank key field as it is stored. A failed save clears the keys.
 */
function ObjectStorageForm({ onClose, onSaved }: { onClose: () => void; onSaved: (test: boolean) => void }) {
  const { data } = useAdmin<StoreView>('/compute/object-storage');
  const [f, setF] = useState(STORE_EMPTY);
  const [err, setErr] = useState('');
  const [then, setThen] = useState(false);
  const has = !!data?.configured;
  const filled = (k: keyof typeof STORE_EMPTY) => f[k].trim() !== '';
  const save = useAdminAction(() => post<StoreView & { hint: string }>('/compute/object-storage', Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()))),
    { success: (r) => `Object storage saved (${r.hint})` });
  const endpointProblem = filled('endpoint') && !/^https:\/\//i.test(f.endpoint.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(f.endpoint.trim()) ? 'Starts with https://' : '';
  const ready = has ? Object.values(f).some((v) => v.trim()) : filled('bucket') && filled('endpoint') && filled('access_key_id') && filled('secret_access_key');
  const submit = (test: boolean) => (e?: React.FormEvent) => {
    e?.preventDefault(); setErr(''); setThen(test);
    if (endpointProblem) return setErr(`Endpoint: ${endpointProblem}`);
    save.mutate(undefined, { onSuccess: () => onSaved(test), onError: (x) => { setErr(x.message); setF({ ...f, access_key_id: '', secret_access_key: '' }); } });
  };
  const set = (k: keyof typeof STORE_EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <form onSubmit={submit(false)} className='grid min-w-0 gap-4 [&>*]:min-w-0' autoComplete='off'>
          <DialogHeader>
            <DialogTitle>{has ? 'Edit object storage' : 'Set up object storage'}</DialogTitle>
            <DialogDescription>
              The bucket the app keeps workspace files and archives in (Cloudflare R2 or any S3-compatible service). Encrypted at rest; the keys are never shown again.
              {data?.in_use === 'env' && ' The server\'s environment sets all four R2_* settings: those stay in use until they are removed there.'}
            </DialogDescription>
          </DialogHeader>
          <FormRow id='os-bucket' label={<>Bucket name {data?.bucket && <Mono>({data.bucket})</Mono>}</>} hint='Cloudflare: R2 › Overview, the name in the bucket list.'>
            <Input id='os-bucket' spellCheck={false} placeholder={data?.bucket ?? 'my-app-files'} value={f.bucket} onChange={set('bucket')} />
          </FormRow>
          <FormRow id='os-endpoint' label={<>Endpoint {data?.endpoint && <Mono>({hostOf(data.endpoint)})</Mono>}</>} hint={endpointProblem || "Cloudflare: the bucket › Settings › S3 API. The address may end with the bucket's name."}>
            <Input id='os-endpoint' spellCheck={false} inputMode='url' placeholder='https://<account id>.r2.cloudflarestorage.com' value={f.endpoint} onChange={set('endpoint')} aria-invalid={!!endpointProblem} />
          </FormRow>
          <FormRow id='os-key' label={<>Access key ID {data?.set.access_key_id && <StatusBadge tone='ok'>set</StatusBadge>}</>} hint={has ? 'Leave blank to keep the one stored.' : 'Cloudflare: R2 › Manage API tokens › Create API token, with Object Read & Write on this bucket.'}>
            <Input id='os-key' type='password' autoComplete='new-password' spellCheck={false} value={f.access_key_id} onChange={set('access_key_id')} />
          </FormRow>
          <FormRow id='os-secret' label={<>Secret access key {data?.set.secret_access_key && <StatusBadge tone='ok'>set</StatusBadge>}</>} hint={has ? 'Leave blank to keep the one stored.' : 'Shown once by Cloudflare when the token is made.'}>
            <Input id='os-secret' type='password' autoComplete='new-password' spellCheck={false} value={f.secret_access_key} onChange={set('secret_access_key')} />
          </FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Gate need='keys'><Button type='button' variant='secondary' disabled={save.isPending || !ready} onClick={() => submit(true)()}>{save.isPending && then ? 'Saving…' : 'Save and test'}</Button></Gate>
            <Gate need='keys'><Button type='submit' disabled={save.isPending || !ready}>{save.isPending && !then ? 'Saving…' : 'Save'}</Button></Gate>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
