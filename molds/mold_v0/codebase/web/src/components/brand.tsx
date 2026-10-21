import Link from 'next/link';
import { profile } from '@/config/profile.generated';
import { cn } from '@/lib/utils';

/**
 * The build's mark and name (mold_v0-039): its icon (web/src/app/icon.svg, which the factory's brand step replaces with
 * the app's own) and the profile's name. No product's mark or name is written here.
 */
export function BrandMark({ className }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- a fixed, local SVG: the brand's icon as it is
  return <img src='/icon.svg' alt='' aria-hidden='true' className={cn('size-7 rounded-md', className)} />;
}

export function BrandLogo({ className }: { className?: string }) {
  return (
    <Link href='/' className={cn('flex items-center gap-2 font-semibold tracking-tight', className)} aria-label={`${profile.name} home`}>
      <BrandMark />
      <span>{profile.name}</span>
    </Link>
  );
}
