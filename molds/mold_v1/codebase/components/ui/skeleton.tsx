import type { ComponentProps, CSSProperties, ElementType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * LOADING KEEPS WHAT IS KNOWN (mold_v1-269). While a thing loads, everything already known about it (a specialist's
 * name, its status chip, the card's frame, a title) renders at once, and only the parts still to come render as
 * these: shapes of the content that will arrive, with a light sweeping across them (`skeleton-shimmer`,
 * app/globals.css). The real content replaces them once, when it has all arrived: no flash of raw text, no jump, no
 * bare spinner beside a "Loading…" sentence. A busy button keeps its small inline spinner; that is not a load.
 *
 * Under prefers-reduced-motion the sweep stops: a still, muted block.
 */

/** One block of content still to come. Decorative: the `Loading` around it is what a screen reader hears. */
export function Skeleton({ className, ...props }: ComponentProps<"span">) {
  return <span aria-hidden data-skeleton className={cn("skeleton-shimmer block h-3.5 rounded", className)} {...props} />;
}

/**
 * Lines of text still to come, at the widths given. Fixed widths, never random: a random width per render makes the
 * skeleton twitch on every re-render, which is worse than a still one.
 */
export function SkeletonLines({
  widths,
  className,
  lineClassName,
}: {
  readonly widths: readonly (number | string)[];
  readonly className?: string;
  readonly lineClassName?: string;
}) {
  return (
    <span aria-hidden className={cn("flex flex-col gap-2", className)}>
      {widths.map((w, i) => (
        <Skeleton
          key={i}
          className={lineClassName}
          style={{ width: typeof w === "number" ? `${w}%` : w, animationDelay: `${i * 70}ms` } as CSSProperties}
        />
      ))}
    </span>
  );
}

/**
 * The part of the screen that is loading: `role="status"`, named by `label` ("Loading transcript"), the label also
 * in visually hidden text, so a screen reader still hears that it is loading while the eye sees only shapes.
 * `children` are the shapes (Skeleton, SkeletonLines); `as="span"` inside a line of text or a table cell.
 */
export function Loading({
  label,
  as: Component = "div",
  className,
  children,
  ...props
}: {
  readonly label: string;
  readonly as?: ElementType;
  readonly className?: string;
  readonly children: ReactNode;
} & Omit<ComponentProps<"div">, "children" | "className">) {
  return (
    <Component role="status" aria-busy="true" aria-label={label} data-loading className={className} {...props}>
      <span className="sr-only">{label}</span>
      {children}
    </Component>
  );
}
