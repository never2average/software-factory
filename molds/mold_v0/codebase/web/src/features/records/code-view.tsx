'use client';
// A record page's code and table sections (mold_v0-256, flag record_pages; ./code-text.ts decides, this draws):
//   code    a field as JSON (pretty-printed), YAML or text, each line numbered and highlighted (keys, strings, numbers,
//           literals, comments in the theme's chart colours mixed toward the foreground: legible in light and dark), in a
//           box that scrolls both ways; Copy and Download (the field's name and the language's extension), and Wrap.
//   table   a json field's list of objects as a table: its columns the items' keys in the order they first show (or the
//           section's own), a number right-aligned, a boolean Yes or No, a nested value in words; a list of cards on a
//           phone. Copy as JSON beside it.
import { useMemo, useState } from 'react';
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { cellText, codeFile, codeText, columnWords, itemCount, itemLines, numericColumn, tableColumns, tableRows, tokensOf, TOKEN_CLASS, type CodeLanguage } from './code-text';
import { downloadText } from './log-viewer';

const LANGUAGE_WORDS: Record<CodeLanguage, string> = { json: 'JSON', yaml: 'YAML', text: 'Text' };

export function CodeView({ value, language, name, label, copy }: {
  value: unknown; language: CodeLanguage; name: string; label: string; copy: (text: string, done: string) => void;
}) {
  const text = useMemo(() => codeText(value, language), [value, language]);
  const lines = useMemo(() => text.split('\n'), [text]);
  const [wrap, setWrap] = useState(false);
  const file = codeFile(name, language);
  const gutter = String(lines.length).length;
  return (
    <div className='flex min-w-0 flex-col' data-code-view={language}>
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-2.5 sm:px-6'>
        <span className='text-muted-foreground text-xs'><span className='text-foreground font-medium' data-code-language=''>{LANGUAGE_WORDS[language]}</span> · {lines.length.toLocaleString('en')} {lines.length === 1 ? 'line' : 'lines'}</span>
        <div className='ml-auto flex items-center gap-2'>
          <Button type='button' variant='outline' size='sm' aria-pressed={wrap} onClick={() => setWrap((w) => !w)} className={cn(wrap && 'bg-accent text-accent-foreground')} data-code-wrap={wrap ? 'on' : 'off'}>
            <Icons.wrap aria-hidden data-icon='inline-start' />Wrap
          </Button>
          <Button type='button' variant='outline' size='sm' onClick={() => copy(text, `${label} copied`)} data-code-copy=''>
            <Icons.copy aria-hidden data-icon='inline-start' />Copy
          </Button>
          <Button type='button' variant='outline' size='sm' onClick={() => downloadText(text, file.name, file.type)} data-code-download={file.name}>
            <Icons.download aria-hidden data-icon='inline-start' /><span className='max-sm:sr-only'>Download</span>
          </Button>
        </div>
      </div>
      <div className='bg-muted/30 dark:bg-muted/20 max-h-[32rem] overflow-auto' tabIndex={0} aria-label={`${label} (${LANGUAGE_WORDS[language]})`} data-code-lines=''>
        <pre className={cn('min-w-max py-3 font-mono text-xs leading-5', wrap && 'min-w-0')}>
          {lines.map((l, i) => (
            <div key={i} className='flex hover:bg-muted/50' data-code-line={i + 1}>
              <span className='text-muted-foreground/70 sticky left-0 shrink-0 bg-inherit pr-4 pl-4 text-right tabular-nums select-none sm:pl-6' style={{ width: `${gutter + 3}ch` }} aria-hidden>{i + 1}</span>
              <code className={cn('pr-6', wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre')}>
                {l ? tokensOf(l, language).map((t, k) => <span key={k} className={TOKEN_CLASS[t.kind] || undefined} data-token={t.kind === 'plain' ? undefined : t.kind}>{t.text}</span>) : ' '}
              </code>
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}

/**
 * A table cell (mold_v0-300): a list of objects as a count ("2 steps") that opens to one line per item (its name, title,
 * label or id), never a run-on line of pairs; any other value in words.
 */
function Cell({ v, column }: { v: unknown; column: string }) {
  const items = itemLines(v);
  if (!items) return <>{cellText(v)}</>;
  return (
    <details className='group min-w-0' data-cell-items={items.length}>
      <summary className='text-primary cursor-pointer list-none whitespace-nowrap underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden'>
        <Icons.chevronRight aria-hidden className='mr-1 inline size-3.5 align-[-2px] transition-transform group-open:rotate-90' />{itemCount(items.length, column)}
      </summary>
      <ul className='mt-1.5 flex flex-col gap-1 text-left'>
        {items.map((t, i) => <li key={i} className='break-words'>{t}</li>)}
      </ul>
    </details>
  );
}

export function JsonTable({ value, columns, label, copy, empty }: { value: unknown; columns?: string[]; label: string; copy: (text: string, done: string) => void; empty: string }) {
  const rows = useMemo(() => tableRows(value), [value]);
  const cols = useMemo(() => (rows ? tableColumns(rows, columns) : []), [rows, columns]);
  // mold_v0-300: an unset field (nothing, an empty text, an empty list or object) shows the section's own empty words.
  const unset = value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value as object).length);
  if (!rows || !rows.length) return (
    <div className='flex items-center gap-3 px-6 py-5' data-section-empty=''>
      <Icons.table aria-hidden className='text-muted-foreground size-5 shrink-0' />
      <p className='text-muted-foreground text-sm'>{rows || unset ? empty : 'This value is not a list of items, so it is not drawn as a table.'}</p>
    </div>
  );
  const num = (k: string) => numericColumn(rows, k);
  const TH = 'text-muted-foreground h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap first:pl-6 last:pr-6';
  const TD = 'px-3 py-2.5 align-top first:pl-6 last:pr-6';
  return (
    <div className='flex min-w-0 flex-col' data-json-table=''>
      <div className='hidden overflow-x-auto md:block'>
        <table className='w-full text-sm' aria-label={label}>
          <thead className='[&_tr]:border-b'><tr>{cols.map((c) => <th key={c} scope='col' className={cn(TH, num(c) && 'text-right')}>{columnWords(c)}</th>)}</tr></thead>
          <tbody className='[&_tr:last-child]:border-0'>
            {rows.map((r, i) => (
              <tr key={i} className='hover:bg-muted/40 border-b' data-json-row={i}>
                {cols.map((c) => <td key={c} className={cn(TD, num(c) && 'text-right tabular-nums', r[c] == null && 'text-muted-foreground')}><Cell v={r[c]} column={c} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className='divide-y md:hidden' data-json-list=''>
        {rows.map((r, i) => (
          <li key={i} className='px-4 py-3'>
            <dl className='grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs'>
              {cols.map((c) => (
                <div key={c} className='flex min-w-0 flex-col gap-0.5'>
                  <dt className='text-muted-foreground'>{columnWords(c)}</dt>
                  <dd className={cn('min-w-0 text-sm break-words', num(c) && 'tabular-nums')}><Cell v={r[c]} column={c} /></dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className='flex border-t px-4 py-2.5 sm:px-6'>
        <Button type='button' variant='outline' size='sm' onClick={() => copy(JSON.stringify(rows, null, 2), `${label} copied`)} data-table-copy=''>
          <Icons.copy aria-hidden data-icon='inline-start' />Copy as JSON
        </Button>
      </div>
    </div>
  );
}
