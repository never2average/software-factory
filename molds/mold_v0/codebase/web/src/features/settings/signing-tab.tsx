'use client';
// Settings › Signing (mold_v0-219; the audit.sign flag of the features registry, src/ledger.ts): the workspace's signed
// checkpoints of its hash-chained audit trails (GET /api/ledger/checkpoints, owners only) and the public key they are
// signed with (/.well-known/ledger-keys.json), as the standard full-area table: four cards, the search row (Verify
// now, its primary action), the table, a checkpoint's full card. Never a signature's bytes; the hashes identify each.
import { useState } from 'react';
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { ErrorState, LoadingCards, When, useOrgLoad } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { ToolbarAction } from '@/features/tabs/tab-action';
import { Icons } from '@/components/icons';

interface Checkpoint { stream: string; n: number; from_seq: number; to_seq: number; entries: number; key_id: string; checkpoint_hash: string; merkle_root: string; signed_at: string }
interface View { checkpoints: Checkpoint[]; keys: { kid: string; alg: string; public_key: string; current: boolean }[]; keys_url: string; every_minutes: number }
interface Verify { ok: boolean; summary: string }

async function call<T>(path: string): Promise<T> {
  const res = await fetch(`/api/ledger${path}`, { credentials: 'same-origin', headers: { accept: 'application/json' } });
  const json = (await res.json().catch(() => ({}))) as T;
  if (!res.ok) throw httpError(res.status, json as { error?: string });
  return json;
}
const STREAM = (s: string) => (s === 'data' ? 'Data access' : s === 'platform' ? 'Requests' : s.startsWith('records:') ? `Records: ${s.slice(8)}` : s);
interface Row extends Checkpoint { key: string }
const COLUMNS: RecordCol<Row>[] = [
  { key: 'signed', label: 'Signed', title: true, keep: true, type: 'date', value: (r) => r.signed_at, render: (r) => <When d={r.signed_at} /> },
  { key: 'stream', label: 'Trail', type: 'text', keep: true, value: (r) => STREAM(r.stream), render: (r) => STREAM(r.stream) },
  { key: 'n', label: 'Checkpoint', type: 'number', value: (r) => r.n, render: (r) => `#${r.n}` },
  { key: 'entries', label: 'Entries', type: 'number', value: (r) => r.entries, render: (r) => `${r.entries} (${r.from_seq}–${r.to_seq})` },
  { key: 'key', label: 'Key', type: 'text', value: (r) => r.key_id, render: (r) => <span className='font-mono text-xs'>{r.key_id}</span> },
  { key: 'hash', label: 'Checkpoint hash', type: 'text', value: (r) => r.checkpoint_hash, render: (r) => <span className='font-mono text-xs'>{r.checkpoint_hash.slice(0, 16)}…</span> }
];

export function SigningTab() {
  const { data, error } = useOrgLoad(() => call<View>('/checkpoints'));
  const [verified, setVerified] = useState<Verify | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return (error as { status?: number }).status === 403 ? <p className='text-muted-foreground text-sm'>Only the workspace's owners see its signing.</p> : <ErrorState error={error} />;
  if (!data) return <LoadingCards count={2} />;
  const rows: Row[] = data.checkpoints.map((c) => ({ ...c, key: `${c.stream}:${c.n}` }));
  const current = data.keys.find((k) => k.current);
  const verify = async () => { setBusy(true); try { setVerified(await call<Verify>('/verify')); } catch (e) { setVerified({ ok: false, summary: (e as Error).message }); } finally { setBusy(false); } };
  return (
    <div className='flex flex-col gap-4'>
      <RecordView<Row>
        id='settings-signing' compact noun='checkpoints' properties
        rows={rows} rowKey={(r) => r.key} cols={COLUMNS}
        summary={<StatStrip quad items={[
          { label: 'Checkpoints', value: rows.length, said: `${rows.length} checkpoints` },
          { label: 'Entries signed', value: rows.reduce((n, r) => n + r.entries, 0), said: 'entries signed' },
          { label: 'Signing key', value: current?.kid ?? 'Not set', said: current ? `key ${current.kid}` : 'no signing key' },
          { label: 'Every', value: `${data.every_minutes} min`, said: `signed every ${data.every_minutes} minutes when there are new entries` }
        ]} />}
        searchText={(r) => `${STREAM(r.stream)} ${r.key_id} ${r.checkpoint_hash} ${r.n}`}
        searchPlaceholder='Search checkpoints'
        toolbarAction={<div className='ml-auto flex shrink-0'><ToolbarAction label={busy ? 'Verifying…' : 'Verify now'} icon={<Icons.shield />} onClick={() => void verify()} /></div>}
        empty={<p className='text-muted-foreground text-sm'>No checkpoint yet: the trails are signed every {data.every_minutes} minutes once they hold new entries.</p>}
        detailTitle={(r) => `${STREAM(r.stream)} #${r.n}`}
        detail={(r) => (
          <dl className='grid gap-3 text-sm'>
            <div><dt className='text-muted-foreground'>Signed</dt><dd><When d={r.signed_at} /> with key <span className='font-mono'>{r.key_id}</span></dd></div>
            <div><dt className='text-muted-foreground'>Entries</dt><dd>{r.entries}, numbers {r.from_seq} to {r.to_seq}</dd></div>
            <div><dt className='text-muted-foreground'>Merkle root</dt><dd className='font-mono text-xs break-all'>{r.merkle_root}</dd></div>
            <div><dt className='text-muted-foreground'>Checkpoint hash</dt><dd className='font-mono text-xs break-all'>{r.checkpoint_hash}</dd></div>
          </dl>
        )}
      />
      {verified && <p className={verified.ok ? 'text-sm text-emerald-700 dark:text-emerald-400' : 'text-destructive text-sm'} role='status'>{verified.ok ? 'Verified: ' : 'Not verified: '}{verified.summary}</p>}
      <p className='text-muted-foreground text-xs'>
        Public key{current ? <> <span className='font-mono'>{current.kid}</span> (Ed25519): <span className='font-mono break-all'>{current.public_key}</span></> : ': none set yet'}. Anyone can check a checkpoint offline with the keys at <a className='underline' href={data.keys_url}>{data.keys_url}</a>.
      </p>
    </div>
  );
}
