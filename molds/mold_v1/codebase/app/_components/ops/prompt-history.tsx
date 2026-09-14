"use client";

/**
 * An agent's prompt history.
 *
 * The prompt is the agent's behaviour, so a change to it deserves the same
 * treatment as a change to the data room: who, when, and exactly what moved.
 * It reuses the changeset diff viewer rather than growing a second one — a
 * prompt version is one file's before/after, which is precisely what that
 * component renders.
 */

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HistoryIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { opsFetch } from "./lib";
import { SURFACE, TYPE } from "./tokens";
import { ChangesetDiffView } from "./diff-view";

interface PromptVersion {
  id: string;
  instructions: string | null;
  actor: string;
  kind: string;
  restoredFrom: string | null;
  createdAt: string;
  before: string | null;
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function PromptHistoryButton({
  agentKey,
  agentName,
  onRestored,
}: {
  readonly agentKey: string;
  readonly agentName: string;
  /** Handed the restored text, so the open editor shows it immediately. */
  readonly onRestored: (instructions: string | null) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Prompt history"
        aria-label="Prompt history"
        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <HistoryIcon className="size-3.5" />
      </button>
      {open && (
        <PromptHistoryDialog
          agentKey={agentKey}
          agentName={agentName}
          onClose={() => setOpen(false)}
          onRestored={onRestored}
        />
      )}
    </>
  );
}

function PromptHistoryDialog({
  agentKey,
  agentName,
  onClose,
  onRestored,
}: {
  readonly agentKey: string;
  readonly agentName: string;
  readonly onClose: () => void;
  readonly onRestored: (instructions: string | null) => Promise<void> | void;
}) {
  const [items, setItems] = useState<PromptVersion[] | null>(null);
  const [canRestore, setCanRestore] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await opsFetch<{ items: PromptVersion[]; canRestore?: boolean }>(
        `/api/ops/agent-configs/history?agentKey=${encodeURIComponent(agentKey)}`,
      );
      setItems(d.items);
      setCanRestore(Boolean(d.canRestore));
      setSelected((cur) => cur ?? d.items[0]?.id ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [agentKey]);
  useEffect(() => {
    void load();
  }, [load]);

  const current = items?.find((v) => v.id === selected) ?? null;

  async function restore(versionId: string) {
    setBusy(true);
    setError(null);
    try {
      const d = await opsFetch<{ instructions: string | null }>("/api/ops/agent-configs/history", {
        method: "POST",
        body: JSON.stringify({ agentKey, versionId }),
      });
      await onRestored(d.instructions ?? null);
      await load();
      // The restore is itself the newest version now, so land the reader on it
      // rather than leaving them looking at a version that is no longer old.
      setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="flex h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[70vw]"
        showCloseButton
      >
        <DialogHeader className="space-y-0 border-border/70 border-b px-5 py-3.5 text-left">
          <DialogTitle className="text-sm leading-tight">Prompt history — {agentName}</DialogTitle>
        </DialogHeader>

        {error && (
          <div className="border-destructive/40 border-b bg-destructive/10 px-5 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* Versions, newest first. */}
          <div className="w-64 shrink-0 overflow-auto border-border/70 border-r py-1">
            {items === null ? (
              <p className={cn("px-4 py-3 text-muted-foreground", TYPE.meta)}>Loading…</p>
            ) : items.length === 0 ? (
              <p className={cn("px-4 py-3 text-muted-foreground", TYPE.meta)}>
                No prompt has been set for this agent yet.
              </p>
            ) : (
              items.map((v, i) => {
                const active = v.id === selected;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelected(v.id)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition-colors",
                      active ? "bg-primary/[0.08]" : "hover:bg-muted/40",
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className={cn("flex-1 truncate font-medium", TYPE.body)}>
                        {i === 0 ? "Current" : `Version ${items.length - i}`}
                      </span>
                      {v.kind === "restore" && (
                        <span className={cn(SURFACE.chip, "shrink-0 text-muted-foreground", TYPE.micro)}>
                          restored
                        </span>
                      )}
                    </span>
                    <span className={cn("w-full truncate text-muted-foreground", TYPE.micro)}>
                      {fmt(v.createdAt)}
                    </span>
                    <span className={cn("w-full truncate text-muted-foreground", TYPE.micro)}>
                      {v.actor}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* What that change did. */}
          <div className="min-w-0 flex-1 overflow-auto p-4">
            {current === null ? (
              <p className={cn("text-muted-foreground", TYPE.meta)}>
                {items === null ? "" : "Select a version."}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {/* The row survives for the action; its caption is gone — the
                    sidebar already names the author and the timestamp. */}
                <div className="flex items-center justify-end gap-3 empty:hidden">
                  {canRestore && current.id !== items?.[0]?.id && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void restore(current.id)}
                    >
                      <RotateCcwIcon className="size-3.5" />
                      {busy ? "Restoring…" : "Restore this version"}
                    </Button>
                  )}
                </div>
                <ChangesetDiffView
                  showPaths={false}
                  files={[
                    {
                      path: `${agentKey} — custom instructions`,
                      action: "update",
                      before: current.before,
                      after: current.instructions,
                    },
                  ]}
                />
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
