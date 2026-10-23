import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENV } from "../core/env-names.js";

/**
 * Standalone fleet plan (FLEET_MODE=standalone; in server mode the server plans globally, src/fleet.ts).
 * One pod group per runnable registry AGENT (harness + model), e.g. "Claude Code · Opus" and "Claude Code · Sonnet",
 * each sized by its own usage share: largest remainder, then any agent left with zero pods takes one from whichever
 * agent is most over its exact share, when the fleet can afford one pod per agent. Same rule as the server's planPods.
 */

export interface RegistryAgent {
  id: string; harness: string; label: string; model: string; weight: number; enabled?: boolean;
  harness_version?: string; image?: { docker?: string; boat_snapshot?: string }; requires_env?: string[];
}
export interface PodGroup {
  agent_id: string; harness: string; model: string; weight: number; pods: number;
  image: string; version?: string; requires_env: string[]; agents: string[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Agents this orchestrator learned from the server, by id: each claimed session's `agent` payload carries its full
 * registry spec (src/worker.ts), so harnesses added on /admin/agents (platform_harnesses; not in the registry.json this
 * orchestrator was deployed with) resolve here too: their harness_version pin, image, requires_env. Weight 0: they are
 * never planned standalone (the server plans the mix, src/fleet.ts).
 */
const remembered = new Map<string, RegistryAgent>();

/** Add specs from claimed sessions (ignores malformed ones). */
export function rememberAgents(specs: unknown[]): void {
  for (const s of specs) {
    const a = s as Partial<RegistryAgent> | null;
    if (!a || typeof a.id !== "string" || !a.id || typeof a.harness !== "string" || typeof a.model !== "string") continue;
    remembered.set(a.id, { ...(a as RegistryAgent), weight: 0 });
  }
}

/** Registry file entries, then remembered server agents; a remembered one never shadows a file id. Pure. */
export function mergeAgents(file: RegistryAgent[], extra: Iterable<RegistryAgent>): RegistryAgent[] {
  const ids = new Set(file.map((a) => a.id));
  return [...file, ...[...extra].filter((a) => !ids.has(a.id) && ids.add(a.id))];
}

export function loadRegistry(file = ENV.APP_REGISTRY ?? "harnesses/registry.json"): { agents: RegistryAgent[] } {
  const reg = JSON.parse(readFileSync(path.resolve(ROOT, file), "utf8")) as { agents: RegistryAgent[] };
  return remembered.size ? { ...reg, agents: mergeAgents(reg.agents, remembered.values()) } : reg;
}

export function planFleet(size: number, agents: RegistryAgent[] = loadRegistry().agents): PodGroup[] {
  const list: PodGroup[] = agents
    .filter((x) => x.enabled !== false && x.weight > 0 && (x as { worker_adapter?: string }).worker_adapter !== "todo" && !(x as { paused?: boolean }).paused)
    .map((a) => ({
      agent_id: a.id, harness: a.harness, model: a.model, weight: a.weight, pods: 0, version: a.harness_version,
      image: a.image?.docker ?? `octillion/agent-${a.harness}:${a.harness_version ?? "latest"}`,
      requires_env: [...(a.requires_env ?? [])], agents: [a.id],
    }))
    .sort((a, b) => b.weight - a.weight || a.agent_id.localeCompare(b.agent_id));
  const total = list.reduce((s, g) => s + g.weight, 0) || 1;
  for (const g of list) g.weight /= total;

  const rows = list.map((g) => ({ g, exact: g.weight * size }));
  for (const r of rows) r.g.pods = Math.floor(r.exact);
  let left = size - rows.reduce((s, r) => s + r.g.pods, 0);
  for (const r of [...rows].sort((a, b) => (b.exact % 1) - (a.exact % 1) || b.g.weight - a.g.weight)) {
    if (left-- <= 0) break;
    r.g.pods++;
  }
  // Same as the server's sandbox unit: honest rounding by default (agents may round to 0 sandboxes); with
  // APP_MIN_ONE_SANDBOX=1 every agent gets at least one, taken from whoever is most over its exact share.
  if (ENV.APP_MIN_ONE_SANDBOX === "1" && size >= list.length)
    for (const empty of list.filter((g) => g.pods === 0)) {
      const donor = list.filter((g) => g.pods > 1).sort((a, b) => (b.pods - b.weight * size) - (a.pods - a.weight * size))[0];
      if (!donor) break;
      donor.pods--;
      empty.pods++;
    }
  return list;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const size = Number(process.argv[2] ?? process.env.POD_CAPACITY ?? process.env.FLEET_SIZE ?? 10);
  const plan = planFleet(size);
  console.table(plan.map((g) => ({ agent: g.agent_id, harness: g.harness, model: g.model, usage: `${(g.weight * 100).toFixed(1)}%`, pods: g.pods, image: g.image })));
  console.log(`${plan.reduce((s, g) => s + g.pods, 0)} pods total`);
  const starved = plan.filter((g) => !g.pods).map((g) => g.agent_id);
  if (starved.length) console.warn(`Warning: no pod for ${starved.join(", ")}; their sessions will wait. Use a fleet of >= ${plan.length} pods.`);
}
