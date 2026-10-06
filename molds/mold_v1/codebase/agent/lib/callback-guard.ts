/**
 * THE CALLBACK GUARD — eve's two unauthenticated hook-resume routes, closed on the agent itself.
 *
 * eve 0.25.1 serves `GET|POST /eve/v1/connections/:name/callback/:token` and `POST /eve/v1/callback/:token` as
 * framework channels. They authenticate nobody and resume whatever workflow hook the token names, so anyone holding a
 * session id could cancel its running turn (`<id>:cancel`) or hand its waiting turn a forged specialist result
 * (`<id>:turn-control:<n>:inbox`), without signing in. They are not routes of the `eve` channel, so the session guard
 * (session-guard.ts) never saw them. Why each hook matters, and why this app has no legitimate caller of either:
 * lib/eve-callback-routes.ts and docs/SECURITY.md.
 *
 * THE INTERCEPTION POINT. eve registers a framework channel only when the app has no channel of the same name
 * (eve/dist/src/runtime/resolve-agent-graph.js and internal/nitro/host/channel-routes.js filter the framework list by
 * the authored names). So agent/channels/eve/v1/connections/callback/{get,post}.ts and agent/channels/eve/v1/callback/
 * post.ts are channels named exactly as eve's, each built here, and eve's handler is never registered: nothing of
 * eve's is patched or forked. Every request gets the answer an absent route gives (404), and one log line saying
 * which kind of hook it aimed at (never the token).
 *
 * `npm run check:callback-routes` holds the other half: eve's framework callback channels are exactly these three,
 * each is replaced, and nothing in the app needs them open (no interactive connection, no remote agent).
 */
import { defineChannel, GET, POST } from "eve/channels";
import { CALLBACK_CHANNELS, callbackTokenKind, refusedCallback, type CallbackChannelName } from "../../lib/eve-callback-routes.ts";

type RouteArgs = { readonly params?: Readonly<Record<string, string | undefined>> };

/** The refusing handler, exported for the handler-level test. */
export async function refuseCallback(request: Request, args: RouteArgs | undefined, channel: CallbackChannelName): Promise<Response> {
  console.warn(
    `[callback-guard] refused ${request.method} ${channel}: token kind ${callbackTokenKind(args?.params?.token)}` +
      (args?.params?.name ? `, connection "${String(args.params.name).slice(0, 64)}"` : ""),
  );
  return refusedCallback();
}

/** A channel that takes eve's framework channel's name and route, and refuses every request to it. */
export function closedCallbackChannel(name: CallbackChannelName) {
  const spec = CALLBACK_CHANNELS.find((c) => c.name === name);
  if (!spec) throw new Error(`callback-guard: "${name}" is not one of eve's callback channels.`);
  const handler = (request: Request, args: RouteArgs) => refuseCallback(request, args, name);
  return defineChannel({ routes: [spec.method === "GET" ? GET(spec.path, handler) : POST(spec.path, handler)] });
}
