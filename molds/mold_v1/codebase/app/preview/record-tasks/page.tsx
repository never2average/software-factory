"use client";

/**
 * Standalone preview of the Tasks view as a deployment defines a task (profiles records.areas.tasks) — the REAL
 * TodosPanel, no auth and no database (dev only; see ../layout.tsx). Checked by tests/task-area.spec.ts, which answers
 * every API call the panel makes and asserts what it sends.
 *
 * `?profile=obligation` renders it under the record-areas design's worked example (c), a task redefined as a
 * compliance obligation (scripts/fixtures/record-areas/examples/obligation.json, compiled into
 * scripts/fixtures/record-areas/golden/obligation.areas.json, which scripts/test-record-areas.mjs holds equal to what
 * the build compiles). Without it, this build's own definition (the default's: today's Tasks view).
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import obligation from "@/scripts/fixtures/record-areas/golden/obligation.areas.json";
import type { RecordAreas } from "@/agent/lib/record-areas";
import { TodosPanel } from "@/app/_components/ops/todos-panel";

function Preview() {
  const params = useSearchParams();
  const areas = params.get("profile") === "obligation" ? (obligation as unknown as RecordAreas) : undefined;
  // The panel renders only in the browser in the console (after sign-in): mounted the same way here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <TooltipProvider>
      <main className="flex h-screen flex-col bg-background text-foreground">
        <TodosPanel authorEmail="reviewer@example.com" onClose={() => {}} initialView="tasks" tasksArea={areas} />
      </main>
    </TooltipProvider>
  );
}

export default function RecordTasksPreview() {
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  );
}
