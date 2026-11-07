/**
 * Health › Sign-in (mold_v0-270; molds/mold_v0/MOLD.md "Sign-in return addresses"): does every sign-in and connection
 * this app sends people through come back to its CURRENT front door (consoleUrl(): the app's own domain once it has
 * one)? After a move to its own domain, a provider still holding the old return address answers "redirect_uri_mismatch"
 * (Google) or "the redirect URL is not associated with the application" (GitHub), and nothing in the app said so.
 *
 * THE FLOWS (each only when this build uses it):
 *   clerk.domain        Clerk's instance accepts the front door (Backend API GET /v1/instance and /v1/domains with
 *                       CLERK_SECRET_KEY: the primary domain, a satellite or an allowed origin)
 *   clerk.<strategy>    each social connection Clerk has on (its Frontend API's public /v1/environment): Clerk's own
 *                       callback, <frontend api>/v1/oauth_callback, which the provider's client must list. Probed with an
 *                       anonymous sign-in attempt (what the sign-in page does on a click), whose answer is the provider's
 *                       authorize address with Clerk's client id and return address; that address is then opened.
 *   google              the built-in sign-in's Google (src/builtin-auth.ts): <front door>/api/auth/google/callback
 *   github_app.callback the platform's GitHub App (src/github-app.ts): <front door>/api/github-app/callback
 *   github_app.setup    the same app: its install comes back with the person's authorization (what the app needs)
 *   github_app.webhook  the same app: the webhook address GitHub holds (GET /app/hook/config with the app's own token)
 *   oauth.<pack>.<name> each credential OAuth provider with a client id in the key vault: <front door>/api/credential-connections/callback
 *   mcp                 AI clients' sign-in: they bring their own return addresses (nothing to register at a provider);
 *                       the check is that their sign-in is on the front door (built-in) or that Clerk lets them register
 *
 * THE ANSWERS: pass, fail or unknown, never a guess. Only an answer the provider gives BEFORE anyone signs in, in the
 * shapes measured (2026-11-07): Google's authorize address answers 302 to its sign-in pages for a listed address and 302
 * to /signin/oauth/error?authError=<base64 naming redirect_uri_mismatch> (or 400) for one it does not list; GitHub's
 * authorize address sends EVERY anonymous request to its sign-in page, a wrong return address and an unknown client id
 * alike (it checks the address only after a sign-in), so a probe alone says unknown for GitHub. What GitHub sends back is
 * evidence instead: a callback that came to an old address, or an error it sent back with a state this server signed
 * (noteCallback), is a fail; one that came to the front door is a pass. Anything not understood is unknown.
 *
 * WHEN: on demand from the tab (at most once a minute), and otherwise at most an hour old (signInReport). The factory
 * reads the same report with the cron secret (GET /api/cron/sign-in-check) at every check and deploy, and probes the
 * providers itself from the front door it is about to use (.claude/scripts/lib/sign_in_check.py).
 *
 * Never a secret in an answer or a log: the Clerk secret goes to Clerk's Backend API only, the GitHub App's own token to
 * GitHub only; client ids are public, and the staff answer shows only a short fingerprint of each.
 */
import { createHash } from "node:crypto";
import { authProvider } from "./auth-provider.js";
import { consoleUrl, mcpUrl, publicUrl } from "./console-url.js";
import { getDb } from "./db.js";
import { stateSigned } from "./oauth-state.js";
import { asPlatform } from "./tenant-scope.js";

export type SignInResult = "pass" | "fail" | "unknown";
export interface SignInFlow {
  id: string;
  label: string;
  provider: string;
  /** The exact address to register at the provider (null: nothing to register, e.g. AI clients). */
  redirect_uri: string | null;
  /** The front-door path the address is made of, so the factory can make it for another front door; null: not on it. */
  path: string | null;
  result: SignInResult;
  detail: string;
  /** Where to click, in one line, and the steps, click by click (the address on its own step). */
  where: string;
  steps: string[];
  /** A short fingerprint of the public client id (never the id itself in the staff answer). */
  client: string | null;
  /** Only in the factory's answer (the cron secret): the public client id and the provider's authorize address. */
  client_id?: string | null;
  authorize_url?: string | null;
}
export interface SignInReport {
  checked_at: string;
  front_door: string;
  front_door_since: string;
  flows: SignInFlow[];
  totals: Record<SignInResult, number>;
  next_check_at: string;
  /** Asked again within a minute of the last check: the last one is shown. */
  throttled?: boolean;
}

const HOUR = 3_600_000, MINUTE = 60_000;
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const E = { rewrite: null as ((url: string) => string) | null };
/** Clerk's Backend API: CLERK_API_URL as src/clerk.ts reads it (the test world's local mock), else Clerk's own. */
const clerkApi = () => (process.env.CLERK_API_URL ?? "https://api.clerk.com").replace(/\/$/, "");
/**
 * Tests only: every request this module makes goes to `rewrite(url)` instead (the providers' own addresses mapped to
 * stand-in servers on 127.0.0.1), while answers are read against the address asked for, as in production.
 */
export function setSignInEndpointsForTest(e: { rewrite?: ((url: string) => string) | null }) { E.rewrite = e.rewrite ?? null; }

export const fingerprint = (id: string | null | undefined) => (id ? createHash("sha256").update(id.trim()).digest("hex").slice(0, 12) : null);
const origin = (u: string) => { try { return new URL(u).origin; } catch { return ""; } };
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

// ---------------------------------------------------------------- HTTP: GETs and one anonymous POST, never followed blindly

interface Answer { status: number; location: string | null; body: string; cookies: string[] }
async function ask(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  try {
    const r = await fetch(E.rewrite ? E.rewrite(url) : url, { method: init.method ?? "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": BROWSER_UA, accept: "text/html,application/json", ...(init.headers ?? {}) }, body: init.body });
    const text = (await r.text()).slice(0, 400_000);
    const loc = r.headers.get("location");
    return { status: r.status, location: loc ? new URL(loc, url).toString() : null, body: text,
      cookies: typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [] };
  } catch { return { status: 0, location: null, body: "", cookies: [] }; }
}
const json = (a: Answer): Record<string, unknown> | null => { try { const j = JSON.parse(a.body); return j && typeof j === "object" ? j as Record<string, unknown> : null; } catch { return null; } };

// ---------------------------------------------------------------- the classifiers (the same rules as the factory's)

export interface Probe { result: SignInResult; detail: string }
const b64 = (s: string) => { try { return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1"); } catch { return ""; } };

/** Google's authorize address with this client and return address: listed, not listed, or not understood. */
export async function probeGoogle(authorizeUrl: string): Promise<Probe> {
  const a = await ask(authorizeUrl);
  if (a.status === 0) return { result: "unknown", detail: "Google could not be reached from the app" };
  if (/redirect_uri_mismatch/.test(a.body) && a.status >= 400) return { result: "fail", detail: "Google answered redirect_uri_mismatch: the address is not under the client's Authorized redirect URIs" };
  if (a.status >= 300 && a.status < 400 && a.location) {
    const to = new URL(a.location);
    if (to.host !== hostOf(authorizeUrl)) return { result: "unknown", detail: `Google sent the browser to another site (${to.host})` };
    const err = to.searchParams.get("authError");
    if (err || /\/error/.test(to.pathname)) {
      const said = b64(err ?? "");
      if (/redirect_uri_mismatch/.test(said)) return { result: "fail", detail: "Google answered redirect_uri_mismatch: the address is not under the client's Authorized redirect URIs" };
      if (/invalid_client|deleted_client|OAuth client was not found/.test(said)) return { result: "fail", detail: "Google does not know this client id (invalid_client): the app's client was deleted or the id is wrong" };
      return { result: "unknown", detail: "Google refused for a reason other than the address" };
    }
    if (/^\/(v\d+\/signin|signin|o\/oauth2|ServiceLogin|AccountChooser|InteractiveLogin)/.test(to.pathname)) return { result: "pass", detail: "Google lists the address: it goes on to its sign-in page" };
  }
  return { result: "unknown", detail: `Google's answer was not understood (HTTP ${a.status})` };
}

/** GitHub's authorize address: a mismatch it says before a sign-in, else unknown (it checks the address after one). */
export async function probeGithub(authorizeUrl: string): Promise<Probe & { app?: string | null }> {
  const a = await ask(authorizeUrl);
  if (a.status === 0) return { result: "unknown", detail: "GitHub could not be reached from the app" };
  const notAssociated = (t: string) => /not associated with (this|the) application|redirect_uri_mismatch/i.test(t);
  if (a.status >= 300 && a.status < 400 && a.location) {
    const to = new URL(a.location);
    if (to.searchParams.get("error") === "redirect_uri_mismatch") return { result: "fail", detail: "GitHub sent the browser back with redirect_uri_mismatch: the address is not the app's Callback URL" };
    if (to.host === hostOf(authorizeUrl) && to.pathname === "/login") {
      const page = await ask(to.toString());
      if (notAssociated(page.body)) return { result: "fail", detail: "GitHub says the redirect URL is not associated with the application" };
      const m = /to continue to\s*<strong>([^<]{1,100})<\/strong>/.exec(page.body);
      return m
        ? { result: "unknown", app: m[1]!.trim(), detail: `GitHub knows the app (${m[1]!.trim()}), but it checks the Callback URL only after someone signs in` }
        : { result: "unknown", app: null, detail: "GitHub did not name an app for this client id (check the client id); it checks the Callback URL only after someone signs in" };
    }
    return { result: "unknown", detail: "GitHub sent the browser somewhere not understood" };
  }
  if (notAssociated(a.body)) return { result: "fail", detail: "GitHub says the redirect URL is not associated with the application" };
  return { result: "unknown", detail: `GitHub's answer was not understood (HTTP ${a.status})` };
}

/** Any other provider: only an answer that names the return address as wrong is a fail; nothing here is a pass. */
export async function probeGeneric(authorizeUrl: string, redirectUri: string): Promise<Probe> {
  const a = await ask(authorizeUrl);
  if (a.status === 0) return { result: "unknown", detail: "the provider could not be reached from the app" };
  if (a.location) {
    const to = new URL(a.location);
    const e = `${to.searchParams.get("error") ?? ""} ${to.searchParams.get("error_description") ?? ""}`;
    if (/redirect_uri_mismatch|invalid_redirect_uri|redirect_uri.*(not|invalid|match)/i.test(e)) return { result: "fail", detail: `the provider sent the browser back with ${to.searchParams.get("error")}: the address is not registered` };
    if (origin(to.toString()) === origin(redirectUri) && to.searchParams.get("error")) return { result: "unknown", detail: `the provider sent back ${to.searchParams.get("error")}` };
  }
  if (a.status >= 400 && /redirect_uri_mismatch|invalid_redirect_uri|AADSTS50011|redirect[ _]ur[il][^<]{0,80}(not (registered|valid|allowed|associated)|does not match|mismatch|invalid)/i.test(a.body))
    return { result: "fail", detail: "the provider says the return address is not registered" };
  return { result: "unknown", detail: `the provider's answer was not understood (HTTP ${a.status}); it may check the address only after a sign-in` };
}

const classify = (provider: string, authorizeUrl: string, redirectUri: string) =>
  provider === "google" || /(^|\.)accounts\.google\.com$/.test(hostOf(authorizeUrl)) ? probeGoogle(authorizeUrl)
    : provider === "github" || hostOf(authorizeUrl) === "github.com" ? probeGithub(authorizeUrl) : probeGeneric(authorizeUrl, redirectUri);

// ---------------------------------------------------------------- where to click (AGENTS.md "Asking the operator for something")

export const GOOGLE_WHERE = "Google Cloud Console → APIs & Services → Credentials → the OAuth client → Authorized redirect URIs";
export const GITHUB_APP_WHERE = "GitHub → Settings → Developer settings → GitHub Apps → the app → Callback URL";
export const CLERK_DOMAINS_WHERE = "Clerk dashboard → Configure → Domains";
export const CLERK_SSO_WHERE = "Clerk dashboard → Configure → SSO connections";

export function googleSteps(uri: string, viaClerk: boolean): string[] {
  return [
    "Open https://console.cloud.google.com/apis/credentials and sign in with the Google account that owns the app's sign-in.",
    "At the top of the page, pick the project the sign-in belongs to (if you see only one, that is it).",
    viaClerk ? "Under \"OAuth 2.0 Client IDs\", click the client whose Client ID Clerk shows (Clerk dashboard → Configure → SSO connections → Google)."
      : "Under \"OAuth 2.0 Client IDs\", click the entry whose type is \"Web application\".",
    "Under \"Authorized redirect URIs\", click \"Add URI\" and paste this exactly:", `    ${uri}`,
    "Click \"Save\" at the bottom. Google can take up to five minutes to apply it.",
  ];
}
export function githubSteps(uri: string, viaClerk: boolean): string[] {
  return viaClerk ? [
    "Open https://github.com/settings/developers (for an organization's app: the organization's Settings → Developer settings) and sign in.",
    "Click the OAuth app or GitHub App whose Client ID Clerk shows (Clerk dashboard → Configure → SSO connections → GitHub).",
    "Set \"Authorization callback URL\" (an OAuth app) or the first \"Callback URL\" (a GitHub App) to exactly:", `    ${uri}`,
    "Click \"Update application\" (or \"Save changes\").",
  ] : [
    "Open https://github.com/settings/apps (for an organization's app: https://github.com/organizations/<the organization>/settings/apps) and sign in.",
    "Click \"Edit\" next to the app this platform uses.",
    "Under \"Callback URL\", click \"Add Callback URL\" (or change the first one) and paste this exactly:", `    ${uri}`,
    "Keep \"Request user authorization (OAuth) during installation\" ticked.",
    "Click \"Save changes\" at the bottom.",
  ];
}

// ---------------------------------------------------------------- the flows

const flow = (f: Omit<SignInFlow, "client"> & { client?: string | null }): SignInFlow => ({ client: null, ...f });

/** Clerk: the instance accepts the front door, and each social connection's client lists Clerk's own callback. */
async function clerkFlows(front: string, factory: boolean): Promise<SignInFlow[]> {
  const { frontendApi } = await import("./clerk.js");
  const fapi = frontendApi();
  const sk = process.env.CLERK_SECRET_KEY ?? "";
  const out: SignInFlow[] = [];
  const auth = { authorization: `Bearer ${sk}`, accept: "application/json" };
  const [inst, doms] = sk ? await Promise.all([ask(`${clerkApi()}/v1/instance`, { headers: auth }), ask(`${clerkApi()}/v1/domains`, { headers: auth })]) : [null, null];
  const instance = inst && inst.status === 200 ? json(inst) : null;
  const domains = doms && doms.status === 200 ? ((json(doms)?.data as Record<string, unknown>[] | undefined) ?? []) : null;
  const env = String(instance?.environment_type ?? (/^pk_test_/.test(process.env.CLERK_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "") ? "development" : "production"));
  const host = hostOf(front);
  const names = (domains ?? []).map((d) => String(d.name ?? "")).filter(Boolean);
  const allowed = Array.isArray(instance?.allowed_origins) ? (instance!.allowed_origins as unknown[]).map(String) : [];
  const covered = names.some((n) => host === n || host.endsWith(`.${n}`)) || allowed.some((o) => origin(o) === origin(front));
  const domainSteps = [
    "Open https://dashboard.clerk.com and sign in.",
    `Click the application this app signs people in with${fapi ? ` (its sign-in address is ${hostOf(fapi)})` : ""}; if there is a Development / Production switch at the top, pick Production.`,
    "Click Configure in the menu along the top, then Domains on the left.",
    `Either change the primary domain to ${host.split(".").slice(-2).join(".")}, or click "Add satellite domain" and type ${host}; then add the DNS records Clerk lists at the company where the domain is registered.`,
    "Wait until Clerk shows the domain as verified (a few minutes up to an hour).",
  ];
  out.push(flow({ id: "clerk.domain", label: "Clerk: the app's address", provider: "clerk", redirect_uri: front, path: "", where: CLERK_DOMAINS_WHERE, steps: domainSteps,
    ...(!sk ? { result: "unknown" as const, detail: "the API has no Clerk secret key, so Clerk's settings could not be read" }
      : instance === null || domains === null ? { result: "unknown" as const, detail: `Clerk's Backend API did not answer (HTTP ${inst?.status ?? 0}, ${doms?.status ?? 0})` }
      : env === "development" ? { result: "pass" as const, detail: "a development instance: it accepts any address" }
      : covered ? { result: "pass" as const, detail: `Clerk's instance holds ${host} (${names.filter((n) => host === n || host.endsWith(`.${n}`))[0] ?? "an allowed origin"})` }
      : { result: "fail" as const, detail: `Clerk's instance is for ${names.join(", ") || "another domain"}, not ${host}: sign-in there is refused` }) }));
  if (!fapi) return out;
  const callback = `${fapi}/v1/oauth_callback`;
  const envAns = await ask(`${fapi}/v1/environment?_clerk_js_version=5`, { headers: { origin: front, accept: "application/json" } });
  const social = (json(envAns)?.user_settings as { social?: Record<string, { enabled?: boolean; strategy?: string; name?: string }> } | undefined)?.social;
  if (!social) {
    out.push(flow({ id: "clerk.social", label: "Clerk: social sign-ins", provider: "clerk", redirect_uri: callback, path: null, where: CLERK_SSO_WHERE, steps: [],
      result: "unknown", detail: `Clerk's public settings could not be read (HTTP ${envAns.status}), so which social sign-ins are on is not known` }));
    return out;
  }
  const dev = env === "development";
  for (const [key, s] of Object.entries(social)) {
    if (!s?.enabled) continue;
    const strategy = String(s.strategy ?? key);
    const provider = strategy.replace(/^oauth_/, "");
    const name = s.name ?? provider;
    const creds = dev ? "Clerk's shared development credentials unless custom ones are set" : "custom credentials (a production instance always uses its own)";
    const probe = await clerkAttempt(fapi, front, strategy, dev);
    let p: Probe = probe.url ? await classify(provider, probe.url, callback) : { result: probe.refused ? "fail" : "unknown", detail: probe.why };
    if (dev && p.result === "unknown" && !probe.url) p = { result: "unknown", detail: `${probe.why}; ${creds}` };
    out.push(flow({ id: `clerk.${strategy}`, label: `${name} (through Clerk)`, provider, redirect_uri: callback, path: null,
      where: provider === "google" ? `${GOOGLE_WHERE} (the client Clerk uses)` : provider === "github" ? "GitHub → Settings → Developer settings → the app Clerk uses → Authorization callback URL" : `${name}'s developer console → the OAuth app Clerk uses → redirect URIs`,
      steps: provider === "google" ? googleSteps(callback, true) : provider === "github" ? githubSteps(callback, true)
        : [`Open ${name}'s developer console and the OAuth app whose client id Clerk shows (${CLERK_SSO_WHERE} → ${name}).`, "Add this as an allowed redirect (callback) address:", `    ${callback}`, "Save."],
      result: p.result, detail: `${p.detail} (Clerk's callback, ${creds})`, client: probe.client ? fingerprint(probe.client) : null,
      ...(factory ? { client_id: probe.client, authorize_url: null } : {}) }));
  }
  return out;
}

/**
 * An anonymous sign-in attempt at Clerk's Frontend API (what its sign-in page does when someone clicks the button):
 * the provider's authorize address, with Clerk's client id and return address, or why there is none. Nobody signs in.
 */
async function clerkAttempt(fapi: string, front: string, strategy: string, dev: boolean): Promise<{ url: string | null; client: string | null; refused: boolean; why: string }> {
  const q = new URLSearchParams({ _clerk_js_version: "5" });
  const headers: Record<string, string> = { origin: front, accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
  if (dev) {
    const db = await ask(`${fapi}/v1/dev_browser`, { method: "POST", headers: { origin: front, accept: "application/json" } });
    const tok = json(db)?.token ?? json(db)?.id;
    if (typeof tok === "string") q.set("__clerk_db_jwt", tok);
  }
  const first = await ask(`${fapi}/v1/client?${q}`, { headers: { origin: front, accept: "application/json" } });
  const cookie = first.cookies.map((c) => c.split(";")[0]).filter((c) => /^__client=/.test(c ?? "")).join("; ");
  const a = await ask(`${fapi}/v1/client/sign_ins?${q}`, { method: "POST", headers: { ...headers, ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams({ strategy, redirect_url: `${front}/sso-callback`, action_complete_redirect_url: `${front}/` }).toString() });
  const j = json(a);
  const ext = ((j?.response as { first_factor_verification?: { external_verification_redirect_url?: unknown } } | undefined)?.first_factor_verification?.external_verification_redirect_url);
  if (a.status === 200 && typeof ext === "string" && /^https?:\/\//.test(ext)) {
    let client: string | null = null;
    try { client = new URL(ext).searchParams.get("client_id"); } catch { client = null; }
    return { url: ext, client, refused: false, why: "" };
  }
  const errs = Array.isArray(j?.errors) ? (j!.errors as { code?: string; message?: string; long_message?: string; meta?: { param_name?: string } }[]) : [];
  const said = errs.map((e) => `${e.code ?? ""} ${e.meta?.param_name ?? ""} ${e.long_message ?? e.message ?? ""}`).join("; ");
  if (a.status >= 400 && /redirect_url|origin/i.test(said)) return { url: null, client: null, refused: true, why: `Clerk refused a sign-in started on ${hostOf(front)} (${errs[0]?.code ?? a.status})` };
  return { url: null, client: null, refused: false, why: `Clerk did not start a sign-in (HTTP ${a.status}${errs[0]?.code ? `, ${errs[0].code}` : ""})` };
}

/** The built-in sign-in's Google button. */
async function googleFlow(front: string, factory: boolean): Promise<SignInFlow | null> {
  const { googlePublic, googleRedirectFor } = await import("./builtin-auth.js");
  const g = googlePublic();
  if (!g) return null;
  const uri = googleRedirectFor(front);
  const q = new URLSearchParams({ client_id: g.clientId, redirect_uri: uri, response_type: "code", scope: "openid email profile", state: "address-check", prompt: "select_account" });
  const p = await probeGoogle(`${g.authUrl}?${q}`);
  return flow({ id: "google", label: "Google (the app's own sign-in)", provider: "google", redirect_uri: uri, path: process.env.GOOGLE_REDIRECT_URI ? null : "/api/auth/google/callback",
    where: GOOGLE_WHERE, steps: googleSteps(uri, false), result: p.result, detail: p.detail, client: fingerprint(g.clientId),
    ...(factory ? { client_id: g.clientId, authorize_url: g.authUrl } : {}) });
}

interface Seen { at: string; origin: string; error?: string | null; authorized?: boolean }
interface Callbacks { ok?: Seen; error?: Seen; last?: Seen }
/** What came back at a return address, since the front door has been what it is now. */
function judgeSeen(seen: Callbacks | null, front: string, since: string): Probe | null {
  if (!seen) return null;
  const fresh = (s?: Seen) => (s && s.at >= since ? s : undefined);
  const err = fresh(seen.error), last = fresh(seen.last);
  if (err && /redirect_uri/.test(err.error ?? "") && (!seen.ok || seen.ok.at <= err.at || seen.ok.origin !== origin(front)))
    return { result: "fail", detail: `the provider sent someone back with ${err.error} at ${err.at.slice(0, 16).replace("T", " ")} UTC: it does not hold this address` };
  if (last && last.origin !== origin(front))
    return { result: "fail", detail: `the provider sent someone back to ${last.origin} at ${last.at.slice(0, 16).replace("T", " ")} UTC, not to ${origin(front)}: it still holds the old address` };
  if (last && last.origin === origin(front)) return { result: "pass", detail: `someone came back here at ${last.at.slice(0, 16).replace("T", " ")} UTC: the provider holds this address` };
  return null;
}

/** The platform's GitHub App: its callback (and the install's return with authorization) and its webhook. */
async function githubAppFlows(front: string, since: string, seen: (k: string) => Promise<Callbacks | null>, factory: boolean): Promise<SignInFlow[]> {
  const { appPublic, appHookUrl } = await import("./github-app.js");
  const gh = await appPublic();
  if (!gh) return [];
  const uri = `${front}/api/github-app/callback`;
  const q = new URLSearchParams({ client_id: gh.clientId, redirect_uri: uri });
  const probe = await probeGithub(`${gh.web}/login/oauth/authorize?${q}`);
  const cb = await seen("github_app");
  const evidence = judgeSeen(cb, front, since);
  const p = probe.result === "fail" ? probe : evidence ?? probe;
  const out: SignInFlow[] = [flow({ id: "github_app.callback", label: "GitHub App: callback", provider: "github", redirect_uri: uri, path: "/api/github-app/callback",
    where: GITHUB_APP_WHERE, steps: githubSteps(uri, false), result: p.result, detail: p.detail, client: fingerprint(gh.clientId),
    ...(factory ? { client_id: gh.clientId, authorize_url: `${gh.web}/login/oauth/authorize` } : {}) })];
  const last = cb?.last && cb.last.at >= since ? cb.last : undefined;
  out.push(flow({ id: "github_app.setup", label: "GitHub App: install returns with authorization", provider: "github", redirect_uri: uri, path: "/api/github-app/callback",
    where: "GitHub → Settings → Developer settings → GitHub Apps → the app → Identifying and authorizing users",
    steps: ["Open https://github.com/settings/apps and click \"Edit\" next to the app this platform uses.",
      "Tick \"Request user authorization (OAuth) during installation\" (the Setup URL is then not used; leave it empty or set it to the same address):", `    ${uri}`,
      "Click \"Save changes\"."],
    ...(last?.authorized === true ? { result: "pass" as const, detail: "the last install came back with the person's authorization, as the app needs" }
      : last?.authorized === false ? { result: "fail" as const, detail: "the last install came back without the person's authorization: \"Request user authorization (OAuth) during installation\" is off, so connecting fails" }
      : { result: "unknown" as const, detail: "no install has come back since the address was last changed" }) }));
  const hook = await appHookUrl();
  const want = `${publicUrl()}/api/github-app/webhook`;
  out.push(flow({ id: "github_app.webhook", label: "GitHub App: webhook", provider: "github", redirect_uri: want, path: null,
    where: "GitHub → Settings → Developer settings → GitHub Apps → the app → Webhook URL",
    steps: ["Open https://github.com/settings/apps and click \"Edit\" next to the app this platform uses.", "Under \"Webhook\", keep \"Active\" ticked and set \"Webhook URL\" to exactly:", `    ${want}`, "Click \"Save changes\"."],
    ...(!hook || hook.url === null ? { result: "unknown" as const, detail: `GitHub did not say which webhook address it holds (HTTP ${hook?.status ?? 0})` }
      : hook.url.replace(/\/$/, "") === want ? { result: "pass" as const, detail: "GitHub sends the app's events to this address" }
      : { result: "fail" as const, detail: `GitHub sends the app's events to ${hook.url}, not here: uninstalls and repository changes are missed` }) }));
  return out;
}

/** Credential fields connected through OAuth: each provider with a client id in the key vault. */
async function connectionFlows(front: string, since: string, seen: (k: string) => Promise<Callbacks | null>, factory: boolean): Promise<SignInFlow[]> {
  const { oauthProviders, publicClientId } = await import("./oauth-connections.js");
  const out: SignInFlow[] = [];
  const uri = `${front}/api/credential-connections/callback`;
  for (const p of oauthProviders()) {
    const id = await publicClientId(p).catch(() => null);
    if (!id) continue;
    const u = new URL(p.authorize_url);
    for (const [k, v] of Object.entries(p.authorize_params ?? {})) u.searchParams.set(k, v);
    u.searchParams.set("response_type", "code"); u.searchParams.set("client_id", id); u.searchParams.set("redirect_uri", uri); u.searchParams.set("state", "address-check");
    if (p.scopes.length) u.searchParams.set("scope", p.scopes.join(p.scope_separator));
    const google = /(^|\.)accounts\.google\.com$/.test(u.host), github = u.host === "github.com";
    const probe = await classify(google ? "google" : github ? "github" : p.name, u.toString(), uri);
    const key = `oauth.${p.pack}.${p.name}`.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 120);
    const evidence = judgeSeen(await seen(key), front, since);
    const r = probe.result === "unknown" && evidence ? evidence : probe;
    out.push(flow({ id: key, label: `${p.label} (credential connection)`, provider: google ? "google" : github ? "github" : p.name, redirect_uri: uri, path: "/api/credential-connections/callback",
      where: google ? GOOGLE_WHERE : github ? "GitHub → Settings → Developer settings → the OAuth app → Authorization callback URL" : `${p.label}'s developer console → the OAuth app → redirect URIs`,
      steps: google ? googleSteps(uri, false) : [`Open ${p.label}'s developer settings and the OAuth app whose client id is in this app's key vault (Admin › Key vault).`, "Add this as an allowed redirect (callback) address:", `    ${uri}`, "Save."],
      result: r.result, detail: r.detail, client: fingerprint(id), ...(factory ? { client_id: id, authorize_url: p.authorize_url } : {}) }));
  }
  return out;
}

/** AI clients' sign-in on /mcp: their own return addresses; on the front door (built-in) or Clerk lets them register. */
async function mcpFlow(front: string): Promise<SignInFlow> {
  const base = { id: "mcp", label: "AI clients' sign-in (MCP)", provider: authProvider() === "clerk" ? "clerk" : "app", redirect_uri: null, path: "/mcp" };
  if (authProvider() === "clerk") {
    const { frontendApi } = await import("./clerk.js");
    const fapi = frontendApi();
    const a = fapi ? await ask(`${fapi}/.well-known/oauth-authorization-server`, { headers: { accept: "application/json" } }) : null;
    const j = a && a.status === 200 ? json(a) : null;
    const on = !!j && ((typeof j.registration_endpoint === "string" && /^https?:\/\//.test(j.registration_endpoint)) || j.client_id_metadata_document_supported === true);
    return flow({ ...base, where: "Clerk dashboard → Configure → OAuth applications → Settings",
      steps: ["Open https://dashboard.clerk.com and click the application this app signs people in with.", "Click Configure along the top, then OAuth applications on the left, then the Settings tab.",
        "Turn on Dynamic client registration (and Client ID Metadata Documents, if it is there).", "Click Save if a Save button appears."],
      ...(!j ? { result: "unknown" as const, detail: "Clerk's sign-in server did not say whether AI clients may register" }
        : on ? { result: "pass" as const, detail: "AI clients register their own return addresses with Clerk: nothing to add for them" }
        : { result: "fail" as const, detail: "Clerk lets no AI client register itself, so AI clients cannot sign in" }) });
  }
  const at = origin(mcpUrl()), want = origin(front);
  return flow({ ...base, where: "the factory: domain.py switch, then a redeploy",
    steps: ["In the factory folder run (it sets the address AI clients connect to, then the deploy applies it):", "    python3 .claude/scripts/domain.py <app> switch", "    python3 .claude/scripts/provision.py <app> --deploy"],
    ...(at === want ? { result: "pass" as const, detail: `AI clients sign in on ${want}/mcp and bring their own return addresses: nothing to add for them` }
      : { result: "fail" as const, detail: `AI clients are told to sign in at ${at}, not on the front door ${want}` }) });
}

// ---------------------------------------------------------------- the report: stored, at most an hour old, at most once a minute on demand

async function read(key: string): Promise<{ value: Record<string, unknown>; updated_at: Date } | null> {
  const [r] = await asPlatform(async () => (await getDb()).query<{ value: Record<string, unknown>; updated_at: Date }>(
    "/* tenant: internal: Health › Sign-in (staff) */ SELECT value, updated_at FROM sign_in_checks WHERE key = $1", [key]));
  return r ?? null;
}
async function write(key: string, value: unknown) {
  await asPlatform(async () => (await getDb()).query(
    `/* tenant: internal: Health › Sign-in (staff) */ INSERT INTO sign_in_checks (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, JSON.stringify(value)]));
}

/** Every flow, checked now, for `front` (the app's front door). `factory`: the factory's answer (public client ids too). */
export async function checkSignIn(front = consoleUrl(), since = new Date(0).toISOString(), factory = false): Promise<SignInFlow[]> {
  const seen = async (k: string) => ((await read(`callback:${k}`).catch(() => null))?.value as Callbacks | undefined) ?? null;
  const out: SignInFlow[] = [];
  if (authProvider() === "clerk") out.push(...await clerkFlows(front, factory));
  else { const g = await googleFlow(front, factory); if (g) out.push(g); }
  out.push(...await githubAppFlows(front, since, seen, factory).catch(() => []));
  out.push(...await connectionFlows(front, since, seen, factory).catch(() => []));
  out.push(await mcpFlow(front));
  return out;
}

const totals = (flows: SignInFlow[]) => ({ pass: flows.filter((f) => f.result === "pass").length, fail: flows.filter((f) => f.result === "fail").length, unknown: flows.filter((f) => f.result === "unknown").length });
const staffView = (r: SignInReport): SignInReport => ({ ...r, flows: r.flows.map(({ client_id: _c, authorize_url: _a, ...f }) => f) });

/**
 * The report: the stored one while it is under an hour old and for the same front door; `refresh` checks again, at most
 * once a minute (a second ask within the minute gets the last one, throttled). `factory`: with the public client ids.
 */
export async function signInReport(opts: { refresh?: boolean; factory?: boolean; now?: number } = {}): Promise<SignInReport> {
  const now = opts.now ?? Date.now(), front = consoleUrl();
  const stored = await read("report").catch(() => null);
  const last = stored?.value as unknown as SignInReport | undefined;
  const age = last ? now - +new Date(last.checked_at) : Infinity;
  const same = last?.front_door === front;
  if (last && same && (age < HOUR && !opts.refresh || opts.refresh && age < MINUTE))
    return opts.factory ? last : { ...staffView(last), ...(opts.refresh ? { throttled: true } : {}) };
  const since = same && last?.front_door_since ? last.front_door_since : new Date(now).toISOString();
  const flows = await checkSignIn(front, since, true);
  const report: SignInReport = { checked_at: new Date(now).toISOString(), front_door: front, front_door_since: since, flows, totals: totals(flows), next_check_at: new Date(now + HOUR).toISOString() };
  await write("report", report).catch((e) => console.error(`sign-in check: not stored (${(e as Error).message.slice(0, 120)})`));
  return opts.factory ? report : staffView(report);
}

/**
 * Note what came back at a return address (the callback routes call this before anything else): where it came to, when,
 * and the provider's error, only when the state is one this server signed for `purpose`. At most one write a minute per
 * flow and kind; never the code, the state, a person or the query.
 */
export async function noteCallback(flowKey: string, purpose: string, q: Record<string, unknown>, cameTo: string, authorized?: boolean) {
  const error = typeof q.error === "string" ? q.error.slice(0, 60).replace(/[^a-z_]/gi, "") : null;
  if (!stateSigned(q.state, purpose)) return;
  const key = `callback:${flowKey}`;
  const cur = ((await read(key).catch(() => null))?.value as Callbacks | undefined) ?? {};
  const at = new Date().toISOString();
  const s: Seen = { at, origin: origin(cameTo) || cameTo.slice(0, 200), ...(error ? { error } : {}), ...(authorized === undefined ? {} : { authorized }) };
  const prev = error ? cur.error : cur.last;
  if (prev && prev.origin === s.origin && Date.now() - +new Date(prev.at) < MINUTE && prev.authorized === s.authorized) return;
  const next: Callbacks = { ...cur, last: s, ...(error ? { error: s } : { ok: s }) };
  await write(key, next).catch(() => {});
}
