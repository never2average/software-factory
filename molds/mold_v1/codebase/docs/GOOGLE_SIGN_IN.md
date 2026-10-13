# Google sign-in at a new address

"Continue with Google" works only at an address that is written, by hand, on the OAuth client's page in Google Cloud
Console. There are two lists there and this app uses both:

| List in Google Cloud Console | What needs it | What happens at an address that is not on it |
|---|---|---|
| Authorised redirect URIs | the "Continue with Google" button (a full-page round trip to Google) | Google shows its own error page, `redirect_uri_mismatch` |
| Authorised JavaScript origins | Google's own button and One Tap | nothing happens |

Google has no API for adding an address to either list. So every deployment at a new address (a new project, a new
domain) that shares a Google client with others came up with a button that could not work until a person edited
that page. Three things now stand between that and the person signing in.

## 1. The page never draws a button that cannot work

Before the sign-in page draws a Google button it asks its own server how Google sign-in works at this address
(`GET /api/auth/google/availability`, `lib/google-sign-in-mode.ts`):

| Answer | The page shows |
|---|---|
| `direct` | the Google button; it signs in at this address, as it always has |
| `hub` | the Google button; it signs in through the hub this deployment names (below) |
| `none` | no Google button at all. The emailed-code sign-in is shown open, as the sign-in |

The server finds out by asking Google the same two questions a browser would (`lib/google-origin-probe.ts`):

- `GET https://accounts.google.com/o/oauth2/v2/auth` with the client and `redirect_uri=<this origin>` answers a
  redirect to Google's sign-in pages when the address is on the redirect list, and a redirect to
  `/signin/oauth/error?authError=…` naming `redirect_uri_mismatch` when it is not.
- `GET https://accounts.google.com/gsi/status?client_id=…` with `Origin: <this origin>` and a browser's User-Agent
  answers 200 when the address is on the origins list and 403 with error code 5 when it is not.

Neither is a documented contract, so there are three answers, `listed`, `unlisted` and `unknown`, and a button is
hidden only on `unlisted`: what Google said in so many words. If Google's answer stops being understood, the page
does what it did before (`direct`, reason `unverified`), never less. Answers are remembered for ten minutes.
`AUTH_GOOGLE_ADDRESS_CHECK=off` skips the questions for a server that may not reach Google.

The same answer carries `reason` and `listed`, for whoever runs the deployment and for a check after a deploy.

## 2. The sign-in hub

An address Google lists (the hub) does the Google part for one it does not (the app). Every deployment ships both
halves; each is off until its setting is there. Both deployments must use the same Google client id.

| Setting | On | Value |
|---|---|---|
| `AUTH_GOOGLE_HUB_ORIGIN` | the app | the hub's origin: `https://<host>`, no path, no trailing slash |
| `AUTH_GOOGLE_HUB_ALLOWED_RETURNS` | the hub | the origins it answers for, separated by commas or new lines; `=A name` after one is what the hub's page calls it |

Both are read when a request arrives, so changing one takes a new deployment (or a restart) of that side to apply,
and nothing else: no rebuild of the other side.

What happens when a person clicks the button on the app:

1. The app (`/api/auth/google-hub/start`) makes a `state` and a `nonce`, keeps them with the path to come back to in
   an httpOnly cookie for ten minutes, and sends the browser to
   `<hub>/auth/google-hub?return=<the app's origin>&state=…&nonce=…`.
2. The hub's page says which address the person is signing in to and draws Google's button, bound to that nonce.
   Where Google's button cannot work (blocked pop-ups, blocked third-party storage) the page offers Google's
   full-page sign-in instead; either way the answer is the same signed token.
3. The page posts the token to the app's `/api/auth/google-hub/callback` as a form: the token is in the request's
   body, never in an address.
4. The app verifies the token exactly as it verifies every Google sign-in (Google's signature, audience = its own
   web client, issuer, expiry), and also that the token's nonce and the posted state are the ones in the cookie.
   The browser then holds the same sign-in it would hold after the direct flow, and the same rules apply to it
   (work accounts, the guest door of a shared chat).

An app whose own address is on Google's lists never uses the hub, whatever its settings.

### What keeps it safe

Each of these has its own section in `npm run test:google-hub`, and the ones a browser has a say in are also driven
in Chromium by `tests/google-hub.spec.ts`.

| Property | How |
|---|---|
| The hub is not an open redirect or a token relay | `return` must equal, as text, an origin on the allow-list: exact origins, https only, no wildcard, nothing normalised. The path the token is posted to is the code's, never the caller's. Anything else gets a page with no redirect, no link and no form |
| A token minted for another app, session or flow is refused | Google signs the nonce into the token; the app accepts only the nonce in its own cookie, and only its own web client as audience |
| A sign-in started elsewhere cannot be finished in this browser | the state must match the cookie, which is httpOnly and, over https, `__Host-` prefixed; the POST must come from the hub (the browser's `Origin`); a cookie is spent by the first answer, accepted or not |
| The token is never in an address or a log | it travels in a form POST's body and in the answering page's body; refusals are logged as a reason word and redirect with a short code |
| The hub page cannot be framed | `frame-ancestors 'none'` and `X-Frame-Options: DENY`, on a page that runs one script by nonce and may post its form to the one allowed origin only |
| The person sees where they are signing in to | the page shows the allow-list entry's host, and the name the hub's operator wrote for it; nothing the caller sent is shown |

What a hub does not change: deployments that share one Google client already accept each other's Google tokens
as sign-ins (the audience is the same), with or without a hub. Put on a hub's allow-list only deployments you
would give that client to.

### Checking a hub

```
curl 'https://<hub>/api/auth/google-hub/status?return=https://<app>'
curl 'https://<app>/api/auth/google/availability'
```

The first says whether the hub is on, whether it answers that origin, whether Google lists the hub itself, and a
fingerprint of its client id (never the id). The second says what the app's page will show and why:

| `reason` | Meaning |
|---|---|
| `listed` | Google lists this address: direct |
| `hub` | the hub answers for this address: through the hub |
| `unlisted` | Google does not list this address and no hub is set: no button |
| `hub-refuses` | the hub's allow-list does not have this origin (or the hub has not been redeployed since it was added) |
| `hub-off` / `hub-unreachable` | that address is not a hub, or did not answer |
| `hub-other-client` | the hub uses another Google client id |
| `hub-not-ready` | Google lists the hub itself for neither flow |
| `unverified` | Google's answer was not understood; the button is drawn as before |
| `no-client` | no Google client id is set |

## 3. Adding the address in Google Cloud Console instead

Still the way for a deployment that should not depend on another: open the OAuth client of type "Web application",
add the origin under "Authorised JavaScript origins" and the same origin under "Authorised redirect URIs" (no
trailing slash on either), and save. Google can take a few minutes to apply it; the page starts drawing the direct
button within ten minutes of that, with no deploy.
