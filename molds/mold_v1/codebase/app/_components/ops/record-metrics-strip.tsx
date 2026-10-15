"use client";

/**
 * An area's declared metrics (records.areas.<area>.metrics), one read-out each: its label and value, flagged
 * (`data-attention`, the warning colour and icon) when the definition asks for attention and the value is not zero.
 * The same look as the tasks view's strip. The values are counted by the server (agent/lib/record-metrics.ts, GET
 * /api/ops/record-metrics), never from the rows the browser happens to hold.
 */
import { AlertTriangleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RecordMetric } from "@/agent/lib/record-metrics";
import { TYPE } from "./tokens";

export function RecordMetricStrip({ metrics }: { readonly metrics: readonly RecordMetric[] }) {
  if (!metrics.length) return null;
  return (
    <div data-testid="record-metrics" className="flex shrink-0 flex-wrap items-center gap-2 border-border/60 border-b px-3 py-2">
      {metrics.map((m) => (
        <span
          key={m.id}
          data-metric={m.id}
          data-value={m.value ?? undefined}
          data-attention={m.attention ? "true" : undefined}
          title={m.error}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 font-medium",
            TYPE.meta,
            m.attention ? "border-red-500/40 text-red-400" : "border-border/60 text-muted-foreground",
          )}
        >
          {m.attention ? <AlertTriangleIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
          <span>{m.label}</span>
          <span className={cn("rounded-md px-1.5 tabular-nums", m.attention ? "bg-red-500/15" : "bg-muted")}>{m.text}</span>
        </span>
      ))}
    </div>
  );
}
