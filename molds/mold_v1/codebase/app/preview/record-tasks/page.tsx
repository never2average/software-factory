"use client";

/**
 * Standalone preview of the Tasks view as a deployment defines a task (profiles records.areas.tasks) — the REAL
 * TodosPanel, no auth and no database (dev only; see ../layout.tsx). Checked by tests/task-area.spec.ts, which answers
 * every API call the panel makes and asserts what it sends.
 *
 * `?profile=obligation` renders it under the record-areas design's worked example (c), a task redefined as a
 * compliance obligation (scripts/fixtures/record-areas/examples/obligation.json, compiled into
 * scripts/fixtures/record-areas/golden/obligation.areas.json, which scripts/test-record-areas.mjs holds equal to what
 * the build compiles). `?profile=obligation-like` lays scripts/fixtures/record-areas/ui/obligation-like.json over it:
 * an area as a pack declares it (only the board and the table, due-date presets, metrics, an own field on the cards,
 * its own placeholders), checked by tests/task-area-definition.spec.ts; `&enforce=strict` (or `warn`, `off`) sets its
 * lifecycle's enforce; `&role=owner|admin|engineer|member` is the signed-in person's role (as the Ops Center passes it).
 * Without a profile, this build's own definition (the default's: today's Tasks view).
 */
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import obligation from "@/scripts/fixtures/record-areas/golden/obligation.areas.json";
import obligationLike from "@/scripts/fixtures/record-areas/ui/obligation-like.json";
import type { RecordAreas, RecordRole } from "@/agent/lib/record-areas";
import { TodosPanel } from "@/app/_components/ops/todos-panel";

/** Objects merge, arrays and values replace (as profiles layer). */
function overlay(base: unknown, over: unknown): unknown {
  if (!over || typeof over !== "object" || Array.isArray(over) || !base || typeof base !== "object" || Array.isArray(base)) return over;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) if (k !== "$comment") out[k] = overlay(out[k], v);
  return out;
}

function areasFor(profile: string | null, enforce: string | null): RecordAreas | undefined {
  if (profile !== "obligation" && profile !== "obligation-like") return undefined;
  const areas = (profile === "obligation-like" ? overlay(obligation, obligationLike) : structuredClone(obligation)) as unknown as RecordAreas;
  if (enforce === "strict" || enforce === "warn" || enforce === "off") areas.tasks.lifecycle = { ...areas.tasks.lifecycle!, enforce };
  return areas;
}

function Preview() {
  const params = useSearchParams();
  const profile = params.get("profile");
  const enforce = params.get("enforce");
  const areas = useMemo(() => areasFor(profile, enforce), [profile, enforce]);
  const roleParam = params.get("role");
  const role = roleParam === "owner" || roleParam === "admin" || roleParam === "engineer" || roleParam === "member" ? (roleParam as RecordRole) : undefined;
  // The panel renders only in the browser in the console (after sign-in): mounted the same way here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <TooltipProvider>
      <main className="flex h-screen flex-col bg-background text-foreground">
        <TodosPanel authorEmail="reviewer@example.com" onClose={() => {}} initialView="tasks" tasksArea={areas} role={role} />
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
