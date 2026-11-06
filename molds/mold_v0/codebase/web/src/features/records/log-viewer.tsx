'use client';
// The event/log viewer (mold_v0-256, flag record_pages): a run's timeline (web/src/features/runs/run-page.tsx) and a
// record page's log section (./detail-page.tsx) draw their lines here (./log-lines.ts decides what they are and what the
// filters keep). Above the lines one row of controls: search (every word, highlighted, with how many lines match), the
// levels (a menu of error, warning, info and debug with each one's count), the source (when lines name one), wrap or
// no-wrap, follow (while the log is live: the newest line stays in view until you scroll up; Jump to latest brings it
// back) and Download (the lines kept, as a .log file). Each line: its number, its time, its level, its source and its
// words, with Copy line on hover and focus. Virtualised: only the lines in view (and a margin) are drawn, measured as
// they are drawn when they wrap, so a log of a hundred thousand lines scrolls as one of a hundred. Every control is the
// shared outlined Button; colours are the console's status tones, legible in light and dark.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icons } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  LEVEL_WORDS, LOG_LEVELS, estimateHeight, filterLines, levelCounts, lineText, logFileName, logText, matchRanges, offsetsOf, sourcesOf, visibleRange,
  type LogLevel, type LogLine
} from './log-lines';

const ROW = 22;
/** Each level's tag: a status tone mixed toward the foreground (light and dark alike). */
export const LEVEL_CLASS: Record<LogLevel, string> = {
  error: 'text-destructive',
  warning: 'text-amber-700 dark:text-amber-300',
  info: 'text-primary',
  debug: 'text-muted-foreground'
};
/** A line's row tint: errors and warnings stand out from the rest. */
const ROW_CLASS: Record<LogLevel, string> = {
  error: 'bg-destructive/[0.06] dark:bg-destructive/[0.10]',
  warning: 'bg-amber-500/[0.06] dark:bg-amber-400/[0.08]',
  info: '',
  debug: ''
};

/** Put text on the clipboard (the clipboard API, else a selection copied), saying so with the caller's toast. */
async function toClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}
/** Download text as a file (a Blob link, clicked once). */
export function downloadText(text: string, name: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Text with search's matches marked. */
function Marked({ text, search }: { text: string; search: string }) {
  const ranges = matchRanges(text, search);
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={i} className='rounded-[2px] bg-amber-300/70 px-px text-inherit dark:bg-amber-400/40' data-log-match=''>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
const timeOf = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(11, 19) : `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
};

export interface LogViewerProps {
  lines: LogLine[];
  /** Whether more lines may come (a running run, a record whose log section is live): Follow is offered, on at first. */
  live?: boolean;
  /** The download's name, in words (the run's id, the record's key and the field). */
  name: string[];
  /** What the viewer is, for a screen reader ("Build 1042: log"). */
  label: string;
  /** Said in place of the lines when there are none. */
  empty?: string;
  /** Say a copy happened (a toast). */
  copied?: (ok: boolean) => void;
  /** The tallest the lines' box grows (px; a phone uses 60% of the window). */
  maxHeight?: number;
}

export function LogViewer({ lines, live = false, name, label, empty = 'No lines yet.', copied, maxHeight = 480 }: LogViewerProps) {
  const [search, setSearch] = useState('');
  const [levels, setLevels] = useState<LogLevel[]>([...LOG_LEVELS]);
  const [source, setSource] = useState<string | null>(null);
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(live);
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(maxHeight);
  const [width, setWidth] = useState(800);
  const measured = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);

  useEffect(() => { if (!live) setFollow(false); }, [live]);
  const counts = useMemo(() => levelCounts(lines), [lines]);
  const sources = useMemo(() => sourcesOf(lines), [lines]);
  const kept = useMemo(() => filterLines(lines, { levels, source, search }), [lines, levels, source, search]);
  const matched = search.trim() ? kept.length : null;
  // Heights: one line each without wrapping; wrapped, measured as drawn (estimated from the text until then).
  const chars = Math.max(20, Math.floor((width - 190) / 7.4));
  const heights = useMemo(() => kept.map((l) => (wrap ? measured.current.get(`${l.n}`) ?? estimateHeight(l.text, true, chars, ROW) : ROW)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kept, wrap, chars, version]);
  const offsets = useMemo(() => offsetsOf(heights), [heights]);
  const total = kept.length ? offsets[kept.length - 1]! + heights[kept.length - 1]! : 0;
  const [first, last] = visibleRange(offsets, heights, top, height);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setHeight(el.clientHeight); setWidth(el.clientWidth); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { measured.current.clear(); setVersion((v) => v + 1); }, [wrap, width]);
  // Following: the newest line in view whenever lines come in (or the filters change).
  useLayoutEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [follow, total, kept.length]);
  const onScroll = () => {
    const el = box.current!;
    setTop(el.scrollTop);
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    if (follow && !atEnd) setFollow(false);
  };
  const measure = (key: string) => (el: HTMLDivElement | null) => {
    if (!el || !wrap) return;
    const h = el.offsetHeight;
    if (h && measured.current.get(key) !== h) { measured.current.set(key, h); requestAnimationFrame(() => setVersion((v) => v + 1)); }
  };
  const copy = async (l: LogLine) => copied?.(await toClipboard(lineText(l)));
  const filtered = levels.length !== LOG_LEVELS.length || !!source;

  return (
    <div className='flex min-w-0 flex-col' data-log-viewer='' aria-label={label} role='group'>
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-2.5 sm:px-6' data-log-toolbar=''>
        <div className='relative min-w-40 flex-1 sm:max-w-72'>
          <Icons.search aria-hidden className='text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2' />
          <Input type='search' value={search} onChange={(e) => setSearch(e.target.value)} placeholder='Search the log' aria-label={`Search ${label}`} className='h-8 pl-8' data-log-search='' />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button type='button' variant='outline' size='sm' data-log-levels='' aria-label='Levels' />}>
            <Icons.adjustments aria-hidden data-icon='inline-start' />{levels.length === LOG_LEVELS.length ? 'All levels' : levels.length ? levels.map((l) => LEVEL_WORDS[l]).join(', ') : 'No level'}
          </DropdownMenuTrigger>
          <DropdownMenuContent align='start' className='w-52'>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Levels</DropdownMenuLabel>
              {LOG_LEVELS.map((l) => (
                <DropdownMenuCheckboxItem key={l} checked={levels.includes(l)} data-log-level={l}
                  onCheckedChange={(on) => setLevels((xs) => (on ? LOG_LEVELS.filter((x) => xs.includes(x) || x === l) : xs.filter((x) => x !== l)))}>
                  <span className={cn('font-medium', LEVEL_CLASS[l])}>{LEVEL_WORDS[l]}</span>
                  <span className='text-muted-foreground ml-auto text-xs tabular-nums'>{counts[l].toLocaleString('en')}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {sources.length > 1 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type='button' variant='outline' size='sm' data-log-sources='' aria-label='Source' />}>
              <Icons.terminal aria-hidden data-icon='inline-start' /><span className='max-w-32 truncate'>{source ?? 'All sources'}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='start' className='w-56'>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Source</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={source ?? ''} onValueChange={(v) => setSource(v ? String(v) : null)}>
                  <DropdownMenuRadioItem value=''>All sources</DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  {sources.map((s) => (
                    <DropdownMenuRadioItem key={s.source} value={s.source} data-log-source={s.source}>
                      <span className='truncate'>{s.source}</span><span className='text-muted-foreground ml-auto pl-3 text-xs tabular-nums'>{s.n.toLocaleString('en')}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className='ml-auto flex items-center gap-2'>
          <Button type='button' variant='outline' size='sm' aria-pressed={wrap} onClick={() => setWrap((w) => !w)} data-log-wrap={wrap ? 'on' : 'off'}
            className={cn(wrap && 'bg-accent text-accent-foreground')} title={wrap ? 'Lines wrap: show each on one line' : 'Wrap long lines'}>
            <Icons.wrap aria-hidden data-icon='inline-start' />Wrap
          </Button>
          {live && (
            <Button type='button' variant='outline' size='sm' aria-pressed={follow} onClick={() => setFollow((f) => !f)} data-log-follow={follow ? 'on' : 'off'}
              className={cn(follow && 'bg-accent text-accent-foreground')} title={follow ? 'Following the newest line: click to stop' : 'Follow the newest line'}>
              <Icons.followTail aria-hidden data-icon='inline-start' />Follow
            </Button>
          )}
          <Button type='button' variant='outline' size='sm' onClick={() => downloadText(logText(kept), logFileName(...name))} disabled={!kept.length} data-log-download=''
            title={filtered || search ? 'Download the lines shown' : 'Download the log'}>
            <Icons.download aria-hidden data-icon='inline-start' /><span className='max-sm:sr-only'>Download</span>
          </Button>
        </div>
      </div>
      <p className='sr-only' aria-live='polite'>{matched !== null ? `${matched} matching lines` : ''}</p>
      {(matched !== null || filtered) && (
        <p className='text-muted-foreground border-b px-4 py-1.5 text-xs sm:px-6' data-log-shown=''>
          {kept.length.toLocaleString('en')} of {lines.length.toLocaleString('en')} lines{matched !== null ? ` match “${search.trim()}”` : ''}
          {(filtered || search) && <> · <Button type='button' variant='link' size='sm' className='h-auto p-0 text-xs' onClick={() => { setSearch(''); setLevels([...LOG_LEVELS]); setSource(null); }}>Show all</Button></>}
        </p>
      )}
      {!lines.length ? (
        <div className='flex items-center gap-3 px-6 py-5' data-section-empty=''>
          <Icons.terminal aria-hidden className='text-muted-foreground size-5 shrink-0' />
          <p className='text-muted-foreground text-sm'>{empty}</p>
        </div>
      ) : (
        <div className='relative'>
          <div ref={box} onScroll={onScroll} tabIndex={0} aria-label={`${label}: ${kept.length} lines`} data-log-lines=''
            className={cn('bg-muted/30 dark:bg-muted/20 relative overflow-auto font-mono text-xs leading-[22px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring')}
            style={{ height: Math.min(maxHeight, Math.max(total, ROW * 3) + 2), maxHeight: '60vh' }}>
            <div style={{ height: total, position: 'relative', minWidth: wrap ? undefined : 'max-content' }} role='list'>
              {kept.slice(first, last + 1).map((l, i) => {
                const at = first + i;
                return (
                  <div key={`${l.n}`} ref={measure(`${l.n}`)} role='listitem' data-log-line={l.n} data-level={l.level}
                    className={cn('group absolute right-0 left-0 flex items-start gap-3 pr-10 pl-2 sm:pl-4', ROW_CLASS[l.level], wrap ? 'whitespace-pre-wrap' : 'whitespace-pre')}
                    style={{ top: offsets[at], minHeight: ROW }}>
                    <span className='text-muted-foreground/80 w-10 shrink-0 text-right tabular-nums select-none' aria-hidden>{l.n}</span>
                    {l.at && <time dateTime={l.at} title={l.at} className='text-muted-foreground shrink-0 tabular-nums'>{timeOf(l.at)}</time>}
                    <span className={cn('w-12 shrink-0 font-semibold uppercase', LEVEL_CLASS[l.level])}>{l.level === 'warning' ? 'warn' : l.level}</span>
                    {l.source && <span className='text-muted-foreground max-w-36 shrink-0 truncate' title={l.source}>[{l.source}]</span>}
                    <span className={cn('min-w-0', wrap ? 'flex-1 break-words' : '')}><Marked text={l.text} search={search} /></span>
                    <Button type='button' variant='outline' size='icon-xs' aria-label={`Copy line ${l.n}`} title='Copy line' data-log-copy={l.n}
                      className='bg-background absolute top-0.5 right-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100'
                      onClick={() => void copy(l)}>
                      <Icons.copy aria-hidden />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
          {live && !follow && (
            <Button type='button' variant='outline' size='sm' className='bg-background absolute right-4 bottom-3 shadow-sm' onClick={() => setFollow(true)} data-log-jump=''>
              <Icons.followTail aria-hidden data-icon='inline-start' />Jump to latest
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A level as a small tag (the run page's timeline counts). */
export function LevelTag({ level, children }: { level: LogLevel; children?: ReactNode }) {
  return <Badge variant='outline' className={cn('font-medium', LEVEL_CLASS[level])}>{children ?? LEVEL_WORDS[level]}</Badge>;
}
