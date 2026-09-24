/**
 * WHICH VERCEL OIDC TOKEN MAY NAME A WORKSPACE — against eve's REAL `vercelOidc` verifier.
 *
 * A service session names the workspace it acts for (`x-workspace-scope` → the `workspace_scope` auth attribute,
 * agent/lib/service-scope.ts). The first version honoured it on ANY token that passed `vercelOidc`. But that
 * verifier also admits every token of the AGENT's own project, in any environment — a preview build of any branch,
 * or a developer's `vercel env pull` (development, carries user_id) — so either could name any workspace and read
 * and write it through the agent (second review of #58).
 *
 * This signs tokens locally, answers the issuer's discovery and JWKS requests from a patched fetch, runs them
 * through the real verifier exactly as agent/channels/eve.ts configures it, then through the real onMessage
 * projection (sessionAuthForRequest) and the real check orgForSession uses (serviceScopeOf). Only the front-end's
 * production token may yield a workspace; every row the reviewer reproduced must yield none.
 *
 *   npm run test:service-scope-oidc
 */
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const TEAM = "f20170061g-3183s-projects";
const ISSUER = `https://oidc.vercel.com/${TEAM}`;
const AUDIENCE = `https://vercel.com/${TEAM}`;
const FRONTEND = `owner:${TEAM}:project:fde-agent:environment:production`; // eve.ts FRONTEND_SUBJECT
const AGENT_PROJECT_ID = "prj_agent_probe";
const FRONTEND_PROJECT_ID = "prj_frontend_probe";
const VICTIM = "org-victim";

// The agent's own deployment, as eve reads it (resolveCurrentVercelProject).
process.env.VERCEL_PROJECT_ID = AGENT_PROJECT_ID;
process.env.VERCEL_ENV = "production";
delete process.env.VERCEL_TARGET_ENV;

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "probe", alg: "RS256", use: "sig" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks`, id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["id_token"], subject_types_supported: ["public"] });
  }
  if (url === `${ISSUER}/.well-known/jwks`) return Response.json({ keys: [jwk] });
  if (url.startsWith("https://oidc.vercel.com/")) return new Response("not found", { status: 404 });
  return realFetch(input, init);
};

const now = Math.floor(Date.now() / 1000);
const sign = (claims, { issuer = ISSUER, exp = now + 600 } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "probe" }).setIssuer(issuer).setAudience(AUDIENCE).setIssuedAt(now - 5).setExpirationTime(exp).sign(privateKey);
const subjectOf = (team, project, env) => `owner:${team}:project:${project}:environment:${env}`;

const ROWS = [
  // [label, claims, sign options, may it name a workspace?]
  ["front-end production (the intended caller)", { sub: FRONTEND, project: "fde-agent", project_id: FRONTEND_PROJECT_ID, environment: "production", owner: TEAM }, {}, true],
  ["agent project, PREVIEW (any branch push)", { sub: subjectOf(TEAM, "fde-agent-api", "preview"), project: "fde-agent-api", project_id: AGENT_PROJECT_ID, environment: "preview", owner: TEAM }, {}, false],
  ["agent project, DEVELOPMENT (vercel env pull, user_id)", { sub: subjectOf(TEAM, "fde-agent-api", "development"), project: "fde-agent-api", project_id: AGENT_PROJECT_ID, environment: "development", owner: TEAM, user_id: "user_probe" }, {}, false],
  ["agent project, PRODUCTION (its own runtime principal)", { sub: subjectOf(TEAM, "fde-agent-api", "production"), project: "fde-agent-api", project_id: AGENT_PROJECT_ID, environment: "production", owner: TEAM }, {}, false],
  ["front-end PREVIEW", { sub: subjectOf(TEAM, "fde-agent", "preview"), project: "fde-agent", project_id: FRONTEND_PROJECT_ID, environment: "preview", owner: TEAM }, {}, false],
  ["another project, production", { sub: subjectOf(TEAM, "someone-else", "production"), project: "someone-else", project_id: "prj_other", environment: "production", owner: TEAM }, {}, false],
  ["another team, same project name", { sub: subjectOf("other-team", "fde-agent", "production"), project: "fde-agent", project_id: "prj_other_team", environment: "production", owner: "other-team" }, {}, false],
  ["front-end production, EXPIRED", { sub: FRONTEND, project: "fde-agent", project_id: FRONTEND_PROJECT_ID, environment: "production", owner: TEAM }, { exp: now - 3600 }, false],
  ["front-end subject but a DEVELOPMENT environment claim", { sub: FRONTEND, project: "fde-agent", project_id: FRONTEND_PROJECT_ID, environment: "development", owner: TEAM }, {}, false],
];

const { vercelOidc } = await import("eve/channels/auth");
const scope = await import("../agent/lib/service-scope.ts");
// Exactly as agent/channels/eve.ts configures it.
const verify = vercelOidc({ subjects: [FRONTEND] });

let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `\n      ${JSON.stringify(detail)}`}`);
  }
};

console.log("\nEach token, through vercelOidc → onMessage (sessionAuthForRequest) → serviceScopeOf, asking for another workspace:");
for (const [label, claims, opts, allowed] of ROWS) {
  const token = await sign(claims, opts);
  const headers = new Headers({ authorization: `Bearer ${token}`, [scope.SERVICE_SCOPE_HEADER ?? "x-workspace-scope"]: VICTIM });
  const request = new Request("https://agent.example/eve/v1/session", { method: "POST", headers });
  const caller = await verify(request);
  const session = scope.sessionAuthForRequest(caller, headers);
  const named = scope.serviceScopeOf(session);
  const admitted = caller ? `admitted as ${caller.principalType}` : "rejected by the verifier";
  if (allowed) check(`${label}: ${admitted}, names ${VICTIM}`, named === VICTIM, { caller: caller && { principalType: caller.principalType, subject: caller.subject }, named });
  else check(`${label}: ${admitted}, names NO workspace`, named === undefined, { caller: caller && { principalType: caller.principalType, subject: caller.subject }, named });
}
check("service-scope.ts's front-end subject is eve.ts's", scope.FRONTEND_SUBJECT === FRONTEND, scope.FRONTEND_SUBJECT);

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\ntest-service-scope-oidc: all assertions passed" : `\ntest-service-scope-oidc: ${failures} FAILED`);
assert.equal(failures, 0, `${failures} service-scope assertion(s) failed`);
