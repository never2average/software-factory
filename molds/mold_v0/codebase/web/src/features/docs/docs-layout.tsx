// The docs frame shared by /app/docs and /admin/docs, inside the app shell (its sidebar and header stay): the article
// at a reading width, and a sticky column on the right from lg up with the page tree above "On this page" (below lg a
// button above the article opens the pages in a drawer). Searching is the platform search (Cmd+K). A server component:
// the article is rendered here; only titles, hrefs and headings go to the client parts (docs-nav.tsx, docs-toc.tsx).
import type { ReactNode } from 'react';
import type { DocHeading, DocNavGroup } from './docs-data';
import { DocsMobileNav, DocsSidebar } from './docs-nav';
import { DocsToc } from './docs-toc';

/** The columns stick under the app header (h-16, h-14 from md) and scroll on their own. */
const STICKY = 'sticky top-14 h-[calc(100svh-3.5rem)] self-start overflow-y-auto overscroll-contain';

export function DocsLayout({ nav, title, description, headings = [], meta, children }: {
  nav: DocNavGroup[];
  title: string;
  description?: ReactNode;
  /** The article's h2/h3, for "On this page". */
  headings?: DocHeading[];
  /** Real facts about the page (its source file, …), shown under the article. */
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className='flex w-full min-w-0 flex-1 gap-8 px-4 md:px-6 xl:gap-10'>
      <div className='min-w-0 flex-1 pt-3 pb-16 lg:pt-8'>
        <div className='mb-6 lg:hidden'><DocsMobileNav groups={nav} current={title} /></div>
        <article className='mx-auto w-full max-w-[720px]'>
          <header className='mb-8 border-b pb-6'>
            <h1 className='text-3xl font-bold tracking-tight text-balance sm:text-4xl'>{title}</h1>
            {description && <div className='text-muted-foreground mt-3 text-lg leading-relaxed text-pretty'>{description}</div>}
          </header>

          {children}

          {meta && <div className='text-muted-foreground mt-12 flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-4 text-xs'>{meta}</div>}

        </article>
      </div>

      <aside className={`${STICKY} hidden w-64 shrink-0 py-6 lg:block`}>
        <DocsSidebar groups={nav} />
        {headings.length > 0 && <div className='mt-8'><DocsToc headings={headings} /></div>}
      </aside>
    </div>
  );
}
