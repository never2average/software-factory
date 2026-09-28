/**
 * WHOSE SESSION IS IT — live, over HTTP, against a running `eve dev` of this agent.
 *
 * The handler-level test (scripts/test-session-guard.mjs, in CI) drives the exported channel with an in-memory eve
 * runtime. This drives the REAL runtime: `eve dev` serving agent/channels/eve.ts, eve's own workflow world, the real
 * root agent and its real `research` subagent answered by scripts/fake-model-server.mjs, and a real Postgres as
 * app_rw. Every request carries a NON-loopback Host header (sent over a socket to 127.0.0.1, as `curl --resolve`
 * does), so eve's `localDev()` — which admits any `Host: localhost` request as an anonymous developer — is not what
 * lets anyone in. Node's fetch drops a custom Host, so requests go through node:http.
 *
 * It exercises: cross-workspace and same-workspace non-owners on stream, message, approval answer and cancel, for a
 * brand-new session and for one mirrored in the chat list; the owner; a participant, a viewer and a revoked member of
 * a shared thread; a continuation token presented on another session's id; a subagent's child session; the REAL
 * workflow delegate (lib/workflow-delegate.ts `makeDelegate`, unmodified, its fetch pointed at eve dev); and — when
 * DB_DOWN_CMD / DB_UP_CMD are given — the database going away (503, closed).
 *
 * NOT here: a trusted SERVICE principal. The front-end's production token is a Vercel OIDC token that `eve dev`
 * verifies against Vercel's real JWKS, so it cannot be minted locally; the handler test covers it with the real
 * verifier and a locally answered JWKS.
 *
 * SETUP (what was run for the PR):
 *   docker run -d --name sessgate-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fde_test -p 127.0.0.1:55441:5432 postgres:16
 *   DATABASE_URL=$ADMIN_URL npx drizzle-kit push --force && DATABASE_URL=$ADMIN_URL node scripts/bootstrap-test-db.mjs
 *   openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt > /tmp/sg-priv.pem
 *   openssl ec -in /tmp/sg-priv.pem -pubout > /tmp/sg-pub.pem
 *   node scripts/fake-model-server.mjs --port 8788 --script delegate-plain &
 *   DATABASE_URL=postgres://app_rw:app_rw_test_password@127.0.0.1:55441/fde_test \
 *   AUTH_JWT_PUBLIC_KEY="$(cat /tmp/sg-pub.pem)" MODEL_PROVIDER=cloudflare CLOUDFLARE_ACCOUNT_ID=test \
 *   CLOUDFLARE_API_TOKEN=test CLOUDFLARE_BASE_URL=http://127.0.0.1:8788/v1 CLOUDFLARE_MODEL_ORCHESTRATOR=@cf/test/orch \
 *   CLOUDFLARE_MODEL_SPECIALIST=@cf/test/spec CLOUDFLARE_MODEL_VISION=@cf/test/vision ENABLE_BROWSER=false \
 *     npx eve dev --no-ui --port 3217 &
 *
 * RUN:
 *   EVE_URL=http://127.0.0.1:3217 AUTH_JWT_PRIVATE_KEY="$(cat /tmp/sg-priv.pem)" \
 *   ADMIN_URL=postgres://postgres:postgres@127.0.0.1:55441/fde_test \
 *   DB_DOWN_CMD="docker stop sessgate-pg" DB_UP_CMD="docker start sessgate-pg" \
 *     node --conditions=react-server --experimental-strip-types scripts/test-session-guard-live.mjs
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import http from "node:http";
import { Readable } from "node:stream";
import postgres from "postgres";

const EVE_URL = process.env.EVE_URL;
const HOST = process.env.EVE_HOST ?? "agent-api.sessgate.test";
const adminUrl = process.env.ADMIN_URL;
if (!EVE_URL || !adminUrl || !process.env.AUTH_JWT_PRIVATE_KEY) {
  console.log("test-session-guard-live: SKIPPED — needs EVE_URL (a running `eve dev`), ADMIN_URL and AUTH_JWT_PRIVATE_KEY. See the header.");
  process.exit(0);
}
const target = new URL(EVE_URL);
/**
 * `main` — everything but the child session; run with a fake model that answers at once
 *          (`--script empty-then-answer --empties 0`), since a delegating first turn is slow wherever the specialist's
 *          sandbox cannot start.
 * `child` — only the subagent's child session; needs `--script delegate-plain`.
 * `all`  (default) — both, with `delegate-plain`.
 */
const PHASE = process.env.LIVE_PHASE ?? "all";
const RUN_MAIN = PHASE !== "child";
const RUN_CHILD = PHASE !== "main";
// eve 0.25.1 writes a child session's id only on its parent's stream (subagent.called); the agent's guard records the
// child's owner as that line passes through it (agent/lib/session-lineage-stream.ts).
const PARK_MS = Number(process.env.LIVE_PARK_MS ?? 240_000);

/** fetch, over a socket to eve dev, with Host set to a non-loopback name. Streams the body like fetch does. */
function hostFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  return new Promise((resolve, reject) => {
    const headers = { ...(init.headers ?? {}), host: HOST };
    const req = http.request(
      { host: target.hostname, port: target.port, path: `${url.pathname}${url.search}`, method: init.method ?? "GET", headers },
      (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") h.set(k, v);
        resolve(new Response(res.statusCode === 204 ? null : Readable.toWeb(res), { status: res.statusCode, headers: h }));
      },
    );
    req.on("error", reject);
    if (init.signal) init.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), { once: true });
    if (init.body) req.write(init.body);
    req.end();
  });
}

const { mintSessionToken } = await import("../lib/auth-session.ts");
const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });

const ORG_A = "org-live-a";
const ORG_B = "org-live-b";
const ALICE = "alice@live-a.test";
const BOB = "bob@live-a.test";
const CAROL = "carol@live-b.test";
const PAT = "pat@live-a.test";
const VIC = "vic@live-a.test";
const REX = "rex@live-a.test";

let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `  — got ${JSON.stringify(detail)}`}`);
  }
};

const base = `http://${HOST}`;
async function req(method, path, token, body) {
  const res = await hostFetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}
/** Read a stream until `until(event)` or `ms` pass; returns { status, events, text }. */
async function readStream(id, token, { until = () => false, ms = 4000, startIndex = 0 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let res;
  try {
    res = await hostFetch(`${base}/eve/v1/session/${encodeURIComponent(id)}/stream?startIndex=${startIndex}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: ctrl.signal,
    });
  } catch {
    // eve holds a stream's headers until its first event; nothing arrived before the deadline.
    clearTimeout(timer);
    return { status: 0, events: [], text: "" };
  }
  const events = [];
  let text = "";
  if (res.ok && res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        text += chunk;
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        let stop = false;
        for (const l of lines) {
          if (!l.trim()) continue;
          try {
            const e = JSON.parse(l);
            events.push(e);
            if (until(e)) stop = true;
          } catch {}
        }
        if (stop) break;
      }
    } catch {
      /* aborted at the deadline */
    }
    ctrl.abort();
  } else {
    text = await res.text().catch(() => "");
  }
  clearTimeout(timer);
  return { status: res.status, events, text };
}
const parked = (e) => e.type === "session.waiting" || e.type === "session.completed" || e.type === "session.failed";
async function waitToken(id, token) {
  const r = await readStream(id, token, { until: parked, ms: PARK_MS });
  const w = [...r.events].reverse().find((e) => e.type === "session.waiting");
  return w?.data?.continuationToken;
}

const cleanup = async () => {
  await admin`DELETE FROM chat_thread_members WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM chat_threads WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM chat_sessions WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM org_members WHERE org_id IN (${ORG_A}, ${ORG_B})`;
  await admin`DELETE FROM orgs WHERE org_id IN (${ORG_A}, ${ORG_B})`;
};

try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG_A}, 'Live A', 'active'), (${ORG_B}, 'Live B', 'active')`;
  for (const [org, email] of [[ORG_A, ALICE], [ORG_A, BOB], [ORG_A, PAT], [ORG_A, VIC], [ORG_A, REX], [ORG_B, CAROL]]) {
    await admin`INSERT INTO org_members (org_id, email, role) VALUES (${org}, ${email}, 'member')`;
  }
  const T = Object.fromEntries(
    await Promise.all(
      [["alice", ALICE], ["bob", BOB], ["carol", CAROL], ["pat", PAT], ["vic", VIC], ["rex", REX]].map(async ([k, e]) => [k, await mintSessionToken(e)]),
    ),
  );
  console.log(`\nLive against ${EVE_URL} with Host: ${HOST} (not loopback — eve's localDev() does not apply)`);

  if (RUN_MAIN) {
  /* ---- brand-new and mirrored sessions --------------------------------------------------------------------- */

  const created = await req("POST", "/eve/v1/session", T.alice, { message: "Alice's secret: the data-room password is HUNTER2." });
  const { sessionId: S } = await created.json();
  check("the owner creates a session (202)", created.status === 202 && Boolean(S), created.status);
  if (!S) throw new Error(`eve dev did not create a session (${created.status}); see its log — nothing below can run`);
  const tokenS = await waitToken(S, T.alice);
  check("…and reads it to its first park (200, with its continuation token)", Boolean(tokenS));

  const createdM = await req("POST", "/eve/v1/session", T.alice, { message: "Mirrored chat, secret MIRROR-7." });
  const { sessionId: M } = await createdM.json();
  const tokenM = await waitToken(M, T.alice);
  // What the web client does after a turn: the chat list mirror row.
  await admin`INSERT INTO chat_sessions (id, org_id, owner_email, eve_session_id, continuation_token, title)
              VALUES ('live-mirrored', ${ORG_A}, ${ALICE}, ${M}, ${tokenM}, 'mirrored')`;

  for (const [kind, id, tok, secret] of [["brand-new", S, tokenS, "HUNTER2"], ["mirrored", M, tokenM, "MIRROR-7"]]) {
    console.log(`\nA ${kind} session, the agent API called DIRECTLY:`);
    for (const [label, t] of [["another workspace", T.carol], ["the same workspace, not the owner", T.bob]]) {
      const r = await readStream(id, t, { ms: 3000 });
      check(`${label}: stream → 404, no transcript, no token`, r.status === 404 && !r.text.includes(secret) && !r.text.includes(tok), { status: r.status });
      const m = await req("POST", `/eve/v1/session/${id}`, t, { message: "injected", continuationToken: tok });
      check(`${label}: message → 404`, m.status === 404, m.status);
      const a = await req("POST", `/eve/v1/session/${id}`, t, { inputResponses: [{ requestId: "r1", optionId: "approve" }], continuationToken: tok });
      check(`${label}: approval answer → 404`, a.status === 404, a.status);
      const c = await req("POST", `/eve/v1/session/${id}/cancel`, t, {});
      check(`${label}: cancel → 404`, c.status === 404, c.status);
    }
    const own = await readStream(id, T.alice, { until: parked, ms: 10_000 });
    check("the owner reads it (200)", own.status === 200 && own.text.includes(secret), own.status);
  }
  const replyS = await req("POST", `/eve/v1/session/${S}`, T.alice, { message: "Thanks. One more thing.", continuationToken: tokenS });
  check("the owner sends into the brand-new one (200)", replyS.status === 200, replyS.status);
  await waitToken(S, T.alice);
  const cancelS = await req("POST", `/eve/v1/session/${S}/cancel`, T.alice, {});
  check("the owner cancels (202)", cancelS.status === 202, cancelS.status);

  /* ---- a continuation token on another session's id ------------------------------------------------------ */

  console.log("\nA continuation token presented on ANOTHER session's id:");
  const bobs = await req("POST", "/eve/v1/session", T.bob, { message: "Bob's own chat" });
  const { sessionId: B } = await bobs.json();
  await waitToken(B, T.bob);
  const before = (await readStream(S, T.alice, { ms: 3000 })).events.length;
  const hijack = await req("POST", `/eve/v1/session/${B}`, T.bob, { message: "into Alice's via my own id", continuationToken: tokenS });
  check("Bob, on his own session id with Alice's token → 404", hijack.status === 404, hijack.status);
  const after = (await readStream(S, T.alice, { ms: 3000 })).events.length;
  check("…and Alice's session received nothing", after === before, { before, after });

  /* ---- a shared thread ----------------------------------------------------------------------------------- */

  console.log("\nA shared thread on Alice's session:");
  const [thread] = await admin`INSERT INTO chat_threads (org_id, eve_session_id, title, owner_email) VALUES (${ORG_A}, ${S}, 'shared', ${ALICE}) RETURNING id`;
  await admin`INSERT INTO chat_thread_members (org_id, thread_id, email, role, status, invited_by) VALUES
    (${ORG_A}, ${thread.id}, ${PAT}, 'participant', 'accepted', ${ALICE}), (${ORG_A}, ${thread.id}, ${VIC}, 'viewer', 'accepted', ${ALICE})`;
  await admin`INSERT INTO chat_thread_members (org_id, thread_id, email, role, status, invited_by, revoked_at) VALUES
    (${ORG_A}, ${thread.id}, ${REX}, 'participant', 'revoked', ${ALICE}, now())`;
  const pr = await readStream(S, T.pat, { until: parked, ms: 10_000 });
  check("a participant reads it (200), with the token the relay needs", pr.status === 200 && pr.text.includes(tokenS), pr.status);
  const pp = await req("POST", `/eve/v1/session/${S}`, T.pat, { message: "[from: pat] hello", continuationToken: tokenS });
  check("…and sends into it (200)", pp.status === 200, pp.status);
  await waitToken(S, T.pat);
  // The participant's turn ran through the real runtime-context hook, which records the session's scope.
  const [scope] = await admin`SELECT principal_email FROM agent_session_scopes WHERE session_id = ${S}`;
  const [owner] = await admin`SELECT owner_email FROM agent_session_owners WHERE session_id = ${S}`;
  check("after the participant's real turn, the recorded principal and owner are still Alice (first writer wins)", scope?.principal_email === ALICE && owner?.owner_email === ALICE, { scope, owner });
  const vr = await readStream(S, T.vic, { until: parked, ms: 10_000 });
  check("a viewer reads it (200) with every continuation token removed", vr.status === 200 && vr.text.includes("HUNTER2") && !vr.text.includes("continuationToken"), { status: vr.status });
  const vp = await req("POST", `/eve/v1/session/${S}`, T.vic, { message: "viewer", continuationToken: tokenS });
  check("…but cannot send (404)", vp.status === 404, vp.status);
  const va = await req("POST", `/eve/v1/session/${S}`, T.vic, { inputResponses: [{ requestId: "r1", optionId: "approve" }], continuationToken: tokenS });
  check("…or answer an approval (404)", va.status === 404, va.status);
  const rr = await readStream(S, T.rex, { ms: 3000 });
  check("a revoked participant is refused (404)", rr.status === 404, rr.status);


  /* ---- the real workflow delegate --------------------------------------------------------------------- */

  console.log("\nThe workflow delegate (lib/workflow-delegate.ts makeDelegate, unmodified):");
  process.env.NEXT_PUBLIC_EVE_API_URL = base;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    return url.startsWith(base) ? hostFetch(url, init) : realFetch(input, init);
  };
  const { makeDelegate } = await import("../lib/workflow-delegate.ts");
  let stepSession;
  const answer = await makeDelegate(T.alice, 90_000, undefined, { workflow: "guard probe" }, ORG_A)(
    "Summarise the account.",
    "research",
    (info) => (stepSession ??= info.sessionId),
  ).catch((e) => `ERROR ${e.message}`);
  check("a step runs end to end on the operator's token and returns its answer", typeof answer === "string" && !answer.startsWith("ERROR"), answer);
  if (stepSession) {
    check("a colleague in the workspace opens the step from the run timeline (200)", (await readStream(stepSession, T.bob, { until: parked, ms: 10_000 })).status === 200);
    check("…but cannot cancel it — read-only (404)", (await req("POST", `/eve/v1/session/${stepSession}/cancel`, T.bob, {})).status === 404);
    const [stepOwner] = await admin`SELECT owner_email, visibility FROM agent_session_owners WHERE session_id = ${stepSession}`;
    check("…the delegate's signed grant made it workspace-visible, owned by the operator", stepOwner?.visibility === "workspace" && stepOwner?.owner_email === ALICE, stepOwner);
    check("nobody outside the workspace can (404)", (await readStream(stepSession, T.carol, { ms: 3000 })).status === 404);
  }
  globalThis.fetch = realFetch;

  /* ---- the database goes away -------------------------------------------------------------------------- */

  if (process.env.DB_DOWN_CMD && process.env.DB_UP_CMD) {
    console.log("\nThe database goes away:");
    execSync(process.env.DB_DOWN_CMD, { stdio: "ignore" });
    try {
      const down = await readStream(S, T.carol, { ms: 20_000 });
      check("a stranger gets 503 — closed — and no transcript", down.status === 503 && !down.text.includes("HUNTER2"), down.status);
      const downOwner = await readStream(S, T.alice, { ms: 20_000 });
      check("…the owner too (503): nothing can be decided", downOwner.status === 503, downOwner.status);
      const downNew = await req("POST", "/eve/v1/session", T.alice, { message: "while the database is down" });
      check("…and no session starts without its owner recorded (503)", downNew.status === 503, downNew.status);
    } finally {
      execSync(process.env.DB_UP_CMD, { stdio: "ignore" });
    }
    for (let i = 0; i < 30; i++) {
      try {
        await admin`select 1`;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  }

  /* ---- a subagent's child session -------------------------------------------------------------------- */

  if (RUN_CHILD) {
    console.log("\nA subagent's child session (the fake model delegates a new session's first turn to `research`):");
    const made = await req("POST", "/eve/v1/session", T.alice, { message: "Research the account. CHILD-PROBE." });
    const { sessionId: R } = await made.json();
    check("the owner starts a delegating session (202)", made.status === 202 && Boolean(R), made.status);
    const ev = (await readStream(R, T.alice, { until: (e) => e.type === "subagent.called" || parked(e), ms: PARK_MS })).events;
    const child = ev.find((e) => e.type === "subagent.called")?.data?.childSessionId;
    check("the root turn delegated (subagent.called names the child)", Boolean(child));
    if (child) {
      const [thread] = await admin`INSERT INTO chat_threads (org_id, eve_session_id, title, owner_email) VALUES (${ORG_A}, ${R}, 'shared', ${ALICE}) RETURNING id`;
      await admin`INSERT INTO chat_thread_members (org_id, thread_id, email, role, status, invited_by) VALUES (${ORG_A}, ${thread.id}, ${PAT}, 'participant', 'accepted', ${ALICE})`;
      const [early] = await admin`SELECT owner_email, parent_session_id FROM agent_session_owners WHERE session_id = ${child}`;
      check("the child's owner was recorded as the root's when the root's stream announced it", early?.owner_email === ALICE && early?.parent_session_id === R, early);
      // A child still bootstrapping its sandbox has no event yet, and eve sends no headers until it does.
      const firstEvent = { until: () => true, ms: PARK_MS };
      check("the root's owner reads the child (200)", (await readStream(child, T.alice, firstEvent)).status === 200);
      check("a participant of the root's shared thread reads the child (200)", (await readStream(child, T.pat, firstEvent)).status === 200);
      check("another workspace is refused the child (404)", (await readStream(child, T.carol, { ms: 3000 })).status === 404);
      check("the same workspace, not the owner, is refused the child (404)", (await readStream(child, T.bob, { ms: 3000 })).status === 404);
    }
    await readStream(R, T.alice, { until: parked, ms: PARK_MS });
  }

} finally {
  await cleanup().catch(() => undefined);
  await admin.end({ timeout: 5 });
}

console.log(failures === 0 ? "\ntest-session-guard-live: all assertions passed" : `\ntest-session-guard-live: ${failures} FAILED`);
assert.equal(failures, 0);
process.exit(0);
