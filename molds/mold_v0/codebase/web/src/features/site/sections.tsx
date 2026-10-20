import { Fragment } from 'react';
import Link from 'next/link';
import {
  IconBolt, IconCode, IconEyeOff, IconGitCompare, IconMessageChatbot, IconSearch, IconTerminal2
} from '@tabler/icons-react';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AccountButton } from './account-cta';
import { AgentLogo } from './agent-logos';

/** Section wrapper: anchor target, eyebrow, title and an optional one-line lead. */
export function Section({ id, eyebrow, title, lead, children, className, center }: {
  id?: string; eyebrow?: string; title: React.ReactNode; lead?: React.ReactNode; children?: React.ReactNode; className?: string;
  /** Centre the heading block (the FAQ). */
  center?: boolean;
}) {
  return (
    <section id={id} className={cn('scroll-mt-20 border-t py-16 sm:py-24', className)}>
      <div className='mx-auto max-w-6xl px-4 sm:px-6'>
        <div className={cn('max-w-2xl', center && 'sm:mx-auto sm:text-center')}>
          {eyebrow && <p className='text-primary font-mono text-xs tracking-wider uppercase'>{eyebrow}</p>}
          <h2 className='mt-2 text-3xl font-semibold tracking-tight text-balance sm:text-4xl'>{title}</h2>
          {lead && <p className='text-muted-foreground mt-3 text-lg text-pretty'>{lead}</p>}
        </div>
        {children && <div className='mt-10 sm:mt-14'>{children}</div>}
      </div>
    </section>
  );
}

/** Thin animated dashes along a path: shows direction of flow (still when reduced motion is on). */
const FLOW = 'stroke-primary [stroke-dasharray:4_12] motion-safe:animate-[apo-dash_1.4s_linear_infinite]';

// ---------- hero ----------

/** The grid and green glow behind the top of a public page. */
export function HeroBackdrop() {
  return (
    <>
      <div aria-hidden='true' className='pointer-events-none absolute inset-0 [mask-image:radial-gradient(70%_60%_at_50%_0%,black,transparent)] bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-60' />
      <div aria-hidden='true' className='pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] max-w-full -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_22%,transparent),transparent)] blur-2xl' />
    </>
  );
}

export const AGENTS = [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['gemini-cli', 'Gemini CLI'], ['copilot', 'GitHub Copilot'], ['opencode', 'OpenCode'], ['cline', 'Cline']] as const;

export function Hero() {
  return (
    <section className='relative overflow-hidden'>
      <HeroBackdrop />

      <div className='relative mx-auto max-w-6xl px-4 pt-16 pb-14 sm:px-6 sm:pt-24 sm:pb-20'>
        <div className='grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center'>
          <div className='min-w-0'>
            <h1 className='text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]'>
              Get picked by <span className='text-primary'>coding agents.</span>
            </h1>
            <p className='text-muted-foreground mt-4 max-w-md text-base text-pretty sm:text-lg'>Octillion measures how often AI coding agents choose your dev tool, and shows why.</p>
            <div className='mt-8 flex flex-wrap gap-3'>
              <AccountButton size='lg' />
              <Link href='/early-access' className={buttonVariants({ size: 'lg', variant: 'outline' })}>Early access</Link>
            </div>
          </div>
          <DecisionGraph />
        </div>

        <AgentStrip className='mt-16' />
      </div>
    </section>
  );
}

/** The coding agents Octillion measures, as a row of logos. */
export function AgentStrip({ className }: { className?: string }) {
  return (
    <ul aria-label='Agents measured' className={cn('text-foreground/60 flex flex-wrap gap-x-8 gap-y-3 font-mono text-sm', className)}>
      {AGENTS.map(([id, name]) => <li key={id} className='flex items-center gap-2'><AgentLogo id={id} size={18} aria-hidden='true' />{name}</li>)}
    </ul>
  );
}

const PICKS = [
  { agent: 'claude-code', pick: '✓ postgres', tone: 'good' },
  { agent: 'cursor', pick: '✓ postgres', tone: 'good' },
  { agent: 'codex', pick: '✗ mongodb', tone: 'bad' },
  { agent: 'gemini-cli', pick: '– sqlite', tone: 'meh' }
] as const;

const TONE = {
  good: { box: 'fill-primary/15 stroke-primary/50', text: 'fill-primary' },
  bad: { box: 'fill-destructive/15 stroke-destructive/50', text: 'fill-destructive' },
  meh: { box: 'fill-muted stroke-border', text: 'fill-muted-foreground' }
};

/** One prompt, four agents, four different picks: the APO problem in a picture. */
function DecisionGraph() {
  const ys = [50, 150, 250, 350];
  return (
    <figure className='min-w-0'>
      <DecisionGraphVertical />
      <svg viewBox='0 0 560 400' className='hidden h-auto w-full sm:block' role='img' aria-label='One prompt sent to four coding agents: two pick Postgres, one picks MongoDB, one uses SQLite.'>
        <rect x='1' y='174' width='170' height='52' rx='10' className='fill-card stroke-border' />
        <text x='18' y='206' className='fill-foreground font-mono text-[15px]'>&gt; add a database</text>
        {ys.map((y, i) => {
          const p = PICKS[i];
          const curve = `M171 200 C205 200 205 ${y} 236 ${y}`;
          return (
            <g key={p.agent}>
              <path d={curve} fill='none' className='stroke-border' strokeWidth='1.5' />
              <path d={curve} fill='none' className={FLOW} strokeWidth='1.5' />
              <rect x='236' y={y - 20} width='140' height='40' rx='8' className='fill-card stroke-border' />
              <AgentLogo id={p.agent} x='248' y={y - 9} size={18} className='text-foreground' aria-hidden='true' />
              <text x='274' y={y + 5} className='fill-muted-foreground font-mono text-[14px]'>{p.agent}</text>
              <path d={`M376 ${y} L418 ${y}`} className='stroke-border' strokeWidth='1.5' />
              <path d={`M376 ${y} L418 ${y}`} className={FLOW} strokeWidth='1.5' />
              <rect x='418' y={y - 20} width='140' height='40' rx='20' className={TONE[p.tone].box} />
              <text x='488' y={y + 5} textAnchor='middle' className={cn('font-mono text-[14px] font-medium', TONE[p.tone].text)}>{p.pick}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/**
 * The same graph turned vertical for phones, drawn at 1:1 so the text stays readable: the prompt on top, a trunk down
 * the left that branches into one row per agent, each row flowing into its pick.
 */
function DecisionGraphVertical() {
  const top = 70, step = 58;
  const ys = PICKS.map((_, i) => top + 22 + i * step);
  return (
    <svg viewBox='0 0 340 316' className='h-auto w-full sm:hidden' role='img' aria-label='One prompt sent to four coding agents: two pick Postgres, one picks MongoDB, one uses SQLite.'>
      <rect x='1' y='1' width='176' height='42' rx='9' className='fill-card stroke-border' />
      <text x='14' y='27' className='fill-foreground font-mono text-[13px]'>&gt; add a database</text>
      {ys.map((y, i) => {
        const p = PICKS[i];
        const branch = `M22 43 L22 ${y - 14} Q22 ${y} 36 ${y} L48 ${y}`;
        return (
          <g key={p.agent}>
            <path d={branch} fill='none' className='stroke-border' strokeWidth='1.5' />
            <path d={branch} fill='none' className={FLOW} strokeWidth='1.5' />
            <rect x='48' y={y - 18} width='150' height='36' rx='8' className='fill-card stroke-border' />
            <AgentLogo id={p.agent} x='58' y={y - 8} size={16} className='text-foreground' aria-hidden='true' />
            <text x='82' y={y + 4.5} className='fill-muted-foreground font-mono text-[13px]'>{p.agent}</text>
            <path d={`M198 ${y} L226 ${y}`} className='stroke-border' strokeWidth='1.5' />
            <path d={`M198 ${y} L226 ${y}`} className={FLOW} strokeWidth='1.5' />
            <rect x='226' y={y - 18} width='113' height='36' rx='18' className={TONE[p.tone].box} />
            <text x='282.5' y={y + 4.5} textAnchor='middle' className={cn('font-mono text-[13px] font-medium', TONE[p.tone].text)}>{p.pick}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------- why now ----------

const SESSION = [
  ['prompt', '> add background jobs to this app'],
  ['agent', 'agent ▸ I need a durable job queue with retries.'],
  ['agent', 'agent ▸ I\'ll use BullMQ with Redis.'],
  ['cmd', 'agent ▸ $ npm install bullmq ioredis'],
  ['ok', 'agent ▸ ✓ done. 3 files changed.']
] as const;

/** What the agent actually weighed before writing that line: the shortlist nobody sees. */
const WEIGHED = [
  { name: 'BullMQ', note: 'picked and installed', tone: 'pick' },
  { name: 'Inngest', note: 'mentioned, not used', tone: 'meh' },
  { name: 'Trigger.dev', note: 'not considered', tone: 'out' },
  { name: 'Your product', note: 'not considered', tone: 'you' }
] as const;
const WEIGHED_TONE = {
  pick: 'border-primary/50 bg-primary/10 text-primary',
  meh: 'text-foreground/80',
  out: 'text-muted-foreground',
  you: 'border-destructive/40 bg-destructive/10 text-destructive'
};

const REASONS = [
  { icon: IconEyeOff, title: 'Invisible', body: 'No click, no referrer, no analytics event. You never see the decision being made.' },
  { icon: IconGitCompare, title: 'Different per agent', body: 'Claude Code, Codex and Cursor each have their own favourites for the same task.' },
  { icon: IconCode, title: 'Made mid-task', body: 'The choice lands inside a diff the developer accepts without a second look.' }
];

// One line or row after another, 380 ms apart, when the visitor has not asked for reduced motion.
const stagger = (i: number, base = 0) => ({ animationDelay: `${base + i * 380}ms` });
const LINE_IN = 'motion-safe:animate-[line-in_.45s_ease-out_both]';

export function WhyNow() {
  return (
    <Section id='why' eyebrow='Why now' title='Agents pick the stack now.'
      lead='Developers type a task into Claude Code, Codex or Cursor and accept the diff. The agent picks the database, queue or auth library, and nobody reads your landing page.'>
      <div className='grid gap-6 lg:grid-cols-[1.25fr_1fr]'>
        <div className='overflow-hidden rounded-xl border bg-black/40'>
          <div className='flex items-center gap-1.5 border-b px-4 py-3'>
            <span className='size-2.5 rounded-full bg-white/15' /><span className='size-2.5 rounded-full bg-white/15' /><span className='size-2.5 rounded-full bg-white/15' />
            <span className='text-muted-foreground ml-2 font-mono text-xs'>claude-code · ~/acme-app</span>
          </div>
          <pre className='overflow-x-auto p-5 font-mono text-[13px] leading-7 whitespace-pre-wrap'>
            {SESSION.map(([k, line], i) => (
              <div key={i} style={stagger(i)} className={cn(LINE_IN, k === 'prompt' && 'text-foreground', k === 'cmd' && 'text-amber-300', k === 'ok' && 'text-foreground/80', k === 'agent' && 'text-foreground/70')}>{line}</div>
            ))}
            <div style={stagger(SESSION.length)} className={cn(LINE_IN, 'text-primary mt-3')}># was your product even considered?</div>
          </pre>
        </div>

        <div className='flex flex-col justify-center gap-3 rounded-xl border p-5'>
          <p className='text-muted-foreground font-mono text-xs tracking-wide uppercase'>What it weighed</p>
          <ul className='flex flex-col gap-2'>
            {WEIGHED.map((w, i) => (
              <li key={w.name} style={stagger(i, SESSION.length * 380 + 200)}
                className={cn(LINE_IN, 'flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3', WEIGHED_TONE[w.tone])}>
                <span className='font-medium'>{w.name}</span>
                <span className={cn('text-xs', w.tone === 'meh' || w.tone === 'out' ? 'text-muted-foreground' : '')}>{w.note}</span>
              </li>
            ))}
          </ul>
          <p className='text-muted-foreground text-sm'>Octillion shows you this shortlist for every agent, on tasks your buyers really give them.</p>
        </div>
      </div>

      <ul className='mt-12 grid gap-8 sm:grid-cols-3'>
        {REASONS.map((r) => (
          <li key={r.title} className='flex flex-col gap-3'>
            <r.icon className='text-primary size-7' stroke={1.5} />
            <p className='text-lg font-semibold'>{r.title}</p>
            <p className='text-muted-foreground text-sm leading-relaxed'>{r.body}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------- what is APO ----------

const ERAS = [
  { icon: IconSearch, short: 'SEO', who: 'People', win: 'A click', next: 'A visit, then maybe a signup', measure: 'Rankings' },
  { icon: IconMessageChatbot, short: 'GEO', who: 'Chatbots', win: 'A mention', next: 'Maybe a search, then a visit', measure: 'Citations' },
  { icon: IconTerminal2, short: 'APO', who: 'Coding agents', win: 'An install', next: 'Nothing: it’s already in their code', measure: 'Pick rate per agent', current: true }
];
const ERA_ROWS: [string, 'who' | 'win' | 'next' | 'measure'][] = [['Who decides', 'who'], ['You win', 'win'], ['Still to go', 'next'], ['You measure', 'measure']];

export function WhatIsApo() {
  return (
    <Section id='apo' eyebrow='What is APO' title='Earn the agent’s pick, and prove it.'
      lead='Agentic Preference Optimization measures and improves how often coding agents choose your product in the middle of real work. Like SEO, you can’t buy the pick, but you can earn it.'>
      <ApoLoop />
    </Section>
  );
}

/** SEO, GEO, APO side by side: each channel's win, and how far that win still is from a customer. */
export function ClosestToRevenue() {
  return (
    <Section id='convert' eyebrow='Why APO converts' title='The step closest to revenue.'
      lead='A click still has to become a signup, and a mention still has to become a visit. When a coding agent picks you, the install has already happened: your product is in the codebase, the step every other channel is working toward.'>
      <div className='mx-auto grid max-w-3xl grid-cols-[auto_1fr_1fr_1fr] text-sm'>
        <span />
        {ERAS.map((e) => (
          <div key={e.short} className={cn('flex flex-col items-center gap-2 rounded-t-xl px-2 pt-4 pb-3', e.current && 'bg-primary/10 border-primary/40 border-x border-t')}>
            <e.icon className={cn('size-6', e.current ? 'text-primary' : 'text-muted-foreground')} stroke={1.5} />
            <span className={cn('font-mono text-xl font-semibold', e.current ? 'text-primary' : 'text-foreground/80')}>{e.short}</span>
          </div>
        ))}
        {ERA_ROWS.map(([label, key], r) => (<Fragment key={key}>
          <span className='text-muted-foreground border-t py-4 pr-4 text-xs leading-tight sm:text-sm'>{label}</span>
          {ERAS.map((e) => (
            <span key={`${key}-${e.short}`} className={cn('border-t px-2 py-4 text-center leading-tight',
              e.current ? cn('bg-primary/10 border-x-primary/40 border-x font-medium', r === ERA_ROWS.length - 1 && 'border-b-primary/40 rounded-b-xl border-b') : 'text-muted-foreground')}>
              {e[key]}
            </span>
          ))}
        </Fragment>))}
      </div>
    </Section>
  );
}

const STEPS = [
  { n: '01', label: 'Profile product', sub: 'what you sell, who buys it' },
  { n: '02', label: 'Blind tasks', sub: 'real work, never naming you' },
  { n: '03', label: 'Agents run', sub: 'every major coding agent' }
];

/** An arrowhead pointing down (or left) with its tip at x, y. */
const tipDown = (x: number, y: number) => `M${x - 4.5} ${y - 7} L${x + 4.5} ${y - 7} L${x} ${y} Z`;
const tipLeft = (x: number, y: number) => `M${x + 7} ${y - 4.5} L${x + 7} ${y + 4.5} L${x} ${y} Z`;

/** A dashed, flowing connector with its arrowhead. */
function Flow({ d, tip }: { d: string; tip: string }) {
  return (
    <g>
      <path d={d} fill='none' className='stroke-border' strokeWidth='1.5' />
      <path d={d} fill='none' className={FLOW} strokeWidth='2' />
      <path d={tip} className='fill-primary' />
    </g>
  );
}

/**
 * APO as an if/else: profile, pose blind tasks, let the agents run, then branch on the verdict. Picked: keep it there
 * by tracking the pick rate every release. Not picked: score the transcripts, fix docs/SDKs/examples, and run again.
 * One vertical drawing at every width, drawn near 1:1 on a phone so its text stays readable.
 */
function ApoLoop() {
  const W = 280, h = 56, x0 = 40, cx = 180;
  const ys = STEPS.map((_, i) => i * (h + 28));
  const dy = ys[2] + h + 30 + 40; // diamond centre
  const by = dy + 80; // branch boxes' top
  return (
    <svg viewBox='0 0 380 460' className='mx-auto h-auto w-full max-w-md' role='img'
      aria-label='APO: profile your product, pose blind tasks, agents run them. If an agent picks you, track the pick rate every release; if not, score and fix your docs, SDKs and examples, then run again.'>
      {ys.slice(0, -1).map((y) => <Flow key={y} d={`M${cx} ${y + h} L${cx} ${y + h + 27}`} tip={tipDown(cx, y + h + 28)} />)}
      <Flow d={`M${cx} ${ys[2] + h} L${cx} ${dy - 41}`} tip={tipDown(cx, dy - 40)} />
      {STEPS.map((st, i) => (
        <g key={st.n}>
          <rect x={x0} y={ys[i] + 1} width={W} height={h} rx='14' className='fill-background stroke-primary/60' />
          <text x={x0 + 16} y={ys[i] + 26} className='fill-primary font-mono text-[12px]'>{st.n}</text>
          <text x={x0 + 42} y={ys[i] + 26} className='fill-foreground text-[14px] font-medium'>{st.label}</text>
          <text x={x0 + 16} y={ys[i] + 45} className='fill-muted-foreground text-[12px]'>{st.sub}</text>
        </g>
      ))}
      {/* if: did the agent pick you? */}
      <path d={`M${cx} ${dy - 40} L${cx + 78} ${dy} L${cx} ${dy + 40} L${cx - 78} ${dy} Z`} className='fill-primary/10 stroke-primary' strokeWidth='1.5' />
      <text x={cx} y={dy + 5} textAnchor='middle' className='fill-foreground text-[14px] font-semibold'>Picked you?</text>
      <Flow d={`M${cx - 78} ${dy} L${83} ${dy} L${83} ${by - 1}`} tip={tipDown(83, by)} />
      <text x={cx - 92} y={dy - 8} textAnchor='end' className='fill-primary font-mono text-[12px]'>yes</text>
      <Flow d={`M${cx + 78} ${dy} L${255} ${dy} L${255} ${by - 1}`} tip={tipDown(255, by)} />
      <text x={cx + 92} y={dy - 8} className='fill-destructive font-mono text-[12px]'>no</text>
      {/* then: keep it */}
      <rect x='1' y={by} width='164' height={h} rx='14' className='fill-primary/15 stroke-primary/60' />
      <text x='16' y={by + 25} className='fill-primary text-[14px] font-medium'>✓ Picked</text>
      <text x='16' y={by + 44} className='fill-muted-foreground text-[12px]'>track it every release</text>
      {/* else: fix and run again */}
      <rect x='175' y={by} width='160' height={h} rx='14' className='fill-background stroke-destructive/60' />
      <text x='190' y={by + 25} className='fill-foreground text-[14px] font-medium'><tspan className='fill-destructive font-mono text-[12px]'>04</tspan><tspan dx='8'>Score &amp; fix</tspan></text>
      <text x='190' y={by + 44} className='fill-muted-foreground text-[12px]'>docs, SDKs, examples</text>
      <Flow d={`M255 ${by + h} L255 ${by + h + 14} Q255 ${by + h + 22} 263 ${by + h + 22} L352 ${by + h + 22} L352 ${ys[2] + h / 2} L${x0 + W + 8} ${ys[2] + h / 2}`}
        tip={tipLeft(x0 + W + 1, ys[2] + h / 2)} />
      <text x='368' y={(by + ys[2] + h) / 2} textAnchor='middle' transform={`rotate(-90 368 ${(by + ys[2] + h) / 2})`} className='fill-muted-foreground font-mono text-[11px]'>run again</text>
    </svg>
  );
}

// ---------- scorecard ----------

const BY_AGENT = [['claude-code', 75], ['cursor', 62], ['copilot', 55], ['gemini-cli', 40], ['codex', 25]] as const;
const TREND = [22, 25, 24, 27, 26, 41, 46, 48];

const VERDICTS = [
  { name: 'Adopted', cls: 'bg-primary/15 text-primary' },
  { name: 'Recommended', cls: 'bg-primary/15 text-primary' },
  { name: 'Mentioned', cls: 'bg-muted text-muted-foreground' },
  { name: 'Competitor', cls: 'bg-destructive/15 text-destructive' },
  { name: 'None', cls: 'bg-secondary text-secondary-foreground' }
];

export function Scorecard() {
  const pts = TREND.map((v, i) => `${10 + i * 40},${110 - v * 1.8}`).join(' ');
  return (
    <Section id='features' eyebrow='Scorecard' title='A number you can move.'
      lead='See your pick rate by agent, task and competitor, with every verdict linked to the transcript behind it. Re-run the same tasks after each docs or SDK change to prove it moved.'>
      <div className='grid gap-x-10 gap-y-12 md:grid-cols-3'>
        <figure className='border-t pt-5'>
          <figcaption className='text-muted-foreground font-mono text-xs uppercase'>By agent</figcaption>
          <ul className='mt-5 space-y-3'>
            {BY_AGENT.map(([n, v]) => (
              <li key={n} className='grid grid-cols-[7rem_1fr_2.5rem] items-center gap-3 text-xs'>
                <span className='text-muted-foreground flex items-center gap-1.5 font-mono'><AgentLogo id={n} size={13} aria-hidden='true' />{n}</span>
                <span className='bg-muted h-2 rounded-full'><span className='bg-primary block h-full rounded-full' style={{ width: `${v}%` }} /></span>
                <span className='text-right tabular-nums'>{v}%</span>
              </li>
            ))}
          </ul>
        </figure>

        <figure className='border-t pt-5'>
          <figcaption className='text-muted-foreground font-mono text-xs uppercase'>Share of voice</figcaption>
          <div className='mt-4 flex items-center gap-6'>
            <svg viewBox='0 0 120 120' className='size-32 shrink-0 -rotate-90' aria-hidden='true'>
              <circle cx='60' cy='60' r='48' fill='none' strokeWidth='14' className='stroke-muted' />
              <circle cx='60' cy='60' r='48' fill='none' strokeWidth='14' pathLength={100} strokeDasharray='58 100' className='stroke-primary' />
              <circle cx='60' cy='60' r='48' fill='none' strokeWidth='14' pathLength={100} strokeDasharray='30 100' strokeDashoffset={-58} className='stroke-destructive/70' />
            </svg>
            <ul className='space-y-2 text-xs'>
              <li className='flex items-center gap-2'><span className='bg-primary size-2 rounded-full' />Postgres <b className='ml-auto pl-3 tabular-nums'>58%</b></li>
              <li className='flex items-center gap-2'><span className='bg-destructive/70 size-2 rounded-full' />MongoDB <b className='ml-auto pl-3 tabular-nums'>30%</b></li>
              <li className='flex items-center gap-2'><span className='bg-muted size-2 rounded-full' />SQLite <b className='ml-auto pl-3 tabular-nums'>12%</b></li>
            </ul>
          </div>
        </figure>

        <figure className='border-t pt-5'>
          <figcaption className='text-muted-foreground flex font-mono text-xs uppercase'>After your fix <span className='text-primary ml-auto'>+22 pts</span></figcaption>
          <svg viewBox='0 0 300 120' className='mt-4 h-auto w-full' aria-hidden='true'>
            <line x1='190' y1='0' x2='190' y2='118' className='stroke-border' strokeDasharray='3 4' />
            <text x='196' y='12' className='fill-muted-foreground font-mono text-[10px]'>docs fix</text>
            <polyline points={pts} fill='none' className='stroke-primary' strokeWidth='2.5' strokeLinejoin='round' strokeLinecap='round' />
            <circle cx={10 + 7 * 40} cy={110 - 48 * 1.8} r='4' className='fill-primary' />
          </svg>
        </figure>
      </div>

      <div className='mt-12 flex flex-wrap items-center gap-2'>
        {VERDICTS.map((v) => <span key={v.name} className={cn('rounded-full px-3 py-1 text-xs font-medium', v.cls)}>{v.name}</span>)}
        <span className='text-muted-foreground ml-1 text-xs'>Every verdict links to its transcript. Sample data.</span>
      </div>
    </Section>
  );
}

// ---------- Claude & ChatGPT ----------

export function WhereYouWork() {
  return (
    <Section id='claude' eyebrow='Claude & ChatGPT' title='Just ask.'
      lead='Octillion is an MCP server, so you can set up products, launch simulations and explore results in plain language from Claude or ChatGPT, with charts rendered right in the chat.'>
      <div className='mx-auto max-w-2xl space-y-4'>
        <div className='bg-muted ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm'>Where does Codex pick MongoDB over Postgres?</div>
        <div className='text-muted-foreground flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs'>
          <IconBolt className='text-primary size-3.5' /> octillion · get_share_of_voice
        </div>
        <div className='space-y-2.5 border-l-2 border-primary/40 pl-4'>
          {[['Python worker', 22], ['Next.js app', 64], ['Edge function', 71]].map(([n, v]) => (
            <div key={n} className='grid grid-cols-[7rem_1fr_2.5rem] items-center gap-3 text-xs'>
              <span className='text-muted-foreground'>{n}</span>
              <span className='bg-muted h-2 rounded-full'><span className={cn('block h-full rounded-full', Number(v) < 40 ? 'bg-destructive/70' : 'bg-primary')} style={{ width: `${v}%` }} /></span>
              <span className='text-right tabular-nums'>{v}%</span>
            </div>
          ))}
        </div>
        <div className='bg-muted ml-auto w-fit rounded-2xl rounded-br-sm px-4 py-2.5 text-sm'>Show me the Python transcripts.</div>
        <p className='text-muted-foreground pt-2 text-center text-xs'>Illustrative · sample values</p>
      </div>
    </Section>
  );
}
