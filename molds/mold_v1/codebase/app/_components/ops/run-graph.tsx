"use client";

/**
 * Workflow run monitor: a PHASES rail on the left, and the subagents that ran
 * inside the selected phase on the right — so a `parallel()` fan-out of 24
 * agents reads as a scannable list instead of a cramped column of nodes.
 * Clicking an agent opens its subagent panel (prompt, result, steer, open-as-chat).
 *
 * Two data sources, deliberately split (see plan-workflow-visualization.md):
 *   - SKELETON from `analyzeWorkflowScript()` (server-only, arrives via
 *     GET /api/ops/workflows/:id) — the phases and their planned steps, so the
 *     shape is visible before a single checkpoint lands.
 *   - LIFE from the run journal — status, subagent, prompt, session ids.
 *
 * Attribution is the hard part: the journal is a flat, ordered list of calls
 * with no phase tag (that needs the Phase-2 migration), and a `parallel()` step
 * expands to an unknown number of calls. So we bind by ORDINAL — see
 * `attributeCalls`, which is exact for static scripts and degrades sanely
 * (rather than lying) for dynamic ones.
 */
import { useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { RunStatusDot } from "./detail";
import type { RunJournalEntry } from "./run-timeline";
import { TYPE } from "./tokens";

export type GraphPhase = { title: string; steps: { kind: string; label: string; line: number }[] };

/** Minimum number of agent calls a phase must account for. */
function minCalls(p: GraphPhase): number {
  const singles = p.steps.filter((s) => s.kind === "agent").length;
  const groups = p.steps.filter((s) => s.kind !== "agent").length;
  return singles + groups; // a group is worth at least one call
}
/** Whether a phase can absorb an unbounded number of calls (has a fan-out). */
function elastic(p: GraphPhase): boolean {
  return p.steps.some((s) => s.kind !== "agent");
}

/**
 * Split the ordered journal across phases. Calls arrive in order, so each phase
 * takes its own greedily; a fan-out phase additionally absorbs the slack that
 * later phases don't need, and the tail always lands somewhere.
 */
export function attributeCalls(
  phases: readonly GraphPhase[],
  journal: readonly RunJournalEntry[],
): RunJournalEntry[][] {
  const sorted = [...journal].sort((a, b) => a.callIndex - b.callIndex);
  const buckets: RunJournalEntry[][] = phases.map(() => []);
  if (phases.length === 0) return [sorted];
  // minAfter[i] = calls the phases AFTER i must be left with.
  const minAfter: number[] = new Array(phases.length).fill(0);
  for (let i = phases.length - 2; i >= 0; i--) {
    minAfter[i] = minAfter[i + 1] + minCalls(phases[i + 1]);
  }
  let cursor = 0;
  for (let i = 0; i < phases.length; i++) {
    const remaining = sorted.length - cursor;
    if (remaining <= 0) break;
    let want: number;
    if (i === phases.length - 1) {
      want = remaining; // the tail always lands somewhere
    } else if (elastic(phases[i])) {
      // A fan-out absorbs the slack, but must leave later phases their minimum.
      want = Math.max(0, remaining - minAfter[i]);
    } else {
      // A fixed phase takes its own calls GREEDILY, in order. Reserving for
      // later phases here is wrong mid-run: those phases haven't executed yet,
      // so the reservation starved the earliest phase and pushed completed
      // calls rightwards (phase 0 rendered empty while phase 1 showed call #0).
      want = Math.min(remaining, minCalls(phases[i]));
    }
    buckets[i] = sorted.slice(cursor, cursor + want);
    cursor += want;
  }
  return buckets;
}

function cardStatus(e: RunJournalEntry): "success" | "failed" | "running" {
  return e.status === "failed" ? "failed" : e.status === "running" ? "running" : "success";
}

export function RunGraph({
  phases,
  journal,
  onOpenAgent,
}: {
  readonly phases: readonly GraphPhase[];
  readonly journal: readonly RunJournalEntry[];
  /** Open this agent's session as a subagent panel in the rail (never navigate),
   *  carrying the phase it ran in for the panel's breadcrumb. */
  readonly onOpenAgent: (entry: RunJournalEntry, phase: string) => void;
}) {
  // No parsed skeleton (dark or unsaved script) — degrade to one phase holding
  // the calls in order, rather than showing nothing.
  const stages: GraphPhase[] = phases.length > 0 ? [...phases] : [{ title: "Run", steps: [] }];
  const buckets = attributeCalls(stages, journal);
  const [active, setActive] = useState(0);

  // Follow the run: focus the phase that is currently executing, until the
  // operator picks one themselves (their click wins from then on).
  const [pinned, setPinned] = useState(false);
  const liveIdx = buckets.findIndex((b) => b.some((c) => c.status === "running"));
  useEffect(() => {
    if (!pinned && liveIdx >= 0) setActive(liveIdx);
  }, [liveIdx, pinned]);

  const idx = Math.min(active, stages.length - 1);

  return (
    // Phases as an ACCORDION: each phase is a row that expands to its agents,
    // so the rail's full width goes to the agent list instead of a sidebar.
    <div className="flex min-h-0 flex-col gap-0.5">
      {stages.map((p, i) => {
        const calls = buckets[i] ?? [];
        const done = calls.filter((c) => c.status === "completed").length;
        const failed = calls.some((c) => c.status === "failed");
        const live = calls.some((c) => c.status === "running");
        const total = Math.max(calls.length, minCalls(p));
        const plannedHere = Math.max(0, minCalls(p) - calls.length);
        const open = i === idx;
        return (
          <Collapsible
            key={`${p.title}-${i}`}
            open={open}
            onOpenChange={(o) => {
              setActive(o ? i : -1);
              setPinned(true);
            }}
          >
            <CollapsibleTrigger
              className={cn(
                "group/ph flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors",
                open ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/50 transition-transform group-data-[state=open]/ph:rotate-90" />
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  failed
                    ? "bg-red-500"
                    : live
                      ? "animate-pulse bg-amber-400"
                      : total > 0 && done >= total
                        ? "bg-emerald-500"
                        : "bg-muted-foreground/30",
                )}
              />
              <span className={cn("min-w-0 flex-1 truncate font-medium", TYPE.meta)}>{p.title}</span>
              <span className={cn("shrink-0 tabular-nums text-muted-foreground/50", TYPE.micro)}>
                {done}/{total}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="flex flex-col gap-0.5 py-0.5 pl-5">
                {calls.map((c) => {
            // The row opens the agent IN THE RAIL as a subagent panel. It must
            // never be a link: navigating to /?chatSession=… reloads the whole
            // app into a new thread, losing the run you were watching.
            const session = c.childSessionId ?? c.sessionId;
            return (
              <li key={c.callIndex}>
                <button
                  type="button"
                  disabled={!session}
                  onClick={() => onOpenAgent(c, p.title)}
                  title={session ? `Open ${c.subagent ?? "agent"}` : c.promptPreview}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors",
                    session ? "hover:bg-muted" : "cursor-default opacity-70",
                  )}
                >
                  <RunStatusDot status={cardStatus(c)} />
                  <span className={cn("min-w-0 flex-1 truncate font-mono", TYPE.meta)}>
                    {c.subagent ?? "agent"}
                  </span>
                  <span className={cn("min-w-0 max-w-[45%] shrink truncate text-muted-foreground/50", TYPE.micro)}>
                    {c.promptPreview}
                  </span>
                  {session ? (
                    <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/30" />
                  ) : null}
                </button>
                    </li>
                  );
                })}
                {Array.from({ length: plannedHere }, (_, k) => (
                  <li key={`planned-${k}`} className="flex items-center gap-2 px-1.5 py-1">
                    <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/25" />
                    <span className={cn("truncate text-muted-foreground/40", TYPE.micro)}>
                      {p.steps[calls.length + k]?.label ?? "queued"}
                    </span>
                  </li>
                ))}
                {calls.length === 0 && plannedHere === 0 ? (
                  <li className={cn("px-1.5 py-1 text-muted-foreground/40 italic", TYPE.micro)}>
                    No agent calls in this phase.
                  </li>
                ) : null}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
