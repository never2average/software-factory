"use client";

/**
 * Standalone preview of the Ops Center modal — the REAL OpsCenter shell over one of its panels, no auth and no
 * database (dev only; see ../layout.tsx). Checked by tests/ops-center.spec.ts, which answers every API call the
 * panels make. `?section=<section>` picks the panel (apps when absent), `?id=<row id>` deep-links a row.
 * The page around the modal says whether it is open and has a button that opens it again, so a spec can see the
 * modal close and come back.
 *
 * `?hub=<name>` shows the record hub (profiles records.hub) under that hub, with the sidebar's Ops Center links beside
 * the modal (tests/record-hub.spec.ts): `default` is this build's, `obligations-register` the one
 * scripts/fixtures/record-hub/50-obligations-register.json declares, compiled by the build's own compileHub
 * (scripts/test-record-hub.mjs holds the two equal). The links are the list the chat sidebar renders, from the same
 * opsSectionsFor(); the sidebar itself is not imported, which would regroup the chat page's first-load chunks.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OPS_SECTIONS, OpsCenter, type OpsSection } from "@/app/_components/ops-center";
import obligationsRegister from "@/scripts/fixtures/record-hub/50-obligations-register.json";
import { compileHub } from "@/agent/lib/record-hub";
import { RECORD_AREAS } from "@/agent/lib/record-areas.generated";
import { opsSectionsFor } from "@/app/_components/ops/lib";
import { RECORD_HUB_UI, RecordHubProvider, recordHubUi } from "@/app/_components/ops/record-hub";

function Preview() {
  const params = useSearchParams();
  const asked = params.get("section");
  const [section, setSection] = useState<OpsSection>(OPS_SECTIONS.find((s) => s.key === asked)?.key ?? "apps");
  const hubAsked = params.get("hub");
  const hub = hubAsked === "obligations-register" ? recordHubUi(compileHub(obligationsRegister.records.hub, RECORD_AREAS.tasks)) : RECORD_HUB_UI;
  const id = params.get("id") ?? undefined;
  const [open, setOpen] = useState(true);
  // In the console the modal only ever renders in the browser, after sign-in: mounted the same way here.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return (
    <RecordHubProvider value={hub}>
      <TooltipProvider>
        <main className="flex h-screen flex-col gap-2 bg-background p-4 text-foreground">
          <p data-testid="ops-state">{open ? "open" : "closed"}</p>
          <button type="button" onClick={() => setOpen(true)}>
            Open the Ops Center
          </button>
          {hubAsked ? (
            <nav aria-label="Ops Center links">
              <ul className="flex gap-3">
                {opsSectionsFor(hub).map(({ key, label, icon: Icon }) => (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => {
                        setSection(key);
                        setOpen(true);
                      }}
                      className="flex items-center gap-2 text-xs"
                    >
                      <Icon className="size-3.5 shrink-0" />
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <OpsCenter open={open} onOpenChange={setOpen} section={section} authorEmail="reviewer@example.com" initialSelectedId={id} />
        </main>
      </TooltipProvider>
    </RecordHubProvider>
  );
}

export default function OpsCenterPreview() {
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  );
}
