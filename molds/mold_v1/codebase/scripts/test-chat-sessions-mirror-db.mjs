/**
 * THE CHAT LIST MIRROR, against a real Postgres (CI's `isolation` job).
 *
 * Runs lib/chat-sessions-mirror.ts — the code app/api/ops/chat-sessions/route.ts
 * calls — as app_rw under row-level security:
 *
 *  1. TAKEOVER (security, review of #59). A second person in the SAME workspace
 *     who knows a chat's session id (it is in `?chatSession=` links) posts a row
 *     with that id. The upsert conflicted on `id` while ownership was checked
 *     only on `eveSessionId`, so a post with no `eveSessionId` rewrote the
 *     owner, nulled the eve session and merged the attacker's markers. It must
 *     be refused, and the row left exactly as it was.
 *  2. ONE CHAT'S MARKERS NEVER BREAK THE BATCH: an oversize marker set is
 *     trimmed for that chat, and the rest of the list still syncs.
 *  3. EITHER DEPLOY ORDER: with `client_markers` absent (before migration 0020)
 *     the list still reads and writes; after the migration, markers are kept.
 *  4. A deleted chat's session cannot be re-claimed (mold_v1-122).
 *  5. One session, one workspace (mold_v1-140): a member of another workspace
 *     cannot file a row for someone's legacy session and so cannot become its
 *     owner when the real owner deletes; a claimant outside the scope row's
 *     workspace is never inferred owner.
 *
 * Run:  ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:chat-sessions-mirror-db
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { sql } from "drizzle-orm";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-chat-sessions-mirror-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
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
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

const ORG = `mirror-probe-${Date.now()}`;
const ALICE = "alice@probe.example";
const MALLORY = "mallory@probe.example";
const SID = `wrun_PROBE_${Date.now()}`;
const STOP = { type: "client.turn.stopped", data: { requestIds: ["r1"], delegations: [{ callId: "c1", name: "configuration" }], at: 9 } };

const { withOrgDb, closeDb } = await import("../agent/lib/db/index.ts");
const mirror = await import("../lib/chat-sessions-mirror.ts");
const inOrg = (fn) => withOrgDb(ORG, fn);
/** The cross-workspace reader the route passes (rule 4): every workspace, each inside its own scope. */
const across = {
  inOrg: (orgId, fn) => withOrgDb(orgId, fn),
  listOrgs: async () => (await admin`select org_id from orgs`).map((r) => r.org_id),
};
const row = async (id) => {
  const hasMarkers =
    (await admin`select 1 from information_schema.columns where table_name = 'chat_sessions' and column_name = 'client_markers'`).length > 0;
  return hasMarkers
    ? ((await admin`select owner_email, eve_session_id, title, client_markers from chat_sessions where id = ${id}`)[0] ?? null)
    : ((await admin`select owner_email, eve_session_id, title from chat_sessions where id = ${id}`)[0] ?? null);
};

const applyMigration = async () => {
  const sqlText = readFileSync("drizzle/0020_chat_session_markers.sql", "utf8");
  for (const st of sqlText.split("--> statement-breakpoint").map((v) => v.trim()).filter(Boolean)) await admin.unsafe(st);
};

try {
  // Start from the migrated shape whatever a previous run left behind.
  await applyMigration();
  await admin`insert into orgs (org_id, name, status) values (${ORG}, 'Chat mirror probe', 'active')`;
  mirror.resetMarkersColumnCache();

  console.log("\n1. A colleague in the same workspace cannot take a chat over by its id");
  await mirror.writeMirrorRows(inOrg, {
    across,
    orgId: ORG,
    email: ALICE,
    sessions: [{ id: SID, eveSessionId: SID, title: "Alice's chat", clientMarkers: [STOP] }],
  });
  const before = await row(SID);
  check("the owner's row is written", before?.owner_email === ALICE && before?.eve_session_id === SID, before);
  const attempts = [
    { label: "with no eveSessionId (the bypass)", session: { id: SID, title: "mine now" } },
    { label: "with the same eveSessionId", session: { id: SID, eveSessionId: SID, title: "mine now" } },
    { label: "with another eveSessionId", session: { id: SID, eveSessionId: "wrun_OTHER", title: "mine now" } },
    {
      label: "with markers to merge in",
      session: { id: SID, title: "mine now", clientMarkers: [{ type: "client.input.responded", data: { responses: [{ requestId: "x", text: "hi" }] } }] },
    },
  ];
  for (const a of attempts) {
    const { refused } = await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: MALLORY, sessions: [a.session] });
    const after = await row(SID);
    check(`refused ${a.label}`, refused === 1, refused);
    check(
      `…and the row is exactly as it was (owner, eve session, title, markers)`,
      JSON.stringify(after) === JSON.stringify(before),
      { before, after },
    );
  }
  const theirs = await mirror.readMirrorRows((fn) => withOrgDb(ORG, fn), { orgId: ORG, email: MALLORY });
  check("the colleague's list does not contain it", !theirs.some((r) => r.id === SID));
  // The owner's own upsert may not null the session either.
  await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: SID, title: "renamed" }] });
  const renamed = await row(SID);
  check("the owner's later write without an eveSessionId keeps it (it is set once, never nulled)", renamed?.eve_session_id === SID && renamed?.title === "renamed", renamed);

  console.log("\n2. One chat's oversize markers do not stop the rest of the list syncing");
  const huge = { type: "client.input.responded", data: { responses: [{ requestId: "big", text: "x".repeat(40_000) }] } };
  const many = Array.from({ length: 400 }, (_, i) => ({ type: "client.input.responded", data: { responses: [{ requestId: `q${i}`, text: "an answer of about fifty characters, give or take." }] } }));
  const batch = [
    { id: `${SID}_a`, eveSessionId: `${SID}_a`, title: "one huge answer", clientMarkers: [STOP, huge] },
    { id: `${SID}_b`, eveSessionId: `${SID}_b`, title: "hundreds of answers", clientMarkers: [...many, STOP] },
    { id: `${SID}_c`, eveSessionId: `${SID}_c`, title: "an ordinary chat" },
  ];
  const { refused } = await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: batch });
  const [a, b, c] = await Promise.all(batch.map((s) => row(s.id)));
  check("every chat in the batch is written", refused === 0 && a && b && c, { refused });
  check("the huge answer is trimmed, the Stop kept", JSON.stringify(a.client_markers).length < 32_000 && a.client_markers.some((m) => m.type === "client.turn.stopped"), JSON.stringify(a.client_markers).length);
  check("hundreds of answers are capped, the Stop kept", JSON.stringify(b.client_markers).length <= 32_000 && b.client_markers.some((m) => m.type === "client.turn.stopped"));

  console.log("\n3. Either deploy order: before migration 0020 the list still works");
  await admin.unsafe(`ALTER TABLE "chat_sessions" DROP COLUMN IF EXISTS "client_markers"`);
  mirror.resetMarkersColumnCache();
  let readOk = true;
  let writeOk = true;
  try {
    await mirror.readMirrorRows(inOrg, { orgId: ORG, email: ALICE });
  } catch (e) {
    readOk = false;
    console.log("     read failed:", String(e?.message ?? e).slice(0, 120));
  }
  try {
    await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: `${SID}_d`, eveSessionId: `${SID}_d`, title: "before the column", clientMarkers: [STOP] }] });
  } catch (e) {
    writeOk = false;
    console.log("     write failed:", String(e?.message ?? e).slice(0, 120));
  }
  check("reading the list works without the column", readOk);
  check("writing the list works without the column (markers simply not kept yet)", writeOk && (await row(`${SID}_d`))?.title === "before the column");
  await applyMigration();
  mirror.resetMarkersColumnCache();
  await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: `${SID}_d`, eveSessionId: `${SID}_d`, title: "after", clientMarkers: [STOP] }] });
  check("after the migration, markers are kept", (await row(`${SID}_d`))?.client_markers?.length === 1);

  console.log("\n4. A deleted chat's session cannot be re-claimed by another member (review of #59; mold_v1-122)");
  {
    const gate = await import("../lib/session-gate.ts");
    const db = { inOrg: (orgId, fn) => withOrgDb(orgId, fn), listOrgs: async () => [ORG], orgsOf: async () => [ORG] };
    // What the route does on DELETE, in order: record ownership, then remove the row.
    const deleteChat = async (sessionId, owner, { tombstone }) => {
      if (tombstone) await mirror.recordOwnershipBeforeDelete(db, { sessionId, orgId: ORG, email: owner });
      await inOrg((tx) => tx.execute(sql`delete from chat_sessions where id = ${sessionId} and owner_email = ${owner}`));
    };
    const claim = (sessionId) =>
      mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: MALLORY, sessions: [{ id: `${sessionId}_m`, eveSessionId: sessionId, title: "mine now" }] });
    const ownerOf = async (sessionId) => (await gate.readOwnership(db, sessionId, [ORG]))?.ownerEmail ?? null;

    // (a) A session created since #66: the agent recorded its owner at creation. #66 alone already holds it.
    const NEW = `${SID}_new`;
    await gate.recordOwner(db, { sessionId: NEW, orgId: ORG, ownerEmail: ALICE, ownerPrincipal: null, ownerKind: "person", visibility: "owner" });
    await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: NEW, eveSessionId: NEW, title: "Alice's new chat" }] });
    await deleteChat(NEW, ALICE, { tombstone: false });
    await claim(NEW);
    check("#66: a session with an owner RECORD stays its owner's after the chat is deleted and re-claimed", (await ownerOf(NEW)) === ALICE);

    // (b) A session from before #66 (no record), deleted WITHOUT the tombstone — the gap #66 left.
    const OLD = `${SID}_old`;
    await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: OLD, eveSessionId: OLD, title: "Alice's old chat" }] });
    check("a pre-#66 session is its owner's by inference while her row exists", (await ownerOf(OLD)) === ALICE);
    await deleteChat(OLD, ALICE, { tombstone: false });
    const refusedOld = (await claim(OLD)).refused;
    check("…without the tombstone, once her row is gone another member's claim is ACCEPTED and makes him the owner (the gap)", refusedOld === 0 && (await ownerOf(OLD)) === MALLORY);

    // (c) The same, deleted the way the route now deletes.
    const HELD = `${SID}_held`;
    await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: HELD, eveSessionId: HELD, title: "Alice's other old chat" }] });
    await deleteChat(HELD, ALICE, { tombstone: true });
    await claim(HELD);
    check("with it, the owner is frozen before the row goes: the claim changes nothing", (await ownerOf(HELD)) === ALICE);
    const record = (await admin`select owner_email, owner_kind from agent_session_owners where session_id = ${HELD}`)[0];
    check("…as an owner RECORD (insert-only), not an inference", record?.owner_email === ALICE && record?.owner_kind === "person", record);

    // (d) Two claimants: the deleter is not the only one, so its DELETE records nothing (it must not decide for the
    // other claimant). The other claimant's row still stands, so the session is theirs and a third person's claim
    // is refused.
    const TWO = `${SID}_two`;
    const CAROL = "carol@probe.example";
    await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: TWO, eveSessionId: TWO, title: "claimed twice" }] });
    await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${`${TWO}_x`}, ${ORG}, ${CAROL}, ${TWO}, 'x')`;
    check("with two claimants nothing is inferred", (await ownerOf(TWO)) === null);
    check("…and deleting records nothing: Alice is not the only claimant", (await mirror.recordOwnershipBeforeDelete(db, { sessionId: TWO, orgId: ORG, email: ALICE })) === "skipped");
    await deleteChat(TWO, ALICE, { tombstone: false });
    check("…the remaining claimant is then the owner, and a third person's claim is refused",
      (await ownerOf(TWO)) === CAROL && (await claim(TWO)).refused === 1 && (await ownerOf(TWO)) === CAROL);
    check("a session that already has a record is left alone", (await mirror.recordOwnershipBeforeDelete(db, { sessionId: NEW, orgId: ORG, email: ALICE })) === "recorded");
    const route = readFileSync("app/api/ops/chat-sessions/route.ts", "utf8");
    const del = route.slice(route.indexOf("export async function DELETE"));
    check(
      "the DELETE route records ownership BEFORE it removes the row (and a failure refuses the delete)",
      del.indexOf("recordOwnershipBeforeDelete(") > 0 && del.indexOf("recordOwnershipBeforeDelete(") < del.indexOf(".delete(chatSessions)"),
    );
  }

  console.log("\n5. One session, one workspace: another workspace can neither claim nor tombstone a legacy session (#77; mold_v1-140)");
  {
    // A pre-0016 session (no scope row) mirrored by Alice in workspace ORG. Mallory is a member of workspace ORG_B
    // only. The mirror used to refuse duplicate claims inside the CALLER's workspace alone, so her row in B was
    // accepted — and when Alice deleted her chat, Mallory's row was the only claimant left and she was inferred
    // its owner. Now a claim for a session another workspace holds is refused.
    const ORG_B = `${ORG}-b`;
    await admin`insert into orgs (org_id, name, status) values (${ORG_B}, 'Chat mirror probe B', 'active')`;
    const gate = await import("../lib/session-gate.ts");
    const db2 = {
      inOrg: (orgId, fn) => withOrgDb(orgId, fn),
      listOrgs: async () => [ORG, ORG_B],
      orgsOf: async (e) => (e === ALICE ? [ORG] : [ORG_B]),
    };
    const inB = (fn) => withOrgDb(ORG_B, fn);
    const ownerOf = async (sessionId) => (await gate.readOwnership(db2, sessionId, [ORG]))?.ownerEmail ?? null;
    const claimInB = async (sessionId, email = MALLORY) =>
      (await mirror.writeMirrorRows(inB, { across, orgId: ORG_B, email, sessions: [{ id: `${sessionId}_m`, eveSessionId: sessionId, title: "x" }] })).refused;
    const rowsInB = async (sessionId) => (await admin`select id from chat_sessions where org_id = ${ORG_B} and eve_session_id = ${sessionId}`).length;
    /** What the route does on DELETE, in order: record ownership, then remove the caller's row. */
    const deleteChat = async (sessionId, rowId, org, email) => {
      const outcome = await mirror.recordOwnershipBeforeDelete(db2, { sessionId, orgId: org, email });
      await withOrgDb(org, (tx) => tx.execute(sql`delete from chat_sessions where id = ${rowId} and owner_email = ${email}`));
      return outcome;
    };

    // (a) The reviewer's probe: B files a row for A's legacy session, A deletes, B must not become owner.
    const PROBE = `${SID}_probe`;
    await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: `${PROBE}_a`, eveSessionId: PROBE, title: "Alice's pre-0016 chat" }] });
    check("the legacy session is Alice's while only her row names it", (await ownerOf(PROBE)) === ALICE);
    check("Mallory's claim from ANOTHER workspace is refused, and no row is written there", (await claimInB(PROBE)) === 1 && (await rowsInB(PROBE)) === 0);
    const outcome = await deleteChat(PROBE, `${PROBE}_a`, ORG, ALICE);
    check("Alice deletes her chat: she holds all the evidence, so she is frozen as its owner", outcome === "frozen", outcome);
    check("…and Mallory is not the owner", (await ownerOf(PROBE)) === ALICE);
    await claimInB(PROBE);
    check("…nor after she files again once Alice's row is gone (the record decides)", (await ownerOf(PROBE)) === ALICE);
    check(
      "…nor may she read it",
      !(await gate.gateSessionRequest(db2, { kind: "person", email: MALLORY }, PROBE, "read")).allow,
    );

    // (b) A session anchored by a scope row in ORG is refused in B too, even with no chat row anywhere.
    const SCOPED = `${SID}_scoped`;
    await admin`insert into agent_session_scopes (session_id, org_id, principal_email) values (${SCOPED}, ${ORG}, ${ALICE})`;
    check("a claim for a session whose scope row is in another workspace is refused", (await claimInB(SCOPED)) === 1 && (await rowsInB(SCOPED)) === 0);
    // One workspace per session, whoever asks: Alice filing her own session from workspace B is refused as well.
    check("…and so is Alice's own claim of it from workspace B (a session has one workspace)", (await claimInB(SCOPED, ALICE)) === 1 && (await rowsInB(SCOPED)) === 0);

    // (c) Rows filed BEFORE this change are still there. The inference ignores a claimant outside the scope row's
    // workspace: with Alice's scope row in ORG and Mallory's old row in B, deleting Alice's chat does not make
    // Mallory the owner.
    await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: `${SCOPED}_a`, eveSessionId: SCOPED, title: "Alice's scoped chat" }] });
    await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${`${SCOPED}_old`}, ${ORG_B}, ${MALLORY}, ${SCOPED}, 'filed before the fix')`;
    check("with a scope row in ORG, Alice is the owner while her row exists (Mallory's row in B is ignored)", (await ownerOf(SCOPED)) === ALICE);
    await deleteChat(SCOPED, `${SCOPED}_a`, ORG, ALICE);
    check("…and once it is deleted Mallory, a claimant outside the anchor's workspace, is NOT inferred owner", (await ownerOf(SCOPED)) !== MALLORY);

    // (d) Review of #77, on a row filed before this change: Mallory's own DELETE must record nothing about a
    // session whose evidence she does not hold alone (no tombstone locking Alice out).
    const LEG = `${SID}_xws`;
    await mirror.writeMirrorRows(inOrg, { across, orgId: ORG, email: ALICE, sessions: [{ id: `${LEG}_a`, eveSessionId: LEG, title: "Alice's pre-0016 chat" }] });
    await admin`insert into chat_sessions (id, org_id, owner_email, eve_session_id, title) values (${`${LEG}_m`}, ${ORG_B}, ${MALLORY}, ${LEG}, 'filed before the fix')`;
    const recorded = await deleteChat(LEG, `${LEG}_m`, ORG_B, MALLORY);
    check("Mallory's DELETE records nothing: the evidence spans two workspaces", recorded === "skipped", recorded);
    const rec = (await admin`select owner_email, owner_kind, org_id from agent_session_owners where session_id = ${LEG}`)[0] ?? null;
    check("…no tombstone and no owner record exists for the session", rec === null, rec);
    check("…and once her row is gone the session is Alice's again, and Alice may read it",
      (await ownerOf(LEG)) === ALICE && (await gate.gateSessionRequest(db2, { kind: "person", email: ALICE }, LEG, "read")).allow);
    check("Alice deleting her own chat still freezes her as the owner", (await mirror.recordOwnershipBeforeDelete(db2, { sessionId: LEG, orgId: ORG, email: ALICE })) === "frozen");
    await admin`delete from chat_sessions where org_id = ${ORG_B}`.catch(() => {});
    await admin`delete from agent_session_owners where org_id = ${ORG_B}`.catch(() => {});
    await admin`delete from orgs where org_id = ${ORG_B}`.catch(() => {});
  }
} finally {
  await applyMigration().catch(() => {});
  await admin`delete from chat_sessions where org_id = ${ORG}`.catch(() => {});
  await admin`delete from agent_session_owners where org_id = ${ORG}`.catch(() => {});
  await admin`delete from agent_session_scopes where org_id = ${ORG}`.catch(() => {});
  await admin`delete from orgs where org_id = ${ORG}`.catch(() => {});
  await admin.end();
  await closeDb?.();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
