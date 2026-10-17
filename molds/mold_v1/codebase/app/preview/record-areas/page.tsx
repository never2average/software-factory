"use client";

/**
 * Standalone preview of the two account record areas drawn from their definition (profiles records.areas.deployments /
 * .implementations in the record-area form) — the REAL TodosPanel, no auth and no database (dev only; see
 * ../layout.tsx). Checked by tests/record-area-panels.spec.ts, which answers every API call the panel makes and asserts
 * what it sends.
 *
 * `?profile=` picks the compiled definitions (scripts/fixtures/record-areas/golden/<name>.areas.json, held equal to
 * what the build compiles by scripts/test-record-area-panels.mjs):
 *   filing     the record-areas design's worked example (a): a compliance desk's "Regulatory filing" (deployments)
 *   coverage   worked example (b): a research desk's "Coverage report" (deployments)
 *   programme  a "Compliance programme" (implementations) with a multi-pick, files, money and a yes/no
 *   permissions the three above with who may write them (examples/permissions.json): tests/record-permissions.spec.ts
 *   own-state  a "Work item" whose lifecycle is an OWN field (examples/own-state.json): rows that hold no own values
 *              (tests/record-area-panels.spec.ts)
 *   period     a "Regulatory filing" period (examples/filing-period.json): own fields, declared states, a board, a
 *              calendar, metrics, contained tasks (tests/period-area.spec.ts)
 * Without it, this build's own definitions (the default's: today's lists). `&view=deployments|implementations|tasks|<the period view key, PERIOD_VIEW in lib/work-periods-ui.ts>`.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import filing from "@/scripts/fixtures/record-areas/golden/filing.areas.json";
import coverage from "@/scripts/fixtures/record-areas/golden/coverage.areas.json";
import programme from "@/scripts/fixtures/record-areas/golden/programme.areas.json";
import permissions from "@/scripts/fixtures/record-areas/golden/permissions.areas.json";
import period from "@/scripts/fixtures/record-areas/golden/filing-period.areas.json";
import ownState from "@/scripts/fixtures/record-areas/golden/own-state.areas.json";
import type { RecordAreas } from "@/agent/lib/record-areas";
import { TodosPanel } from "@/app/_components/ops/todos-panel";

const PROFILES: Record<string, RecordAreas> = {
  filing: filing as unknown as RecordAreas,
  coverage: coverage as unknown as RecordAreas,
  programme: programme as unknown as RecordAreas,
  permissions: permissions as unknown as RecordAreas,
  period: period as unknown as RecordAreas,
  "own-state": ownState as unknown as RecordAreas,
};

function Preview() {
  const params = useSearchParams();
  const areas = PROFILES[params.get("profile") ?? ""];
  const asked = params.get("view");
  const view = asked === "implementations" || asked === "tasks" || asked === "sprints" ? asked : "deployments";
  // The panel renders only in the browser in the console (after sign-in): mounted the same way here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <TooltipProvider>
      <main className="flex h-screen flex-col bg-background text-foreground">
        <TodosPanel authorEmail="reviewer@example.com" onClose={() => {}} initialView={view} tasksArea={areas} />
      </main>
    </TooltipProvider>
  );
}

export default function RecordAreasPreview() {
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  );
}
