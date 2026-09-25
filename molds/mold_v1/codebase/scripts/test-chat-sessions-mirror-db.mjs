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
 *
 * Run:  ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:chat-sessions-mirror-db
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

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
    const { refused } = await mirror.writeMirrorRows(inOrg, { orgId: ORG, email: MALLORY, sessions: [a.session] });
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
  await mirror.writeMirrorRows(inOrg, { orgId: ORG, email: ALICE, sessions: [{ id: SID, title: "renamed" }] });
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
  const { refused } = await mirror.writeMirrorRows(inOrg, { orgId: ORG, email: ALICE, sessions: batch });
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
    await mirror.writeMirrorRows(inOrg, { orgId: ORG, email: ALICE, sessions: [{ id: `${SID}_d`, eveSessionId: `${SID}_d`, title: "before the column", clientMarkers: [STOP] }] });
  } catch (e) {
    writeOk = false;
    console.log("     write failed:", String(e?.message ?? e).slice(0, 120));
  }
  check("reading the list works without the column", readOk);
  check("writing the list works without the column (markers simply not kept yet)", writeOk && (await row(`${SID}_d`))?.title === "before the column");
  await applyMigration();
  mirror.resetMarkersColumnCache();
  await mirror.writeMirrorRows(inOrg, { orgId: ORG, email: ALICE, sessions: [{ id: `${SID}_d`, eveSessionId: `${SID}_d`, title: "after", clientMarkers: [STOP] }] });
  check("after the migration, markers are kept", (await row(`${SID}_d`))?.client_markers?.length === 1);
} finally {
  await applyMigration().catch(() => {});
  await admin`delete from chat_sessions where org_id = ${ORG}`.catch(() => {});
  await admin`delete from orgs where org_id = ${ORG}`.catch(() => {});
  await admin.end();
  await closeDb?.();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
