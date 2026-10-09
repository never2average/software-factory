"use client";

/**
 * Standalone preview of the Apps panel — the REAL AppsPanel (list, create form, document view), no auth and no
 * database (dev only; see ../layout.tsx). Checked by tests/apps-source.spec.ts, which answers every API call the
 * panel makes: what the picker offers, a create the API refuses, an app whose refresh failed and its retry.
 * `?id=<app id>` opens that app.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppsPanel } from "@/app/_components/ops/apps-panel";

function Panel() {
  const id = useSearchParams().get("id");
  // In the console the panel only ever renders in the browser, after sign-in: mounted the same way here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <TooltipProvider>
      <main data-testid="apps" className="flex h-screen flex-col bg-background p-4 text-foreground">
        <AppsPanel authorEmail="reviewer@example.com" initialSelectedId={id} />
      </main>
    </TooltipProvider>
  );
}

export default function AppsPreview() {
  return (
    <Suspense fallback={null}>
      <Panel />
    </Suspense>
  );
}
