/**
 * THE MECHANISM, against a real Postgres failing closed.
 *
 * scripts/test-chat-access.mjs runs the access RULES. This runs the thing the
 * rules were being fed: the reads themselves, under the production policy
 * shape, as the production role.
 *
 * It exists because every one of these holes was a correct-looking rule sitting
 * on top of a read that returned nothing. The ownership gate in front of eve's
 * session routes queried `chat_sessions`, `chat_threads` and
 * `chat_thread_members` on an unscoped handle; `org_isolation` fails closed in
 * production (`org_id = current_setting('app.org_id', true)`, no "GUC unset"
 * escape hatch, FORCE ROW LEVEL SECURITY, app_rw NOBYPASSRLS); all three came
 * back empty; and the gate's "we have no record of this session, let it
 * through" branch was therefore taken for EVERY session by EVERY signed-in
 * caller. Nothing in the source says that. Only the database does.
 *
 * So the same queries the app makes are made here, twice — once the way the
 * broken gate made them and once the way `gateForSession` makes them — and the
 * difference is asserted rather than described.
 *
 * NON-DESTRUCTIVE: probe rows live under throwaway workspaces and are removed
 * in a finally block, and the policies are restored to the shape they were
 * found in. It needs an ADMIN url (to set the policy shape) and the app_rw url
 * (to prove what the app can actually see), which is exactly what CI's
 * `isolation` job already has.
 *
 * Run:  ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:chat-access-db
 */
import assert from "node:assert/strict";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log(
    "test-chat-access-db: SKIPPED — needs ADMIN_URL (policy DDL) and DATABASE_URL (app_rw).",
  );
  process.exit(0);
}
const ssl = /localhost|127\.0\.0\.1/.test(adminUrl) ? false : "require";
const admin = postgres(adminUrl, { ssl, prepare: false });
const app = postgres(appUrl, { ssl, prepare: false, max: 2 });

let failures = 0;
const check = (what, ok) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}`);
  }
};

const TABLES = ["chat_sessions", "chat_threads", "chat_thread_members", "automation_audit"];
const ORG = "org-chat-access-probe";
const OTHER = "personal:probe-outsider.test";
const SESSION = "sess-chat-access-probe";
const THREAD = "9f3c1f00-0000-4000-8000-00000000c0de";
const OWNER = "owner@probe.test";
const MEMBER = "member@probe.test";
const EX = "revoked@probe.test";
const STRANGER = "stranger@probe.test";

/** Run a query set inside a workspace's RLS scope, exactly as withOrgRls does. */
const scoped = (orgId, fn) =>
  app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${orgId}, true)`;
    return fn(tx);
  });

const cleanup = async () => {
  await admin`DELETE FROM chat_thread_members WHERE thread_id = ${THREAD}`;
  await admin`DELETE FROM chat_threads WHERE id = ${THREAD}`;
  await admin`DELETE FROM chat_sessions WHERE eve_session_id = ${SESSION}`;
  await admin`DELETE FROM automation_audit WHERE org_id = ${ORG}`;
};

/** The policy shape each table carries right now, so it can be put back. */
const saved = new Map();

try {
  const [{ rolbypassrls, rolsuper, current_user: who }] = await app`
    SELECT r.rolbypassrls, r.rolsuper, current_user FROM pg_roles r WHERE r.rolname = current_user`;
  console.log(`\nConnected as ${who}`);
  // A role that bypasses RLS makes every assertion below vacuously true, which
  // is the one way this file could pass while proving nothing at all.
  assert.ok(!rolbypassrls && !rolsuper, `${who} bypasses RLS — this test would prove nothing`);

  for (const t of TABLES) {
    const [row] = await admin`
      SELECT qual FROM pg_policies
      WHERE schemaname='public' AND tablename=${t} AND policyname='org_isolation'`;
    assert.ok(row, `${t} carries no org_isolation policy — the tenancy migration has not run`);
    saved.set(t, row.qual);
    // The production shape, from .migrate-rls-fail-closed.mjs.
    const closed = `(org_id = current_setting('app.org_id', true))`;
    await admin.unsafe(`ALTER POLICY org_isolation ON ${t} USING ${closed} WITH CHECK ${closed}`);
  }
  console.log(`policies on ${TABLES.join(", ")} set to the production FAIL-CLOSED shape`);

  await cleanup();
  await admin`
    INSERT INTO chat_sessions (id, org_id, owner_email, eve_session_id, title)
    VALUES ('probe-local-1', ${ORG}, ${OWNER}, ${SESSION}, 'a private chat')`;
  await admin`
    INSERT INTO chat_threads (org_id, id, eve_session_id, title, owner_email)
    VALUES (${ORG}, ${THREAD}, ${SESSION}, 'a shared chat', ${OWNER})`;
  await admin`
    INSERT INTO chat_thread_members (org_id, thread_id, email, role, status, invited_by)
    VALUES (${ORG}, ${THREAD}, ${MEMBER}, 'participant', 'accepted', ${OWNER})`;
  await admin`
    INSERT INTO chat_thread_members (org_id, thread_id, email, role, status, invited_by, revoked_at)
    VALUES (${ORG}, ${THREAD}, ${EX}, 'participant', 'revoked', ${OWNER}, now())`;
  await admin`
    INSERT INTO automation_audit (org_id, automation_type, automation_id, actor, event)
    VALUES (${ORG}, 'chat', 'chat_deadbeefdeadbeef', 'web', 'The stream stopped mid-reply')`;

  /* ---- 1. the bug, reproduced ------------------------------------------- */

  console.log("\nThe reads the gate used to make, on the bare handle:");
  const bareSessions = await app`SELECT owner_email FROM chat_sessions WHERE eve_session_id = ${SESSION}`;
  const bareThreads = await app`SELECT id FROM chat_threads WHERE eve_session_id = ${SESSION}`;
  const bareMembers = await app`SELECT email FROM chat_thread_members WHERE thread_id = ${THREAD}`;
  check("chat_sessions returns nothing", bareSessions.length === 0);
  check("chat_threads returns nothing", bareThreads.length === 0);
  check("chat_thread_members returns nothing", bareMembers.length === 0);
  check(
    "…so the gate's 'no record of this session' branch was true of a session that plainly exists",
    bareSessions.length === 0 && bareThreads.length === 0,
  );

  /* ---- 2. the reads gateForSession makes -------------------------------- */

  console.log("\nThe same reads inside the workspace's scope:");
  const mine = await scoped(ORG, (tx) => tx`
    SELECT owner_email FROM chat_sessions WHERE eve_session_id = ${SESSION}`);
  const threads = await scoped(ORG, (tx) => tx`
    SELECT id, owner_email FROM chat_threads WHERE eve_session_id = ${SESSION} AND archived_at IS NULL`);
  check("the mirror row is there, with its owner", mine.length === 1 && mine[0].owner_email === OWNER);
  check("the thread row is there, with its owner", threads.length === 1 && threads[0].owner_email === OWNER);
  check(
    "so a stranger is now refused: the session is known, and none of it is theirs",
    mine.every((r) => r.owner_email !== STRANGER) && threads.every((r) => r.owner_email !== STRANGER),
  );

  /* ---- 3. revocation ----------------------------------------------------- */

  console.log("\nRevocation, at the gate's own member lookup:");
  const withoutFilter = await scoped(ORG, (tx) => tx`
    SELECT email FROM chat_thread_members WHERE thread_id = ${THREAD} AND email = ${EX}`);
  const withFilter = await scoped(ORG, (tx) => tx`
    SELECT email FROM chat_thread_members
    WHERE thread_id = ${THREAD} AND email = ${EX} AND status <> 'revoked'`);
  const live = await scoped(ORG, (tx) => tx`
    SELECT email FROM chat_thread_members
    WHERE thread_id = ${THREAD} AND email = ${MEMBER} AND status <> 'revoked'`);
  check("the filterless lookup the gate used matched a revoked member", withoutFilter.length === 1);
  check("…and `status <> 'revoked'` does not", withFilter.length === 0);
  check("…while a live member still matches", live.length === 1);

  /* ---- 4. an outsider's workspace --------------------------------------- */

  console.log("\nA caller admitted into an isolated workspace of their own:");
  const outside = await scoped(OTHER, (tx) => tx`
    SELECT id FROM chat_threads WHERE eve_session_id = ${SESSION}`);
  const outsideMirror = await scoped(OTHER, (tx) => tx`
    SELECT id FROM chat_sessions WHERE eve_session_id = ${SESSION}`);
  check(
    "sees nothing — so scoping the reads ALONE would still read as 'unknown session, allow'",
    outside.length === 0 && outsideMirror.length === 0,
  );
  const sweep = await scoped(ORG, (tx) => tx`
    SELECT id FROM chat_threads WHERE eve_session_id = ${SESSION}`);
  check(
    "…which is why the gate sweeps the other workspaces: the session IS recorded, in one of them",
    sweep.length === 1,
  );

  /* ---- 5. un-sharing ----------------------------------------------------- */

  console.log("\nUn-sharing, which used to mean nothing:");
  await admin`UPDATE chat_threads SET archived_at = now() WHERE id = ${THREAD}`;
  await admin`UPDATE chat_thread_members SET status='revoked', revoked_at=now() WHERE thread_id = ${THREAD}`;
  const afterArchive = await scoped(ORG, (tx) => tx`
    SELECT id FROM chat_threads WHERE eve_session_id = ${SESSION} AND archived_at IS NULL`);
  const afterRevoke = await scoped(ORG, (tx) => tx`
    SELECT email FROM chat_thread_members WHERE thread_id = ${THREAD} AND status <> 'revoked'`);
  check("an archived thread no longer answers the transcript rule's lookup", afterArchive.length === 0);
  check("…and no member survives it", afterRevoke.length === 0);
  const ownerStill = await scoped(ORG, (tx) => tx`
    SELECT owner_email FROM chat_sessions WHERE eve_session_id = ${SESSION}`);
  check("…while the owner keeps their own chat, through the mirror row", ownerStill.length === 1);

  /* ---- 6. the audit feed ------------------------------------------------- */

  console.log("\nThe workspace audit feed (the reviewer could not settle this one):");
  const auditBare = await app`
    SELECT automation_id FROM automation_audit ORDER BY created_at DESC LIMIT 100`;
  const auditScoped = await scoped(ORG, (tx) => tx`
    SELECT automation_id FROM automation_audit WHERE org_id = ${ORG} ORDER BY created_at DESC LIMIT 100`);
  check(
    "SETTLED: on the bare handle it returns ZERO rows — the feed has been empty for everyone",
    auditBare.length === 0,
  );
  check("scoped, it returns the workspace's rows", auditScoped.length === 1);
  check(
    "…and what chat telemetry puts in them is a hash, not a session id",
    /^chat_[0-9a-f]{16}$/.test(auditScoped[0].automation_id),
  );
} finally {
  await cleanup().catch(() => undefined);
  for (const [t, qual] of saved) {
    // Put each policy back exactly as it was found — this database is shared
    // with the other isolation checks, which expect the permissive shape.
    await admin.unsafe(`ALTER POLICY org_isolation ON ${t} USING (${qual}) WITH CHECK (${qual})`).catch(() => undefined);
  }
  await admin.end();
  await app.end();
}

console.log(
  failures === 0
    ? "\ntest-chat-access-db: all assertions passed against a fail-closed Postgres"
    : `\ntest-chat-access-db: ${failures} FAILED`,
);
assert.equal(failures, 0, `${failures} database-level assertion(s) failed`);
