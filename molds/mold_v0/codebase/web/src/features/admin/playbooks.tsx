'use client';
// Customer journeys: the use-case pipelines customers follow on /app Setup. The editor used by the
// Journeys table (journeys.tsx); write journeys there and promote the ones customers see. Progress on /app comes from real tool calls (src/playbooks.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActionsMenu } from '@/components/layout/record-view';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { adminApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { post, useAdminAction } from './lib';
import { Gate } from './role';

export interface Stage { id?: string; title: string; why: string; prompt: string; tools: string[]; expect: string; manual?: boolean }
export interface Playbook {
  id: string; name: string; outcome: string; who: string; time: string; example: { title: string; result: string };
  stages: Stage[]; promoted: boolean; updated_at: string; updated_by: string | null;
  adoption?: { started: number; completed: number; median_hours_to_complete: number | null; dropoff: { id: string; title: string; lost: number } | null;
    last_activity: string | null; funnel: { id: string; title: string; reached: number }[] };
  accounts_active?: number;
}
export type Draft = Omit<Playbook, 'promoted' | 'updated_at' | 'updated_by' | 'adoption' | 'accounts_active'> & { isNew: boolean };

const emptyStage = (): Stage => ({ title: '', why: '', prompt: '', tools: [], expect: '' });
// Journeys are not ordered, so the draft carries only what the editor writes (no ordering, no adoption).
export const toDraft = (p: Playbook): Draft => ({ id: p.id, name: p.name, outcome: p.outcome, who: p.who, time: p.time, example: { ...p.example },
  stages: p.stages.map((s) => ({ ...s, tools: [...s.tools] })), isNew: false });
export const blank = (): Draft => ({ id: '', name: '', outcome: '', who: '', time: '', example: { title: '', result: '' }, stages: [emptyStage()], isNew: true });

/** What must be filled in before the server will take it (src/playbooks.ts cleanTemplate), per field and stage. */
function problemsOf(d: Draft): { stage?: number; field: string; msg: string }[] {
  const out: { stage?: number; field: string; msg: string }[] = [];
  if (!d.name.trim()) out.push({ field: 'name', msg: 'Give the journey a name' });
  if (!d.outcome.trim()) out.push({ field: 'outcome', msg: 'Say what the customer gets at the end' });
  d.stages.forEach((st, i) => {
    if (!st.title.trim()) out.push({ stage: i, field: 'title', msg: `Stage ${i + 1} needs a title` });
    if (!st.prompt.trim()) out.push({ stage: i, field: 'prompt', msg: `Stage ${i + 1} needs a prompt` });
    if (!st.expect.trim()) out.push({ stage: i, field: 'expect', msg: `Stage ${i + 1} needs "You'll see"` });
  });
  return out;
}

// Inputs that read as text until you touch them (Notion-like), with a red edge once a save was tried and it is missing.
const ghost = 'border-transparent bg-transparent shadow-none hover:bg-muted/60 focus-visible:bg-background focus-visible:border-input';
const bad = (on: boolean) => (on ? 'border-destructive/60 bg-destructive/5' : '');
const TOKENS = ['{product}', '{competitor}'];

/**
 * The journey editor: a full-height panel. Name as the title, the few journey properties as rows, then the stages as a
 * list where one is open at a time (title, prompt, what they will see, and which tools mark it done). Required fields
 * are checked before saving, and closing with unsaved changes asks first.
 */
export function Editor({ draft: initial, tools, onClose }: { draft: Draft; tools: string[]; onClose: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [open, setOpen] = useState<number | null>(initial.isNew ? 0 : null);
  const [example, setExample] = useState(Boolean(initial.example.title || initial.example.result));
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState('');
  const problems = useMemo(() => problemsOf(d), [d]);
  const dirty = JSON.stringify(d) !== JSON.stringify(initial);
  const missing = (field: string, stage?: number) => tried && problems.some((p) => p.field === field && p.stage === stage);
  const save = useAdminAction(() => (d.isNew ? post('/playbooks', d) : adminApi('PUT', `/playbooks/${d.id}`, d)),
    { success: d.isNew ? 'Journey created (not promoted yet)' : 'Journey saved' });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setStage = (i: number, patch: Partial<Stage>) => setD((x) => ({ ...x, stages: x.stages.map((st, j) => (j === i ? { ...st, ...patch } : st)) }));
  const moveStage = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= d.stages.length) return;
    setD((x) => { const st = [...x.stages]; [st[i], st[j]] = [st[j], st[i]]; return { ...x, stages: st }; });
    setOpen(j);
  };
  const addStage = () => { setD((x) => ({ ...x, stages: [...x.stages, emptyStage()] })); setOpen(d.stages.length); };
  const submit = () => {
    setTried(true); setErr('');
    if (problems.length) { const first = problems.find((p) => p.stage != null); if (first) setOpen(first.stage!); return; }
    save.mutate(undefined, { onSuccess: onClose, onError: (e) => setErr(e.message) });
  };
  const close = () => { if (!dirty || window.confirm('Discard your changes to this journey?')) onClose(); };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitRef.current(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Sheet open onOpenChange={(o) => !o && close()}>
      <SheetContent side='right' showCloseButton={false} className='gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl'>
        <div className='flex items-center gap-2 border-b px-6 py-3'>
          <SheetTitle className='text-muted-foreground text-sm font-normal'>{d.isNew ? 'New journey' : 'Edit journey'}</SheetTitle>
          <SheetDescription className='sr-only'>Stages a customer follows in their AI client; a stage is done when one of its tools runs, or when the customer marks it.</SheetDescription>
          <span className='text-muted-foreground ml-auto hidden text-xs sm:inline'>⌘↵ to save</span>
          <Button variant='ghost' size='sm' onClick={close}>Cancel</Button>
          <Gate need='library'><Button size='sm' onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : d.isNew ? 'Create journey' : 'Save'}</Button></Gate>
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto px-6 py-6'>
          <Input autoFocus={d.isNew} value={d.name} onChange={(e) => set('name', e.target.value)} placeholder='Journey name' aria-label='Name' maxLength={80}
            className={cn('h-12 px-2 text-2xl font-semibold md:text-2xl', ghost, bad(missing('name')))} />
          <Textarea value={d.outcome} onChange={(e) => set('outcome', e.target.value)} rows={2} maxLength={300} aria-label='Outcome'
            placeholder='Outcome: what the customer knows or has at the end' className={cn('mt-1 resize-none px-2 text-sm', ghost, bad(missing('outcome')))} />

          <dl className='mt-4 grid gap-0.5'>
            <Prop label='For'><Input value={d.who} onChange={(e) => set('who', e.target.value)} placeholder='Who it is for, e.g. DevRel after the first report' maxLength={200} className={cn('h-8 px-2', ghost)} /></Prop>
            <Prop label='Takes'><Input value={d.time} onChange={(e) => set('time', e.target.value)} placeholder='e.g. an hour, mostly waiting for agents' maxLength={80} className={cn('h-8 px-2', ghost)} /></Prop>
            {example ? (<>
              <Prop label='Example'><Input value={d.example.title} onChange={(e) => set('example', { ...d.example, title: e.target.value })} placeholder='A real customer, e.g. Resend inbound email' maxLength={120} className={cn('h-8 px-2', ghost)} /></Prop>
              <Prop label='Result'><Textarea rows={2} value={d.example.result} onChange={(e) => set('example', { ...d.example, result: e.target.value })} placeholder='What happened for them' maxLength={600} className={cn('resize-none px-2 text-sm', ghost)} /></Prop>
            </>) : (
              <button type='button' onClick={() => setExample(true)} className='text-muted-foreground hover:text-foreground w-fit px-2 py-1.5 text-sm leading-none'>+ Add a worked example</button>
            )}
          </dl>

          <div className='mt-8 mb-2 flex items-center justify-between'>
            <h3 className='text-sm leading-none font-medium'>Stages <span className='text-muted-foreground font-normal tabular-nums'>{d.stages.length}</span></h3>
            <Button size='sm' variant='ghost' disabled={d.stages.length >= 12} onClick={addStage}><Icons.add /> Add stage</Button>
          </div>
          <ol className='divide-y border-y'>
            {d.stages.map((st, i) => {
              const isOpen = open === i, stageBad = tried && problems.some((p) => p.stage === i);
              return (
                <li key={i}>
                  <div className='flex items-center gap-3 py-2.5'>
                    <button type='button' onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen} className='flex min-w-0 flex-1 items-center gap-3 text-left'>
                      <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums', stageBad ? 'border-destructive text-destructive' : 'text-muted-foreground')}>{i + 1}</span>
                      <span className={cn('min-w-0 flex-1 truncate text-sm leading-none', st.title ? 'font-medium' : 'text-muted-foreground')}>{st.title || 'Untitled stage'}</span>
                      <span className='text-muted-foreground hidden shrink-0 truncate font-mono text-xs sm:inline'>
                        {st.tools.length ? `${st.tools[0]}${st.tools.length > 1 ? ` +${st.tools.length - 1}` : ''}` : <span className='font-sans'>marked by the customer</span>}
                      </span>
                      <Icons.chevronDown className={cn('text-muted-foreground size-4 shrink-0 transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    <ActionsMenu label={`Stage ${i + 1} actions`} items={[
                      { label: 'Move up', icon: <Icons.chevronUp />, disabled: i === 0, onSelect: () => moveStage(i, -1) },
                      { label: 'Move down', icon: <Icons.chevronDown />, disabled: i === d.stages.length - 1, onSelect: () => moveStage(i, 1) },
                      { label: 'Duplicate', icon: <Icons.page />, disabled: d.stages.length >= 12, onSelect: () => { setD((x) => ({ ...x, stages: [...x.stages.slice(0, i + 1), { ...st, id: undefined, title: `${st.title} (copy)`, tools: [...st.tools] }, ...x.stages.slice(i + 1)] })); setOpen(i + 1); } },
                      { label: 'Delete stage', icon: <Icons.trash />, destructive: true, separator: true, disabled: d.stages.length === 1, onSelect: () => { set('stages', d.stages.filter((_, j) => j !== i)); setOpen(null); } },
                    ]} />
                  </div>
                  {isOpen && (
                    <div className='grid gap-3 pb-5 pl-9'>
                      <Input value={st.title} onChange={(e) => setStage(i, { title: e.target.value })} placeholder='Title, e.g. Read results by agent' aria-label='Stage title' maxLength={120} className={bad(missing('title', i))} />
                      <div className='grid gap-1.5'>
                        <div className='flex items-center justify-between'>
                          <span className='text-muted-foreground text-xs leading-none'>Prompt the customer pastes into their AI client</span>
                          <span className='flex gap-1'>{TOKENS.map((t) => (
                            <button key={t} type='button' title={`Insert ${t}`} onClick={() => setStage(i, { prompt: `${st.prompt}${st.prompt && !st.prompt.endsWith(' ') ? ' ' : ''}${t}` })}
                              className='text-muted-foreground hover:text-foreground rounded border px-1.5 py-0.5 font-mono text-[11px] leading-none'>{t}</button>
                          ))}</span>
                        </div>
                        <Textarea rows={3} value={st.prompt} onChange={(e) => setStage(i, { prompt: e.target.value })} placeholder='Show my visibility report for {product}.' aria-label='Prompt' maxLength={600}
                          className={cn('resize-none font-mono text-xs', bad(missing('prompt', i)))} />
                      </div>
                      <Input value={st.expect} onChange={(e) => setStage(i, { expect: e.target.value })} placeholder="You'll see: what comes back, e.g. Hit rate per agent with ranges" aria-label="You'll see" maxLength={500} className={bad(missing('expect', i))} />
                      <Input value={st.why} onChange={(e) => setStage(i, { why: e.target.value })} placeholder='Why it matters (optional)' aria-label='Why' maxLength={500} />
                      <div className='flex flex-wrap items-center gap-1.5'>
                        <span className='text-muted-foreground mr-1 text-xs leading-none'>Done when</span>
                        {st.tools.map((t) => (
                          <span key={t} className='bg-muted flex items-center gap-1 rounded px-2 py-1 font-mono text-xs leading-none'>
                            {t}<button type='button' aria-label={`Remove ${t}`} onClick={() => setStage(i, { tools: st.tools.filter((x) => x !== t) })} className='text-muted-foreground hover:text-foreground'><Icons.close className='size-3' /></button>
                          </span>
                        ))}
                        {!st.tools.length && <span className='text-muted-foreground text-xs leading-none'>the customer marks it done</span>}
                        <ToolPicker tools={tools} value={st.tools} onChange={(v) => setStage(i, { tools: v })} />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>

        {(err || (tried && problems.length > 0)) && (
          <div className='text-destructive border-t px-6 py-3 text-sm leading-snug'>
            {err || `Fix ${problems.length === 1 ? 'this' : `these ${problems.length}`} first: ${problems.slice(0, 4).map((p) => p.msg).join('; ')}${problems.length > 4 ? '…' : ''}`}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='grid grid-cols-[6rem_1fr] items-start gap-2'>
      <dt className='text-muted-foreground pt-2 text-sm leading-none'>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Add the tools whose run marks a stage done: a searchable list instead of every tool as a checkbox. */
function ToolPicker({ tools, value, onChange }: { tools: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const shown = tools.filter((t) => !q || t.includes(q.toLowerCase().replace(/\s+/g, '_')));
  return (
    <Popover>
      <PopoverTrigger render={<Button variant='ghost' size='xs' className='text-muted-foreground' />}><Icons.add /> Tool</PopoverTrigger>
      <PopoverContent align='start' className='flex w-72 flex-col gap-2 p-2'>
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${tools.length} tools`} aria-label='Search tools' className='h-8 text-sm' />
        <ul className='flex max-h-64 flex-col overflow-y-auto'>
          {!shown.length && <li className='text-muted-foreground px-2 py-2 text-xs'>No tool matches.</li>}
          {shown.map((t) => {
            const on = value.includes(t);
            return (
              <li key={t}>
                <button type='button' onClick={() => onChange(on ? value.filter((x) => x !== t) : [...value, t])}
                  className={cn('hover:bg-muted flex w-full items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-xs leading-none', on && 'text-primary')}>
                  <Icons.check className={cn('size-3.5', !on && 'invisible')} />{t}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
