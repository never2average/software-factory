# The web app's service identity on Vercel

On Vercel the web app and the agent are two projects. When the web app calls the agent with no person behind the
call (an app refresh, a starter app's first document, the scheduled workflows, workflow resume, the run trigger), it
presents the Vercel OIDC token of its own invocation (`lib/service-identity.ts`). The agent admits that token, and
lets it name the workspace it acts for, only when the token's subject is the web project's:

    owner:<team slug>:project:<web project name>:environment:production

Which team and project that is belongs to the deployment, not the code. It is read in one place,
`lib/service-frontend-subject.ts`, by both the door (`agent/channels/eve.ts`, eve's `vercelOidc({ subjects })`, the
subject built with eve's `vercelSubject`) and the scope rule (`agent/lib/service-scope.ts`), so the two cannot disagree.

## Settings (on the AGENT's Vercel project)

| Name | Value |
| --- | --- |
| `VERCEL_FRONTEND_TEAM_SLUG` | the Vercel team's **slug** (the segment in `vercel.com/<slug>`; the token's `owner` claim and the end of its issuer `https://oidc.vercel.com/<slug>`). Not the `team_…` id: eve's `vercelSubject` and Vercel's `sub` claim use the slug. |
| `VERCEL_FRONTEND_PROJECT` | the **web app's** project name. Not the agent's project: the agent's own tokens are admitted by eve already, and may never name a workspace. |
| `VERCEL_FRONTEND_ENVIRONMENT` | optional, `production` (default) or `preview`. |
| `SERVICE_FRONTEND_SUBJECT` | instead of the three above, the whole subject. If both forms are set they must agree, or neither is trusted. |
| `WEB_ORIGIN` | the web app's address, on both projects. No default (`lib/web-origin.ts`). The agent's `VERCEL_PROJECT_PRODUCTION_URL` is the agent's own address, so it is not a substitute. |
| `NEXT_PUBLIC_EVE_API_URL` | the agent's address, on the web project. Required on Vercel (`lib/agent-url.ts`); there is no default agent. |

Unset or unusable: no Vercel OIDC token is a service (each such call is refused with a 401) and the agent logs one
line naming these settings. A deployment off Vercel with `SERVICE_AUTH=session-key` does not use them.

## What a provisioner sets for a Vercel app

For an application whose web project is `<project>` (its agent `<project>-api`) on team `<team>`:

    on <project>-api:  VERCEL_FRONTEND_TEAM_SLUG=<team>
                       VERCEL_FRONTEND_PROJECT=<project>
                       WEB_ORIGIN=<the web app's production address>
    on <project>:      WEB_ORIGIN=<the web app's production address>
                       NEXT_PUBLIC_EVE_API_URL=<the agent's production address>

Set them before the agent is built and deployed: a Vercel function reads the environment its deployment was made with.

## History

Until this change the subject was one product's own team and project, written into `eve.ts` and `service-scope.ts`,
and `WEB_ORIGIN` and the agent address defaulted to that product's URLs. Every other Vercel deployment had each
service call refused. `npm run check:deployment-ids` now fails on any Vercel team, project or Connect id, any
`*.vercel.app` address, any OIDC subject or issuer, and any literal `teamSlug`/`projectName` in runtime code.
