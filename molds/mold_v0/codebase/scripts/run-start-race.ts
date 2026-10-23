// The live-run cap under concurrent starts (mold_v0-018), on a real Postgres (PGlite has one connection, so it cannot
// race): N starts at once for one workspace must leave at most the cap queued or running.
//   DATABASE_URL=postgres://... npx tsx scripts/run-start-race.ts
// A throwaway database only: it migrates it and adds rows.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) { console.error("run-start-race: set DATABASE_URL to a throwaway Postgres"); process.exit(2); }
process.env.APP_VAULT_KEY ??= randomBytes(32).toString("base64");
process.env.APP_REGISTRY ??= "scripts/fixtures/registry.json";
process.env.APP_AUTOSCALE ??= "off";
process.env.REASONS_ENABLED = "off";
process.env.APP_ORG_MONTHLY_BUDGET_USD ??= "1000";
const CAP = 3, N = Number(process.env.RACE_N ?? 40), ROUNDS = Number(process.env.RACE_ROUNDS ?? 5);
process.env.APP_RUNS_MAX_LIVE_PER_WORKSPACE = String(CAP);

const { getDb } = await import("../src/db.js");
const db = await getDb();
await import("../src/server.js");
const { setPacksForTest } = await import("../src/packs.js");
const { definePack } = await import("../src/pack-api.js");
const runs = await import("../src/runs.js");
const { createOrg } = await import("../src/auth.js");
setPacksForTest([{ manifest: { id: "fixture_race", name: "Race", version: "1", entry: "index.ts", migrations: null, words: {}, dir: "scripts/fixtures/runs" },
  definition: definePack({ id: "fixture_race", jobKinds: [{ name: "plain", runner: "workspace-harness", entry: "ok.mjs" }] as never }) }]);
let worst = 0;
for (let round = 0; round < ROUNDS; round++) {
  const { org } = await createOrg(`Race ${Date.now().toString(36)} ${round}`);
  const out = await Promise.allSettled(Array.from({ length: N }, () => runs.startRun(org.orgId, "fixture_race", "plain")));
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM runs WHERE org_id = $1 AND status IN ('queued', 'running')", [org.orgId]);
  worst = Math.max(worst, n);
  console.log(`round ${round + 1}: ${N} starts at once -> ${out.filter((x) => x.status === "fulfilled").length} started, ${n} live (cap ${CAP})`);
}
await db.close();
assert.ok(worst <= CAP, `the live-run cap held under concurrent starts: at most ${worst} live (cap ${CAP})`);
console.log(`RUN START RACE PASS: ${ROUNDS} rounds of ${N} concurrent starts, never more than ${CAP} live`);
process.exit(0);
