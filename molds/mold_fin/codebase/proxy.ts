import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { explainAuthFailure, verifyOpsAuth, verifyOpsAuthResult } from "@/lib/ops-auth";

/**
 * Next.js 16 "proxy" (the renamed middleware convention). Two jobs:
 *
 *  1. AUTH GATE for the Ops API. Every `/api/ops/*` route — connectors,
 *     workflows, crons, their audit and runs — requires a verified @onfinance.in
 *     Google identity (see lib/ops-auth.ts). Before this, the API was open to
 *     anyone who knew the URL. The health probe stays public so an uptime monitor
 *     (no token) can reach it.
 *
 *  2. CONTENT-SECURITY-POLICY on every document response. The signed-in user's
 *     Google ID token lives in localStorage (a Bearer token, the pragmatic choice
 *     for this two-origin SPA→API split), so the residual risk is script injection
 *     exfiltrating it. The CSP is defense-in-depth against that.
 *
 *     We deliberately do NOT use a nonce + `strict-dynamic` script policy: this
 *     app builds with Next 16 + Turbopack, which does not stamp the CSP nonce
 *     onto its own `<script>` chunks, so `strict-dynamic` (which ignores `'self'`)
 *     blocks the entire bundle. A report-only rollout proved that on the real
 *     origin. So scripts are allowed by host (`'self'` + Google sign-in), which
 *     keeps `'unsafe-inline'` honored, and the REAL control lives in
 *     `connect-src 'self'` — even an injected script cannot POST the token to an
 *     attacker origin (fetch/XHR/beacon/WebSocket are same-origin only). The
 *     `object-src`/`base-uri`/`frame-ancestors`/`form-action` directives close the
 *     usual side doors. `'wasm-unsafe-eval'` is for the shiki/oniguruma WASM
 *     syntax highlighter.
 *
 * Rollout: ENFORCING by default (a real-origin audit showed zero violations).
 * Set CSP_REPORT_ONLY=1 to fall back to report-only if a future change needs
 * re-validation before it blocks.
 */
export const config = {
  // Run on everything except Next's static assets and the favicon, so the CSP
  // header lands on document responses (and the auth branch still sees /api/ops).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function buildCsp(pathname: string): string {
  // The app must never be framed by anyone (clickjacking) — `frame-ancestors
  // 'none'`. The ONE exception is the artifact proxy: its HTML/SVG response is
  // embedded in OUR OWN page's preview iframe, so it needs 'self' or the browser
  // refuses to connect. Scoping the relaxation to this path keeps every real
  // page un-framable.
  const frameAncestors = pathname === "/api/artifact-proxy" ? "'self'" : "'none'";
  return [
    "default-src 'self'",
    // Host-based (no nonce/strict-dynamic — unsupported by Next16+Turbopack here).
    // 'unsafe-inline' is honored only because no nonce is present.
    // 'unsafe-eval' is required by the shiki JS syntax highlighter (compiles
    // string→JS); it's a superset of 'wasm-unsafe-eval' so it also covers the
    // oniguruma WASM path. Script-src is already soft (unsafe-inline); the real
    // exfil control is connect-src below.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://accounts.google.com https://apis.google.com",
    // Renderer (shiki/mermaid/KaTeX) and Google One Tap inject inline styles.
    // accounts.google.com is also needed as a HOST: the GIS button loads an
    // EXTERNAL sheet (accounts.google.com/gsi/style), which 'unsafe-inline' does
    // NOT cover. Blocking it renders the sign-in button unstyled — it paints but
    // its hit-area collapses, so "Continue with Google" looks dead on click.
    "style-src 'self' 'unsafe-inline' https://accounts.google.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com https://accounts.google.com",
    "font-src 'self' data:",
    // The exfil control: same-origin only (the /eve proxy is same-origin) plus
    // Google for the sign-in handshake. A stolen token can't be POSTed elsewhere.
    "connect-src 'self' https://accounts.google.com",
    // Google One Tap renders in an iframe from accounts.google.com. 'self' +
    // blob: are for the artifact preview iframe (an HTML/SVG deliverable, loaded
    // same-origin via /api/artifact-proxy or as inline srcdoc) — without 'self'
    // here the frame-src directive (which does NOT fall back to default-src)
    // blocked every artifact iframe, so HTML artifacts rendered blank.
    // browserbase.com is the embedded live-view of the agent's browser session
    // (an interactive iframe — the operator can take control of the session).
    "frame-src 'self' blob: https://accounts.google.com https://www.browserbase.com https://browserbase.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Ops API auth gate (health stays public).
  //
  // `/api/ops/run` is EXEMPT here and self-guards instead. It's the internal
  // trigger the agent's trigger_workflow / run_app tools fire, authenticated
  // with CRON_SECRET (a machine credential, same as the Vercel crons) — NOT a
  // Google identity. We can't verify that secret in THIS layer: the proxy runs
  // on the Edge runtime where `process.env.CRON_SECRET` is undefined, so a
  // secret comparison here always failed and rejected the agent with "Sign in
  // with your @onfinance.in account". The route runs on the Node runtime, where
  // the secret IS available and it enforces `Bearer <CRON_SECRET>` itself, so
  // skipping the identity gate for this one path loses no protection.
  const isSelfGuardedServiceRoute = pathname === "/api/ops/run";
  /**
   * `/api/auth/*` is PRE-authentication and cannot sit behind the auth gate —
   * that is the whole point of it. These are the two email sign-in routes, and
   * they are not an open door: `request` only emails a code to an address that
   * already holds a membership or a live invite, and `verify` demands that code
   * within ten minutes, five attempts, once. Both are rate limited, and neither
   * reveals whether an address qualifies.
   */
  if (pathname.startsWith("/api/auth/")) {
    const passthrough = NextResponse.next();
    passthrough.headers.set(
      process.env.CSP_REPORT_ONLY === "1"
        ? "content-security-policy-report-only"
        : "content-security-policy",
      buildCsp(pathname),
    );
    return passthrough;
  }
  if (
    pathname.startsWith("/api/ops/") &&
    pathname !== "/api/ops/health" &&
    !isSelfGuardedServiceRoute
  ) {
    const auth = await verifyOpsAuthResult(request.headers.get("authorization"));
    if (!auth.ok) {
      /**
       * Say WHY, and stop naming one company's domain.
       *
       * This returned "Sign in with your @onfinance.in account" for every
       * rejection — wrong for any other workspace, and un-actionable for all of
       * them. A makemydemo.com owner read it as "you need an OnFinance account"
       * and concluded the product was broken for them. The reason is a fact
       * about the caller's own token, so returning it leaks nothing.
       */
      return NextResponse.json(
        { error: explainAuthFailure(auth.reason, auth.email), reason: auth.reason },
        { status: 401 },
      );
    }
    const identity = auth.identity;
  }

  // 2. CSP on the response. Enforcing unless CSP_REPORT_ONLY=1.
  const csp = buildCsp(pathname);
  const headerName =
    process.env.CSP_REPORT_ONLY === "1"
      ? "content-security-policy-report-only"
      : "content-security-policy";
  const response = NextResponse.next();
  response.headers.set(headerName, csp);
  return response;
}
