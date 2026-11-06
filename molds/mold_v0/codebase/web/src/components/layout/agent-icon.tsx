'use client';
// The workspace agent's icon (mold_v0-252): the top bar's agent button and the agent pages' heading draw it. In order:
//   1. the workspace's own (Settings › Workspace agent; GET /api/agent/icon, src/agent-icon.ts), in the customer console;
//   2. the app's (its brand, written by the factory's branding step: profile.generated.ts `agent_icon`, light and dark);
//   3. the console's default (Icons.agent).
// An icon drawn in currentColor (an icon of the set, a one-colour SVG) is painted in the text colour, as a mask, so it
// follows the theme like every other icon; any other is shown as the picture it is. Always decorative (aria-hidden): the
// control or heading that carries it names it (the button "Workspace agent", the trail's crumb "Agent").
import { useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import { profile } from '@/config/profile.generated';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { Icons } from '../icons';

export interface WorkspaceAgentIcon {
  content_type: 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
  follows_color: boolean;
  width: number | null;
  height: number | null;
  sha256: string;
  updated_at: string;
  updated_by: string | null;
}
export interface AgentIconAnswer { icon: WorkspaceAgentIcon | null; can_change: boolean; max_bytes: number }
interface Shown { light: string; dark: string; mask: boolean }

/** The app's own icon (its brand), when it has one. */
export const appAgentIcon = (): Shown | null => (profile as { agent_icon?: Shown }).agent_icon ?? null;

// One fetch per workspace for every icon on the page; Settings reloads it after a change.
let state: { org: string | null; answer: AgentIconAnswer | null } = { org: null, answer: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

/** Ask the server for the workspace's icon again (after an upload or a reset). */
export function reloadWorkspaceAgentIcon(org: string | null = state.org): Promise<void> {
  inflight = fetch('/api/agent/icon', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? (r.json() as Promise<AgentIconAnswer>) : null))
    .catch(() => null)
    .then((answer) => { state = { org, answer }; inflight = null; emit(); });
  return inflight;
}

/** The workspace's own icon and whether this person may change it (null while it loads, or outside a workspace). */
export function useWorkspaceAgentIcon(enabled = true): AgentIconAnswer | null {
  const { orgId } = useAuth();
  const org = orgId ?? null;
  const snap = useSyncExternalStore(subscribe, () => state, () => state);
  useEffect(() => {
    if (!enabled || !org) return;
    if (state.org !== org && !inflight) { state = { org, answer: null }; void reloadWorkspaceAgentIcon(org); }
  }, [enabled, org]);
  return enabled && org && snap.org === org ? snap.answer : null;
}

const dataUrl = (i: WorkspaceAgentIcon) => `data:${i.content_type};base64,${i.data}`;

/** One icon picture: a mask in the text colour, or the picture itself. */
function Picture({ src, mask, className }: { src: string; mask: boolean; className?: string }) {
  if (mask) {
    const m = `url("${src}") center / contain no-repeat`;
    return <span aria-hidden className={cn('inline-block shrink-0 bg-current', className)} style={{ mask: m, WebkitMask: m } as CSSProperties} />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt='' aria-hidden className={cn('shrink-0 object-contain', className)} />;
}

/**
 * The agent's icon at `className`'s size (16 to 20 px in the top bar). `area` admin: the app's (staff have no
 * workspace of their own); `override` shows a given workspace icon (Settings' preview).
 */
export function AgentIcon({ className, area = 'app', override, theme }: {
  className?: string; area?: 'app' | 'admin'; override?: WorkspaceAgentIcon | null | 'app';
  /** One theme's variant whatever the page's theme (Settings' light and dark swatches). */
  theme?: 'light' | 'dark';
}) {
  const fetched = useWorkspaceAgentIcon(area === 'app' && override === undefined);
  const own = override === 'app' ? null : override ?? fetched?.icon ?? null;
  const brand = appAgentIcon();
  if (own) return <span className='inline-flex' data-agent-icon='workspace'><Picture src={dataUrl(own)} mask={own.follows_color} className={className} /></span>;
  if (brand) return (
    <span className='inline-flex' data-agent-icon='app'>
      {theme ? <Picture src={brand[theme]} mask={brand.mask} className={className} /> : brand.light === brand.dark ? <Picture src={brand.light} mask={brand.mask} className={className} /> : <>
        <Picture src={brand.light} mask={brand.mask} className={cn(className, 'dark:hidden')} />
        <Picture src={brand.dark} mask={brand.mask} className={cn(className, 'hidden dark:inline-block')} />
      </>}
    </span>
  );
  return <span className='inline-flex' data-agent-icon='default'><Icons.agent aria-hidden className={className} /></span>;
}
