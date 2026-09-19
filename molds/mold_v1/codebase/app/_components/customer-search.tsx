"use client";

import { CheckIcon, CircleDotIcon, XIcon } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { DEPLOYMENT_PROFILE, fillProfileText } from "@/lib/deployment-profile.generated";
import { CustomerMark } from "./customer-mark";
import { getCustomerSummary, type CustomerContextSummary } from "./dataroom";

/**
 * A customer in the context selector. Carries the summary fields inline (from the
 * live /api/ops/customers feed) so the row can render tier/stage/status/health
 * without the bundled JSON. Fields are optional so the bundled {id,name} seed
 * still type-checks; when they're absent we fall back to getCustomerSummary.
 */
export interface CustomerListItem {
  id: string;
  name: string;
  tier?: string | null;
  lifecycleStage?: string | null;
  status?: string | null;
  healthScore?: number | null;
  healthReason?: string | null;
  fdeOwner?: string | null;
  openTickets?: number;
  lastTouchDate?: string | null;
  lastTouch?: string | null;
}

/** Color for the progress dot, keyed off the status/stage word. */
function progressColor(value: string | null | undefined): string {
  const v = (value ?? "").toLowerCase();
  if (/live|on track|complete|done/.test(v)) return "text-emerald-500";
  if (/at risk|blocked|stalled|escalat|churn/.test(v)) return "text-red-500";
  if (/in progress|migrat|integrat|configur/.test(v)) return "text-sky-500";
  if (/onboard/.test(v)) return "text-blue-500";
  if (/pilot|poc|trial/.test(v)) return "text-violet-500";
  if (/contract|pricing|legal/.test(v)) return "text-amber-500";
  if (/prospect|lead/.test(v)) return "text-slate-400";
  return "text-muted-foreground";
}

/** Build a summary from the item's live fields; null if it carries none. */
function liveSummary(c: CustomerListItem): CustomerContextSummary | undefined {
  const hasAny =
    c.tier != null ||
    c.lifecycleStage != null ||
    c.status != null ||
    c.healthReason != null ||
    c.fdeOwner != null ||
    c.lastTouchDate != null ||
    (c.openTickets ?? 0) > 0;
  if (!hasAny) return undefined;
  return {
    tier: c.tier ?? undefined,
    lifecycleStage: c.lifecycleStage ?? undefined,
    status: c.status ?? undefined,
    healthScore: c.healthScore ?? undefined,
    healthReason: c.healthReason ?? undefined,
    fdeOwner: c.fdeOwner ?? undefined,
    openTickets: c.openTickets ?? 0,
    lastTouchDate: c.lastTouchDate ?? undefined,
    lastTouch: c.lastTouch ?? undefined,
  };
}

export function CustomerSearchDialog({
  open,
  onOpenChange,
  customers,
  selected,
  onToggle,
  onClear,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly customers: CustomerListItem[];
  readonly selected: string[];
  readonly onToggle: (customer: string) => void;
  readonly onClear: () => void;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.title)}
      description={fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.description)}
      // sm:max-w-* is required: DialogContent ships `sm:max-w-lg`, and
      // tailwind-merge keeps it (different modifier) — a base-only max-width is
      // silently capped at 32rem on every desktop viewport.
      className="w-[min(96vw,64rem)] max-w-[64rem] rounded-2xl border border-white/10 bg-popover shadow-2xl ring-1 ring-white/5 sm:max-w-[64rem]"
    >
      <CommandInput placeholder={fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.placeholder)} />
      <CommandList className="max-h-[70vh]">
        <CommandEmpty>{fillProfileText(DEPLOYMENT_PROFILE.chat.account_search.empty)}</CommandEmpty>
        <CommandGroup>
          {selected.length > 0 ? (
            <CommandItem
              value="__clear all none"
              onSelect={onClear}
              className="gap-2 px-3 py-2 text-muted-foreground text-xs"
            >
              <XIcon className="size-3.5" />
              Clear all ({selected.length})
            </CommandItem>
          ) : null}
          {customers.map((c) => {
            const isSelected = selected.includes(c.name);
            // Prefer the live summary carried on the item; fall back to the
            // bundled JSON for the seed rows that don't carry one.
            const s = liveSummary(c) ?? getCustomerSummary(c.id);
            // ONE leading item, with an icon: the progress (status) if we have
            // it, else the lifecycle stage — not both. The AI summary follows.
            const stageOrProgress = s?.status ?? s?.lifecycleStage ?? null;
            const activity =
              [
                s?.lastTouchDate ? `Last touched ${s.lastTouchDate}` : null,
                s?.fdeOwner ? `FDE ${s.fdeOwner}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || null;
            const summaryText = s?.healthReason ?? activity;
            return (
              <CommandItem
                key={c.id}
                value={`${c.name} ${c.id} ${s?.lifecycleStage ?? ""} ${s?.status ?? ""}`}
                onSelect={() => onToggle(c.name)}
                className="items-start gap-2.5 px-3 py-2"
              >
                {/* Client logo mark */}
                <CustomerMark name={c.name} size="md" className="mt-0.5" />

                {/* Name, then one stage/progress item with an icon + the summary */}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate font-medium text-sm">{c.name}</span>
                  {stageOrProgress || summaryText ? (
                    <p
                      className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
                      title={[stageOrProgress, summaryText].filter(Boolean).join(" · ")}
                    >
                      {stageOrProgress ? (
                        <span className={cn("flex shrink-0 items-center gap-1 font-medium", progressColor(stageOrProgress))}>
                          <CircleDotIcon className="size-2.5" />
                          {stageOrProgress}
                        </span>
                      ) : null}
                      {stageOrProgress && summaryText ? (
                        <span className="shrink-0 text-muted-foreground/40">·</span>
                      ) : null}
                      {summaryText ? <span className="truncate">{summaryText}</span> : null}
                    </p>
                  ) : null}
                </div>

                {/* Selection check */}
                <span
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded border",
                    isSelected
                      ? "border-foreground bg-foreground text-background"
                      : "border-border",
                  )}
                >
                  {isSelected ? <CheckIcon className="size-2.5" /> : null}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
