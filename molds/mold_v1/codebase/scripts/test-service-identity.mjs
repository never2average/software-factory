/**
 * THE WEB APP'S SERVICE IDENTITY, OFF VERCEL — the token, the agent's door for it, and the web app's choice of bearer.
 *
 * On Vercel the web app reaches the agent as itself with its Vercel OIDC token (scripts/test-service-scope-oidc.mjs).
 * Anywhere else there is none, so with `SERVICE_AUTH=session-key` it signs a two-minute token with the session key
 * pair (lib/auth-session.ts `mintWebServiceToken`) and the agent admits it at agent/lib/web-service-auth.ts.
 *
 * This drives the REAL pieces, no database:
 *   · the channel agent/channels/eve.ts exports — its real auth list — asked to create a session. 401 means no door
 *     admitted the token; 403 "must name the workspace" is the session guard speaking to a SERVICE; 503 is the guard
 *     having admitted the caller and found no database (this test has none). So the status alone says who it was;
 *   · the door itself, then onMessage's projection (sessionAuthForRequest) and the check every tool's workspace
 *     resolution uses (serviceScopeOf), exactly as test-service-scope-oidc does for the OIDC path;
 *   · the web app's own verifiers, which must never take the service token for a person;
 *   · lib/service-identity.ts, which decides what the five routes present.
 *
 * It runs twice: once with SERVICE_AUTH=session-key, and once in a child process with it UNSET, where every one of
 * these tokens must be refused and the web app must present exactly what it presents today.
 *
 *   npm run test:service-identity
 *
 * The routes and the channel end to end, against a Postgres, are in scripts/test-service-identity-db.mjs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SignJWT, exportPKCS8, exportSPKI, generateKeyPair } from "jose";

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

const UNSET = process.argv.includes("--unset");
const MODE = UNSET ? "SERVICE_AUTH unset" : "SERVICE_AUTH=session-key";

// A deployment that is NOT on Vercel: none of Vercel's variables, no OIDC token, no database.
for (const k of Object.keys(process.env)) if (k.startsWith("VERCEL")) delete process.env[k];
delete process.env.DATABASE_URL;
delete process.env.GOOGLE_CLIENT_ID;
if (UNSET) delete process.env.SERVICE_AUTH;
else process.env.SERVICE_AUTH = "session-key";

const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const { privateKey: strangerKey } = await generateKeyPair("ES256", { extractable: true });
process.env.AUTH_JWT_PUBLIC_KEY = await exportSPKI(publicKey);
process.env.AUTH_JWT_PRIVATE_KEY = await exportPKCS8(privateKey);

const KIND = "web-service";
const AUDIENCE = "delivered-agent-service";
const SUBJECT = "service:web-app";
const VICTIM = "org-victim";
const ALICE = "alice@person.test";

let failures = 0;
let passed = 0;
const check = (what, ok, detail) => {
  if (ok) {
    passed++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.error(`  FAIL ${what}${detail === undefined ? "" : `\n         ${JSON.stringify(detail)}`}`);
  }
};

const now = () => Math.floor(Date.now() / 1000);
/** A token signed here, claim by claim, so every refusal below differs from the valid one in exactly one thing. */
const sign = ({
  claims = { kind: KIND },
  sub = SUBJECT,
  iss = "delivered",
  aud = AUDIENCE,
  iat = now(),
  ttl = 120,
  key = privateKey,
} = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "ES256" }).setSubject(sub).setIssuer(iss).setAudience(aud).setIssuedAt(iat).setExpirationTime(iat + ttl).sign(key);
const personToken = (email = ALICE, extra = {}) =>
  sign({ claims: { email, kind: "email-session", ...extra }, sub: email, aud: "delivered-app", ttl: 3600 });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/* ---- the channel the agent serves, its real auth list ---------------------------------------------------------- */

const channel = (await import("../agent/channels/eve.ts")).default;
const createRoute = channel.routes.find((r) => r.method === "POST" && r.path === "/eve/v1/session");
assert.ok(createRoute, "the channel serves POST /eve/v1/session");
/** Ask the agent to start a session. Nothing is ever started: there is no database, so the furthest it gets is 503. */
async function create(token, scope) {
  const request = new Request("https://agent.example.test/eve/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(scope ? { "x-workspace-scope": scope } : {}) },
    body: JSON.stringify({ message: "a step" }),
  });
  const res = await createRoute.handler(request, {
    send: async () => {
      throw new Error("the channel must not start a session in this test");
    },
    cancel: async () => ({ status: "no_active_turn" }),
    getSession: () => {
      throw new Error("not used");
    },
    receive: async () => {
      throw new Error("not used");
    },
    params: {},
    waitUntil: () => {},
    requestIp: null,
  });
  return { status: res.status, text: await res.text() };
}
const namesWorkspace = (r) => r.status === 403 && /must name the workspace/i.test(r.text);

const valid = await sign();
const REFUSED = [
  // [label, token]
  ["EXPIRED (signed three minutes ago, two-minute life)", await sign({ iat: now() - 180 })],
  ["WRONG AUDIENCE: the sign-in audience", await sign({ aud: "delivered-app" })],
  ["WRONG AUDIENCE: the queue-delivery audience", await sign({ aud: "delivered-queue-delivery" })],
  ["WRONG AUDIENCE: the step-grant audience", await sign({ aud: "delivered-agent-grant" })],
  ["WRONG PURPOSE: kind email-session on the service audience", await sign({ claims: { kind: "email-session" } })],
  ["WRONG PURPOSE: kind queue-delivery", await sign({ claims: { kind: "queue-delivery" } })],
  ["WRONG PURPOSE: kind workspace-step-grant", await sign({ claims: { kind: "workspace-step-grant" } })],
  ["WRONG PURPOSE: no kind at all", await sign({ claims: {} })],
  ["WRONG KEY: every claim right, signed by another key", await sign({ key: strangerKey })],
  ["wrong issuer", await sign({ iss: "someone-else" })],
  ["wrong subject (an email address)", await sign({ sub: ALICE })],
  ["a life longer than the mint's two minutes (one hour)", await sign({ ttl: 3600 })],
  ["a service token that names a person (email)", await sign({ claims: { kind: KIND, email: ALICE } })],
  ["a service token that names a workspace (org)", await sign({ claims: { kind: KIND, org: VICTIM } })],
  ["a service token that names a session (sid)", await sign({ claims: { kind: KIND, sid: "wrun_x" } })],
  ["a workspace-step grant, as a bearer", await sign({ claims: { email: ALICE, kind: "workspace-step-grant" }, sub: ALICE, aud: "delivered-agent-grant" })],
  ["an unsigned token (alg none) with the service claims", `${b64({ alg: "none", typ: "JWT" })}.${b64({ kind: KIND, sub: SUBJECT, iss: "delivered", aud: AUDIENCE, iat: now(), exp: now() + 120 })}.`],
];
{
  // A PERSON'S TOKEN, REPLAYED: as it is, and with its payload rewritten to the service's claims under the person's
  // own signature — the only way to "make" a service token out of a sign-in without the private key.
  const person = await personToken();
  const [h, , sig] = person.split(".");
  REFUSED.push([
    "a person's sign-in with its payload rewritten to the service claims (its own signature kept)",
    `${h}.${b64({ kind: KIND, sub: SUBJECT, iss: "delivered", aud: AUDIENCE, iat: now(), exp: now() + 120 })}.${sig}`,
  ]);
}

console.log(`\n[${MODE}] The agent's channel (agent/channels/eve.ts, its real auth list), asked to start a session, no database:`);
if (!UNSET) {
  const bare = await create(valid);
  check("a valid service token naming NO workspace is told a service must name one (403): it is the service", namesWorkspace(bare), bare);
  const scoped = await create(valid, VICTIM);
  check("…and naming one, it is admitted as far as the database this test does not have (503)", scoped.status === 503, scoped);
  for (const [label, token] of REFUSED) {
    const r = await create(token, VICTIM);
    check(`${label}: refused by every door (401)`, r.status === 401, r);
  }
  // A person is a person: admitted by the sign-in door, never spoken to as a service whatever header they send.
  const person = await create(await personToken(), VICTIM);
  check("a person's sign-in naming a workspace in the SERVICE header is not treated as a service (no 403-service; 503 for the missing database)", person.status === 503 && !namesWorkspace(person), person);
  const personBare = await create(await personToken());
  check("…and with no header it is still a person (not asked to name a workspace as a service)", !namesWorkspace(personBare) && personBare.status !== 401, personBare);
} else {
  const r1 = await create(valid);
  const r2 = await create(valid, VICTIM);
  check("a VALID service token is refused by every door (401), with or without a workspace: the door is not there", r1.status === 401 && r2.status === 401, { r1, r2 });
  for (const [label, token] of REFUSED) {
    const r = await create(token, VICTIM);
    check(`${label}: refused (401)`, r.status === 401, r);
  }
  const person = await create(await personToken(), VICTIM);
  check("a person's sign-in is admitted as before (503 for the missing database, never 401)", person.status === 503, person);
}

/* ---- the door itself, then who the agent takes the principal for ------------------------------------------------ */

let scope, guard, door, signIn;
try {
  scope = await import("../agent/lib/service-scope.ts");
  guard = await import("../agent/lib/session-guard.ts");
  const { webServiceAuth } = await import("../agent/lib/web-service-auth.ts");
  const { jwtEcdsa } = await import("eve/channels/auth");
  door = webServiceAuth(process.env.AUTH_JWT_PUBLIC_KEY);
  // The sign-in door, configured as agent/channels/eve.ts configures it.
  signIn = jwtEcdsa({ algorithm: "ES256", publicKey: process.env.AUTH_JWT_PUBLIC_KEY, issuer: "delivered", audiences: ["delivered-app"], claims: { kind: ["email-session"] } });
} catch (error) {
  check("the service door and its modules load", false, String(error?.message ?? error));
}
const req = (token, headers = {}) =>
  new Request("https://agent.example.test/eve/v1/session", { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers } });
const scopeHeaders = new Headers({ "x-workspace-scope": VICTIM, "x-ops-org": VICTIM });

if (door) {
  console.log(`\n[${MODE}] The door (agent/lib/web-service-auth.ts) → onMessage (sessionAuthForRequest) → serviceScopeOf / callerOf:`);
  const auth = await door(req(valid));
  check("the door verifies a valid service token (signature, issuer, audience, subject, kind, life)", Boolean(auth) && auth.authenticator === "jwt-ecdsa" && auth.subject === SUBJECT, auth);
  for (const [label, token] of REFUSED) check(`the door refuses: ${label}`, (await door(req(token))) === null);
  check("the door refuses a person's sign-in, replayed", (await door(req(await personToken()))) === null);
  check("the door refuses a person's sign-in whose token names a workspace", (await door(req(await personToken(ALICE, { org: VICTIM })))) === null);

  const session = auth && scope.sessionAuthForRequest(auth, scopeHeaders);
  const caller = auth && guard.callerOf(auth, scopeHeaders);
  if (!UNSET) {
    check("it IS a service principal", scope.isServicePrincipal(auth) === true);
    check("…which names the workspace in its header, exactly as the Vercel OIDC service does", scope.serviceScopeOf(session) === VICTIM, session);
    check("…and names none without the header (a forged attribute is dropped)", scope.serviceScopeOf(scope.sessionAuthForRequest({ ...auth, attributes: { ...auth.attributes, workspace_scope: VICTIM } }, new Headers())) === undefined);
    check("the session guard takes it for a SERVICE, with no email", caller?.kind === "service" && caller.email === null && caller.serviceScope === VICTIM, caller);
    check("…never for a person, and the tab's workspace header gives it no `org`", caller?.kind !== "person" && session?.attributes?.org === undefined, { caller, session });
    // The same shape the OIDC front-end produces, so every rule written for `kind: "service"` applies unchanged.
    const oidcShape = guard.callerOf(
      { authenticator: "oidc", issuer: "https://oidc.vercel.com/f20170061g-3183s-projects", principalId: "p", principalType: "service", subject: scope.FRONTEND_SUBJECT, attributes: { environment: "production" } },
      scopeHeaders,
    );
    check("it reaches the gate in the same terms as the Vercel OIDC service (kind, email, workspace)", caller?.kind === oidcShape.kind && caller.email === oidcShape.email && caller.serviceScope === oidcShape.serviceScope, { caller, oidcShape });
  } else {
    check("with the setting unset a door-verified token is NOT a service principal", scope.isServicePrincipal(auth) === false);
    check("…names no workspace, by header or by attribute", scope.serviceScopeOf(session) === undefined && scope.serviceScopeOf({ ...auth, attributes: { ...auth.attributes, workspace_scope: VICTIM } }) === undefined, session);
    check("…and the session guard does not take it for a service", caller?.kind !== "service", caller);
  }

  // A PERSON stays a person in both modes.
  const person = await signIn(req(await personToken()));
  const personSession = scope.sessionAuthForRequest(person, new Headers({ "x-workspace-scope": VICTIM }));
  check("a person's sign-in is never a service principal", scope.isServicePrincipal(person) === false);
  check("…and names no workspace through the service header or a planted attribute", scope.serviceScopeOf(personSession) === undefined && scope.serviceScopeOf({ ...person, attributes: { ...person.attributes, workspace_scope: VICTIM } }) === undefined);
  check("…and the session guard takes it for a person", guard.callerOf(person, scopeHeaders).kind === "person");
  // An AuthLike that only LOOKS like the service (what a person's token could at most be made to carry).
  for (const [label, forged] of [
    ["a sign-in principal claiming the service kind but carrying an email", { authenticator: "jwt-ecdsa", issuer: "delivered", principalType: "service", subject: SUBJECT, attributes: { kind: KIND, email: ALICE } }],
    ["a sign-in principal claiming the service kind under its own (email) subject", { authenticator: "jwt-ecdsa", issuer: "delivered", principalType: "service", subject: ALICE, attributes: { kind: KIND } }],
    ["the service subject with the sign-in kind", { authenticator: "jwt-ecdsa", issuer: "delivered", principalType: "service", subject: SUBJECT, attributes: { kind: "email-session" } }],
    ["the service claims from another issuer", { authenticator: "jwt-ecdsa", issuer: "someone-else", principalType: "service", subject: SUBJECT, attributes: { kind: KIND } }],
    ["the service claims through another authenticator (a Google OIDC principal)", { authenticator: "oidc", issuer: "https://accounts.google.com", principalType: "user", subject: SUBJECT, attributes: { kind: KIND } }],
    ["the service claims bound to a session (sid)", { authenticator: "jwt-ecdsa", issuer: "delivered", principalType: "service", subject: SUBJECT, attributes: { kind: KIND, sid: "wrun_x" } }],
  ]) {
    check(`not a service principal: ${label}`, scope.isServicePrincipal(forged) === false && scope.serviceScopeOf({ ...forged, attributes: { ...forged.attributes, workspace_scope: VICTIM } }) === undefined);
  }
}

/* ---- the web app: what it mints, what it presents, and that it never takes the token for a person -------------- */

console.log(`\n[${MODE}] The web app (lib/auth-session.ts, lib/service-identity.ts, lib/ops-auth.ts):`);
let authSession, identity;
try {
  authSession = await import("../lib/auth-session.ts");
  identity = await import("../lib/service-identity.ts");
  if (typeof authSession.mintWebServiceToken !== "function") throw new Error("lib/auth-session.ts has no mintWebServiceToken");
} catch (error) {
  check("the web app's service identity modules load", false, String(error?.message ?? error));
}
if (authSession && identity) {
  const minted = await authSession.mintWebServiceToken();
  const claims = JSON.parse(Buffer.from(minted.split(".")[1], "base64url").toString("utf8"));
  check(
    "the minted token: its own kind, audience and subject, a jti, two minutes, and no person, workspace or session",
    claims.kind === KIND && claims.aud === AUDIENCE && claims.sub === SUBJECT && claims.iss === "delivered" && typeof claims.jti === "string" &&
      claims.exp - claims.iat === 120 && claims.email === undefined && claims.org === undefined && claims.sid === undefined,
    claims,
  );
  check("minting takes NO input (nothing of a caller's can go into it)", authSession.mintWebServiceToken.length === 0);
  check("each mint is a new token", (await authSession.mintWebServiceToken()) !== minted);
  if (door) check(`the agent's door ${UNSET ? "verifies it (and service-scope still refuses it, above)" : "admits it"}`, (await door(req(minted))) !== null);
  if (!UNSET) check("the real channel takes the web app's own mint for the service (403 without a workspace, 503 with one)", namesWorkspace(await create(minted)) && (await create(minted, VICTIM)).status === 503);
  else check("the real channel refuses the web app's own mint (401)", (await create(minted, VICTIM)).status === 401);

  check("NOT A PERSON: the web app's sign-in verifier refuses it", (await authSession.verifySessionToken(minted)) === null);
  const opsAuth = await import("../lib/ops-auth.ts");
  check("NOT A PERSON: the Ops API's gate refuses it", (await opsAuth.verifyOpsAuth(`Bearer ${minted}`)) === null);
  check("…while a real sign-in still passes both", (await authSession.verifySessionToken(await authSession.mintSessionToken(ALICE))) === ALICE && Boolean(await opsAuth.verifyOpsAuth(`Bearer ${await authSession.mintSessionToken(ALICE)}`)));
  const saved = process.env.AUTH_JWT_PRIVATE_KEY;
  delete process.env.AUTH_JWT_PRIVATE_KEY;
  check("without the private key nothing is minted (null)", (await authSession.mintWebServiceToken()) === null);
  process.env.AUTH_JWT_PRIVATE_KEY = saved;

  // What the five routes present. `env` is passed in, so each row is one deployment.
  const from = (headers, env) => identity.serviceBearerFor({ headers: new Headers(headers) }, env);
  const today = (headers, env) => new Headers(headers).get("x-vercel-oidc-token") ?? env.VERCEL_OIDC_TOKEN ?? null; // the routes' old expression
  const ROWS = [
    ["on Vercel: the invocation's OIDC header", { "x-vercel-oidc-token": "hdr.oidc.token" }, { VERCEL: "1" }],
    ["on Vercel: header and env both set", { "x-vercel-oidc-token": "hdr.oidc.token" }, { VERCEL: "1", VERCEL_OIDC_TOKEN: "env.oidc.token" }],
    ["local dev after `vercel env pull`: env only", {}, { VERCEL_OIDC_TOKEN: "env.oidc.token" }],
    ["nothing at all", {}, {}],
    ["off Vercel, a header a client sent", { "x-vercel-oidc-token": "client.sent.this" }, {}],
  ];
  for (const [label, headers, env] of ROWS) {
    for (const unsetAs of [{}, { SERVICE_AUTH: "" }, { SERVICE_AUTH: "vercel-oidc" }, { SERVICE_AUTH: "sessionkey" }, { SERVICE_AUTH: "true" }]) {
      const got = from(headers, { ...env, ...unsetAs });
      check(`default (${JSON.stringify(unsetAs.SERVICE_AUTH ?? null)}), ${label}: exactly today's bearer, nothing minted`, got === today(headers, env), got);
    }
  }
  const on = { SERVICE_AUTH: "session-key" };
  check("session-key, on Vercel with an OIDC header: the OIDC token is still what is presented", from({ "x-vercel-oidc-token": "hdr.oidc.token" }, { ...on, VERCEL: "1" }) === "hdr.oidc.token");
  check("session-key, VERCEL_OIDC_TOKEN in the environment: that token is presented", from({}, { ...on, VERCEL_OIDC_TOKEN: "env.oidc.token" }) === "env.oidc.token");
  const source = from({}, on);
  check("session-key, off Vercel: a SOURCE that mints per call, not one token", typeof source === "function");
  if (typeof source === "function") {
    const [a, b] = [await identity.bearerToken(source), await identity.bearerToken(source)];
    check("…each call a fresh token", a !== b && a.split(".").length === 3);
    if (door) check("…that the agent's door verifies", (await door(req(a))) !== null);
  }
  check("session-key, off Vercel: an `x-vercel-oidc-token` header a client sent is not presented", typeof from({ "x-vercel-oidc-token": "client.sent.this" }, on) === "function");
  delete process.env.AUTH_JWT_PRIVATE_KEY;
  check("session-key without the private key: no service identity (null), as when there is no OIDC token", from({}, on) === null);
  process.env.AUTH_JWT_PRIVATE_KEY = saved;
  check("a plain token is itself", (await identity.bearerToken("a.b.c")) === "a.b.c");
}

/* ---- and the same again with the setting unset ----------------------------------------------------------------- */

if (!UNSET) {
  console.log("");
  const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--unset"], {
    stdio: "inherit",
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "SERVICE_AUTH" && !k.startsWith("AUTH_JWT_"))),
  });
  check("the run with SERVICE_AUTH unset passed", child.status === 0, child.status);
}

console.log(failures === 0 ? `\ntest-service-identity [${MODE}]: ${passed} checks passed` : `\ntest-service-identity [${MODE}]: ${failures} FAILED (${passed} passed)`);
assert.equal(failures, 0, `${failures} service-identity assertion(s) failed`);
process.exit(0);
