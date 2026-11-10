import { cn } from '@/lib/utils';
import React from 'react';
import type { InfobarContent } from '@/components/ui/infobar';

function PageSkeleton() {
  return (
    <div
      role='status'
      aria-label='Loading page'
      className='flex flex-1 animate-pulse flex-col gap-4 p-4 md:px-6'
    >
      <div className='flex items-center justify-between'>
        <div>
          <div className='bg-muted mb-2 h-8 w-48 rounded' />
          <div className='bg-muted h-4 w-96 rounded' />
        </div>
      </div>
      <div className='bg-muted mt-6 h-40 w-full rounded-lg' />
      <div className='bg-muted h-40 w-full rounded-lg' />
    </div>
  );
}

export interface PageContainerProps {
  children: React.ReactNode;
  isLoading?: boolean;
  access?: boolean;
  accessFallback?: React.ReactNode;
  pageTitle?: string;
  pageDescription?: string;
  infoContent?: InfobarContent;
  pageHeaderAction?: React.ReactNode;
  /** Smaller outer margins (a page that fills the screen, as the Overview). */
  compact?: boolean;
}

/**
 * A page's frame, or none when the page is drawn as an in-page tab of another (mold_v0-281: a staff Records entry of
 * in-page tabs draws each member's own page body below its strip, inside its own frame).
 */
export function PageFrame({ bare = false, ...props }: PageContainerProps & { bare?: boolean }) {
  return bare ? <>{props.children}</> : <PageContainer {...props} />;
}

export default function PageContainer({
  children,
  isLoading = false,
  access = true,
  accessFallback,
  pageTitle,
  pageDescription,
  infoContent,
  pageHeaderAction,
  compact
}: PageContainerProps) {
  if (!access) {
    return (
      <div role='status' className='flex flex-1 items-center justify-center p-4 md:px-6'>
        {accessFallback ?? (
          <div className='text-muted-foreground text-center text-lg'>
            You do not have access to this page.
          </div>
        )}
      </div>
    );
  }

  const content = isLoading ? <PageSkeleton /> : children;

  // No visible title or description above a page (operator rule, mold_v0-272): the page's name stays for screen
  // readers and the breadcrumb says where you are; actions keep their own row.
  return (
    <div className={cn('flex min-w-0 w-full flex-1 flex-col', compact ? 'px-2 pt-1 pb-2 md:px-3 md:pt-2' : 'px-4 pt-2 pb-4 md:px-6 md:pt-4')}>
      {pageTitle && <h1 className='sr-only'>{pageTitle}</h1>}
      {pageHeaderAction && <div className='mb-4 flex min-w-0 justify-end [&>div]:flex-wrap'>{pageHeaderAction}</div>}
      {content}
    </div>
  );
}
