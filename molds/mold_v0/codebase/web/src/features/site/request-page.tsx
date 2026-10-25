/**
 * The request page (mold_v0-138, after the first product's early-access page): the landing block's `request_page`
 * (src/landing.ts) at its own path, which next.config rewrites to app/(site)/declared/[page] (pack-routes.generated.json).
 * Its words beside the request form (./request-page-form.tsx), over the landing hero's backdrop, filling the space between
 * the header and the footer. No product's words here: every text is the block's, shown as text.
 */
import type { Metadata } from 'next';
import { Backdrop } from './landing';
import { LANDING_ICONS } from './landing-icons';
import type { RequestPage } from './landing-types';
import { RequestPageForm } from './request-page-form';

/** Its title (under the public pages' title template) and description: the block's seo, else its title and lead. */
export function requestPageMetadata(page: RequestPage): Metadata {
  const title = page.seo?.title ?? [page.title, page.title_highlight].filter(Boolean).join(' ');
  const description = page.seo?.description ?? page.lead;
  return { title, ...(description ? { description } : {}) };
}

export function RequestPageView({ page }: { page: RequestPage }) {
  return (
    <section className='relative flex min-h-[calc(100svh-8rem)] items-center overflow-hidden'>
      <Backdrop />
      <div className='relative mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16'>
        <div className='grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center'>
          <div className='min-w-0'>
            {page.eyebrow ? <p className='text-primary font-mono text-xs tracking-wider uppercase'>{page.eyebrow}</p> : null}
            <h1 className='mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem] lg:leading-[1.1]'>
              {page.title}{page.title_highlight ? <> <span className='text-primary'>{page.title_highlight}</span></> : null}
            </h1>
            {page.lead ? <p className='text-muted-foreground mt-4 max-w-md text-base text-pretty sm:text-lg'>{page.lead}</p> : null}
            {page.benefits?.length ? (
              <ul className='mt-10 space-y-6'>
                {page.benefits.map((b, i) => {
                  const Icon = b.icon ? LANDING_ICONS[b.icon] : null;
                  return (
                    <li key={i} className='flex items-center gap-4'>
                      {Icon ? <Icon className='text-primary size-7 shrink-0' stroke={1.5} aria-hidden='true' /> : null}
                      <div><p className='font-semibold'>{b.title}</p><p className='text-muted-foreground text-sm'>{b.body}</p></div>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
          <div className='bg-background/60 min-w-0 rounded-xl border p-5 backdrop-blur sm:p-6'>
            <RequestPageForm form={page.form} />
          </div>
        </div>
      </div>
    </section>
  );
}
