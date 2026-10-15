/**
 * THE SAVED COPY OF A SPECIALIST'S FEED, through the real route, against a fail-closed Postgres.
 *
 * /api/ops/chat-snapshots with `kind=child` keeps what a chat's Control Panel folded from a delegated (child) session
 * (lib/child-copy.ts, lib/child-feed.ts), so the next page shows the specialist without reading its stream from event
 * 0 (9.4 MB to over 147 MB per specialist, measured). It is the most complete copy of what a specialist did, so:
 *
 *   1. its OWNER stores and reads it back unchanged (the round trip the panel relies on);
 *   2. everyone else gets 404, the same as a session nobody recorded: a colleague in the workspace, a participant of
 *      the chat it was shared with, the owner asking from ANOTHER workspace, and a chat's own (non-child) session;
 *   3. it is capped in size (413), shaped as the writer writes it (400), never moved backwards (409, row unchanged);
 *   4. the chat's own copy route cannot reach it (the key is not a session id anyone can name);
 *   5. deleting the chat deletes its specialists' copies; a copy can be discarded by its owner only;
 *   6. row-level security, fail-closed (the production shape): app_rw outside the workspace's scope sees no row.
 *
 * Real route handlers and signed-in requests, as app_rw. Each check fails on the code before `kind=child` existed
 * (the route answered every child read as the chat's own and returned no copy): 21 of its 30 checks.
 *
 *   ADMIN_URL=… DATABASE_URL=…app_rw… npm run test:child-copy-db
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import postgres from "postgres";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) {
            try { return await n(s + ".ts", c); } catch { return await n(s + ".js", c); }
          }
          throw e;
        }
      }`),
  import.meta.url,
);

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-child-copy-db: SKIPPED — needs ADMIN_URL and DATABASE_URL (app_rw).");
  process.exit(0);
}
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
process.env.AUTH_JWT_PRIVATE_KEY = Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
process.env.AUTH_JWT_PUBLIC_KEY = Buffer.from(pair.publicKey.export({ type: "spki", format: "pem" })).toString("base64");

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
const app = postgres(appUrl, { max: 1, onnotice: () => {} });
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

const stamp = Date.now();
const A = `copy-a-${stamp}`;
const B = `copy-b-${stamp}`;
const OWNER = `owner-${stamp}@a.test`; // owns the chat and its specialists; also a member of B
const COLLEAGUE = `colleague-${stamp}@a.test`; // member of A, nothing shared
const PARTICIPANT = `participant-${stamp}@a.test`; // member of A, the chat is shared with them
const ROOT = `wrun_root_${stamp}`;
const CHILD = `wrun_child_${stamp}`;
const NESTED = `wrun_nested_${stamp}`;
const OTHER_ROOT = `wrun_other_${stamp}`; // a chat in B, owned by OWNER, with a child of the same shape
const OTHER_CHILD = `wrun_otherchild_${stamp}`;
const THREAD = randomUUID();
const TABLES = ["chat_transcript_snapshots", "agent_session_owners", "chat_threads", "chat_thread_members"];

const { mintSessionToken } = await import("../lib/auth-session.ts");
const { NextRequest } = await import("next/server");
const { closeDb } = await import("../agent/lib/db/index.ts");
const { CHILD_COPY_VERSION, CHILD_COPY_MAX_BYTES } = await import("../lib/child-copy.ts");
const route = await import("../app/api/ops/chat-snapshots/route.ts");
const token = {};
for (const who of [OWNER, COLLEAGUE, PARTICIPANT]) token[who] = `Bearer ${await mintSessionToken(who)}`;
const req = (who, path, { org, method = "GET", body } = {}) =>
  new NextRequest(`http://copy.test${path}`, {
    method,
    headers: {
      authorization: token[who],
      ...(org ? { "x-ops-org": org } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });
const get = (who, sid, org = A) => route.GET(req(who, `/api/ops/chat-snapshots?kind=child&session=${encodeURIComponent(sid)}`, { org })).then(json);
const post = (who, body, org = A) => route.POST(req(who, "/api/ops/chat-snapshots", { org, method: "POST", body: { kind: "child", ...body } })).then(json);
const del = (who, sid, org = A, kind = "child") =>
  route.DELETE(req(who, `/api/ops/chat-snapshots?${kind ? "kind=child&" : ""}session=${encodeURIComponent(sid)}`, { org, method: "DELETE" })).then(json);

/** A copy as lib/child-feed.ts writes one: kept events with their absolute indexes, ending on a session boundary. */
const copyOf = (sessionId, cursor, extra = 0) => {
  const events = [
    { i: 0, e: { type: "session.started", data: {} } },
    { i: 1, e: { type: "turn.started", data: { turnId: "turn_0", sequence: 0 } } },
    // Key order as eve writes it (not jsonb's): the copy must come back byte for byte.
    { i: 5, e: { data: { actions: [{ toolName: "custom_tool", input: { zeta: "first string field", a: "second" } }] }, type: "actions.requested" } },
    { i: 7, e: { type: "reasoning.completed", data: { reasoning: "x".repeat(extra), stepIndex: 0, turnId: "turn_0", sequence: 0 } } },
    { i: 9, e: { type: "turn.completed", data: { turnId: "turn_0", sequence: 0 } } },
    { i: cursor - 1, e: { type: "session.waiting", data: { wait: "next-user-message" } } },
  ].map(({ i, e }) => ({ i, line: JSON.stringify(e) }));
  return { version: CHILD_COPY_VERSION, sessionId, cursor, events };
};
const stored = async (sid) => (await admin`select event_index, chat_session_id, org_id, owner_email from chat_transcript_snapshots where eve_session_id = ${`child:${sid}`}`)[0] ?? null;

const saved = new Map();
try {
  // The production policy shape (scripts/.migrate-rls-fail-closed.mjs), put back as found in `finally`.
  for (const t of TABLES) {
    const [row] = await admin`select qual from pg_policies where schemaname = 'public' and tablename = ${t} and policyname = 'org_isolation'`;
    if (!row) throw new Error(`${t} carries no org_isolation policy: run scripts/bootstrap-test-db.mjs first`);
    saved.set(t, row.qual);
    const closed = `(org_id = current_setting('app.org_id', true))`;
    await admin.unsafe(`ALTER POLICY org_isolation ON ${t} USING ${closed} WITH CHECK ${closed}`);
  }
  await admin`insert into orgs (org_id, name, status) values (${A}, 'Copy A', 'active'), (${B}, 'Copy B', 'active')`;
  await admin`insert into org_members (org_id, email, role, last_selected_at) values
    (${A}, ${OWNER}, 'member', now()), (${B}, ${OWNER}, 'member', now() - interval '1 day'),
    (${A}, ${COLLEAGUE}, 'member', now()), (${A}, ${PARTICIPANT}, 'member', now())`;
  // The agent's own records (agent/lib/session-owners.ts recordChildSession): the chat, its specialist, a nested one.
  await admin`insert into agent_session_owners (session_id, org_id, owner_email, owner_kind, visibility, root_session_id, parent_session_id) values
    (${ROOT}, ${A}, ${OWNER}, 'person', 'owner', null, null),
    (${CHILD}, ${A}, ${OWNER}, 'person', 'owner', ${ROOT}, ${ROOT}),
    (${NESTED}, ${A}, ${OWNER}, 'person', 'owner', ${ROOT}, ${CHILD}),
    (${OTHER_ROOT}, ${B}, ${OWNER}, 'person', 'owner', null, null),
    (${OTHER_CHILD}, ${B}, ${OWNER}, 'person', 'owner', ${OTHER_ROOT}, ${OTHER_ROOT})`;
  // The chat is shared with PARTICIPANT (a live thread membership on the root).
  await admin`insert into chat_threads (id, org_id, eve_session_id, title, owner_email) values (${THREAD}, ${A}, ${ROOT}, 'shared', ${OWNER})`;
  await admin`insert into chat_thread_members (org_id, thread_id, email, role, status, invited_by) values (${A}, ${THREAD}, ${PARTICIPANT}, 'participant', 'accepted', ${OWNER})`;

  console.log("\n1. The owner stores a specialist's copy and reads it back");
  const none = await get(OWNER, CHILD);
  check("before any harvest: no copy (200, null)", none.status === 200 && none.body?.copy === null, none);
  const first = copyOf(CHILD, 120);
  const w = await post(OWNER, first);
  check("stored (200)", w.status === 200 && w.body?.ok === true, w);
  const r = await get(OWNER, CHILD);
  const canon = (c) => JSON.stringify({ version: c?.version, sessionId: c?.sessionId, cursor: c?.cursor, events: c?.events?.map((k) => [k.i, k.line]) });
  check("read back unchanged: version, session, cursor, every event byte for byte with its index", r.status === 200 && canon(r.body?.copy) === canon(first), r.body);
  const row = await stored(CHILD);
  check("filed in workspace A, under the chat it belongs to, written by its owner", row?.org_id === A && row?.chat_session_id === ROOT && row?.owner_email === OWNER, row);
  check("a nested specialist (a child of a child) is the owner's too", (await post(OWNER, copyOf(NESTED, 40))).status === 200 && (await get(OWNER, NESTED)).body?.copy?.cursor === 40);

  console.log("\n2. Everyone else: 404");
  for (const [label, who, sid, org] of [
    ["a colleague in the same workspace", COLLEAGUE, CHILD, A],
    ["a participant of the chat it was shared with", PARTICIPANT, CHILD, A],
    ["the owner, asking from another workspace (B)", OWNER, CHILD, B],
    ["a chat's own session (not a specialist)", OWNER, ROOT, A],
    ["a session nobody recorded", OWNER, `wrun_nobody_${stamp}`, A],
  ]) {
    const g = await get(who, sid, org);
    const p = await post(who, copyOf(sid, 200), org);
    const d = await del(who, sid, org);
    check(`${label}: read 404, write 404, discard 404`, g.status === 404 && p.status === 404 && d.status === 404, { g: g.status, p: p.status, d: d.status });
  }
  check("…and nothing they sent was stored or changed", (await stored(CHILD))?.event_index === 120 && (await stored(ROOT)) === null);
  check("the owner's specialist in B is B's: not readable from A", (await post(OWNER, copyOf(OTHER_CHILD, 50), B)).status === 200 && (await get(OWNER, OTHER_CHILD, A)).status === 404 && (await get(OWNER, OTHER_CHILD, B)).body?.copy?.cursor === 50);
  check("a refusal says nothing about the session (the same body as an unknown one)", JSON.stringify((await get(COLLEAGUE, CHILD)).body) === JSON.stringify((await get(OWNER, `wrun_nobody_${stamp}`)).body));

  console.log("\n3. The size cap, the shape, never backwards");
  const big = await post(OWNER, copyOf(CHILD, 500, CHILD_COPY_MAX_BYTES + 10));
  check("over the size cap: 413, not stored", big.status === 413 && big.body?.reason === "too-large" && (await stored(CHILD))?.event_index === 120, big);
  const shorter = await post(OWNER, copyOf(CHILD, 80));
  check("a SHORTER copy over a longer one: refused (409), the stored copy unchanged", shorter.status === 409 && (await stored(CHILD))?.event_index === 120, shorter);
  const longer = await post(OWNER, copyOf(CHILD, 300));
  check("a longer one replaces it", longer.status === 200 && (await stored(CHILD))?.event_index === 300);
  const bad = copyOf(CHILD, 400);
  check("not ending on a session boundary: 400", (await post(OWNER, { ...bad, events: bad.events.slice(0, -1) })).status === 400);
  check("indexes not increasing: 400", (await post(OWNER, { ...bad, events: [...bad.events].reverse() })).status === 400);
  check("an index at or past the cursor: 400", (await post(OWNER, { ...bad, cursor: 5 })).status === 400);
  check("another version: 409", (await post(OWNER, { ...bad, version: CHILD_COPY_VERSION + 1 })).status === 409);
  check("…none of them stored", (await stored(CHILD))?.event_index === 300);

  console.log("\n4. The chat's own copy route cannot reach a specialist's copy");
  const asChat = await json(await route.GET(req(OWNER, `/api/ops/chat-snapshots?session=${encodeURIComponent(`child:${CHILD}`)}`, { org: A })));
  check("reading `child:<session>` as a chat: refused, no copy", asChat.status === 403 && !asChat.body?.snapshot, asChat);
  const overwrite = await json(
    await route.POST(
      req(OWNER, "/api/ops/chat-snapshots", {
        org: A,
        method: "POST",
        body: { eveSessionId: `child:${CHILD}`, version: 1, eventIndex: 9_999, events: [{ type: "x" }] },
      }),
    ),
  );
  check("writing `child:<session>` as a chat: refused, the copy unchanged", overwrite.status === 403 && (await stored(CHILD))?.event_index === 300, overwrite);

  console.log("\n5. Discarding, and deleting the chat");
  check("the owner discards a copy the stream disagreed with", (await del(OWNER, NESTED)).status === 200 && (await stored(NESTED)) === null);
  check("…and may then store a SHORTER one (the healed copy)", (await post(OWNER, copyOf(NESTED, 20))).status === 200 && (await stored(NESTED))?.event_index === 20);
  const gone = await del(OWNER, ROOT, A, null);
  check("deleting the chat (its own DELETE) deletes its specialists' copies", gone.status === 200 && (await stored(CHILD)) === null && (await stored(NESTED)) === null, gone);
  check("…and not the owner's other chat's (in B)", (await stored(OTHER_CHILD))?.event_index === 50);

  console.log("\n6. Row-level security, fail-closed");
  await post(OWNER, copyOf(CHILD, 120));
  const bare = await app`select eve_session_id from chat_transcript_snapshots where eve_session_id = ${`child:${CHILD}`}`;
  const inB = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${B}, true)`;
    return tx`select eve_session_id from chat_transcript_snapshots where eve_session_id = ${`child:${CHILD}`}`;
  });
  const inA = await app.begin(async (tx) => {
    await tx`select set_config('app.org_id', ${A}, true)`;
    return tx`select eve_session_id from chat_transcript_snapshots where eve_session_id = ${`child:${CHILD}`}`;
  });
  check("app_rw with no workspace scope sees no copy", bare.length === 0, bare.length);
  check("…in workspace B's scope, none", inB.length === 0, inB.length);
  check("…in workspace A's scope, the one", inA.length === 1, inA.length);
} finally {
  for (const sid of [CHILD, NESTED, OTHER_CHILD, ROOT, OTHER_ROOT]) {
    await admin`delete from chat_transcript_snapshots where eve_session_id in (${sid}, ${`child:${sid}`})`.catch(() => {});
  }
  await admin`delete from chat_thread_members where thread_id = ${THREAD}`.catch(() => {});
  await admin`delete from chat_threads where id = ${THREAD}`.catch(() => {});
  await admin`delete from agent_session_owners where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from org_members where org_id in (${A}, ${B})`.catch(() => {});
  await admin`delete from orgs where org_id in (${A}, ${B})`.catch(() => {});
  for (const [t, qual] of saved) {
    await admin.unsafe(`ALTER POLICY org_isolation ON ${t} USING (${qual}) WITH CHECK (${qual})`).catch(() => undefined);
  }
  await admin.end();
  await app.end();
  await closeDb?.();
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
