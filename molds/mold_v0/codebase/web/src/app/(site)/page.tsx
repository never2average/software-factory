import { Faq } from '@/features/site/faq';
import { Hero, Scorecard, Section, WhatIsApo, WhereYouWork, WhyNow } from '@/features/site/sections';

export default function LandingPage() {
  return (
    <>
      <Hero />
      <WhyNow />
      <WhatIsApo />
      <Scorecard />
      <WhereYouWork />
      <Section id='faq' center eyebrow='FAQ' title='Questions.'
        lead='Straight answers on how Octillion measures agent preference, what it does and doesn’t touch, which agents it covers, and how your team gets started during early access.'>
        <div className='mx-auto max-w-3xl'><Faq /></div>
      </Section>
    </>
  );
}
