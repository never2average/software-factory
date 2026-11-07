/**
 * The early-access form and the sign-in pages' words, as platform staff edit them (mold_v0-266; molds/mold_v0/MOLD.md
 * "Early access and sign-in editor"). Two pages, each a row of access_pages (0055_access_pages) and its history in
 * access_page_changes: `request_form` (src/access-request.ts AccessFormConfig: every field of the request form, the
 * shell's own included, its submit button and thank-you words) and `sign_in` (SignInConfig: the sign-in and sign-up
 * pages' title, subtitle and button, a provider button's words, a legal line and the methods not shown).
 *
 * Nothing saved (or reset): config is NULL and every page is what the build declares, exactly as before this ticket (the
 * request API checks a request as it always did). Saved: the public pages (GET /api/access-pages) draw it at once, and
 * POST /api/access-requests checks each request against it (formSubmission). Each save is a new version, written with
 * who made it and the config before and after; a save names the version it edited, and one made meanwhile wins (409).
 *
 * Readers on the public path read an in-process copy at most 10 s old (a save here refreshes it at once), so another
 * instance's save lands within 10 s, without a redeploy.
 */
import { getDb, type Queryable } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { PackError } from "./pack-api.js";
import { accessFormProblems, formOf, labelFields, signInProblems, type AccessField, type AccessFormConfig, type SignInConfig } from "./access-request.js";
import { GENERATED_ACCESS_FIELDS } from "./access-request.generated.js";
import { builtinAuth } from "./auth-provider.js";
import { frontendApi } from "./clerk.js";

export const ACCESS_PAGE_IDS = ["request_form", "sign_in"] as const;
export type AccessPageId = (typeof ACCESS_PAGE_IDS)[number];
export const isAccessPageId = (v: unknown): v is AccessPageId => (ACCESS_PAGE_IDS as readonly unknown[]).includes(v);
type ConfigOf<P extends AccessPageId> = P extends "request_form" ? AccessFormConfig : SignInConfig;

export interface AccessPage<P extends AccessPageId = AccessPageId> {
  id: P;
  /** The version in force: 0 while nothing was ever saved. */
  version: number;
  /** What staff saved; null: the build's own defaults. */
  config: ConfigOf<P> | null;
  updated_by: string | null;
  updated_at: string | null;
}
export interface AccessPageChange {
  id: number; page_id: AccessPageId; version: number; action: "edited" | "reset"; changed_by: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; changed_at: string;
}

const read = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => fn(await getDb()));
const tx = <T>(fn: (q: Queryable) => Promise<T>) => asPlatform(async () => (await getDb()).transaction(fn));
type Row = { id: AccessPageId; version: number; config: Record<string, unknown> | null; updated_by: string | null; updated_at: Date | string | null };
const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const pageOf = (id: AccessPageId, r: Row | undefined): AccessPage =>
  r ? { id, version: r.version, config: (r.config ?? null) as AccessPage["config"], updated_by: r.updated_by, updated_at: iso(r.updated_at) }
    : { id, version: 0, config: null, updated_by: null, updated_at: null };

/** Both pages as they are in force (from the database). */
export async function readAccessPages(): Promise<Record<AccessPageId, AccessPage>> {
  const rows = await read((q) => q.query<Row>("SELECT id, version, config, updated_by, updated_at FROM access_pages"));
  return { request_form: pageOf("request_form", rows.find((r) => r.id === "request_form")), sign_in: pageOf("sign_in", rows.find((r) => r.id === "sign_in")) };
}

// ---------- the in-process copy the public path reads ----------

const TTL_MS = 10_000;
let cached: { at: number; pages: Record<AccessPageId, AccessPage> } | null = null;
let loading: Promise<Record<AccessPageId, AccessPage>> | null = null;
/** The pages in force, at most 10 s old. A database that cannot be read answers the defaults (nothing saved). */
export async function currentAccessPages(): Promise<Record<AccessPageId, AccessPage>> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.pages;
  loading ??= readAccessPages()
    .then((pages) => { cached = { at: Date.now(), pages }; return pages; })
    .catch((e) => { console.error("access pages: read failed:", (e as Error).message); return cached?.pages ?? { request_form: pageOf("request_form", undefined), sign_in: pageOf("sign_in", undefined) }; })
    .finally(() => { loading = null; });
  return loading;
}
/** The request form in force, or null: the build's own (POST /api/access-requests checks the way it always did). */
export const currentRequestForm = async () => (await currentAccessPages()).request_form.config as AccessFormConfig | null;
/** The fields that label a stored request's answers: the saved form's (and the build's it no longer has), else the build's. */
export const answerLabelFields = async (): Promise<AccessField[]> => labelFields(GENERATED_ACCESS_FIELDS, await currentRequestForm().catch(() => null));
/** What the public pages read (GET /api/access-pages): each page's saved config, null for the build's own. */
export async function publicAccessPages() {
  const p = await currentAccessPages();
  return { request_form: p.request_form.config, sign_in: p.sign_in.config };
}
/** Forget the in-process copy (a save does it; a test that writes the table directly too). */
export const forgetAccessPages = () => { cached = null; };

// ---------- staff: save, reset, history ----------

/** A config checked for its page. -> the config as stored (known keys only), or a 400 naming every problem. */
export function checkAccessPage(id: AccessPageId, config: unknown): AccessFormConfig | SignInConfig {
  const problems = id === "request_form" ? accessFormProblems(config) : signInProblems(config);
  if (problems.length) {
    const e = new PackError(problems.join("; ").slice(0, 2000), 400) as PackError & { problems?: string[] };
    e.problems = problems.slice(0, 50);
    throw e;
  }
  if (id === "request_form") return formOf(config as AccessFormConfig);
  const c = config as SignInConfig;
  const words = (w: SignInConfig["sign_in"]) => (w ? Object.fromEntries(Object.entries(w).filter(([, v]) => typeof v === "string" && v.trim())) : {});
  const out: SignInConfig = {};
  for (const page of ["sign_in", "sign_up"] as const) if (Object.keys(words(c[page])).length) out[page] = words(c[page]);
  if (c.social_button) out.social_button = c.social_button;
  if (c.legal) out.legal = { text: c.legal.text, ...(c.legal.terms_url ? { terms_url: c.legal.terms_url } : {}), ...(c.legal.privacy_url ? { privacy_url: c.legal.privacy_url } : {}) };
  if (c.hidden_methods?.length) out.hidden_methods = [...c.hidden_methods];
  return out;
}

const pageId = (id: unknown): AccessPageId => {
  if (!isAccessPageId(id)) throw new PackError(`no such page: ${String(id).slice(0, 40)} (request_form or sign_in)`, 404);
  return id;
};
const versionOf = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new PackError("version: the version you edited (a save is refused when someone saved a newer one meanwhile)", 400);
  return n;
};

/** The same value with every object's keys in order (JSONB keeps its own order), to compare two configs. */
const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, stable(x)])) : v);

/** Write a new version of a page (config null: back to the build's defaults), with its change. */
async function write(by: string, idIn: unknown, expectedIn: unknown, config: Record<string, unknown> | null, action: "edited" | "reset"): Promise<AccessPage> {
  const id = pageId(idIn), expected = versionOf(expectedIn);
  const who = String(by || "staff").slice(0, 200);
  await tx(async (q) => {
    await q.query("INSERT INTO access_pages (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [id]);
    const [r] = await q.query<Row>("SELECT id, version, config, updated_by, updated_at FROM access_pages WHERE id = $1 FOR UPDATE", [id]);
    if (r!.version !== expected) throw new PackError(`Someone saved version ${r!.version} of this page while you edited version ${expected}: open it again and redo your change`, 409);
    if (JSON.stringify(stable(r!.config ?? null)) === JSON.stringify(stable(config))) throw new PackError(action === "reset" ? "This page already shows the defaults" : "Nothing changed: this would save the same page again", 400);
    const v = r!.version + 1;
    await q.query("UPDATE access_pages SET version = $2, config = $3, updated_by = $4, updated_at = now() WHERE id = $1", [id, v, config === null ? null : JSON.stringify(config), who]);
    await q.query("INSERT INTO access_page_changes (page_id, version, action, changed_by, before, after) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, v, action, who, r!.config === null ? null : JSON.stringify(r!.config), config === null ? null : JSON.stringify(config)]);
  });
  forgetAccessPages();
  return (await readAccessPages())[id];
}

/** Staff: save a page (a new version). `input`: { version: the one edited, config }. */
export function saveAccessPage(by: string, id: unknown, input: { version?: unknown; config?: unknown }): Promise<AccessPage> {
  const page = pageId(id);
  return write(by, page, input?.version, checkAccessPage(page, input?.config) as unknown as Record<string, unknown>, "edited");
}
/** Staff: back to the build's own defaults (a new version whose config is null). */
export function resetAccessPage(by: string, id: unknown, input: { version?: unknown }): Promise<AccessPage> {
  return write(by, id, input?.version, null, "reset");
}
/** Every change of the pages, newest first (both, or one). */
export async function accessPageChanges(id?: AccessPageId, limit = 200): Promise<AccessPageChange[]> {
  const rows = await read((q) => q.query<AccessPageChange & { changed_at: Date | string }>(
    `SELECT id, page_id, version, action, changed_by, before, after, changed_at FROM access_page_changes ${id ? "WHERE page_id = $2" : ""} ORDER BY changed_at DESC, id DESC LIMIT $1`,
    id ? [limit, id] : [limit]));
  return rows.map((r) => ({ ...r, id: Number(r.id), changed_at: iso(r.changed_at)! }));
}

// ---------- the sign-in methods there are ----------

export interface SignInMethod { id: string; label: string; kind: "identifier" | "social" | "code"; hideable: boolean; note?: string }
export interface SignInMethods { provider: "builtin" | "clerk"; source: "clerk" | "shell"; methods: SignInMethod[]; note: string }

let clerkMethods: { at: number; value: SignInMethod[] | null } | null = null;
/**
 * The sign-in methods a person can be offered: under Clerk, what the Clerk instance has turned on (its Frontend API's
 * environment: the identifiers it asks, each social provider), else the shell's list; under the built-in sign-in, an
 * emailed code (always: lanes and local runs sign in with it) and Google when the server has a Google client. Only a
 * provider's button may be hidden here; which methods exist at all is the Clerk dashboard's.
 */
export async function signInMethods(): Promise<SignInMethods> {
  const { googleConfigured } = await import("./builtin-auth.js");
  const shell = (): SignInMethod[] => [
    { id: "email_code", label: "Emailed code", kind: "code", hideable: false, note: "Always shown: everyone can sign in with it." },
    { id: "google", label: "Google", kind: "social", hideable: true, ...(builtinAuth() && !googleConfigured() ? { note: "No Google client on this server yet: it is not shown either way." } : {}) },
  ];
  if (builtinAuth()) return { provider: "builtin", source: "shell", methods: shell(), note: "The built-in sign-in: an emailed code, and Google when the server has a Google client." };
  if (!clerkMethods || Date.now() - clerkMethods.at > 5 * 60_000) clerkMethods = { at: Date.now(), value: await readClerkMethods().catch(() => null) };
  return clerkMethods.value
    ? { provider: "clerk", source: "clerk", methods: clerkMethods.value, note: "What the Clerk instance has turned on. Turn methods on or off in the Clerk dashboard; here you choose which provider buttons show." }
    : { provider: "clerk", source: "shell", methods: shell(), note: "The Clerk instance's settings could not be read, so these are the shell's own methods. Turn methods on or off in the Clerk dashboard." };
}

/** Clerk's Frontend API environment (public, the same the sign-in widget loads): its first-factor identifiers and social providers. */
async function readClerkMethods(): Promise<SignInMethod[] | null> {
  const api = frontendApi();
  if (!api) return null;
  const r = await fetch(`${api}/v1/environment`, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
  if (!r.ok) return null;
  const env = (await r.json()) as { user_settings?: { attributes?: Record<string, { enabled?: boolean; used_for_first_factor?: boolean }>; social?: Record<string, { enabled?: boolean; name?: string; strategy?: string }> } };
  const us = env.user_settings;
  if (!us) return null;
  const LABEL: Record<string, string> = { email_address: "Email address", phone_number: "Phone number", username: "Username", web3_wallet: "Web3 wallet" };
  const out: SignInMethod[] = [];
  for (const [k, a] of Object.entries(us.attributes ?? {})) if (k in LABEL && a?.enabled && a.used_for_first_factor)
    out.push({ id: k, label: LABEL[k]!, kind: "identifier", hideable: false, note: "Asked in the sign-in form (turned on or off in the Clerk dashboard)." });
  for (const [k, s] of Object.entries(us.social ?? {})) if (s?.enabled && /^oauth_[a-z0-9_]{1,50}$/.test(k))
    out.push({ id: k, label: typeof s.name === "string" && s.name ? s.name.slice(0, 60) : k.slice(6).replace(/_/g, " "), kind: "social", hideable: true });
  return out;
}
