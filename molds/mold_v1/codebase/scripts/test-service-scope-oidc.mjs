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
 * production token may yield a workspace; every row the reviewer reproduced must yield none. WHICH project is the
 * front-end is the deployment's setting (lib/service-frontend-subject.ts): a minted project named there is admitted,
 * the original project is not, and with the settings unset no OIDC token is a service at all.
 *
 *   npm run test:service-scope-oidc
 */
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

// Neutral names: which team and project are trusted is the deployment's setting (lib/service-frontend-subject.ts).
const TEAM = "probe-team";
const ISSUER = `https://oidc.vercel.com/${TEAM}`;
const AUDIENCE = `https://vercel.com/${TEAM}`;
const WEB = "probe-web"; // the web app's project, as the settings below name it
const AGENT = "probe-web-api"; // the agent's own project
const FRONTEND = `owner:${TEAM}:project:${WEB}:environment:production`;
const AGENT_PROJECT_ID = "prj_agent_probe";
const FRONTEND_PROJECT_ID = "prj_frontend_probe";
const VICTIM = "org-victim";

// The agent's own deployment, as eve reads it (resolveCurrentVercelProject).
process.env.VERCEL_PROJECT_ID = AGENT_PROJECT_ID;
process.env.VERCEL_ENV = "production";
delete process.env.VERCEL_TARGET_ENV;
const SETTINGS = ["VERCEL_FRONTEND_TEAM_SLUG", "VERCEL_FRONTEND_PROJECT", "VERCEL_FRONTEND_ENVIRONMENT", "SERVICE_FRONTEND_SUBJECT", "SERVICE_AUTH"];
const setSettings = (values) => {
  for (const k of SETTINGS) delete process.env[k];
  Object.assign(process.env, values);
};

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

const fe = (sub, project, environment, extra = {}) => ({ sub, project, project_id: FRONTEND_PROJECT_ID, environment, owner: TEAM, ...extra });
const ROWS = [
  // [label, claims, sign options, may it name a workspace?]
  ["front-end production (the intended caller)", fe(FRONTEND, WEB, "production"), {}, true],
  ["agent project, PREVIEW (any branch push)", { sub: subjectOf(TEAM, AGENT, "preview"), project: AGENT, project_id: AGENT_PROJECT_ID, environment: "preview", owner: TEAM }, {}, false],
  ["agent project, DEVELOPMENT (vercel env pull, user_id)", { sub: subjectOf(TEAM, AGENT, "development"), project: AGENT, project_id: AGENT_PROJECT_ID, environment: "development", owner: TEAM, user_id: "user_probe" }, {}, false],
  ["agent project, PRODUCTION (its own runtime principal)", { sub: subjectOf(TEAM, AGENT, "production"), project: AGENT, project_id: AGENT_PROJECT_ID, environment: "production", owner: TEAM }, {}, false],
  ["front-end PREVIEW", fe(subjectOf(TEAM, WEB, "preview"), WEB, "preview"), {}, false],
  ["another project, production", { ...fe(subjectOf(TEAM, "someone-else", "production"), "someone-else", "production"), project_id: "prj_other" }, {}, false],
  ["another team, same project name", { sub: subjectOf("other-team", WEB, "production"), project: WEB, project_id: "prj_other_team", environment: "production", owner: "other-team" }, {}, false],
  ["front-end production, EXPIRED", fe(FRONTEND, WEB, "production"), { exp: now - 3600 }, false],
  ["front-end subject but a DEVELOPMENT environment claim", fe(FRONTEND, WEB, "development"), {}, false],
];

const { vercelOidc, vercelSubject } = await import("eve/channels/auth");
const scope = await import("../agent/lib/service-scope.ts");
const shared = await import("../lib/service-frontend-subject.ts");

let failures = 0;
const check = (what, ok, detail) => {
  if (ok) console.log(`  ✓ ${what}`);
  else {
    failures++;
    console.error(`  ✗ ${what}${detail === undefined ? "" : `\n      ${JSON.stringify(detail)}`}`);
  }
};

/** The door exactly as agent/channels/eve.ts builds it from the shared reading, then the scope rule. */
async function names(claims, opts = {}) {
  const t = shared.frontendSubjectSetting();
  const subject = t ? vercelSubject({ teamSlug: t.teamSlug, projectName: t.projectName, environment: t.environment }) : null;
  const verify = vercelOidc({ subjects: subject ? [subject] : [] });
  const token = await sign(claims, opts);
  const headers = new Headers({ authorization: `Bearer ${token}`, [scope.SERVICE_SCOPE_HEADER ?? "x-workspace-scope"]: VICTIM });
  const caller = await verify(new Request("https://agent.example/eve/v1/session", { method: "POST", headers }));
  const session = scope.sessionAuthForRequest(caller, headers);
  return { caller, named: scope.serviceScopeOf(session), service: Boolean(caller) && scope.isServicePrincipal(caller) };
}

console.log("\nSettings name the web project (VERCEL_FRONTEND_TEAM_SLUG + VERCEL_FRONTEND_PROJECT). Each token, through vercelOidc → onMessage → serviceScopeOf, asking for another workspace:");
setSettings({ VERCEL_FRONTEND_TEAM_SLUG: TEAM, VERCEL_FRONTEND_PROJECT: WEB });
for (const [label, claims, opts, allowed] of ROWS) {
  const { caller, named } = await names(claims, opts);
  const admitted = caller ? `admitted as ${caller.principalType}` : "rejected by the verifier";
  if (allowed) check(`${label}: ${admitted}, names ${VICTIM}`, named === VICTIM, { caller: caller && { principalType: caller.principalType, subject: caller.subject }, named });
  else check(`${label}: ${admitted}, names NO workspace`, named === undefined, { caller: caller && { principalType: caller.principalType, subject: caller.subject }, named });
}
check("the shared reading's subject is eve's vercelSubject for the same settings", shared.frontendSubject() === vercelSubject({ teamSlug: TEAM, projectName: WEB }) && shared.frontendSubject() === FRONTEND, shared.frontendSubject());

console.log("\nA MINTED project (another team, another web project) is admitted when its settings name it:");
{
  const MINTED_TEAM = "minted-team";
  const MINTED = "minted-web";
  const issuer = `https://oidc.vercel.com/${MINTED_TEAM}`;
  // The minted team's issuer, answered by the same key.
  const prev = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, jwks_uri: `${issuer}/.well-known/jwks`, id_token_signing_alg_values_supported: ["RS256"], response_types_supported: ["id_token"], subject_types_supported: ["public"] });
    if (url === `${issuer}/.well-known/jwks`) return Response.json({ keys: [jwk] });
    return prev(input, init);
  };
  const mintedClaims = { sub: subjectOf(MINTED_TEAM, MINTED, "production"), project: MINTED, project_id: "prj_minted", environment: "production", owner: MINTED_TEAM };
  setSettings({ VERCEL_FRONTEND_TEAM_SLUG: MINTED_TEAM, VERCEL_FRONTEND_PROJECT: MINTED });
  let r = await names(mintedClaims, { issuer });
  check("minted web project's production token: admitted as a service and names the workspace", r.service && r.named === VICTIM, { named: r.named });
  setSettings({ SERVICE_FRONTEND_SUBJECT: `owner:${MINTED_TEAM}:project:${MINTED}:environment:production` });
  r = await names(mintedClaims, { issuer });
  check("…the same with the single SERVICE_FRONTEND_SUBJECT setting", r.service && r.named === VICTIM, { named: r.named });
  setSettings({ VERCEL_FRONTEND_TEAM_SLUG: MINTED_TEAM, VERCEL_FRONTEND_PROJECT: MINTED });
  r = await names(fe(FRONTEND, WEB, "production"));
  check("the ORIGINAL project's token is refused when the settings name another (no workspace, not a service)", !r.service && r.named === undefined && r.caller === null, { caller: r.caller?.subject, named: r.named });
  setSettings({ VERCEL_FRONTEND_TEAM_SLUG: MINTED_TEAM, VERCEL_FRONTEND_PROJECT: `${MINTED}-api` });
  r = await names(mintedClaims, { issuer });
  check("naming the AGENT's project instead of the web app's does not admit the web app", r.named === undefined && r.caller === null);
  globalThis.fetch = prev;
}

console.log("\nSettings UNSET (or unusable): no Vercel OIDC token is a service, and nothing falls back to any project:");
for (const [label, values] of [
  ["all unset", {}],
  ["only the team", { VERCEL_FRONTEND_TEAM_SLUG: TEAM }],
  ["only the project", { VERCEL_FRONTEND_PROJECT: WEB }],
  ["a subject with a wildcard", { SERVICE_FRONTEND_SUBJECT: `owner:${TEAM}:project:*:environment:production` }],
  ["a development environment", { VERCEL_FRONTEND_TEAM_SLUG: TEAM, VERCEL_FRONTEND_PROJECT: WEB, VERCEL_FRONTEND_ENVIRONMENT: "development" }],
  ["the two forms disagree", { VERCEL_FRONTEND_TEAM_SLUG: TEAM, VERCEL_FRONTEND_PROJECT: WEB, SERVICE_FRONTEND_SUBJECT: `owner:${TEAM}:project:other:environment:production` }],
]) {
  setSettings(values);
  const r = await names(fe(FRONTEND, WEB, "production"));
  check(`${label}: the front-end's production token names NO workspace and is no service`, shared.frontendSubject() === null && r.named === undefined && !r.service && !scope.isServicePrincipal({ authenticator: "oidc", issuer: ISSUER, principalType: "service", subject: FRONTEND, attributes: { environment: "production" } }), { setting: shared.frontendSubject(), named: r.named });
}
setSettings({ SERVICE_AUTH: "session-key" });
check("SERVICE_AUTH=session-key with the settings unset: no OIDC service either (that deployment does not use one), and no error", shared.frontendSubject() === null);

console.log("\neve.ts and service-scope.ts agree BY CONSTRUCTION (one reading, no literal subject in either):");
{
  const { readFileSync } = await import("node:fs");
  const eve = readFileSync(new URL("../agent/channels/eve.ts", import.meta.url), "utf8");
  const sc = readFileSync(new URL("../agent/lib/service-scope.ts", import.meta.url), "utf8");
  check("eve.ts reads the subject from lib/service-frontend-subject.ts", /import \{ frontendSubjectSetting \} from "\.\.\/\.\.\/lib\/service-frontend-subject\.ts"/.test(eve) && /const FRONTEND = frontendSubjectSetting\(\);/.test(eve));
  check("eve.ts admits exactly that subject (vercelOidc subjects from it, nothing else)", /vercelOidc\(\{ subjects: FRONTEND_SUBJECT \? \[FRONTEND_SUBJECT\] : \[\] \}\)/.test(eve) && (eve.match(/vercelOidc\(/g) ?? []).length === 1);
  check("service-scope.ts reads the same function", /import \{ frontendSubjectSetting \} from "\.\.\/\.\.\/lib\/service-frontend-subject\.ts"/.test(sc) && /frontendSubjectSetting\(\)/.test(sc));
  check("neither spells a subject, team slug or project name", ![eve, sc].some((t) => /owner:[A-Za-z0-9._-]+:project:|teamSlug:\s*["'`]|projectName:\s*["'`]/.test(t)));
}

console.log("\nThe web app's address (WEB_ORIGIN) is the deployment's setting, never a default:");
{
  const { webOriginSetting } = await import("../lib/web-origin.ts");
  check("unset: none (no default address)", webOriginSetting({}) === null);
  check("on Vercel and unset: still none (the agent's own VERCEL_PROJECT_PRODUCTION_URL is not the web app)", webOriginSetting({ VERCEL: "1", VERCEL_PROJECT_PRODUCTION_URL: "agent.example.test" }) === null);
  check("not an address / Vercel's [SENSITIVE] placeholder: none", webOriginSetting({ WEB_ORIGIN: "web.example.test" }) === null && webOriginSetting({ WEB_ORIGIN: "[SENSITIVE]" }) === null);
  check("set: that address, trailing slash trimmed", webOriginSetting({ WEB_ORIGIN: " https://web.example.test/ " }) === "https://web.example.test");
}

globalThis.fetch = realFetch;
console.log(failures === 0 ? "\ntest-service-scope-oidc: all assertions passed" : `\ntest-service-scope-oidc: ${failures} FAILED`);
assert.equal(failures, 0, `${failures} service-scope assertion(s) failed`);
