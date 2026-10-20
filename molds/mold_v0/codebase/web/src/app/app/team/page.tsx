import { redirect } from 'next/navigation';

// The team is part of the Billing page.
export default function Page() {
  redirect('/app/billing#team');
}
