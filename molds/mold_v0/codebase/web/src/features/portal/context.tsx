'use client';
// /app Context: the account's institutional memory, one page each for the company, a user and a product. Each page
// shows the memory list, saves to it (Add memory and its docked editor), searches it, and exports or imports it as
// CSV or JSON. The AI client reads and writes the same memory (save_to_memory, search_memory; src/context.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import PageContainer from '@/components/layout/page-container';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { Icons } from '@/components/icons';
import { appApi } from '@/lib/api-client';
import { csvCell, parseCsv } from '@/lib/csv';
import { counted } from '@/lib/octillion-format';
import { cn } from '@/lib/utils';
import { Dock, KINDS, TYPE_STYLE, type Kind, type MemoryItem, type MemoryScope } from './memory';
import { Field, RecordView, type RecordCol, type RowAction } from '@/components/layout/record-view';
import { ErrorState, LoadingCards, When, fail, useOrgLoad } from './shared';
import { Allowed, useAccountRole } from './role';

interface Ctx { person: unknown | null; products: { slug: string; name: string }[] }
interface UserRow { user_id: string; email: string | null; name: string | null; active: boolean; me: boolean; memories?: number }

export type ContextSection = 'company' | 'users' | 'products';

/** Context: three pages (company, users, products), reached from the sidebar; each is one memory table and its toolbar. */
export function ContextPage({ section }: { section: ContextSection }) {
  const { data: d, error } = useOrgLoad(() => appApi<Ctx>('GET', '/context'));
  const shown: ContextSection = section === 'users' && d && !d.person ? 'company' : section;
  return (
    <PageContainer>
      {error ? <ErrorState error={error} /> : !d ? <LoadingCards count={2} /> : <MemoryTable key={shown} d={d} section={shown} />}
    </PageContainer>
  );
}

function MemoryTable({ d, section }: { d: Ctx; section: ContextSection }) {
  const scope: MemoryScope = section === 'company' ? 'company' : section === 'users' ? 'user' : 'product';
  const [users, setUsers] = useState<UserRow[] | null>(null);
  // Users: one person at a time. Products: every product's memory in one table (no onboarded product needed).
  const [subject, setSubject] = useState<string>('');
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [editing, setEditing] = useState<{ item?: MemoryItem } | null>(null);
  const { can, lock } = useAccountRole();

  useEffect(() => {
    if (section !== 'users') return;
    appApi<{ users: UserRow[] }>('GET', '/context/users').then((r) => {
      setUsers(r.users);
      setSubject((cur) => cur || r.users.find((u) => u.me)?.user_id || r.users[0]?.user_id || '');
    }).catch(fail);
  }, [section]);

  const load = useCallback(() => {
    if (section === 'users' && !subject) { setItems([]); return; }
    appApi<{ memories: MemoryItem[] }>('GET', `/context/memories?scope=${scope}&subject=${encodeURIComponent(subject)}`).then((r) => setItems(r.memories)).catch(fail);
  }, [section, scope, subject]);
  useEffect(() => { setItems(null); load(); }, [load]);

  const user = users?.find((u) => u.user_id === subject);
  const label = section === 'company' ? 'Company' : section === 'users' ? (user ? (user.me ? 'You' : user.name || user.email || 'this user') : '') : 'Products';
  // Product names to suggest: onboarded products, then names already used in memory.
  const productNames = useMemo(() => [...new Set([...d.products.map((p) => p.name), ...(items ?? []).map((m) => m.subject_name ?? '').filter(Boolean)])], [d.products, items]);

  const save = (item: MemoryItem | undefined, kind: Kind, body: string, product?: string) =>
    (item ? appApi('PUT', `/context/memories/${item.id}`, { kind, body }) : appApi('POST', '/context/memories', { scope, subject: section === 'products' ? product : subject, kind, body }))
      .then(() => { toast.success(item ? 'Memory updated' : `Saved to ${section === 'products' ? `${product}'s` : label === 'You' ? 'your' : `${label}'s`} memory`); load(); return true; })
      .catch((e) => { fail(e); return false; });
  const remove = (m: MemoryItem) => appApi('DELETE', `/context/memories/${m.id}`).then(() => { toast.success('Removed from memory'); load(); }).catch(fail);

  const noSubject = section === 'users' && !subject;
  const file = useRef<HTMLInputElement>(null);
  const importFile = async (f: File) => {
    let rows: { kind?: string; body?: string; product?: string }[];
    try { rows = parseMemoryFile(f.name, await f.text()); } catch (e) { fail(e); return; }
    if (!rows.length) { toast.error('No memories found in that file'); return; }
    appApi<{ imported: number; skipped: number }>('POST', '/context/memories/import', { scope, subject, items: rows })
      .then((r) => { toast.success(`Imported ${r.imported} memor${r.imported === 1 ? 'y' : 'ies'}${r.skipped ? `, skipped ${r.skipped} ${section === 'products' ? 'empty or without a product' : 'empty'}` : ''}`); load(); })
      .catch(fail);
  };
  const cols: RecordCol<MemoryItem>[] = [
    { key: 'kind', label: 'Type', className: 'w-28', keep: true, type: 'select', value: (m) => m.kind, options: KINDS.map((k) => ({ value: k.id, label: k.label })), render: (m) => <span className={cn('inline-flex h-6 items-center rounded-md px-2 text-xs leading-none font-medium capitalize ring-1 ring-inset', TYPE_STYLE[m.kind] ?? TYPE_STYLE.note)}>{m.kind}</span> },
    ...(section === 'products' ? [{ key: 'product', label: 'Product', className: 'w-44', keep: true, type: 'select' as const, value: (m: MemoryItem) => m.subject_name ?? undefined, render: (m: MemoryItem) => <span className='text-sm font-medium'>{m.subject_name}</span> }] : []),
    { key: 'body', label: 'Memory', keep: true, type: 'text', value: (m) => m.body, render: (m) => <p className='line-clamp-3 text-sm whitespace-pre-wrap'>{m.body}</p> },
    // When on line 1, who added it on line 2 (one event; was Added by and Added).
    { key: 'at', label: 'Added', className: 'hidden w-40 sm:table-cell', type: 'date', value: (m) => m.created_at, render: (m) => (<>
      <span className='text-muted-foreground text-xs'><When d={m.created_at} /></span>
      {m.created_by && <div className='text-muted-foreground mt-1 max-w-40 truncate text-xs leading-none' title={m.created_by}>{m.created_by}</div>}
    </>) }
  ];
  const picker = section === 'users' && users && users.length > 1 && (
    <NativeSelect aria-label='User' value={subject} onChange={(e) => setSubject(e.target.value)} className='w-56'>
      {/* Each person's memory items; the one shown counts its loaded rows, so adds and deletes show at once. */}
      {users.map((u) => <NativeSelectOption key={u.user_id} value={u.user_id}>{counted(`${u.name || u.email || 'Unnamed user'}${u.me ? ' (you)' : ''}${u.active ? '' : ' · suspended'}`,
        u.user_id === subject && items ? items.length : u.memories)}</NativeSelectOption>)}
    </NativeSelect>
  );
  // One button plus RecordView's ▾ menu holding Import and Export.
  const primary = !noSubject && <Allowed need='edit'><Button onClick={() => setEditing({})}><Icons.add /> Add memory</Button></Allowed>;
  const primaryMenu: RowAction[] | undefined = noSubject ? undefined : [
    lock({ label: 'Import CSV or JSON', icon: <Icons.upload />, onSelect: () => file.current?.click() }, 'edit'),
    { label: 'Export CSV', icon: <Icons.download />, disabled: !items?.length, onSelect: () => { if (items) exportCsv(items, label, section === 'products'); } }
  ];
  return (
    <>
      <RecordView<MemoryItem>
        key={subject}
        rows={items ?? []} rowKey={(m) => String(m.id)} cols={cols} loading={items === null && !noSubject} noun='memories'
        actions={(m) => m.can_delete && can('edit') ? [
          { label: 'Edit', icon: <Icons.edit />, onSelect: () => setEditing({ item: m }) },
          { label: 'Remove', icon: <Icons.trash />, destructive: true, onSelect: () => void remove(m) }
        ] : []}
        searchText={(m) => `${m.kind} ${m.body} ${m.created_by ?? ''} ${m.subject_name ?? ''}`}
        searchPlaceholder={`Search ${label ? `${label === 'You' ? 'your' : `${label}'s`} ` : ''}memory`}
        filters={picker || undefined}
        primary={primary || undefined} primaryMenu={primaryMenu}
        empty={noSubject ? 'Nobody to show.' : 'Nothing remembered yet. Add the first memory, or import a CSV or JSON file.'}
        detailTitle={(m) => `${m.kind[0].toUpperCase()}${m.kind.slice(1)}${m.subject_name && section === 'products' ? ` · ${m.subject_name}` : ''}`}
        detail={(m) => (
          <div className='flex flex-col gap-5'>
            <p className='text-base whitespace-pre-wrap'>{m.body}</p>
            <dl>
              <Field label='Type'><span className={cn('inline-flex h-6 items-center rounded-md px-2 text-xs leading-none font-medium capitalize ring-1 ring-inset', TYPE_STYLE[m.kind] ?? TYPE_STYLE.note)}>{m.kind}</span></Field>
              {section === 'products' && <Field label='Product'>{m.subject_name}</Field>}
              <Field label='Added by'>{m.created_by ?? '—'}</Field>
              <Field label='Added'><When d={m.created_at} /></Field>
            </dl>
          </div>
        )}
      />
      <input ref={file} type='file' accept='.csv,.json,text/csv,application/json' className='hidden' onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
      {editing && <MemoryEditor key={editing.item?.id ?? 'new'} item={editing.item} label={label} products={section === 'products' ? productNames : undefined} onClose={() => setEditing(null)} onSave={save} />}
    </>
  );
}

// ---------- export / import ----------

/** Download the list as CSV: (product,) kind, memory, added_by, added_at (the same columns import reads back). */
function exportCsv(items: MemoryItem[], label: string, withProduct = false) {
  const lines = [[...(withProduct ? ['product'] : []), 'kind', 'memory', 'added_by', 'added_at'].join(','),
    ...items.map((m) => [...(withProduct ? [m.subject_name ?? m.subject ?? ''] : []), m.kind, m.body, m.created_by ?? '', new Date(m.created_at).toISOString()].map(csvCell).join(','))];
  const blob = new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `octillion-memory-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'export'}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A memory file: our CSV export (or any CSV with a memory/body column), or JSON: a list of { kind, body } or strings. */
function parseMemoryFile(name: string, text: string): { kind?: string; body?: string; product?: string }[] {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (name.toLowerCase().endsWith('.json') || t.startsWith('[') || t.startsWith('{')) {
    const data = JSON.parse(t);
    const list = Array.isArray(data) ? data : Array.isArray(data?.memories) ? data.memories : null;
    if (!list) throw new Error('JSON must be a list of memories, e.g. [{ "kind": "fact", "body": "…" }]');
    return list.map((x: unknown) => (typeof x === 'string' ? { body: x } : { kind: (x as any)?.kind, body: (x as any)?.body ?? (x as any)?.memory, product: (x as any)?.product }));
  }
  const [head, ...rest] = parseCsv(t);
  if (!head) return [];
  const cols = head.map((h) => h.trim().toLowerCase());
  const bodyAt = cols.findIndex((c) => c === 'memory' || c === 'body' || c === 'text');
  const kindAt = cols.indexOf('kind'), productAt = cols.indexOf('product');
  if (bodyAt < 0) return [head, ...rest].map((r) => ({ body: r[0] })); // no header: one memory per line
  return rest.map((r) => ({ kind: kindAt >= 0 ? r[kindAt] : undefined, body: r[bodyAt], product: productAt >= 0 ? r[productAt] : undefined }));
}

/** Save a new memory item or change one, in the docked window. */
function MemoryEditor({ item, label, products, onClose, onSave }: {
  item?: MemoryItem; label: string; products?: string[]; onClose: () => void; onSave: (item: MemoryItem | undefined, kind: Kind, body: string, product?: string) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<Kind>(item?.kind ?? 'fact');
  const [product, setProduct] = useState(item?.subject_name ?? '');
  const needsProduct = Boolean(products) && !item;
  const [body, setBody] = useState(item?.body ?? '');
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus(); }, []);
  const save = (again: boolean) => {
    if (!body.trim() || (needsProduct && !product.trim())) return;
    setBusy(true);
    void onSave(item, kind, body.trim(), product.trim()).then((ok) => { setBusy(false); if (!ok) return; if (again && !item) { setBody(''); area.current?.focus(); } else onClose(); });
  };
  return (
    <Dock title={`${item ? 'Edit memory' : 'New memory'} · ${products ? (item?.subject_name ?? 'Product') : label}`} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); save(false); }} className='flex flex-col gap-3 p-4'>
        {needsProduct && (<>
          <Input list='memory-products' value={product} onChange={(e) => setProduct(e.target.value)} placeholder='Product name (onboarded or not)' aria-label='Product' maxLength={120} />
          <datalist id='memory-products'>{products!.map((n) => <option key={n} value={n} />)}</datalist>
        </>)}
        <div role='radiogroup' aria-label='Kind' className='flex flex-wrap gap-1.5'>
          {KINDS.map((k) => (
            <button key={k.id} type='button' role='radio' aria-checked={kind === k.id} onClick={() => setKind(k.id)}
              className={cn('rounded-full border px-3 py-1 text-xs font-medium transition-colors', kind === k.id ? 'border-primary bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground')}>
              {k.label}
            </button>
          ))}
        </div>
        <Textarea ref={area} rows={5} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={KINDS.find((k) => k.id === kind)?.hint}
          aria-label='What to remember' className='resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0'
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(false); } }} />
        <div className='flex items-center gap-2 border-t pt-3'>
          <Button type='submit' disabled={busy || !body.trim() || (needsProduct && !product.trim())}>{item ? 'Save' : 'Save to memory'}</Button>
          {!item && <Button type='button' variant='ghost' disabled={busy || !body.trim() || (needsProduct && !product.trim())} onClick={() => save(true)}>Save & add another</Button>}
          <span className='text-muted-foreground ml-auto text-xs tabular-nums'>{body.length}/1000</span>
        </div>
      </form>
    </Dock>
  );
}
