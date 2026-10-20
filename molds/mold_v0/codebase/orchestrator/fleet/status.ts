/**
 * Pool status: pods per POD GROUP (registry agent = harness + model) on this Docker host, idle vs busy, next to the plan.
 *   npx tsx orchestrator/fleet/status.ts [--owner <ORCHESTRATOR_ID>] [--json]
 * Plan column: the server's global fleet (GET /api/worker/fleet, needs OCTILLION_URL + OCTILLION_WORKER_TOKEN),
 * else the standalone plan (fleet/plan.ts, POD_CAPACITY). Busy pods are named octi-busy-*, idle ones octi-pool-*.
 */
import { execFileSync } from "node:child_process";
import { planFleet } from "./plan.js";

const args = process.argv.slice(2);
const owner = args.includes("--owner") ? args[args.indexOf("--owner") + 1] : undefined;
const filters = ["--filter", "label=octillion.pool=1", ...(owner ? ["--filter", `label=octillion.pool.owner=${owner}`] : [])];
const out = execFileSync("docker", ["ps", ...filters, "--format",
  '{{.Names}}\t{{.Label "octillion.agent"}}\t{{.Label "octillion.harness"}}\t{{.Label "octillion.model"}}\t{{.Label "octillion.pool.owner"}}'], { encoding: "utf8" });

interface Row { agent: string; harness: string; model: string; idle: number; busy: number; planned?: number; assigned?: number }
const rows = new Map<string, Row>();
const row = (agent: string, harness = "", model = "") => {
  const r = rows.get(agent) ?? { agent, harness, model, idle: 0, busy: 0 };
  r.harness ||= harness; r.model ||= model;
  rows.set(agent, r);
  return r;
};
const owners = new Set<string>();
for (const line of out.split("\n").filter(Boolean)) {
  const [name, agent, harness, model, own] = line.split("\t");
  owners.add(own!);
  const r = row(agent || harness!, harness, model);
  if (name!.startsWith("octi-busy-")) r.busy++; else r.idle++;
}

let source = "standalone plan";
let header = "";
const url = (process.env.OCTILLION_URL ?? "").replace(/\/+$/, "");
const token = process.env.OCTILLION_WORKER_TOKEN;
let server: any = null;
if (url && token) {
  try {
    const res = await fetch(`${url}/api/worker/fleet`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) server = await res.json();
  } catch { /* fall back */ }
}
if (server) {
  source = "server (global)";
  header = `${server.orchestrators} orchestrator(s), ${server.total_pods} pods planned, queue ${JSON.stringify(server.queue)}`;
  for (const p of server.plan ?? []) row(p.agent_id ?? p.harness, p.harness, p.model).planned = p.pods;
  if (owner && server.assignments?.[owner]) for (const [a, n] of Object.entries(server.assignments[owner])) row(a).assigned = Number(n);
} else {
  try { for (const g of planFleet(Number(process.env.POD_CAPACITY ?? process.env.FLEET_SIZE ?? 20))) row(g.agent_id, g.harness, g.model).planned = g.pods; }
  catch { source = "none (no registry)"; }
}

const list = [...rows.values()].sort((a, b) => (b.planned ?? 0) - (a.planned ?? 0) || a.agent.localeCompare(b.agent));
if (args.includes("--json")) console.log(JSON.stringify({ source, server, owners: [...owners], rows: list }));
else {
  if (header) console.log(header);
  console.table(list.map((r) => ({ group: r.agent, harness: r.harness, model: r.model, idle: r.idle, busy: r.busy, [`planned (${source})`]: r.planned ?? "-", ...(owner ? { assigned: r.assigned ?? "-" } : {}) })));
  console.log(`${list.reduce((s, r) => s + r.idle, 0)} idle, ${list.reduce((s, r) => s + r.busy, 0)} busy on this host (${owners.size} orchestrator id(s))`);
}
