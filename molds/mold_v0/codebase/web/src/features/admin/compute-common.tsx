'use client';
// Formatting and URL state shared by the Compute page's sections (compute.tsx, compute-sessions.tsx,
// compute-orchestrators.tsx): durations, money, "est." labels, a ticking clock for relative times, and the query
// string that deep-links a section, its filters and an open record (?section=sessions&status=queued&session=ses_…).
// Jobs and Sessions live on Health (/admin/health, as tabs); the other sections on Compute. A link or action that
// names a section on the other page goes there.
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';

export const money = (x: number) => `$${x.toFixed(2)}`;
/** Small amounts keep their cents' fractions ("$0.004"), so a cheap session does not read as free. */
export const cents = (x: number | null | undefined) => (x == null ? '—' : x > 0 && x < 0.01 ? `$${x.toFixed(3)}` : money(x));
/** "45 s", "2.1 min", "3 h". */
export const dur = (s: number | null | undefined) => (s == null ? '—' : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${(s / 60).toFixed(1)} min` : `${(s / 3600).toFixed(1)} h`);
export const ageOf = (d: string | null | undefined) => (d ? Math.max(0, (Date.now() - new Date(d).getTime()) / 1000) : null);
export const since = (a: string | null | undefined, b?: string | null) => (a ? Math.max(0, ((b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime()) / 1000) : null);
export const AMBER = 'text-amber-700 dark:text-amber-400';

/** Re-renders every `ms` so relative times ("12 s ago") stay current between fetches. */
export function useNow(ms = 5_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/** A small outlined chip beside a value ("image", "retiring", "infra retry"). */
export function Chip({ children, title, tone }: { children: ReactNode; title?: string; tone?: 'warn' | 'bad' }) {
  return (
    <span title={title} className={cn('inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-xs leading-none font-medium whitespace-nowrap ring-1 ring-inset',
      tone === 'bad' ? 'bg-destructive/10 text-destructive ring-destructive/25' : tone === 'warn' ? 'bg-amber-500/10 ring-amber-600/25 ' + AMBER : 'text-muted-foreground ring-border')}>
      {children}
    </span>
  );
}

/** A heading inside a record peek. */
export function PeekSection({ title, children, action }: { title: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className='grid gap-2'>
      <div className='flex items-center justify-between gap-2'>
        <h3 className='text-muted-foreground text-xs font-medium tracking-wide uppercase'>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const GOTO = 'compute:goto';
/** The sections shown on Health rather than Compute. */
export const HEALTH_SECTIONS = ['jobs', 'sessions'];
/** The page a section lives on. */
export const pageOf = (section: string) => (HEALTH_SECTIONS.includes(section) ? '/admin/health' : '/admin/compute');
/** A link to a section and its filters, on whichever page holds it. */
export const sectionHref = (section: string, q: Record<string, string> = {}) => `${pageOf(section)}?${new URLSearchParams({ section, ...q })}`;
/** The section a link names on the page `pathname` (`/admin/compute?section=orchestrators&…`), or null. */
export const sectionOf = (href: string, pathname: string) => (href.startsWith(`${pathname}?`) ? new URLSearchParams(href.split('?')[1]).get('section') : null);
/** Asks a section to scroll into view: on every in-page link or action that names it, not only the first. */
export function goToSection(section: string | null | undefined) {
  if (section) window.dispatchEvent(new CustomEvent(GOTO, { detail: section }));
}

/**
 * The Compute page's query string: read, and written in place (replace, so Back leaves the page rather than undoing
 * a filter). A write that names a section also scrolls to it. Needs a Suspense boundary above it (useSearchParams).
 */
export function useComputeParams() {
  const params = useSearchParams(), router = useRouter(), pathname = usePathname();
  const s = params.toString();
  const p = useMemo(() => new URLSearchParams(s), [s]);
  const write = (patch: Record<string, string | null | undefined>) => {
    // A section on the other page: go there with only what the patch names.
    if (patch.section && pageOf(patch.section) !== pathname) {
      const q = Object.fromEntries(Object.entries(patch).filter((e): e is [string, string] => !!e[1]));
      router.push(sectionHref(patch.section, q));
      return;
    }
    const next = new URLSearchParams(s);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    goToSection(patch.section);
  };
  return { get: (k: string) => p.get(k), has: (k: string) => p.has(k), write };
}

/**
 * Scrolls to the section when the page opens with the URL naming it (?section=sessions), once its first data arrives,
 * and again each time an in-page link or action asks for it (goToSection).
 */
export function useScrollTo(section: string, ready: boolean) {
  const { get } = useComputeParams();
  const pending = useRef(get('section') === section);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === section) { pending.current = true; setAsked((k) => k + 1); } };
    window.addEventListener(GOTO, on);
    return () => window.removeEventListener(GOTO, on);
  }, [section]);
  useEffect(() => {
    if (!pending.current || !ready) return;
    pending.current = false;
    (document.getElementById(`compute-${section}-anchor`) ?? document.getElementById(`compute-${section}`))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [ready, asked, section]);
}

/**
 * A link that may point into this page (a tile, a verdict line, a hint): one naming a section does not jump to the top
 * of the page and scrolls to that section instead, every time it is clicked. Any other link behaves as usual.
 */
export function SectionLink({ href, onClick, ...rest }: Omit<ComponentProps<typeof Link>, 'href'> & { href: string }) {
  const section = sectionOf(href, usePathname());
  return <Link href={href} scroll={section ? false : undefined} onClick={(e) => { onClick?.(e); goToSection(section); }} {...rest} />;
}

/** Every session status: "Show sessions" for a job lists all of them, whatever the Sessions filters were. */
const ALL_STATUSES = 'queued,running,completed,failed,timeout,cancelled';
/** The URL patch that opens Sessions on one job: every status, the widest range, no other filter. */
export const jobSessions = (job: string) =>
  ({ section: 'sessions', job_id: job, status: ALL_STATUSES, since: '7d', class: null, stale: null, session: null });

/**
 * Keeps a deep-linked record in a list whatever its filters: once the open id is missing from the loaded rows, the
 * list asks for it by `include` until the record is closed. Rows clicked in the table are already there, so the list
 * never reorders under the pointer. Callers hold `pinned` in state and set it to this during render when it differs.
 */
export function nextPinned(open: string | null, ids: string[] | undefined, pinned: string | null): string | null {
  if (!open) return null;
  return ids && pinned !== open && !ids.includes(open) ? open : pinned;
}

/**
 * A page's tabs held in ?section= (Health: errors · jobs · sessions; Compute: orchestrators · failures · …): the first
 * is the default and clears the query. `right` sits at the end of the row (a status line).
 */
export function UrlTabs({ tabs, tab, base, right }: { tabs: readonly (readonly [string, string])[]; tab: string; base: string; right?: ReactNode }) {
  const router = useRouter();
  return (
    <div className='flex shrink-0 flex-wrap items-end gap-x-6 gap-y-2 border-b'>
      <nav className='flex gap-6 text-sm' aria-label='Sections'>
        {tabs.map(([id, label], i) => (
          <button key={id} type='button' onClick={() => id !== tab && router.replace(i === 0 ? base : `${base}?section=${id}`, { scroll: false })}
            className={cn('-mb-px border-b-2 pb-2 font-medium', id === tab ? 'border-foreground text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent')}>
            {label}
          </button>
        ))}
      </nav>
      {right && <div className='ml-auto min-w-0 pb-2'>{right}</div>}
    </div>
  );
}
