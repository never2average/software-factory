/**
 * THE WEB APP'S SERVICE IDENTITY, OFF VERCEL — the five routes and the agent's channel, end to end.
 *
 * Five web routes reach the agent as the web app itself: the three crons (resume-workflows, run-cron-workflows,
 * refresh-apps), the on-demand run trigger (ops/run) and the run-cancel fan-out (ops/workflow-runs/:id/cancel). On
 * Vercel that identity is the project's OIDC token. Off Vercel there is none, and before `SERVICE_AUTH=session-key`
 * each of them did nothing: "no-service-token", a 503, a backlog only reported, a cancel that fell back to the
 * caller's own token and was refused by the agent.
 *
 * This is a deployment that is NOT on Vercel: no VERCEL variable, no OIDC token, `SERVICE_AUTH=session-key`. Each
 * route is the real handler, called as its real caller calls it. The agent is the channel agent/channels/eve.ts
 * exports — its real auth list and session guard — with eve's runtime replaced by an in-memory one, and the web app's
 * `fetch` to the agent's address delivered straight to those handlers (as scripts/test-session-guard.mjs does for the
 * delegate). The database is a real Postgres, as app_rw.
 *
 * For every call the web app makes, the test records what the agent saw: the token's kind, the workspace it named,
 * the status. So "works" means: the work was done, every call was admitted, and every call carried the web app's own
 * service token — never a person's.
 *
 * It imports nothing this change added, so it runs unchanged on the code before it (where it fails).
 *
 *   ADMIN_URL=postgres://…admin… DATABASE_URL=postgres://app_rw:…@…/workspace_test npm run test:service-identity-db
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { SignJWT, exportPKCS8, exportSPKI, generateKeyPair } from "jose";
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
  console.log("test-service-identity-db: SKIPPED — needs ADMIN_URL (seeding) and DATABASE_URL (app_rw).");
  process.exit(0);
}

/* ---- a deployment that is not on Vercel ------------------------------------------------------------------------ */

for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
delete process.env.GOOGLE_CLIENT_ID;
process.env.SERVICE_AUTH = "session-key";
const CRON_SECRET = `cron-${randomUUID()}`;
process.env.CRON_SECRET = CRON_SECRET;
const AGENT = "https://agent.service-identity.test";
process.env.NEXT_PUBLIC_EVE_API_URL = AGENT; // read at import by lib/workflow-delegate.ts and the cancel route
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);

const stamp = Date.now();
const ORG = `svc-a-${stamp}`;
const OTHER = `svc-b-${stamp}`;
const ALICE = `alice-${stamp}@svc-a.test`; // a member of ORG
const WF = `svc-wf-${stamp}`;
const APP = `svc-app-${stamp}`;
const ANSWER = `STEP-ANSWER-${stamp}`;

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.error(`  FAIL ${what}${detail === undefined ? "" : `\n         ${JSON.stringify(detail).slice(0, 900)}`}`);
  }
};

const admin = postgres(adminUrl, { prepare: false, onnotice: () => {} });
const cleanup = async () => {
  for (const t of ["app_versions", "apps", "workflow_run_journal", "workflow_runs", "automation_runs", "schedule_rules", "workflows", "agent_session_scopes", "agent_session_owners", "org_members"]) {
    await admin.unsafe(`DELETE FROM ${t} WHERE org_id IN ($1, $2)`, [ORG, OTHER]).catch(() => undefined);
  }
  await admin`DELETE FROM orgs WHERE org_id IN (${ORG}, ${OTHER})`.catch(() => undefined);
};

/* ---- an in-memory eve runtime, shaped like the real one (see scripts/test-session-guard.mjs) -------------------- */

const sessions = new Map(); // id → { token, events, cancelled }
let seq = 0;
const handle = (id, token) => ({
  id,
  continuationToken: token,
  async cancel() {
    const s = sessions.get(id);
    if (s) s.cancelled++;
    return { status: "accepted" };
  },
  async getEventStream(opts) {
    const s = sessions.get(id);
    if (!s) throw new Error("run not found");
    const from = opts?.startIndex === undefined ? 0 : opts.startIndex < 0 ? Math.max(0, s.events.length + opts.startIndex) : opts.startIndex;
    const items = s.events.slice(from);
    return new ReadableStream({
      start(c) {
        for (const e of items) c.enqueue(e);
        c.close();
      },
    });
  },
});
/** A new session whose turn runs to an answer at once, as a workflow step's does. */
async function send(payload, options) {
  const input = typeof payload === "string" || Array.isArray(payload) ? { message: payload } : payload;
  const id = `wrun_svc_${++seq}_${randomUUID().slice(0, 8)}`;
  sessions.set(id, {
    token: options.continuationToken,
    cancelled: 0,
    events: [
      { type: "session.started", data: { runtime: { agentId: "probe" } } },
      { type: "message.received", data: { message: String(input.message ?? "") } },
      { type: "message.completed", data: { message: ANSWER } },
      { type: "turn.completed", data: {} },
    ],
  });
  return handle(id, options.continuationToken);
}
const routeAgent = {
  async cancelTurn({ sessionId }) {
    const s = sessions.get(sessionId);
    if (s) s.cancelled++;
    return { status: s ? "accepted" : "no_active_turn" };
  },
};

const channel = (await import("../agent/channels/eve.ts")).default;
function match(method, path) {
  for (const route of channel.routes) {
    if (route.method !== method) continue;
    const names = [];
    const re = new RegExp(`^${route.path.replace(/:([A-Za-z]+)/g, (_, n) => (names.push(n), "([^/]+)"))}$`);
    const m = path.match(re);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
const claimsOf = (authorization) => {
  try {
    return JSON.parse(Buffer.from((authorization ?? "").replace(/^Bearer\s+/i, "").split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
};
/** One request to the agent, through the guarded channel. Records what the agent saw. */
const seen = [];
async function agentCall(request) {
  const url = new URL(request.url);
  const hit = match(request.method, url.pathname);
  if (!hit) return new Response("no route", { status: 404 });
  const headers = new Headers(request.headers);
  const guarded = new Request(`${AGENT}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" ? undefined : await request.text(),
  });
  const res = await hit.route.handler(guarded, {
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
  });
  const claims = claimsOf(headers.get("authorization"));
  seen.push({
    method: request.method,
    path: url.pathname,
    status: res.status,
    scope: headers.get("x-workspace-scope"),
    kind: claims.kind ?? null,
    sub: claims.sub ?? null,
    email: claims.email ?? null,
    life: typeof claims.exp === "number" && typeof claims.iat === "number" ? claims.exp - claims.iat : null,
    oidcHeader: headers.has("x-vercel-oidc-token"),
  });
  return res;
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  if (!request.url.startsWith(AGENT)) return realFetch(input, init);
  return agentCall(request);
};

/** Every call the web app made since `from` was admitted, as the web app's own service token, naming the workspace. */
const asTheService = (calls, org = ORG) =>
  calls.length > 0 &&
  calls.every((c) => c.status < 300 && c.kind === "web-service" && c.sub === "service:web-app" && c.email === null && c.scope === org && c.life !== null && c.life <= 120);
const since = (mark) => seen.slice(mark);

const { NextRequest } = await import("next/server");
const cronGet = (path) => new NextRequest(`http://web.service-identity.test${path}`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null) });

try {
  await cleanup();
  await admin`INSERT INTO orgs (org_id, name, status) VALUES (${ORG}, 'Service A', 'active'), (${OTHER}, 'Service B', 'active')`;
  await admin`INSERT INTO org_members (org_id, email, role) VALUES (${ORG}, ${ALICE}, 'member')`;
  const script = `export const meta = { name: ${JSON.stringify(WF)}, description: "one step" };\nconst out = await agent("Say the word.");\nreturn out;`;
  const [wf] = await admin`
    INSERT INTO workflows (org_id, name, description, script, enabled, created_by)
    VALUES (${ORG}, ${WF}, 'service identity probe', ${script}, true, ${ALICE}) RETURNING id`;
  const [who] = await postgres(appUrl, { prepare: false, max: 1 })`SELECT current_user AS u`;
  console.log(`\nNot on Vercel (no VERCEL*, no OIDC token), SERVICE_AUTH=session-key, database as ${who.u}; workspace ${ORG}`);

  /* ---- 1. POST /api/ops/run ---------------------------------------------------------------------------------- */

  console.log("\nPOST /api/ops/run (the on-demand trigger an agent tool calls):");
  const runRoute = await import("../app/api/ops/run/route.ts");
  let mark = seen.length;
  const ran = await json(
    await runRoute.POST(
      new NextRequest("http://web.service-identity.test/api/ops/run", {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "workflow", target: WF, orgId: ORG, actor: "probe" }),
      }),
    ),
  );
  check("the workflow runs to its answer (200, the step's reply)", ran.status === 200 && ran.body?.ok === true && ran.body?.result === ANSWER, ran);
  check("…every call it made on the agent was admitted as the web app's service token, naming the workspace", asTheService(since(mark)) && since(mark).some((c) => c.path === "/eve/v1/session" && c.status === 202) && since(mark).some((c) => c.path.endsWith("/stream")), since(mark));
  const stepSession = since(mark).find((c) => c.path.endsWith("/stream"))?.path.split("/")[4];
  const [stepOwner] = stepSession ? await admin`SELECT org_id, owner_kind, owner_email, visibility FROM agent_session_owners WHERE session_id = ${stepSession}` : [];
  check("…and the agent recorded the step as a SERVICE's, in that workspace, with no person on it", stepOwner?.owner_kind === "service" && stepOwner.org_id === ORG && stepOwner.owner_email === null && stepOwner.visibility === "workspace", stepOwner);

  /* ---- 2. GET /api/cron/run-cron-workflows --------------------------------------------------------------------- */

  console.log("\nGET /api/cron/run-cron-workflows (a schedule fire routed to a workflow):");
  const [rule] = await admin`
    INSERT INTO schedule_rules (org_id, name, prompt, workflow, next_run_at, created_by)
    VALUES (${ORG}, ${`svc-rule-${stamp}`}, 'probe', ${WF}, now(), ${ALICE}) RETURNING id`;
  const [fire] = await admin`
    INSERT INTO automation_runs (org_id, automation_type, automation_id, status, started_at)
    VALUES (${ORG}, 'schedule', ${rule.id}, 'success', now()) RETURNING id`;
  const cronRoute = await import("../app/api/cron/run-cron-workflows/route.ts");
  mark = seen.length;
  let fired = null;
  for (let tick = 0; tick < 4 && !fired; tick++) {
    const r = await json(await cronRoute.GET(cronGet("/api/cron/run-cron-workflows")));
    fired = r.body?.outcomes?.find((o) => o.cron === rule.id) ?? null;
    if (r.status !== 200) fired = { status: `http_${r.status}`, body: r.body };
  }
  check("the fire's workflow is run to completion", fired?.status === "completed", fired);
  const [fireRow] = await admin`SELECT workflow_run_id FROM automation_runs WHERE id = ${fire.id}`;
  const [cronRun] = fireRow?.workflow_run_id ? await admin`SELECT status, result FROM workflow_runs WHERE run_id = ${fireRow.workflow_run_id}` : [];
  check("…the run is recorded completed with the step's reply", cronRun?.status === "completed" && cronRun.result === ANSWER, cronRun);
  check("…every call on the agent was the web app's service token, naming the workspace", asTheService(since(mark).filter((c) => c.scope === ORG || c.scope === null)), since(mark));

  /* ---- 3. GET /api/cron/refresh-apps ------------------------------------------------------------------------- */

  console.log("\nGET /api/cron/refresh-apps (an app whose refresh is due):");
  const [app] = await admin`
    INSERT INTO apps (org_id, slug, name, source_kind, prompt, refresh_cron, enabled, created_by)
    VALUES (${ORG}, ${APP}, ${APP}, 'prompt', 'Summarise the week.', '* * * * *', true, ${ALICE}) RETURNING id`;
  const appsRoute = await import("../app/api/cron/refresh-apps/route.ts");
  mark = seen.length;
  let refreshed = null;
  for (let tick = 0; tick < 4 && !refreshed; tick++) {
    const r = await json(await appsRoute.GET(cronGet("/api/cron/refresh-apps")));
    refreshed = r.body?.outcomes?.find((o) => o.app === APP) ?? null;
    if (r.status !== 200) refreshed = { status: `http_${r.status}`, body: r.body };
  }
  check("the app is refreshed", refreshed?.status === "refreshed", refreshed);
  const [appRow] = await admin`SELECT content_md, last_session_id, last_error FROM apps WHERE id = ${app.id}`;
  check("…its document is the agent's reply, with the session it came from and no error", appRow?.content_md === ANSWER && Boolean(appRow.last_session_id) && appRow.last_error === null, appRow);
  check("…every call on the agent was the web app's service token, naming the workspace", asTheService(since(mark).filter((c) => c.scope === ORG || c.scope === null)), since(mark));

  /* ---- 4. GET /api/cron/resume-workflows ----------------------------------------------------------------------- */

  console.log("\nGET /api/cron/resume-workflows (a run whose driver died):");
  const stalledRun = `wfr_${randomUUID()}`;
  await admin`
    INSERT INTO workflow_runs (org_id, run_id, workflow_id, workflow_name, status, attempts, created_by, created_at, updated_at)
    VALUES (${ORG}, ${stalledRun}, ${wf.id}, ${WF}, 'running', 1, 'probe', now() - interval '20 minutes', now() - interval '20 minutes')`;
  const resumeRoute = await import("../app/api/cron/resume-workflows/route.ts");
  mark = seen.length;
  let resumed = null;
  let lastResume = null;
  for (let tick = 0; tick < 4 && !resumed; tick++) {
    lastResume = await json(await resumeRoute.GET(cronGet("/api/cron/resume-workflows")));
    resumed = lastResume.body?.outcomes?.find((o) => o.runId === stalledRun) ?? null;
    if (lastResume.body?.resumed === 0 && lastResume.body?.note) break; // report-only: it will never resume
  }
  check("the stalled run is re-driven to completion (not only reported)", resumed?.status === "completed", resumed ?? lastResume);
  const [resumedRow] = await admin`SELECT status, result, attempts FROM workflow_runs WHERE run_id = ${stalledRun}`;
  check("…and recorded completed with the step's reply", resumedRow?.status === "completed" && resumedRow.result === ANSWER, resumedRow);
  check("…every call on the agent was the web app's service token, naming the workspace", asTheService(since(mark).filter((c) => c.scope === ORG || c.scope === null)), since(mark));

  /* ---- 5. POST /api/ops/workflow-runs/:runId/cancel ------------------------------------------------------------ */

  console.log("\nPOST /api/ops/workflow-runs/:runId/cancel (a member cancels a run; the fan-out reaches its step sessions):");
  const { mintSessionToken } = await import("../lib/auth-session.ts");
  const aliceToken = await mintSessionToken(ALICE);
  // A running run with a live lease, whose one step is a session the platform started (step 1's).
  const liveRun = `wfr_${randomUUID()}`;
  const target = stepSession ?? "wrun_missing";
  await admin`
    INSERT INTO workflow_runs (org_id, run_id, workflow_id, workflow_name, status, attempts, lease_token, lease_expires_at, created_by)
    VALUES (${ORG}, ${liveRun}, ${wf.id}, ${WF}, 'running', 1, ${randomUUID()}, now() + interval '5 minutes', 'probe')`;
  await admin`
    INSERT INTO workflow_run_journal (org_id, run_id, attempt, call_index, prompt, status, session_id)
    VALUES (${ORG}, ${liveRun}, 1, 0, 'Say the word.', 'running', ${target})`;
  // What a member's OWN token may do to that step on the agent: nothing (a colleague reads a step, never cancels it).
  const direct = await agentCall(new Request(`${AGENT}/eve/v1/session/${target}/cancel`, { method: "POST", headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json", "x-ops-org": ORG }, body: "{}" }));
  check("the member's own token may NOT cancel the step on the agent (404): only the service can", direct.status === 404, direct.status);
  const cancelRoute = await import("../app/api/ops/workflow-runs/[runId]/cancel/route.ts");
  const cancelledBefore = sessions.get(target)?.cancelled ?? 0;
  mark = seen.length;
  const cancelled = await json(
    await cancelRoute.POST(
      new NextRequest(`http://web.service-identity.test/api/ops/workflow-runs/${liveRun}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json", "x-ops-org": ORG },
        body: JSON.stringify({ reason: "probe" }),
      }),
      { params: Promise.resolve({ runId: liveRun }) },
    ),
  );
  check("the cancellation is recorded (200)", cancelled.status === 200 && ["requested", "cancelled"].includes(cancelled.body?.cancellationStatus), cancelled);
  check("…and the step's session is signalled and accepts it", cancelled.body?.signalledSessions?.length === 1 && cancelled.body.signalledSessions[0].status === "accepted" && (sessions.get(target)?.cancelled ?? 0) === cancelledBefore + 1, cancelled.body?.signalledSessions);
  check("…as the web app's service token naming the run's workspace — not the member's token", asTheService(since(mark)) && since(mark).every((c) => c.path.endsWith("/cancel")), since(mark));

  /* ---- 6. the channel itself, with the same identity ------------------------------------------------------------- */

  console.log("\nThe agent's channel, called directly with the web app's service token:");
  const now = () => Math.floor(Date.now() / 1000);
  const serviceToken = ({ iat = now(), ttl = 120, claims = { kind: "web-service" }, aud = "delivered-agent-service", sub = "service:web-app", key = privateKey } = {}) =>
    new SignJWT(claims).setProtectedHeader({ alg: "ES256" }).setSubject(sub).setIssuer("delivered").setAudience(aud).setIssuedAt(iat).setExpirationTime(iat + ttl).sign(key);
  const call = async (method, path, token, headers = {}, body) => {
    const res = await agentCall(new Request(`${AGENT}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }));
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ndjson */
    }
    return { status: res.status, text, json: parsed };
  };
  const inOrg = { "x-workspace-scope": ORG };
  const svc = await serviceToken();
  const made = await call("POST", "/eve/v1/session", svc, inOrg, { message: "a cron step" });
  check("it starts a step for the workspace it names (202)", made.status === 202 && Boolean(made.json?.sessionId), made);
  const sid = made.json?.sessionId;
  check("…reads it back (200, the reply)", (await call("GET", `/eve/v1/session/${sid}/stream`, svc, inOrg)).text.includes(ANSWER));
  check("…and cancels it (202)", (await call("POST", `/eve/v1/session/${sid}/cancel`, svc, inOrg, {})).status === 202);
  check("the SAME RULES as the Vercel service: no workspace named, no session started (403)", (await call("POST", "/eve/v1/session", svc, {}, { message: "x" })).status === 403);
  check("…a step is not reachable while naming another workspace (404)", (await call("GET", `/eve/v1/session/${sid}/stream`, svc, { "x-workspace-scope": OTHER })).status === 404);
  check("…nor with no workspace named (404)", (await call("GET", `/eve/v1/session/${sid}/stream`, svc)).status === 404);
  check("…and a workspace that does not exist cannot be acted for (nothing recorded under it)", (await call("POST", "/eve/v1/session", svc, { "x-workspace-scope": `nope-${stamp}` }, { message: "x" })).json?.sessionId === undefined || (await admin`SELECT 1 FROM agent_session_owners WHERE org_id = ${`nope-${stamp}`}`).length === 0);
  // A PERSON'S CHAT is never the service's, whatever workspace it names.
  const chat = await call("POST", "/eve/v1/session", aliceToken, { "x-ops-org": ORG }, { message: "Alice's private chat" });
  check("a person's own chat is created as theirs (202)", chat.status === 202, chat);
  check("…and the service token cannot read it (404) or cancel it (404)", (await call("GET", `/eve/v1/session/${chat.json?.sessionId}/stream`, svc, inOrg)).status === 404 && (await call("POST", `/eve/v1/session/${chat.json?.sessionId}/cancel`, svc, inOrg, {})).status === 404);
  check("an EXPIRED service token is refused (401)", (await call("POST", "/eve/v1/session", await serviceToken({ iat: now() - 180 }), inOrg, { message: "x" })).status === 401);
  check("WRONG AUDIENCE (the sign-in audience) is refused (401)", (await call("POST", "/eve/v1/session", await serviceToken({ aud: "delivered-app" }), inOrg, { message: "x" })).status === 401);
  check("WRONG PURPOSE (kind email-session) is refused (401)", (await call("POST", "/eve/v1/session", await serviceToken({ claims: { kind: "email-session" } }), inOrg, { message: "x" })).status === 401);
  const { privateKey: stranger } = await generateKeyPair("ES256");
  check("WRONG KEY is refused (401)", (await call("POST", "/eve/v1/session", await serviceToken({ key: stranger }), inOrg, { message: "x" })).status === 401);
  // A PERSON'S TOKEN REPLAYED as the service: the service header gives a person nothing.
  const replay = await call("POST", "/eve/v1/session", aliceToken, { "x-workspace-scope": OTHER }, { message: "let me into B" });
  const [replayOwner] = replay.json?.sessionId ? await admin`SELECT org_id, owner_kind, owner_email, visibility FROM agent_session_owners WHERE session_id = ${replay.json.sessionId}` : [];
  check("a person's token naming ANOTHER workspace in the service header stays that person, in their own workspace", replay.status === 202 && replayOwner?.org_id === ORG && replayOwner.owner_kind === "person" && replayOwner.owner_email === ALICE && replayOwner.visibility === "owner", { status: replay.status, replayOwner });
  check("…and may not reach the service's step in a way a member could not (cancel: 404)", (await call("POST", `/eve/v1/session/${sid}/cancel`, aliceToken, inOrg, {})).status === 404);

  check("no call anywhere in this run carried a Vercel OIDC header (there is none off Vercel)", seen.every((c) => !c.oidcHeader));
} finally {
  globalThis.fetch = realFetch;
  await cleanup().catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
}

console.log(failures === 0 ? `\ntest-service-identity-db: ${passed} checks passed` : `\ntest-service-identity-db: ${failures} FAILED (${passed} passed)`);
assert.equal(failures, 0, `${failures} service-identity assertion(s) failed`);
process.exit(0);
