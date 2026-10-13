import { NextRequest, NextResponse } from "next/server";
import { STORAGE_KEYS } from "@/lib/browser-storage";
import {
  HUB_ERROR_PARAM,
  type HubRefusal,
  decodeHubFlow,
  hubCookie,
  hubCookieName,
  hubOriginSetting,
  readCookie,
  requestOrigin,
  sameText,
  validHubValue,
} from "@/lib/google-hub";
import { verifyHubSignIn } from "@/lib/ops-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/google-hub/callback: the hub's answer (lib/google-hub.ts, steps 3 and 4).
 *
 * The hub's page posts a form here: `credential` (Google's ID token) and `state`. It is accepted only when ALL hold:
 *
 *   - this deployment names a hub, and the POST came from it (the browser's Origin header, when it sends one);
 *   - this browser holds the cookie of a sign-in it started in the last ten minutes;
 *   - the posted state is the cookie's (so a sign-in someone else started cannot be finished in this browser);
 *   - Google signed the token, for this deployment's web client, unexpired (lib/ops-auth.ts verifyHubSignIn);
 *   - the token's nonce is the cookie's (so a token minted for another app or another sign-in is refused).
 *
 * The cookie is cleared whatever the outcome: one start, one answer.
 *
 * Accepted, the browser is handed the token the way the direct flow hands it over: this answers a small page that
 * puts it in the tab's own storage and goes to the path the sign-in was started from, where the sign-in gate adopts
 * it exactly as it adopts a token Google returned directly (the same account checks, the same guest door). The token
 * is in this response's body and nowhere else: not in an address, not in a header, not in a log line.
 *
 * Refused, the browser goes to the home page with a short code the page turns into a sentence. The code says which
 * check failed; it never carries anything from the token.
 */
const MAX_BODY = 16 * 1024;

function refuse(origin: string, why: HubRefusal): NextResponse {
  // One plain line, no token and no claim from it.
  console.warn(`[google-hub] sign-in refused: ${why}`);
  const response = NextResponse.redirect(new URL(`/?${HUB_ERROR_PARAM}=${why}`, origin), {
    status: 303,
    headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
  response.headers.append("set-cookie", hubCookie("", origin.startsWith("https:"), 0));
  return response;
}

/** For a script block: no `<`, so nothing inside can close the block or open another. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");

export async function POST(request: NextRequest) {
  const origin = requestOrigin(request);
  const secure = origin.startsWith("https:");
  const hub = hubOriginSetting();
  if (!hub || hub === origin) return refuse(origin, "off");

  // The browser names the site a cross-site POST came from. When it does, it must be the hub.
  const from = request.headers.get("origin");
  if (from && from !== hub) return refuse(origin, "origin");

  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY) return refuse(origin, "incomplete");
  let credential = "";
  let state = "";
  try {
    const body = await request.text();
    if (body.length > MAX_BODY) return refuse(origin, "incomplete");
    const form = new URLSearchParams(body);
    credential = form.get("credential") ?? "";
    state = form.get("state") ?? "";
  } catch {
    return refuse(origin, "incomplete");
  }
  if (!credential || !validHubValue(state)) return refuse(origin, "incomplete");

  const flow = decodeHubFlow(readCookie(request.headers.get("cookie"), hubCookieName(secure)));
  if (!flow) return refuse(origin, "expired");
  if (!sameText(state, flow.state)) return refuse(origin, "state");

  const verified = await verifyHubSignIn(credential, flow.nonce);
  if (!verified.ok) return refuse(origin, verified.reason);

  const nonce = crypto.randomUUID().replace(/-/g, "");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Signing you in</title></head>` +
    `<body><p id="m">Signing you in…</p><noscript>This page needs JavaScript to finish signing you in.</noscript>` +
    `<script nonce="${nonce}">(function(){var d=${scriptJson({ key: STORAGE_KEYS.hubHandoff, token: credential, back: flow.back })};` +
    `try{sessionStorage.setItem(d.key,d.token)}catch(e){document.getElementById("m").textContent=` +
    `"This browser would not keep the sign-in. Allow site data for this address and try again.";return}` +
    `location.replace(d.back)})()</script></body></html>`;
  const response = new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
  response.headers.append("set-cookie", hubCookie("", secure, 0));
  return response;
}
