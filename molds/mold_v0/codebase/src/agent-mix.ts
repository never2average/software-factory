import { registry, type Population } from "./agents.js";
import { hosts } from "./host.js";

/**
 * The agent mix the session engine schedules by (the autoscaler's warm orchestrators, the fleet plan, the Compute
 * page): a host pack's (src/host.ts sessions.population, mold_v0-039: the product's developer populations), else every
 * registry agent at its registry weight (harnesses/registry.json, its cited seed), with no database of its own.
 */
export async function currentPopulation(): Promise<Population> {
  const h = hosts().find((x) => x.sessions?.population);
  if (h) return h.sessions!.population!();
  const reg = registry() as ReturnType<typeof registry> & { as_of?: string; methodology?: string; sources?: unknown[]; unrepresented_share?: number };
  return {
    id: 0, slug: "registry", name: "Registry agents", description: "Every agent of the harness registry at its registry weight.",
    as_of: reg.as_of ?? null, methodology: reg.methodology ?? "", sources: reg.sources ?? [], unrepresented_share: reg.unrepresented_share ?? null,
    sandbox_unit: Math.max(1, Math.trunc(Number(process.env.OCTILLION_SANDBOX_UNIT ?? 20))), min_one_sandbox: process.env.OCTILLION_MIN_ONE_SANDBOX !== "0",
    is_default: true, org_id: null, agents: reg.agents,
  };
}
