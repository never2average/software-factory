"use client";

/**
 * Pieces of the Tasks view that only a definition that DECLARES them draws (./task-area-model.ts reads them): the
 * metrics strip under the toolbar, the toast a lifecycle warning or a next occurrence raises, and the question a move
 * that needs a comment asks. The default definition declares no
 * metrics and its writes carry no warnings, so neither renders there.
 */
import { useEffect, useState } from "react";
import { AlertTriangleIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { OpsButton, OpsTextarea } from "./primitives";
import { TYPE } from "./tokens";
import type { TaskMetric } from "./task-area-model";

/**
 * The definition's metrics, one read-out each: its label and value, flagged (`data-attention`, the warning colour and
 * icon) when the definition asks for attention and the value is not zero. Counted over every row of the area.
 */
export function TaskMetricStrip({ metrics }: { readonly metrics: readonly TaskMetric[] }) {
  if (!metrics.length) return null;
  return (
    <div data-testid="task-metrics" className="flex shrink-0 flex-wrap items-center gap-2 border-border/60 border-b px-3 py-2">
      {metrics.map((m) => (
        <span
          key={m.id}
          data-metric={m.id}
          data-attention={m.attention ? "true" : undefined}
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

/**
 * The warnings a write answered with (a lifecycle rule it broke under "warn"): a toast in the corner that announces
 * itself, blocks nothing, and goes on its own after a while or when dismissed.
 */
export function TaskWarningsToast({ warnings, onDismiss }: { readonly warnings: readonly string[]; readonly onDismiss: () => void }) {
  useEffect(() => {
    if (!warnings.length) return;
    const t = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(t);
  }, [warnings, onDismiss]);
  if (!warnings.length) return null;
  return (
    <div
      data-testid="task-warnings"
      role="status"
      aria-live="polite"
      className="pointer-events-auto fixed right-4 bottom-4 z-50 flex max-w-md items-start gap-2 rounded-lg border border-amber-500/40 bg-background/95 px-3 py-2.5 shadow-lg backdrop-blur"
    >
      <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div className={cn("flex min-w-0 flex-1 flex-col gap-1 text-foreground", TYPE.meta)}>
        {warnings.map((w, i) => (
          <p key={i}>{w}</p>
        ))}
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground">
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** A move waiting for its reason: what is moved, from and to (as a person reads them), and by which transition. */
export type PendingMove = { readonly title: string; readonly from: string; readonly to: string; readonly action: string | null };

/**
 * The question a move asks when its transition needs a comment (`requires_comment`): why. The reason goes with the
 * move as the write's `reason`; cancelling sends nothing.
 */
export function MoveReasonDialog({
  move,
  onConfirm,
  onCancel,
}: {
  readonly move: PendingMove | null;
  readonly onConfirm: (reason: string) => void;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [move]);
  const ok = reason.trim().length > 0;
  return (
    <Dialog open={move !== null} onOpenChange={(o) => (o ? null : onCancel())}>
      <DialogContent data-testid="move-reason" showCloseButton={false} className="max-w-md gap-3">
        <DialogTitle className="font-semibold text-[15px]">{move?.action ?? `Move to ${move?.to ?? ""}`}</DialogTitle>
        <DialogDescription className={cn("text-muted-foreground", TYPE.meta)}>
          {move ? `"${move.title}" from ${move.from} to ${move.to} needs a comment saying why.` : null}
        </DialogDescription>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) onConfirm(reason.trim());
          }}
        >
          <OpsTextarea aria-label="Reason" rows={3} autoFocus value={reason} placeholder="Why…" onChange={(e) => setReason(e.target.value)} />
          <div className="flex justify-end gap-2">
            <OpsButton type="button" intent="ghost" onClick={onCancel}>
              Cancel
            </OpsButton>
            <OpsButton type="submit" intent="primary" disabled={!ok}>
              Move
            </OpsButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
