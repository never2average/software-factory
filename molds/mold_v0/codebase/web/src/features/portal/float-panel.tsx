// A floating panel of the home page's pinned right column (mold_v0-172): the connection card, a home tab's cards, the
// Due soon card (mold_v0-207). Its own module so a card's module and the page's can both use it without a cycle.
import { cn } from '@/lib/utils';

/** A floating panel for the pinned right column (a home tab's cards too: mold_v0-172). */
export function FloatPanel({ title, icon, description, className, children, action }: { title: string; icon?: React.ReactNode; description?: React.ReactNode; className?: string; children: React.ReactNode; /** Beside the title, at its right (mold_v0-207: View all). */ action?: React.ReactNode }) {
  return (
    <section className={cn('bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-4 shadow-xl shadow-black/30', className)}>
      <div>
        <div className='flex items-center justify-between gap-2'>
          <h2 className='flex items-center gap-2 text-sm font-semibold tracking-tight'>{icon && <span className='text-primary [&_svg]:size-4'>{icon}</span>}{title}</h2>
          {action}
        </div>
        {description && <p className='text-muted-foreground text-xs'>{description}</p>}
      </div>
      {children}
    </section>
  );
}
