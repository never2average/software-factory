'use client';
/**
 * The built-in sign-in (mold_v0-004; the API server's /api/auth, src/builtin-auth.ts): an address, then the six-digit code
 * emailed to it; or Google when the server has a Google client. Invite-only: the same form signs up an invited person.
 * After signing in, the person goes back to the page that sent them here (a path on this site only).
 */
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { profile } from '@/config/profile.generated';
import { authPost } from '@/lib/auth/builtin-client';

/** A path on this site, else /app (the server checks again: src/builtin-auth.ts safeRedirect). */
const safePath = (v: string | null) => (v && v.startsWith('/') && !v.startsWith('//') && !/[\\\u0000-\u001f]/.test(v) ? v : '/app');

const ERRORS: Record<string, string> = {
  google_state: 'That Google sign-in expired or came from another browser. Try again.',
  google_cancelled: 'Google sign-in was cancelled.',
  google_failed: 'Google could not confirm your address. Try again, or use an emailed code.',
  google_linked_elsewhere: 'This address is linked to another Google account. Use an emailed code instead.',
  not_invited: `That Google account's address has no ${profile.name} invitation. Ask your account admin to invite it, or sign in with the address they invited.`
};

function Form() {
  const params = useSearchParams();
  const redirect = safePath(params.get('redirect_url'));
  const [config, setConfig] = useState<{ email_code?: boolean; google?: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(ERRORS[params.get('error') ?? ''] ?? null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/auth/config', { cache: 'no-store' }).then((r) => r.json()).then(setConfig, () => setConfig({}));
  }, []);

  const ask = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await authPost<{ message?: string }>('/email/request', { email });
      setNote(r.message ?? 'Check your email for a code.');
      setStep('code');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await authPost<{ redirect?: string }>('/email/verify', { email, code, redirect_url: redirect });
      window.location.href = safePath(r.redirect ?? redirect);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };

  return (
    <Card className='w-full max-w-sm'>
      <CardHeader>
        <CardTitle>Sign in to {profile.name}</CardTitle>
        <CardDescription>{step === 'email' ? 'We will email you a six-digit code.' : `Enter the code we sent to ${email}.`}</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {error && <p role='alert' className='text-destructive text-sm'>{error}</p>}
        {step === 'email' ? (
          <form onSubmit={ask} className='flex flex-col gap-3'>
            <Label htmlFor='email'>Email address</Label>
            <Input id='email' type='email' autoComplete='email' required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
            <Button type='submit' disabled={busy || !email || config?.email_code === false}>{busy ? 'Sending…' : 'Email me a code'}</Button>
            {config?.email_code === false && <p className='text-muted-foreground text-xs'>Email sign-in is not set up on this server yet.</p>}
          </form>
        ) : (
          <form onSubmit={verify} className='flex flex-col gap-3'>
            {note && <p className='text-muted-foreground text-sm'>{note}</p>}
            <Label htmlFor='code'>Code</Label>
            <Input id='code' inputMode='numeric' autoComplete='one-time-code' pattern='[0-9]{6}' maxLength={6} required value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} disabled={busy} />
            <Button type='submit' disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Sign in'}</Button>
            <Button type='button' variant='ghost' size='sm' disabled={busy} onClick={() => { setStep('email'); setCode(''); setNote(null); }}>Use another address</Button>
            <Button type='button' variant='ghost' size='sm' disabled={busy} onClick={() => void ask()}>Send a new code</Button>
          </form>
        )}
        {config?.google && (
          <>
            <div className='text-muted-foreground text-center text-xs'>or</div>
            <Button variant='outline' render={<a href={`/api/auth/google/start?redirect_url=${encodeURIComponent(redirect)}`} />}>Continue with Google</Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function BuiltinSignIn() {
  return <Suspense fallback={null}><Form /></Suspense>;
}
