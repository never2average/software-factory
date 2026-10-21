"use client";

/**
 * A SPECIALIST'S STATE AS AN ICON (mold_v1-297): one glyph per state, each with an accessible label and a tooltip,
 * the same on a delegation card in the chat and on its row in the Control Panel. What the states mean and how they
 * are derived: lib/specialist-status.ts.
 *
 * The icon is the only visible mark: no word or pill beside it (a check and "Done" said the same thing twice). The
 * state's word is its accessible name and its tooltip. Motion: only the running glyph turns, and only for someone who
 * has not asked for reduced motion (`motion-safe:`); every other state is still.
 */
import { useEffect, useState } from "react";
import {
  CircleCheckIcon,
  CircleStopIcon,
  CircleXIcon,
  ClockAlertIcon,
  CornerUpLeftIcon,
  HandIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { specialistState, stateLabel, stuckAfterMs, stuckAt, type SpecialistState, type StateFacts } from "@/lib/specialist-status";

const GLYPH: Readonly<Record<SpecialistState, { readonly Icon: typeof CircleCheckIcon; readonly tone: string }>> = {
  running: { Icon: LoaderCircleIcon, tone: "text-primary motion-safe:animate-spin" },
  waiting: { Icon: HandIcon, tone: "text-amber-700 dark:text-amber-400" },
  stuck: { Icon: ClockAlertIcon, tone: "text-orange-700 dark:text-orange-400" },
  ready: { Icon: CornerUpLeftIcon, tone: "text-primary" },
  done: { Icon: CircleCheckIcon, tone: "text-emerald-700 dark:text-emerald-500" },
  failed: { Icon: CircleXIcon, tone: "text-red-700 dark:text-red-400" },
  stopped: { Icon: CircleStopIcon, tone: "text-muted-foreground" },
};

/** The glyph for a state, named for assistive technology and hover alike. */
export function SpecialistStatusIcon({
  state,
  label,
  className,
}: {
  readonly state: SpecialistState;
  /** The state's word (lib/specialist-status.ts `stateLabel`): the accessible name and the tooltip. */
  readonly label: string;
  readonly className?: string;
}) {
  const { Icon, tone } = GLYPH[state];
  return (
    <span role="img" aria-label={label} title={label} data-specialist-state={state} className="inline-flex shrink-0">
      <Icon aria-hidden="true" className={cn("size-3.5", tone, className)} />
    </span>
  );
}

/**
 * The state now, re-derived when a running specialist crosses the stuck bound (one timer, set for that moment only;
 * nothing ticks while nothing can change). Returns the state and how long it has been quiet.
 */
export function useSpecialistState(facts: StateFacts): { readonly state: SpecialistState; readonly quietMs?: number } {
  const bound = stuckAfterMs();
  const [now, setNow] = useState(() => Date.now());
  const due = stuckAt(facts, bound);
  useEffect(() => {
    if (due === null) return;
    const wait = due - Date.now();
    // Already past the bound (it was quiet when it mounted, or the facts moved): re-read the clock once.
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, wait) + 50);
    return () => clearTimeout(t);
  }, [due]);
  const state = specialistState(facts, now, bound);
  return { state, ...(state === "stuck" && facts.lastProgressAt !== undefined ? { quietMs: now - facts.lastProgressAt } : {}) };
}

/** The glyph and its label from the facts, for a row that has nothing else to show (the Control Panel's rail). */
export function SpecialistStatus({ facts, className }: { readonly facts: StateFacts; readonly className?: string }) {
  const { state, quietMs } = useSpecialistState(facts);
  return <SpecialistStatusIcon state={state} label={stateLabel(state, quietMs)} className={className} />;
}

