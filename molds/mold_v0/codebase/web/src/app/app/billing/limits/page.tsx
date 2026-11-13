import { redirect } from 'next/navigation';

// Limits are Billing's Budget rules tab (mold_v0-298: the tab itself, ?tab=rules; a member without it lands on Billing's first tab).
export default function Page() {
  redirect('/app/billing?tab=rules');
}
