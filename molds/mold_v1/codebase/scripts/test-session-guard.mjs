/**
 * WHOSE SESSION IS IT — the agent's own session routes, driven through the REAL channel it exports.
 *
 * The assessor's finding: the agent API is its own public deployment, and eve's per-session routes
 * (`POST /eve/v1/session/:id`, `GET …/stream`, `POST …/cancel`) authenticate a caller and then act on ANY session.
 * With a valid token from a DIFFERENT workspace, called directly: the stream returned the victim's whole transcript
 * (continuation token included), a message went in, an approval was answered and the turn was cancelled.
 *
 * This imports `agent/channels/eve.ts` — the default export eve serves, auth list and all — and calls its route
 * handlers the way eve's dispatcher does (`handler(request, args)`), with requests signed by a locally generated
 * key through the REAL `jwtEcdsa` / `vercelOidc` verifiers, and eve's runtime (send / getSession / cancelTurn)
 * replaced by an in-memory one that behaves like it (it delivers by TOKEN, as eve does, and starts a new session
 * when a token is not live). The database is a real Postgres, as app_rw, with the production FAIL-CLOSED policies.
 *
 * It runs unchanged against `main`, which is how it was shown to fail there first.
 *
 * Run (CI's isolation job has both urls):
 *   ADMIN_URL=postgres://…admin… DATABASE_URL=postgres://app_rw:…@…/fde_test npm run test:session-guard
 *
 * The live-HTTP companion, against a running `eve dev`, is scripts/test-session-guard-live.mjs (run by hand).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SignJWT, exportJWK, exportSPKI, generateKeyPair } from "jose";
import postgres from "postgres";

const adminUrl = process.env.ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) {
  console.log("test-session-guard: SKIPPED — needs ADMIN_URL (seeding, policy DDL) and DATABASE_URL (app_rw).");
  process.exit(0);
}

/* ---- identities, signed locally, verified by the real verifiers ---------------------------------------------- */

const { privateKey: esPriv, publicKey: esPub } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(esPub);
delete process.env.GOOGLE_CLIENT_ID;

// The front-end's production Vercel OIDC token — the trusted service — signed here, its discovery and JWKS answered
// from a patched fetch exactly as scripts/test-service-scope-oidc.mjs does.
const TEAM = "f20170061g-3183s-projects";
const ISSUER = `https://oidc.vercel.com/${TEAM}`;
const FRONTEND = `owner:${TEAM}:project:fde-agent:environment:production`;
process.env.VERCEL_PROJECT_ID = "prj_agent_probe";
const { privateKey: rsPriv, publicKey: rsPub } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(rsPub)), kid: "probe", alg: "RS256", use: "sig" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks`, id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["id_token"], subject_types_supported: ["public"] });
  }
  if (url === `${ISSUER}/.well-known/jwks`) return Response.json({ keys: [jwk] });
  return realFetch(input, init);
};
const now = () => Math.floor(Date.now() / 1000);
const serviceToken = () =>
  new SignJWT({ sub: FRONTEND, project: "fde-agent", project_id: "prj_frontend_probe", environment: "production", owner: TEAM })
    .setProtectedHeader({ alg: "RS256", kid: "probe" }).setIssuer(ISSUER).setAudience(`https://vercel.com/${TEAM}`)
    .setIssuedAt(now() - 5).setExpirationTime(now() + 600).sign(rsPriv);
const emailToken = (email, extra = {}, audience = "delivered-app") =>
  new SignJWT({ email, kind: "email-session", ...extra })
    .setProtectedHeader({ alg: "ES256" }).setSubject(email).setIssuer("delivered").setAudience(audience)
    .setIssuedAt().setExpirationTime("1h").sign(esPriv);
/** The web app's workspace-step grant (lib/auth-session.ts mintWorkspaceStepGrant), signed with the web app's key. */
const stepGrant = (email, key = esPriv) =>
  new SignJWT({ email, kind: "workspace-step-grant" })
    .setProtectedHeader({ alg: "ES256" }).setSubject(email).setIssuer("delivered").setAudience("delivered-agent-grant")
    .setIssuedAt().setExpirationTime("2m").sign(key);
/** PR #63's queue-delivery token: its own audience and kind, the owner's email and workspace, one session in `sid`. */
const queueToken = (email, sid, org = ORG_A) =>
  emailToken(email, { kind: "queue-delivery", org, sid }, "delivered-queue-delivery");

const ORG_A = "org-guard-a";
const ORG_B = "org-guard-b";
const ALICE = "alice@guard-a.test"; // the owner
const BOB = "bob@guard-a.test"; // same workspace, not the owner
const CAROL = "carol@guard-b.test"; // another workspace
const PAT = "pat@guard-a.test"; // participant on alice's shared thread
const VIC = "vic@guard-a.test"; // viewer on it
const REX = "rex@guard-a.test"; // revoked from it

const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });
const TABLES = ["agent_session_owners", "agent_session_scopes", "chat_sessions", "chat_threads", "chat_thread_members"];
const saved = new Map();
const cleanup = async () => {
  await admin`DELETE FROM chat_thread_members WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM chat_threads WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM chat_sessions WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM agent_session_scopes WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM workflow_run_journal WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM org_members WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM orgs WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  const [owners] = await admin`SELECT to_regclass('public.agent_session_owners') AS reg`;
  if (owners.reg) await admin`DELETE FROM agent_session_owners WHERE org_id IN (${ORG_A}, ${ORG_B})`;
};

let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `  — got ${JSON.stringify(detail)}`}`);
  }
};

/* ---- an in-memory eve runtime, shaped like the real one ------------------------------------------------------ */

const sessions = new Map(); // id → { token, events: [] }
let seq = 0;
const newSession = (token, first = { type: "session.started", data: { runtime: { agentId: "probe" } } }) => {
  const id = `wrun_guard_${++seq}_${randomUUID().slice(0, 8)}`;
  sessions.set(id, { token, events: [first], cancelled: 0, delivered: [] });
  return id;
};
const park = (id) => sessions.get(id).events.push({ type: "session.waiting", data: { continuationToken: sessions.get(id).token } });
const handle = (id, token) => ({
  id,
  continuationToken: token,
  async cancel() {
    sessions.get(id) && sessions.get(id).cancelled++;
    return { status: "accepted" };
  },
  async getEventStream(opts) {
    return eventStream(id, opts?.startIndex);
  },
});
function eventStream(id, startIndex) {
  const s = sessions.get(id);
  if (!s) throw new Error("run not found");
  const from = startIndex === undefined ? 0 : startIndex < 0 ? Math.max(0, s.events.length + startIndex) : startIndex;
  const items = s.events.slice(from);
  return new ReadableStream({
    start(c) {
      for (const e of items) c.enqueue(e);
      c.close();
    },
  });
}
/** eve's send: DELIVER by token when one is live, else start a new session carrying it (channel/send.js). */
async function send(payload, options) {
  const input = typeof payload === "string" || Array.isArray(payload) ? { message: payload } : payload;
  for (const [id, s] of sessions) {
    if (s.token === options.continuationToken) {
      s.delivered.push(input);
      s.events.push({ type: "message.received", data: { message: String(input.message ?? "(input responses)") } });
      park(id);
      return handle(id, options.continuationToken);
    }
  }
  if (input.inputResponses?.length) throw new Error("Cannot deliver inputResponses — the target session was not found via continuation token.");
  const id = newSession(options.continuationToken);
  sessions.get(id).delivered.push(input);
  sessions.get(id).events.push({ type: "message.received", data: { message: String(input.message ?? "") } });
  park(id);
  return handle(id, options.continuationToken);
}
const routeAgent = {
  async cancelTurn({ sessionId }) {
    const s = sessions.get(sessionId);
    if (s) s.cancelled++;
    return { status: s ? "accepted" : "no_active_turn" };
  },
};

/* ---- the channel under test --------------------------------------------------------------------------------- */

const channel = (await import("../agent/channels/eve.ts")).default;
const HOST = "https://agent-api.guard.test"; // NOT loopback: eve's localDev() must not be what lets anyone in

function match(method, path, via = channel) {
  for (const route of via.routes) {
    if (route.method !== method) continue;
    const names = [];
    const re = new RegExp(`^${route.path.replace(/:([A-Za-z]+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`);
    const m = path.match(re);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

async function call(method, path, { token, body, headers = {}, host = HOST, via = channel } = {}) {
  const hit = match(method, path, via);
  assert.ok(hit, `no route for ${method} ${path}`);
  const request = new Request(`${host}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const args = {
    send,
    cancel: async () => ({ status: "no_active_turn" }),
    getSession: (id) => handle(id, ""),
    receive: async () => {
      throw new Error("not used");
    },
    params: hit.params,
    waitUntil: () => {},
    requestIp: null,
    __eveRouteAgent: routeAgent,
  };
  const res = await hit.route.handler(request, args);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ndjson or empty */
  }
  return { status: res.status, text, json };
}

const create = async (token, message = "hello", headers = {}, via = channel) => {
  const r = await call("POST", "/eve/v1/session", { token, body: { message }, headers, via });
  return { ...r, sessionId: r.json?.sessionId, ct: r.json?.continuationToken };
};
const stream = (id, token, via = channel) => call("GET", `/eve/v1/session/${encodeURIComponent(id)}/stream`, { token, via });
const post = (id, token, body, via = channel) => call("POST", `/eve/v1/session/${encodeURIComponent(id)}`, { token, body, via });
const cancel = (id, token) => call("POST", `/eve/v1/session/${encodeURIComponent(id)}/cancel`, { token, body: {} });

try {
  /* ---- the database, as production has it ---------------------------------------------------------------- */

  for (const t of TABLES) {
    const [row] = await admin`SELECT qual FROM pg_policies WHERE schemaname='public' AND tablename=${t} AND policyname='org_isolation'`;
    if (!row) continue; // agent_session_owners does not exist on main
    saved.set(t, row.qual);
    const closed = `(org_id = current_setting('app.org_id', true))`;
    await admin.unsafe(`ALTER POLICY org_isolation ON ${t} USING ${closed} WITH CHECK ${closed}`);
  }
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG_A}, 'Guard A', 'active'), (${ORG_B}, 'Guard B', 'active')`;
  for (const [org, email] of [[ORG_A, ALICE], [ORG_A, BOB], [ORG_A, PAT], [ORG_A, VIC], [ORG_A, REX], [ORG_B, CAROL]]) {
    await admin`INSERT INTO org_members (org_id, email, role) VALUES (${org}, ${email}, 'member')`;
  }
  const [who] = await postgres(appUrl, { prepare: false, max: 1 })`SELECT current_user AS u, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`;
  assert.ok(!who.b, `${who.u} bypasses RLS — this test would prove nothing`);
  console.log(`\nAs ${who.u}, policies fail-closed on ${[...saved.keys()].join(", ")}; host ${HOST} (not loopback)`);

  const T = {
    alice: await emailToken(ALICE),
    bob: await emailToken(BOB),
    carol: await emailToken(CAROL),
    pat: await emailToken(PAT),
    vic: await emailToken(VIC),
    rex: await emailToken(REX),
  };

  /* ---- a brand-new session ------------------------------------------------------------------------------- */

  console.log("\nA BRAND-NEW session (created a moment ago, never mirrored anywhere):");
  const s1 = await create(T.alice, "Alice's secret: the data-room password is HUNTER2.");
  check("the owner creates it (202)", s1.status === 202 && Boolean(s1.sessionId), s1.status);
  const S = s1.sessionId;
  const ownerRows = saved.has("agent_session_owners")
    ? await admin`SELECT org_id, owner_email, token_sha256 FROM agent_session_owners WHERE session_id = ${S}`
    : [];
  check(
    "…and its owner, workspace and token hash are recorded before the id is returned",
    ownerRows.length === 1 && ownerRows[0].owner_email === ALICE && ownerRows[0].org_id === ORG_A && Boolean(ownerRows[0].token_sha256),
    ownerRows,
  );

  for (const [label, token] of [["another workspace", T.carol], ["the SAME workspace, not the owner", T.bob]]) {
    const r = await stream(S, token);
    check(`${label}: stream → 404, and not one byte of the transcript`, r.status === 404 && !r.text.includes("HUNTER2") && !r.text.includes(s1.ct), { status: r.status, leaked: r.text.includes("HUNTER2") });
    const m = await post(S, token, { message: "injected", continuationToken: s1.ct });
    check(`${label}: message → 404, nothing delivered`, m.status === 404 && sessions.get(S).delivered.length === 1, m.status);
    const a = await post(S, token, { inputResponses: [{ requestId: "r1", optionId: "approve" }], continuationToken: s1.ct });
    check(`${label}: approval answer (inputResponses) → 404`, a.status === 404 && sessions.get(S).delivered.length === 1, a.status);
    const c = await cancel(S, token);
    check(`${label}: cancel → 404, turn untouched`, c.status === 404 && sessions.get(S).cancelled === 0, c.status);
  }
  const own = await stream(S, T.alice);
  check("the owner reads it (200), token included", own.status === 200 && own.text.includes("HUNTER2") && own.text.includes(s1.ct), own.status);
  const ownPost = await post(S, T.alice, { message: "and another thing", continuationToken: s1.ct });
  check("the owner sends into it (200)", ownPost.status === 200 && sessions.get(S).delivered.length === 2, ownPost.status);
  const ownAnswer = await post(S, T.alice, { inputResponses: [{ requestId: "r1", optionId: "approve" }], continuationToken: s1.ct });
  check("the owner answers an approval (200)", ownAnswer.status === 200, ownAnswer.status);
  const ownCancel = await cancel(S, T.alice);
  check("the owner cancels (202)", ownCancel.status === 202 && sessions.get(S).cancelled === 1, ownCancel.status);

  /* ---- a continuation token is bound to its session ------------------------------------------------------ */

  console.log("\nA continuation token belongs to ONE session (eve delivers by token, not by the id in the path):");
  const s2 = await create(T.bob, "Bob's own chat");
  const before = sessions.get(S).delivered.length;
  const cross = await post(s2.sessionId, T.bob, { message: "into Alice's, via my own session id", continuationToken: s1.ct });
  check("Bob, on HIS session id with ALICE's token → 404, nothing lands in hers", cross.status === 404 && sessions.get(S).delivered.length === before, cross.status);
  const bobOwn = await post(s2.sessionId, T.bob, { message: "mine", continuationToken: s2.ct });
  check("…while his own token on his own session works (200)", bobOwn.status === 200, bobOwn.status);

  /* ---- a shared thread ----------------------------------------------------------------------------------- */

  console.log("\nA SHARED thread on Alice's session:");
  const [thread] = await admin`
    INSERT INTO chat_threads (org_id, eve_session_id, title, owner_email) VALUES (${ORG_A}, ${S}, 'shared', ${ALICE}) RETURNING id`;
  await admin`INSERT INTO chat_thread_members (org_id, thread_id, email, role, status, invited_by) VALUES
    (${ORG_A}, ${thread.id}, ${PAT}, 'participant', 'accepted', ${ALICE}),
    (${ORG_A}, ${thread.id}, ${VIC}, 'viewer', 'accepted', ${ALICE})`;
  await admin`INSERT INTO chat_thread_members (org_id, thread_id, email, role, status, invited_by, revoked_at) VALUES
    (${ORG_A}, ${thread.id}, ${REX}, 'participant', 'revoked', ${ALICE}, now())`;
  const pr = await stream(S, T.pat);
  check("a participant reads it (200) — with the token the multiplayer relay needs", pr.status === 200 && pr.text.includes(s1.ct), pr.status);
  const pp = await post(S, T.pat, { message: "[from: pat] hi", continuationToken: s1.ct });
  check("…and sends into it (200)", pp.status === 200, pp.status);
  const vr = await stream(S, T.vic);
  check("a viewer reads it (200) — WITHOUT the continuation token", vr.status === 200 && vr.text.includes("HUNTER2") && !vr.text.includes("continuationToken"), { status: vr.status, token: vr.text.includes("continuationToken") });
  const vp = await post(S, T.vic, { message: "viewer tries", continuationToken: s1.ct });
  check("…but cannot send (404)", vp.status === 404, vp.status);
  const va = await post(S, T.vic, { inputResponses: [{ requestId: "r1", optionId: "approve" }], continuationToken: s1.ct });
  check("…or answer an approval (404)", va.status === 404, va.status);
  const vc = await cancel(S, T.vic);
  check("…or cancel (404)", vc.status === 404, vc.status);
  const rr = await stream(S, T.rex);
  check("a REVOKED participant is refused (404)", rr.status === 404, rr.status);
  // A thread row anybody can write (POST /api/ops/threads names any session): Bob "shares" Alice's session with Carol.
  const [forged] = await admin`
    INSERT INTO chat_threads (org_id, eve_session_id, title, owner_email) VALUES (${ORG_A}, ${S}, 'forged', ${BOB}) RETURNING id`;
  await admin`INSERT INTO chat_thread_members (org_id, thread_id, email, role, status, invited_by) VALUES (${ORG_A}, ${forged.id}, ${CAROL}, 'participant', 'accepted', ${BOB})`;
  check("a thread Bob wrote on Alice's session admits neither Bob…", (await stream(S, T.bob)).status === 404);
  check("…nor the person he 'shared' it with", (await stream(S, T.carol)).status === 404);

  /* ---- a session from before the record: mirrored in the chat list --------------------------------------- */

  console.log("\nA session from BEFORE owners were recorded (mirrored in Alice's chat list):");
  const L = newSession("eve:legacy-token");
  sessions.get(L).events.push({ type: "message.received", data: { message: "legacy secret LEGACY-42" } });
  park(L);
  await admin`INSERT INTO chat_sessions (id, org_id, owner_email, eve_session_id, title) VALUES ('guard-legacy', ${ORG_A}, ${ALICE}, ${L}, 'old chat')`;
  await admin`INSERT INTO agent_session_scopes (session_id, org_id, principal_email) VALUES (${L}, ${ORG_A}, ${ALICE})`;
  check("the owner still reads it (200)", (await stream(L, T.alice)).status === 200);
  check("another workspace is refused (404)", (await stream(L, T.carol)).status === 404);
  check("the same workspace, not the owner, is refused (404)", (await stream(L, T.bob)).status === 404);
  const lp = await post(L, T.alice, { message: "continue the old one", continuationToken: "eve:legacy-token" });
  check("the owner continues it with its token (200 — verified against eve's own latest session.waiting)", lp.status === 200, lp.status);

  /* ---- nothing on record ------------------------------------------------------------------------------ */

  console.log("\nPre-existing sessions whose only record is agent_session_scopes (last writer won while the hole was open):");
  // (a) Alice's un-mirrored chat, into which Bob posted once: the scope row now names BOB.
  const P = newSession("eve:poisoned");
  sessions.get(P).events.push({ type: "message.received", data: { message: "Alice's POISON-9" } });
  park(P);
  await admin`INSERT INTO agent_session_scopes (session_id, org_id, principal_email) VALUES (${P}, ${ORG_A}, ${BOB})`;
  check("the colleague the poisoned scope row names is NOT crowned owner (404)", (await stream(P, T.bob)).status === 404);
  check("…nor is anyone else in the workspace let in (404)", (await stream(P, T.pat)).status === 404);
  if (saved.has("agent_session_owners")) {
    const rows = await admin`SELECT 1 FROM agent_session_owners WHERE session_id = ${P}`;
    check("…and nothing was frozen, so the real owner can still be established", rows.length === 0, rows.length);
  }
  await admin`INSERT INTO chat_sessions (id, org_id, owner_email, eve_session_id, title) VALUES ('guard-poisoned', ${ORG_A}, ${ALICE}, ${P}, 'old chat')`;
  check("once the chat list mirrors it, its real owner reads it (200)", (await stream(P, T.alice)).status === 200);
  check("…and the scope row's colleague still does not (404)", (await stream(P, T.bob)).status === 404);
  // (b) an ordinary un-mirrored chat, scope row intact.
  const U = newSession("eve:unmirrored");
  park(U);
  await admin`INSERT INTO agent_session_scopes (session_id, org_id, principal_email) VALUES (${U}, ${ORG_A}, ${ALICE})`;
  check("an un-mirrored chat is NOT workspace-visible: a colleague is refused (404)", (await stream(U, T.bob)).status === 404);
  // (c) a genuine pre-deploy workflow step: the run journal names it.
  const W = newSession("eve:legacy-step");
  sessions.get(W).events.push({ type: "message.completed", data: { message: "step output STEP-5" } });
  park(W);
  await admin`INSERT INTO agent_session_scopes (session_id, org_id, principal_email) VALUES (${W}, ${ORG_A}, NULL)`;
  await admin`INSERT INTO workflow_run_journal (org_id, run_id, call_index, prompt, status, session_id)
              VALUES (${ORG_A}, 'wfr_guardlegacy1', 0, 'summarise', 'completed', ${W})`;
  check("a pre-deploy workflow step is still open to the workspace (200)", (await stream(W, T.bob)).status === 200);
  check("…read-only (404 on a message)", (await post(W, T.bob, { message: "steer", continuationToken: "eve:legacy-step" })).status === 404);
  check("…and closed to other workspaces (404)", (await stream(W, T.carol)).status === 404);
  const Wc = newSession("subagent:legacy-step-child");
  park(Wc);
  await admin`UPDATE workflow_run_journal SET child_session_id = ${Wc} WHERE run_id = 'wfr_guardlegacy1'`;
  check("…and so is its delegated child, named in the journal (200)", (await stream(Wc, T.bob)).status === 200);

  console.log("\nA session id nobody has any record of:");
  const ghost = newSession("eve:ghost");
  park(ghost);
  check("is refused to every caller (404) — the old 'unknown, allow' branch is gone", (await stream(ghost, T.alice)).status === 404 && (await stream(ghost, T.carol)).status === 404);

  /* ---- a subagent's child session -------------------------------------------------------------------- */

  console.log("\nA subagent's CHILD session (eve creates it; its id is announced only on the parent's stream):");
  // What eve dev showed live: a child's first event can be session.failed, and in 0.25.1 its session.started carries
  // no parent anyway. The parent's `subagent.called` is the one authoritative place the relationship appears.
  const C = newSession("subagent:child", { type: "session.failed", data: { code: "FatalError" } });
  sessions.get(C).events.unshift({ type: "message.completed", data: { message: "child found CHILD-SECRET" } });
  check("before any parent stream announces it, even the root's owner is refused (404)", (await stream(C, T.alice)).status === 404);
  sessions.get(S).events.push({ type: "subagent.called", data: { callId: "call_1", childSessionId: C, name: "research", sessionId: S } });
  const announced = await stream(S, T.pat); // a participant tails the parent, as the rail does
  check("the parent's stream carries the announcement (200)", announced.status === 200 && announced.text.includes(C));
  if (saved.has("agent_session_owners")) {
    const [row] = await admin`SELECT owner_email, parent_session_id FROM agent_session_owners WHERE session_id = ${C}`;
    check("…and the child's owner was on record BEFORE that line left the agent", row?.owner_email === ALICE && row?.parent_session_id === S, row);
  }
  check("the root's owner reads the child (200)", (await stream(C, T.alice)).status === 200);
  check("the root's participant reads the child (200)", (await stream(C, T.pat)).status === 200);
  check("the root's viewer reads the child (200) but may not steer it (404)", (await stream(C, T.vic)).status === 200 && (await post(C, T.vic, { message: "steer" })).status === 404);
  check("another workspace is refused (404)", (await stream(C, T.carol)).status === 404);
  check("the same workspace, not the owner, is refused (404)", (await stream(C, T.bob)).status === 404);
  // A delegation announced on a stream the caller may NOT read is never learned from their request.
  const ghostChild = newSession("subagent:ghost");
  sessions.get(s2.sessionId).events.push({ type: "subagent.called", data: { childSessionId: ghostChild, sessionId: s2.sessionId } });
  check("a stranger's read of someone else's parent is refused, and records nothing", (await stream(s2.sessionId, T.carol)).status === 404 && (await stream(ghostChild, T.bob)).status === 404);

  /* ---- workflow delegate and service principals ------------------------------------------------------ */

  console.log("\nThe workflow delegate (lib/workflow-delegate.ts) and the platform's own service token:");
  // What the delegate sends: the operator's token, the workspace, and the web app's signed grant for that operator.
  const step = await create(T.alice, "workflow step", {
    "x-session-visibility-grant": await stepGrant(ALICE),
    "x-session-visibility": "workspace", // what be160d2 read; now ignored
    "x-workspace-scope": ORG_A,
  });
  check("a step started with the operator's token is created (202)", step.status === 202, step.status);
  check("…read back by the delegate with that token (200)", (await stream(step.sessionId, T.alice)).status === 200);
  check("…and steered by its initiator (200)", (await post(step.sessionId, T.alice, { message: "focus on Q3", continuationToken: step.ct })).status === 200);
  check("…opened from the run timeline by a colleague in the workspace (200)", (await stream(step.sessionId, T.bob)).status === 200);
  check("…but a colleague may NOT steer it (404)", (await post(step.sessionId, T.bob, { message: "steer", continuationToken: step.ct })).status === 404);
  check("…or answer its approval (404)", (await post(step.sessionId, T.bob, { inputResponses: [{ requestId: "r1", optionId: "approve" }], continuationToken: step.ct })).status === 404);
  check("…or cancel it (404)", (await cancel(step.sessionId, T.bob)).status === 404 && sessions.get(step.sessionId).cancelled === 0);
  check("…and nobody outside the workspace reads it (404)", (await stream(step.sessionId, T.carol)).status === 404);

  console.log("\nWho may make a session workspace-visible:");
  const bare = await create(T.alice, "an ordinary chat", { "x-session-visibility": "workspace" });
  check("an ordinary client's bare `x-session-visibility: workspace` does nothing — a colleague is refused (404)", (await stream(bare.sessionId, T.bob)).status === 404);
  const othersGrant = await create(T.bob, "Bob's chat", { "x-session-visibility-grant": await stepGrant(ALICE) });
  check("a grant signed for someone ELSE does nothing (404)", (await stream(othersGrant.sessionId, T.pat)).status === 404);
  const { privateKey: forger } = await generateKeyPair("ES256");
  const forgedGrant = await create(T.bob, "Bob's chat", { "x-session-visibility-grant": await stepGrant(BOB, forger) });
  check("a grant not signed by the web app's key does nothing (404)", (await stream(forgedGrant.sessionId, T.pat)).status === 404);
  check("a grant is not a sign-in (401 as a bearer)", (await stream(step.sessionId, await stepGrant(ALICE))).status === 401);

  process.env.VERCEL_ENV = "production";
  const svc = await serviceToken();
  const cronStep = await create(svc, "cron step", { "x-workspace-scope": ORG_A });
  check("the front-end's production token starts a step for workspace A (202)", cronStep.status === 202, cronStep);
  check("…reads it back (200)", (await stream(cronStep.sessionId, svc)).status === 200);
  check("…and it is visible to workspace A's members (200)", (await stream(cronStep.sessionId, T.bob)).status === 200);
  check("…read-only: a member may not cancel it directly (404)", (await cancel(cronStep.sessionId, T.bob)).status === 404);
  check(
    "…the run-cancel route's fan-out (service token, scoped to the run's workspace) cancels it (202)",
    (await call("POST", `/eve/v1/session/${cronStep.sessionId}/cancel`, { token: svc, body: {}, headers: { "x-workspace-scope": ORG_A } })).status === 202,
  );
  check("…and so does it for a person's step in that workspace (202)", (await call("POST", `/eve/v1/session/${step.sessionId}/cancel`, { token: svc, body: {}, headers: { "x-workspace-scope": ORG_A } })).status === 202);
  check("…and to nobody outside it (404)", (await stream(cronStep.sessionId, T.carol)).status === 404);
  check("the service reads a person's chat (resume, relay) (200)", (await stream(S, svc)).status === 200);
  const wrongScope = await call("GET", `/eve/v1/session/${S}/stream`, { token: svc, headers: { "x-workspace-scope": ORG_B } });
  check("…but not while naming ANOTHER workspace than the session's (404)", wrongScope.status === 404, wrongScope.status);

  /* ---- token kinds ----------------------------------------------------------------------------------- */

  console.log("\nToken kinds (emailSessionAuth checks `kind`):");
  const oddKind = await emailToken(ALICE, { kind: "password-reset" });
  check("a token of an unknown kind is not a sign-in (401 on create)", (await create(oddKind)).status === 401);
  check("…nor on the owner's own stream (401)", (await stream(S, oddKind)).status === 401);
  const signInWithSid = await emailToken(ALICE, { sid: S });
  check(
    "a SIGN-IN token that also names a session (`sid`) is held to that one session",
    (await stream(S, signInWithSid)).status === 200 && (await stream(step.sessionId, signInWithSid)).status === 404,
  );

  /* ---- PR #63's queue-delivery door, composed the way #63 will compose it ---------------------------------- */

  console.log("\nA session-bound token (PR #63 queue delivery) behind a door that admits it EVERYWHERE:");
  // The worst door #63 could ship: verifies signature, issuer, audience and kind, and checks no route at all. The
  // guard must still hold it to its one session and its owner — the door can only narrow, never widen.
  const { eveChannel } = await import("eve/channels/eve");
  const { jwtEcdsa } = await import("eve/channels/auth");
  // Absent on `main` (where this test was first run): reported as a failure, and the rest of the matrix still runs.
  const guardSessionRoutes = await import("../agent/lib/session-guard.ts").then(
    (m) => m.guardSessionRoutes,
    () => (ch) => ch,
  );
  const pub = process.env.AUTH_JWT_PUBLIC_KEY;
  const doors = [
    jwtEcdsa({ algorithm: "ES256", publicKey: pub, issuer: "delivered", audiences: ["delivered-app"], claims: { kind: ["email-session"] } }),
    jwtEcdsa({ algorithm: "ES256", publicKey: pub, issuer: "delivered", audiences: ["delivered-queue-delivery"], claims: { kind: ["queue-delivery"] } }),
  ];
  const with63 = guardSessionRoutes(eveChannel({ auth: doors }), { auth: doors });
  const q = await queueToken(ALICE, S);
  check("it reads ITS session (200)", (await stream(S, q, with63)).status === 200);
  check("…and delivers the queued message into it (200)", (await post(S, q, { message: "queued while away", continuationToken: s1.ct }, with63)).status === 200);
  check("…and nothing else of its owner's (404)", (await stream(step.sessionId, q, with63)).status === 404);
  check("…and never starts a session (404)", (await create(q, "new", {}, with63)).status === 404);
  const qForeign = await queueToken(BOB, S);
  check("one minted for someone who does not own the session is refused (404)", (await stream(S, qForeign, with63)).status === 404);
  const qElsewhere = await queueToken(CAROL, S, ORG_B);
  check("…from another workspace too (404)", (await post(S, qElsewhere, { message: "x", continuationToken: s1.ct }, with63)).status === 404);
  check("the real channel (no #63 door yet) does not accept it at all (401)", (await stream(S, q)).status === 401);

  /* ---- the recorded owner never moves ------------------------------------------------------------------- */

  console.log("\nNobody who speaks later becomes the owner (first writer wins):");
  // Each import below is a FRESH copy of the module — an empty process cache, i.e. a cold serverless instance, which
  // is where the old upsert let a later speaker through (a warm one skipped the write on its cache hit).
  const cold = async (n) => (await import(`../agent/lib/session-scope.ts?cold=${n}`)).recordSessionScope;
  // The session's first turn records its scope (runtime-context.ts), as the real runtime does.
  await (await cold(0))(S, ORG_A, ALICE);
  // …then later turns start, each on a cold instance: the participant's, a colleague's, a service step's, and one
  // from another workspace.
  await (await cold(1))(S, ORG_A, PAT);
  await (await cold(2))(S, ORG_A, BOB);
  await (await cold(3))(S, ORG_A, undefined, { service: true });
  await (await cold(4))(S, ORG_B, CAROL);
  const [scope] = await admin`SELECT org_id, principal_email FROM agent_session_scopes WHERE session_id = ${S}`;
  check("agent_session_scopes still names the first writer, in its workspace", scope?.principal_email === ALICE && scope?.org_id === ORG_A, scope);
  if (saved.has("agent_session_owners")) {
    const [row] = await admin`SELECT org_id, owner_email FROM agent_session_owners WHERE session_id = ${S}`;
    check("the owner record is untouched by every post above (participant, service, queue token)", row?.owner_email === ALICE && row?.org_id === ORG_A, row);
  }
  check("…and the gate still admits exactly who it did: the owner (200)", (await stream(S, T.alice)).status === 200);
  check("…not the later speaker from another workspace (404)", (await stream(S, T.carol)).status === 404);

  /* ---- localDev -------------------------------------------------------------------------------------- */

  console.log("\n`eve dev`'s local-dev door:");
  const saveEnv = { NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, VERCEL: process.env.VERCEL };
  process.env.NODE_ENV = "production";
  const spoof = await call("GET", `/eve/v1/session/${S}/stream`, { host: "http://localhost:3000" });
  check("a production process refuses Host: localhost with no credentials (401)", spoof.status === 401, spoof.status);
  process.env.NODE_ENV = "development";
  process.env.EVE_DEV = "1";
  process.env.VERCEL_ENV = "preview";
  check("…and so does a preview deployment, even marked as eve dev (401)", (await call("GET", `/eve/v1/session/${S}/stream`, { host: "http://localhost:3000" })).status === 401);
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL;
  delete process.env.EVE_DEV;
  delete process.env.NODE_ENV;
  check(
    "…and so does a built server with NODE_ENV unset (a VM that forgot it) — not a dev server (401)",
    (await call("GET", `/eve/v1/session/${S}/stream`, { host: "http://localhost:3000" })).status === 401,
  );
  process.env.EVE_DEV = "1"; // what `eve dev` sets in its own process
  check("`eve dev` on loopback is still let in, as local development needs (200)", (await call("GET", `/eve/v1/session/${S}/stream`, { host: "http://localhost:3000" })).status === 200);
  delete process.env.EVE_DEV;
  if (saveEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saveEnv.NODE_ENV;
  process.env.VERCEL_ENV = "production";

  /* ---- the database is down -------------------------------------------------------------------------- */

  console.log("\nThe database cannot be reached:");
  const realUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://app_rw:x@127.0.0.1:9/nowhere"; // nothing listens on port 9
  const down = await stream(S, T.carol);
  check("a stranger gets 503 — CLOSED, not the transcript", down.status === 503 && !down.text.includes("HUNTER2"), down.status);
  const downOwner = await post(S, T.alice, { message: "while down", continuationToken: s1.ct });
  check("…and so does the owner on a per-session route (503)", downOwner.status === 503, downOwner.status);
  const downCreate = await create(T.alice, "new while down");
  check("a new session is not started without its owner recorded (503)", downCreate.status === 503, downCreate.status);
  process.env.DATABASE_URL = realUrl;
  const back = await stream(S, T.alice);
  check("…and it recovers when the database does (200)", back.status === 200, back.status);
} finally {
  await cleanup().catch(() => undefined);
  for (const [t, qual] of saved) {
    await admin.unsafe(`ALTER POLICY org_isolation ON ${t} USING (${qual}) WITH CHECK (${qual})`).catch(() => undefined);
  }
  await admin.end();
}

console.log(failures === 0 ? "\ntest-session-guard: all assertions passed" : `\ntest-session-guard: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
