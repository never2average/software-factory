'use client';
// Operations › Emails (GET /emails, src/email.ts): every email Octillion tried to send through Resend, newest first,
// with what became of it (sent, skipped and why, failed and why). Addresses are never stored: the domain only. The
// cards are the last 24 hours, hour by hour. Owners can send a test email to an address typed in.
import { useState } from 'react';
import Link from 'next/link';
import PageContainer from '@/components/layout/page-container';
import { StatStrip } from '@/components/layout/section';
import { RecordView, type RecordCol, type RecordViewDef } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Icons } from '@/components/icons';
import { post, useAdmin, useAdminAction } from './lib';
import { Gate } from './role';
import { ErrorBox, FormRow, Mono, Notice, StatusBadge, When, type Tone } from './ui';

type Status = 'sending' | 'sent' | 'skipped' | 'failed';
interface EmailRow { id: number; at: string; kind: string; to_domain: string; subject: string; status: Status; provider_id: string | null; error: string | null; attempts: number; meta: Record<string, unknown> }
interface Data {
  rows: EmailRow[];
  status: { enabled: boolean; connected: boolean; from: string; reply_to: string | null };
  last_24h: { sent: number; failed: number; skipped: number };
  series: { sent: number[]; failed: number[]; skipped: number[] };
}

const TONE: Record<Status, Tone> = { sending: 'info', sent: 'ok', skipped: 'neutral', failed: 'bad' };
const KIND: Record<string, string> = {
  request_received: 'Request received', request_alert: 'Request alert', request_declined: 'Request declined', request_approved: 'Welcome',
  submission_alert: 'Submission alert', submission_accepted: 'Submission accepted', submission_declined: 'Submission declined',
  budget_80: 'Budget 80%', budget_100: 'Budget 100%', due_soon: 'Due soon', test: 'Test', sign_in_code: 'Sign-in code', invitation: 'Invitation'
};
const kindOf = (k: string) => KIND[k] ?? k;
const muted = (s: string) => <span className='text-muted-foreground'>{s}</span>;
const VIEWS: RecordViewDef<EmailRow>[] = [
  { id: 'all', label: 'All' },
  { id: 'sent', label: 'Sent', match: (r) => r.status === 'sent' },
  { id: 'failed', label: 'Failed', match: (r) => r.status === 'failed' },
  { id: 'skipped', label: 'Skipped', match: (r) => r.status === 'skipped' }
];

/** The email log; on its own page or as Compute's Emails tab (`embedded`: no page frame, the table fills the tab). */
export function AdminEmails({ embedded = false }: { embedded?: boolean }) {
  const { data, error, isLoading } = useAdmin<Data>('/emails', { refetchInterval: 30_000 });
  const [testing, setTesting] = useState(false);
  const s = data?.status;
  const attempts = data ? data.series.sent.map((v, i) => v + data.series.failed[i] + data.series.skipped[i]) : undefined;
  const cols: RecordCol<EmailRow>[] = [
    { key: 'at', label: 'When', type: 'date', className: 'w-32', keep: true, value: (r) => r.at, render: (r) => <When d={r.at} className='text-muted-foreground text-xs leading-none' /> },
    { key: 'kind', label: 'Kind', type: 'select', className: 'w-44', value: (r) => kindOf(r.kind), options: Object.values(KIND).map((v) => ({ value: v })), render: (r) => kindOf(r.kind) },
    { key: 'to', label: 'To', type: 'text', className: 'w-44', hidden: true, value: (r) => r.to_domain, render: (r) => muted(`…@${r.to_domain}`) },
    { key: 'subject', label: 'Subject', type: 'text', title: true, keep: true, value: (r) => r.subject, render: (r) => (<>
      <span className='block max-w-md truncate font-medium'>{r.subject}</span>
      <span className='text-muted-foreground block max-w-md truncate text-xs'>…@{r.to_domain}</span>
    </>) },
    { key: 'status', label: 'Status', type: 'select', className: 'w-28', keep: true, value: (r) => r.status,
      options: [{ value: 'sent', label: 'Sent' }, { value: 'skipped', label: 'Skipped' }, { value: 'failed', label: 'Failed' }, { value: 'sending', label: 'Sending' }],
      render: (r) => { const note = [(r.status === 'failed' || r.status === 'skipped') && r.error, r.attempts > 1 && `${r.attempts} tries`].filter(Boolean).join(' · '); return (<>
        <StatusBadge tone={TONE[r.status]}>{r.status}</StatusBadge>
        {note && <span className='text-muted-foreground mt-1 block max-w-40 truncate text-xs' title={r.error ?? undefined}>{note}</span>}
      </>); } },
    { key: 'error', label: 'Why', type: 'text', hidden: true, value: (r) => r.error, render: (r) => (r.error ? <span className='text-muted-foreground block max-w-sm truncate text-sm' title={r.error}>{r.error}</span> : muted('—')) },
    { key: 'attempts', label: 'Attempts', type: 'number', hidden: true, className: 'w-24 text-right', value: (r) => r.attempts, render: (r) => r.attempts },
    { key: 'provider_id', label: 'Resend id', type: 'text', hidden: true, value: (r) => r.provider_id, render: (r) => (r.provider_id ? <Mono>{r.provider_id}</Mono> : muted('—')) },
    { key: 'about', label: 'About', type: 'text', hidden: true, value: (r) => JSON.stringify(r.meta), render: (r) => <Mono>{Object.entries(r.meta ?? {}).map(([k, v]) => `${k}: ${String(v)}`).join(' · ') || '—'}</Mono> }
  ];
  const body = (
    <>
      <ErrorBox error={error} />
      {s && !s.enabled && <Notice>Emails are off: nothing is sent and each one is logged as skipped. Turn them on in <Link className='underline' href='/admin/configuration'>Agent configuration</Link> (Send emails).</Notice>}
      {s && s.enabled && !s.connected && <Notice>No Resend key: emails are logged as skipped. Add one to Resend in <Link className='underline' href='/admin/keys'>Key vault</Link>.</Notice>}
      <RecordView<EmailRow>
        id='admin-emails' noun='emails' exportName='emails' views={VIEWS} compact={embedded} defaultSort={[{ key: 'at', dir: 'desc' }]} initialSize={50}
        rows={data?.rows ?? []} rowKey={(r) => String(r.id)} cols={cols} loading={isLoading || !data}
        searchText={(r) => `${r.subject} ${kindOf(r.kind)} ${r.to_domain} ${r.status} ${r.error ?? ''}`} searchPlaceholder='Search emails by subject, kind or domain'
        summary={<StatStrip items={[
          { label: 'Sent, 24 h', spark: data?.series.sent, value: data ? data.last_24h.sent.toLocaleString() : '—' },
          { label: 'Failed, 24 h', spark: data?.series.failed, value: data ? data.last_24h.failed.toLocaleString() : '—' },
          { label: 'Skipped, 24 h', spark: data?.series.skipped, value: data ? data.last_24h.skipped.toLocaleString() : '—' },
          { label: 'Resend connected', spark: attempts, value: s ? (s.connected ? 'Yes' : 'No') : '—', href: '/admin/keys' }
        ]} />}
        primary={<Gate need='email'><Button onClick={() => setTesting(true)}><Icons.send /> Send test email</Button></Gate>}
        empty='No emails yet.'
      />
      {testing && <TestEmail from={s?.from ?? null} onClose={() => setTesting(false)} />}
    </>
  );
  return embedded ? <div className='flex min-w-0 flex-col gap-3'>{body}</div> : <PageContainer>{body}</PageContainer>;
}

function TestEmail({ from, onClose }: { from: string | null; onClose: () => void }) {
  const [to, setTo] = useState('');
  const [err, setErr] = useState('');
  const send = useAdminAction(() => post<{ status: string; error?: string | null }>('/emails/test', { to: to.trim() }),
    { success: (r) => (r.status === 'sent' ? `Test email sent to ${to.trim()}` : `Not sent (${r.status})${r.error ? `: ${r.error}` : ''}`) });
  const submit = (e: React.FormEvent) => { e.preventDefault(); setErr(''); send.mutate(undefined, { onSuccess: onClose, onError: (x) => setErr(x.message) }); };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form onSubmit={submit} className='grid gap-4'>
          <DialogHeader>
            <DialogTitle>Send test email</DialogTitle>
            <DialogDescription>One short email through Resend{from ? `, from ${from}` : ''}. It shows up in the log like any other.</DialogDescription>
          </DialogHeader>
          <FormRow id='te-to' label='To'><Input id='te-to' type='email' required autoFocus value={to} onChange={(e) => setTo(e.target.value)} /></FormRow>
          {err && <p className='text-destructive text-sm'>{err}</p>}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>Cancel</Button>
            <Button type='submit' disabled={send.isPending}>Send</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
