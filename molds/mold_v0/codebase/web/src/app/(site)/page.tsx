import type { Metadata } from 'next';
import { hostLanding } from '@/features/packs/host-registry';
import type { HostPageComponent } from '@/features/packs/host-web';
import { LandingSections, landingMetadata } from '@/features/site/landing';
import { accountsMode } from '@/features/site/accounts-mode';

// The landing page: a host pack's own (mold_v0-039) when the build has one, else the declared landing block (a pack's
// pack.json `landing`, the app's profile.json `landing` over it; mold_v0-091), else the shell's neutral page in the
// profile's words.
export async function generateMetadata(): Promise<Metadata> {
  const host = hostLanding();
  return host ? (host.metadata ?? {}) : landingMetadata();
}

export default async function LandingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const Host = hostLanding()?.default as HostPageComponent | undefined;
  if (Host) return <Host searchParams={searchParams} />;
  // Invite-only (mold_v0-098): its calls to sign up lead to the request form.
  return <LandingSections access={await accountsMode()} />;
}
