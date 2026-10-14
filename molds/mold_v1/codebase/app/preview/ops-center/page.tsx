"use client";

/**
 * Standalone preview of the Ops Center modal — the REAL OpsCenter shell over one of its panels, no auth and no
 * database (dev only; see ../layout.tsx). Checked by tests/ops-center.spec.ts, which answers every API call the
 * panels make. `?section=<section>` picks the panel (apps when absent), `?id=<row id>` deep-links a row.
 * The page around the modal says whether it is open and has a button that opens it again, so a spec can see the
 * modal close and come back.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OPS_SECTIONS, OpsCenter, type OpsSection } from "@/app/_components/ops-center";

function Preview() {
  const params = useSearchParams();
  const asked = params.get("section");
  const section: OpsSection = OPS_SECTIONS.find((s) => s.key === asked)?.key ?? "apps";
  const id = params.get("id") ?? undefined;
  const [open, setOpen] = useState(true);
  // In the console the modal only ever renders in the browser, after sign-in: mounted the same way here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <TooltipProvider>
      <main className="flex h-screen flex-col gap-2 bg-background p-4 text-foreground">
        <p data-testid="ops-state">{open ? "open" : "closed"}</p>
        <button type="button" onClick={() => setOpen(true)}>
          Open the Ops Center
        </button>
        <OpsCenter open={open} onOpenChange={setOpen} section={section} authorEmail="reviewer@example.com" initialSelectedId={id} />
      </main>
    </TooltipProvider>
  );
}

export default function OpsCenterPreview() {
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  );
}
