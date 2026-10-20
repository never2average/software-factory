'use client';
// /app/pick-rate (was /app/visibility): did the coding agents in your simulations pick your product. One page header
// holds every control: product (when there are several), Competitors, Developer personas, Tasks, the period, and
// Reports (new report, export now, saved reports). The filters live in the URL (?competitor=…&persona=…&task=…&from=…),
// so a filtered view can be shared. Data: GET /api/app/visibility (src/visibility.ts); exports and saved reports under it.
// /app/pick-rate/report is the print page (PDF): the same cells and a table per section, then window.print().
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { parseAsArrayOf, parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { DateRangePicker, last30, PRESETS, rangeLabel, type DateRange } from '@/components/layout/date-range-picker';
import { MultiSelectFilter, type FilterOption } from '@/components/layout/multi-select-filter';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { ErrorState, fail, LoadingCards, useOrgLoad } from './shared';
import { SECTIONS, VisibilitySection, type SectionId, type Visibility } from './visibility';

// ---------- filters ----------

export interface Filters { competitor: string[]; persona: number[]; task: number[]; product: number | null }
interface Options { products: { id: number; name: string }[]; competitors: string[]; personas: { id: number; name: string }[]; tasks: { id: number; title: string }[] }
interface PageData { range: { from: string; to: string; days: number }; filters: Filters; options: Options; visibility: Visibility; permissions: string[] }
type Format = 'pdf' | 'csv' | 'json';
type RangeDef = { preset: string } | { from: string; to: string };
interface Definition { filters: Filters; range: RangeDef; sections: SectionId[]; format: Format }
interface Saved { id: number; name: string; definition: Definition; range: { from: string; to: string }; mine: boolean; last_run_at: string | null; can_edit: boolean; can_delete: boolean }

const ALL = SECTIONS.map((s) => s.id) as SectionId[];
const SAVED_PRESETS = ['7d', '14d', '30d', '90d', 'month', 'last-month'];
export const DEFAULT_NAME = 'Pick rate report';

/** The API's query string: repeated competitor= (a name may hold a comma), persona=1,2, task=…, product, from/to. */
export function apiQuery(f: Filters, range: DateRange, extra: Record<string, string | string[] | undefined> = {}) {
  const q = new URLSearchParams({ from: range.from, to: range.to });
  if (f.product) q.set('product', String(f.product));
  for (const c of f.competitor) q.append('competitor', c);
  if (f.persona.length) q.set('persona', f.persona.join(','));
  if (f.task.length) q.set('task', f.task.join(','));
  for (const [k, v] of Object.entries(extra)) for (const x of Array.isArray(v) ? v : v == null ? [] : [v]) q.append(k, x);
  return q.toString();
}

const urlState = {
  from: parseAsString, to: parseAsString, product: parseAsInteger,
  competitor: parseAsArrayOf(parseAsString).withDefault([]), persona: parseAsArrayOf(parseAsInteger).withDefault([]), task: parseAsArrayOf(parseAsInteger).withDefault([])
};

/** Download a file from the API (an export): saves it under the server's name. */
async function download(path: string) {
  const res = await fetch(`/api/app${path}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Export failed (${res.status})`));
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'pick-rate-report';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const printUrl = (f: Filters, range: DateRange, sections: SectionId[], name: string) =>
  `/app/pick-rate/report?${apiQuery(f, range, { section: sections.join(','), name })}`;

/** A button that runs an export and reads "Downloaded" (or "Opened") with a check for two seconds after. */
function ExportButton({ run, label, done = 'Downloaded', variant = 'outline', disabled }: { run: () => Promise<void> | void; label: ReactNode; done?: string; variant?: 'outline' | 'default'; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  useEffect(() => { if (state !== 'done') return; const t = setTimeout(() => setState('idle'), 2000); return () => clearTimeout(t); }, [state]);
  return (
    <Button type='button' size='sm' variant={variant} disabled={disabled || state === 'busy'}
      onClick={async () => { setState('busy'); try { await run(); setState('done'); } catch (e) { setState('idle'); fail(e); } }}>
      {state === 'busy' ? <Icons.spinner className='size-3.5 animate-spin' /> : state === 'done' ? <Icons.check className='size-3.5' /> : <Icons.download className='size-3.5' />}
      {state === 'done' ? done : label}
    </Button>
  );
}

function FilterControls({ f, options, onChange, inDialog }: { f: Filters; options: Options | null; onChange: (f: Filters) => void; inDialog?: boolean }) {
  const comp: FilterOption[] = useMemo(() => (options?.competitors ?? []).map((c) => ({ value: c, label: c })), [options]);
  const pers: FilterOption[] = useMemo(() => (options?.personas ?? []).map((p) => ({ value: String(p.id), label: p.name })), [options]);
  const tasks: FilterOption[] = useMemo(() => (options?.tasks ?? []).map((t) => ({ value: String(t.id), label: t.title })), [options]);
  const cls = inDialog ? 'w-full max-w-none' : undefined;
  return (
    <>
      {(options?.products.length ?? 0) > 1 && (
        <NativeSelect aria-label='Product' className={cls} value={f.product == null ? '' : String(f.product)} onChange={(e) => onChange({ ...f, product: e.target.value ? Number(e.target.value) : null })}>
          <NativeSelectOption value=''>All products</NativeSelectOption>
          {options!.products.map((p) => <NativeSelectOption key={p.id} value={String(p.id)}>{p.name}</NativeSelectOption>)}
        </NativeSelect>
      )}
      <MultiSelectFilter noun='competitors' icon={<Icons.building />} options={comp} value={f.competitor} onChange={(v) => onChange({ ...f, competitor: v })} className={cls} />
      <MultiSelectFilter noun='developer personas' icon={<Icons.userPen />} options={pers} value={f.persona.map(String)} onChange={(v) => onChange({ ...f, persona: v.map(Number) })} className={cls} />
      <MultiSelectFilter noun='tasks' icon={<Icons.kanban />} options={tasks} value={f.task.map(String)} onChange={(v) => onChange({ ...f, task: v.map(Number) })} className={cls} />
    </>
  );
}

// ---------- the page ----------

export function PickRatePage() {
  const [u, setU] = useQueryStates(urlState);
  const fallback = useMemo(() => last30(), []);
  const range: DateRange = u.from && u.to ? { from: u.from, to: u.to } : fallback;
  const f: Filters = { competitor: u.competitor, persona: u.persona, task: u.task, product: u.product };
  const setFilters = (x: Filters) => void setU({ competitor: x.competitor.length ? x.competitor : null, persona: x.persona.length ? x.persona : null, task: x.task.length ? x.task : null, product: x.product });
  const setRange = (r: DateRange) => void setU({ from: r.from, to: r.to });
  const q = apiQuery(f, range);
  const { data, error } = useOrgLoad(() => appApi<PageData>('GET', `/visibility?${q}`), [q]);
  // The options don't depend on the filters; keep the last ones so the pickers don't empty while a new view loads.
  const [options, setOptions] = useState<Options | null>(null);
  useEffect(() => { if (data?.options) setOptions(data.options); }, [data?.options]);
  const saved = useOrgLoad(() => appApi<{ reports: Saved[]; can_create: boolean }>('GET', '/visibility/reports'), []);
  const [builder, setBuilder] = useState<{ name: string; def: Definition; editing?: Saved } | null>(null);
  const [list, setList] = useState(false);
  const runSaved = async (r: Saved) => {
    const x = await appApi<Saved>('POST', `/visibility/reports/${r.id}/run`);
    const d = x.definition.filters;
    await setU({ from: x.range.from, to: x.range.to, competitor: d.competitor.length ? d.competitor : null, persona: d.persona.length ? d.persona : null, task: d.task.length ? d.task : null, product: d.product });
    setList(false);
    toast.success(`Showing ${x.name}`);
    void saved.reload();
  };
  const newReport = () => {
    const preset = PRESETS.find((p) => SAVED_PRESETS.includes(p.id) && p.range().from === range.from && p.range().to === range.to)?.id;
    setBuilder({ name: DEFAULT_NAME, def: { filters: f, range: preset ? { preset } : { from: range.from, to: range.to }, sections: ALL, format: 'pdf' } });
  };
  const n = f.competitor.length + f.persona.length + f.task.length;
  return (
    <PageContainer
      pageTitle='Pick rate'
      pageDescription={n ? 'How often agents picked you, filtered.' : 'How often agents picked you.'}
      pageHeaderAction={
        <div className='flex flex-wrap items-center justify-end gap-2'>
          <FilterControls f={f} options={options} onChange={setFilters} />
          <DateRangePicker value={range} onChange={setRange} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant='outline' />}><Icons.post /> Reports</DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='w-56'>
              <DropdownMenuItem onClick={newReport}><Icons.add /> New report</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setList(true)}><Icons.page /> Saved reports</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => window.open(printUrl(f, range, ALL, DEFAULT_NAME), '_blank', 'noopener')}><Icons.fileTypePdf /> Export this view (PDF)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => download(`/visibility/export?${apiQuery(f, range, { format: 'csv', name: DEFAULT_NAME })}`).then(() => toast.success('Downloaded'), fail)}><Icons.fileTypeXls /> Export this view (CSV)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => download(`/visibility/export?${apiQuery(f, range, { format: 'json', name: DEFAULT_NAME })}`).then(() => toast.success('Downloaded'), fail)}><Icons.code /> Export this view (JSON)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={4} />
        : <div className='flex w-full flex-col pb-4'><VisibilitySection v={data.visibility} /></div>}
      {builder && <ReportBuilder init={builder} options={options} canSave={Boolean(saved.data?.can_create)} onClose={() => setBuilder(null)} onSaved={() => { setBuilder(null); void saved.reload(); }} />}
      {list && <SavedReports data={saved.data} onClose={() => setList(false)} onRun={(r) => runSaved(r).catch(fail)} reload={() => void saved.reload()}
        onEdit={(r) => { setList(false); setBuilder({ name: r.name, def: r.definition, editing: r }); }} onNew={() => { setList(false); newReport(); }} />}
    </PageContainer>
  );
}

const rangeOf = (r: RangeDef): DateRange => ('preset' in r ? (PRESETS.find((p) => p.id === r.preset) ?? PRESETS[4]).range() : { from: r.from, to: r.to });
const rangeText = (r: RangeDef) => ('preset' in r ? (PRESETS.find((p) => p.id === r.preset)?.label ?? 'Last 30 days') : rangeLabel(r));

function ReportBuilder({ init, options, canSave, onClose, onSaved }: {
  init: { name: string; def: Definition; editing?: Saved }; options: Options | null; canSave: boolean; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(init.name);
  const [def, setDef] = useState<Definition>(init.def);
  const [busy, setBusy] = useState(false);
  const range = rangeOf(def.range);
  const sections = ALL.filter((id) => def.sections.includes(id));
  const exportNow = async () => {
    if (!sections.length) throw new Error('Pick at least one section');
    if (def.format === 'pdf') { window.open(printUrl(def.filters, range, sections, name.trim() || DEFAULT_NAME), '_blank', 'noopener'); return; }
    await download(`/visibility/export?${apiQuery(def.filters, range, { format: def.format, section: sections.join(','), name: name.trim() || DEFAULT_NAME })}`);
  };
  const save = async () => {
    if (!name.trim()) return fail(new Error('Give the report a name'));
    if (!sections.length) return fail(new Error('Pick at least one section'));
    setBusy(true);
    try {
      const body = { name: name.trim(), definition: { ...def, sections } };
      if (init.editing) await appApi('PUT', `/visibility/reports/${init.editing.id}`, body);
      else await appApi('POST', '/visibility/reports', body);
      toast.success(init.editing ? 'Report saved' : 'Report saved to Saved reports');
      onSaved();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const presetValue = 'preset' in def.range ? def.range.preset : 'fixed';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>{init.editing ? `Edit ${init.editing.name}` : 'New report'}</DialogTitle>
          <DialogDescription>Pick the filters, dates and sections, then export it now or save it to run again later.</DialogDescription>
        </DialogHeader>
        <div className='grid min-w-0 gap-4'>
          <div className='grid gap-1.5'>
            <Label htmlFor='rep-name'>Report name</Label>
            <Input id='rep-name' maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label>Filters</Label>
            <div className='grid gap-2 sm:grid-cols-2'><FilterControls inDialog f={def.filters} options={options} onChange={(x) => setDef({ ...def, filters: x })} /></div>
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='rep-range'>Dates</Label>
            <div className='flex flex-wrap items-center gap-2'>
              <NativeSelect id='rep-range' value={presetValue} onChange={(e) => setDef({ ...def, range: e.target.value === 'fixed' ? { from: range.from, to: range.to } : { preset: e.target.value } })}>
                {PRESETS.filter((p) => SAVED_PRESETS.includes(p.id)).map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.label}, when run</NativeSelectOption>)}
                <NativeSelectOption value='fixed'>Fixed dates</NativeSelectOption>
              </NativeSelect>
              {presetValue === 'fixed' && <DateRangePicker value={range} onChange={(r) => setDef({ ...def, range: { from: r.from, to: r.to } })} />}
            </div>
          </div>
          <fieldset className='grid gap-1.5'>
            <legend className='mb-1.5 flex w-full items-center justify-between text-sm font-medium'>
              Sections
              <span className='flex gap-3 text-xs font-normal'>
                <button type='button' className='text-primary hover:underline' onClick={() => setDef({ ...def, sections: ALL })}>Select all</button>
                <button type='button' className='text-muted-foreground hover:text-foreground' onClick={() => setDef({ ...def, sections: [] })}>Clear</button>
              </span>
            </legend>
            <div className='grid gap-1 sm:grid-cols-2'>
              {SECTIONS.map((s) => (
                <label key={s.id} className='hover:bg-muted flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm'>
                  <Checkbox checked={def.sections.includes(s.id)} onCheckedChange={(c) => setDef({ ...def, sections: c ? [...def.sections, s.id] : def.sections.filter((x) => x !== s.id) })} />
                  {s.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className='grid gap-1.5'>
            <Label>Format</Label>
            <div role='radiogroup' aria-label='Format' className='flex w-fit rounded-md border p-0.5 text-sm'>
              {([['pdf', 'PDF'], ['csv', 'CSV'], ['json', 'JSON']] as const).map(([id, label]) => (
                <button key={id} type='button' role='radio' aria-checked={def.format === id} onClick={() => setDef({ ...def, format: id })}
                  className={cn('rounded px-3 py-1', def.format === id ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          {canSave && (init.editing ? init.editing.can_edit : true) && <Button variant='outline' size='sm' disabled={busy} onClick={save}>{busy ? <Icons.spinner className='size-3.5 animate-spin' /> : <Icons.check className='size-3.5' />} Save report</Button>}
          <ExportButton variant='default' label={`Export now (${def.format.toUpperCase()})`} done={def.format === 'pdf' ? 'Opened' : 'Downloaded'} run={exportNow} disabled={!sections.length} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SavedReports({ data, onClose, onRun, onEdit, onNew, reload }: {
  data: { reports: Saved[]; can_create: boolean } | null; onClose: () => void; onRun: (r: Saved) => void; onEdit: (r: Saved) => void; onNew: () => void; reload: () => void;
}) {
  const [renaming, setRenaming] = useState<{ r: Saved; name: string } | null>(null);
  const [del, setDel] = useState<Saved | null>(null);
  const exp = (r: Saved, format: Format) => format === 'pdf'
    ? void window.open(printUrl(r.definition.filters, r.range, r.definition.sections, r.name), '_blank', 'noopener')
    : download(`/visibility/reports/${r.id}/export?format=${format}`);
  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className='max-h-[90svh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>Saved reports</DialogTitle>
            <DialogDescription>Run one to apply its filters and dates to the page, or export it as it stands today.</DialogDescription>
          </DialogHeader>
          {!data ? <LoadingCards count={1} /> : !data.reports.length ? (
            <p className='text-muted-foreground py-6 text-center text-sm'>No saved reports yet.{data.can_create ? ' Build one with New report and save it.' : ''}</p>
          ) : (
            <ul className='divide-y border-y'>
              {data.reports.map((r) => (
                <li key={r.id} className='flex flex-wrap items-center gap-2 py-2.5'>
                  <div className='min-w-0 flex-1'>
                    <div className='truncate text-sm font-medium'>{r.name}</div>
                    <div className='text-muted-foreground truncate text-xs'>{rangeText(r.definition.range)} · {r.definition.sections.length === ALL.length ? 'every section' : `${r.definition.sections.length} of ${ALL.length} sections`}{r.mine ? ' · yours' : ''}</div>
                  </div>
                  <Button size='sm' variant='outline' onClick={() => onRun(r)}><Icons.play className='size-3.5' /> Run</Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button size='sm' variant='outline' />}><Icons.download className='size-3.5' /> Export</DropdownMenuTrigger>
                    <DropdownMenuContent align='end'>
                      <DropdownMenuItem onClick={() => exp(r, 'pdf')}><Icons.fileTypePdf /> PDF</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => Promise.resolve(exp(r, 'csv')).then(() => toast.success('Downloaded'), fail)}><Icons.fileTypeXls /> CSV</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => Promise.resolve(exp(r, 'json')).then(() => toast.success('Downloaded'), fail)}><Icons.code /> JSON</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {(r.can_edit || r.can_delete) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button size='icon-sm' variant='ghost' aria-label={`More for ${r.name}`} />}><Icons.dots /></DropdownMenuTrigger>
                      <DropdownMenuContent align='end'>
                        {r.can_edit && <DropdownMenuItem onClick={() => onEdit(r)}><Icons.edit /> Edit</DropdownMenuItem>}
                        {r.can_edit && <DropdownMenuItem onClick={() => setRenaming({ r, name: r.name })}><Icons.post /> Rename</DropdownMenuItem>}
                        {r.can_delete && <DropdownMenuItem variant='destructive' onClick={() => setDel(r)}><Icons.trash /> Delete</DropdownMenuItem>}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              ))}
            </ul>
          )}
          {data?.can_create && <DialogFooter><Button size='sm' onClick={onNew}><Icons.add className='size-3.5' /> New report</Button></DialogFooter>}
        </DialogContent>
      </Dialog>
      {renaming && (
        <Dialog open onOpenChange={(o) => !o && setRenaming(null)}>
          <DialogContent className='sm:max-w-md'>
            <form className='grid gap-4' onSubmit={async (e) => {
              e.preventDefault();
              try { await appApi('PUT', `/visibility/reports/${renaming.r.id}`, { name: renaming.name }); toast.success('Renamed'); setRenaming(null); reload(); } catch (x) { fail(x); }
            }}>
              <DialogHeader><DialogTitle>Rename report</DialogTitle></DialogHeader>
              <Input aria-label='Report name' maxLength={120} value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} autoFocus />
              <DialogFooter><Button type='submit' size='sm' disabled={!renaming.name.trim()}>Rename</Button></DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {del?.name}?</AlertDialogTitle>
            <AlertDialogDescription>It goes for everyone in the account. Files already exported are not affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={async () => {
              const r = del; setDel(null);
              if (r) try { await appApi('DELETE', `/visibility/reports/${r.id}`); toast.success('Deleted'); reload(); } catch (x) { fail(x); }
            }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ---------- the print page (PDF) ----------

interface Table { id: SectionId; title: string; columns: string[]; rows: (string | number | boolean | null)[][] }
interface ReportJson { report: string; account: string; generated_at: string; range: { from: string; to: string }; filters: { product: { name: string | null } | null; competitor: string[]; persona: { id: number; name: string | null }[]; task: { id: number; title: string | null }[] }; sections: Table[] }

/**
 * /app/pick-rate/report?<the page's query>&section=a,b&name=…: a clean printable report (title, account, dates,
 * filters, each section's chart and its table), laid over the app and printed with the browser's Save as PDF.
 */
export function PickRateReport() {
  const [qs, setQs] = useState<string | null>(null);
  useEffect(() => setQs(window.location.search.replace(/^\?/, '')), []);
  const sp = useMemo(() => new URLSearchParams(qs ?? ''), [qs]);
  const sections = useMemo(() => { const want = (sp.get('section') ?? '').split(','); const ids = ALL.filter((id) => want.includes(id)); return ids.length ? ids : ALL; }, [sp]);
  const { data, error } = useOrgLoad(async () => {
    if (qs == null) return null;
    const [page, rep] = await Promise.all([appApi<PageData>('GET', `/visibility?${qs}`), appApi<ReportJson>('GET', `/visibility/export?${qs}&format=json&print=1`)]);
    return { page, rep };
  }, [qs]);
  const [printed, setPrinted] = useState(false);
  useEffect(() => {
    if (!data || printed) return;
    setPrinted(true);
    // Let the charts lay out first, then count the export and open the print dialog.
    const t = setTimeout(() => { void appApi('POST', '/visibility/export-events', { format: 'pdf' }).catch(() => {}); window.print(); }, 900);
    return () => clearTimeout(t);
  }, [data, printed]);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.body), []);
  if (!host) return null;
  const tables = new Map((data?.rep.sections ?? []).map((t) => [t.id, t]));
  const f = data?.rep.filters;
  const filterLine = f ? [f.product?.name && `Product: ${f.product.name}`, f.competitor.length && `Competitors: ${f.competitor.join(', ')}`,
    f.persona.length && `Developer personas: ${f.persona.map((x) => x.name ?? `#${x.id}`).join(', ')}`, f.task.length && `Tasks: ${f.task.map((x) => x.title ?? `#${x.id}`).join(', ')}`].filter(Boolean).join(' · ') : '';
  const cell = (v: Table['rows'][number][number]) => (v == null ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
  return createPortal(
    <div id='pick-rate-print' className='bg-background text-foreground fixed inset-0 z-[100] overflow-auto'>
      <style>{`@media print { body > *:not(#pick-rate-print) { display: none !important; } #pick-rate-print { position: static !important; overflow: visible !important; }
        .no-print { display: none !important; } @page { margin: 14mm; } .break-inside-avoid { break-inside: avoid; } }`}</style>
      <div className='mx-auto flex max-w-5xl flex-col gap-4 p-6 print:max-w-none print:p-0'>
        <div className='no-print flex items-center justify-end gap-2'>
          <Button size='sm' variant='outline' onClick={() => window.close()}>Close</Button>
          <Button size='sm' onClick={() => window.print()}><Icons.fileTypePdf className='size-3.5' /> Print or save as PDF</Button>
        </div>
        {error ? <ErrorState error={error} /> : !data ? <LoadingCards count={3} /> : (
          <>
            <header className='border-b pb-3'>
              <h1 className='text-2xl font-semibold tracking-tight'>{data.rep.report}</h1>
              <p className='text-muted-foreground mt-1 text-sm'>{data.rep.account} · {rangeLabel(data.rep.range)} ({data.rep.range.from} to {data.rep.range.to}) · generated {new Date(data.rep.generated_at).toLocaleString()}</p>
              <p className='text-muted-foreground mt-0.5 text-sm'>{filterLine || 'All competitors, developer personas and tasks'}</p>
            </header>
            <div className='flex flex-col'>
              <VisibilitySection v={data.page.visibility} sections={sections} print after={(id) => {
                const t = tables.get(id);
                if (!t) return null;
                return (
                  <div className='break-inside-avoid border-r border-b p-4'>
                    <h3 className='mb-2 text-xs font-semibold'>{t.title}: table</h3>
                    {t.rows.length ? (
                      <table className='w-full border-collapse text-xs tabular-nums'>
                        <thead><tr>{t.columns.map((c) => <th key={c} className='border-b py-1 pr-3 text-left font-medium'>{c.replace(/_/g, ' ')}</th>)}</tr></thead>
                        <tbody>{t.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className='border-b py-1 pr-3'>{cell(v)}</td>)}</tr>)}</tbody>
                      </table>
                    ) : <p className='text-muted-foreground text-xs'>Nothing in this period.</p>}
                  </div>
                );
              }} />
            </div>
          </>
        )}
      </div>
    </div>,
    host
  );
}
