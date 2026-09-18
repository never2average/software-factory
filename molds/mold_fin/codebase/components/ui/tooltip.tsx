"use client";

import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

/**
 * Two shapes, because a tooltip carries two different kinds of thing:
 *
 * - "chip" (default): the inverted one-liner — a label for a control. Its ground
 *   is `bg-foreground`, so any text inside it must be `text-background`.
 * - "panel": a small popover — structured content with its own hierarchy (a
 *   heading, a list, muted subtext, a coloured warning). Those colours are all
 *   defined against a NORMAL ground, so they are unreadable on the inverted one.
 *   `text-balance` also has to go: it centre-rags every line, which reads as
 *   broken indentation the moment the content is a list rather than a sentence.
 *
 * The arrow is part of this: it lives inside the component, so a caller cannot
 * recolour it from the outside and a panel with a chip's arrow shows a bright
 * diamond hanging off a dark card.
 */
function TooltipContent({
  className,
  sideOffset = 0,
  variant = "chip",
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & {
  readonly variant?: "chip" | "panel";
}) {
  const panel = variant === "panel";
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          panel
            ? "rounded-lg border border-border bg-popover text-left text-popover-foreground shadow-md"
            : "bg-foreground px-3 py-1.5 text-xs text-balance text-background",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className={cn(
            "z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]",
            panel ? "border-border bg-popover fill-popover" : "bg-foreground fill-foreground",
          )}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
