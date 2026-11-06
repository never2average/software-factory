'use client';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

/** The landing page's questions (mold_v0-122, after the first product's): an accordion between two rules. */
export function LandingFaq({ items }: { items: { question: string; answer: string }[] }) {
  return (
    <Accordion className='divide-y border-y'>
      {items.map((q, i) => (
        <AccordionItem key={i} value={String(i)} className='px-0'>
          <AccordionTrigger className='my-2 py-3 text-left text-base font-medium'>{q.question}</AccordionTrigger>
          <AccordionContent className='text-muted-foreground px-3 pb-4'>{q.answer}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
