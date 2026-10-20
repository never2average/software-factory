import { redirect } from 'next/navigation';

// Spend became FinOps (/admin/finops); old links keep their ?section= and range.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of ([] as (string | undefined)[]).concat(v)) if (x != null) q.append(k, x);
  const qs = q.toString();
  redirect(qs ? `/admin/finops?${qs}` : '/admin/finops');
}
