import { redirect } from 'next/navigation';

// Limits are part of the Billing page.
export default function Page() {
  redirect('/app/billing#limits');
}
