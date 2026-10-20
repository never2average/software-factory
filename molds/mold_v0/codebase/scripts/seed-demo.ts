// Create a demo organization with a fictional product and ~2 weeks of simulated agent sessions, pushed
// through the real queue -> ingest -> scoring path. For local previews and demos only.
//   npm run demo:seed
import { createOrg } from "../src/auth.js";
import { getDb } from "../src/db.js";
import { runSimulation, saveProduct, saveScenarios } from "../src/queries.js";
import { appendEvents, claimJobs, completeSession } from "../src/worker.js";
import { DEMO_PRODUCT, DEMO_SCENARIOS, demoTranscript } from "./demo-data.js";

if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed demo data in production");
const db = await getDb();
const { org, key } = await createOrg("Demo Co", `demo-${Date.now().toString(36)}`);
await saveProduct(org, DEMO_PRODUCT);
await saveScenarios(org, undefined, DEMO_SCENARIOS);

// Per scenario, how likely each model is to pick the product: gives the report some real shape.
const odds: Record<string, number[]> = { "claude-sonnet-5-5": [0.7, 0.3, 0.5, 0.15], "claude-opus-5-5": [0.8, 0.45, 0.6, 0.25] };
const competitors = [["BullMQ", "bullmq"], ["Inngest", "inngest"], ["Celery", "celery"]];
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const scenarioIds = (await db.query<{ id: number }>("SELECT s.id FROM scenarios s JOIN products p ON p.id = s.product_id WHERE p.org_id = $1 ORDER BY s.id", [org.orgId])).map((r) => r.id);
for (let day = 13; day >= 0; day -= 2) {
  const sim = await runSimulation(org, { repeats: 2, name: `Daily check (${day}d ago)` });
  for (let jobs = await claimJobs("demo"); jobs.length; jobs = await claimJobs("demo")) {
    const job = jobs[0];
    const [{ scenario_id }] = await db.query<{ scenario_id: number }>("SELECT scenario_id FROM agent_sessions WHERE id = $1", [job.session_id]);
    const i = scenarioIds.indexOf(scenario_id);
    const p = (odds[job.model] ?? [0.5, 0.5, 0.5, 0.5])[i] + (13 - day) * 0.01;
    const r = rand();
    const [comp, pkg] = competitors[i % 3];
    const outcome = r < p * 0.7 ? "adopted" : r < p ? "recommended" : r < p + 0.1 ? "mentioned" : r < 0.93 ? "competitor" : "none";
    const ended = Date.now() - day * 86_400_000 - rand() * 3_600_000;
    await appendEvents(job.session_id, demoTranscript(job.prompt, outcome, comp, pkg, ended - 120_000));
    await completeSession(job.session_id, { status: "completed", tokens_in: 18000, tokens_out: 2400, cost_usd: 0.42 });
    await db.query("UPDATE agent_sessions SET started_at = $2::timestamptz - interval '2 minutes', ended_at = $2, queued_at = $2::timestamptz - interval '3 minutes' WHERE id = $1", [job.session_id, new Date(ended)]);
  }
  await db.query("UPDATE simulations SET created_at = now() - make_interval(days => $2), finished_at = now() - make_interval(days => $2) WHERE id = $1", [sim.simulation.id, day]);
}
const port = process.env.PORT ?? 3333;
console.log(`Demo org "${org.name}" (${org.slug}) seeded.
API key: ${key}
Preview (needs OCTILLION_PREVIEW=1 npm run start:http):
  http://127.0.0.1:${port}/preview/get_visibility_report?key=${key}`);
await db.close();
