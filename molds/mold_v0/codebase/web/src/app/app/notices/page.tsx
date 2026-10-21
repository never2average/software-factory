import { NoticesPage } from '@/features/schedules/notices-page';

// In-app notices (mold_v0-035): records due soon, posted once a day. With no area declaring due dates the sidebar has
// no entry and the API answers 404.
export const metadata = { title: 'Notices' };

export default function Page() {
  return <NoticesPage />;
}
