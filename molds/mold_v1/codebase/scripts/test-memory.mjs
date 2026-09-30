/**
 * Fallback-path test for multi-player long-term memory
 * (agent/lib/memory-store.ts + the remember/list_memories/forget tools +
 * the turn.started dynamic-instructions recall in agent/instructions/memory.ts).
 *
 * Runs with NO database URL, so the store uses the in-process fallback — no
 * Postgres connection is ever attempted. Asserts:
 *   1. a fact stored via `remember` is returned by `list_memories`;
 *   2. a fresh turn's recall (the turn.started resolver) injects team
 *      memories always, and customer/person memories when the entity is
 *      named in the turn — for a DIFFERENT teammate than the author
 *      (multi-player);
 *   3. `forget` removes the fact from both listing and recall.
 *
 * Usage: npm run test:memory
 */
import assert from "node:assert/strict";

// Force the fallback path: no DB URL.
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const { getDb } = await import("../agent/lib/db/index.ts");
const store = await import("../agent/lib/memory-store.ts");
const { rememberTool, listMemoriesTool, forgetTool } = await import("../agent/lib/memory-tools.ts");
const recall = (await import("../agent/instructions/memory.ts")).default;

assert.equal(getDb(), null, "no DB URL is set, getDb() must return null (fallback path)");
assert.equal(typeof recall.events["turn.started"], "function", "recall resolver subscribes to turn.started");

/** Fake eve session/tool context for a given authenticated teammate. */
const ctxFor = (email, messages = []) => ({
  session: {
    id: "test-session",
    auth: {
      current: { principalId: email, principalType: "user", authenticator: "test", attributes: { email } },
      initiator: null,
    },
  },
  channel: { kind: "http" },
  messages,
});

/** Run the turn.started dynamic-instructions resolver for one user turn. */
async function recallForTurn(email, userText) {
  return recall.events["turn.started"](
    { type: "turn.started" },
    ctxFor(email, [{ role: "user", content: userText }]),
  );
}

const PERSON_A = "priyesh@onfinance.in";
const PERSON_B = "lena@onfinance.in";

// --- remember: team, customer, and person scoped facts (saved by member A) ----

const teamFact = await rememberTool.execute(
  { scope: "team", key: "standup-time", value: "Daily stand-up is 09:30 IST, capped at 30 minutes." },
  ctxFor(PERSON_A),
);
assert.equal(teamFact.saved, true);
assert.equal(teamFact.memory.scope, "team");
assert.equal(teamFact.memory.authorEmail, PERSON_A);
assert.equal(teamFact.memory.version, 1);

await rememberTool.execute(
  { scope: "customer:acme-bank", key: "deploy-window", value: "Acme Bank only allows production deploys on Tuesdays 06:00-08:00 UTC." },
  ctxFor(PERSON_A),
);
await rememberTool.execute(
  { scope: "customer:northwind-cap", key: "escalation-path", value: "Northwind escalations go straight to Alex Kim, never the shared inbox." },
  ctxFor(PERSON_A),
);
await rememberTool.execute(
  { scope: "person:sam@acmebank.com", key: "comm-preference", value: "Sam Cole (CISO) wants security findings by encrypted email only." },
  ctxFor(PERSON_A),
);

// --- list_memories: stored facts come back (for a DIFFERENT teammate) -------

const all = await listMemoriesTool.execute({}, ctxFor(PERSON_B));
assert.equal(all.memories.length, 4, "all four memories are listed");
assert.ok(
  all.memories.some((m) => m.scope === "team" && m.key === "standup-time" && m.value.includes("09:30 IST")),
  "the remembered team fact is returned by list_memories",
);

const acmeOnly = await listMemoriesTool.execute({ scope: "customer:acme-bank" }, ctxFor(PERSON_B));
assert.deepEqual(
  acmeOnly.memories.map((m) => m.key),
  ["deploy-window"],
  "scope filter returns only that scope's memories",
);

// --- remember same (scope, key) updates in place ----------------------------

const updated = await rememberTool.execute(
  { scope: "team", key: "standup-time", value: "Daily stand-up moved to 09:00 IST." },
  ctxFor(PERSON_B),
);
assert.equal(updated.memory.version, 2, "re-remembering bumps the version");
assert.equal(updated.memory.authorEmail, PERSON_B, "the latest author is recorded");
assert.equal(
  (await listMemoriesTool.execute({ scope: "team" }, ctxFor(PERSON_A))).memories.length,
  1,
  "upsert did not duplicate the team fact",
);

// --- fresh-turn recall: turn.started injects team + named-entity memories ---

// Turn naming acme-bank by id (from teammate B, who never saved the fact).
let injected = await recallForTurn(PERSON_B, "Prep me for the acme-bank deploy tomorrow.");
assert.ok(injected, "recall produced instructions");
assert.match(injected.markdown, /09:00 IST/, "team memory is always recalled");
assert.match(injected.markdown, /Tuesdays 06:00-08:00 UTC/, "acme-bank memory recalled when named by id");
assert.doesNotMatch(injected.markdown, /Alex Kim/, "northwind memory NOT recalled when unnamed");

// Turn naming the customer by display name, not id.
injected = await recallForTurn(PERSON_B, "Anything I should know before the Northwind Capital QBR?");
assert.match(injected.markdown, /Alex Kim/, "customer memory recalled when named by display name");
assert.doesNotMatch(injected.markdown, /Tuesdays 06:00-08:00 UTC/, "acme memory NOT recalled when unnamed");

// Turn naming a person by name (memory is keyed by their email).
injected = await recallForTurn(PERSON_B, "Drafting the pen-test summary for Sam Cole — anything to keep in mind?");
assert.match(injected.markdown, /encrypted email only/, "person memory recalled when named by name");

// Turn naming nobody: only team memories.
injected = await recallForTurn(PERSON_B, "What is on my plate today?");
assert.match(injected.markdown, /09:00 IST/);
assert.doesNotMatch(injected.markdown, /Tuesdays 06:00-08:00 UTC|Alex Kim|encrypted email only/);

// --- forget removes the fact from listing AND recall -------------------------

const forgotten = await forgetTool.execute({ scope: "customer:acme-bank", key: "deploy-window" }, ctxFor(PERSON_A));
assert.equal(forgotten.deleted, true);
assert.equal(
  (await forgetTool.execute({ scope: "customer:acme-bank", key: "deploy-window" }, ctxFor(PERSON_A))).deleted,
  false,
  "forgetting a missing memory reports deleted: false",
);
assert.equal(
  (await listMemoriesTool.execute({ scope: "customer:acme-bank" }, ctxFor(PERSON_A))).memories.length,
  0,
  "forgotten memory is gone from list_memories",
);
injected = await recallForTurn(PERSON_A, "Prep me for the acme-bank deploy tomorrow.");
assert.doesNotMatch(injected.markdown, /Tuesdays 06:00-08:00 UTC/, "forgotten memory is no longer recalled");
assert.match(injected.markdown, /09:00 IST/, "other memories still recalled");

// --- scope validation --------------------------------------------------------

await assert.rejects(
  store.rememberMemory({ scope: "customer:", key: "x", value: "y", authorEmail: PERSON_A }),
  /Scope must be/,
  "malformed scope strings are rejected",
);

assert.equal(getDb(), null, "still no DB connection after the whole flow");

console.log("test-memory: all assertions passed (fallback path, no Postgres).");
