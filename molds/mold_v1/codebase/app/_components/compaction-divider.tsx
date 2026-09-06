"use client";

/**
 * The inline "context compacted" divider shown in the transcript — a horizontal
 * rule with a centered label. Auto-compaction (eve's own, from
 * `compaction.completed` events) and manual compaction (the context ring's
 * click) both render this, so a long thread reads as one continuous
 * conversation with clear compaction checkpoints instead of a jarring fork.
 */

import { cn } from "@/lib/utils";

export function CompactionDivider({
  kind,
}: {
  /** "compacting" = in progress (spinner); "manual"/"auto" = a done checkpoint. */
  readonly kind: "compacting" | "manual" | "auto";
}) {
  const label =
    kind === "compacting"
      ? "Compacting context"
      : kind === "manual"
        ? "Context manually compacted"
        : "Context automatically compacted";
  return (
    <div className="not-prose my-2 flex w-full items-center gap-3 text-muted-foreground/70">
      <span className="h-px flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-2 text-xs">
        {kind === "compacting" ? (
          <span className="size-3 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-muted-foreground" />
        ) : null}
        {label}
        {kind === "compacting" ? <span className="animate-pulse">…</span> : null}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
