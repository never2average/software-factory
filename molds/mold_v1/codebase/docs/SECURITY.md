# Security notes

## eve's callback routes resume any hook by token (closed here, 2026-10-06)

### What was reachable

eve 0.25.1 serves two routes as framework channels, with no authentication of any kind:

| Route | Payload it resumes the hook with |
|---|---|
| `GET` or `POST /eve/v1/connections/:name/callback/:token` (no body needed) | `{ kind: "deliver", payloads: [{ authorizationCallback: { connectionName, callback } }] }` |
| `POST /eve/v1/callback/:token` (body `{ kind: "session.completed", callId, subagentName, output }`) | `{ kind: "runtime-action-result", results: [{ kind: "subagent-result", callId, subagentName, output }] }` |

Each calls `resumeHook(token, payload)` for whatever token is in the URL (`eve/dist/src/runtime/connections/callback-route.js`,
`runtime/session-callback-route.js`). Neither checks that the token was minted for that route. They are not routes
of the `eve` channel, so the session guard (`agent/lib/session-guard.ts`) never saw them, and the web app forwarded
them too (`next.config.ts` rewrites `/eve/v1/:path*` to the agent).

eve's own hook tokens are derived from the session id (the workflow run id, `wrun_…`), and session ids reach every
reader of a chat stream: `?chatSession=` links, shared threads, a guest's read-only stream, and a specialist's
`childSessionId` on its parent's `subagent.called`. Ranked by impact, measured on the real runtime
(`npm run test:callback-routes`, part 1):

1. **Forged specialist result** (`<sessionId>:turn-control:<n>:inbox`, `n` counts turns from 0, `execution/turn-workflow.js`).
   While a turn waits for a specialist, `POST /eve/v1/callback/<id>:turn-control:<n>:inbox` with the call's id (on
   the stream as `subagent.called`/`actions.requested`) is taken as that specialist's answer: the main agent replies
   from text the caller wrote, with the authority of its own specialist. Anonymous.
2. **Cancel any running turn** (`<sessionId>:cancel`, `execution/turn-cancellation-control.js`). Any payload without a
   `turnId` matches the active turn, so `GET /eve/v1/connections/x/callback/<id>:cancel` with no body stops the
   person's turn, or a specialist's (`<childSessionId>:cancel`). Anonymous.
3. **Forged sign-in callback** (`<sessionId>:auth`, `execution/workflow-entry.js`). The hook lives for the whole
   session; a `deliver` sent to it is queued and taken as the authorization callback the next time the session waits
   for a sign-in. No connection here signs a person in, so it is never read; it was accepted all the same.
4. **Turn control** (`<sessionId>:turn-control:<n>`, `execution/turn-control-receiver.js`). Accepted; both payload kinds
   are dropped by the receiver today. Any future control kind would not be.
5. The continuation token (`eve:<uuid>`) was not resumable this way in 0.25.1 (measured: "not pending").

The eve patch for per-result delegation (docs/EVE_PATCH.md, mold_v1-184) adds two more hooks. Both are closed here
like the rest, and each also ignores every payload but its own, so neither callback route's payload can move it even
where the routes are open (`npm run test:specialist-detach`, scenario `forgery`, against eve's open routes in a scratch
app):

6. **Stop a specialist waiting on its question** (`<childSessionId>:stop-parked`, only for a "reports later"
   specialist). It accepts only `{ kind: "stop-parked" }`, which eve's own Stop sends.
7. **The hand-over bound** (`<inbox token>:detach-timer:<n>`, one per wait). It accepts only `{ kind: "detach-timer" }`,
   which the patch's own timer sends.

### Who legitimately calls them

Nobody, in this app. The connection callback is the redirect target of an interactive connection's sign-in (auth
with `startAuthorization`; eve mints `/eve/v1/connections/<name>/callback/<sessionId>:auth`), and every connection here
is app-scoped (a workspace's own credentials, or Vercel Connect with `principalType: "app"`, which has no sign-in step).
The session callback is where a remote agent (`defineRemoteAgent`) posts its result, at the parent turn's inbox
token; there is none.

### The fix (no eve patch)

- **Agent.** eve registers a framework channel only when the app has no channel of the same name. So
  `agent/channels/eve/v1/connections/callback/{get,post}.ts` and `agent/channels/eve/v1/callback/post.ts` are channels
  with exactly those names, built by `closedCallbackChannel` (`agent/lib/callback-guard.ts`): every request answers 404
  (what an absent route answers) and logs which kind of hook it aimed at, never the token.
- **Web app.** `app/eve/v1/callback/[...rest]` and `app/eve/v1/connections/[...rest]` answer 404 for every method. Next
  serves a route before a `fallback` rewrite, so the `/eve/v1/:path*` proxy never forwards these paths.
- **Held by** `npm run check:callback-routes` (CI, verify job): eve's framework callback channels are exactly the three
  replaced (read from the installed eve, so an upgrade that adds one fails), each replacement refuses, no connection
  signs a person in, no agent declares a remote agent, and the web routes and the `fallback` rewrite are in place. If
  a sign-in connection or a remote agent is ever added, the check fails first: re-open that one route with a guard
  that admits only the shape eve mints for it (and, for the session callback, a signature eve does not have today).

### Upstream

eve should fix this in the framework: mint a separate random secret per hook that HTTP may resume (as `createWebhook`
does) rather than routing a caller-chosen token to `resumeHook`; refuse any token that eve uses internally
(`:cancel`, `:turn-control:*`, `:inbox`, `:auth` from the wrong route); bind the session callback to the call it was
issued for (a signed token, checked against `callId`). Until it does, every eve app that does not replace these two
channels is exposed in the same way. Not filed externally from here.

### Checking a deployment

Against the agent and the web app, with a made-up session id (nothing real is touched; a refused request answers
404 `{"error":"Not found.","ok":false}`, where eve's own handler would say "not pending"):

```sh
for BASE in https://<agent-host> https://<web-host>; do
  curl -s -o /dev/null -w "%{http_code} connections GET  $BASE\n" "$BASE/eve/v1/connections/github/callback/wrun_00000000000000000000000000:cancel"
  curl -s -w " connections POST $BASE\n" -X POST "$BASE/eve/v1/connections/github/callback/wrun_00000000000000000000000000:cancel"
  curl -s -w " callback POST $BASE\n" -X POST -H 'content-type: application/json' \
    -d '{"kind":"session.completed","callId":"x","subagentName":"x","output":"x"}' \
    "$BASE/eve/v1/callback/wrun_00000000000000000000000000:turn-control:0:inbox"
done
```
