/**
 * HOW GOOGLE SIGN-IN WORKS AT THIS ADDRESS, DECIDED BEFORE A BUTTON IS SHOWN: directly, through a hub, or not at all.
 *
 * The page used to draw "Continue with Google" wherever a client id was set. On an address the client does not list
 * the button led to Google's error page, and a person could not tell a broken deployment from a wrong password. Now
 * the page asks (app/api/auth/google/availability) and draws the button only when it leads somewhere:
 *
 *   direct  Google lists this address for the full-page flow: the button works here, as it always has.
 *   hub     Google does not, but this deployment names a hub (AUTH_GOOGLE_HUB_ORIGIN) that answers for it: the button
 *           goes through the hub (lib/google-hub.ts).
 *   none    neither: no Google button. The emailed code is the sign-in, shown open, not behind a link.
 *
 * "Not listed" is only ever what Google said (lib/google-origin-probe.ts). When Google's answer is not understood
 * and no hub answers, the mode is `direct`: what the page did before, never a button hidden on a guess.
 *
 * Dependency-free beyond its two neighbours, so plain-node tests load it.
 */
import { checkGoogleAddress, type GoogleAddressCheck, type Listing } from "./google-origin-probe.ts";
import { HUB_STATUS_PATH, allowedReturn, allowedReturns, clientFingerprint, hubEnabled, hubOriginSetting } from "./google-hub.ts";

type Env = Record<string, string | undefined>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type GoogleSignInMode = "direct" | "hub" | "none";

export interface GoogleAvailability {
  google: GoogleSignInMode;
  /** One Tap and the Google button need the origin list as well; false when Google says this address is not on it. */
  oneTap: boolean;
  /**
   * Why, for the person running the deployment (never shown to someone signing in):
   *   listed | unverified            direct
   *   hub                            hub
   *   no-client | unlisted           none, nothing else to try
   *   hub-refuses | hub-unreachable | hub-other-client | hub-not-ready | hub-off     none (or direct when Google's
   *                                  answer for this address was not understood), and the hub is why
   */
  reason: string;
  /** Google's two answers for this address. */
  listed: GoogleAddressCheck;
  /** The hub this deployment names, when it names one. */
  hub: string | null;
}

/** What a hub says about itself and about one origin (app/api/auth/google-hub/status). */
export interface HubStatus {
  hub: boolean;
  /** Is the asked origin on its allow-list? */
  allowed: boolean;
  /** Fingerprint of the hub's Google client (lib/google-hub.ts clientFingerprint). */
  client: string | null;
  /** Google's two answers for the HUB's own address. */
  listed: GoogleAddressCheck;
  /** True when the hub can complete a Google sign-in itself, by either flow. */
  ready: boolean;
  /** Entries of its allow-list that are not exact https origins and were dropped (count only). */
  dropped: number;
}

const usable = (l: Listing): boolean => l !== "unlisted";

/** The hub's answer about `returnTo`, computed on the hub. */
export async function hubStatus(
  returnTo: string | null,
  ownOrigin: string,
  opts: { env?: Env; fetcher?: Fetch } = {},
): Promise<HubStatus> {
  const env = opts.env ?? process.env;
  const clientId = (env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "").trim();
  const off: GoogleAddressCheck = { redirect: "unknown", origin: "unknown" };
  if (!hubEnabled(env)) return { hub: false, allowed: false, client: null, listed: off, ready: false, dropped: 0 };
  const listed = clientId ? await checkGoogleAddress(clientId, ownOrigin, { env, fetcher: opts.fetcher }) : off;
  return {
    hub: true,
    allowed: Boolean(allowedReturn(returnTo, env)),
    client: await clientFingerprint(clientId),
    listed,
    // Either flow will do: the hub page offers whichever Google has not refused.
    ready: Boolean(clientId) && (usable(listed.redirect) || usable(listed.origin)),
    dropped: allowedReturns(env).invalid.length,
  };
}

const HUB_ASK_MS = 4000;
const hubAnswers = new Map<string, { at: number; value: HubStatus | null }>();

/** Ask a hub about this origin. Null when it did not answer in the shape above. Remembered for a minute. */
async function askHub(hub: string, ownOrigin: string, fetcher: Fetch, now: number): Promise<HubStatus | null> {
  const key = `${hub}\n${ownOrigin}`;
  const hit = hubAnswers.get(key);
  if (hit && now - hit.at < 60_000) return hit.value;
  let value: HubStatus | null = null;
  try {
    const res = await fetcher(`${hub}${HUB_STATUS_PATH}?${new URLSearchParams({ return: ownOrigin })}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(HUB_ASK_MS),
      cache: "no-store",
      redirect: "error",
    });
    const body = res.ok ? ((await res.json()) as Partial<HubStatus> | null) : null;
    if (body && typeof body.hub === "boolean") {
      value = {
        hub: body.hub,
        allowed: body.allowed === true,
        client: typeof body.client === "string" ? body.client : null,
        listed: body.listed ?? { redirect: "unknown", origin: "unknown" },
        ready: body.ready === true,
        dropped: typeof body.dropped === "number" ? body.dropped : 0,
      };
    }
  } catch {
    value = null;
  }
  hubAnswers.set(key, { at: now, value });
  if (hubAnswers.size > 50) hubAnswers.delete(hubAnswers.keys().next().value as string);
  return value;
}

/** How Google sign-in works for a page served at `ownOrigin`. */
export async function googleAvailability(
  ownOrigin: string,
  opts: { env?: Env; fetcher?: Fetch; now?: number } = {},
): Promise<GoogleAvailability> {
  const env = opts.env ?? process.env;
  const fetcher = opts.fetcher ?? fetch;
  const now = opts.now ?? Date.now();
  const clientId = (env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "").trim();
  const hubSetting = hubOriginSetting(env);
  // A deployment is never its own hub: at its own address it signs in directly.
  const hub = hubSetting && hubSetting !== ownOrigin ? hubSetting : null;
  if (!clientId) {
    return { google: "none", oneTap: false, reason: "no-client", listed: { redirect: "unknown", origin: "unknown" }, hub };
  }
  const listed = await checkGoogleAddress(clientId, ownOrigin, { env, fetcher, now });
  const oneTap = usable(listed.origin);
  if (listed.redirect === "listed") return { google: "direct", oneTap, reason: "listed", listed, hub };

  let hubWhy: string | null = null;
  if (hub) {
    const status = await askHub(hub, ownOrigin, fetcher, now);
    if (!status) hubWhy = "hub-unreachable";
    else if (!status.hub) hubWhy = "hub-off";
    else if (!status.allowed) hubWhy = "hub-refuses";
    else if (status.client !== (await clientFingerprint(clientId))) hubWhy = "hub-other-client";
    else if (!status.ready) hubWhy = "hub-not-ready";
    else return { google: "hub", oneTap: false, reason: "hub", listed, hub };
  }
  if (listed.redirect === "unlisted") return { google: "none", oneTap: false, reason: hubWhy ?? "unlisted", listed, hub };
  return { google: "direct", oneTap, reason: hubWhy ?? "unverified", listed, hub };
}

/** Test seam: forget remembered hub answers. */
export function __forgetHubAnswers(): void {
  hubAnswers.clear();
}
