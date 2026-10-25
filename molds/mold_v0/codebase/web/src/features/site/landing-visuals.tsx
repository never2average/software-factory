import { IconBolt } from '@tabler/icons-react';
import { cn } from '@/lib/utils';
import { AgentLogo } from './agent-logos';
import { LANDING_ICONS } from './landing-icons';
import type {
  ChatVisual, DecisionGraphVisual, LandingVisual, LoopVisual, PathsVisual, ScorecardVisual, TranscriptVisual
} from './landing-types';

/**
 * The landing page's visual templates (mold_v0-122): faithful, data-driven generalisations of the first product's landing
 * drawings (its decision graph, session transcript, if/else loop, channel cards, scorecard and chat), with the same
 * geometry, spacing and type, so that product's own words reproduce its page. Every colour is a theme token; every text
 * is the block's, shown as text. A pack names a template and gives its data; it never brings a drawing.
 */

/** Thin animated dashes along a path: shows direction of flow (still when reduced motion is on). */
const FLOW = 'stroke-primary [stroke-dasharray:4_12] motion-safe:animate-[apo-dash_1.4s_linear_infinite]';

// One line or row after another, 380 ms apart, when the visitor has not asked for reduced motion.
const stagger = (i: number, base = 0) => ({ animationDelay: `${base + i * 380}ms` });
const LINE_IN = 'motion-safe:animate-[line-in_.45s_ease-out_both]';
const two = (n: number) => String(n).padStart(2, '0');

// ---------- decision graph: one prompt, several outcomes ----------

const TONE = {
  good: { box: 'fill-primary/15 stroke-primary/50', text: 'fill-primary' },
  bad: { box: 'fill-destructive/15 stroke-destructive/50', text: 'fill-destructive' },
  neutral: { box: 'fill-muted stroke-border', text: 'fill-muted-foreground' }
};

function DecisionGraph({ v }: { v: DecisionGraphVisual }) {
  const n = v.branches.length;
  const ys = v.branches.map((_, i) => 200 + (i - (n - 1) / 2) * 100);
  return (
    <figure className='min-w-0'>
      <DecisionGraphVertical v={v} />
      <svg viewBox='0 0 560 400' className='hidden h-auto w-full sm:block' role='img' aria-label={v.label}>
        <rect x='1' y='174' width='170' height='52' rx='10' className='fill-card stroke-border' />
        <text x='18' y='206' className='fill-foreground font-mono text-[15px]'>{v.root}</text>
        {ys.map((y, i) => {
          const b = v.branches[i]!;
          const tone = TONE[b.tone ?? 'neutral'];
          const curve = `M171 200 C205 200 205 ${y} 236 ${y}`;
          return (
            <g key={i}>
              <path d={curve} fill='none' className='stroke-border' strokeWidth='1.5' />
              <path d={curve} fill='none' className={FLOW} strokeWidth='1.5' />
              <rect x='236' y={y - 20} width='140' height='40' rx='8' className='fill-card stroke-border' />
              {b.logo ? <AgentLogo id={b.logo} x='248' y={y - 9} size={18} className='text-foreground' aria-hidden='true' /> : null}
              <text x={b.logo ? 274 : 250} y={y + 5} className='fill-muted-foreground font-mono text-[14px]'>{b.label}</text>
              <path d={`M376 ${y} L418 ${y}`} className='stroke-border' strokeWidth='1.5' />
              <path d={`M376 ${y} L418 ${y}`} className={FLOW} strokeWidth='1.5' />
              <rect x='418' y={y - 20} width='140' height='40' rx='20' className={tone.box} />
              <text x='488' y={y + 5} textAnchor='middle' className={cn('font-mono text-[14px] font-medium', tone.text)}>{b.outcome}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/**
 * The same graph turned vertical for phones, drawn at 1:1 so the text stays readable: the prompt on top, a trunk down
 * the left that branches into one row per outcome, each row flowing into its outcome.
 */
function DecisionGraphVertical({ v }: { v: DecisionGraphVisual }) {
  const top = 70, step = 58;
  const ys = v.branches.map((_, i) => top + 22 + i * step);
  return (
    <svg viewBox={`0 0 340 ${ys[ys.length - 1]! + 50}`} className='h-auto w-full sm:hidden' role='img' aria-label={v.label}>
      <rect x='1' y='1' width='176' height='42' rx='9' className='fill-card stroke-border' />
      <text x='14' y='27' className='fill-foreground font-mono text-[13px]'>{v.root}</text>
      {ys.map((y, i) => {
        const b = v.branches[i]!;
        const tone = TONE[b.tone ?? 'neutral'];
        const branch = `M22 43 L22 ${y - 14} Q22 ${y} 36 ${y} L48 ${y}`;
        return (
          <g key={i}>
            <path d={branch} fill='none' className='stroke-border' strokeWidth='1.5' />
            <path d={branch} fill='none' className={FLOW} strokeWidth='1.5' />
            <rect x='48' y={y - 18} width='150' height='36' rx='8' className='fill-card stroke-border' />
            {b.logo ? <AgentLogo id={b.logo} x='58' y={y - 8} size={16} className='text-foreground' aria-hidden='true' /> : null}
            <text x={b.logo ? 82 : 60} y={y + 4.5} className='fill-muted-foreground font-mono text-[13px]'>{b.label}</text>
            <path d={`M198 ${y} L226 ${y}`} className='stroke-border' strokeWidth='1.5' />
            <path d={`M198 ${y} L226 ${y}`} className={FLOW} strokeWidth='1.5' />
            <rect x='226' y={y - 18} width='113' height='36' rx='18' className={tone.box} />
            <text x='282.5' y={y + 4.5} textAnchor='middle' className={cn('font-mono text-[13px] font-medium', tone.text)}>{b.outcome}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------- transcript: a terminal session and what it weighed ----------

const LINE_TONE = { prompt: 'text-foreground', command: 'text-amber-300', ok: 'text-foreground/80', agent: 'text-foreground/70' };
const ASIDE_TONE = {
  pick: 'border-primary/50 bg-primary/10 text-primary',
  neutral: 'text-foreground/80',
  muted: 'text-muted-foreground',
  // The red is the frame, not the text: red text on its own 10% tint fell short of 4.5:1 (mold_v0-082).
  alert: 'border-destructive/40 bg-destructive/10 text-foreground'
};

function Transcript({ v }: { v: TranscriptVisual }) {
  const terminal = (
    <div className='overflow-hidden rounded-xl border bg-black/40'>
      <div className='flex items-center gap-1.5 border-b px-4 py-3'>
        <span className='size-2.5 rounded-full bg-white/15' /><span className='size-2.5 rounded-full bg-white/15' /><span className='size-2.5 rounded-full bg-white/15' />
        <span className='text-muted-foreground ml-2 font-mono text-xs'>{v.title}</span>
      </div>
      <pre className='overflow-x-auto p-5 font-mono text-[13px] leading-7 whitespace-pre-wrap'>
        {v.lines.map((l, i) => <div key={i} style={stagger(i)} className={cn(LINE_IN, LINE_TONE[l.tone ?? 'agent'])}>{l.text}</div>)}
        {v.highlight ? <div style={stagger(v.lines.length)} className={cn(LINE_IN, 'text-primary mt-3')}>{v.highlight}</div> : null}
      </pre>
    </div>
  );
  if (!v.aside) return terminal;
  return (
    <div className='grid gap-6 lg:grid-cols-[1.25fr_1fr]'>
      {terminal}
      <div className='flex flex-col justify-center gap-3 rounded-xl border p-5'>
        {v.aside.title ? <p className='text-muted-foreground font-mono text-xs tracking-wide uppercase'>{v.aside.title}</p> : null}
        <ul className='flex flex-col gap-2'>
          {v.aside.items.map((w, i) => (
            <li key={i} style={stagger(i, v.lines.length * 380 + 200)}
              className={cn(LINE_IN, 'flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3', ASIDE_TONE[w.tone ?? 'neutral'])}>
              <span className='font-medium'>{w.label}</span>
              {w.note ? <span className={cn('text-xs', w.tone === 'pick' || w.tone === 'alert' ? '' : 'text-muted-foreground')}>{w.note}</span> : null}
            </li>
          ))}
        </ul>
        {v.aside.note ? <p className='text-muted-foreground text-sm'>{v.aside.note}</p> : null}
      </div>
    </div>
  );
}

// ---------- loop: steps, a yes/no question, keep it or fix and run again ----------

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

/** The steps as an if/else, one vertical drawing at every width, drawn near 1:1 on a phone so its text stays readable. */
function Loop({ v }: { v: LoopVisual }) {
  const W = 280, h = 56, x0 = 40, cx = 180;
  const ys = v.steps.map((_, i) => i * (h + 28));
  const last = ys[ys.length - 1]!;
  const dy = last + h + 30 + 40; // diamond centre
  const by = dy + 80; // branch boxes' top
  return (
    <svg viewBox={`0 0 380 ${by + h + 30}`} className='mx-auto h-auto w-full max-w-md' role='img' aria-label={v.label}>
      {ys.slice(0, -1).map((y) => <Flow key={y} d={`M${cx} ${y + h} L${cx} ${y + h + 27}`} tip={tipDown(cx, y + h + 28)} />)}
      <Flow d={`M${cx} ${last + h} L${cx} ${dy - 41}`} tip={tipDown(cx, dy - 40)} />
      {v.steps.map((st, i) => (
        <g key={i}>
          <rect x={x0} y={ys[i]! + 1} width={W} height={h} rx='14' className='fill-background stroke-primary/60' />
          <text x={x0 + 16} y={ys[i]! + 26} className='fill-primary font-mono text-[12px]'>{two(i + 1)}</text>
          <text x={x0 + 42} y={ys[i]! + 26} className='fill-foreground text-[14px] font-medium'>{st.label}</text>
          <text x={x0 + 16} y={ys[i]! + 45} className='fill-muted-foreground text-[12px]'>{st.sub}</text>
        </g>
      ))}
      <path d={`M${cx} ${dy - 40} L${cx + 78} ${dy} L${cx} ${dy + 40} L${cx - 78} ${dy} Z`} className='fill-primary/10 stroke-primary' strokeWidth='1.5' />
      <text x={cx} y={dy + 5} textAnchor='middle' className='fill-foreground text-[14px] font-semibold'>{v.question}</text>
      <Flow d={`M${cx - 78} ${dy} L${83} ${dy} L${83} ${by - 1}`} tip={tipDown(83, by)} />
      <text x={cx - 92} y={dy - 8} textAnchor='end' className='fill-primary font-mono text-[12px]'>{v.yes_tag ?? 'yes'}</text>
      <Flow d={`M${cx + 78} ${dy} L${255} ${dy} L${255} ${by - 1}`} tip={tipDown(255, by)} />
      <text x={cx + 92} y={dy - 8} className='fill-destructive font-mono text-[12px]'>{v.no_tag ?? 'no'}</text>
      <rect x='1' y={by} width='164' height={h} rx='14' className='fill-primary/15 stroke-primary/60' />
      <text x='16' y={by + 25} className='fill-primary text-[14px] font-medium'>{v.yes.label}</text>
      <text x='16' y={by + 44} className='fill-muted-foreground text-[12px]'>{v.yes.sub}</text>
      <rect x='175' y={by} width='160' height={h} rx='14' className='fill-background stroke-destructive/60' />
      <text x='190' y={by + 25} className='fill-foreground text-[14px] font-medium'><tspan className='fill-destructive font-mono text-[12px]'>{two(v.steps.length + 1)}</tspan><tspan dx='8'>{v.no.label}</tspan></text>
      <text x='190' y={by + 44} className='fill-muted-foreground text-[12px]'>{v.no.sub}</text>
      <Flow d={`M255 ${by + h} L255 ${by + h + 14} Q255 ${by + h + 22} 263 ${by + h + 22} L352 ${by + h + 22} L352 ${last + h / 2} L${x0 + W + 8} ${last + h / 2}`}
        tip={tipLeft(x0 + W + 1, last + h / 2)} />
      <text x='368' y={(by + last + h) / 2} textAnchor='middle' transform={`rotate(-90 368 ${(by + last + h) / 2})`} className='fill-muted-foreground font-mono text-[11px]'>{v.again}</text>
    </svg>
  );
}

// ---------- paths: cards side by side, each a path of chips to the goal ----------

function Paths({ v }: { v: PathsVisual }) {
  return (
    <ol className='grid gap-4 md:grid-cols-3'>
      {v.items.map((e, k) => {
        const Icon = e.icon ? LANDING_ICONS[e.icon] : null;
        const togo = e.path.length - 1;
        return (
          <li key={k} className={cn('flex flex-col gap-5 rounded-2xl border p-5',
            e.highlight ? 'border-primary/50 bg-primary/10 shadow-[0_0_40px_-12px] shadow-primary/40' : 'bg-card/40')}>
            <div className='flex items-center gap-3'>
              {Icon ? (
                <span className={cn('flex size-9 items-center justify-center rounded-lg border', e.highlight ? 'border-primary/50 text-primary' : 'text-muted-foreground')}>
                  <Icon className='size-5' stroke={1.5} />
                </span>
              ) : null}
              <span className='flex flex-col'>
                <span className={cn('font-mono text-lg leading-tight font-semibold', e.highlight ? 'text-primary' : 'text-foreground/80')}>{e.title}</span>
                {e.subtitle ? <span className='text-muted-foreground text-xs'>{e.subtitle}</span> : null}
              </span>
            </div>
            <div>
              {e.value_label ? <div className='text-muted-foreground text-xs'>{e.value_label}</div> : null}
              <div className={cn('text-xl font-semibold', !e.highlight && 'text-foreground/80')}>{e.value}</div>
            </div>
            <div className='flex flex-col gap-2'>
              {v.count_label || v.done_label ? (
                <div className={cn('text-sm font-medium', e.highlight ? 'text-primary' : 'text-muted-foreground')}>
                  {togo ? (v.count_label ?? '').replace('{n}', String(togo)) : v.done_label}
                </div>
              ) : null}
              <ol className='flex flex-wrap items-center gap-1.5' aria-label={`${e.title}: ${e.path.join(', then ')}`}>
                {e.path.map((step, i) => {
                  const goal = i === e.path.length - 1;
                  return (
                    <li key={i} className='flex items-center gap-1.5'>
                      {i > 0 && <span className='text-muted-foreground/60 text-xs' aria-hidden='true'>→</span>}
                      <span className={cn('rounded-full px-2.5 py-1 text-xs',
                        i === 0 && !goal && 'bg-foreground/10 text-foreground',
                        i > 0 && !goal && 'text-muted-foreground border border-dashed',
                        goal && (e.highlight ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground border border-dashed'))}>
                        {goal && e.highlight ? `✓ ${step}` : step}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
            {e.measure ? (
              <div className='text-muted-foreground mt-auto border-t pt-3 text-xs'>
                {v.measure_label ? `${v.measure_label} ` : ''}<span className={cn('font-medium', e.highlight ? 'text-foreground' : 'text-foreground/80')}>{e.measure}</span>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- scorecard: bars, a donut, a trend and chips ----------

const SLICE = { primary: 'stroke-primary', alert: 'stroke-destructive/70', muted: '' };
const DOT = { primary: 'bg-primary', alert: 'bg-destructive/70', muted: 'bg-muted' };
const CHIP = {
  primary: 'bg-primary/15 text-primary',
  muted: 'bg-muted text-muted-foreground',
  alert: 'bg-destructive/15 text-foreground', // red text on its tint fell short of 4.5:1 (mold_v0-082)
  secondary: 'bg-secondary text-secondary-foreground'
};

function Scorecard({ v }: { v: ScorecardVisual }) {
  const t = v.trend;
  const step = t ? 280 / (t.points.length - 1) : 0;
  const pts = t ? t.points.map((p, i) => `${10 + i * step},${110 - p * 1.8}`).join(' ') : '';
  const marker = t && t.marker_after !== undefined && t.marker_after < t.points.length - 1 ? 10 + (t.marker_after + 0.5) * step : null;
  let offset = 0;
  return (
    <>
      <div className='grid gap-x-10 gap-y-12 md:grid-cols-3'>
        {v.bars ? (
          <figure className='border-t pt-5'>
            <figcaption className='text-muted-foreground font-mono text-xs uppercase'>{v.bars.title}</figcaption>
            <ul className='mt-5 space-y-3'>
              {v.bars.rows.map((r, i) => (
                <li key={i} className='grid grid-cols-[7rem_1fr_2.5rem] items-center gap-3 text-xs'>
                  <span className='text-muted-foreground flex items-center gap-1.5 font-mono'>{r.logo ? <AgentLogo id={r.logo} size={13} aria-hidden='true' /> : null}{r.label}</span>
                  <span className='bg-muted h-2 rounded-full'><span className='bg-primary block h-full rounded-full' style={{ width: `${r.value}%` }} /></span>
                  <span className='text-right tabular-nums'>{r.value}%</span>
                </li>
              ))}
            </ul>
          </figure>
        ) : null}
        {v.donut ? (
          <figure className='border-t pt-5'>
            <figcaption className='text-muted-foreground font-mono text-xs uppercase'>{v.donut.title}</figcaption>
            <div className='mt-4 flex items-center gap-6'>
              <svg viewBox='0 0 120 120' className='size-32 shrink-0 -rotate-90' aria-hidden='true'>
                <circle cx='60' cy='60' r='48' fill='none' strokeWidth='14' className='stroke-muted' />
                {v.donut.slices.map((s, i) => {
                  const at = offset;
                  offset += s.value;
                  return (s.tone ?? 'primary') === 'muted' ? null : (
                    <circle key={i} cx='60' cy='60' r='48' fill='none' strokeWidth='14' pathLength={100} strokeDasharray={`${s.value} 100`}
                      {...(at ? { strokeDashoffset: -at } : {})} className={SLICE[s.tone ?? 'primary']} />
                  );
                })}
              </svg>
              <ul className='space-y-2 text-xs'>
                {v.donut.slices.map((s, i) => (
                  <li key={i} className='flex items-center gap-2'><span className={cn('size-2 rounded-full', DOT[s.tone ?? 'primary'])} />{s.label} <b className='ml-auto pl-3 tabular-nums'>{s.value}%</b></li>
                ))}
              </ul>
            </div>
          </figure>
        ) : null}
        {t ? (
          <figure className='border-t pt-5'>
            <figcaption className='text-muted-foreground flex font-mono text-xs uppercase'>{t.title} {t.delta ? <span className='text-primary ml-auto'>{t.delta}</span> : null}</figcaption>
            <svg viewBox='0 0 300 120' className='mt-4 h-auto w-full' aria-hidden='true'>
              {marker !== null ? <line x1={marker} y1='0' x2={marker} y2='118' className='stroke-border' strokeDasharray='3 4' /> : null}
              {marker !== null && t.marker_label ? <text x={marker + 6} y='12' className='fill-muted-foreground font-mono text-[10px]'>{t.marker_label}</text> : null}
              <polyline points={pts} fill='none' className='stroke-primary' strokeWidth='2.5' strokeLinejoin='round' strokeLinecap='round' />
              <circle cx={10 + (t.points.length - 1) * step} cy={110 - t.points[t.points.length - 1]! * 1.8} r='4' className='fill-primary' />
            </svg>
          </figure>
        ) : null}
      </div>
      {v.chips || v.note ? (
        <div className='mt-12 flex flex-wrap items-center gap-2'>
          {(v.chips ?? []).map((c, i) => <span key={i} className={cn('rounded-full px-3 py-1 text-xs font-medium', CHIP[c.tone ?? 'muted'])}>{c.label}</span>)}
          {v.note ? <span className='text-muted-foreground ml-1 text-xs'>{v.note}</span> : null}
        </div>
      ) : null}
    </>
  );
}

// ---------- chat: a sample conversation with the assistant ----------

function Chat({ v }: { v: ChatVisual }) {
  return (
    <figure className='mx-auto max-w-2xl space-y-4'>
      {v.messages.map((m, i) => {
        if (m.from === 'person') return <p key={i} className='bg-muted ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2.5 text-sm'><span className='sr-only'>You: </span>{m.text}</p>;
        if (m.from === 'tool') return (
          <p key={i} className='text-muted-foreground flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs'>
            <IconBolt className='text-primary size-3.5' aria-hidden='true' /><span className='sr-only'>Tool call: </span>{m.text}
          </p>
        );
        if (m.from === 'bars') return (
          <div key={i} className='space-y-2.5 border-l-2 border-primary/40 pl-4'>
            {m.rows.map((r, k) => (
              <div key={k} className='grid grid-cols-[7rem_1fr_2.5rem] items-center gap-3 text-xs'>
                <span className='text-muted-foreground'>{r.label}</span>
                <span className='bg-muted h-2 rounded-full'><span className={cn('block h-full rounded-full', r.value < (m.low_below ?? 40) ? 'bg-destructive/70' : 'bg-primary')} style={{ width: `${r.value}%` }} /></span>
                <span className='text-right tabular-nums'>{r.value}%</span>
              </div>
            ))}
          </div>
        );
        return <p key={i} className='border-primary/40 border-l-2 pl-4 text-sm leading-relaxed'><span className='sr-only'>Assistant: </span>{m.text}</p>;
      })}
      {v.note ? <figcaption className='text-muted-foreground pt-2 text-center text-xs'>{v.note}</figcaption> : null}
    </figure>
  );
}

/** A visual template, by its type. */
export function Visual({ v }: { v: LandingVisual }) {
  switch (v.type) {
    case 'decision_graph': return <DecisionGraph v={v} />;
    case 'transcript': return <Transcript v={v} />;
    case 'loop': return <Loop v={v} />;
    case 'paths': return <Paths v={v} />;
    case 'scorecard': return <Scorecard v={v} />;
    case 'chat': return <Chat v={v} />;
  }
}
