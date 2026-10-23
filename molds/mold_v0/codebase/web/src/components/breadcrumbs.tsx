'use client';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from '@/components/ui/breadcrumb';
import { useBreadcrumbs } from '@/hooks/use-breadcrumbs';
import { Icons } from '@/components/icons';

export function Breadcrumbs() {
  const items = useBreadcrumbs();
  if (items.length === 0) return null;

  // Every child of the list is an item (axe `list`): the earlier crumbs (from tablet width up) are a link and a
  // separator in one item; the current page is its own item.
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {items.map((item, index) =>
          index < items.length - 1 ? (
            <BreadcrumbItem key={item.link} className='hidden md:inline-flex'>
              <BreadcrumbLink href={item.link}>{item.title}</BreadcrumbLink>
              <BreadcrumbSeparator className='ml-0.5'>
                <Icons.slash />
              </BreadcrumbSeparator>
            </BreadcrumbItem>
          ) : (
            <BreadcrumbItem key={item.link}>
              <BreadcrumbPage>{item.title}</BreadcrumbPage>
            </BreadcrumbItem>
          )
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
