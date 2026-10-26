import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { resolveContext } from '@/features/context/config';
import { ContextPage } from '@/features/context/context-page';

// The account context and memory pages (mold_v0-142; src/account-context.ts): /app/context/<page> for each scope the
// build's pack.json `memory` turns on (company, users, products), old page names redirecting to theirs, and /app/context
// itself to the page its ?tab= names (else the first). With the component off every address here is not found.
type Props = { params: Promise<{ section?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = resolveContext((await params).section);
  return r && 'page' in r ? { title: r.page.title } : {};
}
export default async function Page({ params, searchParams }: Props) {
  const tab = (await searchParams).tab;
  const r = resolveContext((await params).section, typeof tab === 'string' ? tab : undefined);
  if (!r) notFound();
  if ('redirect' in r) redirect(r.redirect);
  return <ContextPage section={r.page.section} />;
}
