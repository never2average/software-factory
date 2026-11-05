// A record's json field, readable (mold_v0-240; ./json-text.ts): a list of objects one line per item (its name, then
// its meaningful fields), an object one line per field; bookkeeping hidden, common short values in words. Drawn by a
// record's page, an open row's card and a staff record's page (./record-pages.tsx FieldValue). Spans, not a list: it
// sits in a field's inline value.
import type { ReactNode } from 'react';
import { jsonView, type JsonPart } from './json-text';

const Parts = ({ parts }: { parts: JsonPart[] }) => (
  <>{parts.map((p, i) => <span key={`${p.label}-${i}`}>{i > 0 && <span className='text-muted-foreground' aria-hidden> · </span>}{p.label}: {p.text}</span>)}</>
);

export function JsonValue({ v, recordKey, empty }: { v: unknown; recordKey?: string; empty: ReactNode }) {
  const view = jsonView(v, recordKey);
  if (view.kind === 'items') return view.items.length ? (
    <span role='list' className='flex flex-col gap-1.5 leading-snug' data-json-items=''>
      {view.items.map((it, i) => (
        <span role='listitem' className='block' key={i}>
          {it.name && <span className='font-medium'>{it.name}</span>}
          {it.name && it.parts.length > 0 && <span className='text-muted-foreground' aria-hidden> · </span>}
          <Parts parts={it.parts} />
        </span>
      ))}
    </span>
  ) : <>{empty}</>;
  if (view.kind === 'fields') return view.parts.length ? (
    <span role='list' className='flex flex-col gap-1.5 leading-snug' data-json-fields=''>
      {view.parts.map((p, i) => <span role='listitem' className='block' key={`${p.label}-${i}`}>{p.label}: {p.text}</span>)}
    </span>
  ) : <>{empty}</>;
  return <>{view.text || empty}</>;
}
