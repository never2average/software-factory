"use client";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { exceedsFold, foldHeight, lineHeightPx } from "@/lib/chat-collapse";
import { DEPLOYMENT_PROFILE } from "@/lib/deployment-profile.generated";
import { cn } from "@/lib/utils";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The text of a message a PERSON sent, folded when it is long.
 *
 * A pasted filing or table is the person's own words — they do not need to
 * re-read it, and at full height it pushes the reply it asked for off screen.
 * So it starts folded to `chat.user_messages.collapsed_lines` lines (deployment
 * profile) with a "Show more" button; short messages are untouched and get no
 * control. Only the TEXT folds: attachment chips sit outside this component.
 *
 * - Expanding is per message and sticks for as long as the message is mounted.
 * - Nothing here looks at turn state, so the control works while the reply to
 *   this very message is streaming — which is when the fold matters most.
 * - The fade is painted in the bubble's own colour (`--primary`), not the page
 *   background: this only ever renders inside the primary-coloured user bubble
 *   (components/ai-elements/message.tsx), in light and dark alike.
 */
export function CollapsibleUserText({ children }: { readonly children: ReactNode }) {
  const { collapse, collapsed_lines: lines } = DEPLOYMENT_PROFILE.chat.user_messages;
  const regionId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fold, setFold] = useState<number | null>(null); // px; null = fits, no control

  useIsoLayoutEffect(() => {
    const el = contentRef.current;
    if (!collapse || !el) return;
    const measure = () => {
      const cs = window.getComputedStyle(el);
      const lh = lineHeightPx(cs.lineHeight, cs.fontSize);
      // The inner element is never clamped, so this is the full rendered height.
      setFold(exceedsFold(el.scrollHeight, lh, lines) ? foldHeight(lh, lines) : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Re-measure on width changes (rail opening, window resize) and late layout
    // (fonts, highlighted code, tables).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapse, lines]);

  if (!collapse) return <>{children}</>;
  const folded = fold !== null && !expanded;

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-folded={folded ? "true" : undefined}>
      <div
        id={regionId}
        className={cn("relative min-w-0", folded && "overflow-hidden")}
        style={folded ? { maxHeight: fold } : undefined}
      >
        <div ref={contentRef} className="min-w-0">
          {children}
        </div>
        {folded ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-primary to-transparent"
          />
        ) : null}
      </div>
      {fold !== null ? (
        <button
          type="button"
          aria-controls={regionId}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            "inline-flex w-fit items-center gap-1 self-start rounded-md px-1.5 py-0.5 font-medium text-xs",
            "-ml-1.5 text-primary-foreground/85 hover:bg-primary-foreground/15 hover:text-primary-foreground",
            "focus-visible:outline-2 focus-visible:outline-primary-foreground focus-visible:outline-offset-1",
          )}
        >
          {expanded ? <ChevronUpIcon className="size-3.5" aria-hidden="true" /> : <ChevronDownIcon className="size-3.5" aria-hidden="true" />}
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
