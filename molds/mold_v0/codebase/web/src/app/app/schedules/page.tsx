import { SchedulesPage } from '@/features/schedules/schedules-page';

// Schedules per workspace (mold_v0-035): the packs' default schedules and the workspace's own. With no job kind in the
// build the sidebar has no entry and the API answers 404, so the page shows the error.
export const metadata = { title: 'Schedules' };

export default function Page() {
  return <SchedulesPage />;
}
