# The web app's service identity off Vercel (`SERVICE_AUTH`)

Five web routes call the agent as the web app itself, with no person behind the call:

| Route | What it does |
|---|---|
| `GET /api/cron/resume-workflows` | re-drives a workflow run whose driver died |
| `GET /api/cron/run-cron-workflows` | runs the workflow a schedule or system cron fire routes to |
| `GET /api/cron/refresh-apps` | finishes app refreshes already in progress (whatever a killed function left), then starts an app whose refresh is due |
| `POST /api/ops/run` | the on-demand run trigger the agent's own tools call |
| `POST /api/ops/workflow-runs/:runId/cancel` | signals a cancelled run's step sessions |

On Vercel the web app proves who it is with the project's OIDC token, which Vercel issues and rotates for every
function call. Anywhere else there is no such token, and without this setting those routes do nothing: the crons
report `no-service-token`, the run trigger answers 503, a stalled run is listed and never resumed.

## The setting

Set the same value on **both** the web app and the agent:

```
SERVICE_AUTH=session-key
```

| Value | Meaning |
|---|---|
| unset, empty, `vercel-oidc` | Vercel OIDC only. This is the default and what every Vercel deployment runs today. |
| `session-key` | Also accept (agent) and present (web app) the web app's own short-lived service token. |
| anything else | Treated as the default, with one line in the log. A typo never turns the feature on. |

It needs nothing new to be stored. The token is signed with the key pair the web app already signs sign-ins with:

- `AUTH_JWT_PRIVATE_KEY` on the web app only;
- `AUTH_JWT_PUBLIC_KEY` on the web app and on the agent.

There is no shared secret between the two. The agent holds the public half and cannot make one of these tokens.

## What the token is

`lib/auth-session.ts` `mintWebServiceToken()` signs an ES256 token with:

| Claim | Value |
|---|---|
| `iss` | `delivered` |
| `aud` | `delivered-agent-service` (not the sign-in audience) |
| `sub` | `service:web-app` (not an email) |
| `kind` | `web-service` |
| `exp` | two minutes after `iat` |
| `jti` | random |

It carries no `email`, no `org`, no `sid`. The function takes no argument, so nothing a caller holds can go into it.
A workflow step can run longer than two minutes, so the web app signs a fresh token for every call it makes
(`lib/service-identity.ts`), rather than reusing one.

## What the agent does with it

`agent/lib/web-service-auth.ts` is one more door in the channel's auth list, present only when the setting is on. It
admits the token when the signature, issuer, audience, subject and kind all match, its life is no longer than two
minutes, and it names no person, workspace or session.

`agent/lib/service-scope.ts` then treats that principal as the same service the Vercel OIDC token is. Every rule is
the one that already applies to that service:

- it must name the workspace it acts for on every call (`x-workspace-scope`), and that workspace must exist;
- the sessions it starts are workflow, app or cron steps, visible to the workspace;
- it can read, steer and cancel only sessions the platform itself runs in that workspace. It cannot reach a person's
  chat.

It is not accepted as a person anywhere: the web app's sign-in verifier and the Ops API gate refuse it, and the
agent's sign-in door refuses it. A person's sign-in token is not accepted as the service: it fails the audience, the
subject and the kind.

## On Vercel

Leave `SERVICE_AUTH` unset. Nothing is minted and the new door is not in the list. If it is set on a Vercel
deployment anyway, the OIDC token is still what the web app presents whenever Vercel provides one.

## Calling the cron routes off Vercel

Vercel Cron calls the six routes in `vercel.json` on a schedule. Off Vercel something else has to (a timer on the
server), with the same header Vercel sends:

```
curl -fsS -H "authorization: Bearer $CRON_SECRET" http://127.0.0.1:<web port>/api/cron/resume-workflows
```

## Tests

- `npm run test:service-identity`: the token, the door and the web app's choice of bearer, with the setting on and
  again with it unset. No database.
- `npm run test:service-identity-db`: each of the five routes and the agent's channel, end to end against Postgres,
  on a deployment with no Vercel variables.
- `npm run test:service-scope-oidc` and `npm run test:session-guard` hold the Vercel OIDC path, unchanged.
