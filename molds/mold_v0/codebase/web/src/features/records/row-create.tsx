'use client';
// An open row's Add <related record> buttons (mold_v0-256, flag record_pages): on an area's list, the row opened beside
// it offers the create_record actions its page declares and this person may take (the server says which:
// GET /api/records/_page/<area>/<key>), each opening that area's Add form with the fields filled in (./detail-layout.ts
// createHref: ?new=1&<field>=<value>), in the side panel when side_panel_forms is on.
import Link from 'next/link';
import { Icons } from '@/components/icons';
import { PanelMenu } from '@/components/layout/detail-panel';
import type { RowAction } from '@/components/layout/record-filters';
import { Button } from '@/components/ui/button';
import { featureOn } from '@/config/features';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { useOrgLoad } from '@/features/portal/shared';
import { createHref, declaresCreate, layoutOf, type PageData } from './detail-layout';

export function RowCreateActions({ area, recordKey }: { area: RecordAreaSpec; recordKey: string }) {
  const wanted = featureOn('record_pages') && declaresCreate(layoutOf(area));
  const { data } = useOrgLoad(() => (wanted
    ? fetch(`/api/records/_page/${encodeURIComponent(area.name)}/${encodeURIComponent(recordKey)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<PageData>) : null)).catch(() => null)
    : Promise.resolve(null)), [wanted, area.name, recordKey]);
  const creates = (data?.actions ?? []).filter((a) => a.kind === 'create_record' && !a.disabled && createHref(a));
  return (<>
    {creates.map((a) => (
      <Button key={a.id} variant='outline' size='sm' nativeButton={false} render={<Link href={createHref(a)!} />} data-row-create={a.id}>
        <Icons.add aria-hidden data-icon='inline-start' />{a.label}
      </Button>
    ))}
  </>);
}

/** mold_v0-278: a record panel's ⋯ menu: `items`, then the Add <related record> actions its page declares (flag record_pages). */
export function RowCreateMenu({ area, recordKey, items, name }: { area: RecordAreaSpec; recordKey: string; items: RowAction[]; name: string }) {
  const wanted = featureOn('record_pages') && declaresCreate(layoutOf(area));
  const { data } = useOrgLoad(() => (wanted
    ? fetch(`/api/records/_page/${encodeURIComponent(area.name)}/${encodeURIComponent(recordKey)}`, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<PageData>) : null)).catch(() => null)
    : Promise.resolve(null)), [wanted, area.name, recordKey]);
  const creates: RowAction[] = (data?.actions ?? []).filter((a) => a.kind === 'create_record' && !a.disabled && createHref(a))
    .map((a) => ({ label: a.label, icon: <Icons.add aria-hidden />, href: createHref(a)! }));
  const own = items.filter((x) => !x.href);
  return <PanelMenu name={name} items={[...own, ...creates.map((a, i) => (i === 0 && own.length ? { ...a, separator: true } : a)), ...items.filter((x) => x.href)]} />;
}
