// Nested runs under real concurrency (mold_v0-291): budgets carved and gateway requests held, on a real Postgres (PGlite has
// one connection, so it cannot race). N spawns at once must never carve past the parent's budget; N model requests at once
// must never hold past the run's; a child settled by several processes at once is settled once.
//   DATABASE_URL=postgres://... npx tsx scripts/nested-runs-race.ts
// A throwaway database only: it migrates it and adds rows.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) { console.error("nested-runs-race: set DATABASE_URL to a throwaway Postgres"); process.exit(2); }
process.env.APP_VAULT_KEY ??= randomBytes(32).toString("base64");
process.env.APP_REGISTRY ??= "scripts/fixtures/registry.json";
process.env.APP_AUTOSCALE ??= "off";
process.env.REASONS_ENABLED = "off";
process.env.APP_ORG_MONTHLY_BUDGET_USD ??= "100000";
process.env.APP_RUNS_MAX_LIVE_PER_WORKSPACE = "400";
const N = Number(process.env.RACE_N ?? 40), ROUNDS = Number(process.env.RACE_ROUNDS ?? 5);

const F = await import("../src/features.js");
F.setFeaturesForTest({ agent_harness: true, nested_runs: true });
const { getDb } = await import("../src/db.js");
const db = await getDb();
await import("../src/server.js");
const H = await import("../src/harness-sessions.js");
const Nested = await import("../src/nested-runs.js");

const { createOrg } = await import("../src/auth.js");
const { saveSettingValues } = await import("../src/platform-keys.js");
await saveSettingValues("race", { AGENT_CHECKPOINT_SECONDS: 0, AGENT_SESSION_BUDGET_USD: 10, AGENT_BUDGET_CEILING_USD: 20, AGENT_SESSIONS_PER_WORKSPACE: 50 });
const runs = await import("../src/runs.js");
/** This session's own queued wake (the queue also holds other rounds' children). */
const claimOf = async (sessionId: string) => {
  const [r] = await db.query<{ id: string }>("SELECT id FROM runs WHERE harness_session_id = $1 AND status = 'queued' ORDER BY created_at DESC LIMIT 1", [sessionId]);
  return r ? runs.claimRun("race", { runId: r.id }) : null;
};
const key: import("../src/harness-sessions.js").Actor = { kind: "key", user: null, name: "account key", role: null };
const model = "claude-sonnet-5-5";

let worstCarved = 0, worstHeld = 0, wonTotal = 0, heldRefused = 0;
for (let round = 0; round < ROUNDS; round++) {
  const { org } = await createOrg(`Nested race ${Date.now().toString(36)} ${round}`);
  const s = await H.startSession(org.orgId, key, { message: "race", budget_usd: 5 });
  const claim = await claimOf(s.id);
  assert.ok(claim, "a wake");
  const w = await H.wakeStart(claim!.run.id, claim!.lease_token);
  const ctx = { orgId: org.orgId, sessionId: w.session_id, runId: claim!.run.id, role: null };
  // Spawns at once: at most the budget, less the margin kept for the parent, is ever carved.
  const out = await Promise.allSettled(Array.from({ length: N }, (_, i) => Nested.spawnChild(ctx, { prompt: `race ${i}`, budget_usd: 0.6 })));
  const won = out.filter((r) => r.status === "fulfilled").length;
  wonTotal += won;
  assert.ok(won > 0, `no spawn won: ${String((out.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined)?.reason?.message)}`);
  const [row] = await db.query<{ carved: string }>("SELECT carved_usd AS carved FROM harness_sessions WHERE id = $1", [s.id]);
  assert.ok(Number(row!.carved) <= 5 - Nested.PARENT_MARGIN_USD + 1e-6, `round ${round}: carved ${row!.carved} of a $5 budget`);
  assert.equal(Number(row!.carved), Number((won * 0.6).toFixed(6)), "what is carved is what was won");
  worstCarved = Math.max(worstCarved, Number(row!.carved));

  // A model request held from a child's budget: never more than it has, under a real lock.
  // Some spawns answered while another's pump was still starting theirs: the queue is moved once more, then read.
  await Nested.pump(org.orgId, s.id);
  const [started] = await db.query<{ handle: string; session_id: string }>("SELECT h.id AS handle, h.session_id FROM harness_children h JOIN runs r ON r.harness_session_id = h.session_id AND r.status = 'queued' WHERE h.org_id = $1 AND h.settled_at IS NULL LIMIT 1", [org.orgId]);
  assert.ok(started, "a child that has started");
  const handle = started;
  const childClaim = await claimOf(handle.session_id);
  assert.ok(childClaim, "a child's wake");
  await db.query("UPDATE runs SET budget_usd = 0.5 WHERE id = $1", [childClaim!.run.id]);
  const body = Buffer.from(JSON.stringify({ model, max_tokens: 8000, messages: [{ role: "user", content: "x" }] }));
  const held = await Promise.all(Array.from({ length: N }, () => Nested.admitTreeRequest({ id: childClaim!.run.id, org_id: org.orgId, budget_usd: 0.5 }, body, model)));
  const [h] = await db.query<{ sum: string }>("SELECT coalesce(sum(usd), 0) AS sum FROM harness_gateway_holds WHERE run_id = $1", [childClaim!.run.id]);
  assert.ok(Number(h!.sum) <= 0.5 + 1e-6, `holds ${h!.sum} of a $0.50 budget`);
  worstHeld = Math.max(worstHeld, Number(h!.sum));
  heldRefused += held.filter((r) => "refused" in r).length;

  // Several settlers at once charge once.
  const settled = await Promise.all(Array.from({ length: 6 }, () => H.tx((q) => Nested.settleHandle(q, org.orgId, handle.handle, { status: "cancelled", error: "race" }))));
  assert.equal(settled.filter(Boolean).length, 1, "settled exactly once");
  await db.query("DELETE FROM harness_gateway_holds WHERE run_id = $1", [childClaim!.run.id]);
}
console.log(`ok: ${ROUNDS} rounds of ${N} at once: carved at most $${worstCarved.toFixed(2)} of $5 (${wonTotal} spawns won); held at most $${worstHeld.toFixed(4)} of $0.50 (${heldRefused} refused); a child settled by six at once, once`);
process.exit(0);
