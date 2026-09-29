/**
 * THE STARTUP READS, STARTED BEFORE THE APP'S JAVASCRIPT AND SHARED BY EVERYTHING THAT ASKS.
 *
 * A signed-in load used to ask the ops API for its lists only once every script had downloaded, run and hydrated,
 * and the sign-in state had been restored in an effect: on a phone (4x CPU, slow 4G) that is ten seconds of an idle
 * network before the first read. Two of the reads were also made twice (the account list by the shell and by the
 * starter cards; the workspace list by the sign-in gate and by the workspace switcher, the switcher's only after its
 * memberships had answered).
 *
 * So:
 *   - `startupScript()` is a few hundred bytes that run in <head>, before any bundle: when the browser holds an
 *     unexpired session it marks <html data-session> (the page paints the app's frame instead of the sign-in card,
 *     see app/globals.css) and, on the chat page, starts the reads in STARTUP_READS with the same headers the app
 *     would send;
 *   - `sharedGet()` hands a caller that early answer when it was made for the same person and workspace and is
 *     recent, and otherwise coalesces callers asking for the same read at the same moment into one request.
 *
 * Never a cache of record: an early answer is used once and only within EARLY_MAX_AGE_MS of being asked for, a
 * failed answer is never shared, and a read is shared only with callers asking within SHARE_MS of the first (or
 * while it is still in flight).
 */
import { LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "./browser-storage.ts";

/** What every signed-in first screen reads. Each is a GET the server answers per person (and workspace). */
export const STARTUP_READS = [
  "/api/ops/chat-sessions",
  "/api/ops/customers",
  "/api/ops/orgs",
  "/api/ops/me/workspaces",
  "/api/ops/threads",
] as const;

/** An early answer older than this was made for a page that has moved on; ask again. */
const EARLY_MAX_AGE_MS = 30_000;
/**
 * Callers asking for the same read within this long of the first share its answer (and any still in flight share
 * it until it lands). Long enough for the components of one first render; short enough that a refresh a person
 * causes (after joining a workspace, say) always asks again.
 */
const SHARE_MS = 1_500;

interface Answer {
  status: number;
  body: string;
}
interface EarlyRead {
  token: string;
  org: string | null;
  at: number;
  answer: Promise<Answer>;
}
declare global {
  interface Window {
    __startupReads?: Record<string, EarlyRead>;
  }
}

/**
 * The <head> script. Kept tiny and dependency-free, and wrapped whole in try/catch: anything that throws here would
 * blank the page. It decides "signed in" the way AuthGate's restore does (a stored token whose `exp` is more than a
 * minute away) and sends what `getAuthHeaders()` sends (the bearer and, when chosen, `x-ops-org` — this tab's
 * workspace, or the one a `?org=` link names, which the tab adopts here before anything else is read).
 */
export function startupScript(): string {
  const k = (key: string) => JSON.stringify(key);
  const token = `s.getItem(${k(STORAGE_KEYS.token)})||s.getItem(${k(LEGACY_STORAGE_KEYS[STORAGE_KEYS.token])})`;
  const orgKey = k(STORAGE_KEYS.activeOrg);
  // THIS TAB's workspace first (sessionStorage), then the default for new tabs (lib/browser-storage.ts readActiveOrg).
  const org = `(ss&&ss.getItem(${orgKey}))||s.getItem(${orgKey})||s.getItem(${k(LEGACY_STORAGE_KEYS[STORAGE_KEYS.activeOrg])})`;
  // A link that names its workspace (`?org=`: a notification, a shared thread, "open as chat") is adopted by THIS TAB
  // before the first reads go out, so the whole page loads in that workspace. Only a plausible id is taken; the
  // server still honours it only for a member (a guest of one shared chat reads that chat, nothing else). The
  // default for new tabs is not touched here: the page's switch (ops/lib switchWorkspace) sets it once the server
  // accepts the person as a member.
  const adopt =
    `var ss=null;try{ss=sessionStorage}catch(e){}` +
    `try{var q=new URLSearchParams(location.search).get('org');if(q&&ss&&/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(q))ss.setItem(${orgKey},q)}catch(e){}`;
  return (
    `try{var s=localStorage;${adopt}var t=${token};if(t){var c=JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));` +
    `if(c.exp&&c.exp*1000>Date.now()+60000){document.documentElement.setAttribute('data-session','');` +
    `var o=${org}||null,h={Authorization:'Bearer '+t},r=window.__startupReads={};if(o)h['x-ops-org']=o;` +
    `if(location.pathname==='/')${JSON.stringify(STARTUP_READS)}.forEach(function(u){r[u]={token:t,org:o,at:Date.now(),answer:fetch(u,{headers:h}).then(function(x){return x.text().then(function(b){return{status:x.status,body:b}})})}})}}}catch(e){}`
  );
}

const shared = new Map<string, { created: number; done: boolean; answer: Promise<Answer> }>();

function asResponse(a: Answer): Response {
  return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
}

/** The early read for `url`, if it was made for these headers and is recent; it is handed out once. */
function takeEarly(url: string, token: string, org: string | null): Promise<Answer> | null {
  if (typeof window === "undefined") return null;
  const early = window.__startupReads?.[url];
  if (!early) return null;
  delete window.__startupReads![url];
  if (early.token !== token || early.org !== org || Date.now() - early.at > EARLY_MAX_AGE_MS) return null;
  return early.answer;
}

/**
 * GET `url` with `headers`, answered by the <head> script's early read when it matches, or by a request another
 * caller already has in flight for the same person, workspace and url. A non-2xx answer is never shared: a caller
 * that retries gets a fresh request.
 */
export function sharedGet(url: string, headers: Record<string, string>): Promise<Response> {
  const auth = headers.Authorization ?? headers.authorization ?? "";
  const org = headers["x-ops-org"] ?? null;
  const key = `${url}\n${auth}\n${org ?? ""}`;
  const now = Date.now();
  const hit = shared.get(key);
  if (hit && (!hit.done || now - hit.created < SHARE_MS)) return hit.answer.then(asResponse);
  const answer =
    takeEarly(url, auth.replace(/^Bearer /, ""), org) ??
    fetch(url, { headers }).then(async (r) => ({ status: r.status, body: await r.text() }));
  const entry = { created: now, done: false, answer };
  shared.set(key, entry);
  const forget = () => {
    if (shared.get(key) === entry) shared.delete(key);
  };
  answer.then(
    (a) => {
      entry.done = true;
      if (a.status < 200 || a.status >= 300) forget();
    },
    forget,
  );
  return answer.then(asResponse);
}

export const isStartupRead = (path: string): boolean => (STARTUP_READS as readonly string[]).includes(path);
