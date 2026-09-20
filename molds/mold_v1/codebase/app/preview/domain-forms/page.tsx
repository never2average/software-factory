"use client";

/**
 * Standalone preview of the "New …" forms of the two record areas a deployment profile may redefine — the REAL
 * RefCreate and the real field builders from the TODOs panel, no auth and no database (dev only; see
 * ../layout.tsx). Checked by tests/domain-forms.spec.ts, which answers the two API calls the forms make.
 *
 * `?profile=research` applies docs/examples/profile-equity-research.json's `domains` section over the defaults
 * with the generator's own merge rule (objects merge deeply, arrays and scalars replace); without it the forms
 * are the default deployment's. The rest of the page (vocabulary, product name) is whatever this build's profile is.
 */
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import example from "@/docs/examples/profile-equity-research.json";
import { DEFAULT_DOMAINS } from "@/lib/deployment-profile.generated";
import { domainView, type Domains } from "@/lib/profile-domains";
import { RefCreate, deploymentCreateFields, implementationCreateFields } from "@/app/_components/ops/todos-panel";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === "$comment") continue;
    const b = base[k];
    out[k] = isObj(v) && isObj(b) ? merge(b, v) : v;
  }
  return out;
}

function Forms() {
  const research = useSearchParams().get("profile") === "research";
  const domains = (research ? merge(DEFAULT_DOMAINS as unknown as Record<string, unknown>, example.domains) : DEFAULT_DOMAINS) as unknown as Domains;
  const dep = domainView("deployments", domains);
  const imp = domainView("implementations", domains);
  const [created, setCreated] = useState<string[]>([]);
  return (
    <main className="grid min-h-screen grid-cols-2 gap-6 bg-background p-6 text-foreground">
      <section data-testid="form-deployments" className="rounded-lg border border-border/60">
        <RefCreate
          noun={dep.noun}
          endpoint="/api/ops/deployments"
          fields={deploymentCreateFields(dep)}
          fixed={dep.fixedValues()}
          onCancel={() => {}}
          onCreated={(id) => setCreated((p) => [...p, `deployments:${id}`])}
        />
      </section>
      <section data-testid="form-implementations" className="rounded-lg border border-border/60">
        <RefCreate
          noun={imp.noun}
          endpoint="/api/ops/implementations"
          fields={implementationCreateFields(imp)}
          fixed={imp.fixedValues()}
          groupChoices={[{ value: "large-hfcs", label: "Large hfcs" }]}
          groupNoun={imp.groupLabel?.singular}
          onCancel={() => {}}
          onCreated={(id) => setCreated((p) => [...p, `implementations:${id}`])}
        />
      </section>
      <output data-testid="created" className="col-span-2 font-mono text-xs">{created.join(" ")}</output>
    </main>
  );
}

export default function DomainFormsPreview() {
  return (
    <Suspense>
      <Forms />
    </Suspense>
  );
}
