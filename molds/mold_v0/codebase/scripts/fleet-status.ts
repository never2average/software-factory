// Live orchestrators, the global usage-proportional pod plan, each orchestrator's share, and the autoscaler.
//   npm run fleet:status
import "../src/hosts.js"; // the build's host packs first: the agent mix the fleet plans by may be theirs (mold_v0-039)
import { getDb } from "../src/db.js";
import { fleetStatus } from "../src/fleet.js";
import { autoscalerStatus, computeDemand } from "../src/autoscaler.js";

const s = await fleetStatus();
console.log(`${s.orchestrators} live orchestrators, ${s.total_pods} pods; queue: ${s.queue.queued} queued, ${s.queue.running} running`);
console.table(s.plan.map((p) => ({ agent: p.agent_id, harness: p.harness, model: p.model, usage: `${(p.weight * 100).toFixed(1)}%`, pods: p.pods })));
if ("assignments" in s) console.table(s.assignments);

const a = await autoscalerStatus();
const d = await computeDemand();
console.log(`\nautoscaler: ${a.enabled ? "on" : "OFF (OCTILLION_AUTOSCALE=off)"}; leader ${a.leader ? `${a.leader.holder} (lease until ${new Date(a.leader.expires_at).toISOString()})` : "none"}`);
console.log(`knobs: ${JSON.stringify(a.knobs)}`);
console.log(`demand now: ${d.sessions} claimable sessions (${d.queued_sessions} queued), ${d.research} research, ${d.unclaimable_sessions} unclaimable`);
if (a.last_tick) console.log(`last tick: ${JSON.stringify(a.last_tick)}`);
console.table((a.sandboxes as any[]).slice(0, 15).map((r) => ({ sandbox: r.sandbox_id, orchestrator: r.orchestrator_id, state: r.state, created: r.created_at, ready: r.ready_at, last_seen: r.last_seen, image: r.from_image ?? "", error: r.error ?? "" })));
await (await getDb()).close();
