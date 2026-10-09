/**
 * THE RUN HISTORY, AGAINST A REAL POSTGRES.
 *
 * scripts/test-subagent-delivery.mjs holds the DECISIONS — which invocation
 * failed, which child session it belongs to, which open run is merely waiting.
 * The two things those decisions turn into are database statements, and neither
 * can be asserted from source:
 *
 *   · that the parent writing a row for a child that never started CANNOT
 *     produce a second row when the child did start. The guarantee is the
 *     UNIQUE index on `run_key` plus `onConflictDoNothing`, and an index either
 *     behaves that way or it does not — no amount of reading says which;
 *   · that the sweeper closes exactly the rows that cannot still be live, and
 *     no others. That is one WHERE clause with four predicates, and its whole
 *     value is in what it does NOT match.
 *
 * And what a run COSTS (section 9): each step priced at the model that served
 * it, an unpriced model left unknown (NULL, never $0), a provider's own figure
 * kept; with ADMIN_URL also drizzle/0036's own checks (section 10).
 *
 * So this runs the real recorder (agent/lib/workflow-usage.ts, the module the
 * hooks call) against a real database, the way the isolation job's other
 * database test does.
 *
 * NON-DESTRUCTIVE: every row lives under a throwaway workspace whose id carries
 * this process's pid, and the workspace is removed in a finally block. It
 * touches nothing else. It needs the app_rw url CI's `isolation` job already
 * builds; without DATABASE_URL it skips rather than failing, so the offline
 * job is unaffected.
 *
 * Run:  [ADMIN_URL=postgres://postgres:…@127.0.0.1:5432/workspace_test] \
 *       DATABASE_URL=postgres://app_rw:…@127.0.0.1:5432/workspace_test npm run test:run-history-db
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("test-run-history-db: SKIPPED — needs DATABASE_URL (the app_rw url).");
  process.exit(0);
}

const { eq } = await import("drizzle-orm");
const { closeDb, getDb, withOrgDb } = await import("../agent/lib/db/index.ts");
const { automationRuns, orgs, workflows } = await import("../agent/lib/db/schema.ts");
const {
  ABANDONED_RUN_ERROR,
  ABANDONED_RUN_MS,
  AWAITING_ANSWER_SUMMARY,
  __resetWorkflowIdCache,
  clearDelegationPark,
  closeAbandonedWorkflowRuns,
  delegatedRunKey,
  finishWorkflowRun,
  markDelegationParked,
  openWorkflowRun,
  recordFailedDelegation,
  recordWorkflowStep,
} = await import("../agent/lib/workflow-usage.ts");

let passed = 0;
const check = (label, condition, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label} — ${JSON.stringify(detail)?.slice(0, 600)}`);
  passed++;
  console.log(`  ok   ${label}`);
};

const ORG = `runhist-test-${process.pid}`;
const ORG2 = `runhist-test2-${process.pid}`;
/** The subagent id. Deliberately not one of the real ones, so nothing collides. */
const SPECIALIST = `run-history-probe-${process.pid}`;

const db = getDb();
assert.ok(db, "DATABASE_URL is set but getDb() returned null");

/** Every automation_runs row this workspace holds, newest first. */
const rows = () =>
  withOrgDb(ORG, (tx) =>
    tx.select().from(automationRuns).where(eq(automationRuns.orgId, ORG)).orderBy(automationRuns.startedAt),
  );

const rowFor = async (runKey) =>
  (await withOrgDb(ORG, (tx) =>
    tx.select().from(automationRuns).where(eq(automationRuns.runKey, runKey)),
  ))[0] ?? null;

/** Push a row's start back in time, the way an hour of real waiting would. */
const backdate = (runKey, ms) =>
  withOrgDb(ORG, (tx) =>
    tx
      .update(automationRuns)
      .set({ startedAt: new Date(Date.now() - ms) })
      .where(eq(automationRuns.runKey, runKey)),
  );

let workflowId = null;
try {
  await db.insert(orgs).values({ orgId: ORG, name: "Run history probe", status: "active" });
  const [wf] = await withOrgDb(ORG, (tx) =>
    tx
      .insert(workflows)
      .values({ orgId: ORG, name: SPECIALIST, description: "Throwaway probe.", createdBy: "test-run-history-db" })
      .returning({ id: workflows.id }),
  );
  workflowId = wf.id;
  __resetWorkflowIdCache();

  console.log("\n1. A specialist that dies before turn.started leaves a row saying so");
  {
    // THE MEASURED CASE, replayed from the stream it was recorded on. A sandbox
    // bootstrap failure: the parent's stream carries `subagent.called` and then
    // an `action.result` flagged isError, and the child emits NO turn event in
    // between — so every recorder driven by the child's turn stays silent.
    const events = readFileSync("scripts/fixtures/subagent-delivery/child-fails.ndjson", "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const called = events.find((e) => e.type === "subagent.called").data;
    const childSession = called.childSessionId;
    const key = delegatedRunKey(workflowId, childSession);

    // Drive the CHILD's own recorder the way agent/subagents/<key>/hooks/usage.ts
    // does, over exactly the child events this invocation produced. This is the
    // defect, executed rather than described: zero events, zero rows.
    for (const wrapped of events.filter((e) => e.type === "subagent.event")) {
      const e = wrapped.data.event;
      if (e.type === "turn.started") await openWorkflowRun(SPECIALIST, e.data.turnId, childSession, ORG);
      if (e.type === "turn.failed") {
        await finishWorkflowRun(SPECIALIST, e.data.turnId, { status: "failed" }, childSession, ORG);
      }
    }
    check("the child's own recorder leaves nothing behind — this is the gap", (await rowFor(key)) === null);

    // What the PARENT knows: eve handed it a subagent-result flagged isError.
    const result = events.find((e) => e.type === "action.result").data.result;
    assert.equal(result.isError, true, "the recorded stream is not a failed delegation");
    await recordFailedDelegation(SPECIALIST, childSession, result.output.message, undefined, ORG);
    const row = await rowFor(key);
    check("the invocation is in the history at all", row !== null);
    check("filed against the specialist's workflow row", row.automationId === workflowId);
    check("in the workspace that owns it", row.orgId === ORG);
    check("as a terminal failure, not an open run", row.status === "failed");
    check("naming the cause eve reported", String(row.error).includes("Sandbox bootstrap failed"));
    check(
      "trimmed to a sentence a run feed can show — eve's own is 1,282 bytes of shell",
      row.error.length < 500,
    );
    // No turn ever ran, so there is no duration to report. Inventing
    // `now() - started_at` would publish a measurement nobody made.
    check("with no invented duration", row.durationMs === null);
    check("and keyed as the child's own first turn would have keyed it", row.runKey === key);
  }

  console.log("\n2. It cannot double-write when the child DOES start");
  {
    // The child starts normally, records its own row, and finishes. The parent
    // then records a failure for the same invocation — which is the ordering
    // that would produce two rows if the key were not shared.
    const childSession = "wrun_child_started_and_finished";
    const key = delegatedRunKey(workflowId, childSession);
    await openWorkflowRun(SPECIALIST, "turn_0", childSession, ORG);
    await recordWorkflowStep(SPECIALIST, "turn_0", { inputTokens: 11, outputTokens: 7 }, childSession, ORG);
    await finishWorkflowRun(SPECIALIST, "turn_0", { status: "success" }, childSession, ORG);
    const before = (await rows()).length;
    await recordFailedDelegation(SPECIALIST, childSession, "a late, wrong opinion about this run", undefined, ORG);
    const after = await rows();
    check("no second row appears", after.length === before);
    const row = await rowFor(key);
    check("the child's own outcome stands", row.status === "success");
    check("with its tokens intact", row.inputTokens === 11 && row.outputTokens === 7);
    check("and its own duration, not a null one", typeof row.durationMs === "number");
    check("and the parent's error never overwrote it", row.error === null);
  }

  console.log("\n3. And not in the other order either");
  {
    // The race the unique index actually has to settle: the parent's failure
    // lands FIRST (the child was slow to emit turn.started), then the child
    // starts anyway. Still one row.
    const childSession = "wrun_parent_first";
    const key = delegatedRunKey(workflowId, childSession);
    await recordFailedDelegation(SPECIALIST, childSession, "died before starting", undefined, ORG);
    const before = (await rows()).length;
    await openWorkflowRun(SPECIALIST, "turn_0", childSession, ORG);
    check("the child's open is a no-op", (await rows()).length === before);
    const row = await rowFor(key);
    check("and does not re-open a closed run", row.status === "failed");
  }

  console.log("\n4. The sweeper closes a run nobody will ever close");
  {
    // `session.failed` carries no turnId, so this row has no event that can
    // close it. Measured live: customer-b holds one exactly like it.
    const dead = "wrun_died_mid_turn";
    const deadKey = delegatedRunKey(workflowId, dead);
    await openWorkflowRun(SPECIALIST, "turn_0", dead, ORG);
    await backdate(deadKey, ABANDONED_RUN_MS + 60_000);

    // A run that started a minute ago is doing its job.
    const live = "wrun_still_working";
    const liveKey = delegatedRunKey(workflowId, live);
    await openWorkflowRun(SPECIALIST, "turn_0", live, ORG);

    // A run that ENDED long ago must not be touched a second time.
    const done = "wrun_finished_long_ago";
    const doneKey = delegatedRunKey(workflowId, done);
    await openWorkflowRun(SPECIALIST, "turn_0", done, ORG);
    await finishWorkflowRun(SPECIALIST, "turn_0", { status: "success" }, done, ORG);
    await backdate(doneKey, ABANDONED_RUN_MS + 60_000);

    const { closed } = await closeAbandonedWorkflowRuns();
    check("exactly one row is closed", closed === 1);
    const deadRow = await rowFor(deadKey);
    check("the abandoned one is now terminal", deadRow.status === "failed");
    check("and says it was never heard from again", deadRow.error === ABANDONED_RUN_ERROR);
    check("with no invented duration", deadRow.durationMs === null);
    check("the run that is minutes old is untouched", (await rowFor(liveKey)).status === "running");
    check("and a finished run is not re-closed", (await rowFor(doneKey)).status === "success");
    check("nor is its outcome overwritten", (await rowFor(doneKey)).error === null);
  }

  console.log("\n5. A run parked on a question is never swept, however old");
  {
    // THE ONE CASE A CLOCK CANNOT JUDGE. A specialist that asks a question
    // parks: its turn is open and its row is `running` for as long as nobody
    // answers — overnight, if that is how long the operator takes. Across six
    // live sessions (#42) EVERY declared specialist parked, so this is the
    // common shape, not the exotic one.
    const parked = "wrun_waiting_on_a_person";
    const parkedKey = delegatedRunKey(workflowId, parked);
    await openWorkflowRun(SPECIALIST, "turn_0", parked, ORG);
    await markDelegationParked(SPECIALIST, parked, ORG);
    await backdate(parkedKey, ABANDONED_RUN_MS * 10);

    check(
      "the open run says what it is waiting for",
      (await rowFor(parkedKey)).summary === AWAITING_ANSWER_SUMMARY,
    );
    const { closed } = await closeAbandonedWorkflowRuns();
    check("ten times the interval later it is still open", closed === 0 && (await rowFor(parkedKey)).status === "running");

    // Answered: it is no longer waiting on anyone, so it becomes sweepable
    // again. Without this the mark would exempt the row for ever and the leak
    // would simply move.
    await clearDelegationPark(SPECIALIST, parked, ORG);
    check("the mark is cleared when the delegation comes back", (await rowFor(parkedKey)).summary === null);
    const again = await closeAbandonedWorkflowRuns();
    check("and the clock applies again", again.closed === 1 && (await rowFor(parkedKey)).status === "failed");
  }

  console.log("\n6. The sweeper stays inside its own kind of run");
  {
    // A schedule, a system cron and a connector sync each write their row once,
    // when they finish. Only a workflow run is assembled from a stream of
    // events and can be left open, so only a workflow run is swept — a sweeper
    // that closed a cron's row would be inventing an outcome for a subsystem it
    // knows nothing about.
    await withOrgDb(ORG, (tx) =>
      tx.insert(automationRuns).values({
        orgId: ORG,
        automationType: "system_cron",
        automationId: "some-cron",
        status: "running",
        startedAt: new Date(Date.now() - ABANDONED_RUN_MS * 10),
        runKey: `cron-probe-${process.pid}`,
      }),
    );
    const { closed } = await closeAbandonedWorkflowRuns();
    check("a system cron's open row is not a subagent run", closed === 0);
    check(
      "and is left exactly as it was",
      (await rowFor(`cron-probe-${process.pid}`)).status === "running",
    );
  }

  console.log("\n7. Another workspace's runs are not swept out from under it");
  {
    // The sweep is cross-workspace by construction and runs per workspace
    // inside withOrgDb, so each workspace's rows are closed in its own scope.
    // What must not happen is one workspace's tick closing another's rows as a
    // side effect of a single unscoped statement.
    const other = `${ORG}-neighbour`;
    await db.insert(orgs).values({ orgId: other, name: "Neighbour", status: "active" });
    try {
      const key = `neighbour-probe-${process.pid}`;
      await withOrgDb(other, (tx) =>
        tx.insert(automationRuns).values({
          orgId: other,
          automationType: "workflow",
          automationId: workflowId,
          status: "running",
          startedAt: new Date(Date.now() - ABANDONED_RUN_MS * 10),
          runKey: key,
        }),
      );
      const { closed } = await closeAbandonedWorkflowRuns();
      check("the neighbour's abandoned run is swept too, in its own scope", closed === 1);
      const [row] = await withOrgDb(other, (tx) =>
        tx.select().from(automationRuns).where(eq(automationRuns.runKey, key)),
      );
      check("and it is the neighbour's own row that changed", row.status === "failed" && row.orgId === other);
    } finally {
      await withOrgDb(other, (tx) => tx.delete(automationRuns).where(eq(automationRuns.orgId, other)));
      await db.delete(orgs).where(eq(orgs.orgId, other));
    }
  }

  console.log("\n8. The same rows, recorded from the PARENT'S STREAM as the session guard serves it (mold_v1-129)");
  {
    // In eve 0.25.1 no authored hook receives `subagent.called` (test-subagent-delivery section 10), so the hook
    // that called the writers above never learned a child and never wrote a row. The guard's own pass over the
    // parent's stream does: the real stream wrapper (agent/lib/session-lineage-stream.ts) and the real recorder.
    const lineage = await import("../agent/lib/session-lineage-stream.ts");
    const recorderModule = await import("../agent/lib/session-delegation-runs.ts").catch((e) => ({ missing: String(e) }));
    check("there is a recorder the guard feeds from the stream", !recorderModule.missing);
    const { DELEGATION_EVENT_TYPES, delegationRunRecorder } = recorderModule;
    /** A recorded fixture as the NDJSON eve serves, its specialist renamed to this test's probe. */
    const ndjson = (name, rewrite = (e) => e) =>
      readFileSync(`scripts/fixtures/subagent-delivery/${name}.ndjson`, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const e = JSON.parse(line);
          if (e.type === "subagent.called") e.data.name = SPECIALIST;
          if (e.type === "action.result" && e.data?.result?.subagentName) e.data.result.subagentName = SPECIALIST;
          return JSON.stringify(rewrite(e));
        });
    /** Serve it the way the guard does — in arbitrary chunks — and drain it as a reader would. */
    const serve = async (parent, lines) => {
      const bytes = new TextEncoder().encode(lines.join("\n") + "\n");
      const upstream = new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 97) c.enqueue(bytes.slice(i, i + 97));
          c.close();
        },
      });
      const served = lineage.noticeDelegations(upstream, async () => {}, { eventTypes: DELEGATION_EVENT_TYPES, handle: delegationRunRecorder(parent, undefined, ORG) });
      return new Response(served).text();
    };

    // A child that died before turn.started, on a fresh child id so section 1's row is not what is found.
    const failedChild = `wrun_stream_fail_${process.pid}`;
    const fails = ndjson("child-fails", (e) => {
      if (e.data?.childSessionId) e.data.childSessionId = failedChild;
      return e;
    });
    const text = await serve(`parent-fail-${process.pid}`, fails);
    check("every byte of the stream still reaches the reader", text.trim().split("\n").length === fails.length);
    const failed = await rowFor(delegatedRunKey(workflowId, failedChild));
    check("the delegation that never started is in the history", failed !== null);
    check("as a failure, with eve's cause", failed?.status === "failed" && String(failed?.error).includes("Sandbox bootstrap failed"));
    const stamped = JSON.parse(fails.find((l) => l.includes('"action.result"'))).meta?.at;
    check("dated when eve reported it, not when the stream was read", stamped && failed?.startedAt?.toISOString() === new Date(stamped).toISOString());
    await serve(`parent-fail-${process.pid}`, fails);
    const all = (await rows()).filter((r) => r.runKey === delegatedRunKey(workflowId, failedChild));
    check("a second reader of the same stream (another tab, a replay) adds no second row", all.length === 1);

    // A child parked on a question: its own row is open, and must be marked as waiting from the parent's stream.
    const parkedChild = `wrun_stream_park_${process.pid}`;
    const parks = ndjson("child-parks-never-answered", (e) => {
      if (e.data?.childSessionId) e.data.childSessionId = parkedChild;
      return e;
    });
    await openWorkflowRun(SPECIALIST, "turn_0", parkedChild, ORG);
    await serve(`parent-park-${process.pid}`, parks);
    const parkedRow = await rowFor(delegatedRunKey(workflowId, parkedChild));
    check("a child parked on a question is marked as waiting, so the sweeper spares it", parkedRow?.summary === AWAITING_ANSWER_SUMMARY);
  }

  console.log("\n7. A run is filed in its OWN workspace, never in another's row of the same name");
  {
    // Two workspaces both have a specialist of this name. The lookup used to sweep every workspace for the NAME and
    // take the first match, so one workspace's runs landed in the other's history. Now the run's workspace is named.
    await db.insert(orgs).values({ orgId: ORG2, name: "Run history probe 2", status: "active" });
    const [wf2] = await withOrgDb(ORG2, (tx) =>
      tx.insert(workflows).values({ orgId: ORG2, name: SPECIALIST, description: "Same name, other workspace.", createdBy: "test-run-history-db" }).returning({ id: workflows.id }),
    );
    const other = `wrun_other_ws_${process.pid}`;
    await openWorkflowRun(SPECIALIST, "turn_0", other, ORG2);
    const inOther = await withOrgDb(ORG2, (tx) => tx.select().from(automationRuns).where(eq(automationRuns.orgId, ORG2)));
    check("a run in workspace 2 is filed under workspace 2's row", inOther.length === 1 && inOther[0].automationId === wf2.id, inOther.map((r) => r.automationId));
    check("…and nothing of it lands in workspace 1", !(await rows()).some((r) => r.runKey?.includes(other)));
    const nowhere = `wrun_no_ws_${process.pid}`;
    await openWorkflowRun(SPECIALIST, "turn_0", nowhere);
    const anywhere = [
      ...(await rows()),
      ...(await withOrgDb(ORG2, (tx) => tx.select().from(automationRuns).where(eq(automationRuns.orgId, ORG2)))),
    ];
    check("a run with no workspace named is recorded nowhere (not in whichever workspace has the name)", !anywhere.some((r) => r.runKey?.includes(nowhere)));
  }

  console.log("\n9. What a run costs: priced from its tokens at the model that served each step");
  {
    // Cloudflare Workers AI reports no cost, so a run on it used to read $0 with 200k tokens on it: the row was opened
    // at 0 and only a provider's figure was ever added. Each step is now priced at the model that served it, by the
    // function chat turns are priced with, and an unknown stays unknown.
    const { estimateCostUsd } = await import("../lib/inference-pricing.ts");
    const GLM = "@cf/zai-org/glm-5.3";
    const KIMI = "@cf/moonshotai/kimi-k2.6";
    const UNPRICED = "@cf/example/not-in-the-price-table";
    const s1 = { inputTokens: 120_000, outputTokens: 4_000, cacheReadTokens: 20_000 };
    const s2 = { inputTokens: 30_000, outputTokens: 1_500 };

    const priced = `wrun_cost_priced_${process.pid}`;
    await openWorkflowRun(SPECIALIST, "turn_0", priced, ORG);
    check("a run is opened at $0, not at unknown", (await rowFor(delegatedRunKey(workflowId, priced))).costUsd === 0);
    await recordWorkflowStep(SPECIALIST, "turn_0", s1, priced, ORG, GLM);
    let row = await rowFor(delegatedRunKey(workflowId, priced));
    const want1 = estimateCostUsd(GLM, s1);
    check(`a step on a Workers AI model gets a priced cost: $${want1} (it was $0)`, want1 > 0 && Math.abs(row.costUsd - want1) < 1e-9, row.costUsd);
    check("the row records the model that served the step, with its tokens", JSON.stringify(row.modelUsage) === JSON.stringify({ [GLM]: { steps: 1, input_tokens: 120000, output_tokens: 4000, cache_read_tokens: 20000, cache_write_tokens: 0 } }), row.modelUsage);

    // The empty-response fallback answers the next call on the other role's model: that step is ITS tokens, at ITS rate.
    await recordWorkflowStep(SPECIALIST, "turn_0", s2, priced, ORG, KIMI);
    await recordWorkflowStep(SPECIALIST, "turn_0", s2, priced, ORG, GLM);
    await finishWorkflowRun(SPECIALIST, "turn_0", { status: "success" }, priced, ORG);
    row = await rowFor(delegatedRunKey(workflowId, priced));
    const want = estimateCostUsd(GLM, s1) + estimateCostUsd(KIMI, s2) + estimateCostUsd(GLM, s2);
    check(`a run two models answered is priced per model: $${want.toFixed(4)}`, Math.abs(row.costUsd - want) < 1e-9, row.costUsd);
    check("…and keeps each model's share apart", row.modelUsage?.[GLM]?.steps === 2 && row.modelUsage[GLM].input_tokens === 150000 && row.modelUsage?.[KIMI]?.steps === 1 && row.modelUsage[KIMI].output_tokens === 1500, row.modelUsage);
    check("the row's own token totals are every step's", row.inputTokens === 180000 && row.outputTokens === 7000);

    const unpriced = `wrun_cost_unpriced_${process.pid}`;
    await openWorkflowRun(SPECIALIST, "turn_0", unpriced, ORG);
    await recordWorkflowStep(SPECIALIST, "turn_0", s2, unpriced, ORG, UNPRICED);
    row = await rowFor(delegatedRunKey(workflowId, unpriced));
    check("a step on a model with no price leaves the run's cost unknown (NULL), never $0", row.costUsd === null, row.costUsd);
    check("…and still records which model it was", row.modelUsage?.[UNPRICED]?.steps === 1, row.modelUsage);
    await recordWorkflowStep(SPECIALIST, "turn_0", s1, unpriced, ORG, GLM);
    row = await rowFor(delegatedRunKey(workflowId, unpriced));
    check("a later priced step does not turn the unknown into a partial figure", row.costUsd === null, row.costUsd);

    const unnamed = `wrun_cost_no_model_${process.pid}`;
    await openWorkflowRun(SPECIALIST, "turn_0", unnamed, ORG);
    await recordWorkflowStep(SPECIALIST, "turn_0", s2, unnamed, ORG);
    row = await rowFor(delegatedRunKey(workflowId, unnamed));
    check("a step whose model was not recorded, and no provider cost, is unknown too", row.costUsd === null && row.modelUsage === null, row);

    const reported = `wrun_cost_reported_${process.pid}`;
    await openWorkflowRun(SPECIALIST, "turn_0", reported, ORG);
    await recordWorkflowStep(SPECIALIST, "turn_0", { ...s1, costUsd: 0.5 }, reported, ORG, GLM);
    await recordWorkflowStep(SPECIALIST, "turn_0", { ...s2, costUsd: 0.25 }, reported, ORG, UNPRICED);
    row = await rowFor(delegatedRunKey(workflowId, reported));
    check("a cost the provider reports is kept as reported, whatever the price table says", Math.abs(row.costUsd - 0.75) < 1e-9, row.costUsd);
  }

  console.log("\n10. drizzle/0036_run_model_usage.sql: one nullable column, additive, the table's workspace boundary unchanged");
  if (!process.env.ADMIN_URL) {
    console.log("  (skipped — needs ADMIN_URL for the migration's own checks)");
  } else {
    const { default: postgres } = await import("postgres");
    const { join } = await import("node:path");
    const adminUrl = process.env.ADMIN_URL;
    const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
    const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
    const admin = postgres(adminUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
    try {
      const TAG = "0036_run_model_usage";
      const [col] = await admin`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'automation_runs' AND column_name = 'model_usage'`;
      check("automation_runs.model_usage exists: nullable jsonb with no default", col?.data_type === "jsonb" && col.is_nullable === "YES" && col.column_default === null);
      const journal = JSON.parse(readFileSync(join(ROOT, "drizzle/meta/_journal.json"), "utf8"));
      const at = journal.entries.findIndex((e) => e.tag === TAG);
      check(`the journal carries ${TAG}, numbered after the one before`, at > 0 && journal.entries[at].idx === journal.entries[at - 1].idx + 1);
      const statements = readFileSync(join(ROOT, `drizzle/${TAG}.sql`), "utf8").split("--> statement-breakpoint").map((v) => v.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
      check("it is additive: one nullable column added, nothing else altered, dropped, written or re-secured", statements.length === 1 && /^ALTER TABLE "automation_runs" ADD COLUMN IF NOT EXISTS "model_usage" jsonb;$/.test(statements[0]));
      const [cls] = await admin`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'automation_runs' AND relnamespace = 'public'::regnamespace`;
      const pol = await admin`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'automation_runs'`;
      check("automation_runs is still row-level secured and forced, under its org_isolation policy", cls?.relrowsecurity === true && cls.relforcerowsecurity === true && pol.some((p) => p.policyname === "org_isolation"));
      const before = JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM automation_runs x ORDER BY id`);
      let again = "ok";
      try { for (let i = 0; i < 2; i++) for (const x of statements) await admin.unsafe(x); } catch (e) { again = String(e?.message ?? e); }
      check("applying it twice more, over a table that holds runs, is harmless and changes no row", again === "ok" && JSON.stringify(await admin`SELECT to_jsonb(x) AS r FROM automation_runs x ORDER BY id`) === before, again);

      // The deploy's drift step against a database as the live ones are before 0036: the plan names the column and
      // only it; after the file, it plans nothing.
      const { driftPlan, kit } = await import("./lib/drift-plan.mjs");
      const SCRATCH = `runcost_${process.pid}`;
      const scratchUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${SCRATCH}`; return u.toString(); })();
      await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`);
      await admin.unsafe(`create database "${SCRATCH}"`);
      const sdb = postgres(scratchUrl, { ssl, prepare: false, max: 1, onnotice: () => {} });
      try {
        const pushed = kit(["push", "--force", "--verbose"], scratchUrl);
        check("a database built from schema.ts has the column", pushed.status === 0 && (await sdb`select 1 from information_schema.columns where table_name = 'automation_runs' and column_name = 'model_usage'`).length === 1);
        await sdb.unsafe('alter table "automation_runs" drop column "model_usage"');
        const pre = driftPlan(scratchUrl);
        check("before 0036 the drift plan against schema.ts names the column, and only it", !pre.error && pre.apply.length === 1 && /ADD COLUMN "model_usage" jsonb/.test(pre.apply[0]) && pre.refused.length === 0, pre.error ? pre : { apply: pre.apply, refused: pre.refused });
        await sdb.begin(async (tx) => { for (const x of statements) await tx.unsafe(x); });
        const post = driftPlan(scratchUrl);
        check("after 0036 the drift dry run plans NOTHING to apply, and refuses nothing", !post.error && post.apply.length === 0 && post.refused.length === 0, post.error ? post : { apply: post.apply, refused: post.refused });
      } finally {
        await sdb.end({ timeout: 2 });
        await admin.unsafe(`drop database if exists "${SCRATCH}" with (force)`).catch(() => {});
      }
    } finally {
      await admin.end({ timeout: 2 });
    }
  }

  console.log(`\ntest-run-history-db: ${passed} assertions passed`);
} finally {
  try {
    await withOrgDb(ORG2, (tx) => tx.delete(automationRuns).where(eq(automationRuns.orgId, ORG2))).catch(() => {});
    await withOrgDb(ORG2, (tx) => tx.delete(workflows).where(eq(workflows.orgId, ORG2))).catch(() => {});
    await db.delete(orgs).where(eq(orgs.orgId, ORG2)).catch(() => {});
    await withOrgDb(ORG, (tx) => tx.delete(automationRuns).where(eq(automationRuns.orgId, ORG)));
    await withOrgDb(ORG, (tx) => tx.delete(workflows).where(eq(workflows.orgId, ORG)));
    await db.delete(orgs).where(eq(orgs.orgId, ORG));
  } catch (error) {
    console.error("cleanup failed:", error);
  }
  await closeDb();
}
