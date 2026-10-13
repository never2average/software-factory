import { NextRequest, NextResponse } from "next/server";
import { PRODUCT_NAME } from "@/lib/deployment-profile.generated";
import { allowedReturn, hubEnabled, requestOrigin, validHubValue } from "@/lib/google-hub";
import { hubPage, hubRefusalPage } from "@/lib/google-hub-page";
import { checkGoogleAddress } from "@/lib/google-origin-probe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /auth/google-hub?return=<origin>&state=…&nonce=…: this deployment, as a sign-in hub, answering another
 * (lib/google-hub.ts, step 2; the page is lib/google-hub-page.ts).
 *
 * Off (404) unless AUTH_GOOGLE_HUB_ALLOWED_RETURNS is set. `return` must be, character for character, an origin on
 * that list; anything else gets a page that says so and offers nowhere to go: no redirect, no link, nothing built
 * from what was sent. `state` and `nonce` must have the shape the asking app makes them in.
 */
export async function GET(request: NextRequest) {
  const send = (page: { status: number; headers: Record<string, string>; body: string }) =>
    new NextResponse(page.body, { status: page.status, headers: page.headers });
  if (!hubEnabled()) return send(hubRefusalPage(404, "There is no sign-in page at this address."));
  const q = new URL(request.url).searchParams;
  const to = allowedReturn(q.get("return"));
  if (!to) return send(hubRefusalPage(400, "It names an address this sign-in page does not serve. Go back to the page you came from and try again."));
  const state = q.get("state");
  const nonce = q.get("nonce");
  if (!validHubValue(state) || !validHubValue(nonce)) {
    return send(hubRefusalPage(400, "It is incomplete. Go back to the page you came from and try again."));
  }
  const clientId = (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "").trim();
  if (!clientId) return send(hubRefusalPage(503, "Google sign-in is not set up here. Go back and sign in with a code sent to your email."));
  const hubOrigin = requestOrigin(request);
  return send(
    hubPage({
      to,
      state,
      nonce,
      clientId,
      hubOrigin,
      hubName: PRODUCT_NAME,
      listed: await checkGoogleAddress(clientId, hubOrigin),
      cspNonce: crypto.randomUUID().replace(/-/g, ""),
    }),
  );
}
