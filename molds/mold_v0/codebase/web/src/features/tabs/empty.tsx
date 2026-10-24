// A tab's empty state (mold_v0-107): what an area, runs or reports tab shows while it has nothing to show. The words
// come from the build (src/metric-spec.ts tabEmpty, written by gen-packs into the tab's spec): the pack's pack.json
// `empty` where it says one, else the shell's default from the area's label, the build's words and its onboarding.
// Plain text, drawn as text; the link's address was checked by the build (a path of this site, https: or mailto:).
// Pure: the tab page decides when there is nothing; a rendered check draws it (scripts/console-tabs-test.ts).
import { Icons } from '@/components/icons';
import { Button } from '@/components/ui/button';
import type { PackTabSpec } from '@/config/pack-nav.generated';

export type EmptySpec = NonNullable<PackTabSpec['empty']>;

/** The Setup page's anchor of a pack's onboarding step: the same as the build's (src/metric-spec.ts onboardingAnchor). */
export const onboardingAnchor = (pack: string, step: string) => `onboarding-${pack}-${step}`.replace(/[^A-Za-z0-9_-]/g, '-');

/** The fallback when a tab's spec carries none (a console built before mold_v0-107's generator). */
const NOTHING: EmptySpec = { title: 'Nothing here yet.', text: '', cta: null };

export function EmptyState({ empty, id }: { empty?: EmptySpec | null; id?: string }) {
  const e = empty ?? NOTHING;
  const external = !!e.cta && /^(https:|mailto:)/i.test(e.cta.href);
  return (
    <section aria-labelledby={id ? `${id}-title` : undefined} aria-label={id ? undefined : e.title} data-empty-state=''
      className='flex flex-col items-start gap-3 rounded-lg border border-dashed p-6'>
      <div className='flex items-start gap-3'>
        <Icons.inbox aria-hidden className='text-muted-foreground mt-0.5 size-5 shrink-0' />
        <div className='flex flex-col gap-1'>
          <h3 id={id ? `${id}-title` : undefined} className='text-sm font-medium'>{e.title}</h3>
          {e.text && <p className='text-muted-foreground max-w-prose text-sm'>{e.text}</p>}
        </div>
      </div>
      {e.cta && (
        <Button variant='outline' size='sm' className='ml-8'
          render={<a href={e.cta.href} {...(external ? { rel: 'noopener noreferrer' } : {})} />}>
          {e.cta.label}
        </Button>
      )}
    </section>
  );
}
