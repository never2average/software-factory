// A cell of the home page's flat grid (mold_v0-214, replacing mold_v0-172's floating panel): the connection card, a home
// tab's rail cards, the Due soon card (mold_v0-207). Flat: no shadow, no rounded card, no border of its own; the grid that
// holds it draws the shared 1px lines (the console's `grid border-t border-l` and `border-r border-b` cells). Its own
// module so a card's module and the page's can both use it without a cycle.
import { cn } from '@/lib/utils';

/** A titled cell of the home page's grid: its padding and heading; the lines are the grid's. */
export function GridCell({ id, title, icon, description, className, children, action }: { /** An anchor to link to (mold_v0-298: /app#connect). */ id?: string; title: string; icon?: React.ReactNode; description?: React.ReactNode; className?: string; children: React.ReactNode; /** Beside the title, at its right (mold_v0-207: View all). */ action?: React.ReactNode }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3 p-4', className)} id={id}>
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
