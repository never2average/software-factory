/**
 * Fallback-path test for the durable dynamic-schedule rule engine
 * (agent/lib/schedule-store.ts + the create/list/update/delete_schedule tools).
 *
 * Runs with NO database URL, so the store uses the in-process fallback — no
 * Postgres connection is ever attempted. Asserts CRUD, the verified-caller
 * stamp, and THE LEASE: a due rule is claimed exactly once; completing a
 * recurring rule re-arms it; completing with an error still advances; an
 * expired lease is re-claimable; a one-time rule disables itself after it runs.
 *
 * Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/test-schedules.mjs
 */
import assert from "node:assert/strict";

// Force the fallback path: no DB URL.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const { getDb } = await import("../agent/lib/db/index.ts");
const store = await import("../agent/lib/schedule-store.ts");
const { createScheduleTool, listSchedulesTool, updateScheduleTool, deleteScheduleTool } =
  await import("../agent/lib/schedule-tools.ts");
const { orgForSession } = await import("../agent/lib/org-context.ts");

assert.equal(getDb(), null, "no DB URL is set, getDb() must return null (fallback path)");

store.__resetFallbackScheduleRules();

/**
 * Every store entry point is workspace-scoped: the tools resolve the workspace from the
 * caller's session and pass it down. These direct store calls must do the same, or they are
 * testing a signature the product no longer has.
 */
/** Fake eve session/tool context for a given authenticated teammate. */
const ctxFor = (email) => ({
  session: {
    id: "test-session",
    auth: {
      current: { principalId: email, principalType: "user", authenticator: "test", attributes: { email } },
      initiator: null,
    },
  },
  channel: { kind: "http" },
  messages: [],
});

const FDE_A = "operator@example.com";
const FDE_B = "operator@example.com";
const OTHER_ORG = "org-someone-else";

// --- create via tool: createdBy = ctx email, enabled, nextRunAt echoes ------

const ORG = await orgForSession(ctxFor(FDE_A));
assert.equal(typeof ORG, "string", "the tools resolve a workspace even with no database");

const firstRunAt = "2026-07-11T09:00:00Z";
const created = await createScheduleTool.execute(
  {
    name: "Acme weekly health check",
    prompt: "Summarize acme-bank open follow-ups and post the headline.",
    firstRunAt,
    everyMinutes: 1440,
    customerId: "acme-bank",
  },
  ctxFor(FDE_A),
);
assert.equal(created.created, true);
assert.equal(created.rule.createdBy, FDE_A, "createdBy comes from the verified caller, not the model");
assert.equal(created.rule.enabled, true, "new rules are enabled");
assert.equal(created.rule.kind, "prompt", "kind defaults to 'prompt'");
assert.equal(created.rule.customerId, "acme-bank");
assert.equal(created.rule.everyMinutes, 1440);
assert.equal(
  new Date(created.rule.nextRunAt).toISOString(),
  new Date(firstRunAt).toISOString(),
  "nextRunAt echoes firstRunAt",
);
const ruleId = created.rule.id;

// A second, team-wide, one-time rule (everyMinutes null default).
const teamRule = await createScheduleTool.execute(
  { name: "One-off reminder", prompt: "Ping the team once.", firstRunAt },
  ctxFor(FDE_B),
);
assert.equal(teamRule.rule.customerId, null, "omitted customerId => team-wide (null)");
assert.equal(teamRule.rule.everyMinutes, null, "everyMinutes defaults to null (one-time)");

// --- list + filter ----------------------------------------------------------

const all = await listSchedulesTool.execute({}, ctxFor(FDE_A));
assert.equal(all.rules.length, 2, "both rules are listed");

const acmeOnly = await listSchedulesTool.execute({ customerId: "acme-bank" }, ctxFor(FDE_A));
assert.deepEqual(
  acmeOnly.rules.map((r) => r.id),
  [ruleId],
  "customerId filter returns only that customer's rule",
);

const enabledOnly = await listSchedulesTool.execute({ enabled: true }, ctxFor(FDE_A));
assert.equal(enabledOnly.rules.length, 2, "both rules are enabled");

// --- update: enabled flip, everyMinutes change, updatedAt bump --------------

const beforeUpdate = created.rule.updatedAt;
const updated = await updateScheduleTool.execute(
  { id: ruleId, everyMinutes: 60, enabled: false },
  ctxFor(FDE_A),
);
assert.equal(updated.updated, true);
assert.equal(updated.rule.everyMinutes, 60, "everyMinutes changed");
assert.equal(updated.rule.enabled, false, "enabled flipped");
assert.ok(updated.rule.updatedAt >= beforeUpdate, "updatedAt bumped");
// re-enable and reset to daily for the lease tests below
await updateScheduleTool.execute({ id: ruleId, everyMinutes: 1440, enabled: true }, ctxFor(FDE_A));

// unknown id throws
await assert.rejects(
  updateScheduleTool.execute({ id: "00000000-0000-0000-0000-000000000000" }, ctxFor(FDE_A)),
  /not found/,
  "updating an unknown id throws",
);

// --- THE LEASE: a due rule is claimed exactly once --------------------------

store.__resetFallbackScheduleRules();
const now = new Date("2026-07-10T12:00:00Z");
const recurring = await store.createScheduleRule({
  orgId: ORG,
  name: "Every 30m sweep",
  prompt: "sweep",
  firstRunAt: now, // due exactly at `now`
  everyMinutes: 30,
  createdBy: FDE_A,
});

const firstClaim = await store.claimDueRules({ now });
assert.equal(firstClaim.length, 1, "the due rule is claimed on the first pass");
assert.equal(firstClaim[0].id, recurring.id);
assert.ok(firstClaim[0].leaseToken, "a lease token is stamped on the claim");

const secondClaim = await store.claimDueRules({ now });
assert.deepEqual(secondClaim, [], "the same rule is NOT claimed again within the lease window");

// --- completeRule on a recurring rule advances nextRunAt & clears the lock --

const ranAt = new Date("2026-07-10T12:00:05Z");
await store.completeRule(firstClaim[0], { ranAt });
const afterComplete = (await store.listScheduleRules(ORG))[0];
assert.equal(
  new Date(afterComplete.nextRunAt).toISOString(),
  new Date(ranAt.getTime() + 30 * 60_000).toISOString(),
  "recurring rule advances nextRunAt by everyMinutes from ranAt",
);
assert.equal(afterComplete.lockedAt, null, "the lock is cleared after complete");
assert.equal(afterComplete.leaseToken, null, "the lease token is cleared after complete");
assert.equal(afterComplete.lastError, null, "a clean run records no error");
assert.equal(
  new Date(afterComplete.lastRunAt).toISOString(),
  ranAt.toISOString(),
  "lastRunAt records the run time",
);

// It is not due again at `now` (it advanced 30m into the future).
assert.deepEqual(await store.claimDueRules({ now }), [], "advanced rule is no longer due at `now`");

// --- a rule completed WITH an error still advances and records lastError -----

const dueAgain = new Date(afterComplete.nextRunAt);
const claimAgain = await store.claimDueRules({ now: dueAgain });
assert.equal(claimAgain.length, 1, "the rule is due again at its advanced nextRunAt");
await store.completeRule(claimAgain[0], { ranAt: dueAgain, error: "slack delivery failed: channel unwired" });
const afterError = (await store.listScheduleRules(ORG))[0];
assert.equal(afterError.lastError, "slack delivery failed: channel unwired", "delivery error is recorded");
assert.equal(
  new Date(afterError.nextRunAt).toISOString(),
  new Date(dueAgain.getTime() + 30 * 60_000).toISOString(),
  "a run completed with an error still advances the schedule (no hot-loop)",
);
assert.equal(afterError.lockedAt, null, "lock cleared even on an error-completed run");

// --- expired lease is re-claimable ------------------------------------------

store.__resetFallbackScheduleRules();
const leaseForMs = 5 * 60_000;
const t0 = new Date("2026-07-10T12:00:00Z");
const leaseRule = await store.createScheduleRule({
  orgId: ORG,
  name: "lease-test",
  prompt: "x",
  firstRunAt: t0,
  everyMinutes: 15,
  createdBy: FDE_A,
});
const claimA = await store.claimDueRules({ now: t0, leaseForMs });
assert.equal(claimA.length, 1, "claimed once");
// still locked within the window
assert.deepEqual(
  await store.claimDueRules({ now: new Date(t0.getTime() + 60_000), leaseForMs }),
  [],
  "not re-claimable while the lease is live",
);
// lease expires: claim after leaseForMs + 1min
const claimB = await store.claimDueRules({
  now: new Date(t0.getTime() + leaseForMs + 60_000),
  leaseForMs,
});
assert.equal(claimB.length, 1, "an expired lease is recoverable");
assert.equal(claimB[0].id, leaseRule.id);
assert.notEqual(claimB[0].leaseToken, claimA[0].leaseToken, "re-claim stamps a fresh lease token");
// a stale worker (claimA) completing after re-claim is a no-op
await store.completeRule(claimA[0], { ranAt: new Date(t0.getTime() + 30_000) });
const stillLocked = (await store.listScheduleRules(ORG))[0];
assert.equal(stillLocked.leaseToken, claimB[0].leaseToken, "stale-lease complete did NOT clobber the new holder");

// --- one-time rule is disabled after complete -------------------------------

store.__resetFallbackScheduleRules();
const oneShot = await store.createScheduleRule({
  orgId: ORG,
  name: "one-shot",
  prompt: "run once",
  firstRunAt: t0,
  everyMinutes: null,
  createdBy: FDE_A,
});
const oneClaim = await store.claimDueRules({ now: t0 });
assert.equal(oneClaim.length, 1);
await store.completeRule(oneClaim[0], { ranAt: t0 });
const afterOneShot = (await store.listScheduleRules(ORG, { enabled: false }))[0];
assert.equal(afterOneShot.id, oneShot.id, "one-time rule is now disabled");
assert.equal(afterOneShot.enabled, false, "one-time rule flips to enabled=false after it runs");
assert.deepEqual(
  await store.claimDueRules({ now: new Date(t0.getTime() + 10 * 60_000) }),
  [],
  "a disabled one-time rule is never claimed again",
);

// --- releaseRule re-arms to retryAt without advancing recurrence ------------

store.__resetFallbackScheduleRules();
const relRule = await store.createScheduleRule({
  orgId: ORG,
  name: "release-test",
  prompt: "x",
  firstRunAt: t0,
  everyMinutes: 60,
  createdBy: FDE_A,
});
const relClaim = await store.claimDueRules({ now: t0 });
const retryAt = new Date(t0.getTime() + 15 * 60_000);
await store.releaseRule(relClaim[0], { error: new Error("boom"), retryAt });
const afterRelease = (await store.listScheduleRules(ORG))[0];
assert.equal(afterRelease.id, relRule.id);
assert.equal(afterRelease.lockedAt, null, "release clears the lock");
assert.equal(afterRelease.lastError, "boom", "release records String(error.message)");
assert.equal(
  new Date(afterRelease.nextRunAt).toISOString(),
  retryAt.toISOString(),
  "release re-arms nextRunAt to retryAt (does not advance recurrence)",
);

// --- delete returns true then false -----------------------------------------

assert.equal(await store.deleteScheduleRule(ORG, relRule.id), true, "delete removes the rule");
assert.equal(await store.deleteScheduleRule(ORG, relRule.id), false, "deleting a missing rule returns false");

// delete via tool (uuid-validated input)
store.__resetFallbackScheduleRules();
const toDelete = await store.createScheduleRule({
  orgId: ORG,
  name: "del", prompt: "x", firstRunAt: t0, everyMinutes: null, createdBy: FDE_A,
});
const del = await deleteScheduleTool.execute({ id: toDelete.id }, ctxFor(FDE_A));
assert.equal(del.deleted, true, "delete tool removes the rule");

// --- the fallback map is workspace-scoped, exactly like the table ------------
// Before orgId reached FallbackRule this was unreachable code: creating a rule without a
// database threw on the schema. It is also the property the database branch has always
// enforced with `eq(scheduleRules.orgId, orgId)`, and the fallback silently did not.
store.__resetFallbackScheduleRules();
const mine = await store.createScheduleRule({
  orgId: ORG, name: "mine", prompt: "x", firstRunAt: t0, everyMinutes: null, createdBy: FDE_A,
});
assert.equal(mine.orgId, ORG, "a rule created without a database still records its workspace");
assert.deepEqual(
  await store.listScheduleRules(OTHER_ORG),
  [],
  "another workspace cannot list this rule",
);
assert.equal(
  await store.deleteScheduleRule(OTHER_ORG, mine.id),
  false,
  "another workspace cannot delete this rule by id",
);
await assert.rejects(
  store.updateScheduleRule(OTHER_ORG, mine.id, { name: "stolen" }),
  /not found/,
  "another workspace cannot update this rule, and is told NOT FOUND rather than forbidden",
);
assert.equal(
  (await store.listScheduleRules(ORG)).length,
  1,
  "the owning workspace still sees its rule after all of that",
);

assert.equal(getDb(), null, "still no DB connection after the whole flow");

console.log("test-schedules: all assertions passed (fallback path, no Postgres).");
