/**
 * WHICH VERCEL PROJECT IS "THE WEB APP", for the agent — read in ONE place.
 *
 * On Vercel the web app calls the agent as itself (no person behind the call: an app refresh, a starter app's first
 * document, the cron workflows, workflow resume, the run trigger) with the Vercel OIDC token of its own invocation
 * (lib/service-identity.ts). The agent admits that token (agent/channels/eve.ts, eve's `vercelOidc({ subjects })`) and
 * lets it name the workspace it acts for (agent/lib/service-scope.ts) only when its subject is exactly the web
 * project's production subject. Both files read the subject HERE, so they can never disagree.
 *
 * The subject is the deployment's, never the code's. It used to be one product's own team and project, written into
 * both files; every other Vercel deployment of this code then had each service call refused with a 401. So it
 * comes from settings on the AGENT's project:
 *
 *   VERCEL_FRONTEND_TEAM_SLUG     the Vercel team's slug (the `owner` claim; the team's URL segment on vercel.com)
 *   VERCEL_FRONTEND_PROJECT       the WEB app's Vercel project name (not the agent's)
 *   VERCEL_FRONTEND_ENVIRONMENT   optional: production (default) or preview
 *
 * or, instead, the whole subject in one setting:
 *
 *   SERVICE_FRONTEND_SUBJECT      owner:<team slug>:project:<web project>:environment:production
 *
 * The subject Vercel puts in the token is `owner:<team slug>:project:<project name>:environment:<environment>` (the
 * same string eve's `vercelSubject` builds; eve.ts builds it with that function too and refuses to start if the two
 * differ). It carries the team SLUG, not the team id.
 *
 * UNSET (or unusable): no Vercel OIDC token is a trusted service. Nothing falls back to any project. One plain line
 * in the log names the settings. A deployment off Vercel that sets SERVICE_AUTH=session-key does not use this at all
 * (lib/service-auth-mode.ts) and says nothing.
 *
 * Dependency-free: the agent, the web app and plain-node tests all load it.
 */
import { sessionKeyServiceAuth } from "./service-auth-mode.ts";

export const FRONTEND_TEAM_ENV = "VERCEL_FRONTEND_TEAM_SLUG";
export const FRONTEND_PROJECT_ENV = "VERCEL_FRONTEND_PROJECT";
export const FRONTEND_ENVIRONMENT_ENV = "VERCEL_FRONTEND_ENVIRONMENT";
export const FRONTEND_SUBJECT_ENV = "SERVICE_FRONTEND_SUBJECT";

export type FrontendEnvironment = "production" | "preview";

export interface FrontendSubject {
  readonly teamSlug: string;
  readonly projectName: string;
  readonly environment: FrontendEnvironment;
  /** `owner:<teamSlug>:project:<projectName>:environment:<environment>` — the token's `sub`. */
  readonly subject: string;
}

type Env = Record<string, string | undefined>;

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const SUBJECT = /^owner:([^:*]+):project:([^:*]+):environment:([^:*]+)$/;

const said = new Set<string>();
function sayOnce(line: string): void {
  if (said.has(line)) return;
  said.add(line);
  console.warn(line);
}

// (No record word in these lines: the web app is "the web app" and its Vercel name is "its Vercel name".)
const SETTINGS_LINE =
  `[service-identity] The web app's Vercel identity is not configured on the agent, so the web app's own calls to ` +
  `the agent (app refresh, scheduled workflows, workflow resume, the run trigger) are refused. On the agent set ` +
  `${FRONTEND_TEAM_ENV}=<team slug> and ${FRONTEND_PROJECT_ENV}=<the web app's Vercel name> ` +
  `(or ${FRONTEND_SUBJECT_ENV}=<the web app's Vercel OIDC subject>).`;

function build(teamSlug: string, projectName: string, environment: string, from: string): FrontendSubject | null {
  if (!SEGMENT.test(teamSlug) || !SEGMENT.test(projectName)) {
    sayOnce(`[service-identity] ${from} must be letters, digits, '.', '_' or '-'. ${SETTINGS_LINE}`);
    return null;
  }
  if (environment !== "production" && environment !== "preview") {
    sayOnce(`[service-identity] ${from}: environment ${JSON.stringify(environment)} is not "production" or "preview". ${SETTINGS_LINE}`);
    return null;
  }
  return { teamSlug, projectName, environment, subject: `owner:${teamSlug}:project:${projectName}:environment:${environment}` };
}

function fromSubject(raw: string): FrontendSubject | null {
  const m = SUBJECT.exec(raw);
  if (!m) {
    sayOnce(`[service-identity] ${FRONTEND_SUBJECT_ENV} is not owner:<team slug>:project:<project>:environment:<environment>. ${SETTINGS_LINE}`);
    return null;
  }
  return build(m[1], m[2], m[3], FRONTEND_SUBJECT_ENV);
}

/**
 * The web app's Vercel OIDC identity this deployment trusts, or null when none is configured (then none is trusted).
 * Read from the environment on each call; eve.ts reads it once when the agent starts.
 */
export function frontendSubjectSetting(env: Env = process.env): FrontendSubject | null {
  const whole = env[FRONTEND_SUBJECT_ENV]?.trim() || "";
  const team = env[FRONTEND_TEAM_ENV]?.trim() || "";
  const project = env[FRONTEND_PROJECT_ENV]?.trim() || "";
  const environment = env[FRONTEND_ENVIRONMENT_ENV]?.trim().toLowerCase() || "production";

  const parts = team || project ? (team && project ? build(team, project, environment, `${FRONTEND_TEAM_ENV}/${FRONTEND_PROJECT_ENV}`) : undefined) : null;
  if (parts === undefined) {
    sayOnce(`[service-identity] Only one of ${FRONTEND_TEAM_ENV} and ${FRONTEND_PROJECT_ENV} is set; both are needed. ${SETTINGS_LINE}`);
    return null;
  }
  const single = whole ? fromSubject(whole) : null;
  if (whole && !single) return null;
  if ((team || project) && !parts) return null;
  if (single && parts && single.subject !== parts.subject) {
    sayOnce(`[service-identity] ${FRONTEND_SUBJECT_ENV} (${single.subject}) and ${FRONTEND_TEAM_ENV}/${FRONTEND_PROJECT_ENV} (${parts.subject}) disagree; trusting neither.`);
    return null;
  }
  const chosen = single ?? parts;
  if (!chosen && !sessionKeyServiceAuth(env)) sayOnce(SETTINGS_LINE);
  return chosen;
}

/** Just the subject string, or null. */
export function frontendSubject(env: Env = process.env): string | null {
  return frontendSubjectSetting(env)?.subject ?? null;
}
