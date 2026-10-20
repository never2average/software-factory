import type { Metadata } from 'next';
import { IconChartBar, IconFileSearch, IconRefresh } from '@tabler/icons-react';
import { AccessForm } from '@/features/site/access-form';
import { HeroBackdrop } from '@/features/site/sections';

export const metadata: Metadata = { title: 'Early access', description: 'Request early access to Octillion and get your APO baseline.' };

const YOU_GET = [
  { icon: IconChartBar, title: 'Your pick rate', body: 'By agent, task and competitor.' },
  { icon: IconFileSearch, title: 'The why', body: 'Transcript evidence for every verdict.' },
  { icon: IconRefresh, title: 'Proof of fixes', body: 'Re-run after each docs or SDK change.' }
];

export default function EarlyAccessPage() {
  return (
    // Fills the space between header and footer and centres the content in it.
    <section className='relative flex min-h-[calc(100svh-8rem)] items-center overflow-hidden'>
      <HeroBackdrop />
      <div className='relative mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16'>
        <div className='grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center'>
          <div className='min-w-0'>
            <p className='text-primary font-mono text-xs tracking-wider uppercase'>Early access</p>
            <h1 className='mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]'>
              Get your <span className='text-primary'>APO baseline.</span>
            </h1>
            <p className='text-muted-foreground mt-4 max-w-md text-base text-pretty sm:text-lg'>Tell us your product. We’ll show where agents pick you, and where they don’t.</p>
            <ul className='mt-10 space-y-6'>
              {YOU_GET.map((r) => (
                <li key={r.title} className='flex items-center gap-4'>
                  <r.icon className='text-primary size-7 shrink-0' stroke={1.5} />
                  <div><p className='font-semibold'>{r.title}</p><p className='text-muted-foreground text-sm'>{r.body}</p></div>
                </li>
              ))}
            </ul>
          </div>
          <div className='bg-background/60 min-w-0 rounded-xl border p-5 backdrop-blur sm:p-6'>
            <AccessForm />
          </div>
        </div>
      </div>
    </section>
  );
}
