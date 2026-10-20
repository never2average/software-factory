import { redirect } from 'next/navigation';
import { CUSTOMER_DOCS_HOME } from '@/features/docs/customer-docs';

/** The guide opens on its first page. */
export default function Page() {
  redirect(CUSTOMER_DOCS_HOME);
}
