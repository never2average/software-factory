import type { Metadata } from 'next';
import Link from 'next/link';
import { profile } from '@/config/profile.generated';
import { hostLanding } from '@/features/packs/host-registry';
import type { HostPageComponent } from '@/features/packs/host-web';

// The landing page: a host pack's (mold_v0-039) when the build has one, else the shell's own, in the profile's words.
export async function generateMetadata(): Promise<Metadata> {
  return hostLanding()?.metadata ?? {};
}

export default function LandingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const Host = hostLanding()?.default as HostPageComponent | undefined;
  if (Host) return <Host searchParams={searchParams} />;
  return (
    <section className='mx-auto flex max-w-3xl flex-col gap-6 px-4 py-24 sm:px-6'>
      <h1 className='text-3xl font-semibold tracking-tight sm:text-4xl'>{profile.name}</h1>
      <p className='text-muted-foreground text-lg'>{profile.console_description}</p>
      <div className='flex gap-4'>
        <Link className='underline' href='/app'>Sign in</Link>
        <Link className='underline' href='/install'>Connect an MCP client</Link>
      </div>
    </section>
  );
}
