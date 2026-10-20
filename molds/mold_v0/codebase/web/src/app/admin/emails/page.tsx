import { redirect } from 'next/navigation';

/** Emails is a tab on Compute now. */
export default function Page() {
  redirect('/admin/compute?section=emails');
}
