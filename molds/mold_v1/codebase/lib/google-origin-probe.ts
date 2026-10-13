/**
 * DOES GOOGLE KNOW THIS ADDRESS? Asked of Google itself, from the server, before a button is shown.
 *
 * An OAuth client lists, by hand, the addresses it serves. There are two lists and this app uses both:
 *
 *   - "Authorised redirect URIs": the full-page flow behind the "Continue with Google" button. Google sends the
 *     person to an error page ("redirect_uri_mismatch") when the address is not on it.
 *   - "Authorised JavaScript origins": the Google button and One Tap. They do nothing on an address not on it.
 *
 * Neither list can be read through an API, but Google's own sign-in endpoints answer differently for a listed and
 * an unlisted address, and they answer a server as they answer a browser (measured 2026-10-13 with one client, one
 * listed and three unlisted addresses):
 *
 *   - redirect list: GET accounts.google.com/o/oauth2/v2/auth with the client and `redirect_uri=<origin>` answers
 *     302 to its sign-in pages when listed, and 302 to `/signin/oauth/error?authError=<base64 beginning
 *     "redirect_uri_mismatch">` when not.
 *   - origin list: GET accounts.google.com/gsi/status?client_id=… with `Origin: <origin>` and a browser's
 *     User-Agent answers 200 when listed and 403 with error code 5 when not. (Without a browser's User-Agent it
 *     answers 403 with code 9 for every origin, which says nothing; a wrong client is code 3.)
 *
 * Neither is a documented contract. So there are THREE answers, and anything not recognised is "unknown": a caller
 * hides a button only on "unlisted", which Google said in so many words, never on a guess. A change on Google's
 * side therefore degrades to what the page did before this file existed, not to a missing button.
 *
 * Nothing here signs anyone in or carries a person's data: the requests name the client (public, it is in the
 * page's JavaScript) and an address. No client id is written to a log.
 */
export type Listing = "listed" | "unlisted" | "unknown";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT_MS = 3500;

/** Is `origin` on the client's redirect list? */
export async function probeRedirectList(clientId: string, origin: string, fetcher: Fetch = fetch): Promise<Listing> {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: origin,
    response_type: "id_token",
    scope: "openid email profile",
    nonce: "address-check",
  });
  try {
    const res = await fetcher(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, {
      redirect: "manual",
      headers: { "user-agent": BROWSER_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status < 300 || res.status > 399) return "unknown";
    const location = res.headers.get("location") ?? "";
    let to: URL;
    try {
      to = new URL(location, "https://accounts.google.com");
    } catch {
      return "unknown";
    }
    if (to.hostname !== "accounts.google.com") return "unknown";
    const authError = to.searchParams.get("authError");
    if (authError !== null || to.pathname.includes("/error")) {
      // The error's name is the first field of the base64 text. Only this one name means "not on the list".
      let text = "";
      try {
        text = atob((authError ?? "").replace(/-/g, "+").replace(/_/g, "/"));
      } catch {
        text = "";
      }
      return text.includes("redirect_uri_mismatch") ? "unlisted" : "unknown";
    }
    // On to Google's own sign-in or account pages: the address was accepted.
    return /^\/(v\d+\/signin|signin|o\/oauth2|ServiceLogin|AccountChooser|InteractiveLogin)/.test(to.pathname) ? "listed" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Is `origin` on the client's JavaScript-origins list? */
export async function probeOriginList(clientId: string, origin: string, fetcher: Fetch = fetch): Promise<Listing> {
  try {
    const res = await fetcher(`https://accounts.google.com/gsi/status?${new URLSearchParams({ client_id: clientId })}`, {
      headers: { origin, "user-agent": BROWSER_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status === 200) return "listed";
    if (res.status !== 403) return "unknown";
    // `)]}'\n[["<token>"],[5]]`: the last bracket holds Google's error code.
    const body = (await res.text()).slice(0, 400);
    const code = /\],\s*\[(\d+)\]\s*\]\s*$/.exec(body.trim())?.[1];
    return code === "5" ? "unlisted" : "unknown";
  } catch {
    return "unknown";
  }
}

export interface GoogleAddressCheck {
  /** The full-page flow behind the button. */
  redirect: Listing;
  /** The Google button and One Tap. */
  origin: Listing;
}

const KNOWN_FOR_MS = 10 * 60_000;
const UNKNOWN_FOR_MS = 60_000;
const remembered = new Map<string, { at: number; value: GoogleAddressCheck }>();
/**
 * At most this many addresses are asked about per minute, per server process. The address comes from the request
 * (its Host), and the answer page is public, so without a ceiling anyone could make this server question Google
 * about a stream of invented addresses. A real deployment has one or two. Over the ceiling the answer is "unknown"
 * (not remembered), which hides nothing.
 */
const ASKS_PER_MINUTE = 12;
let asked: number[] = [];

/**
 * Both lists for one address, remembered for ten minutes (one minute when either answer was "unknown", so a
 * hiccup is asked again soon). AUTH_GOOGLE_ADDRESS_CHECK=off answers "unknown" without asking: for a deployment
 * that may not reach Google from its server, and for tests.
 */
export async function checkGoogleAddress(
  clientId: string,
  origin: string,
  opts: { fetcher?: Fetch; now?: number; env?: Record<string, string | undefined> } = {},
): Promise<GoogleAddressCheck> {
  const env = opts.env ?? process.env;
  if ((env.AUTH_GOOGLE_ADDRESS_CHECK ?? "").trim().toLowerCase() === "off") return { redirect: "unknown", origin: "unknown" };
  const now = opts.now ?? Date.now();
  const key = `${clientId}\n${origin}`;
  const hit = remembered.get(key);
  if (hit) {
    const known = hit.value.redirect !== "unknown" && hit.value.origin !== "unknown";
    if (now - hit.at < (known ? KNOWN_FOR_MS : UNKNOWN_FOR_MS)) return hit.value;
  }
  asked = asked.filter((t) => now - t < 60_000);
  if (asked.length >= ASKS_PER_MINUTE) return { redirect: "unknown", origin: "unknown" };
  asked.push(now);
  const [redirect, originList] = await Promise.all([
    probeRedirectList(clientId, origin, opts.fetcher),
    probeOriginList(clientId, origin, opts.fetcher),
  ]);
  const value = { redirect, origin: originList };
  remembered.set(key, { at: now, value });
  if (remembered.size > 200) remembered.delete(remembered.keys().next().value as string);
  return value;
}

/** Test seam: forget what was remembered. */
export function __forgetGoogleAddressChecks(): void {
  remembered.clear();
  asked = [];
}
