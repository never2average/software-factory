/**
 * THE SIGN-IN HUB'S PAGE (lib/google-hub.ts, step 2), as one HTML document and its headers.
 *
 * Deliberately not a React page: it loads none of the app's JavaScript, so its policy can name the one script that
 * runs here (by nonce) and Google's, and nothing else. What the page does:
 *
 *   - says, in words, which address the person is signing in to: the allow-list entry's name when the hub's operator
 *     gave it one, and always its host. Nothing on the page is text the caller sent;
 *   - draws Google's own button, bound to the caller's nonce, when Google lists this hub for it; and a full-page
 *     "Continue with Google" for browsers where the button cannot work (blocked pop-ups, blocked third-party
 *     storage), when Google lists this hub for that. Either answer is the same signed token;
 *   - posts the token to the asking app's callback (a form POST: the token is in the request's body), with the
 *     caller's state beside it. The form's address is built here from the allow-list entry.
 *
 * It cannot be framed (frame-ancestors 'none', X-Frame-Options DENY), is never cached, sends no referrer, and its
 * form may post to the one allowed origin only. The token is never written to the console or to an address: the
 * full-page flow receives it in the URL fragment, which is not sent to any server, and the script removes the
 * fragment before it does anything else.
 */
import { type AllowedReturn, callbackUrlFor, encodeHubRoundTrip } from "./google-hub.ts";
import type { GoogleAddressCheck } from "./google-origin-probe.ts";

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");

const BASE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // The page's address holds the state and the nonce, so no page it leads to is told it; only this hub's origin
  // is, which is what lets the asking app see that the form POST came from its hub (with `no-referrer` a browser
  // sends `Origin: null` on a cross-site form POST).
  "referrer-policy": "strict-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex",
};

const STYLE =
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:15px/1.5 system-ui,sans-serif;" +
  "background:#fafafa;color:#18181b}main{width:100%;max-width:24rem;padding:1.5rem;text-align:center}" +
  "h1{font-size:1.25rem;margin:0 0 .25rem}.to{font-weight:600;word-break:break-all}.muted{color:#52525b;font-size:.8125rem}" +
  "#g{display:flex;justify-content:center;min-height:44px;margin:1.5rem 0 .75rem}" +
  "button{font:inherit;cursor:pointer;border:1px solid #d4d4d8;background:#fff;color:#18181b;border-radius:9999px;padding:.55rem 1.25rem}" +
  "button.link{border:0;background:none;color:#52525b;text-decoration:underline;font-size:.8125rem;padding:.25rem}" +
  "#err{color:#b91c1c;font-size:.8125rem;min-height:1.25rem}[hidden]{display:none!important}" +
  "@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}.muted,button.link{color:#a1a1aa}" +
  "button{background:#18181b;color:#fafafa;border-color:#3f3f46}#err{color:#fca5a5}}";

/** A page that says the request cannot be served, and offers nowhere to go: never a link built from the request. */
export function hubRefusalPage(status: number, message: string): { status: number; headers: Record<string, string>; body: string } {
  return {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
    body:
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Sign-in</title><style>${STYLE}</style></head><body><main><h1>This sign-in link cannot be used</h1>` +
      `<p class="muted">${escapeHtml(message)}</p></main></body></html>`,
  };
}

export function hubPage(input: {
  /** The allow-list entry being answered. */
  to: AllowedReturn;
  state: string;
  nonce: string;
  clientId: string;
  /** This hub's own address, as the browser sees it. */
  hubOrigin: string;
  /** What this hub is called. */
  hubName: string;
  /** Google's answers for the hub's own address: which of the two flows to offer. */
  listed: GoogleAddressCheck;
  /** A fresh value per response, for the policy's script nonce. */
  cspNonce: string;
}): { status: number; headers: Record<string, string>; body: string } {
  const { to, state, nonce, clientId, hubOrigin, cspNonce } = input;
  const button = input.listed.origin !== "unlisted";
  const fullPage = input.listed.redirect !== "unlisted";
  if (!button && !fullPage) {
    return hubRefusalPage(503, "Google sign-in is not available here right now. Go back and sign in with a code sent to your email.");
  }
  const action = callbackUrlFor(to);
  const config = {
    clientId,
    nonce,
    button,
    fullPage,
    // The full-page flow: Google returns to this hub's home address, which is the one its console lists.
    redirect:
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: hubOrigin,
        response_type: "id_token",
        scope: "openid email profile",
        nonce,
        prompt: "select_account",
        state: encodeHubRoundTrip({ returnTo: to.origin, state, nonce }),
      }),
  };
  // The page's one script. It never logs, and it never puts the token anywhere but the form it posts.
  const script =
    `(function(){var c=${scriptJson(config)},f=document.getElementById("f"),err=document.getElementById("err");` +
    `function say(t){err.textContent=t}` +
    `function nonceOf(t){try{var p=t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");return JSON.parse(atob(p)).nonce}catch(e){return null}}` +
    `function send(t){if(!t||nonceOf(t)!==c.nonce){say("That sign-in did not match this page. Go back and try again.");return}` +
    `f.elements.credential.value=t;document.getElementById("g").hidden=true;say("");document.getElementById("w").hidden=false;f.submit()}` +
    `if(location.hash.indexOf("id_token=")>-1){var h=new URLSearchParams(location.hash.slice(1));` +
    `history.replaceState(null,"",location.pathname+location.search);send(h.get("id_token"));return}` +
    `var fp=document.getElementById("fp");` +
    `if(c.fullPage){fp.addEventListener("click",function(){location.assign(c.redirect)})}else{fp.hidden=true}` +
    `function noButton(){if(c.fullPage){fp.className="";fp.textContent="Continue with Google";document.getElementById("g").hidden=true}` +
    `else{say("Google sign-in did not load. Go back and sign in with a code sent to your email.")}}` +
    `if(!c.button){noButton();return}` +
    `var s=document.createElement("script");s.src="https://accounts.google.com/gsi/client";s.async=true;s.nonce=${scriptJson(cspNonce)};` +
    `s.onerror=noButton;s.onload=function(){try{google.accounts.id.initialize({client_id:c.clientId,nonce:c.nonce,ux_mode:"popup",` +
    `auto_select:false,callback:function(r){send(r&&r.credential)}});` +
    `google.accounts.id.renderButton(document.getElementById("g"),{theme:"outline",size:"large",text:"continue_with",shape:"pill",width:300})}` +
    `catch(e){noButton()}};document.head.appendChild(s)})()`;
  const name = to.label ? `${escapeHtml(to.label)} <span class="muted">(${escapeHtml(to.host)})</span>` : escapeHtml(to.host);
  const body =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Sign in to ${escapeHtml(to.label ?? to.host)}</title><style>${STYLE}</style></head><body><main>` +
    `<h1>Sign in with Google</h1>` +
    `<p>You are signing in to <span class="to" data-hub-return>${name}</span>.</p>` +
    `<p class="muted">Only continue if that is where you came from. Sign-in for it is provided by ${escapeHtml(input.hubName)}.</p>` +
    `<div id="g" data-hub-google></div>` +
    `<p id="w" class="muted" hidden>Taking you back to ${escapeHtml(to.host)}…</p>` +
    `<p id="err" role="alert"></p>` +
    `<button type="button" id="fp" class="link" data-hub-full-page>Button not working? Continue on Google's page instead</button>` +
    `<form id="f" method="post" action="${escapeHtml(action)}" hidden>` +
    `<input type="hidden" name="credential" value=""><input type="hidden" name="state" value="${escapeHtml(state)}"></form>` +
    `<noscript><p class="muted">This page needs JavaScript. Go back and sign in with a code sent to your email.</p></noscript>` +
    `<script nonce="${cspNonce}">${script}</script></main></body></html>`;
  const csp = [
    "default-src 'none'",
    // This page's one script (by nonce) and Google's sign-in client. No 'unsafe-inline', no 'self': the app's
    // bundles do not run here.
    `script-src 'nonce-${cspNonce}' https://accounts.google.com/gsi/client`,
    // Google's client styles its button with a sheet of its own and inline styles.
    "style-src 'unsafe-inline' https://accounts.google.com/gsi/style",
    "frame-src https://accounts.google.com/gsi/",
    "connect-src https://accounts.google.com/gsi/",
    "img-src data: https://*.googleusercontent.com",
    "base-uri 'none'",
    // The token may be posted to the allowed origin and nowhere else.
    `form-action ${to.origin}`,
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "content-security-policy": csp,
      // Google's button opens a pop-up that must be able to answer this page.
      "cross-origin-opener-policy": "same-origin-allow-popups",
    },
    body,
  };
}
