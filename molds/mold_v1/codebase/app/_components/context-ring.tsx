"use client";

/**
 * A circular gauge of how full the model's context window is, shown next to the
 * send button. The fill = current prompt tokens / context window (derived from
 * the latest `step.completed` usage — see agent-chat). eve auto-compacts as it
 * nears the limit; this makes that visible, and CLICKING it compacts NOW
 * (summarize the thread and continue in a fresh, shorter one).
 */

import { FoldVerticalIcon } from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

export function ContextRing({
  tokens,
  windowSize,
  breakdown,
  onCompact,
  busy,
}: {
  readonly tokens: number;
  readonly windowSize: number;
  /** Quantitative split of the context: `cached` = prior conversation replayed
   *  from cache, `fresh` = this turn's new prompt tokens. */
  readonly breakdown?: { cached: number; fresh: number };
  /** Compact now — summarize this thread in place. */
  readonly onCompact?: () => void;
  /** A turn is in flight (compaction disabled). */
  readonly busy?: boolean;
}) {
  const fraction = Math.max(0, Math.min(1, windowSize > 0 ? tokens / windowSize : 0));
  const pct = Math.round(fraction * 100);
  const R = 9;
  const CIRC = 2 * Math.PI * R;
  const level = fraction >= 0.9 ? "high" : fraction >= 0.7 ? "med" : "low";
  // Explicit class strings (never built by string-manipulation) so Tailwind's
  // compiler keeps them in the bundle.
  const stroke = level === "high" ? "stroke-red-500" : level === "med" ? "stroke-amber-500" : "stroke-emerald-500";
  const bar = level === "high" ? "bg-red-500" : level === "med" ? "bg-amber-500" : "bg-emerald-500";
  // Breakdown dots MATCH the progress-bar color: solid for cached, translucent
  // for the latest turn, outline for free.
  const barMuted = level === "high" ? "bg-red-500/40" : level === "med" ? "bg-amber-500/40" : "bg-emerald-500/40";
  const canCompact = Boolean(onCompact) && !busy;

  return (
    <HoverCard openDelay={120} closeDelay={60}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onCompact}
          disabled={!canCompact}
          aria-label={`Context ${pct}% full${canCompact ? " — click to compact" : ""}`}
          className={cn(
            "grid size-8 place-items-center rounded-full transition-colors",
            canCompact ? "hover:bg-muted" : "cursor-default",
          )}
        >
          <svg viewBox="0 0 24 24" className="size-6 -rotate-90">
            <circle cx="12" cy="12" r={R} fill="none" strokeWidth="2.5" className="stroke-muted-foreground/20" />
            <circle
              cx="12"
              cy="12"
              r={R}
              fill="none"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - fraction)}
              className={cn("transition-[stroke-dashoffset] duration-500", stroke)}
            />
          </svg>
        </button>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" sideOffset={8} className="w-72 p-0">
        {/* No "CONTEXT WINDOW" caption: the ring you hovered to get here already
            said that, and a title restating the control is a line of noise in a
            popover this small. The bar and the breakdown carry the meaning. */}
        <div className="px-3.5 pt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", bar)}
              style={{ width: `${Math.max(2, pct)}%` }}
            />
          </div>
        </div>
        {breakdown ? (
          <div className="mt-3 space-y-1 px-3.5 text-xs tabular-nums">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", bar)} /> Conversation (cached)
              </span>
              <span className="font-medium">{fmtTokens(breakdown.cached)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className={cn("size-1.5 rounded-full", barMuted)} /> Latest turn (new)
              </span>
              <span className="font-medium">{fmtTokens(breakdown.fresh)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="size-1.5 rounded-full border border-muted-foreground/40" /> Free
              </span>
              <span className="font-medium">{fmtTokens(Math.max(0, windowSize - tokens))}</span>
            </div>
          </div>
        ) : null}
        {onCompact ? (
          <button
            type="button"
            onClick={onCompact}
            disabled={!canCompact}
            className="mt-3 flex w-full items-center gap-2 border-t border-border px-3.5 py-2.5 text-left text-xs font-medium transition-colors enabled:hover:bg-muted disabled:opacity-60"
          >
            <FoldVerticalIcon className="size-4 shrink-0 text-muted-foreground" />
            Compact conversation
          </button>
        ) : (
          <div className="mt-2 border-t border-border px-3.5 py-2.5 text-xs text-muted-foreground">
            Compacts automatically as it approaches the limit.
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
