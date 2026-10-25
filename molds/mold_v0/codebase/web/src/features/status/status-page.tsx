'use client';
/**
 * The console's one status page (mold_v0-131): not found, denied, staff only, suspended, signed out, no account, error
 * and offline, everywhere (/, /app, /admin, docs, sign-in, pack pages). The build's brand, the code, a title, one
 * sentence (./words.ts) and one or two actions. Never a blank page or a raw error card.
 *
 *   frame 'full'    a page of its own (the brand's header, the status centred in a <main>): the root's not-found,
 *                   forbidden and error pages, the sign-in area's
 *   frame 'inline'  inside a layout that already has a <main> (the portal's and the admin console's shell, the public
 *                   pages' header and footer) or inside a page (a data hook's refusal: ./from-error.tsx)
 *
 * data-status-page (the kind) and data-status-code mark it for tests and the lanes.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useId, type ReactNode } from 'react';
import { BrandLogo, BrandMark } from '@/components/brand';
import { Icons } from '@/components/icons';
import { Button, buttonVariants } from '@/components/ui/button';
import { SignOutButton } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { AREA_HOME, areaOf, signInHref, STATUS_ACTIONS, statusText, type StatusArea, type StatusKind } from './words';

export interface StatusPageProps {
  kind: StatusKind;
  /** Where it is shown (else from the address). */
  area?: StatusArea;
  frame?: 'full' | 'inline';
  /** The heading's level: h1 for a page of its own, h2 inside a page that has its title. */
  level?: 1 | 2;
  /** The role a denied page needs (its label). */
  role?: string | null;
  /** Who is signed in (staff only). */
  email?: string | null;
  /** The person is platform staff: offer the admin console. */
  staff?: boolean;
  /** Try again (error, offline): else the page reloads. */
  onRetry?: () => void;
  /** In place of the sentence: the server's own words for an answer the page cannot use. */
  detail?: string | null;
}

type Action = { key: string; label: string; href?: string; onClick?: () => void; signOut?: boolean; primary?: boolean; icon?: ReactNode };

export function StatusPage({ kind, area: areaProp, frame = 'inline', level, role, email, staff, onRetry, detail }: StatusPageProps) {
  const router = useRouter();
  const pathname = usePathname();
  const area = areaProp ?? areaOf(pathname);
  const t = statusText(kind, { role, email, area });
  const id = useId();
  const home = AREA_HOME[area];
  const back = () => (typeof window !== 'undefined' && window.history.length > 1 ? router.back() : router.push(home));
  // The address to come back to after signing in (the path: the same on the server and in the browser).
  const here = pathname;

  const goHome: Action = { key: 'home', label: STATUS_ACTIONS.home[area], href: home, primary: true, icon: <Icons.arrowRight aria-hidden='true' /> };
  const actions: Action[] =
    kind === 'not_found' ? [goHome, { key: 'back', label: STATUS_ACTIONS.back, onClick: back }]
    : kind === 'denied' ? [{ ...goHome }, { key: 'back', label: STATUS_ACTIONS.back, onClick: back }]
    : kind === 'staff_only' ? [{ key: 'portal', label: STATUS_ACTIONS.portal, href: '/app', primary: true, icon: <Icons.arrowRight aria-hidden='true' /> }, { key: 'out', label: STATUS_ACTIONS.signInOther, signOut: true }]
    : kind === 'suspended' ? [{ key: 'out', label: STATUS_ACTIONS.signOut, signOut: true, primary: true }, ...(staff ? [{ key: 'admin', label: STATUS_ACTIONS.admin, href: '/admin' }] : [{ key: 'site', label: STATUS_ACTIONS.home.site, href: '/' }])]
    : kind === 'signed_out' ? [{ key: 'in', label: STATUS_ACTIONS.signIn, href: signInHref(here), primary: true, icon: <Icons.login aria-hidden='true' /> }, { key: 'site', label: STATUS_ACTIONS.home.site, href: '/' }]
    : kind === 'no_account' ? [...(staff ? [{ key: 'admin', label: STATUS_ACTIONS.admin, href: '/admin', primary: true, icon: <Icons.arrowRight aria-hidden='true' /> }] : []), { key: 'out', label: STATUS_ACTIONS.signOut, signOut: true, primary: !staff, icon: <Icons.logout aria-hidden='true' /> }]
    : [{ key: 'retry', label: STATUS_ACTIONS.retry, onClick: onRetry ?? (() => window.location.reload()), primary: true, icon: <Icons.refresh aria-hidden='true' /> }, goHome.href === here ? { key: 'site', label: STATUS_ACTIONS.home.site, href: '/' } : { ...goHome, primary: false, icon: undefined }];

  const H = (level ?? (frame === 'full' ? 1 : 2)) === 1 ? 'h1' : 'h2';
  const button = (a: Action) => {
    const cls = cn(buttonVariants({ variant: a.primary ? 'default' : 'outline' }), 'h-10 px-4');
    if (a.signOut) return <SignOutButton redirectUrl='/auth/sign-in'><button type='button' className={cls}>{a.icon}{a.label}</button></SignOutButton>;
    if (a.href) return <Link href={a.href} className={cls} prefetch={false}>{a.label}{a.icon}</Link>;
    return <Button type='button' variant={a.primary ? 'default' : 'outline'} className='h-10 px-4' onClick={a.onClick}>{a.icon}{a.label}</Button>;
  };

  const body = (
    <section aria-labelledby={id} data-status-page={kind} data-status-code={t.code || undefined}
      className='mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-4 py-12 text-center sm:py-16'>
      {frame === 'inline' ? <BrandMark className='size-9' /> : null}
      {t.code ? <p className='text-muted-foreground font-mono text-sm tracking-wide'>Error {t.code}</p> : null}
      <H id={id} className='text-2xl font-semibold tracking-tight text-balance break-words sm:text-3xl'>{t.title}</H>
      <p className='text-muted-foreground max-w-prose text-base break-words'>{detail || t.body}</p>
      <div className='mt-2 flex flex-wrap items-center justify-center gap-3'>
        {actions.slice(0, 2).map((a) => <span key={a.key} className='contents'>{button(a)}</span>)}
      </div>
    </section>
  );
  if (frame === 'inline') return <div className='flex w-full flex-1 items-center justify-center'>{body}</div>;
  return (
    <div className='flex min-h-svh flex-col'>
      <header className='border-b'>
        <div className='mx-auto flex min-h-16 w-full max-w-5xl items-center px-4 py-3 sm:px-6'><BrandLogo className='min-w-0' /></div>
      </header>
      <main id='main' className='flex flex-1 items-center justify-center'>{body}</main>
    </div>
  );
}
