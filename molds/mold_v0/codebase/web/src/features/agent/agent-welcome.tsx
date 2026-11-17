'use client';
// The workspace agent's blank screen (mold_v0-316, flag agent_quick_commands): a chat with nothing in it yet shows a
// greeting in the app's words, the page it was opened from, and 4 to 6 example prompts (the active tab's own, else the
// app's, else the shell's; composer/quick-commands.ts). Choosing one fills the composer, its placeholders filled from that
// page, the cursor on the first blank left; it is never sent on its own. Cards are buttons: Tab reaches each, Enter or
// Space chooses. Two columns from a tablet up, one on a phone.
import { useEffect, useMemo, useState } from 'react';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { agentPrompts } from '@/config/agent-prompts.generated';
import { packTabs, recordAreas } from '@/config/pack-nav.generated';
import { featureOn } from '@/config/features';
import { commandsFor, examplesFor, fillPrompt, greetingFor, type AgentExample, type ScopedCommand, type OpenedFrom, type PromptContext } from './composer/quick-commands';

/** Whether the blank screen and the "/" menu are on in this build (the flag; the agent itself is on wherever they are). */
export const quickCommandsOn = () => featureOn('agent_quick_commands');

/** The words a page's prompts are filled with: its tab's label, its record area's label and the record's title (read once). */
export function usePromptContext(from: OpenedFrom | null): PromptContext {
  const tab = from?.tab ? packTabs.find((t) => t.id === from.tab) ?? null : null;
  const rec = from?.record ?? null;
  const area = rec ? recordAreas.find((a) => a.name === rec.area) ?? null : null;
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    setTitle(null);
    if (!rec) return;
    let live = true;
    void fetch(`/api/records/${encodeURIComponent(rec.area)}/${encodeURIComponent(rec.key)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { record?: { title?: string | null } } | null) => { if (live && typeof d?.record?.title === 'string' && d.record.title.trim()) setTitle(d.record.title.trim()); }, () => undefined);
    return () => { live = false; };
  }, [rec?.area, rec?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({ tab: tab?.label ?? null, area: area?.label ?? (rec?.area ?? null), record_key: rec?.key ?? null, record_title: title ?? rec?.key ?? null }), [tab?.label, area?.label, rec?.area, rec?.key, title]);
}

/** The "/" menu's commands for a page, or null while the flag is off (no "/" button at all). */
export function useAgentCommands(from: OpenedFrom | null): ScopedCommand[] | null {
  return useMemo(() => (quickCommandsOn() ? commandsFor(agentPrompts, from ?? { tab: null, record: null }) : null), [from?.tab, from?.record?.area, from?.record?.key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** "Findings › FND-12": where the chat was opened from, in words (null: the Agents page). */
export function openedFromWords(ctx: PromptContext): string | null {
  return [ctx.tab, ctx.record_title].filter(Boolean).join(' › ') || null;
}

/** The blank screen: the greeting, where it was opened from, the example prompts. */
export function AgentWelcome({ from, ctx, onPick, className }: { from: OpenedFrom | null; ctx: PromptContext; onPick: (text: string, select: [number, number] | null) => void; className?: string }) {
  const at = from ?? { tab: null, record: null };
  const examples = useMemo(() => examplesFor(agentPrompts, at), [at.tab, at.record?.area, at.record?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const greeting = greetingFor(agentPrompts, ctx);
  const where = openedFromWords(ctx);
  const pick = (e: AgentExample) => { const f = fillPrompt(e.prompt, ctx); onPick(f.text, f.select); };
  return (
    <section className={cn('mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-1 py-6 text-center sm:py-10', className)} aria-labelledby='agent-welcome-title' data-agent-welcome=''>
      <div className='flex flex-col items-center gap-3'>
        <span className='bg-primary/10 text-primary ring-primary/20 grid size-11 place-items-center rounded-2xl ring-1' aria-hidden><Icons.sparkles className='size-5' /></span>
        <h2 id='agent-welcome-title' className='text-xl font-semibold tracking-tight text-balance sm:text-2xl' data-agent-welcome-title=''>{greeting.title}</h2>
        <p className='text-muted-foreground max-w-xl text-sm text-balance'>{greeting.text}</p>
        {where && <span className='bg-muted/60 text-muted-foreground inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs' data-agent-opened-from=''>
          <Icons.mapPin className='size-3 shrink-0' aria-hidden /><span className='sr-only'>Opened from </span><span className='truncate'>{where}</span>
        </span>}
      </div>
      <ul className='grid w-full grid-cols-1 gap-2.5 text-left sm:grid-cols-2' aria-label='Example prompts' data-agent-examples=''>
        {examples.map((e, i) => {
          const title = fillPrompt(e.title, ctx).text, line = fillPrompt(e.description ?? e.prompt, ctx).text;
          return (
            <li key={`${i}-${e.title}`} className='flex'>
              <button type='button' onClick={() => pick(e)} data-agent-example={i}
                className='group bg-card hover:border-primary/40 hover:bg-muted/40 focus-visible:ring-ring/50 flex w-full min-w-0 items-start gap-3 rounded-xl border p-3.5 text-left shadow-xs transition-colors outline-none focus-visible:ring-2'>
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-sm font-medium'>{title}</span>
                  <span className='text-muted-foreground mt-0.5 block truncate text-xs'>{line}</span>
                </span>
                <Icons.arrowUpRight className='text-muted-foreground group-hover:text-foreground mt-0.5 size-4 shrink-0 transition-colors' aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
