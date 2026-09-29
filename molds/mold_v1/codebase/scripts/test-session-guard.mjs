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
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// The web app's `@/` alias and extensionless imports, so lib/chat-session-access.ts (the transcript cache rule) is
// loaded as the app loads it — the same resolver scripts/test-agent-vocabulary.mjs uses.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      const ROOT = ${JSON.stringify(pathToFileURL(process.cwd() + "/").href)};
      export async function resolve(s, c, n) {
        if (s.startsWith("@/")) s = ROOT + s.slice(2);
        try { return await n(s, c); } catch (e) {
          if (s.endsWith(".js")) return await n(s.slice(0, -3) + ".ts", c);
          if (!/\\.[cm]?[jt]sx?$/.test(s)) return await n(s + ".ts", c);
          throw e;
        }
      }`),
  import.meta.url,
);
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
process.env.NEXT_PUBLIC_EVE_API_URL = "https://agent-delegate.guard.test"; // lib/workflow-delegate.ts reads it at import
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
const queueToken = (email, sid, org = ORG_A, extra = {}) =>
  emailToken(email, { kind: "queue-delivery", org, sid, ...extra }, "delivered-queue-delivery");

const ORG_A = "org-guard-a";
const ORG_B = "org-guard-b";
const ALICE = "alice@guard-a.test"; // the owner
const BOB = "bob@guard-a.test"; // same workspace, not the owner
const CAROL = "carol@guard-b.test"; // another workspace
const PAT = "pat@guard-a.test"; // participant on alice's shared thread
const VIC = "vic@guard-a.test"; // viewer on it
const REX = "rex@guard-a.test"; // revoked from it

const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });
const TABLES = ["agent_session_owners", "agent_session_scopes", "chat_sessions", "chat_threads", "chat_thread_members", "chat_transcript_snapshots"];
const saved = new Map();
const cleanup = async () => {
  await admin`DELETE FROM chat_thread_members WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM chat_threads WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM chat_sessions WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM chat_transcript_snapshots WHERE org_id IN (${ORG_A}, ${ORG_B})`;
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
/**
 * eve's event stream. Like eve's, a LIVE session's stream never ends (`s.live`: after its events it waits for more,
 * forever), and a long history takes time to read (`s.delayMs` per event) — so the guard's history reads meet their
 * idle and deadline paths here as they do in production.
 */
function eventStream(id, startIndex) {
  const s = sessions.get(id);
  if (!s) throw new Error("run not found");
  const from = startIndex === undefined ? 0 : startIndex < 0 ? Math.max(0, s.events.length + startIndex) : startIndex;
  if (!s.live && !s.delayMs) {
    const items = s.events.slice(from);
    return new ReadableStream({
      start(c) {
        for (const e of items) c.enqueue(e);
        c.close();
      },
    });
  }
  let i = from;
  return new ReadableStream({
    async pull(c) {
      for (;;) {
        if (i < s.events.length) {
          if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
          c.enqueue(s.events[i++]);
          return;
        }
        if (!s.live) return c.close();
        await new Promise((r) => setTimeout(r, 20)); // a live tail: wait for the next event, forever
      }
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

function match(method, pathAndQuery, via = channel) {
  const path = pathAndQuery.split("?")[0];
  for (const route of via.routes) {
    if (route.method !== method) continue;
    const names = [];
    const re = new RegExp(`^${route.path.replace(/:([A-Za-z]+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`);
    const m = path.match(re);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

async function call(method, path, { token, body, headers = {}, host = HOST, via = channel, peekMs } = {}) {
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
  // A live stream never ends: `peekMs` reads what arrives in that long, then hangs up, as a tail probe does.
  let text = "";
  if (peekMs !== undefined && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const stopAt = Date.now() + peekMs;
    for (;;) {
      const left = stopAt - Date.now();
      if (left <= 0) break;
      const next = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), left))]);
      if (!next || next.done) break;
      text += dec.decode(next.value, { stream: true });
    }
    void reader.cancel().catch(() => undefined);
  } else text = await res.text();
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

  /* ---- children delegated BEFORE lineage was recorded (mold_v1-133) ------------------------------------- */

  console.log("\nA child delegated BEFORE lineage was recorded (#66), its parent reopened from the transcript cache:");
  // The parent announced the child long ago, before the guard recorded lineage; the chat now reopens from its cached
  // transcript and streams only what is new (startIndex > 0), so the announcement never passes the guard again.
  const old = await create(T.alice, "an old conversation that delegated");
  const OC = newSession("subagent:pre-66-child");
  sessions.get(OC).events.unshift({ type: "message.completed", data: { message: "PRE66-CHILD-SECRET" } });
  sessions.get(old.sessionId).events.push(
    { type: "subagent.called", data: { callId: "call_old", childSessionId: OC, name: "research", sessionId: old.sessionId } },
    { type: "subagent.completed", data: { callId: "call_old", childSessionId: OC } },
    { type: "message.completed", data: { message: "done" } },
  );
  const cursor = sessions.get(old.sessionId).events.length;
  check("before anything, the child is refused even to its owner (the reported 404)", (await stream(OC, T.alice)).status === 404);
  const tail = await call("GET", `/eve/v1/session/${old.sessionId}/stream?startIndex=${cursor}`, { token: T.carol });
  check("a stranger's read of the parent from its cursor is refused (404)…", tail.status === 404);
  check("…and records nothing: the child is still refused to its owner", (await stream(OC, T.alice)).status === 404);
  const resumed = await call("GET", `/eve/v1/session/${old.sessionId}/stream?startIndex=${cursor}`, { token: T.alice });
  check("the owner reopens the parent from the cache's cursor (200, the announcement NOT in what is streamed)", resumed.status === 200 && !resumed.text.includes(OC), resumed.status);
  const [oldRow] = await admin`SELECT owner_email, parent_session_id, org_id FROM agent_session_owners WHERE session_id = ${OC}`;
  check("…and the skipped history was read server-side: the child now has the parent's owner on record", oldRow?.owner_email === ALICE && oldRow?.parent_session_id === old.sessionId && oldRow?.org_id === ORG_A, oldRow);
  const oc = await stream(OC, T.alice);
  check("the owner opens the child (200)", oc.status === 200 && oc.text.includes("PRE66-CHILD-SECRET"), oc.status);
  check("…and nobody else does: not a colleague (404), not another workspace (404)", (await stream(OC, T.bob)).status === 404 && (await stream(OC, T.carol)).status === 404);
  const tailed = await create(T.alice, "another old conversation");
  const OT = newSession("subagent:pre-66-tail-child");
  sessions.get(tailed.sessionId).events.push({ type: "subagent.called", data: { childSessionId: OT, sessionId: tailed.sessionId } }, { type: "message.completed", data: { message: "x" } });
  await call("GET", `/eve/v1/session/${tailed.sessionId}/stream?startIndex=-1`, { token: T.alice });
  // A tail read never waits for the history (it is a latency-sensitive probe); the children land moments later.
  let tailChild = 404;
  for (let i = 0; i < 25 && tailChild !== 200; i++) {
    tailChild = (await stream(OT, T.alice)).status;
    if (tailChild !== 200) await new Promise((r) => setTimeout(r, 40));
  }
  check("a read from the TAIL (startIndex=-1) records the history's children too, in the background", tailChild === 200, tailChild);

  console.log("\nThe one-time deploy backfill (scripts/backfill-session-lineage.mjs), replaying each root as its owner:");
  const lineage = await import("../agent/lib/session-lineage-backfill.ts").catch((e) => ({ missing: String(e) }));
  check("agent/lib/session-lineage-backfill.ts exists", !lineage.missing, lineage.missing);
  if (!lineage.missing) {
    const quiet = await create(T.alice, "a conversation nobody has reopened since");
    const QC = newSession("subagent:quiet-child");
    sessions.get(quiet.sessionId).events.push({ type: "subagent.called", data: { childSessionId: QC, sessionId: quiet.sessionId } });
    // Bob's parent: its child must go to BOB, never to whoever runs the backfill or owns the other parents.
    const bobs = await create(T.bob, "Bob's delegating chat");
    const BC = newSession("subagent:bobs-child");
    sessions.get(bobs.sessionId).events.push({ type: "subagent.called", data: { childSessionId: BC, sessionId: bobs.sessionId } });
    const { agentGateDb } = await import("../agent/lib/session-owners.ts");
    const parents = await lineage.listLineageParents(agentGateDb(), [ORG_A, ORG_B]);
    check("it lists the owned roots (not the children) with their owners", parents.some((p) => p.sessionId === quiet.sessionId && p.ownerEmail === ALICE) && parents.some((p) => p.sessionId === bobs.sessionId && p.ownerEmail === BOB) && !parents.some((p) => p.sessionId === OC), parents.length);
    const replay = async (p) => {
      const r = await call("GET", `/eve/v1/session/${encodeURIComponent(p.sessionId)}/stream?startIndex=0`, { token: await queueToken(p.ownerEmail, p.sessionId, p.orgId, { act: "read" }) });
      return { status: r.status, body: new Response(r.text).body };
    };
    const first = await lineage.backfillLineage(parents, replay, { idleMs: 50 });
    check("every root replays through the guard as its owner, none fails", first.failed === 0 && first.replayed >= 2, first);
    const [qr] = await admin`SELECT owner_email, parent_session_id FROM agent_session_owners WHERE session_id = ${QC}`;
    const [br] = await admin`SELECT owner_email, parent_session_id FROM agent_session_owners WHERE session_id = ${BC}`;
    check("the quiet child is Alice's, under its parent", qr?.owner_email === ALICE && qr?.parent_session_id === quiet.sessionId, qr);
    check("Bob's child is Bob's", br?.owner_email === BOB && br?.parent_session_id === bobs.sessionId, br);
    check("…so Alice opens hers (200) and not Bob's (404)", (await stream(QC, T.alice)).status === 200 && (await stream(BC, T.alice)).status === 404);
    const [{ n: before }] = await admin`SELECT count(*)::int AS n FROM agent_session_owners WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    const again = await lineage.backfillLineage(parents, replay, { idleMs: 50 });
    const [{ n: after }] = await admin`SELECT count(*)::int AS n FROM agent_session_owners WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    check("running it again changes nothing (idempotent)", again.failed === 0 && after === before, { before, after });
    const forged = await lineage.backfillLineage([{ orgId: ORG_A, sessionId: quiet.sessionId, ownerEmail: BOB }], replay, { idleMs: 50 });
    check("a replay as someone who does not own the parent is refused and records nothing", forged.refused === 1 && forged.replayed === 0, forged);

    // #75 review: the backfill replayed roots only, so a GRANDCHILD delegated before #66 — announced on its parent
    // child's stream — was never reached.
    const G = await create(T.alice, "a root whose specialist delegated again");
    const GC = newSession("subagent:child");
    const GGC = newSession("subagent:grandchild");
    sessions.get(G.sessionId).events.push({ type: "subagent.called", data: { childSessionId: GC, sessionId: G.sessionId } });
    sessions.get(GC).events.push({ type: "subagent.called", data: { childSessionId: GGC, sessionId: GC } });
    const deep = await lineage.backfillLineage([{ orgId: ORG_A, sessionId: G.sessionId, ownerEmail: ALICE }], replay, { idleMs: 50 });
    const [ggr] = await admin`SELECT owner_email, parent_session_id FROM agent_session_owners WHERE session_id = ${GGC}`;
    check("the backfill follows each child it finds: a pre-#66 GRANDCHILD is Alice's, under its parent child", ggr?.owner_email === ALICE && ggr?.parent_session_id === GC, { ggr, deep });
    check("…and Alice opens it (200) while a colleague does not (404)", (await stream(GGC, T.alice)).status === 200 && (await stream(GGC, T.bob)).status === 404);

    // #75 review, item 6: a pre-#66 chat with no owner record is refused by the cached-transcript and fast-replay
    // routes (the client falls back to a slower direct stream). The backfill's replay freezes its owner from the
    // chat list the way the guard's legacy rule does, and from then on those routes serve it.
    const LG = newSession("eve:legacy-cached");
    sessions.get(LG).events.push({ type: "message.received", data: { message: "legacy cached chat" } });
    park(LG);
    await admin`INSERT INTO chat_sessions (id, org_id, owner_email, eve_session_id, title) VALUES ('guard-legacy-cached', ${ORG_A}, ${ALICE}, ${LG}, 'old cached chat')`;
    await admin`INSERT INTO agent_session_scopes (session_id, org_id, principal_email) VALUES (${LG}, ${ORG_A}, ${ALICE})`;
    const { accessForSession } = await import("../lib/chat-session-access.ts");
    const beforeFill = await accessForSession(ORG_A, ALICE, LG);
    check("before the backfill, a pre-#66 chat with no owner record is refused by the transcript routes", !beforeFill.read && !beforeFill.write, beforeFill);
    const legacyParents = (await lineage.listLineageParents(agentGateDb(), [ORG_A])).filter((p) => p.sessionId === LG);
    check("…the backfill lists it (from the chat list)", legacyParents.length === 1 && legacyParents[0].ownerEmail === ALICE, legacyParents);
    await lineage.backfillLineage(legacyParents, replay, { idleMs: 50 });
    const afterFill = await accessForSession(ORG_A, ALICE, LG);
    check("…and after it the cached-transcript and fast-replay routes serve it to its owner", afterFill.read && afterFill.write, afterFill);
    check("…and to nobody else", !(await accessForSession(ORG_A, BOB, LG)).read);

    // #75 review, item 5. A tail read's history scan that hits its deadline must not mark the session scanned: the
    // next read resumes from where it stopped. Uses a guarded channel whose history read is bounded at 300 ms, over a
    // parent whose long history arrives slowly and whose stream never ends (a live tail).
    console.log("\nThe guard's history reads on a slow, never-ending stream (idle and deadline paths):");
    const { eveChannel: eveCh } = await import("eve/channels/eve");
    const { jwtEcdsa: jwtDoor } = await import("eve/channels/auth");
    const { guardSessionRoutes: guardRoutes } = await import("../agent/lib/session-guard.ts");
    const emailDoor = [jwtDoor({ algorithm: "ES256", publicKey: process.env.AUTH_JWT_PUBLIC_KEY, issuer: "delivered", audiences: ["delivered-app"], claims: { kind: ["email-session"] } })];
    const fast = guardRoutes(eveCh({ auth: emailDoor }), { auth: emailDoor, deps: { streamProbeMs: 300 } });
    const D = await create(T.alice, "a long conversation, still live");
    const DC = newSession("subagent:late-child");
    for (let i = 0; i < 38; i++) sessions.get(D.sessionId).events.push({ type: "message.appended", data: { i } });
    sessions.get(D.sessionId).events.push({ type: "subagent.called", data: { childSessionId: DC, sessionId: D.sessionId } });
    sessions.get(D.sessionId).events.push({ type: "message.completed", data: { message: "still going" } });
    Object.assign(sessions.get(D.sessionId), { live: true, delayMs: 25 });
    let tails = 0;
    let lateChild = null;
    for (; tails < 8 && !lateChild; tails++) {
      await call("GET", `/eve/v1/session/${D.sessionId}/stream?startIndex=-1`, { token: T.alice, via: fast, peekMs: 30 });
      await new Promise((r) => setTimeout(r, 400)); // the background history read, cut at its 300 ms deadline
      [lateChild] = await admin`SELECT owner_email FROM agent_session_owners WHERE session_id = ${DC}`;
    }
    check("a tail scan cut by its deadline is resumed by the next tail read, until the late child is on record", lateChild?.owner_email === ALICE && tails > 1, { tails, lateChild });

    const I = await create(T.alice, "a parked conversation, caught up");
    const IC = newSession("subagent:idle-child");
    sessions.get(I.sessionId).events.push({ type: "subagent.called", data: { childSessionId: IC, sessionId: I.sessionId } });
    Object.assign(sessions.get(I.sessionId), { live: true });
    await call("GET", `/eve/v1/session/${I.sessionId}/stream?startIndex=-1`, { token: T.alice, via: fast, peekMs: 30 });
    await new Promise((r) => setTimeout(r, 250)); // idle after the backlog (75 ms quiet), well inside the deadline
    check("a tail scan that goes quiet has caught up, and recorded the child", (await admin`SELECT 1 FROM agent_session_owners WHERE session_id = ${IC}`).length === 1);

    // The rail asks for a child a moment after its parent was served from a cursor: the guard waited at most 400 ms
    // for the skipped history, and this one takes longer. The child route awaits the read instead of refusing.
    console.log("\nA child asked for before its parent's history was read:");
    const H = await create(T.alice, "a conversation reopened from the cache");
    const HC = newSession("subagent:rail-child");
    for (let i = 0; i < 14; i++) sessions.get(H.sessionId).events.push({ type: "message.appended", data: { i } });
    sessions.get(H.sessionId).events.push({ type: "subagent.called", data: { childSessionId: HC, sessionId: H.sessionId } });
    for (let i = 0; i < 6; i++) sessions.get(H.sessionId).events.push({ type: "message.appended", data: { i } });
    const hCursor = sessions.get(H.sessionId).events.length;
    Object.assign(sessions.get(H.sessionId), { delayMs: 40 }); // ~0.9 s of history before the cursor
    const reopened = await call("GET", `/eve/v1/session/${H.sessionId}/stream?startIndex=${hCursor}`, { token: T.alice });
    check("the parent is served from its cursor without waiting for all of its history (200)", reopened.status === 200);
    const rail = await stream(HC, T.alice);
    check("the rail's immediate read of the child waits for that history read and gets the child (200), not a 404", rail.status === 200, rail.status);
    delete sessions.get(H.sessionId).delayMs;

    // On ANOTHER instance there is no read to wait for: the parent is found from the caller's own transcript cache
    // (a hint a browser wrote), checked against the gate and against eve's own history of it.
    const R = await create(T.alice, "a conversation whose child only the cache knows");
    const RC = newSession("subagent:cached-child");
    sessions.get(R.sessionId).events.push({ type: "subagent.called", data: { childSessionId: RC, sessionId: R.sessionId } });
    const snap = (org, owner, sid, events) =>
      admin`INSERT INTO chat_transcript_snapshots (org_id, eve_session_id, owner_email, version, event_index, events)
            VALUES (${org}, ${sid}, ${owner}, 1, ${events.length}, ${JSON.stringify(events)}::jsonb)`;
    await snap(ORG_A, ALICE, R.sessionId, sessions.get(R.sessionId).events);
    check("a colleague asking for that child gets 404 — he may not read its parent — and records nothing", (await stream(RC, T.bob)).status === 404 && (await admin`SELECT 1 FROM agent_session_owners WHERE session_id = ${RC}`).length === 0);
    check("another workspace gets 404", (await stream(RC, T.carol)).status === 404);
    check("its owner, on a cold instance, gets the child (200): parent found in her cache, confirmed in eve's history", (await stream(RC, T.alice)).status === 200);
    // A forged cache row: Bob's own session "announces" Alice's still-unrecorded child.
    const bobsOwn = await create(T.bob, "Bob's chat");
    const R2 = await create(T.alice, "another of Alice's");
    const R2C = newSession("subagent:unrecorded-child");
    sessions.get(R2.sessionId).events.push({ type: "subagent.called", data: { childSessionId: R2C, sessionId: R2.sessionId } });
    await snap(ORG_A, BOB, bobsOwn.sessionId, [{ type: "subagent.called", data: { childSessionId: R2C } }]);
    check("a cache row that claims someone else's child for the caller's own session gets 404 (eve's history of it disagrees)", (await stream(R2C, T.bob)).status === 404 && (await admin`SELECT 1 FROM agent_session_owners WHERE session_id = ${R2C}`).length === 0);
  }

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
  const inA = { "x-workspace-scope": ORG_A };
  const svcCall = (method, id, verb = "", headers = inA, body = method === "POST" ? {} : undefined) =>
    call(method, `/eve/v1/session/${encodeURIComponent(id)}${verb}`, { token: svc, body, headers });
  const cronStep = await create(svc, "cron step", inA);
  check("the front-end's production token starts a step for workspace A (202)", cronStep.status === 202, cronStep);
  check("…reads it back, naming the workspace (200)", (await svcCall("GET", cronStep.sessionId, "/stream")).status === 200);
  check("…and it is visible to workspace A's members (200)", (await stream(cronStep.sessionId, T.bob)).status === 200);
  check("…read-only: a member may not cancel it directly (404)", (await cancel(cronStep.sessionId, T.bob)).status === 404);
  check(
    "…the run-cancel route's fan-out (service token, scoped to the run's workspace) cancels it (202)",
    (await svcCall("POST", cronStep.sessionId, "/cancel")).status === 202,
  );
  check("…and so does it for a person's step in that workspace (202)", (await svcCall("POST", step.sessionId, "/cancel")).status === 202);
  check("…and to nobody outside it (404)", (await stream(cronStep.sessionId, T.carol)).status === 404);

  // mold_v1-130: the service used to be admitted to ANY session in the workspace it named, and to ANY session at all
  // when it named none — so the front-end's token read, steered and cancelled a person's private chat.
  console.log("\nA service principal acts only on the sessions it runs, and only while naming their workspace:");
  const cancelledBefore = sessions.get(S).cancelled;
  const deliveredBefore = sessions.get(S).delivered.length;
  const noHeader = await call("GET", `/eve/v1/session/${S}/stream`, { token: svc });
  check("with NO workspace header it reads nobody's chat (404, not one byte)", noHeader.status === 404 && !noHeader.text.includes("HUNTER2"), noHeader.status);
  const sameOrg = await svcCall("GET", S, "/stream");
  check("naming the chat's OWN workspace it still may not read a person's private chat (404)", sameOrg.status === 404 && !sameOrg.text.includes("HUNTER2"), sameOrg.status);
  check(
    "…nor post into it, answer its approval or cancel it (404, nothing delivered, turn untouched)",
    (await svcCall("POST", S, "", inA, { message: "svc", continuationToken: s1.ct })).status === 404 &&
      (await svcCall("POST", S, "", inA, { inputResponses: [{ requestId: "r1", optionId: "approve" }], continuationToken: s1.ct })).status === 404 &&
      (await svcCall("POST", S, "/cancel")).status === 404 &&
      sessions.get(S).cancelled === cancelledBefore &&
      sessions.get(S).delivered.length === deliveredBefore,
  );
  check("…nor another person's legacy chat (404)", (await svcCall("GET", L, "/stream")).status === 404);
  check("…nor a subagent child of a person's chat (404)", (await svcCall("GET", C, "/stream")).status === 404);
  // mold_v1-138: #69 held a one-release door open for a pre-#69 web app's headerless stream reads and cancels of the
  // steps the platform runs. The web app and agent now deploy together, naming the workspace on every call, so the
  // door is shut: a headerless service reads, cancels and posts into nothing.
  const cancelsBefore = sessions.get(cronStep.sessionId).cancelled;
  check("a headerless stream read of a platform step is refused (404)", (await call("GET", `/eve/v1/session/${cronStep.sessionId}/stream`, { token: svc })).status === 404);
  check("…and a headerless cancel of it (404, not cancelled)", (await call("POST", `/eve/v1/session/${cronStep.sessionId}/cancel`, { token: svc, body: {} })).status === 404 && sessions.get(cronStep.sessionId).cancelled === cancelsBefore);
  check("…and of a person's workflow step (404)", (await call("POST", `/eve/v1/session/${step.sessionId}/cancel`, { token: svc, body: {} })).status === 404);
  check("…and a headerless POST into a step (404)", (await call("POST", `/eve/v1/session/${cronStep.sessionId}`, { token: svc, body: { message: "steer", continuationToken: cronStep.ct } })).status === 404);
  check(
    "…and never a person's chat, headerless: not its stream, not its cancel (404)",
    (await call("GET", `/eve/v1/session/${S}/stream`, { token: svc })).status === 404 &&
      (await call("POST", `/eve/v1/session/${S}/cancel`, { token: svc, body: {} })).status === 404,
  );
  const wrongScope = await svcCall("GET", cronStep.sessionId, "/stream", { "x-workspace-scope": ORG_B });
  check("…and while naming ANOTHER workspace than the step's (404)", wrongScope.status === 404, wrongScope.status);
  const bareCreate = await create(svc, "a step for no workspace in particular");
  check("a service may not START a session without naming its workspace (403, nothing started)", bareCreate.status === 403 && !bareCreate.sessionId, bareCreate.status);
  check("a pre-deploy workflow step (journal evidence) is the service's to cancel (202)", (await svcCall("POST", W, "/cancel")).status === 202);
  check("…and its journalled child's to read (200)", (await svcCall("GET", Wc, "/stream")).status === 200);

  // The workflow delegate end to end: lib/workflow-delegate.ts, with its fetch pointed at THIS guarded channel.
  console.log("\nThe workflow delegate (lib/workflow-delegate.ts), through the guarded channel:");
  const AGENT = process.env.NEXT_PUBLIC_EVE_API_URL;
  const seen = [];
  let onStreamOpen = null;
  /** `oldWeb`: the pre-mold_v1-130 web app, which named the workspace on a step's CREATE only — refused since mold_v1-138. */
  let oldWeb = false;
  const beforeDelegate = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (!request.url.startsWith(AGENT)) return beforeDelegate(input, init);
    const path = new URL(request.url).pathname;
    const hit = match(request.method, path);
    if (!hit) return new Response("no route", { status: 404 });
    const headers = new Headers(request.headers);
    if (oldWeb && path !== "/eve/v1/session") headers.delete("x-workspace-scope");
    const guarded = new Request(`${HOST}${path}${new URL(request.url).search}`, { method: request.method, headers, body: request.method === "GET" ? undefined : await request.text() });
    const args = { send, cancel: async () => ({ status: "no_active_turn" }), getSession: (id) => handle(id, ""), receive: async () => { throw new Error("not used"); }, params: hit.params, waitUntil: () => {}, requestIp: null, __eveRouteAgent: routeAgent };
    const res = await hit.route.handler(guarded, args);
    seen.push({ method: request.method, path, scope: headers.get("x-workspace-scope"), grant: headers.has("x-session-visibility-grant"), status: res.status });
    if (path === "/eve/v1/session" && res.ok) {
      // What eve does next for a step: the orchestrator delegates, and its specialist answers in the child.
      const body = await res.clone().json();
      const child = newSession("subagent:delegate-child");
      sessions.get(child).events.push({ type: "message.completed", data: { message: "CHILD-ANSWER-7" } }, { type: "turn.completed", data: {} });
      sessions.get(body.sessionId).events.push(
        { type: "subagent.called", data: { callId: "call_d", childSessionId: child, name: "research", sessionId: body.sessionId } },
        { type: "turn.completed", data: {} },
      );
    }
    if (path.endsWith("/stream")) onStreamOpen?.();
    return res;
  };
  const createdBy = () => seen.find((r) => r.path === "/eve/v1/session");
  const { exportPKCS8 } = await import("jose");
  const signingKey = await exportPKCS8(esPriv);
  try {
    const { makeDelegate } = await import("../lib/workflow-delegate.ts");
    for (const web of ["NEW"]) {
      oldWeb = false;
      seen.length = 0;
      try {
      const answer = await makeDelegate(svc, 5_000, undefined, undefined, ORG_A, "step")("summarise the quarter", "research");
      check(`${web} web app: a service step runs to its answer, read from the delegated child's own session`, answer === "CHILD-ANSWER-7", { answer, seen });
      check(
        "…every call it made was admitted, each naming the workspace",
        seen.filter((r) => r.path.endsWith("/stream")).length >= 2 && seen.every((r) => r.status < 300 && r.scope === ORG_A),
        seen,
      );
      seen.length = 0;
      const abort = new AbortController();
      onStreamOpen = () => abort.abort(new Error("run cancelled"));
      await makeDelegate(svc, 5_000, abort.signal, undefined, ORG_A, "step")("a step the run cancels").catch(() => undefined);
      onStreamOpen = null;
      for (let i = 0; i < 50 && !seen.some((r) => r.path.endsWith("/cancel")); i++) await new Promise((r) => setTimeout(r, 20));
      const stop = seen.find((r) => r.path.endsWith("/cancel"));
      check("…a run aborted mid-step cancels its session (202), naming the workspace", stop?.status === 202 && stop.scope === ORG_A, seen);
      } catch (error) {
        check(`${web} web app: the workflow delegate runs a service step`, false, String(error?.message ?? error));
      } finally {
        onStreamOpen = null;
      }
    }
    // mold_v1-138: a web app that names the workspace on the create alone (pre-mold_v1-130) no longer reads its step.
    oldWeb = true;
    seen.length = 0;
    const oldAnswer = await makeDelegate(svc, 5_000, undefined, undefined, ORG_A, "step")("summarise the quarter", "research").catch((e) => e);
    const oldStreams = seen.filter((r) => r.path.endsWith("/stream"));
    check(
      "OLD web app (header on the create only): its headerless stream read is refused (404) and the step yields no answer",
      oldAnswer !== "CHILD-ANSWER-7" && oldStreams.length >= 1 && oldStreams.every((r) => r.scope === null && r.status === 404),
      { oldAnswer: String(oldAnswer?.message ?? oldAnswer), seen },
    );
    oldWeb = false;

    // A PERSON's step: made the workspace's with the web app's signed grant, so the run can cancel and resume it.
    console.log("\nA person's delegate: steps take the signed grant, private requests none, and no grant means no step:");
    process.env.AUTH_JWT_PRIVATE_KEY = signingKey;
    seen.length = 0;
    await makeDelegate(T.alice, 5_000, undefined, undefined, ORG_A, "step")("a person's workflow step");
    const personStep = createdBy();
    check("a person's STEP is created with the signed grant (202)", personStep?.grant === true && personStep.status === 202, seen);
    const [stepRow] = await admin`SELECT session_id, visibility FROM agent_session_owners WHERE owner_email = ${ALICE} ORDER BY created_at DESC LIMIT 1`;
    check("…so it is workspace-visible", stepRow?.visibility === "workspace", stepRow);
    check("…and the run's service fan-out may cancel it (202)", (await svcCall("POST", stepRow.session_id, "/cancel")).status === 202);
    seen.length = 0;
    await makeDelegate(T.alice, 5_000, undefined, undefined, ORG_A, "private")("summarise this person's accounts");
    check("a PRIVATE request (account summary, workflow author) sends no grant", createdBy()?.grant === false && createdBy()?.status === 202, seen);
    const [privRow] = await admin`SELECT session_id, visibility FROM agent_session_owners WHERE owner_email = ${ALICE} ORDER BY created_at DESC LIMIT 1`;
    check("…so it stays the owner's alone", privRow?.visibility === "owner", privRow);
    check(
      "…no colleague reads it and no service call reaches it (404)",
      (await stream(privRow.session_id, T.bob)).status === 404 &&
        (await svcCall("GET", privRow.session_id, "/stream")).status === 404 &&
        (await svcCall("POST", privRow.session_id, "/cancel")).status === 404,
    );
    delete process.env.AUTH_JWT_PRIVATE_KEY;
    seen.length = 0;
    let refused = null;
    try {
      await makeDelegate(T.alice, 5_000, undefined, undefined, ORG_A, "step")("a step the web app cannot sign for");
    } catch (error) {
      refused = error;
    }
    check(
      "a person's STEP the web app cannot sign a grant for is REFUSED loudly, before anything is started",
      refused?.name === "StepGrantUnavailable" || /step grant/i.test(String(refused?.message)),
      String(refused),
    );
    check("…no session was created for it", !seen.some((r) => r.path === "/eve/v1/session"), seen);
    seen.length = 0;
    await makeDelegate(svc, 5_000, undefined, undefined, ORG_A, "step")("a service step needs no grant");
    check("…while a service step needs no grant and still starts (202)", createdBy()?.status === 202, seen);
  } catch (error) {
    check("the workflow delegate could be driven", false, String(error?.stack ?? error));
  } finally {
    onStreamOpen = null;
    oldWeb = false;
    delete process.env.AUTH_JWT_PRIVATE_KEY;
    globalThis.fetch = beforeDelegate;
  }

  /* ---- the transcript cache rule (lib/chat-session-access.ts accessForSession) ---------------------------- */

  // mold_v1-129(b): the cache behind /api/ops/chat-snapshots and /api/ops/chat-replay decided an unshared session's
  // owner from the chat LIST — the sole in-workspace `chat_sessions` claimant — which the browser writes.
  console.log("\nThe transcript cache (accessForSession) decides on the agent's owner record, not the chat list:");
  {
    // The REAL function the two routes call, as the web app loads it (withOrgRls, as app_rw, fail-closed).
    const { accessForSession } = await import("../lib/chat-session-access.ts");
    const cache = (email, id, org = ORG_A) => accessForSession(org, email, id);
    const same = (got, read, write) => got.read === read && got.write === write;
    const fresh = await create(T.alice, "a chat the list has not mirrored yet");
    await admin`INSERT INTO chat_sessions (id, org_id, owner_email, eve_session_id, title) VALUES ('guard-claim', ${ORG_A}, ${BOB}, ${fresh.sessionId}, 'mine now')`;
    const claimed = await cache(BOB, fresh.sessionId);
    check("a colleague who is the SOLE chat-list claimant of Alice's session reads nothing and writes nothing", same(claimed, false, false), claimed);
    check("…while Alice, with no list row at all, reads and writes her own", same(await cache(ALICE, fresh.sessionId), true, true), await cache(ALICE, fresh.sessionId));
    check("the owner of a shared session reads and writes", same(await cache(ALICE, S), true, true));
    check("its participant and viewer READ (the stream hands them the same) and never write", same(await cache(PAT, S), true, false) && same(await cache(VIC, S), true, false));
    check("a revoked member gets nothing", same(await cache(REX, S), false, false));
    check("a thread Bob wrote on Alice's session gives Bob and his invitee nothing", same(await cache(BOB, S), false, false) && same(await cache(CAROL, S), false, false));
    check("a colleague reads a workspace-visible step, never writes it", same(await cache(BOB, step.sessionId), true, false));
    check("another workspace's scope finds nothing, owner or not", same(await cache(ALICE, S, ORG_B), false, false) && same(await cache(CAROL, S, ORG_B), false, false));
    check("a session nobody has a record of is nobody's", same(await cache(ALICE, "wrun_nobody_knows"), false, false));
  }

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
  // #63's post tokens are spent ONCE PER REQUEST by the guard (deps.consumeSessionPost); here a stand-in that
  // admits each (claim, seq) once, so the guard's own spend-once and read/post rules are what is measured.
  const spentHere = new Set();
  const consumeSessionPost = async (p) => (spentHere.has(`${p.claim}:${p.seq}`) ? false : (spentHere.add(`${p.claim}:${p.seq}`), true));
  const with63 = guardSessionRoutes(eveChannel({ auth: doors }), { auth: doors, deps: { consumeSessionPost } });
  const qRead = await queueToken(ALICE, S, ORG_A, { act: "read" });
  const qPost = (seq, claim = "c-guard") => queueToken(ALICE, S, ORG_A, { act: "post", item: "q-guard", claim, seq });
  const queued = { message: "queued while away", continuationToken: s1.ct };
  check("a READ token reads ITS session (200)", (await stream(S, qRead, with63)).status === 200);
  check("…and can NEVER write — not a message, not an answer, not a cancel — whatever door admitted it (404)",
    (await post(S, qRead, queued, with63)).status === 404 &&
    (await post(S, qRead, { inputResponses: [{ requestId: "r1", optionId: "approve" }], continuationToken: s1.ct }, with63)).status === 404 &&
    (await call("POST", `/eve/v1/session/${S}/cancel`, { token: qRead, body: {}, via: with63 })).status === 404);
  const p1 = await qPost(1);
  check("a POST token delivers the queued message into its session (200)", (await post(S, p1, queued, with63)).status === 200);
  check("…ONCE: the same token again is refused (404)", (await post(S, p1, queued, with63)).status === 404);
  check("…never reads the stream (404) and never cancels (404)",
    (await stream(S, await qPost(2), with63)).status === 404 &&
    (await call("POST", `/eve/v1/session/${S}/cancel`, { token: await qPost(3), body: {}, via: with63 })).status === 404);
  const qNoAct = await queueToken(ALICE, S);
  check("…and a token naming no act is read-only: it reads (200) and never writes (404)", (await stream(S, qNoAct, with63)).status === 200 && (await post(S, qNoAct, queued, with63)).status === 404);
  check("…and nothing else of its owner's (404)", (await stream(step.sessionId, qRead, with63)).status === 404);
  check("…and never starts a session (404)", (await create(qRead, "new", {}, with63)).status === 404 && (await create(await qPost(4), "new", {}, with63)).status === 404);
  const qForeign = await queueToken(BOB, S, ORG_A, { act: "read" });
  check("one minted for someone who does not own the session is refused (404)", (await stream(S, qForeign, with63)).status === 404);
  const qElsewhere = await queueToken(CAROL, S, ORG_B, { act: "post", item: "x", claim: "x", seq: 1 });
  check("…from another workspace too (404)", (await post(S, qElsewhere, { message: "x", continuationToken: s1.ct }, with63)).status === 404);

  console.log("\n…and through the REAL channel, with #63's own door (agent/lib/queue-delivery-auth.ts) and the real spend:");
  check("a queue-kind token with no act is not admitted at all (401)", (await stream(S, await queueToken(ALICE, S))).status === 401);
  check("a read token reads its session (200)", (await stream(S, qRead)).status === 200);
  check("…and cannot post (not admitted: 401/404)", [401, 404].includes((await post(S, qRead, queued)).status));
  const hasQueue = (await admin`SELECT to_regclass('public.chat_queue_items') AS t`)[0]?.t;
  if (hasQueue) {
    const { deliveryReference } = await import("../lib/queue-delivery-token.ts");
    await admin`INSERT INTO chat_queue_items (id, org_id, owner_email, eve_session_id, text, message, settings, position, state, claim_id, claimed_at)
                VALUES ('q-real', ${ORG_A}, ${ALICE}, ${S}, 'queued while away', 'queued while away', '{}'::jsonb, 1, 'sending', 'c-real', now())`;
    try {
      const real = { message: "queued while away" + deliveryReference("c-real"), continuationToken: s1.ct };
      const r1 = await queueToken(ALICE, S, ORG_A, { act: "post", item: "q-real", claim: "c-real", seq: 1 });
      const first = await post(S, r1, real);
      check("the claimed item's post token is admitted by the door, spent by the guard, and admitted again by eve's own auth pass (200)", first.status === 200, first.status);
      check("…a replay is refused (404)", (await post(S, r1, real)).status === 404);
      check("…and a fresh token with other words is refused (401/404)", [401, 404].includes((await post(S, await queueToken(ALICE, S, ORG_A, { act: "post", item: "q-real", claim: "c-real", seq: 2 }), { ...real, message: "other words" })).status));
      const [row] = await admin`SELECT token_seq FROM chat_queue_items WHERE id = 'q-real'`;
      check("…the claim records the one spend (token_seq = 1)", row?.token_seq === 1, row);
    } finally {
      await admin`DELETE FROM chat_queue_items WHERE id = 'q-real'`;
    }
  }

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
