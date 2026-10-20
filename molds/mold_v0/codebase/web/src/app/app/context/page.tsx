import { redirect } from 'next/navigation';

// Context is three pages now; the old ?tab= links land on the matching one.
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const tab = (await searchParams).tab;
  redirect(tab === 'me' || tab === 'users' ? '/app/context/users' : tab === 'products' ? '/app/context/products' : '/app/context/company');
}
