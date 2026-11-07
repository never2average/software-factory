'use client';
// Admin › Agent profiles (mold_v0-261, redesigned by mold_v0-267, flag agent_harness; src/agent-routes.ts
// /api/admin/onboarding/agent-profiles, src/agent-profiles.ts). The list is the standard one (four cards, the search row
// with New profile, the table). A row, or New profile, opens ONE modal with everything a profile is, and nothing else:
//   1. Harness       which agent CLI runs it (only the pinned ones are offered)
//   2. (no model field: the model is the primary inference provider's)
//   3. Key vault     the primary inference provider (its model, priced, and its key), and the keys injected into its
//                    sessions (a workspace credential, or a platform key in a variable of its own)
//   4. Workspace     files and folders uploaded into its sessions' workspace (runtime binaries made executable)
//   5. Governance    its governance policy: web tools, approvals, rules (a website, an app tool, an exception), retention
// Adding a key, a file or a rule puts a row in place, editable and removable: no nested dialog, no other screen, no Back.
// Save and Cancel are at the bottom. Budgets, turns and limits are the platform's (Agent configuration).
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useQueryState } from 'nuqs';
import PageContainer from '@/components/layout/page-container';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { adminApi } from '@/lib/api-client';
import { ADMIN_HEADERS } from '@/lib/env-names';
import { ErrorBox, When } from '@/features/admin/ui';
import { useAdmin, useAdminAction } from '@/features/admin/lib';
import { Gate, useAdminRole } from '@/features/admin/role';
import { ToneBadge } from '@/features/records/detail-page';
import { ToolbarAction } from '@/features/tabs/tab-action';

// ---------------------------------------------------------------- the shapes (src/agent-profile-spec.ts)

type Key = { kind: 'workspace'; name: string } | { kind: 'platform'; provider: string; label: string; env: string };
interface Upload { id: string; path: string; bytes: number; sha256: string; executable: boolean }
interface WebPolicy { enabled: boolean; web_search_enabled: boolean; web_fetch_enabled: boolean; web_fetch_allowed_domains: string[]; max_calls: number }
interface Exception { domain: string; reason: string; expires_at: string; approved_by?: string }
interface Governance { web?: WebPolicy; egress_approvals?: boolean; tools?: { allowed: string[]; max_calls: number } | null; exceptions?: Exception[]; retention_days?: number | null }
export interface ProfileConfig { harness?: string | null; inference?: { provider: string; model: string; key?: string | null } | null; keys?: Key[]; uploads?: Upload[]; governance?: Governance | null }
interface Summary {
  id: string; name: string; description: string; version: number; status: 'active' | 'archived'; source: 'platform' | 'pack'; pack: string | null; is_default: boolean;
  harness: string; model: string; provider: string; keys: number; uploads: number; upload_bytes: number; governance: string; sessions: number; updated_at: string; updated_by: string;
}
interface Detail extends Summary { config: ProfileConfig; changes: { id: number; version: number; action: string; by: string; at: string }[] }
interface Facts {
  harnesses: { id: string; label: string; providers: string[] }[];
  providers: { id: string; name: string; keys: { label: string; hint: string; enabled: boolean }[] }[];
  models: string[];
  keys: { workspace: { name: string; label: string }[]; platform: { provider: string; provider_name: string; label: string; hint: string; enabled: boolean }[] };
  tools: { name: string; title: string | null; read: boolean }[];
  upload_max_bytes: number; part_bytes: number; retention_days_max: number; exception_days_max: number;
  settings: { harness: string; provider: string; model: string; web_tools: string; web_calls_max: number };
}
interface ListAnswer extends Facts { profiles: Summary[] }

const BASE = '/agent-profiles';
const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.ceil(n / 1024)} KB` : `${n} B`);

// ---------------------------------------------------------------- the list

/** Admin › Agent profiles: the four cards, the search row with New profile, the table; a row opens its modal. */
export function AgentProfilesPage() {
  const { data, error, isLoading } = useAdmin<ListAnswer>(BASE);
  const [open, setOpen] = useQueryState('profile');
  const rows = data?.profiles ?? [];
  const cols: RecordCol<Summary>[] = [
    { key: 'name', label: 'Profile', title: true, keep: true, type: 'text', className: 'min-w-60', value: (p) => p.name,
      render: (p) => <span className='flex min-w-0 flex-col gap-1'><span className='leading-snug font-medium'>{p.name}</span>{p.description && <span className='text-muted-foreground line-clamp-2 text-xs whitespace-normal'>{p.description}</span>}</span> },
    { key: 'status', label: 'Status', type: 'select', keep: true, options: [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }], value: (p) => p.status, render: (p) => <StatusBadges p={p} /> },
    { key: 'harness', label: 'Harness', type: 'text', value: (p) => p.harness, render: (p) => p.harness },
    { key: 'model', label: 'Model', type: 'text', value: (p) => p.model, render: (p) => <span className='font-mono text-xs'>{p.model}</span> },
    { key: 'keys', label: 'Keys', type: 'number', value: (p) => p.keys, render: (p) => <span className='tabular-nums'>{p.keys}</span> },
    { key: 'uploads', label: 'Uploads', type: 'number', value: (p) => p.uploads, render: (p) => <span className='tabular-nums'>{p.uploads ? `${p.uploads} (${size(p.upload_bytes)})` : '0'}</span> },
    { key: 'governance', label: 'Governance', type: 'text', value: (p) => p.governance, render: (p) => <span className='text-xs whitespace-normal'>{p.governance}</span> },
    { key: 'sessions', label: 'Sessions', type: 'number', value: (p) => p.sessions, render: (p) => <span className='tabular-nums'>{p.sessions.toLocaleString('en')}</span> },
    { key: 'version', label: 'Version', type: 'number', value: (p) => p.version, render: (p) => <span className='tabular-nums'>{p.version}</span> },
    { key: 'updated', label: 'Changed', type: 'date', keep: true, value: (p) => p.updated_at, render: (p) => <When d={p.updated_at} /> }
  ];
  const active = rows.filter((p) => p.status === 'active');
  return (
    <PageContainer>
      <ErrorBox error={error} />
      <RecordView<Summary>
        id='admin-agent-profiles' noun={rows.length === 1 ? 'profile' : 'profiles'} loading={isLoading}
        rows={rows} rowKey={(p) => p.id} cols={cols} panelKind='editor' detailTitle={(p) => p.name}
        // mold_v0-278: a row opens its profile's editor in the panel beside the list (?profile=<id>); New profile stays the modal.
        openKey={open && open !== 'new' ? open : null} onOpenChange={(k) => void setOpen(k)}
        detail={(p) => data ? <ProfileEditor key={p.id} id={p.id} facts={data} onClose={() => void setOpen(null)} /> : null}
        defaultSort={[{ key: 'name', dir: 'asc' }]}
        summary={<StatStrip quad items={[
          { label: 'Active profiles', value: active.length, said: `${active.length} active profiles` },
          { label: 'From packs', value: rows.filter((p) => p.source === 'pack').length, said: `${rows.filter((p) => p.source === 'pack').length} profiles brought by the app's packs` },
          { label: 'Archived', value: rows.length - active.length, said: `${rows.length - active.length} archived profiles` },
          { label: 'Sessions started', value: rows.reduce((t, p) => t + p.sessions, 0).toLocaleString('en'), said: `${rows.reduce((t, p) => t + p.sessions, 0)} sessions started with these profiles` }
        ]} />}
        searchText={(p) => `${p.name} ${p.id} ${p.description} ${p.model} ${p.harness} ${p.pack ?? ''} ${p.status}`} searchPlaceholder='Search profiles'
        toolbarAction={<div className='ml-auto flex shrink-0 gap-2'><Gate need='compute'><NewButton onClick={() => void setOpen('new')} /></Gate></div>}
        exportName='agent-profiles'
        empty={<p className='text-muted-foreground text-sm'>No profiles yet: the Default profile appears once the workspace agent is used.</p>}
      />
      {data && open === 'new' && <ProfileModal key={open} id={open === 'new' ? null : open} facts={data} onClose={() => void setOpen(null)} />}
    </PageContainer>
  );
}

/** The search row's primary button, disabled (by Gate) for a role that may not change profiles. */
function NewButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return disabled ? <Button disabled aria-label='New profile' title='New profile' className='ml-auto shrink-0 max-sm:w-8 max-sm:px-0'><Icons.add /><span className='hidden sm:inline'>New profile</span></Button>
    : <ToolbarAction label='New profile' icon={<Icons.add />} onClick={onClick} />;
}

function StatusBadges({ p }: { p: Pick<Summary, 'status' | 'is_default' | 'source' | 'pack'> }) {
  return (
    <span className='flex flex-wrap items-center gap-1.5' data-profile-status={p.status}>
      <ToneBadge color={p.status === 'active' ? 'success' : 'neutral'}>{p.status === 'active' ? 'Active' : 'Archived'}</ToneBadge>
      {p.is_default && <ToneBadge color='info'>Default</ToneBadge>}
      {p.source === 'pack' && <Badge variant='outline' className='font-normal'>From {p.pack}</Badge>}
    </span>
  );
}

// ---------------------------------------------------------------- the one modal

type Rule = { id: number; type: 'website' | 'tool' | 'exception'; value: string; reason: string; until: string };
type FileRow = Upload & { row: number; progress: number | null; error: string | null };
let seq = 0;
const next = () => ++seq;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

/** One profile (or a new one) in one modal: its five items, inline rows, Save and Cancel at the bottom. */
/** A profile's editor in its list's record panel (mold_v0-278). */
function ProfileEditor({ id, facts, onClose }: { id: string; facts: Facts; onClose: () => void }) {
  const { data, error } = useAdmin<{ profile: Detail }>(`${BASE}/${encodeURIComponent(id)}`);
  const p = data?.profile ?? null;
  if (error) return <ErrorBox error={error} />;
  if (!p) return <p className='text-muted-foreground text-sm'>Loading the profile…</p>;
  return <div data-agent-profile-panel={id}><ProfileForm key={`${p.id}@${p.version}`} profile={p} facts={facts} onClose={onClose} /></div>;
}

function ProfileModal({ id, facts, onClose }: { id: string | null; facts: Facts; onClose: () => void }) {
  const { data, error } = useAdmin<{ profile: Detail }>(id ? `${BASE}/${encodeURIComponent(id)}` : null);
  const p = data?.profile ?? null;
  const loading = !!id && !p && !error;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl' data-agent-profile-modal={id ?? 'new'} onKeyDown={keepTabInside}>
        {error ? <ErrorBox error={error} /> : loading ? <p className='text-muted-foreground text-sm'>Loading the profile…</p>
          : <ProfileForm key={p ? `${p.id}@${p.version}` : 'new'} profile={p} facts={facts} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

/** Tab wraps inside the modal (focus never leaves it for the page behind), as the Start a session dialog does. */
function keepTabInside(e: KeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'Tab') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter((x) => x.getClientRects().length > 0);
  if (!items.length) return;
  const first = items[0]!, last = items[items.length - 1]!, at = document.activeElement;
  if (e.shiftKey ? at === first || !e.currentTarget.contains(at) : at === last) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
}

function rulesOf(g: Governance | null | undefined): Rule[] {
  return [
    ...(g?.web?.web_fetch_allowed_domains ?? []).map((d) => ({ id: next(), type: 'website' as const, value: d, reason: '', until: '' })),
    ...(g?.tools?.allowed ?? []).map((t) => ({ id: next(), type: 'tool' as const, value: t, reason: '', until: '' })),
    ...(g?.exceptions ?? []).map((e) => ({ id: next(), type: 'exception' as const, value: e.domain, reason: e.reason, until: e.expires_at.slice(0, 10) })),
  ];
}

function ProfileForm({ profile, facts, onClose }: { profile: Detail | null; facts: Facts; onClose: () => void }) {
  const { can } = useAdminRole();
  const editable = can('compute') && profile?.status !== 'archived';
  const c = profile?.config ?? {};
  const g = c.governance ?? null;
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [harness, setHarness] = useState(c.harness ?? '');
  const [provider, setProvider] = useState(c.inference?.provider ?? '');
  const [model, setModel] = useState(c.inference?.model ?? '');
  const [inferenceKey, setInferenceKey] = useState(c.inference?.key ?? '');
  const [keys, setKeys] = useState<(Key & { row: number })[]>(() => (c.keys ?? []).map((k) => ({ ...k, row: next() })));
  const [files, setFiles] = useState<FileRow[]>(() => (c.uploads ?? []).map((u) => ({ ...u, row: next(), progress: null, error: null })));
  const [governed, setGoverned] = useState(!!g);
  const [search, setSearch] = useState(!!g?.web?.web_search_enabled);
  const [fetchOn, setFetchOn] = useState(!!g?.web?.web_fetch_enabled);
  const [calls, setCalls] = useState(String(g?.web?.max_calls || facts.settings.web_calls_max || 20));
  const [asks, setAsks] = useState(g?.egress_approvals !== false);
  const [rules, setRules] = useState<Rule[]>(() => rulesOf(g));
  const [toolCalls, setToolCalls] = useState(String(g?.tools?.max_calls ?? 100));
  const [retention, setRetention] = useState(g?.retention_days ? String(g.retention_days) : '');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const providers = useMemo(() => {
    const h = facts.harnesses.find((x) => x.id === (harness || facts.settings.harness));
    return facts.providers.filter((x) => !h || h.providers.includes(x.id));
  }, [facts, harness]);
  const providerKeys = facts.providers.find((x) => x.id === provider)?.keys ?? [];
  const uploading = files.some((f) => f.progress !== null);
  const total = files.reduce((t, f) => t + f.bytes, 0);

  // ---- uploads: each file in parts, its row showing its progress; a folder keeps its files' paths
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const chosen = [...list];
    if (chosen.reduce((t, f) => t + f.size, total) > facts.upload_max_bytes) { setProblem(`Those files would make ${size(chosen.reduce((t, f) => t + f.size, total))}: a profile uploads at most ${size(facts.upload_max_bytes)} in all.`); return; }
    for (const file of chosen) {
      const row = next();
      const path = (file.webkitRelativePath || file.name).replace(/^\/+/, '');
      setFiles((fs) => [...fs, { row, id: '', path, bytes: file.size, sha256: '', executable: false, progress: 0, error: null }]);
      try {
        const { upload } = await adminApi<{ upload: { id: string; parts: number; part_bytes: number } }>('POST', `${BASE}/uploads`, { bytes: file.size });
        for (let n = 0; n < upload.parts; n++) {
          const part = file.slice(n * upload.part_bytes, Math.min(file.size, (n + 1) * upload.part_bytes));
          const res = await fetch(`/api/admin/onboarding${BASE}/uploads/${upload.id}/parts/${n}`, { method: 'PUT', credentials: 'same-origin', body: part,
            headers: { accept: 'application/json', 'content-type': 'application/octet-stream', ...ADMIN_HEADERS } });
          if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `The upload stopped (${res.status}).`);
          setFiles((fs) => fs.map((f) => (f.row === row ? { ...f, progress: Math.round(((n + 1) / upload.parts) * 100) } : f)));
        }
        const done = await adminApi<{ upload: { id: string; sha256: string; bytes: number; executable: boolean } }>('POST', `${BASE}/uploads/${upload.id}/complete`, {});
        setFiles((fs) => fs.map((f) => (f.row === row ? { ...f, id: done.upload.id, sha256: done.upload.sha256, bytes: done.upload.bytes, executable: done.upload.executable, progress: null } : f)));
      } catch (e) {
        setFiles((fs) => fs.map((f) => (f.row === row ? { ...f, progress: null, error: (e as Error).message } : f)));
      }
    }
  };

  // ---- the config as the server takes it
  const configOf = (): ProfileConfig => {
    const sites = rules.filter((r) => r.type === 'website').map((r) => r.value.trim()).filter(Boolean);
    const tools = rules.filter((r) => r.type === 'tool').map((r) => r.value.trim()).filter(Boolean);
    const exceptions = rules.filter((r) => r.type === 'exception' && r.value.trim()).map((r) => ({ domain: r.value.trim(), reason: r.reason.trim(), expires_at: r.until ? new Date(`${r.until}T23:59:59Z`).toISOString() : '' }));
    const enabled = search || fetchOn;
    return {
      ...(harness ? { harness } : {}),
      ...(provider && model ? { inference: { provider, model, ...(inferenceKey ? { key: inferenceKey } : {}) } } : {}),
      ...(keys.length ? { keys: keys.map(({ row: _r, ...k }) => k as Key) } : {}),
      ...(files.length ? { uploads: files.filter((f) => f.id).map((f) => ({ id: f.id, path: f.path.trim(), bytes: f.bytes, sha256: f.sha256, executable: f.executable })) } : {}),
      ...(governed ? { governance: {
        web: { enabled, web_search_enabled: search, web_fetch_enabled: fetchOn, web_fetch_allowed_domains: fetchOn ? sites : [], max_calls: enabled ? Number(calls) || 0 : 0 },
        egress_approvals: asks,
        ...(tools.length ? { tools: { allowed: tools, max_calls: Number(toolCalls) || 0 } } : {}),
        ...(exceptions.length ? { exceptions } : {}),
        ...(retention ? { retention_days: Number(retention) } : {}),
      } } : {}),
    };
  };
  const save = useAdminAction(async () => {
    const body = { name, description, config: configOf() };
    return profile ? adminApi('PUT', `${BASE}/${encodeURIComponent(profile.id)}`, { ...body, version: profile.version }) : adminApi('POST', BASE, body);
  }, { success: profile ? 'Saved as a new version' : 'Profile created (version 1)' });
  const submit = async () => {
    setProblem(null);
    if (files.some((f) => f.error)) { setProblem('A file did not upload: remove it, or add it again.'); return; }
    setBusy(true);
    try { await save.mutateAsync(); onClose(); }
    catch (e) { setProblem((e as Error).message); }
    finally { setBusy(false); }
  };
  const archive = useAdminAction((on: boolean) => adminApi('POST', `${BASE}/${encodeURIComponent(profile!.id)}/${on ? 'archive' : 'restore'}`), { success: (r: { profile: Detail }) => (r.profile.status === 'archived' ? 'Archived: no new session starts with it' : 'Restored') });
  const ro = !editable;

  return (
    <form className='grid gap-5' onSubmit={(e) => { e.preventDefault(); void submit(); }} data-agent-profile-form=''>
      <DialogHeader>
        <DialogTitle>{profile ? profile.name : 'New profile'}</DialogTitle>
        <DialogDescription>
          {profile ? `Version ${profile.version}${profile.source === 'pack' ? `, brought by ${profile.pack}` : ''}. Saving makes version ${profile.version + 1}; sessions already running keep theirs.` : 'Saved as version 1.'} Anything left unset is the platform setting; budgets, turns and limits are always the platform&apos;s.
        </DialogDescription>
      </DialogHeader>
      <div className='grid gap-3 sm:grid-cols-2'>
        <Field label='Name' htmlFor='ap-name'><Input id='ap-name' value={name} onChange={(e) => setName(e.target.value)} disabled={ro || !!profile?.is_default} required maxLength={80} /></Field>
        <Field label='Description' htmlFor='ap-description'><Input id='ap-description' value={description} onChange={(e) => setDescription(e.target.value)} disabled={ro} maxLength={500} /></Field>
      </div>

      <Part n={1} title='Harness' hint='Which agent program runs the session. Only the ones this platform has pinned are offered.'>
        <NativeSelect id='ap-harness' aria-label='Harness' value={harness} onChange={(e) => setHarness(e.target.value)} disabled={ro} data-ap-harness=''>
          <NativeSelectOption value=''>Platform setting ({facts.harnesses.find((h) => h.id === facts.settings.harness)?.label ?? facts.settings.harness})</NativeSelectOption>
          {facts.harnesses.map((h) => <NativeSelectOption key={h.id} value={h.id}>{h.label}</NativeSelectOption>)}
        </NativeSelect>
      </Part>

      <Part n={2} title='Key vault' hint='The primary inference provider sets the model and the key the gateway uses. Keys added below are given to each session, hidden from everything it writes.'>
        <div className='grid gap-3 sm:grid-cols-3' data-ap-inference=''>
          <Field label='Inference provider' htmlFor='ap-provider'>
            <NativeSelect id='ap-provider' value={provider} onChange={(e) => { setProvider(e.target.value); setInferenceKey(''); if (!e.target.value) setModel(''); else if (!model) setModel(facts.settings.model); }} disabled={ro}>
              <NativeSelectOption value=''>Platform setting ({facts.settings.provider}, {facts.settings.model})</NativeSelectOption>
              {providers.map((x) => <NativeSelectOption key={x.id} value={x.id}>{x.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field label='Model' htmlFor='ap-model'>
            <NativeSelect id='ap-model' value={model} onChange={(e) => setModel(e.target.value)} disabled={ro || !provider}>
              {!provider && <NativeSelectOption value=''>The provider&apos;s</NativeSelectOption>}
              {facts.models.map((m) => <NativeSelectOption key={m} value={m}>{m}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
          <Field label='Its key' htmlFor='ap-inference-key'>
            <NativeSelect id='ap-inference-key' value={inferenceKey} onChange={(e) => setInferenceKey(e.target.value)} disabled={ro || !provider}>
              <NativeSelectOption value=''>The provider&apos;s default key</NativeSelectOption>
              {providerKeys.map((k) => <NativeSelectOption key={k.label} value={k.label} disabled={!k.enabled}>{k.label} ({k.hint}){k.enabled ? '' : ', off'}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </div>
        <Rows label='Keys given to each session' empty='No keys: the session gets only the gateway.' data='ap-keys'>
          {keys.map((k) => (
            <Row key={k.row} onRemove={ro ? undefined : () => setKeys((ks) => ks.filter((x) => x.row !== k.row))} what={k.kind === 'workspace' ? k.name : `${k.provider}/${k.label}`}>
              <NativeSelect aria-label='Kind of key' value={k.kind} disabled={ro} className='w-40'
                onChange={(e) => setKeys((ks) => ks.map((x): Key & { row: number } => (x.row !== k.row ? x : e.target.value === 'workspace' ? { row: x.row, kind: 'workspace' as const, name: facts.keys.workspace[0]?.name ?? '' } : { row: x.row, kind: 'platform' as const, provider: facts.keys.platform[0]?.provider ?? '', label: facts.keys.platform[0]?.label ?? '', env: '' })))}>
                <NativeSelectOption value='workspace'>Workspace credential</NativeSelectOption>
                <NativeSelectOption value='platform'>Platform key</NativeSelectOption>
              </NativeSelect>
              {k.kind === 'workspace' ? (
                <NativeSelect aria-label='Workspace credential' value={k.name} disabled={ro} className='min-w-0 flex-1' onChange={(e) => setKeys((ks) => ks.map((x) => (x.row === k.row ? { ...x, name: e.target.value } : x)))}>
                  {!facts.keys.workspace.some((w) => w.name === k.name) && <NativeSelectOption value={k.name}>{k.name || 'Choose one'}</NativeSelectOption>}
                  {facts.keys.workspace.map((w) => <NativeSelectOption key={w.name} value={w.name}>{w.label} ({w.name})</NativeSelectOption>)}
                </NativeSelect>
              ) : (<>
                <NativeSelect aria-label='Platform key' value={`${k.provider}/${k.label}`} disabled={ro} className='min-w-0 flex-1'
                  onChange={(e) => { const [pv, ...lb] = e.target.value.split('/'); setKeys((ks) => ks.map((x) => (x.row === k.row ? { ...x, provider: pv!, label: lb.join('/') } : x))); }}>
                  {!facts.keys.platform.some((v) => v.provider === k.provider && v.label === k.label) && <NativeSelectOption value={`${k.provider}/${k.label}`}>{k.provider ? `${k.provider} ${k.label}` : 'Choose one'}</NativeSelectOption>}
                  {facts.keys.platform.map((v) => <NativeSelectOption key={`${v.provider}/${v.label}`} value={`${v.provider}/${v.label}`}>{v.provider_name}: {v.label} ({v.hint})</NativeSelectOption>)}
                </NativeSelect>
                <Input aria-label='In the variable' placeholder='VARIABLE_NAME' value={k.env} disabled={ro} className='w-44 font-mono'
                  onChange={(e) => setKeys((ks) => ks.map((x) => (x.row === k.row ? { ...x, env: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))} />
              </>)}
            </Row>
          ))}
        </Rows>
        {!ro && <AddButton label='Add key' data='ap-add-key' onClick={() => setKeys((ks) => [...ks, facts.keys.workspace.length ? { row: next(), kind: 'workspace' as const, name: facts.keys.workspace[0]!.name } : { row: next(), kind: 'platform' as const, provider: facts.keys.platform[0]?.provider ?? '', label: facts.keys.platform[0]?.label ?? '', env: '' }])} />}
      </Part>

      <Part n={3} title='Workspace upload' hint={`Files and folders written into each session's workspace, programs it needs included (made executable there). At most ${size(facts.upload_max_bytes)} in all.`}>
        <Rows label={`Files${files.length ? ` (${files.length}, ${size(total)})` : ''}`} empty='Nothing uploaded: the session starts with an empty workspace.' data='ap-files'>
          {files.map((f) => (
            <Row key={f.row} onRemove={ro ? undefined : () => setFiles((fs) => fs.filter((x) => x.row !== f.row))} what={f.path}>
              <Input aria-label='Path in the workspace' value={f.path} disabled={ro} className='min-w-0 flex-1 font-mono text-xs' onChange={(e) => setFiles((fs) => fs.map((x) => (x.row === f.row ? { ...x, path: e.target.value } : x)))} />
              <span className='text-muted-foreground w-20 shrink-0 text-right text-xs tabular-nums'>{f.progress !== null ? `${f.progress}%` : f.error ? 'Failed' : size(f.bytes)}</span>
              <label className='flex shrink-0 items-center gap-1.5 text-xs'>
                <Checkbox checked={f.executable} disabled={ro || f.progress !== null} onCheckedChange={(v) => setFiles((fs) => fs.map((x) => (x.row === f.row ? { ...x, executable: v === true } : x)))} aria-label={`Executable: ${f.path}`} />Executable
              </label>
              {f.error && <span className='text-destructive basis-full text-xs'>{f.error}</span>}
            </Row>
          ))}
        </Rows>
        {!ro && <div className='flex flex-wrap gap-2'>
          <input ref={fileInput} type='file' multiple className='sr-only' tabIndex={-1} aria-label='Choose files' onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          <input ref={folderInput} type='file' multiple className='sr-only' tabIndex={-1} aria-label='Choose a folder' {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          <AddButton label='Add files' data='ap-add-files' onClick={() => fileInput.current?.click()} />
          <AddButton label='Add folder' data='ap-add-folder' onClick={() => folderInput.current?.click()} />
        </div>}
      </Part>

      <Part n={4} title='Governance policy' hint='What the session may reach and use, who decides what it asks for, and how long its conversation is kept. Off: the platform settings.'>
        <label className='flex items-center gap-2 text-sm'><Checkbox checked={governed} disabled={ro} onCheckedChange={(v) => setGoverned(v === true)} data-ap-governed='' />This profile has its own governance policy</label>
        {governed && <div className='grid gap-3' data-ap-governance=''>
          <div className='flex flex-wrap items-center gap-x-5 gap-y-2 text-sm'>
            <label className='flex items-center gap-2'><Checkbox checked={search} disabled={ro} onCheckedChange={(v) => setSearch(v === true)} />Web search</label>
            <label className='flex items-center gap-2'><Checkbox checked={fetchOn} disabled={ro} onCheckedChange={(v) => setFetchOn(v === true)} />Web fetch (the websites below)</label>
            <label className='flex items-center gap-2'>Web calls at most<Input aria-label='Web calls at most' type='number' min={1} max={100} value={calls} disabled={ro || !(search || fetchOn)} onChange={(e) => setCalls(e.target.value)} className='w-20' /></label>
          </div>
          <label className='flex items-center gap-2 text-sm'><Checkbox checked={asks} disabled={ro} onCheckedChange={(v) => setAsks(v === true)} />Ask a workspace owner before an unlisted website or package download (else refuse it)</label>
          <Rows label='Rules' empty='No rules: no website is listed, and the app’s tools follow the platform setting.' data='ap-rules'>
            {rules.map((r) => (
              <Row key={r.id} onRemove={ro ? undefined : () => setRules((rs) => rs.filter((x) => x.id !== r.id))} what={r.value || 'this rule'}>
                <NativeSelect aria-label='Kind of rule' value={r.type} disabled={ro} className='w-40'
                  onChange={(e) => setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, type: e.target.value as Rule['type'], value: e.target.value === 'tool' ? facts.tools[0]?.name ?? '' : '', until: e.target.value === 'exception' ? inDays(30) : '' } : x)))}>
                  <NativeSelectOption value='website'>Allow a website</NativeSelectOption>
                  <NativeSelectOption value='tool'>Allow an app tool</NativeSelectOption>
                  <NativeSelectOption value='exception'>Exception (until a date)</NativeSelectOption>
                </NativeSelect>
                {r.type === 'tool' ? (
                  <NativeSelect aria-label='App tool' value={r.value} disabled={ro} className='min-w-0 flex-1' onChange={(e) => setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))}>
                    {!facts.tools.some((t) => t.name === r.value) && <NativeSelectOption value={r.value}>{r.value || 'Choose one'}</NativeSelectOption>}
                    {facts.tools.map((t) => <NativeSelectOption key={t.name} value={t.name}>{t.title ? `${t.title} (${t.name})` : t.name}</NativeSelectOption>)}
                  </NativeSelect>
                ) : (
                  <Input aria-label={r.type === 'website' ? 'Website' : 'Exception host'} placeholder={r.type === 'website' ? 'docs.example.com, *.example.com or *' : 'host.example.com'} value={r.value} disabled={ro}
                    className='min-w-0 flex-1 font-mono text-xs' onChange={(e) => setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)))} />
                )}
                {r.type === 'exception' && <>
                  <Input aria-label='Why' placeholder='Why (kept with it)' value={r.reason} disabled={ro} className='min-w-40 flex-1' onChange={(e) => setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, reason: e.target.value } : x)))} />
                  <Input aria-label='Until' type='date' value={r.until} disabled={ro} max={inDays(facts.exception_days_max)} className='w-40' onChange={(e) => setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, until: e.target.value } : x)))} />
                </>}
              </Row>
            ))}
          </Rows>
          {!ro && <AddButton label='Add rule' data='ap-add-rule' onClick={() => setRules((rs) => [...rs, { id: next(), type: 'website', value: '', reason: '', until: '' }])} />}
          <div className='flex flex-wrap items-center gap-x-5 gap-y-2 text-sm'>
            {rules.some((r) => r.type === 'tool') && <label className='flex items-center gap-2'>App tool calls a wake at most<Input aria-label='App tool calls a wake at most' type='number' min={1} max={1000} value={toolCalls} disabled={ro} onChange={(e) => setToolCalls(e.target.value)} className='w-24' /></label>}
            <label className='flex items-center gap-2'>Keep conversations for<Input aria-label='Keep conversations for (days)' type='number' min={1} max={facts.retention_days_max} placeholder={String(facts.retention_days_max)} value={retention} disabled={ro} onChange={(e) => setRetention(e.target.value)} className='w-24' />days (at most the platform&apos;s {facts.retention_days_max})</label>
          </div>
        </div>}
      </Part>

      {problem && <p role='alert' className='border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm' data-ap-problem=''>{problem}</p>}
      <DialogFooter className='items-center gap-2 sm:justify-between'>
        <span className='text-muted-foreground text-xs'>
          {profile && !profile.is_default && can('compute') && (
            <Button type='button' variant='outline' size='sm' onClick={() => archive.mutate(profile.status === 'active', { onSuccess: onClose })} data-ap-archive=''>
              {profile.status === 'active' ? 'Archive' : 'Restore'}
            </Button>
          )}
          {profile && profile.changes[0] && <span className='ml-2'>Last change: {profile.changes[0].action} by {profile.changes[0].by}</span>}
        </span>
        <span className='flex gap-2'>
          <Button type='button' variant='outline' onClick={onClose} data-ap-cancel=''>Cancel</Button>
          {editable && <Button type='submit' variant='outline' disabled={busy || uploading} data-ap-save=''>{busy ? 'Saving…' : 'Save'}</Button>}
        </span>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------- the modal's pieces

function Part({ n, title, hint, children }: { n: number; title: string; hint: string; children: ReactNode }) {
  return (
    <fieldset className='grid gap-3 border-t pt-4' data-ap-part={n}>
      <legend className='sr-only'>{title}</legend>
      <div><h3 className='text-sm font-semibold'>{title}</h3><p className='text-muted-foreground text-xs'>{hint}</p></div>
      {children}
    </fieldset>
  );
}
function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return <div className='grid min-w-0 gap-1.5'><label htmlFor={htmlFor} className='text-xs font-medium'>{label}</label>{children}</div>;
}
function Rows({ label, empty, data, children }: { label: string; empty: string; data: string; children: ReactNode[] }) {
  return (
    <div className='grid gap-2' {...{ [`data-${data}`]: '' }}>
      <span className='text-xs font-medium'>{label}</span>
      {children.length ? <ul className='grid gap-2'>{children}</ul> : <p className='text-muted-foreground text-xs'>{empty}</p>}
    </div>
  );
}
function Row({ what, onRemove, children }: { what: string; onRemove?: () => void; children: ReactNode }) {
  return (
    <li className='flex flex-wrap items-center gap-2 rounded-md border p-2' data-ap-row=''>
      {children}
      {onRemove && <Button type='button' variant='outline' size='icon-sm' aria-label={`Remove ${what}`} title='Remove' onClick={onRemove}><Icons.close /></Button>}
    </li>
  );
}
function AddButton({ label, data, onClick }: { label: string; data: string; onClick: () => void }) {
  return <Button type='button' variant='outline' size='sm' className='justify-self-start' onClick={onClick} {...{ [`data-${data}`]: '' }}><Icons.add />{label}</Button>;
}

