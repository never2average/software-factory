"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatShell } from "./chat-shell";
import { EmailSignIn } from "./email-sign-in";
import { Spinner } from "@/components/ui/spinner";
import { sharedGet } from "@/lib/startup-fetch";
import { DEPLOYMENT_PROFILE, PRODUCT_NAME, fillProfileText } from "@/lib/deployment-profile.generated";
import { STORAGE_KEYS, readStored, removeStored, writeStored } from "@/lib/browser-storage";
import { clearAllPending } from "@/lib/chat-queue";
import { clearDesktopPrefs, forgetThisDevice } from "./desktop-notify";
import { forgetQueueCache } from "./use-chat-queue";

// Minimal typing for the Google Identity Services client we load at runtime.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize(cfg: {
            client_id: string;
            callback: (r: { credential: string }) => void;
            auto_select?: boolean;
          }): void;
          prompt(listener?: (n: PromptNotification) => void): void;
          renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
          disableAutoSelect(): void;
        };
      };
    };
  }
}

/** One Tap's notification object — tells us WHY a prompt didn't show. */
interface PromptNotification {
  isNotDisplayed(): boolean;
  isSkippedMoment(): boolean;
  getNotDisplayedReason?(): string;
  getSkippedReason?(): string;
}

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const GIS_SRC = "https://accounts.google.com/gsi/client";
/**
 * The signed-in session. These three keys were `fde-*` until the base product's
 * role name came out of the wire; every read below goes through lib/browser-storage,
 * which falls back to the old spelling, because renaming the token key outright
 * signs out every analyst with an open tab.
 */
const TOKEN_KEY = STORAGE_KEYS.token;
/** Where the invite outcome is left for ChatShell to render. */
export const INVITE_RESULT_KEY = STORAGE_KEYS.inviteResult;

const NONCE_KEY = STORAGE_KEYS.nonce;

interface Claims {
  email?: string;
  name?: string;
  picture?: string;
  exp?: number;
  hd?: string;
  nonce?: string;
  /** "email-session" for tokens WE mint (see lib/auth-session.ts). */
  kind?: string;
  iss?: string;
}

function decodeJwt(token: string): Claims {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload)) as Claims;
  } catch {
    return {};
  }
}

function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Google sign-in")));
      return;
    }
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google sign-in"));
    document.head.appendChild(s);
  });
}

/**
 * The <head> script (lib/startup-fetch.ts) marks <html data-session> when this browser holds an unexpired session, so
 * the first paint is the app's frame rather than the sign-in card. The moment this component learns there is no
 * usable session after all (none restored, refused, expired, signed out) the mark goes, and the card shows.
 */
function endSessionFrame(): void {
  try {
    document.documentElement.removeAttribute("data-session");
  } catch {
    /* no document */
  }
}

/**
 * What a signed-in person sees before the app's JavaScript has run: the shell's outline (sidebar, composer) in the
 * page's own colours, instead of a sign-in card that is about to vanish. Shown only under <html data-session>.
 */
function SessionFrame() {
  return (
    <div data-session-frame aria-hidden className="h-dvh w-full bg-background">
      <div className="hidden h-dvh w-72 shrink-0 flex-col gap-2 border-border border-r bg-muted/20 px-3 py-4 md:flex">
        <div className="h-6 w-32 rounded bg-muted/70" />
        <div className="mt-4 flex flex-col gap-2">
          {[70, 55, 62, 48, 66, 58].map((w, i) => (
            <div key={i} className="h-3.5 rounded bg-muted/50" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-end">
        <div className="mx-auto w-full max-w-3xl px-4 pb-5 sm:px-6">
          <div className="h-24 w-full rounded-2xl border border-border/60 bg-muted/30" />
        </div>
      </div>
    </div>
  );
}

export function AuthGate() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [picture, setPicture] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gisReady, setGisReady] = useState(false);
  /** Whether this identity belongs to any workspace yet. */
  const [orgState, setOrgState] = useState<"unknown" | "ok" | "none">("unknown");
  const tokenRef = useRef<string | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once we've restored a session from storage — suppresses the One Tap
  // prompt so a logged-in user isn't asked to pick an account on every load.
  const restoredRef = useRef(false);

  // Live getter so useEveAgent always sends the current token without remounting.
  /**
   * Identity AND workspace, on every request.
   *
   * This returned the bearer alone, so the many `fetch("/api/ops/…", { headers:
   * getAuthHeaders() })` call sites in chat-shell — customers, chat sessions,
   * workflow runs — carried no workspace and the server fell back to the
   * caller's DEFAULT one. Switching to another workspace changed the label and
   * nothing else: the sidebar kept listing the first workspace's chats while
   * the switcher said otherwise. opsFetch had this right; the raw fetches did
   * not, and there are more of them.
   *
   * It is a preference, not a grant: resolveOrgForIdentity honours it only for
   * a workspace the caller is actually a member of.
   */
  const getAuthHeaders = useCallback((): Record<string, string> => {
    if (!tokenRef.current) return {};
    const headers: Record<string, string> = { Authorization: `Bearer ${tokenRef.current}` };
    try {
      const org = readStored(STORAGE_KEYS.activeOrg);
      if (org) headers["x-ops-org"] = org;
    } catch {
      /* private mode — the server falls back to the default workspace */
    }
    return headers;
  }, []);

  const applyToken = useCallback((credential: string) => {
    const claims = decodeJwt(credential);
    /**
     * Refuse a token the SERVER will refuse.
     *
     * A personal Google account has no `hd` claim and lib/ops-auth.ts rejects
     * it. The client stored it anyway, so the app looked signed in and then
     * 401'd on every single request — a blank console with no explanation,
     * which is exactly how it was reported. Better to say why at the door.
     *
     * The email-code path below is how these accounts get in, and it exists
     * precisely for them, so point at it rather than just refusing.
     */
    // Our OWN email-session tokens carry no `hd` and must not be caught by
    // this — they are the admitted path for exactly these accounts. Checking
    // this the wrong way round would have broken the only way a gmail invitee
    // can sign in.
    const isOurs = claims.kind === "email-session" || claims.iss === "delivered";
    if (!isOurs && !claims.hd) {
      setError(
        `${claims.email ?? "That account"} is a personal Google account, which Google sign-in cannot admit. ` +
          "If you were invited, use “Invited by email? Sign in with a code” below.",
      );
      removeStored(TOKEN_KEY);
      endSessionFrame();
      return;
    }
    tokenRef.current = credential;
    setToken(credential);
    setEmail(claims.email ?? null);
    setName(claims.name ?? null);
    setPicture(claims.picture ?? null);
    setError(null);
    // Persist so a page refresh restores the session instead of forcing re-login.
    writeStored(TOKEN_KEY, credential);
    // Drop the session a little before the token actually expires (~1h).
    if (expiryTimer.current) clearTimeout(expiryTimer.current);
    if (claims.exp) {
      const msLeft = claims.exp * 1000 - Date.now() - 60_000;
      expiryTimer.current = setTimeout(() => {
        tokenRef.current = null;
        setToken(null);
        removeStored(TOKEN_KEY);
        endSessionFrame();
      }, Math.max(msLeft, 0));
    }
  }, []);

  const signOut = useCallback(() => {
    // Desktop notifications: this device stops receiving the person's notifications. Asked BEFORE the sign-in is
    // dropped — the server needs it to know whose device row to delete — and not waited for.
    void forgetThisDevice(getAuthHeaders());
    clearDesktopPrefs();
    forgetQueueCache();
    window.google?.accounts.id.disableAutoSelect();
    restoredRef.current = false;
    tokenRef.current = null;
    setToken(null);
    setEmail(null);
    setName(null);
    setPicture(null);
    // Both spellings: a sign-out that cleared only the new key would leave a live
    // token under the old one, and the next load would silently restore it.
    removeStored(TOKEN_KEY);
    endSessionFrame();
    // Queued messages and owed deliveries are one person's (lib/chat-queue):
    // on a shared machine they must not survive into the next sign-in.
    try {
      clearAllPending(window.localStorage, window.sessionStorage);
    } catch {
      /* no storage to clear */
    }
  }, []);

  // Coming back from the redirect flow: Google puts the id_token in the URL
  // fragment (never sent to a server). Verify the nonce round-tripped, adopt the
  // token, then scrub the fragment so it can't leak via history or a copied URL.
  useEffect(() => {
    if (!window.location.hash.includes("id_token=")) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const idToken = params.get("id_token");
    history.replaceState(null, "", window.location.pathname + window.location.search);
    if (!idToken) return;
    const expected = readStored(NONCE_KEY, "session");
    removeStored(NONCE_KEY, "session");
    if (expected && decodeJwt(idToken).nonce !== expected) {
      setError("Sign-in could not be verified. Please try again.");
      return;
    }
    restoredRef.current = true; // don't re-prompt One Tap over a fresh session
    applyToken(idToken);
  }, [applyToken]);

  // Restore a still-valid token across refreshes (before Google even loads).
  useEffect(() => {
    const stored = readStored(TOKEN_KEY);
    // Coming back from the redirect flow, the effect above has already adopted a fresh token.
    if (!stored) {
      if (!tokenRef.current) endSessionFrame();
      return;
    }
    const claims = decodeJwt(stored);
    if (claims.exp && claims.exp * 1000 > Date.now() + 60_000) {
      restoredRef.current = true;
      applyToken(stored);
    } else {
      removeStored(TOKEN_KEY);
      endSessionFrame();
    }
  }, [applyToken]);

  useEffect(() => {
    // Already signed in (fresh or restored from storage) — don't init/prompt.
    if (token || restoredRef.current) return;
    if (!CLIENT_ID) {
      setError("Google sign-in is not configured (NEXT_PUBLIC_GOOGLE_CLIENT_ID is unset).");
      return;
    }
    let cancelled = false;
    loadGis()
      .then(() => {
        if (cancelled || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: CLIENT_ID,
          callback: (r) => applyToken(r.credential),
          auto_select: true,
        });
        if (buttonRef.current) {
          // The real button is stacked INVISIBLE over our on-brand pill (the raw
          // GIS iframe chrome clashes with the page). Clicks fall through the
          // transparent overlay straight onto Google's button.
          window.google.accounts.id.renderButton(buttonRef.current, {
            theme: "outline",
            size: "large",
            text: "continue_with",
            width: 400,
          });
          setGisReady(true);
        }
        // One Tap only when there's no session at all.
        window.google.accounts.id.prompt();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Sign-in failed"));
    return () => {
      cancelled = true;
      if (expiryTimer.current) clearTimeout(expiryTimer.current);
    };
  }, [token, applyToken]);

  // Does this identity have a workspace? A verified work email with none is a
  // new signup and belongs in onboarding, not an empty console. Fail-safe: any
  // error leaves them in the app rather than trapping them in a redirect.
  useEffect(() => {
    if (!token) {
      setOrgState("unknown");
      return;
    }
    let alive = true;
    (async () => {
      try {
        /**
         * Redeem an invite BEFORE asking whether they have a workspace.
         *
         * The order was the bug, and it made invites impossible to accept. An
         * invitee has no workspace until they redeem, so the check below sent
         * them to /onboard — which drops the ?invite= parameter — and the
         * redemption code lived in ChatShell, which they therefore never
         * reached. They ended up creating their own org instead of joining the
         * one that invited them, and nothing reported a failure.
         *
         * Best-effort: a bad or spent token must not block sign-in. The outcome
         * is handed to ChatShell through sessionStorage so it can say what
         * happened, since this component is about to unmount.
         */
        const invite = new URLSearchParams(window.location.search).get("invite");
        if (invite) {
          try {
            const r = await fetch("/api/ops/invites/accept", {
              method: "POST",
              headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ token: invite }),
            });
            const d = (await r.json().catch(() => null)) as
              | { orgId?: string; role?: string; error?: string }
              | null;
            writeStored(
              INVITE_RESULT_KEY,
              JSON.stringify(
                r.ok && d?.orgId
                  ? { kind: "ok", text: `You've joined the ${d.orgId} workspace as ${d.role}.` }
                  : { kind: "err", text: d?.error ?? "That invite couldn't be redeemed." },
              ),
              "session",
            );
          } catch {
            writeStored(
              INVITE_RESULT_KEY,
              JSON.stringify({ kind: "err", text: "Couldn't reach the server to redeem the invite." }),
              "session",
            );
          }
          // Drop the token from the URL either way — it is single-use and has no
          // business surviving in history or a shared screenshot.
          window.history.replaceState({}, "", window.location.pathname);
        }

        // The same read (same headers) the workspace switcher makes, and the <head> script started early: one request.
        const res = await sharedGet("/api/ops/orgs", getAuthHeaders());
        if (!res.ok) return alive && setOrgState("ok");
        const data = (await res.json()) as { items?: unknown[] };
        if (!alive) return;
        if (Array.isArray(data.items) && data.items.length === 0) {
          /**
           * No workspace — but an INVITEE has no workspace either, right up
           * until they accept, and sending them to self-serve onboarding is how
           * someone ends up creating their own org instead of joining the one
           * that invited them. That already happened once.
           *
           * The emailed link avoids it (redemption runs above, before this
           * check), but the link is not the only way in any more: someone can
           * now sign in with a code and arrive here with invites waiting and
           * nothing redeemed. So ask before redirecting.
           */
          const pending = await fetch("/api/ops/me/workspaces", {
            headers: { Authorization: `Bearer ${token}` },
          })
            .then((r) => (r.ok ? (r.json() as Promise<{ invites?: unknown[] }>) : null))
            .catch(() => null);
          if (!alive) return;
          if (pending?.invites?.length) {
            // Land them in the app, where the switcher lists what they can join.
            setOrgState("ok");
            return;
          }
          setOrgState("none");
          window.location.replace("/onboard");
        } else {
          setOrgState("ok");
        }
      } catch {
        if (alive) setOrgState("ok");
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, getAuthHeaders]);

  /**
   * Full-page redirect sign-in — the escape hatch when GIS can't work.
   *
   * The Google button needs a popup, an accounts.google.com iframe, and
   * third-party cookies; privacy/popup blockers kill all three SILENTLY, so the
   * button looks alive but nothing happens. This flow uses none of them: we
   * navigate to Google, it returns an id_token in the URL fragment, and the
   * server verifies it against Google's JWKS exactly as it does a GIS token.
   * The nonce (kept in sessionStorage) makes a replayed/injected token fail.
   */
  const signInRedirect = () => {
    if (!CLIENT_ID) return setError("Google sign-in is not configured.");
    const nonce = crypto.randomUUID();
    // private mode swallows this; the token is still signature-verified server-side
    writeStored(NONCE_KEY, nonce, "session");
    const p = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: window.location.origin,
      response_type: "id_token",
      scope: "openid email profile",
      nonce,
      prompt: "select_account",
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  };

  // Clicking our themed button when Google's overlaid button didn't paint (or
  // was clipped/blocked). Tries One Tap, and falls through to the redirect flow
  // whenever Google can't show it — so a blocker can't leave the user stuck.
  const signInFallback = () => {
    const gid = window.google?.accounts.id;
    if (!gid) return signInRedirect();
    setError(null);
    gid.prompt((n) => {
      if (n.isNotDisplayed() || n.isSkippedMoment()) signInRedirect();
    });
  };

  if (token) {
    // A verified work identity with NO workspace is a brand-new signup — send
    // them to self-serve onboarding instead of an empty console. (Invitees get a
    // membership when they accept, so they land straight in the app.)
    if (orgState === "none") {
      return (
        <main className="flex h-dvh flex-col items-center justify-center gap-3 bg-background text-foreground">
          <Spinner />
          <p className="text-muted-foreground text-sm">Setting up your workspace…</p>
        </main>
      );
    }
    return (
      <ChatShell
        getAuthHeaders={getAuthHeaders}
        email={email}
        name={name}
        picture={picture}
        onSignOut={signOut}
      />
    );
  }

  return (
    // The sign-in card keeps its indentation inside the fragment on purpose: deployments' branding overlays match
    // its markup (the brand mark, the tagline) verbatim.
    <>
    <SessionFrame />
    <main data-signed-out className="relative flex h-dvh flex-col items-center justify-center overflow-hidden bg-background px-6 text-foreground">
      {/* Quiet backdrop: one radial wash + a faint grid, nothing animated. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% -10%, color-mix(in oklab, var(--foreground) 7%, transparent), transparent)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.025]"
        style={{
          backgroundImage:
            "linear-gradient(var(--foreground) 1px, transparent 1px), linear-gradient(90deg, var(--foreground) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(ellipse 70% 45% at 50% 0%, black 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse 70% 45% at 50% 0%, black 30%, transparent 75%)",
        }}
      />

      <div className="relative flex w-full max-w-sm flex-col items-center">
        {/* Brand mark — the same checkmark as the favicon. */}
        <span className="grid size-14 place-items-center rounded-2xl bg-foreground shadow-[0_8px_32px_-8px] shadow-foreground/25 ring-1 ring-foreground/10">
          <svg viewBox="0 0 32 32" className="size-8" fill="none" aria-hidden>
            <path
              d="M9 16.5L14 21.5L23.5 11"
              className="stroke-background"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <h1 className="mt-5 font-semibold text-3xl tracking-tight">{PRODUCT_NAME}</h1>
        <p className="mt-2 text-center text-muted-foreground text-sm leading-relaxed">
          {fillProfileText(DEPLOYMENT_PROFILE.product.tagline)}
        </p>

        {/* ONE control, and it is ours.
         *
         * This used to be a themed button with Google's own transparent button
         * overlaid on top, on the theory that Google's was the preferred path
         * and ours the fallback. Measured, that is backwards: the overlay is an
         * IFRAME, it sits over the pill's entire hit area, and it swallows every
         * click — so the fallback beneath it could never fire. Whenever the GIS
         * button failed inside that iframe (no Google session, FedCM disabled,
         * third-party cookies blocked — Safari's default), the result was a
         * button that looked perfect, did nothing at all, and offered no way
         * out. That is the single most expensive failure this page can have,
         * and it reported itself as "the button doesn't click".
         *
         * So: no overlay, and the pill goes straight to the OAuth redirect —
         * plain top-level navigation, no iframe, no FedCM, no third-party
         * cookies, nothing an ad blocker or a privacy mode can quietly break.
         * One Tap still runs on load for the returning-user convenience; it is
         * now strictly additive and can no longer block the deliberate click. */}
        <div className="group/btn relative mt-9 h-10 w-full overflow-hidden rounded-full">
            <button
              type="button"
              onClick={signInRedirect}
              disabled={false}
              className="flex h-full w-full cursor-pointer items-center justify-center gap-2.5 rounded-full border border-border bg-card font-medium text-foreground text-sm transition-colors duration-150 group-hover/btn:bg-muted"
            >
              <svg viewBox="0 0 48 48" className="size-4.5" aria-hidden>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              Continue with Google
            </button>
            {/* Google renders its own button in here for One Tap's benefit, but
                it must never intercept: pointer-events-none is the whole point
                of keeping it. Zero size so it cannot cover anything either.
                `invisible` + inert + aria-hidden, not opacity-0: an opacity-0
                button is still in the tab order and the accessibility tree, so a
                keyboard or screen-reader user landed on a Google button clipped
                to nothing — the responsiveness lane measured exactly that, at
                every viewport. visibility:hidden removes it from both. */}
            <div
              ref={buttonRef}
              inert
              aria-hidden="true"
              className="pointer-events-none invisible absolute size-0 overflow-hidden"
            />
        </div>
        {error ? (
          <p className="mt-3 w-full rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-destructive text-xs">
            {error}
          </p>
        ) : null}

        {/* The second door, for people Google cannot vouch for.
         *
         * Not a sign-up: the request route only sends a code to an address that
         * already holds an invite or a membership, so this is the way an INVITE
         * gets redeemed by someone on gmail.com or any domain without a Google
         * Workspace. Kept visually secondary to Google, which remains the path
         * for everyone with a work account. */}
        <EmailSignIn onToken={applyToken} />

        <p className="mt-3.5 text-center text-2xs text-muted-foreground">
          Work Google accounts sign in directly. Any other address needs an invite.
        </p>
      </div>

      {/* Footer — quiet, no dead links. */}
      <footer className="absolute inset-x-0 bottom-5 flex items-center justify-center gap-2 text-3xs text-muted-foreground/50">
        <span>© {new Date().getFullYear()} {PRODUCT_NAME}</span>
        <span aria-hidden>·</span>
        <span>By continuing you agree to your organization's usage policies.</span>
      </footer>
    </main>
    </>
  );
}
