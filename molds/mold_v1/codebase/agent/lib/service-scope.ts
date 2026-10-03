/**
 * The workspace a SERVICE-started session acts for.
 *
 * Every tool resolves its workspace from the session's identity (orgForSession). A person has one; a service
 * does not. Two kinds of session start with no person behind them:
 *
 *   · a dynamic schedule rule (agent/schedules/dynamic.ts): eve's `appAuth`, principal `eve:app`, no email;
 *   · a front-end workflow / app / cron step (lib/workflow-delegate.ts): the front-end's Vercel OIDC token, no
 *     email and no workspace.
 *
 * Both used to resolve to an isolated empty workspace (`personal:unknown`). Once the by-id tools stopped taking
 * the workspace from the record (PR #58), a scheduled "promote the ticket" or "match this sender" found nothing.
 *
 * So the service NAMES the workspace it acts for: the one on the schedule rule it claimed, the workflow run, or the
 * app. It rides on the session's auth as one attribute, {@link SERVICE_SCOPE_ATTR}. It is honoured on exactly these
 * principals, and on nothing else:
 *
 *   · eve's schedule app principal — built inside the agent's own schedule handler, never presented over HTTP;
 *   · the FRONT-END's production Vercel OIDC token: subject exactly {@link FRONTEND_SUBJECT} and `environment`
 *     claim `production`;
 *   · ONLY WHEN `SERVICE_AUTH=session-key` IS SET ON THIS AGENT (a deployment that is not on Vercel, where there is no
 *     OIDC token): the front-end's own short-lived service token, signed with the session key pair and admitted by
 *     agent/lib/web-service-auth.ts. It is the SAME service as the one above by another proof, and gets the same
 *     rules, no more. Unset, that token is not a service principal here, whatever door let it in.
 *
 * NOT "any Vercel OIDC token". eve's `vercelOidc` also admits every token of the AGENT's OWN project, in any
 * environment — a preview build of any branch, or a developer's `vercel env pull` (development, carries user_id) —
 * as principal type `service`/`runtime`. The first version of this file trusted anything with a Vercel issuer, so
 * such a token plus `x-workspace-scope: <any org>` could read and write any workspace through the agent (review of
 * #58, reproduced with locally signed tokens against the real verifier; scripts/test-service-scope-oidc.mjs holds
 * that matrix). No current path needs the agent's own principal to name a workspace, so it cannot.
 *
 * On every other principal the attribute is stripped at the door (eve.ts `onMessage`) and ignored by
 * orgForSession, so neither a person nor a preview/dev token can name a workspace by it. The model never sees it.
 */

import { WEB_SERVICE_TOKEN_KIND, WEB_SERVICE_TOKEN_SUBJECT } from "../../lib/session-token-kinds.ts";
import { sessionKeyServiceAuth } from "../../lib/service-auth-mode.ts";

/** The auth attribute that carries a service session's workspace. */
export const SERVICE_SCOPE_ATTR = "workspace_scope";
/** The request header the front-end sets on a service call to name the workspace (lib/workflow-delegate.ts). */
export const SERVICE_SCOPE_HEADER = "x-workspace-scope";

/**
 * The front-end project's PRODUCTION Vercel OIDC subject — the one service allowed to name a workspace, and the one
 * agent/channels/eve.ts admits from outside the agent's own project (`vercelSubject({ teamSlug, projectName:
 * "fde-agent", environment: "production" })`, spelled out so this module imports nothing of eve's).
 */
export const FRONTEND_SUBJECT = "owner:f20170061g-3183s-projects:project:fde-agent:environment:production";

export interface AuthLike {
  readonly attributes?: Readonly<Record<string, string | readonly string[]>>;
  readonly authenticator?: string;
  readonly issuer?: string;
  readonly principalId?: string;
  readonly principalType?: string;
  readonly subject?: string;
}

/** eve's schedule `appAuth` (eve/dist/src/channel/schedule-auth.js SCHEDULE_APP_AUTH). */
function isScheduleApp(auth: AuthLike): boolean {
  return auth.authenticator === "app" && auth.principalId === "eve:app" && auth.principalType === "runtime";
}

function attrOf(auth: AuthLike, key: string): string | undefined {
  const v = auth.attributes?.[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return undefined;
}

/**
 * The front-end's production token, as eve's `vercelOidc` hands it over: a Vercel issuer, principal type `service`
 * (another project, admitted by the subject list — the agent's own project comes through as `runtime`, or as
 * `service` for a preview, or as `user` for a dev env pull), the exact front-end subject, and the production
 * environment claim. Every condition is required.
 */
function isFrontEndProduction(auth: AuthLike): boolean {
  return (
    auth.authenticator === "oidc" &&
    typeof auth.issuer === "string" &&
    auth.issuer.startsWith("https://oidc.vercel.com/") &&
    auth.principalType === "service" &&
    auth.subject === FRONTEND_SUBJECT &&
    attrOf(auth, "environment") === "production"
  );
}

/**
 * The front-end's own service token, as eve's `jwtEcdsa` hands it over from agent/lib/web-service-auth.ts: our issuer,
 * the fixed service subject (not an email), the service `kind`, and no person, session or workspace on it. Only when
 * the setting is on in this process. A person's sign-in comes through the same authenticator with the same issuer and
 * principal type, and fails the subject and the kind (it carries its `email` and `email-session`); nobody but the web
 * app's private key can sign either claim.
 */
function isFrontEndSessionKey(auth: AuthLike): boolean {
  return (
    sessionKeyServiceAuth() &&
    auth.authenticator === "jwt-ecdsa" &&
    auth.issuer === "delivered" &&
    auth.principalType === "service" &&
    auth.subject === WEB_SERVICE_TOKEN_SUBJECT &&
    attrOf(auth, "kind") === WEB_SERVICE_TOKEN_KIND &&
    attrOf(auth, "email") === undefined &&
    attrOf(auth, "sid") === undefined &&
    attrOf(auth, "org") === undefined
  );
}

/** Is this principal a service that may name the workspace it acts for? */
export function isServicePrincipal(auth: AuthLike | null | undefined): boolean {
  return (
    Boolean(auth) &&
    (isScheduleApp(auth as AuthLike) || isFrontEndProduction(auth as AuthLike) || isFrontEndSessionKey(auth as AuthLike))
  );
}

/** The workspace a service principal names, or undefined (anyone else, or none named). */
export function serviceScopeOf(auth: AuthLike | null | undefined): string | undefined {
  if (!auth || !isServicePrincipal(auth)) return undefined;
  const org = attrOf(auth, SERVICE_SCOPE_ATTR)?.trim();
  return org ? org : undefined;
}

/** `auth` with {@link SERVICE_SCOPE_ATTR} removed. */
export function withoutServiceScope<T extends AuthLike>(auth: T): T {
  if (!auth.attributes || !(SERVICE_SCOPE_ATTR in auth.attributes)) return auth;
  const { [SERVICE_SCOPE_ATTR]: _dropped, ...attributes } = auth.attributes;
  return { ...auth, attributes };
}

/** `auth` naming `orgId` as the workspace it acts for. Only meaningful on a service principal. */
export function withServiceScope<T extends AuthLike>(auth: T, orgId: string | null | undefined): T {
  const clean = withoutServiceScope(auth);
  if (!orgId) return clean;
  return { ...clean, attributes: { ...(clean.attributes ?? {}), [SERVICE_SCOPE_ATTR]: orgId } };
}

/**
 * The header a PERSON's request names its workspace with: the web app's per-tab workspace (the same header the Ops API
 * reads — lib/org-context.ts ORG_HEADER), passed through the /eve proxy.
 */
export const WORKSPACE_PIN_HEADER = "x-ops-org";

/**
 * The session auth for an inbound eve HTTP message (agent/channels/eve.ts `onMessage`, and the session guard's
 * workspace resolution). A service caller's {@link SERVICE_SCOPE_HEADER} becomes its workspace; every other caller has
 * that attribute stripped, whatever its token or its headers say.
 *
 * A person's {@link WORKSPACE_PIN_HEADER} becomes the token's `org` attribute — unless the token already names one
 * (a workflow step's or a queue delivery's token is bound to its workspace, and a header never overrides that). It is
 * a name, not a grant: `orgForSession` honours an `org` only for a workspace the caller is a member of, and REFUSES
 * any other (it used to resolve the person's first membership instead, so a console set to a workspace they were not
 * in started its chats in another one). Without the header the agent used the workspace the person selected LAST, so
 * a second tab on another workspace had its chats recorded in — and refused by — the wrong one.
 */
export function sessionAuthForRequest<T extends AuthLike>(caller: T | null, headers: Headers): T | null {
  if (!caller) return null;
  if (!isServicePrincipal(caller)) {
    const person = withoutServiceScope(caller);
    const pin = headers.get(WORKSPACE_PIN_HEADER)?.trim();
    if (!pin || attrOf(person, "org")) return person;
    return { ...person, attributes: { ...(person.attributes ?? {}), org: pin } };
  }
  return withServiceScope(caller, headers.get(SERVICE_SCOPE_HEADER)?.trim() || null);
}
