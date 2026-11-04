'use client';
// Settings › Alerts (mold_v0-219; the scheduled_alerts flag of the features registry): who gets the reminders and
// escalations, and when, as the packs declare them (pack.json record_areas[].due and .clocks[].remind / .escalate):
// one row per due date and per clock step, with the roles told, read from the build (scripts/gen-packs.mjs alertRules).
// The standard full-area table: four cards, the search row, the table, a row's full card.
import { RecordView, type RecordCol } from '@/components/layout/record-view';
import { StatStrip } from '@/components/layout/section';
import { alertRules, type AlertRule } from '@/config/pack-nav.generated';

const ROLE: Record<string, string> = { owner: 'Owners', billing: 'Billing', member: 'Members', viewer: 'Viewers', assignee: 'The assignee' };
const who = (r: AlertRule) => r.who.map((x) => ROLE[x] ?? x).join(', ');
interface Row extends AlertRule { key: string }

const COLUMNS: RecordCol<Row>[] = [
  { key: 'area', label: 'Area', title: true, keep: true, type: 'text', className: 'min-w-36', value: (r) => r.area_label, render: (r) => <span className='font-medium'>{r.area_label}</span> },
  { key: 'source', label: 'From', type: 'select', options: [{ value: 'due', label: 'Due date' }, { value: 'clock', label: 'Clock' }], value: (r) => r.source, render: (r) => (r.source === 'due' ? 'Due date' : `Clock: ${r.clock}`) },
  { key: 'step', label: 'Step', type: 'text', value: (r) => r.step, render: (r) => r.step },
  { key: 'when', label: 'When', type: 'text', keep: true, value: (r) => r.when, render: (r) => r.when },
  { key: 'who', label: 'Who is told', type: 'text', keep: true, value: (r) => who(r), render: (r) => who(r) },
  { key: 'does', label: 'Also', type: 'text', value: (r) => r.does ?? '', render: (r) => r.does ?? '' }
];

export function AlertsTab({ rules = alertRules }: { rules?: readonly AlertRule[] }) {
  const rows: Row[] = rules.map((r, i) => ({ ...r, key: `${r.area}:${r.clock ?? 'due'}:${i}` }));
  const reminders = rows.filter((r) => r.step.startsWith('Reminder')).length;
  const escalations = rows.filter((r) => r.source === 'clock' && !r.step.startsWith('Reminder')).length;
  return (
    <RecordView<Row>
      id='settings-alerts' compact noun='alerts' properties
      rows={rows} rowKey={(r) => r.key} cols={COLUMNS}
      summary={<StatStrip quad items={[
        { label: 'Alerts', value: rows.length, said: `${rows.length} alerts` },
        { label: 'Due dates', value: rows.filter((r) => r.source === 'due').length, said: 'due dates' },
        { label: 'Reminders', value: reminders, said: `${reminders} reminders` },
        { label: 'Escalations', value: escalations, said: `${escalations} escalations` }
      ]} />}
      searchText={(r) => `${r.area_label} ${r.clock ?? ''} ${r.step} ${r.when} ${who(r)} ${r.does ?? ''}`}
      searchPlaceholder='Search alerts'
      empty={<p className='text-muted-foreground text-sm'>This app sends no reminders or escalations.</p>}
      detailTitle={(r) => `${r.area_label}: ${r.step}`}
      detail={(r) => (
        <dl className='grid gap-3 text-sm'>
          <div><dt className='text-muted-foreground'>From</dt><dd>{r.source === 'due' ? 'The area\'s due date: one in-app notice per record, and one email a day listing them' : `The clock ${r.clock}: one in-app notice per record and deadline, and one email per person`}</dd></div>
          <div><dt className='text-muted-foreground'>When</dt><dd>{r.when}</dd></div>
          <div><dt className='text-muted-foreground'>Who is told</dt><dd>{who(r)}</dd></div>
          {r.does && <div><dt className='text-muted-foreground'>Also</dt><dd>{r.does}</dd></div>}
          <div><dt className='text-muted-foreground'>Where it is set</dt><dd>The app's own configuration: ask whoever runs the app to change who is told or when.</dd></div>
        </dl>
      )}
    />
  );
}
