'use client';
// A workspace's Import (mold_v0-234): on a list of an area whose contract grants import to this person's role (the
// generated registry's import_roles; the server decides again: src/record-areas.ts importRoles). Its button sits in the
// list's search row next to Export (its own button); its form is a full card in the list's place while open (?import=1,
// Back to the list), as a tab's create form is (?new=1): the staff import's form (./staff-import.tsx), a CSV or JSON
// file read in the browser, its columns mapped to the area's key, title and fields, a preview from the server (POST
// /api/data/<area>/_import: what each row would do, each invalid row's problems), then the import itself (the valid rows
// as the workspace's records, written as this person in one transaction, idempotent by key) and what it wrote. Nothing
// is written before Import. A lifecycle's state is never mapped: new records start in the initial state, existing ones
// keep theirs.
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import type { RecordAreaSpec } from '@/config/pack-nav.generated';
import { useAccountRole } from '@/features/portal/role';
import { useOrgLoad } from '@/features/portal/shared';
import { ActionCard, useActionOpen, type FormField } from '@/features/tabs/tab-action';
import { singular } from '@/features/tabs/run-rows';
import { ImportRecordsForm } from './staff-import';

interface Offer { area: string; label: string; import: boolean; fields: FormField[] }

const importUrl = (area: string) => `/api/data/${encodeURIComponent(area)}/_import`;

/**
 * The Import of one workspace area's list: its button (once the server says this person may import: none otherwise)
 * and, while open, its card for the list's place. `onDone` reloads the list after an import. A hook: called on every
 * render of the list, with null when the list is not one area's (a merged tab).
 */
export function useImportAction(area: Pick<RecordAreaSpec, 'name' | 'label' | 'scope' | 'import_roles'> | null, onDone?: () => unknown): { button: ReactNode; card: ReactNode } {
  const { role } = useAccountRole();
  const granted = !!(area && area.scope === 'workspace' && role && area.import_roles?.includes(role));
  const { data } = useOrgLoad(async (): Promise<Offer | null> => {
    if (!granted || !area) return null;
    const res = await fetch(importUrl(area.name), { credentials: 'same-origin', headers: { accept: 'application/json' } }).catch(() => null);
    return res?.ok ? ((await res.json()) as Offer) : null;
  }, [granted, area?.name]);
  const [open, setOpen] = useActionOpen('import');
  if (!area || !granted || !data?.import) return { button: null, card: null };
  const noun = singular(area.label).toLowerCase();
  const button = (
    <Button variant='outline' onClick={() => setOpen(true)} data-testid='import-records' aria-label={`Import ${area.label}`}
      title={`Import ${area.label} from a CSV or JSON file`} className='max-sm:w-8 max-sm:px-0'>
      <Icons.upload aria-hidden='true' /><span className='hidden sm:inline'>Import</span>
    </Button>
  );
  return {
    button,
    card: !open ? null : (
      <ActionCard open onOpenChange={setOpen} title={`Import ${noun}s`}
        description={`Rows of a CSV or JSON file as records of ${area.label}: map its columns, preview, then import.`}>
        <ImportRecordsForm workspace area={area} fields={data.fields} noun={noun} url={importUrl(area.name)}
          onDone={() => { setOpen(false); void onDone?.(); }} />
      </ActionCard>
    ),
  };
}
