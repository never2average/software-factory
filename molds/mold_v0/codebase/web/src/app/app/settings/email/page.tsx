import { EmailSettingsPage } from '@/features/email/email-settings-page';

// Settings › Email (mold_v0-192; src/email-routes.ts): the workspace's own sender and the mailboxes the intake reads,
// when a pack turns the company's own email on. With none the API answers 404, so the page says there is nothing here.
export const metadata = { title: 'Email' };

export default function Page() {
  return <EmailSettingsPage />;
}
