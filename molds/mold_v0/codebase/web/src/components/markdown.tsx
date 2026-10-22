import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Children, isValidElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CodeCopyButton } from '@/components/code-copy-button';

const textOf = (n: ReactNode): string =>
  Children.toArray(n).map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? textOf(c.props.children) : '')).join('');

/** A heading's text as an anchor id, e.g. "Reading the Pick rate page" -> "reading-the-pick-rate-page". */
export function anchorId(node: ReactNode): string {
  return textOf(node).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** A heading with its anchor id and a link to itself that shows on hover (or keyboard focus). */
function anchored(Tag: 'h2' | 'h3', className: string): Components['h2'] {
  return function Heading({ node: _n, children, ...p }) {
    const id = anchorId(children);
    return (
      <Tag id={id} className={cn('group/heading relative scroll-mt-24', className)} {...p}>
        {children}
        <a href={`#${id}`} aria-label='Link to this section'
          className='text-muted-foreground/70 hover:text-primary ml-2 inline-block font-normal no-underline opacity-0 transition-opacity group-hover/heading:opacity-100 focus-visible:opacity-100'>#</a>
      </Tag>
    );
  };
}

/** The language of a fenced block (```ts), from the `language-*` class remark gives its code element. */
const languageOf = (children: ReactNode) => {
  const first = Children.toArray(children)[0];
  const c = isValidElement<{ className?: string }>(first) ? first.props.className ?? '' : '';
  return c.match(/language-([\w+-]+)/)?.[1] ?? '';
};

const LINK = 'text-primary decoration-primary/40 hover:decoration-primary font-medium underline underline-offset-4 transition-colors';

/** Every element but links: they don't depend on the page. */
const ELEMENTS: Components = {
  h1: ({ node: _n, children, ...p }) => <h1 className='mt-2 mb-4 text-3xl font-bold tracking-tight' {...p}>{children}</h1>,
  h2: anchored('h2', 'mt-12 mb-4 border-b pb-2 text-2xl font-semibold tracking-tight first:mt-0'),
  h3: anchored('h3', 'mt-8 mb-3 text-lg font-semibold tracking-tight'),
  h4: ({ node: _n, children, ...p }) => <h4 className='mt-6 mb-2 text-base font-semibold' {...p}>{children}</h4>,
  p: ({ node: _n, ...p }) => <p className='my-4 leading-7' {...p} />,
  ul: ({ node: _n, ...p }) => <ul className='marker:text-muted-foreground my-4 ml-6 list-disc space-y-2 [&_ol]:my-2 [&_ul]:my-2' {...p} />,
  ol: ({ node: _n, ...p }) => <ol className='marker:text-muted-foreground my-4 ml-6 list-decimal space-y-2 [&_ol]:my-2 [&_ul]:my-2' {...p} />,
  li: ({ node: _n, ...p }) => <li className='pl-1 leading-7 [&>p]:my-1' {...p} />,
  blockquote: ({ node: _n, ...p }) => (
    <blockquote className='border-primary/60 bg-muted/40 text-foreground/90 my-6 rounded-r-lg border-l-4 px-4 py-1 [&>p]:my-2.5' {...p} />
  ),
  hr: () => <hr className='my-10' />,
  strong: ({ node: _n, ...p }) => <strong className='text-foreground font-semibold' {...p} />,
  pre: ({ node: _n, children, ...p }) => {
    const lang = languageOf(children);
    return (
      <div data-code-block className='bg-muted/40 relative my-6 overflow-hidden rounded-lg border'>
        <div className='flex h-9 items-center justify-between border-b px-3'>
          <span className='text-muted-foreground font-mono text-xs'>{lang || 'code'}</span>
          <CodeCopyButton className='-mr-1.5' />
        </div>
        <pre tabIndex={0} className='focus-visible:ring-ring/50 overflow-x-auto p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-inset font-mono text-[13px] leading-relaxed [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]' {...p}>{children}</pre>
      </div>
    );
  },
  code: ({ node: _n, className: c, ...p }) => <code className={cn('bg-muted rounded-md border px-1.5 py-0.5 font-mono text-[0.85em] break-words', c)} {...p} />,
  // A wide table scrolls inside its frame, which takes keyboard focus so it can be scrolled without a pointer (axe
  // `scrollable-region-focusable`).
  table: ({ node: _n, ...p }) => (
    <div tabIndex={0} className='focus-visible:ring-ring/50 my-6 w-full overflow-x-auto rounded-lg border outline-none focus-visible:ring-[3px]'>
      <table className='w-full border-collapse text-sm' {...p} />
    </div>
  ),
  thead: ({ node: _n, ...p }) => <thead className='bg-muted/60' {...p} />,
  tbody: ({ node: _n, ...p }) => <tbody className='[&>tr:nth-child(even)]:bg-muted/25' {...p} />,
  tr: ({ node: _n, ...p }) => <tr className='border-b last:border-0' {...p} />,
  th: ({ node: _n, ...p }) => <th className='border-r px-3 py-2 text-left align-bottom font-semibold whitespace-nowrap last:border-r-0' {...p} />,
  td: ({ node: _n, ...p }) => <td className='border-r px-3 py-2 align-top leading-6 last:border-r-0 [&_code]:whitespace-nowrap' {...p} />
};

/**
 * Markdown as a readable page, styled with the app's own tokens (no typography plugin). Raw HTML in the source shows
 * as text. `resolveHref` maps a link to an in-app URL; returning null renders the link's text only (a repo path that
 * does not exist in the app).
 */
export function Markdown({ children, resolveHref, className }: { children: string; resolveHref?: (href: string) => string | null; className?: string }) {
  const components: Components = {
    ...ELEMENTS,
    a: ({ node: _n, href = '', children: c, ...p }) => {
      const external = /^[a-z][a-z0-9+.-]*:/i.test(href);
      if (external) return <a href={href} target='_blank' rel='noopener noreferrer' className={LINK} {...p}>{c}</a>;
      if (href.startsWith('#')) return <a href={href} className={LINK} {...p}>{c}</a>;
      const to = resolveHref ? resolveHref(href) : href;
      return to ? <Link href={to} className={LINK}>{c}</Link> : <span className='font-medium'>{c}</span>;
    }
  };
  return (
    <div className={cn('text-foreground max-w-3xl text-[15px] break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{children}</ReactMarkdown>
    </div>
  );
}
