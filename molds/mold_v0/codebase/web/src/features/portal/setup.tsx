'use client';
// /app Setup & training, every build's home (mold_v0-172: a home tab, an overview tab that includes setup, draws this
// same layout with its own right-column cards). Right column: the connection string (with a live connection test), then
// the journey selector (or a home tab's cards: pack.json rail). Main column: the selected journey, then tips. "Get set up"
// is the setup timeline and recent problems (workflow coverage lives on /app/adoption); the other journeys (managed on
// /admin, src/playbooks.ts) show their stages, marked from real tool calls. It is one list (mold_v0-146): the shell's
// setup steps and the packs' onboarding steps, merged in order (setup-steps.ts), every step with its description and,
// while open, its prompt to copy.
import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQueryState } from 'nuqs';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/layout/section';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { CopyButton, ErrorState, LoadingCards, When, fail, useOrgLoad } from './shared';
import { Allowed } from './role';
import { packOnboardingSteps } from '@/config/pack-nav.generated';
import { profile } from '@/config/profile.generated';
import { onboardingAnchor } from '@/features/tabs/empty';
import { mergeSetupSteps, stepProgress, type ChecklistStep, type PackSetupStep, type ShellSetupStep } from './setup-steps';
import { text } from '@/lib/texts';
import { capWord } from '@/lib/words.generated';
import { journeysOn, launchesWork, tipsOn } from '@/features/journeys/config';

interface Setup {
  steps: ShellSetupStep[]; done: number; total: number; clients: { client: string; last: string }[]; calls: number;
  groups: { id: string; label: string; prompt: string; used: number; total: number }[];
  errors: { at: string; name: string | null; error: string | null; hint: string | null }[];
  connect: { connector_url: string; secret: boolean; clients: Client[] };
  live: { at: string; client: string | null } | null;
  /** Set for a viewer: shown where a launch prompt would be. */
  viewer_note?: string | null;
}
interface Client {
  id: string; client: string; group: 'chat' | 'agent' | 'editor'; method: 'ui' | 'cli' | 'config' | 'link'; steps: string;
  command?: string; snippet?: string; file?: string; install_url?: string; verified: boolean; share: number | null;
}
interface Stage { id: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean; link?: { href: string; label: string }; done: boolean; at: string | null }
interface Journey {
  id: string; name: string; outcome: string; who: string; time: string; example: { title: string; result: string };
  stages: Stage[]; done: number; total: number;
}
interface Tips { muted: boolean; nudges: { id: number; message: string; prompt: string | null; link: string | null }[] }

/**
 * The home page's layout (mold_v0-172: every build's, the Setup page's and a home tab's alike). `rail`: the cards below
 * the connection card, in order (a home tab's pack.json rail: journeys, notices, chart:<name>; `cards` draws all but
 * journeys); left out, the journey picker. Every build has journeys (mold_v0-175): the picker always offers "Get set up"
 * (these setup steps), then the journeys component's when pack.json journeys turns it on. `main`: what follows the checklist in the main
 * column (a home tab's records due soon); `below`: what follows both columns, full width (a home tab's charts).
 */
export function SetupPage({ rail, cards, main, below }: { rail?: readonly string[]; cards?: Record<string, React.ReactNode>; main?: React.ReactNode; below?: React.ReactNode } = {}) {
  const { data: s, error, reload } = useOrgLoad(() => appApi<Setup>('GET', '/setup'));
  const pack = usePackSteps();
  // The journey picker (mold_v0-175: every build's, Get set up first); the journeys component's own journeys and the
  // in-chat tips (mold_v0-143: pack.json journeys and tips) are asked for only when on.
  const showPicker = rail === undefined || rail.includes('journeys');
  const showJourneys = journeysOn() && showPicker;
  const { data: jr, reload: reloadJourneys } = useOrgLoad(() => (showJourneys ? appApi<{ journeys: Journey[] }>('GET', '/journeys') : Promise.resolve({ journeys: [] as Journey[] })));
  const [selected, setSelected] = useQueryState('journey', { defaultValue: 'setup' });
  // The earliest step not done yet, optional ones included: the timeline highlights it.
  const journey = jr?.journeys.find((x) => x.id === selected) ?? null;
  const steps = s ? mergeSetupSteps(s.steps, pack.data?.steps ?? []) : [];
  const progress = stepProgress(steps);
  const picker = showPicker && <JourneyPicker key='journeys' setup={progress} journeys={jr?.journeys ?? []} selected={journey ? selected : 'setup'} onSelect={(id) => {
    void setSelected(id === 'setup' ? null : id);
    if (id !== 'setup') void appApi('POST', `/journeys/${encodeURIComponent(id)}/view`).catch(() => {});
  }} />;
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !s || !pack.settled ? <LoadingCards count={4} /> : (<>
        <div className='grid w-full gap-x-10 gap-y-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start xl:grid-cols-[minmax(0,1fr)_24rem]'>
          <div className='order-2 flex min-w-0 flex-col gap-8 lg:order-1'>
            {selected === 'setup' || !journey ? (<>
              <Checklist steps={steps} title='Get set up' anchored={pack.data !== null} />
              {s.errors.length > 0 && <Problems errors={s.errors} />}
            </>) : <JourneyView key={journey.id} j={journey} onChanged={reloadJourneys} note={s.viewer_note ?? null} />}
            {main}
            {tipsOn() && <TipsSection />}
          </div>
          {/* Two floating panels at a fixed width, pinned while the main column (which takes the rest) scrolls: the connection string and the journey picker. */}
          <div className='order-1 flex min-w-0 flex-col gap-4 lg:sticky lg:top-[4.5rem] lg:order-2'>
            <ConnectionBox s={s} onConnected={reload} />
            {rail === undefined ? picker : rail.map((x) => (x === 'journeys' ? picker : <Fragment key={x}>{cards?.[x]}</Fragment>))}
          </div>
        </div>
        {below}
      </>)}
    </PageContainer>
  );
}

/** A floating panel for the pinned right column (a home tab's cards too: mold_v0-172). */
export function FloatPanel({ title, icon, description, className, children }: { title: string; icon?: React.ReactNode; description?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={cn('bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 shadow-xl shadow-black/30', className)}>
      <div><h2 className='flex items-center gap-2 text-sm font-semibold tracking-tight'>{icon && <span className='text-primary [&_svg]:size-4'>{icon}</span>}{title}</h2>{description && <p className='text-muted-foreground text-xs'>{description}</p>}</div>
      {children}
    </section>
  );
}

/** The connection string, always in view: copy it, then prove the client reaches the server. */
function ConnectionBox({ s, onConnected }: { s: Setup; onConnected: () => void }) {
  return (
    <FloatPanel title='Connect your AI client' icon={<Icons.plug />} description={s.connect.secret ? 'Your connection URL contains your key: keep it private.' : `${profile.name} runs inside the AI client you already use.`}>
      <ConnectSteps s={s} onConnected={onConnected} />
    </FloatPanel>
  );
}

/** Pick a client, add the connection URL to it, test it: the panel's three steps. */
function ConnectSteps({ s, onConnected }: { s: Setup; onConnected: () => void }) {
  const [live, setLive] = useState<{ kind: 'wait' | 'ok' | 'bad'; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clients = s.connect.clients;
  // The client to show: the last one picked here, else one this person already connected from, else Claude.
  const [pick, setPick] = useState<string>(() => {
    try { const saved = localStorage.getItem('oct_client'); if (saved && clients.some((c) => c.id === saved)) return saved; } catch { /* private mode */ }
    const seen = s.clients.map((x) => x.client.toLowerCase());
    return clients.find((c) => seen.some((x) => x.includes(c.id.replace('-cli', '')) || x.includes(c.client.toLowerCase().split(' ')[0])))?.id ?? clients[0]?.id ?? 'claude';
  });
  const choose = (id: string) => { setPick(id); try { localStorage.setItem('oct_client', id); } catch { /* private mode */ } };
  const c = clients.find((x) => x.id === pick) ?? clients[0];
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  // Live connection test: watch for this person's next connector request for up to three minutes.
  const test = () => {
    if (timer.current) return;
    appApi<{ since: string }>('POST', '/setup/test').then(({ since }) => {
      const until = Date.now() + 180_000;
      setLive({ kind: 'wait', text: `Waiting for your client… Open a new chat and type: "Get me started with ${profile.name}."` });
      timer.current = setInterval(() => {
        appApi<Setup>('GET', `/setup?since=${encodeURIComponent(since)}`).then((r) => {
          if (r.live) {
            clearInterval(timer.current!); timer.current = null;
            setLive({ kind: 'ok', text: `Connected${r.live.client ? ` from ${r.live.client}` : ''}. You're all set.` });
            onConnected();
          } else if (Date.now() > until) {
            clearInterval(timer.current!); timer.current = null;
            setLive({ kind: 'bad', text: `Nothing arrived yet. Check the URL, that you signed in when your client asked, and that the ${profile.name} tools are switched on; then try again.` });
          }
        }).catch(() => {});
      }, 3000);
    }).catch(fail);
  };
  const groups: [Client['group'], string][] = [['chat', 'Chat apps'], ['agent', 'Coding agents'], ['editor', 'Editors']];
  const url = s.connect.connector_url;
  const [show, setShow] = useState(!s.connect.secret);
  // Already connected (a client reached us before, or the test just passed): the test button is then secondary.
  const connected = live?.kind === 'ok' || s.clients.length > 0;
  const masked = url.replace(/([?&](?:key|token|k)=)[^&]+/i, '$1••••••••').replace(/(oct_[A-Za-z0-9]{4})[A-Za-z0-9_-]+/, '$1••••••••');
  return (
      <ol className='flex flex-col gap-4'>
          <NumberedStep n={1} title='Pick your client'>
            <NativeSelect id='client-pick' aria-label='Your AI client' value={c?.id} onChange={(e) => choose(e.target.value)} className='bg-background w-full'>
              {groups.map(([g, label]) => (
                <NativeSelectOptGroup key={g} label={label}>
                  {clients.filter((x) => x.group === g).map((x) => <NativeSelectOption key={x.id} value={x.id}>{x.client}</NativeSelectOption>)}
                </NativeSelectOptGroup>
              ))}
            </NativeSelect>
          </NumberedStep>
          <NumberedStep n={2} title={c ? `Add ${profile.name} to ${c.client}` : `Add ${profile.name}`}>
            <div className='flex flex-col gap-2'>
              <div className='bg-background flex items-center gap-1 rounded-md border py-1 pr-1 pl-2.5'>
                <code className='min-w-0 flex-1 truncate font-mono text-xs select-all' title={show ? url : undefined}>{show ? url : masked}</code>
                {s.connect.secret && (
                  <Button variant='ghost' size='icon-sm' onClick={() => setShow(!show)} aria-label={show ? 'Hide the URL' : 'Show the URL'} title={show ? 'Hide' : 'Show'}>
                    {show ? <Icons.eyeOff className='size-4' /> : <Icons.eye className='size-4' />}
                  </Button>
                )}
                <CopyButton text={url} label='Copy URL' variant='ghost' />
              </div>
              {c && <ClientSteps c={c} />}
            </div>
          </NumberedStep>
          <NumberedStep n={3} title='Check it works'>
            <Button className='w-full' variant={connected ? 'outline' : 'default'} onClick={test} disabled={live?.kind === 'wait'}>
              {live?.kind === 'wait' ? <Icons.spinner className='animate-spin' /> : <Icons.plug />} {live?.kind === 'wait' ? 'Waiting for your client…' : 'Test my connection'}
            </Button>
            {live && (
              <Alert variant={live.kind === 'bad' ? 'destructive' : 'default'} role='status' aria-live='polite'
                className={cn('mt-2', live.kind === 'ok' && 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400')}>
                {live.kind === 'ok' ? <Icons.circleCheck /> : live.kind === 'wait' ? <Icons.clock /> : <Icons.warning />}
                <AlertDescription className={cn(live.kind === 'ok' && 'text-emerald-700 dark:text-emerald-400')}>{live.text}</AlertDescription>
              </Alert>
            )}
          </NumberedStep>
        </ol>
  );
}

/** A numbered step in the connection panel. */
function NumberedStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className='flex gap-3'>
      <span className='border-border text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums'>{n}</span>
      <div className='min-w-0 flex-1 space-y-2'>
        <div className='text-sm leading-5 font-medium'>{title}</div>
        {children}
      </div>
    </li>
  );
}


/** The selected client's way in: one-click install, a command, a config snippet, or steps in its settings. */
function ClientSteps({ c }: { c: Client }) {
  return (
    <div className='space-y-2 text-sm'>
      {c.install_url && (
        <Button size='sm' render={<a href={c.install_url} />}><Icons.add /> Add to {c.client}</Button>
      )}
      {c.command && <CodeLine text={c.command} label='Command' />}
      {c.snippet && (
        <div className='space-y-1'>
          {c.file && <div className='text-muted-foreground text-xs'>{c.command || c.install_url ? 'Or add to ' : 'In '}<code className='font-mono'>{c.file}</code></div>}
          <div className='relative'>
            <pre className='bg-background overflow-x-auto rounded-md border p-2.5 pr-20 font-mono text-xs whitespace-pre-wrap break-all'>{c.snippet}</pre>
            <div className='absolute top-1 right-1'><CopyButton text={c.snippet} variant='ghost' /></div>
          </div>
        </div>
      )}
    </div>
  );
}

function CodeLine({ text, label }: { text: string; label: string }) {
  return (
    <div className='flex items-center gap-2'>
      <code className='bg-background min-w-0 flex-1 overflow-x-auto rounded-md border px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap' aria-label={label}>{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

/** Pick what the main column shows: getting set up, or one of the journeys, each with its progress. */
/** Journeys beyond this many get a search box. */
const SEARCH_FROM = 6;

function JourneyPicker({ setup, journeys, selected, onSelect }: { setup: { done: number; total: number }; journeys: Journey[]; selected: string; onSelect: (id: string) => void }) {
  const [q, setQ] = useState('');
  const items = [{ id: 'setup', name: 'Get set up', goal: 'Connect your client and try the workflow once', done: setup.done, total: setup.total },
    ...journeys.map((j) => ({ id: j.id, name: j.name, goal: j.outcome, done: j.done, total: j.total }))];
  const needle = q.trim().toLowerCase();
  const [all, setAll] = useState(false);
  const matches = needle ? items.filter((j) => `${j.name} ${j.goal}`.toLowerCase().includes(needle)) : items;
  // Fit the pinned column: past SEARCH_FROM, show the first few (and the selected one) until searched or expanded.
  const shown = needle || all || matches.length <= SEARCH_FROM ? matches
    : [...matches.slice(0, SEARCH_FROM - 1), ...matches.slice(SEARCH_FROM - 1).filter((j) => j.id === selected)];
  return (
    <FloatPanel title={capWord(text('journeys.many'))} icon={<Icons.route />} description='Real use cases as step-by-step pipelines. Pick one to replicate it.' >
      {items.length > SEARCH_FROM && (
        <div className='relative'>
          <Icons.search className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input type='search' value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${items.length} ${text('journeys.many')}`} aria-label={`Search ${text('journeys.many')}`} className='h-8 pl-8 text-sm' />
        </div>
      )}
      <div role='radiogroup' aria-label={capWord(text('journeys.one'))} className='flex flex-col gap-0.5'>
        {shown.length === 0 && <p className='text-muted-foreground px-2 py-3 text-sm'>No {text('journeys.one')} matches “{q}”.</p>}
        {shown.map((j) => {
          const on = j.id === selected, complete = j.total > 0 && j.done >= j.total;
          return (
            <button key={j.id} type='button' role='radio' aria-checked={on} onClick={() => onSelect(j.id)}
              title={j.goal}
              className={cn('flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                on ? 'border-primary bg-primary/5' : 'hover:bg-muted/60 border-transparent')}>
              <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border-2', complete ? 'border-primary bg-primary text-primary-foreground' : on ? 'border-primary' : 'border-muted-foreground/40')}>
                {complete && <Icons.check className='size-3' />}
              </span>
              <span className='min-w-0 flex-1 truncate text-sm font-medium'>{j.name}</span>
              <span className='text-muted-foreground shrink-0 text-xs tabular-nums'>{j.done}/{j.total}</span>
            </button>
          );
        })}
      </div>
      {!needle && matches.length > shown.length && (
        <button type='button' onClick={() => setAll(true)} className='text-primary self-start px-3 text-xs font-medium hover:underline'>
          Show all {matches.length} {text('journeys.many')}
        </button>
      )}
      {!needle && all && matches.length > SEARCH_FROM && (
        <button type='button' onClick={() => setAll(false)} className='text-muted-foreground self-start px-3 text-xs hover:underline'>Show fewer</button>
      )}
    </FloatPanel>
  );
}

/** A use case as a pipeline: what it gets you, a worked example, and each stage's prompt, tool and expected result. */
function JourneyView({ j, onChanged, note }: { j: Journey; onChanged: () => void; note: string | null }) {
  const [busy, setBusy] = useState<string | null>(null);
  // Stages with no tool are marked by hand, for the whole account (and counted in journey analytics).
  const toggle = (id: string, done: boolean) => {
    setBusy(id);
    appApi('POST', `/journeys/${encodeURIComponent(j.id)}/stages/${encodeURIComponent(id)}`, { done })
      .then(() => onChanged()).catch(fail).finally(() => setBusy(null));
  };
  const isDone = (x: Stage) => x.done;
  const done = j.stages.filter(isDone).length;
  return (
    <TimelineSection title={j.name} done={done} total={j.total} noun='stages'
      items={j.stages.map((x) => {
        const ok = isDone(x);
        // A stage whose tool starts work (pack.json journeys.launch): a viewer gets the note, not the prompt.
        const gated = !!note && x.tools.some(launchesWork);
        const help = `${x.why} You'll see: ${x.expect}`;
        return { id: x.id, label: x.title, done: ok, body: (
          <>
            <StepHelp help={help} done={ok} prompt={!x.manual && !gated ? x.prompt : null} />
            {!ok && x.link && /^\/app(\/|$)/.test(x.link.href) && (
              <a href={x.link.href} className='text-primary mt-2 inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline'>Or do it on the {x.link.label} page <Icons.chevronRight className='size-3.5' /></a>
            )}
            {!ok && x.manual && (
              <div className='mt-2 flex flex-wrap items-center gap-2'>
                <span className='text-sm'>{x.prompt}</span>
                <Allowed need='edit'><Button size='sm' variant='outline' disabled={busy === x.id} onClick={() => toggle(x.id, true)}>Mark done</Button></Allowed>
              </div>
            )}
            {!ok && gated && <p className='text-muted-foreground mt-2 text-sm'>{note}</p>}
            {x.manual && ok && <Allowed need='edit'><Button size='sm' variant='ghost' className='text-muted-foreground mt-1' disabled={busy === x.id} onClick={() => toggle(x.id, false)}>Undo</Button></Allowed>}
          </>
        ) };
      })}
      footer={done >= j.total ? `Pipeline complete. Run it again after your next change, or pick another ${text('journeys.one')}.` : <>Worked example: <span className='text-foreground'>{j.example.title}</span>. {j.example.result}</>} />
  );
}

/** Setup as a vertical timeline: every step explained, what is done (and when), what is next, what is optional. */
/**
 * A step's description (selectable) and, while the step is open, its prompt in a box with one Copy button, to paste
 * into your AI client. A done step shows only its description.
 */
function StepHelp({ help, done, prompt }: { help: string; done: boolean; prompt: string | null }) {
  const m = help.match(/\s*Type:\s*"(.+?)"\.?\s*(.*)$/);
  const text = m ? help.slice(0, m.index).trim() : help, after = m?.[2]?.trim() ?? '';
  const p = prompt ?? m?.[1] ?? null;
  return (
    <div className='mt-1 flex flex-col gap-2'>
      <p className={cn('text-sm select-text', 'text-muted-foreground')}>{text}{after && <> {after}</>}</p>
      {!done && p && (
        <div className='bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2'>
          <code className='min-w-0 flex-1 font-mono text-xs break-words select-all'>{p}</code>
          <CopyButton text={p} label='Copy prompt' />
        </div>
      )}
    </div>
  );
}

interface TimelineItem { id: string; label: string; done: boolean; body: React.ReactNode; /** The item's address on the page (#anchor): a pack's onboarding step, which a tab's empty state links to (mold_v0-107). */ anchor?: string }

/**
 * Get set up and every journey: progress, then a vertical timeline. The earliest open item is highlighted (ring on its
 * node, tinted body); done items show a check. One component, so every journey looks exactly like Get set up. Every
 * item says what it is and, while open, what to type (mold_v0-172: a home tab's checklist is this one too).
 */
function TimelineSection({ title, done, total, noun, items, footer }: {
  title: string; done: number; total: number; noun: string; items: TimelineItem[]; footer: React.ReactNode;
}) {
  const pct = Math.round((done / Math.max(1, total)) * 100);
  const current = items.find((x) => !x.done)?.id;
  const uid = useId();
  return (
    <Section title={title} description={`${done} of ${total} ${noun} done.`}
      action={<div className='flex items-center gap-3'><Badge variant={pct === 100 ? 'default' : 'secondary'}>{pct}%</Badge></div>}>
      <div className='bg-muted h-1.5 overflow-hidden rounded-full'><div className='bg-primary h-full rounded-full transition-all' style={{ width: `${pct}%` }} /></div>
      <ol className='mt-3'>
        {items.map((x, i) => {
          const cur = current === x.id;
          const last = i === items.length - 1;
          return (
            <li key={x.id} id={x.anchor} data-step={x.id} className={cn('relative flex scroll-mt-24 gap-4 last:pb-0', 'pb-7')}>
              {!last && <span aria-hidden='true' className={cn('absolute top-8 bottom-0 left-[15px] w-px', x.done ? 'bg-primary/60' : 'bg-border')} />}
              <span className={cn('relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold tabular-nums',
                x.done ? 'border-primary bg-primary text-primary-foreground' : cur ? 'border-primary text-primary bg-background ring-primary/20 ring-4' : 'border-border text-muted-foreground bg-background')}>
                {x.done ? <><Icons.check aria-hidden='true' className='size-4' /><span className='sr-only'>Done:</span></> : i + 1}
              </span>
              <div className={cn('min-w-0 flex-1 pt-1', cur && 'bg-primary/5 -mt-1 rounded-lg px-4 py-3')}>
                <div className='flex flex-wrap items-center gap-2'>
                  <span className={cn('font-medium', x.done && 'text-muted-foreground')}>{x.label}</span>
                </div>
                {x.body && <div id={`${uid}-step-${i}`}>{x.body}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {footer && <p className='text-muted-foreground border-t pt-3 text-sm'>{footer}</p>}
    </Section>
  );
}

interface PackChecklistData { steps: PackSetupStep[]; done: number; total: number }

/**
 * The packs' onboarding steps (mold_v0-011; src/onboarding.ts, /api/onboarding), each ticked from what really happened
 * in this workspace. Asked for only when a pack declares a step (packOnboardingSteps): with none the list is the shell's.
 */
function usePackSteps(): { data: PackChecklistData | null; settled: boolean } {
  const { data, error } = useOrgLoad(async () => {
    if (!packOnboardingSteps) return null;
    const res = await fetch('/api/onboarding', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return (await res.json()) as PackChecklistData;
  });
  return { data, settled: !packOnboardingSteps || data !== null || error !== null };
}

/**
 * The one checklist (mold_v0-146): the setup steps and the packs' steps, merged (setup-steps.ts), each with its
 * description and, while open, the words to type in an AI client (mold_v0-172: a pack step's pack.json prompt too).
 */
function Checklist({ steps, title, anchored }: {
  steps: ChecklistStep[]; title: string;
  /** The packs' steps are in: scroll to a linked one. */
  anchored: boolean;
}) {
  // A link to one step (/app#onboarding-<pack>-<step>, from a tab's empty state; on a home tab, mold_v0-134, the redirect
  // keeps the anchor): the page loads the steps after the browser looked for the anchor, so scroll to it once drawn.
  useEffect(() => {
    if (!anchored || typeof window === 'undefined' || !window.location.hash.startsWith('#onboarding-')) return;
    document.getElementById(decodeURIComponent(window.location.hash.slice(1)))?.scrollIntoView({ block: 'start' });
  }, [anchored]);
  const items: TimelineItem[] = steps.map((x) => ({ id: x.key, anchor: x.pack ? onboardingAnchor(x.pack, x.id) : undefined, label: x.label, done: x.done,
    body: x.pack && !x.help && !x.prompt ? null : <StepHelp help={x.help ?? ''} done={x.done} prompt={x.prompt} /> }));
  const { done, total } = stepProgress(steps);
  const ticks = steps.some((x) => x.pack);
  return (
    <TimelineSection title={title} done={done} total={total} noun='steps' items={items}
      footer={ticks || journeysOn() ? <>
        {ticks && 'These steps tick themselves as you go. '}
        {journeysOn() && <>How much of the workflow your team uses is on <a href='/app/journeys' className='text-primary underline underline-offset-4'>{capWord(text('journeys.many'))}</a>.</>}
      </> : null} />
  );
}

function TipsSection() {
  const [t, setT] = useState<Tips | null>(null);
  const load = useCallback(() => appApi<Tips>('GET', '/nudges').then(setT).catch(() => {}), []);
  useEffect(() => { void load(); }, [load]);
  if (!t || (!t.nudges.length && !t.muted)) return null;
  const setShow = (on: boolean) =>
    appApi('POST', '/nudges/mute', { muted: !on }).then(() => { toast.success(on ? 'Tips on' : 'Tips off in your AI client'); return load(); }).catch(fail);
  const safe = (l: string) => (/^\/app/.test(l) || /^https:\/\//.test(l) ? l : '#');
  return (
    <Section title={<span className='flex items-center gap-2'><Icons.sparkles className='text-primary size-4' /> Tips for you</span>} description={`Suggestions to get more out of ${profile.name}.`}>
      <div className='space-y-3'>
        <label className='flex items-center justify-between gap-3 text-sm'>
          <span>Show tips in my AI client</span>
          <Switch checked={!t.muted} onCheckedChange={(v) => setShow(Boolean(v))} />
        </label>
        {t.nudges.length ? t.nudges.map((n) => (
          <div key={n.id} className='bg-primary/5 border-primary space-y-2 border-l-2 py-2 pr-2 pl-3 text-sm'>
            <p>{n.message}</p>
            {n.prompt && (
              <div className='flex items-center gap-2'>
                <code className='bg-background flex-1 truncate rounded px-2 py-1 text-xs' title={n.prompt}>{n.prompt}</code>
                <CopyButton text={n.prompt} />
              </div>
            )}
            <div className='flex items-center gap-2'>
              {n.link && <Button variant='link' size='sm' className='px-0' render={<a href={safe(n.link)} />}>Open</Button>}
              <span className='flex-1' />
              <Button variant='ghost' size='sm' onClick={() => appApi('POST', `/nudges/${n.id}/dismiss`).then(load).catch(fail)}>Dismiss</Button>
            </div>
          </div>
        )) : <p className='text-muted-foreground text-sm'>No tips right now.</p>}
      </div>
    </Section>
  );
}

function Problems({ errors }: { errors: Setup['errors'] }) {
  return (
    <Section title='Recent problems' description='Errors from your recent tool calls, with what to do about them.'>
      <div className='divide-y border-y'>
        {errors.map((e, i) => (
          <div key={i} className='space-y-1 py-3 text-sm'>
            <div className='flex items-center justify-between gap-2'>
              <code className='text-xs'>{e.name}</code>
              <span className='text-muted-foreground text-xs'><When d={e.at} /></span>
            </div>
            <p className='text-muted-foreground'>{e.error}</p>
            {e.hint && <p><span className='font-medium'>Fix:</span> {e.hint}</p>}
          </div>
        ))}
      </div>
    </Section>
  );
}
