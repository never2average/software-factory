import Link from 'next/link';
import { cn } from '@/lib/utils';

/** The Octillion mark, identical to app/icon.svg: a green octagon on a dark tile, with a hairline edge so the tile reads on dark pages. */
export function OctillionMark({ className }: { className?: string }) {
  return (
    <svg viewBox='0 0 32 32' aria-hidden='true' className={cn('size-7', className)}>
      <rect x='0.5' y='0.5' width='31' height='31' rx='6.5' fill='#1c1c1c' stroke='rgb(255 255 255 / 0.14)' />
      <path d='M16 6.5 22.7 9.3 25.5 16 22.7 22.7 16 25.5 9.3 22.7 6.5 16 9.3 9.3Z' fill='none' stroke='#3ecf8e' strokeWidth='3' strokeLinejoin='round' />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link href='/' className={cn('flex items-center gap-2 font-semibold tracking-tight', className)} aria-label='Octillion home'>
      <OctillionMark />
      <span>Octillion</span>
    </Link>
  );
}
