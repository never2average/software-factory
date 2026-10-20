'use client';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

const FAQ = [
  ['What is APO?', 'Agentic Preference Optimization: measuring and improving how often AI coding agents choose your product while they do real work.'],
  ['How is it different from SEO or GEO?', 'SEO is for people reading search results, GEO for chatbots answering questions. APO is for agents writing code, where the outcome is an install, not a link.'],
  ['Which coding agents do you test?', 'Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot, OpenCode, Cline and more, mixed in proportion to how developers actually use them.'],
  ['Do the agents know about my product?', 'No. They get blind, realistic tasks in real repos. Your product is used only to score the transcript afterwards.'],
  ['Does Octillion change the models?', 'No. No paid placement, no prompt injection. You improve docs, examples and SDKs; Octillion measures whether preference moved.'],
  ['What counts as a pick?', 'Adopted means the agent installed, imported or configured you. Recommended means it explicitly advised you. Mentioned and Competitor are tracked separately, never counted as picks.'],
  ['Can I check a verdict myself?', 'Yes. Every verdict links to the transcript lines behind it: the install command, the import or the sentence that earned it.'],
  ['Can I bring my own tasks and repos?', 'Yes. Tasks should mirror what your buyers really ask agents to do. We help you shape a starting set during onboarding.'],
  ['Where do I see results?', 'In your Octillion dashboard, or by asking in Claude or ChatGPT through the Octillion connector, with charts rendered in the chat.'],
  ['Can my whole team use it?', 'Yes. Invite teammates, set roles, and split your usage budget across teams and people from the billing page.'],
  ['How are transcripts stored?', 'Each transcript is kept with its verdict and scoped to your organization’s account. Tell us during onboarding if you have retention requirements.'],
  ['How much does it cost?', 'We’re in early access. Pricing depends on scenarios, models and runs. Request early access and talk to us.']
];

export function Faq() {
  return (
    <Accordion className='divide-y border-y'>
      {FAQ.map(([q, a]) => (
        <AccordionItem key={q} value={q} className='px-0'>
          <AccordionTrigger className='py-4 text-left text-base font-medium'>{q}</AccordionTrigger>
          <AccordionContent className='text-muted-foreground pb-4'>{a}</AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}
