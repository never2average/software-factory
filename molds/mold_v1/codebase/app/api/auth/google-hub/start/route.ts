import { NextRequest, NextResponse } from "next/server";
import {
  HUB_ERROR_PARAM,
  HUB_FLOW_SECONDS,
  encodeHubFlow,
  hubCookie,
  hubOriginSetting,
  hubPageUrl,
  randomHubValue,
  requestOrigin,
  safeBackPath,
} from "@/lib/google-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google-hub/start?back=<path on this site>: begin a Google sign-in through this deployment's hub
 * (lib/google-hub.ts, step 1).
 *
 * Makes the `state` and the `nonce`, keeps them with the path to come back to in an httpOnly cookie for ten minutes,
 * and sends the browser to the hub's page naming this address as the one to answer. Nothing here trusts the caller:
 * `back` is kept only when it is a path on this site, and the hub is this deployment's setting, never a parameter.
 *
 * A second start replaces the first (one sign-in at a time per browser); the callback accepts only the latest.
 */
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const hub = hubOriginSetting();
  if (!hub || hub === origin) {
    return NextResponse.redirect(new URL(`/?${HUB_ERROR_PARAM}=off`, origin), { status: 303, headers: { "cache-control": "no-store" } });
  }
  const flow = { state: randomHubValue(), nonce: randomHubValue(), back: safeBackPath(new URL(request.url).searchParams.get("back")) };
  const response = NextResponse.redirect(hubPageUrl(hub, { returnTo: origin, state: flow.state, nonce: flow.nonce }), {
    status: 303,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
  response.headers.append("set-cookie", hubCookie(encodeHubFlow(flow), origin.startsWith("https:"), HUB_FLOW_SECONDS));
  return response;
}
