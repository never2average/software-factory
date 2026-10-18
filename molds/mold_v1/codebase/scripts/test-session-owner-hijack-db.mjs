/**
 * NOBODY BECOMES THE OWNER OF SOMEONE ELSE'S OLD SESSION BY FILING A ROW FOR IT (mold_v1-293), against a real Postgres
 * as app_rw under row-level security.
 *
 * The hole: for a session with no owner record (older than #66), the agent's guard froze the owner its legacy inference
 * named (agent/lib/session-guard.ts `ownershipOf` → lib/session-gate.ts `readLegacyOwnershipIn`), and that inference
 * took the name from the session's THREAD rows first. POST /api/ops/threads wrote a thread owned by the caller for any
 * session id they named. So a colleague could file a thread on Alice's old session, be frozen in as its owner on the
 * next pass of the guard, read it, and lock Alice out.
 *
 *  1. Filing: a colleague naming Alice's old session is refused (`callerOwnsSession`, which both thread routes call
 *     before they write); Alice is not.
 *  2. Inference: a thread (or a chat row) the colleague filed never names an owner: Alice's old session stays Alice's
 *     (her scope row and her own row agree); the colleague is refused, Alice admitted.
 *  3. Only browser evidence: no scope row naming anyone, or a scope row naming someone no row of theirs agrees with,
 *     leaves the session UNOWNED and refused to everyone — the guard has nothing to freeze, and nor has the factory's
 *     cross-workspace backfill. A workflow step stays workspace-visible, read-only, with no owner named by a thread.
 *  4. The audit (scripts/audit-session-owners.mjs) lists a record frozen the old way, and writes nothing.
 *
 * Run:  ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:session-owner-hijack-db
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-session-owner-hijack-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
let passed = 0;
const failed = [];
const check = (label, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
};

const STAMP = Date.now();
const ORG = `hj-probe-${STAMP}`;
const ALICE = "alice@probe.example"; // the real owner of the old sessions
const MALLORY = "mallory@probe.example"; // a colleague in the same workspace
const S = (name) => `wrun_HJ_${name}_${STAMP}`;
const OLD = S("old"); // Alice's old chat: her scope row and her chat-list row
const BARE = S("bare"); // only browser rows: no scope row at all
const NOPRINCIPAL = S("noprincipal"); // a scope row naming nobody, and browser rows
const POISONED = S("poisoned"); // a scope row naming MALLORY (last writer won before first-writer-wins), Alice's chat row
const STEP = S("step"); // a workflow step, on which Mallory filed a thread
const FROZEN = S("frozen"); // a record frozen the OLD way: Mallory, from her thread
const ALL = [OLD, BARE, NOPRINCIPAL, POISONED, STEP, FROZEN];

const { closeDb, withOrgDb } = await import("../agent/lib/db/index.ts");
const { agentGateDb } = await import("../agent/lib/session-owners.ts");
const gate = await import("../lib/session-gate.ts");
const { sessionGateDecision } = await import("../lib/chat-gate.ts");
const { inferAcrossWorkspaces, agentSystemGateDb } = await import("../agent/lib/session-owner-backfill.ts");
const { auditWorkspace } = await import("../agent/lib/session-owner-audit.ts");
const here = { inOrg: (o, fn) => withOrgDb(o, fn) };

/** The guard's own decision for `who` on `sid`, with the ownership the guard would read (and freeze) in ORG. */
const decide = async (sid, who, right = "read") => {
  const db = agentGateDb();
  const ownership = await gate.readOwnership(db, sid, ORG);
  const caller = { kind: "person", email: who };
  const facts = await gate.readCallerFacts(db, caller, sid, ownership, [ORG]);
  const d = sessionGateDecision({ caller, sessionId: sid, right, ownership, membership: facts.membership, callerInWorkspace: facts.callerInWorkspace, localDevAllowed: false });
  return { allow: d.allow, owner: ownership?.ownerEmail ?? null, visibility: ownership?.visibility ?? null };
};
const thread = (sid, owner, ago = "1 hour") =>
  admin`insert into chat_threads (org_id, eve_session_id, title, owner_email, created_at) values (${ORG}, ${sid}, 'probe', ${owner}, now() - ${ago}::interval)`;
const chatRow = (sid, owner) =>
  admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${`${sid}-${owner}`}, ${ORG}, ${owner}, ${sid}, 'old chat')`;
const scope = (sid, principal) => admin`insert into agent_session_scopes (session_id, org_id, principal_email) values (${sid}, ${ORG}, ${principal})`;
const recorded = async (sid) => (await admin`select owner_email from agent_session_owners where session_id = ${sid}`)[0] ?? null;

const cleanup = async () => {
  await admin`delete from chat_threads where org_id = ${ORG}`.catch(() => {});
  await admin`delete from chat_sessions where org_id = ${ORG}`.catch(() => {});
  await admin`delete from agent_session_scopes where org_id = ${ORG}`.catch(() => {});
  await admin`delete from agent_session_owners where org_id = ${ORG}`.catch(() => {});
  await admin`delete from workflow_run_journal where org_id = ${ORG}`.catch(() => {});
  await admin`delete from org_members where org_id = ${ORG}`.catch(() => {});
  await admin`delete from orgs where org_id = ${ORG}`.catch(() => {});
};

try {
  await cleanup();
  await admin`insert into orgs (org_id, name) values (${ORG}, 'probe') on conflict do nothing`.catch(() => {});
  for (const who of [ALICE, MALLORY]) await admin`insert into org_members (org_id, email, role) values (${ORG}, ${who}, 'member') on conflict do nothing`;
  await scope(OLD, ALICE);
  await chatRow(OLD, ALICE);

  console.log("1. Filing a thread on someone else's old session:");
  check("the colleague may not file a thread on Alice's old session (the routes' check)", !(await gate.callerOwnsSession(here, ORG, OLD, MALLORY)));
  check("…Alice may", await gate.callerOwnsSession(here, ORG, OLD, ALICE));
  check("…nobody may for a session id nobody holds", !(await gate.callerOwnsSession(here, ORG, S("ghost"), ALICE)));
  const share = readFileSync("app/api/ops/threads/route.ts", "utf8");
  const post = share.slice(share.indexOf("export async function POST"), share.indexOf("export async function GET"));
  check(
    "POST /api/ops/threads checks the caller owns the session before it writes a thread",
    post.indexOf("callerOwnsSession(") > 0 && post.indexOf("callerOwnsSession(") < post.indexOf(".insert(chatThreads)") && post.indexOf("callerOwnsSession(") < post.indexOf(".update(chatThreads)"),
  );
  const one = readFileSync("app/api/ops/threads/[id]/route.ts", "utf8");
  const patch = one.slice(one.indexOf("export async function PATCH"), one.indexOf("export async function DELETE"));
  check(
    "PATCH /api/ops/threads/:id moves a thread to another session only for a session its owner owns",
    patch.indexOf("callerOwnsSession(") > 0 && patch.indexOf("callerOwnsSession(") < patch.indexOf(".update(chatThreads)") && /access\.role === "owner"/.test(patch),
  );

  console.log("\n2. A thread the colleague filed anyway (as the old route allowed) names nobody:");
  await thread(OLD, MALLORY);
  const old = await decide(OLD, MALLORY);
  check("the colleague is not inferred the owner, and is refused", !old.allow && old.owner === ALICE, old);
  check("…so nothing the guard would freeze names her", (await gate.readLegacyOwnershipIn(here, ORG, OLD))?.ownerEmail === ALICE);
  check("…nor can she now file anything: her own thread does not make the session hers", !(await gate.callerOwnsSession(here, ORG, OLD, MALLORY)));
  const alice = await decide(OLD, ALICE);
  check("Alice still gets in: her scope row and her own chat row agree", alice.allow && alice.owner === ALICE, alice);
  check("…writes too", (await decide(OLD, ALICE, "write")).allow);
  const sys = agentSystemGateDb();
  check("the factory's cross-workspace backfill names Alice, never the colleague", (await inferAcrossWorkspaces(sys, OLD))?.ownerEmail === ALICE);

  console.log("\n3. Sessions with only browser evidence stay unowned:");
  await chatRow(BARE, ALICE);
  await thread(BARE, MALLORY);
  const bare = await decide(BARE, MALLORY);
  check("no scope row: the colleague's thread makes her nothing (refused)", !bare.allow && bare.owner === null, bare);
  check("…and Alice's chat row makes her nothing either (refused, unowned)", !(await decide(BARE, ALICE)).allow);
  check("…the cross-workspace backfill leaves it unowned (nothing to record)", (await inferAcrossWorkspaces(sys, BARE)) === null);

  await scope(NOPRINCIPAL, null);
  await thread(NOPRINCIPAL, MALLORY);
  await chatRow(NOPRINCIPAL, MALLORY);
  const np = await gate.readLegacyOwnershipIn(here, ORG, NOPRINCIPAL);
  check("a scope row naming nobody: her thread and her chat row name no owner", np === null, np);
  check("…she is refused", !(await decide(NOPRINCIPAL, MALLORY)).allow);

  await scope(POISONED, MALLORY);
  await chatRow(POISONED, ALICE);
  check("a scope row naming the colleague, with no row of hers: no owner", (await gate.readLegacyOwnershipIn(here, ORG, POISONED)) === null);
  check("…she is refused", !(await decide(POISONED, MALLORY)).allow);
  check("…and may not file the thread that would agree with it", !(await gate.callerOwnsSession(here, ORG, POISONED, MALLORY)));
  check("…Alice's chat row alone does not name Alice over the scope row either (unowned, refused)", !(await decide(POISONED, ALICE)).allow);

  await scope(STEP, null);
  await admin`insert into workflow_run_journal (org_id, run_id, call_index, prompt, status, session_id) values (${ORG}, ${`wfr_hj_${STAMP}`}, 0, 'summarise', 'completed', ${STEP})`;
  await thread(STEP, MALLORY);
  const step = await decide(STEP, MALLORY);
  check("a workflow step: workspace-visible, and the colleague's thread names no owner", step.allow && step.owner === null && step.visibility === "workspace", step);
  check("…she may read it, never write to it", !(await decide(STEP, MALLORY, "write")).allow);
  check("…nor file a thread on it", !(await gate.callerOwnsSession(here, ORG, STEP, MALLORY)));

  check("none of these sessions got an owner record", (await Promise.all([OLD, BARE, NOPRINCIPAL, POISONED, STEP].map(recorded))).every((r) => r === null));

  console.log("\n4. The audit lists what the old rule froze, and writes nothing:");
  await scope(FROZEN, ALICE);
  await chatRow(FROZEN, ALICE);
  await thread(FROZEN, MALLORY, "2 hours");
  await admin`insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility) values (${FROZEN}, ${ORG}, ${MALLORY}, 'person', 'owner')`;
  const before = await admin`select (select count(*)::int from agent_session_owners) as o, (select count(*)::int from chat_threads) as t, (select count(*)::int from agent_session_scopes) as s`;
  const findings = await auditWorkspace(sys, ORG);
  const after = await admin`select (select count(*)::int from agent_session_owners) as o, (select count(*)::int from chat_threads) as t, (select count(*)::int from agent_session_scopes) as s`;
  const of = (sid) => findings.filter((f) => f.sessionId === sid);
  check("a record naming the colleague where the scope row names Alice is listed as `disagrees`", of(FROZEN).length === 1 && of(FROZEN)[0].kind === "disagrees" && of(FROZEN)[0].recordedOwner === MALLORY && of(FROZEN)[0].scopePrincipal === ALICE, of(FROZEN));
  check("the colleague's thread on Alice's unrecorded session is listed as `unrecorded-claims`", of(OLD).length === 1 && of(OLD)[0].kind === "unrecorded-claims", of(OLD));
  check("…as is a session whose scope row names someone other than its rows do, and one two people's rows claim", of(POISONED).length === 1 && of(BARE).length === 1, { POISONED: of(POISONED), BARE: of(BARE) });
  check("…but not one only one person's rows name with no scope person to compare (the ordinary unanchored chat)", of(NOPRINCIPAL).length === 0 && of(STEP).length === 0);
  check("the audit changed nothing", JSON.stringify(before) === JSON.stringify(after), { before, after });
  let refusedWrite = false;
  try {
    await sys.inOrg(ORG, async (tx) => {
      const { sql } = await import("drizzle-orm");
      await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`delete from agent_session_owners where session_id = ${FROZEN}`);
    });
  } catch {
    refusedWrite = true;
  }
  check("…its transactions are read-only (a write inside one fails)", refusedWrite && (await recorded(FROZEN))?.owner_email === MALLORY);
} catch (e) {
  check(`the run completed (${String(e?.stack ?? e).slice(0, 400)})`, false);
} finally {
  await cleanup();
  void ALL;
  await closeDb().catch(() => {});
  await admin.end({ timeout: 5 });
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
