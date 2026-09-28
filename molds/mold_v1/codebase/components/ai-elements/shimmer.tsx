"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo, useMemo } from "react";

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

/**
 * A sweep of light across the text ("Thinking..."). This was a `motion` component, which put the whole of motion
 * (~40 KB brotli) into the first load of every chat page to animate one background-position; a CSS keyframe
 * (`shimmer-sweep`, app/globals.css) draws the same thing: 100% → 0%, linear, forever.
 */
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  return (
    <Component
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className,
      )}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
          backgroundPosition: "100% center",
          animation: `shimmer-sweep ${duration}s linear infinite`,
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
