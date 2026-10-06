/**
 * EVE'S TWO CALLBACK ROUTES ARE CLOSED IN THIS APP. Shared by the agent (agent/lib/callback-guard.ts, which replaces
 * eve's handlers) and the web app (app/eve/v1/callback, app/eve/v1/connections, which stop its `/eve/v1/:path*`
 * rewrite from forwarding them). Pure: no imports, so the real-runtime test can copy it into a scratch app.
 *
 * WHAT THEY ARE. eve 0.25.1 serves, as framework channels with NO authentication of any kind:
 *
 *     GET|POST /eve/v1/connections/:name/callback/:token   resumeHook(token, { kind: "deliver", payloads: [...] })
 *     POST     /eve/v1/callback/:token                     resumeHook(token, { kind: "runtime-action-result", ... })
 *
 * (eve/dist/src/runtime/connections/callback-route.js, runtime/session-callback-route.js). `resumeHook` resumes ANY
 * pending workflow hook whose token is in the URL; neither route checks that the token is one minted for it. eve's
 * internal hook tokens are derived from the session id, which every reader of a chat stream sees:
 *
 *     <sessionId>:cancel                      any payload without a turnId CANCELS the running turn
 *     <sessionId>:turn-control:<n>:inbox      a runtime-action-result is taken as a specialist's result: FORGED
 *     <sessionId>:turn-control:<n>            the driver's control channel (other kinds are dropped today)
 *     <sessionId>:auth                        queued as an authorization callback for the next sign-in wait
 *     eve:<uuid>                              the continuation token (not resumable this way in 0.25.1: measured)
 *
 * WHO LEGITIMATELY CALLS THEM. Nobody, in this app:
 *
 *   · the connection callback is the redirect target of an INTERACTIVE connection's sign-in (a connection whose auth
 *     has `startAuthorization`; eve mints `/eve/v1/connections/<name>/callback/<sessionId>:auth`). Every connection
 *     here is app-scoped (a workspace's own credentials, or Vercel Connect with principalType "app", which has no
 *     sign-in step), so eve never mints that URL;
 *   · the session callback is where a REMOTE agent (`defineRemoteAgent`) posts its result, at the parent turn's inbox
 *     token. This app declares none.
 *
 * `npm run check:callback-routes` fails the build if either becomes untrue (an interactive connection, a remote agent,
 * or an eve that adds or renames a callback route), because then the route is needed and closing it would break that
 * flow silently. Re-opening one is a guard that admits only the shape eve mints for it, written then, with a test.
 */

/** eve's framework channel names (runtime/framework-channels), each replaced by agent/channels/<name>.ts. */
export const CALLBACK_CHANNELS = [
  { name: "eve/v1/connections/callback/get", method: "GET", path: "/eve/v1/connections/:name/callback/:token" },
  { name: "eve/v1/connections/callback/post", method: "POST", path: "/eve/v1/connections/:name/callback/:token" },
  { name: "eve/v1/callback/post", method: "POST", path: "/eve/v1/callback/:token" },
] as const;

export type CallbackChannelName = (typeof CALLBACK_CHANNELS)[number]["name"];

/** Which eve hook a token would have resumed, for the refusal's log line. Never the token itself. */
export function callbackTokenKind(token: string | undefined): string {
  if (!token) return "none";
  if (token.startsWith("eve:")) return "continuation";
  if (/:turn-control:\d+:inbox$/.test(token)) return "turn-inbox";
  if (/:turn-control:\d+$/.test(token)) return "turn-control";
  const suffix = /:([a-z][a-z-]*)$/.exec(token)?.[1];
  return suffix ? `:${suffix}` : "other";
}

/** The one answer both routes give, whatever is asked: the same as a route that does not exist. */
export function refusedCallback(): Response {
  return Response.json({ error: "Not found.", ok: false }, { status: 404 });
}
