"use client";

/**
 * Ops Center — the modal shell. The three sections live in
 * app/_components/ops/{connectors,workflows,crons}-panel.tsx, built on the
 * design system in app/_components/ops/{tokens.ts,primitives.tsx,detail.tsx}
 * (see app/_components/ops/README.md).
 */

import { useCallback, useEffect, useState } from "react";
import { XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AppsPanel } from "./ops/apps-panel";
import { InboxPanel } from "./ops/inbox-panel";
import { TodosPanel } from "./ops/todos-panel";
import { ConnectorsPanel } from "./ops/connectors-panel";
import { CronsPanel } from "./ops/crons-panel";
import { SECTION_META, type OpsSection } from "./ops/lib";
import { WorkflowsPanel } from "./ops/workflows-panel";
import { SURFACE } from "./ops/tokens";
import type { TodoViewKey } from "@/lib/work-periods-ui";

export { OPS_SECTIONS } from "./ops/lib";
export type { OpsSection } from "./ops/lib";

export function OpsCenter({
  open,
  onOpenChange,
  section,
  authorEmail,
  initialSelectedId,
  initialView,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly section: OpsSection;
  readonly authorEmail?: string;
  // Deep-link (`/?ops=<section>&id=<id>`): the row to select and open when
  // the modal first shows. For crons this may be a system cron NAME.
  readonly initialSelectedId?: string;
  // Deep-link (`&view=<tab>`) for the TODOs workspace's tab.
  readonly initialView?: TodoViewKey;
}) {
  const meta = SECTION_META[section];

  // The deep-linked row is applied exactly once: the panel that consumes it
  // clears it here, so switching sections (or reopening the modal) afterwards
  // does not re-select it.
  const [pendingInitialId, setPendingInitialId] = useState(initialSelectedId);
  useEffect(() => {
    setPendingInitialId(initialSelectedId);
  }, [initialSelectedId]);
  const consumeInitial = useCallback(() => setPendingInitialId(undefined), []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Escape belongs to the INNERMOST thing that is open. Radix portals a
        // dropdown outside this dialog, so the dialog cannot see that a menu owns
        // the key and would close the entire Ops Center behind it — which is
        // exactly what it did: one Escape to dismiss a row menu took the whole
        // modal down. The modal only takes Escape when nothing inside it wants it.
        onEscapeKeyDown={(e) => {
          const innerLayerOpen =
            document.querySelector('[role="menu"][data-state="open"]') ??
            document.querySelector("aside[aria-label='Details']");
          if (innerLayerOpen) e.preventDefault();
        }}
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0",
          // TODOs is a full workspace (its own side-nav) → 98% of the screen.
          section === "todos"
            ? "h-[98vh] max-h-[98vh] w-[98vw] max-w-[98vw] sm:max-w-[98vw]"
            : "h-[88vh] max-h-[88vh] w-[97vw] max-w-[min(97vw,1500px)] sm:max-w-[min(97vw,1500px)]",
          SURFACE.modal,
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{meta.title}</DialogTitle>
          <DialogDescription>{meta.blurb}</DialogDescription>
        </DialogHeader>

        {/*
          One dismiss for the whole modal.
          
          showCloseButton is false because Radix's default X sits at the very
          corner and collides with each panel's own detail-panel close. But that
          left NO visible way out — only Escape, which is not discoverable and
          which this dialog deliberately yields to whatever is open inside it.
          This sits above the panel content and always closes the Ops Center.
        */}
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          title="Close (Esc)"
          className="absolute right-3 top-3 z-30 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
        {section === "connectors" ? (
          <ConnectorsPanel
            authorEmail={authorEmail}
            initialSelectedId={pendingInitialId}
            onInitialConsumed={consumeInitial}
          />
        ) : null}
        {section === "workflows" ? (
          <WorkflowsPanel
            authorEmail={authorEmail}
            initialSelectedId={pendingInitialId}
            onInitialConsumed={consumeInitial}
          />
        ) : null}
        {section === "inbox" ? <InboxPanel authorEmail={authorEmail} /> : null}
        {section === "crons" ? (
          <CronsPanel
            authorEmail={authorEmail}
            initialSelectedId={pendingInitialId}
            onInitialConsumed={consumeInitial}
          />
        ) : null}
        {section === "apps" ? (
          <AppsPanel
            authorEmail={authorEmail}
            initialSelectedId={pendingInitialId}
            onInitialConsumed={consumeInitial}
          />
        ) : null}
        {section === "todos" ? (
          <TodosPanel
            authorEmail={authorEmail}
            onClose={() => onOpenChange(false)}
            initialSelectedId={pendingInitialId}
            initialView={initialView}
            onInitialConsumed={consumeInitial}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
