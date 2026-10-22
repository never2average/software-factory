'use client';
/**
 * The consent screen of the built-in MCP authorization server (mold_v0-013; the API server's /oauth/authorize sends the
 * browser here with ?request=<id>, src/mcp-oauth.ts). Signed out, it sends the person to sign in and back. It names the
 * app (verified when it is a metadata-document client), where the app sends the person back, and the workspace the
 * app will act in; Allow and Deny answer the API, which hands back the app's redirect. The page refuses to work inside
 * a frame (and the server forbids framing it), so another site cannot overlay it to steal a click.
 */
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { profile } from '@/config/profile.generated';

interface ConsentView {
  client: { name: string | null; verified: boolean; id_host: string | null };
  redirect: { scheme: string; host: string | null };
  scope: string[];
  workspaces: { id: string; name: string; role: string }[];
  default_workspace: string | null;
}

const REQUEST = /^[A-Za-z0-9_-]{43}$/;

function Consent() {
  const params = useSearchParams();
  const id = params.get('request') ?? '';
  const [view, setView] = useState<ConsentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [framed, setFramed] = useState(false);

  useEffect(() => {
    if (window.top !== window.self) { setFramed(true); return; }
    if (!REQUEST.test(id)) { setError('This sign-in request is not valid. Go back to the app and connect again.'); return; }
    void (async () => {
      const r = await fetch(`/api/oauth/requests/${id}`, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
      if (r?.status === 401) {
        window.location.href = `/auth/sign-in?redirect_url=${encodeURIComponent(`/auth/consent?request=${id}`)}`;
        return;
      }
      const j = (await r?.json().catch(() => null)) as (ConsentView & { error?: string }) | null;
      if (!r?.ok || !j) { setError(j?.error ?? 'This sign-in request could not be read. Go back to the app and connect again.'); return; }
      setView(j);
      setWorkspace(j.default_workspace ?? j.workspaces[0]?.id ?? '');
    })();
  }, [id]);

  const answer = async (decision: 'allow' | 'deny') => {
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/oauth/requests/${id}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Pack-Request': '1' },
        body: JSON.stringify({ decision, workspace })
      });
      const j = (await r.json().catch(() => ({}))) as { redirect?: string; error?: string };
      if (!r.ok || !j.redirect) throw new Error(j.error || `Request failed (${r.status})`);
      window.location.href = j.redirect;
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  if (framed) return <p role='alert' className='text-destructive text-sm'>Open this page in its own window to continue.</p>;
  const app = view?.client.name ?? 'An app';
  return (
    <Card className='w-full max-w-sm'>
      <CardHeader>
        <CardTitle>Allow {app} to use {profile.name}?</CardTitle>
        <CardDescription>
          {view ? (view.client.verified
            ? <>The app is identified by <strong>{view.client.id_host}</strong>.</>
            : <>This name was given by the app itself and is <strong>not verified</strong>. Only continue if you just asked to connect it.</>) : 'Loading…'}
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {error && <p role='alert' className='text-destructive text-sm'>{error}</p>}
        {view && (
          <>
            <p className='text-sm'>
              It will act as you, with your role, in the workspace you pick, until you or it disconnects. Afterwards you go back to{' '}
              <strong>{view.redirect.host ?? `the ${view.redirect.scheme} app`}</strong>.
            </p>
            {view.workspaces.length ? (
              <div className='flex flex-col gap-2'>
                <Label htmlFor='workspace'>Workspace</Label>
                <NativeSelect id='workspace' value={workspace} onChange={(e) => setWorkspace(e.target.value)} disabled={busy}>
                  {view.workspaces.map((w) => <NativeSelectOption key={w.id} value={w.id}>{w.name} ({w.role})</NativeSelectOption>)}
                </NativeSelect>
              </div>
            ) : <p className='text-sm'>You are not in any workspace yet, so there is nothing to connect.</p>}
            <div className='flex gap-2'>
              <Button type='button' onClick={() => void answer('allow')} disabled={busy || !workspace}>Allow</Button>
              <Button type='button' variant='outline' onClick={() => void answer('deny')} disabled={busy}>Deny</Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function BuiltinConsent() {
  return <Suspense fallback={null}><Consent /></Suspense>;
}
