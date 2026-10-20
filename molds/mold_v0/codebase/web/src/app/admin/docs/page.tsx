import { redirect } from 'next/navigation';
import { firstAdminDocHref } from '@/features/docs/admin-docs';

// No cover page: the first doc is the docs' landing page.
export default function Page() {
  redirect(firstAdminDocHref());
}
