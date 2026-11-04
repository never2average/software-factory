'use client';
// A workspace's Import (mold_v0-234): beside a list's Export, on an area whose contract grants import to this person's
// role (the generated registry's import_roles; the server decides again: src/record-areas.ts importRoles). It opens a
// panel with the staff import's form (./staff-import.tsx): a CSV or JSON file read in the browser, its columns mapped to
// the area's key, title and fields, a preview from the server (POST /api/data/<area>/_import: what each row would do, and
// each invalid row's problems), then the import itself: the valid rows as the workspace's records, written as this
// person in one transaction, idempotent by key. Nothing is written before Import. A lifecycle's state is never mapped:
// new records start in the initial state, existing ones keep theirs.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ActionCard, type FormField } from '@/features/tabs/tab-action';
import { fail } from '@/features/portal/shared';
import { httpError } from '@/features/status/from-error';
import { singular } from '@/features/tabs/run-rows';
import { ImportRecordsForm } from './staff-import';

interface Offer { area: string; label: string; import: boolean; fields: FormField[] }

const importUrl = (area: string) => `/api/data/${encodeURIComponent(area)}/_import`;

/** The Import button and its panel, for one workspace area. */
export function WorkspaceImportButton({ area, compact = false }: { area: { name: string; label: string }; compact?: boolean }) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const res = await fetch(importUrl(area.name), { credentials: 'same-origin', headers: { accept: 'application/json' } });
      const body = (await res.json().catch(() => ({}))) as Offer & { error?: string };
      if (!res.ok) throw httpError(res.status, body);
      if (!body.import) throw new Error(`Your role may not import ${area.label} records.`);
      setOffer(body);
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const noun = singular(area.label).toLowerCase();
  const close = () => setOffer(null);
  return (
    <>
      <Button variant='outline' size={compact ? 'default' : 'sm'} onClick={() => void open()} disabled={busy} data-testid='import-records'
        aria-label={compact ? `Import ${area.label}` : undefined} title={compact ? `Import ${area.label} from a CSV or JSON file` : undefined}
        className={compact ? 'max-sm:w-8 max-sm:px-0' : undefined}>
        {busy ? <Icons.spinner aria-hidden='true' className='animate-spin' /> : <Icons.upload aria-hidden='true' />}
        {compact ? <span className='hidden sm:inline'>Import</span> : ' Import'}
      </Button>
      {offer && (
        <Sheet open onOpenChange={(o) => { if (!o) close(); }}>
          <SheetContent side='right' className='gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl'>
            <SheetTitle className='sr-only'>Import {area.label}</SheetTitle>
            <SheetDescription className='sr-only'>Rows of a CSV or JSON file as records of {area.label}: map its columns, preview, then import.</SheetDescription>
            <div className='min-h-0 flex-1 overflow-y-auto p-4'>
              <ActionCard open onOpenChange={(o) => { if (!o) close(); }} title={`Import ${noun}s`}
                description={`Rows of a CSV or JSON file as records of ${area.label}: map its columns, preview, then import.`}>
                <ImportRecordsForm workspace area={area} fields={offer.fields} noun={noun} url={importUrl(area.name)}
                  onDone={() => { close(); window.location.reload(); }} />
              </ActionCard>
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
