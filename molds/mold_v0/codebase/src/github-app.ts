/**
 * Repository access by a GitHub App per workspace (mold_v0-014; molds/mold_v0/MOLD.md "Repository access by a GitHub
 * App"). Instead of pasting a read-only token, a workspace's owners connect an installation of the platform's GitHub App;
 * a run that receives a credential field declared `github_app: true` gets a short-lived installation token minted for it.
 *
 *   the app        the platform's: its id, URL name, client id and secret, private key and webhook secret are one sealed
 *                  entry of the key vault (provider github_app, label "app"; set on /admin Key vault). Read here only, on
 *                  the server: no answer, run, session, log or error ever carries the private key or a secret.
 *   install        an owner asks for the install address (beginInstall): a one-time nonce (stored as its sha256, ten
 *                  minutes, for that workspace and person) inside a state signed with the app's client secret. GitHub
 *                  sends the browser back to the callback with the installation id, the state and a user-authorization
 *                  code (the app must "Request user authorization (OAuth) during installation"); completeInstall checks
 *                  the signature, the expiry, that the signed-in session is the same person in the same workspace and
 *                  may manage it, uses the nonce up, then proves that person can reach the installation (the code's user
 *                  token lists it in /user/installations; that token is revoked at once and never stored), that the
 *                  installation is of this app, and that no other workspace holds it. Without that proof any workspace
 *                  could claim another's installation by its number.
 *   runs           installationTokenForRun: a token per run and field, scoped to read-only contents of the installation's
 *                  repositories (or the ones an owner narrowed the run's asset record to), sealed with the workspace's
 *                  data key in run_github_app_tokens (so the run's output can be redacted of it), reused while it has more
 *                  than five minutes left, re-minted after. GitHub's answer is checked: a token with any permission but
 *                  read contents (and read metadata, which GitHub adds) is revoked and never delivered.
 *   revocation     a run's tokens are revoked when its attempt ends (src/gateway.ts revokeRunTokens marks them, then
 *                  flushRevocations asks GitHub to revoke each); the app's webhook (verified by the webhook secret)
 *                  ends a workspace's connection at once when the app is uninstalled, pauses it while suspended and keeps
 *                  the repository list current; a workspace's owners disconnect (the installation is uninstalled too),
 *                  staff revoke one from /admin, and removing a workspace (src/tenancy.ts) does the same.
 *   fallback       no app configured, or a workspace with no live installation: the field's pasted value is delivered
 *                  exactly as before (src/credentials.ts).
 *
 * Every table here is closed to tenant work (sql/migrations/0021_github_app.sql); the workspace is always the caller's
 * session's, the signed state's or the run row's, never an input.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, createSign, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { getDb, type Queryable } from "./db.js";
import { decrypt, encrypt } from "./keyvault.js";
import { openBytes, sealBytes } from "./orgcrypto.js";
import { CredentialSchema, PackError, RECORD_KEY } from "./pack-api.js";
import { packs } from "./packs.js";
import { asPlatform } from "./tenant-scope.js";
import type { Secret } from "./credential-redact.js";

export const GITHUB_APP_PROVIDER = "github_app";
const CONFIG_LABEL = "app";
/** What a run's token may do: read the repositories' contents (GitHub adds read metadata to every token). */
export const TOKEN_PERMISSIONS = { contents: "read" } as const;
const STATE_MINUTES = 10;
/** A cached token is handed out again only while it has more than this left. */
const REUSE_MARGIN_MS = 5 * 60_000;
const MAX_REPOS = 500;

// ---------- the packs' fields ----------

export interface GithubAppField { pack: string; name: string; label: string; bound_to: "workspace" | "asset" | "environment"; area: string | null }
let fieldCache: { from: unknown; list: GithubAppField[] } | null = null;
/** Every credential field the packs declare with `github_app: true`. None: nothing of this module is mounted. */
export function githubAppFields(): GithubAppField[] {
  const list = packs();
  if (fieldCache?.from === list) return fieldCache.list;
  fieldCache = { from: list, list: list.flatMap((p) => (p.definition.credentials ?? []).map((c) => CredentialSchema.parse(c))
    .filter((c) => c.github_app).map((c) => ({ pack: p.id, name: c.name, label: c.label, bound_to: c.bound_to, area: c.area ?? null }))) };
  return fieldCache.list;
}

// ---------- the app's configuration (key vault) ----------

export interface GithubAppConfig { app_id: string; slug: string; client_id: string; client_secret: string; private_key: string; webhook_secret: string }
const CONFIG_KEYS = ["app_id", "slug", "client_id", "client_secret", "private_key", "webhook_secret"] as const;
const SECRET_KEYS = new Set(["client_secret", "private_key", "webhook_secret"]);

/** Tokens the server itself uses for a workspace (an http_api repository's header): kept in memory until near expiry. */
const memo = new Map<number, { token: string; expires: number; installation: number }>();
/** GitHub's addresses: github.com unless a test points them at its stand-in. */
const endpoints = { api: "https://api.github.com", web: "https://github.com" };
/** Tests only (scripts/github-app-test.ts): GitHub's API and web addresses on a stand-in. */
export function setGithubEndpointsForTest(e: { api: string; web: string }) { endpoints.api = e.api.replace(/\/$/, ""); endpoints.web = e.web.replace(/\/$/, ""); }

async function readConfig(): Promise<Partial<GithubAppConfig>> {
  const [r] = await asPlatform(async () => (await getDb()).query<{ ciphertext: string; iv: string; tag: string; key_id: string }>(
    "SELECT ciphertext, iv, tag, key_id FROM vault_credentials WHERE provider = $1 AND label = $2 AND enabled", [GITHUB_APP_PROVIDER, CONFIG_LABEL]));
  if (!r) return {};
  try { return JSON.parse(decrypt(r)) as Partial<GithubAppConfig>; }
  catch { throw new PackError("the GitHub App's settings cannot be opened now (the key vault is locked?): try again", 503); }
}
/** The app's settings when every one of them is set, else null (the app is not configured: the fallback applies). */
export async function appConfig(): Promise<GithubAppConfig | null> {
  const c: Partial<GithubAppConfig> = await readConfig().catch((e) => { if (e instanceof PackError) throw e; return {}; });
  return CONFIG_KEYS.every((k) => typeof c[k] === "string" && c[k]!.length) ? (c as GithubAppConfig) : null;
}

let keyCache: { pem: string; key: KeyObject } | null = null;
const privateKey = (pem: string) => {
  if (keyCache?.pem === pem) return keyCache.key;
  keyCache = { pem, key: createPrivateKey(pem) };
  return keyCache.key;
};

/**
 * Set some or all of the app's settings (staff, /admin Key vault). Each is checked; an error never quotes a value. Only
 * what is given changes. Returns the summary (never a secret).
 */
export async function setAppConfig(input: Record<string, unknown>) {
  const now = await readConfig();
  const next: Partial<GithubAppConfig> = { ...now };
  for (const k of CONFIG_KEYS) {
    const v = input?.[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > 8192) throw new PackError(`${k}: text`, 400);
    const t = k === "private_key" ? v.replace(/\r\n/g, "\n").trim() + "\n" : v.trim();
    if (k === "app_id" && !/^[0-9]{1,12}$/.test(t)) throw new PackError("app_id: the App ID, digits (the app's General page on GitHub)", 400);
    if (k === "slug" && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(t)) throw new PackError("slug: the app's URL name (github.com/apps/<slug>), lowercase letters, digits and -", 400);
    if (k === "client_id" && !/^[A-Za-z0-9.]{8,64}$/.test(t)) throw new PackError("client_id: the Client ID on the app's General page", 400);
    if ((k === "client_secret" || k === "webhook_secret") && (t.length < 16 || /\s/.test(t))) throw new PackError(`${k}: at least 16 characters, no spaces`, 400);
    if (k === "private_key") {
      let ok = false;
      try { const key = createPrivateKey(t); ok = key.asymmetricKeyType === "rsa"; } catch { ok = false; }
      if (!ok) throw new PackError("private_key: the .pem file GitHub gave when you generated a private key (an RSA key)", 400);
    }
    next[k] = t;
  }
  const extra = Object.keys(input ?? {}).filter((k) => !(CONFIG_KEYS as readonly string[]).includes(k));
  if (extra.length) throw new PackError(`unknown setting ${extra[0]!.slice(0, 40)}`, 400);
  const enc = encrypt(JSON.stringify(next));
  const hint = `app ${next.app_id ?? "?"}${next.slug ? ` (${next.slug})` : ""}`;
  await asPlatform(async () => (await getDb()).query(
    `INSERT INTO vault_credentials (provider, label, ciphertext, iv, tag, key_id, hint, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
     ON CONFLICT (provider, label) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
       key_id = excluded.key_id, hint = excluded.hint, enabled = true, rotated_at = now()`,
    [GITHUB_APP_PROVIDER, CONFIG_LABEL, enc.ciphertext, enc.iv, enc.tag, enc.key_id, hint]));
  return configSummary();
}

/** What staff see of the settings: which are set, the public ones, a fingerprint of the key. Never a secret. */
export async function configSummary() {
  const c = await readConfig().catch(() => ({} as Partial<GithubAppConfig>));
  let fingerprint: string | null = null;
  if (c.private_key) {
    try { fingerprint = `SHA256:${createHash("sha256").update(createPublicKey(createPrivateKey(c.private_key)).export({ type: "spki", format: "der" })).digest("base64")}`; }
    catch { fingerprint = null; }
  }
  return {
    configured: CONFIG_KEYS.every((k) => !!c[k]),
    app_id: c.app_id ?? null, slug: c.slug ?? null, client_id: c.client_id ?? null,
    set: Object.fromEntries(CONFIG_KEYS.filter((k) => SECRET_KEYS.has(k)).map((k) => [k, !!c[k]])),
    // GitHub shows this beside the key on the app's page: staff can tell which key is held without seeing it.
    private_key_fingerprint: fingerprint,
  };
}

// ---------- GitHub's API ----------

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
/** The app's own JSON Web Token (RS256, nine minutes), signed with its private key. Never leaves this module but to GitHub. */
function appJwt(c: GithubAppConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iat: now - 60, exp: now + 540, iss: c.app_id }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey(c.private_key));
  return `${head}.${body}.${b64u(sig)}`;
}

class GithubError extends PackError {}
/** One call to GitHub. No redirects, 15 s. An error names the call and the status, never a token or a body. */
async function gh<T = unknown>(method: string, url: string, auth: string | null, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: T }> {
  let r: Response;
  try {
    r = await fetch(url, { method, redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "workspace-github-app",
        ...(auth ? { authorization: auth } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
  } catch { throw new GithubError(`GitHub could not be reached (${method} ${new URL(url).pathname.replace(/\/[0-9]+/g, "/:id")})`, 502); }
  const text = await r.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json: json as T };
}
const ok = (r: { status: number }, what: string) => { if (r.status < 200 || r.status >= 300) throw new GithubError(`GitHub refused ${what} (${r.status})`, 502); };

interface Repo { id: number; full_name: string }
interface MintedToken { token: string; expires_at: string; permissions: Record<string, string>; repositories: Repo[] }

/** An installation token: the permissions and repositories asked for, checked against what GitHub answered. */
async function mintToken(c: GithubAppConfig, installationId: number, ask: { repository_ids?: number[]; permissions: Record<string, string> }): Promise<MintedToken> {
  const r = await gh<{ token?: string; expires_at?: string; permissions?: Record<string, string>; repositories?: Repo[] }>(
    "POST", `${endpoints.api}/app/installations/${installationId}/access_tokens`, `Bearer ${appJwt(c)}`, ask);
  ok(r, "an installation token");
  const t = r.json;
  if (!t || typeof t.token !== "string" || t.token.length < 8 || typeof t.expires_at !== "string" || Number.isNaN(Date.parse(t.expires_at)))
    throw new GithubError("GitHub's installation token answer was not understood", 502);
  const perms = t.permissions ?? {};
  // Exactly what was asked (and read metadata, which every token has): anything more is revoked, never used.
  const extra = Object.entries(perms).filter(([k, v]) => !(ask.permissions[k] === v || (k === "metadata" && v === "read")));
  if (extra.length) {
    await gh("DELETE", `${endpoints.api}/installation/token`, `token ${t.token}`).catch(() => null);
    throw new GithubError(`GitHub gave a token with more than was asked (${extra.map(([k, v]) => `${k}:${v}`).join(", ").slice(0, 120)}): revoked, not used`, 502);
  }
  const repos = Array.isArray(t.repositories) ? t.repositories.filter((x) => Number.isSafeInteger(x?.id) && typeof x?.full_name === "string").map((x) => ({ id: x.id, full_name: x.full_name })) : [];
  if (ask.repository_ids && repos.some((x) => !ask.repository_ids!.includes(x.id)))
    { await gh("DELETE", `${endpoints.api}/installation/token`, `token ${t.token}`).catch(() => null); throw new GithubError("GitHub gave a token for repositories that were not asked for: revoked, not used", 502); }
  return { token: t.token, expires_at: new Date(t.expires_at).toISOString(), permissions: perms, repositories: repos };
}
const revokeOnGithub = async (token: string) => {
  const r = await gh("DELETE", `${endpoints.api}/installation/token`, `token ${token}`);
  // 401: GitHub no longer knows it (expired, or the app was uninstalled): as good as revoked.
  return r.status === 204 || r.status === 401 || r.status === 404;
};

/** Every repository an installation was given (a short-lived token with read metadata only, revoked right after). */
async function installationRepos(c: GithubAppConfig, installationId: number): Promise<Repo[]> {
  const t = await mintToken(c, installationId, { permissions: { metadata: "read" } });
  try {
    const out: Repo[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = await gh<{ repositories?: Repo[] }>("GET", `${endpoints.api}/installation/repositories?per_page=100&page=${page}`, `token ${t.token}`);
      ok(r, "the installation's repositories");
      const list = (r.json?.repositories ?? []).filter((x) => Number.isSafeInteger(x?.id) && typeof x?.full_name === "string").map((x) => ({ id: x.id, full_name: x.full_name }));
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  } finally { await revokeOnGithub(t.token).catch(() => false); }
}

// ---------- installations ----------

export interface InstallationRow {
  id: number; org_id: number; installation_id: number; account_login: string; account_type: string; repository_selection: string;
  repositories: Repo[]; asset_repositories: Record<string, string[]>; suspended_at: Date | string | null; connected_by: string | null;
  created_at: Date | string; updated_at: Date | string; removed_at: Date | string | null; removed_reason: string | null;
}
const COLS = "id, org_id, installation_id::float8 AS installation_id, account_login, account_type, repository_selection, repositories, asset_repositories, suspended_at, connected_by, created_at, updated_at, removed_at, removed_reason";
const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** A workspace's live installation, or null. */
export async function liveInstallation(orgId: number, q?: Queryable): Promise<InstallationRow | null> {
  const run = async (db: Queryable) => (await db.query<InstallationRow>(`SELECT ${COLS} FROM workspace_github_installations WHERE org_id = $1 AND removed_at IS NULL`, [orgId]))[0] ?? null;
  return q ? run(q) : asPlatform(async () => run(await getDb()));
}

/** What the workspace's console shows: the account, its repositories and how each asset is narrowed. Never a token. */
export async function workspaceView(orgId: number) {
  const c = await appConfig();
  const i = await liveInstallation(orgId);
  return {
    available: !!c,
    fields: githubAppFields(),
    installation: i ? {
      account: i.account_login, account_type: i.account_type, repository_selection: i.repository_selection,
      repositories: i.repositories.map((r) => r.full_name).sort(), asset_repositories: i.asset_repositories,
      suspended: !!i.suspended_at, connected_at: iso(i.created_at), connected_by: i.connected_by,
    } : null,
  };
}

/** The state the install redirect carries: payload.signature, signed with the app's client secret. */
const signState = (c: GithubAppConfig, payload: string) => createHmac("sha256", c.client_secret).update(`github-app-state/v1.${payload}`).digest("base64url");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The install address for workspace `orgId` and person `userId` (an owner: the route checks). */
export async function beginInstall(orgId: number, userId: string): Promise<{ url: string; expires_at: string }> {
  const c = await appConfig();
  if (!c) throw new PackError("the platform has no GitHub App set up: paste a token instead, or ask the platform's staff", 409);
  const nonce = randomBytes(24).toString("base64url");
  const exp = Date.now() + STATE_MINUTES * 60_000;
  await asPlatform(async () => {
    const db = await getDb();
    await db.query("/* tenant: platform sweep of expired install states */ DELETE FROM github_app_states WHERE expires_at < now() - interval '1 day'");
    await db.query("INSERT INTO github_app_states (nonce_sha256, org_id, user_id, expires_at) VALUES ($1, $2, $3, $4)", [sha256(nonce), orgId, userId, new Date(exp)]);
  });
  const payload = b64u(JSON.stringify({ v: 1, o: orgId, n: nonce, e: exp }));
  const state = `${payload}.${signState(c, payload)}`;
  return { url: `${endpoints.web}/apps/${encodeURIComponent(c.slug)}/installations/new?state=${encodeURIComponent(state)}`, expires_at: new Date(exp).toISOString() };
}

/** Why an install was refused: a code the console turns into words (never anything GitHub or the caller sent). */
export class InstallRefused extends Error { constructor(public code: string, public status = 400) { super(code); } }

/**
 * The install's return (GitHub sends the browser back here). `who` is the signed-in session; `q` is the query GitHub
 * added. Binds the installation to the session's workspace only when every check passes (see the top of this file).
 */
export async function completeInstall(who: { org: number; user: string; by: string }, q: Record<string, unknown>): Promise<{ outcome: "connected" | "requested"; account: string | null }> {
  const c = await appConfig();
  if (!c) throw new InstallRefused("not_configured", 409);
  const state = typeof q.state === "string" ? q.state : "";
  const [payload, sig] = state.split(".");
  if (!payload || !sig || state.length > 1000) throw new InstallRefused("bad_state");
  const want = Buffer.from(signState(c, payload)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new InstallRefused("bad_state");
  let p: { v?: number; o?: number; n?: string; e?: number };
  try { p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new InstallRefused("bad_state"); }
  if (p.v !== 1 || !Number.isSafeInteger(p.o) || typeof p.n !== "string" || typeof p.e !== "number") throw new InstallRefused("bad_state");
  if (p.e < Date.now()) throw new InstallRefused("expired");
  // Bound to the workspace it was made for: a session now in another workspace (or another person's) is refused.
  if (p.o !== who.org) throw new InstallRefused("other_workspace", 403);
  const used = await asPlatform(async () => (await getDb()).query<{ org_id: number }>(
    `UPDATE github_app_states SET used_at = now() WHERE nonce_sha256 = $1 AND org_id = $2 AND user_id = $3 AND used_at IS NULL AND expires_at > now() RETURNING org_id`,
    [sha256(p.n!), who.org, who.user]));
  if (!used.length) throw new InstallRefused("state_used", 403);
  // An organization member who may not install asked an organization owner to: nothing to connect yet.
  if (q.setup_action === "request") return { outcome: "requested", account: null };
  const idText = typeof q.installation_id === "string" ? q.installation_id : "";
  if (!/^[0-9]{1,15}$/.test(idText)) throw new InstallRefused("no_installation");
  const installationId = Number(idText);
  const code = typeof q.code === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(q.code) ? q.code : null;
  if (!code) throw new InstallRefused("no_user_authorization");
  // Proof that the person reached this installation on GitHub: the code's user token lists it. Never stored; revoked.
  const tok = await gh<{ access_token?: string }>("POST", `${endpoints.web}/login/oauth/access_token`, null,
    { client_id: c.client_id, client_secret: c.client_secret, code }, { accept: "application/json" });
  const userToken = tok.status === 200 && typeof tok.json?.access_token === "string" ? tok.json.access_token : null;
  if (!userToken) throw new InstallRefused("user_authorization_failed", 403);
  let reachable = false;
  try {
    for (let page = 1; page <= 10 && !reachable; page++) {
      const r = await gh<{ installations?: { id: number }[] }>("GET", `${endpoints.api}/user/installations?per_page=100&page=${page}`, `Bearer ${userToken}`);
      ok(r, "the person's installations");
      const list = r.json?.installations ?? [];
      reachable = list.some((x) => x?.id === installationId);
      if (list.length < 100) break;
    }
  } finally {
    await gh("DELETE", `${endpoints.api}/applications/${encodeURIComponent(c.client_id)}/token`, `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`,
      { access_token: userToken }).catch(() => null);
  }
  if (!reachable) throw new InstallRefused("not_your_installation", 403);
  const info = await gh<{ id?: number; app_id?: number; account?: { login?: string; type?: string }; repository_selection?: string; suspended_at?: string | null }>(
    "GET", `${endpoints.api}/app/installations/${installationId}`, `Bearer ${appJwt(c)}`);
  ok(info, "the installation");
  if (info.json?.id !== installationId || String(info.json?.app_id ?? "") !== c.app_id) throw new InstallRefused("other_app", 403);
  const login = String(info.json?.account?.login ?? "").slice(0, 100), type = String(info.json?.account?.type ?? "Organization").slice(0, 40);
  if (!login) throw new InstallRefused("no_installation");
  const repos = await installationRepos(c, installationId);
  const selection = info.json?.repository_selection === "all" ? "all" : "selected";
  await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const [held] = await tx.query<{ org_id: number }>(
      "SELECT org_id FROM workspace_github_installations WHERE installation_id = $1 AND removed_at IS NULL FOR UPDATE", [installationId]);
    if (held && held.org_id !== who.org) throw new InstallRefused("installation_in_use", 409);
    const mine = await liveInstallation(who.org, tx);
    if (mine && mine.installation_id !== installationId) throw new InstallRefused("already_connected", 409);
    if (mine) {
      await tx.query(`/* tenant: the session workspace's own row, by id */ UPDATE workspace_github_installations SET account_login = $2, account_type = $3, repository_selection = $4, repositories = $5::jsonb,
                             suspended_at = $6, updated_at = now() WHERE id = $1`,
        [mine.id, login, type, selection, JSON.stringify(repos), info.json?.suspended_at ? new Date(info.json.suspended_at) : null]);
    } else {
      await tx.query(`INSERT INTO workspace_github_installations (org_id, installation_id, account_login, account_type, repository_selection, repositories, suspended_at, connected_by)
                      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [who.org, installationId, login, type, selection, JSON.stringify(repos), info.json?.suspended_at ? new Date(info.json.suspended_at) : null, who.by]);
    }
  }));
  return { outcome: "connected", account: login };
}

/**
 * Narrow the token of runs targeting one asset record to some of the installation's repositories (an owner). An empty
 * list removes the narrowing: those runs get every repository of the installation again.
 */
export async function setAssetRepositories(orgId: number, input: { area?: unknown; asset?: unknown; repositories?: unknown }) {
  const area = typeof input?.area === "string" ? input.area : "";
  if (!githubAppFields().some((f) => f.area === area)) throw new PackError("area: an asset area a GitHub repository credential is bound to", 400);
  const key = typeof input?.asset === "string" && RECORD_KEY.test(input.asset) ? input.asset : null;
  if (!key) throw new PackError("asset: a record key of that area", 400);
  const { getFor } = await import("./record-areas.js");
  if (!(await getFor(orgId, area, key))) throw new PackError(`no ${area} record ${key} in this workspace`, 404);
  const list = Array.isArray(input.repositories) ? input.repositories : null;
  if (!list || list.length > MAX_REPOS || list.some((x) => typeof x !== "string")) throw new PackError("repositories: a list of owner/name", 400);
  return asPlatform(async () => (await getDb()).transaction(async (tx) => {
    const i = await liveInstallation(orgId, tx);
    if (!i) throw new PackError("connect GitHub first", 409);
    const known = new Set(i.repositories.map((r) => r.full_name.toLowerCase()));
    const wanted = [...new Set((list as string[]).map((x) => x.trim()))];
    const unknown = wanted.filter((x) => !known.has(x.toLowerCase()));
    if (unknown.length) throw new PackError(`not a repository of the installation: ${unknown[0]!.slice(0, 140)}`, 400);
    const canon = wanted.map((x) => i.repositories.find((r) => r.full_name.toLowerCase() === x.toLowerCase())!.full_name).sort();
    const next = { ...i.asset_repositories };
    if (canon.length) next[`${area}/${key}`] = canon; else delete next[`${area}/${key}`];
    await tx.query("/* tenant: the session workspace's own row, by id */ UPDATE workspace_github_installations SET asset_repositories = $2::jsonb, updated_at = now() WHERE id = $1", [i.id, JSON.stringify(next)]);
    return { area, asset: key, repositories: canon };
  }));
}

/**
 * End a workspace's connection (its owners, staff, or the workspace being removed): the row is ended, every token minted
 * for its runs is revoked, and the installation is uninstalled on GitHub (best effort: GitHub may already have done it).
 */
export async function disconnect(orgId: number, reason: "disconnected" | "workspace_removed" | "revoked_by_staff"): Promise<{ disconnected: boolean; uninstalled: boolean }> {
  const ended = await asPlatform(async () => (await getDb()).query<{ installation_id: number }>(
    `UPDATE workspace_github_installations SET removed_at = now(), removed_reason = $2, updated_at = now()
      WHERE org_id = $1 AND removed_at IS NULL RETURNING installation_id::float8 AS installation_id`, [orgId, reason]));
  if (!ended.length) return { disconnected: false, uninstalled: false };
  const installationId = ended[0]!.installation_id;
  memo.delete(orgId);
  await asPlatform(async () => (await getDb()).query(
    "UPDATE run_github_app_tokens SET revoked_at = now() WHERE org_id = $1 AND installation_id = $2 AND revoked_at IS NULL", [orgId, installationId]));
  await flushRevocations().catch(() => 0);
  let uninstalled = false;
  const c = await appConfig().catch(() => null);
  if (c) {
    const r = await gh("DELETE", `${endpoints.api}/app/installations/${installationId}`, `Bearer ${appJwt(c)}`).catch(() => null);
    uninstalled = !!r && (r.status === 204 || r.status === 404);
  }
  return { disconnected: true, uninstalled };
}

// ---------- the app's webhook ----------

/** Whether `raw` is signed by the app's webhook secret (X-Hub-Signature-256: sha256=<hex>). */
export function webhookSignatureValid(secret: string, raw: Buffer, header: unknown): boolean {
  if (typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * One delivery of the app's webhook, already verified. `installation` deleted: every workspace's connection to it ends
 * now and its tokens count as revoked (GitHub revoked them); suspend/unsuspend pause and resume minting;
 * `installation_repositories`: the repository list follows (a removed repository leaves every asset's narrowing too).
 */
export async function handleWebhook(event: string, body: Record<string, unknown>): Promise<{ handled: string }> {
  const inst = body.installation as { id?: unknown; app_id?: unknown } | undefined;
  const installationId = Number.isSafeInteger(inst?.id) ? (inst!.id as number) : null;
  const action = typeof body.action === "string" ? body.action : "";
  if (event === "ping" || installationId === null) return { handled: "ignored" };
  const db = await getDb();
  if (event === "installation" && action === "deleted") {
    const ended = await asPlatform(() => db.query<{ org_id: number }>(
      `UPDATE workspace_github_installations SET removed_at = now(), removed_reason = 'uninstalled', updated_at = now()
        WHERE installation_id = $1 AND removed_at IS NULL RETURNING org_id`, [installationId]));
    for (const e of ended) memo.delete(e.org_id);
    await asPlatform(() => db.query(
      "/* tenant: the app's verified webhook, by installation */ UPDATE run_github_app_tokens SET revoked_at = coalesce(revoked_at, now()), github_revoked_at = coalesce(github_revoked_at, now()) WHERE installation_id = $1 AND github_revoked_at IS NULL",
      [installationId]));
    return { handled: ended.length ? "uninstalled" : "ignored" };
  }
  if (event === "installation" && (action === "suspend" || action === "unsuspend")) {
    const rows = await asPlatform(() => db.query<{ org_id: number }>(
      `UPDATE workspace_github_installations SET suspended_at = ${action === "suspend" ? "now()" : "NULL"}, updated_at = now()
        WHERE installation_id = $1 AND removed_at IS NULL RETURNING org_id`, [installationId]));
    for (const r of rows) memo.delete(r.org_id);
    return { handled: rows.length ? action : "ignored" };
  }
  if (event === "installation_repositories") {
    const clean = (v: unknown): Repo[] => (Array.isArray(v) ? v : []).filter((x) => Number.isSafeInteger(x?.id) && typeof x?.full_name === "string")
      .map((x) => ({ id: x.id as number, full_name: x.full_name as string }));
    const added = clean(body.repositories_added), removed = clean(body.repositories_removed);
    const selection = body.repository_selection === "all" ? "all" : body.repository_selection === "selected" ? "selected" : null;
    const changed = await asPlatform(() => db.transaction(async (tx) => {
      const rows = await tx.query<InstallationRow>(`/* tenant: the app's verified webhook, by installation */ SELECT ${COLS} FROM workspace_github_installations WHERE installation_id = $1 AND removed_at IS NULL FOR UPDATE`, [installationId]);
      for (const i of rows) {
        const gone = new Set(removed.map((r) => r.id));
        const repos = [...i.repositories.filter((r) => !gone.has(r.id)), ...added.filter((a) => !i.repositories.some((r) => r.id === a.id))];
        const goneNames = new Set(removed.map((r) => r.full_name.toLowerCase()));
        const narrowed = Object.fromEntries(Object.entries(i.asset_repositories).map(([k, v]) => [k, v.filter((n) => !goneNames.has(n.toLowerCase()))]).filter(([, v]) => v.length));
        await tx.query(`/* tenant: the app's verified webhook, the installation's row by id */ UPDATE workspace_github_installations SET repositories = $2::jsonb, asset_repositories = $3::jsonb, repository_selection = coalesce($4, repository_selection), updated_at = now() WHERE id = $1`,
          [i.id, JSON.stringify(repos), JSON.stringify(narrowed), selection]);
        memo.delete(i.org_id);
      }
      return rows.length;
    }));
    return { handled: changed ? "repositories" : "ignored" };
  }
  return { handled: "ignored" };
}

// ---------- tokens for runs ----------

const tokenAad = (orgId: number, runId: string, name: string, installationId: number, scopeKey: string) =>
  JSON.stringify(["github-app-token/v1", orgId, runId, name, installationId, scopeKey]);

export interface RunTokenRequest { runId: string; orgId: number; name: string; bound_to: string; area: string | null; asset: string | null }
export type RunTokenAnswer = { value: string; repositories: string[]; expires_at: string } | { missing: string } | null;

/**
 * The installation token run `runId` receives as field `name`, or null when the workspace has no live installation or
 * the platform no app (the field's pasted value applies then). `{missing}` when a token is due but none can be given
 * (the installation is suspended, has no repository for the asset, or GitHub refused): the run gets no value, never a
 * broader one.
 */
export async function installationTokenForRun(req: RunTokenRequest): Promise<RunTokenAnswer> {
  const c = await appConfig();
  if (!c) return null;
  const i = await liveInstallation(req.orgId);
  if (!i) return null;
  if (i.suspended_at) return { missing: "the GitHub App's installation is suspended" };
  const scopeKey = req.bound_to !== "workspace" && req.asset && req.area ? `${req.area}/${req.asset}` : "";
  const narrowed = scopeKey ? i.asset_repositories[scopeKey] ?? null : null;
  const repos = narrowed ? i.repositories.filter((r) => narrowed.some((n) => n.toLowerCase() === r.full_name.toLowerCase())) : i.repositories;
  if (!repos.length) return { missing: "the GitHub App's installation has no repository for this run" };
  if (repos.length > MAX_REPOS) return { missing: `the installation has more than ${MAX_REPOS} repositories: narrow this asset's` };
  const db = await getDb();
  // The run's own token for this field and scope, while it has time left.
  const [cached] = await asPlatform(() => db.query<{ sealed: string; repositories: Repo[]; expires_at: Date | string }>(
    `SELECT sealed, repositories, expires_at FROM run_github_app_tokens
      WHERE run_id = $1 AND org_id = $2 AND name = $3 AND scope_key = $4 AND installation_id = $5 AND revoked_at IS NULL AND expires_at > $6
      ORDER BY expires_at DESC LIMIT 1`, [req.runId, req.orgId, req.name, scopeKey, i.installation_id, new Date(Date.now() + REUSE_MARGIN_MS)]));
  if (cached) {
    const value = (await asPlatform(() => openBytes(req.orgId, Buffer.from(cached.sealed, "base64"), tokenAad(req.orgId, req.runId, req.name, i.installation_id, scopeKey)))).toString("utf8");
    return { value, repositories: cached.repositories.map((r) => r.full_name), expires_at: iso(cached.expires_at)! };
  }
  let t: MintedToken;
  try { t = await mintToken(c, i.installation_id, { repository_ids: repos.map((r) => r.id), permissions: { ...TOKEN_PERMISSIONS } }); }
  catch (e) { return { missing: e instanceof PackError ? e.message : "GitHub refused the installation token" }; }
  const sealed = (await asPlatform(() => sealBytes(req.orgId, Buffer.from(t.token, "utf8"), tokenAad(req.orgId, req.runId, req.name, i.installation_id, scopeKey)))).toString("base64");
  const scoped = t.repositories.length ? t.repositories : repos;
  await asPlatform(() => db.query(
    `/* tenant: the run row's own workspace */ INSERT INTO run_github_app_tokens (run_id, org_id, installation_id, name, scope_key, sealed, repositories, permissions, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
    [req.runId, req.orgId, i.installation_id, req.name, scopeKey, sealed, JSON.stringify(scoped), JSON.stringify(t.permissions), new Date(t.expires_at)]));
  return { value: t.token, repositories: scoped.map((r) => r.full_name), expires_at: t.expires_at };
}

/** Every token minted for run `runId` (revoked or not), for redacting what it writes. Throws while they cannot be opened. */
export async function runTokenSecrets(runId: string, orgId: number): Promise<Secret[]> {
  const rows = await asPlatform(async () => (await getDb()).query<{ name: string; sealed: string; installation_id: number; scope_key: string }>(
    "SELECT name, sealed, installation_id::float8 AS installation_id, scope_key FROM run_github_app_tokens WHERE run_id = $1 AND org_id = $2", [runId, orgId]));
  const out: Secret[] = [];
  for (const r of rows) {
    try { out.push({ name: r.name, value: (await asPlatform(() => openBytes(orgId, Buffer.from(r.sealed, "base64"), tokenAad(orgId, runId, r.name, r.installation_id, r.scope_key)))).toString("utf8") }); }
    catch { throw new PackError("the run's GitHub tokens cannot be opened now (the key vault is locked?): try again", 503); }
  }
  return out;
}

let flushing: Promise<number> | null = null;
/** Ask GitHub to revoke every token marked revoked that it may still honour. Returns how many it confirmed. */
export function flushRevocations(): Promise<number> {
  flushing ??= (async () => {
    const db = await getDb();
    const rows = await asPlatform(() => db.query<{ id: number; run_id: string; org_id: number; name: string; sealed: string; installation_id: number; scope_key: string }>(
      `/* tenant: platform sweep of revoked run tokens, every workspace */ SELECT id, run_id, org_id, name, sealed, installation_id::float8 AS installation_id, scope_key FROM run_github_app_tokens
        WHERE revoked_at IS NOT NULL AND github_revoked_at IS NULL AND expires_at > now() ORDER BY id LIMIT 100`));
    let n = 0;
    for (const r of rows) {
      let token: string;
      try { token = (await asPlatform(() => openBytes(r.org_id, Buffer.from(r.sealed, "base64"), tokenAad(r.org_id, r.run_id, r.name, r.installation_id, r.scope_key)))).toString("utf8"); }
      catch { continue; }
      if (await revokeOnGithub(token).catch(() => false)) {
        await asPlatform(() => db.query("/* tenant: the token's own row, by id */ UPDATE run_github_app_tokens SET github_revoked_at = now() WHERE id = $1", [r.id]));
        n++;
      }
    }
    return n;
  })().finally(() => { flushing = null; });
  return flushing;
}

/**
 * An installation token for the server's own read of a workspace-bound field (src/credentials.ts
 * workspaceCredentialValue), or null for the pasted value. Never handed to a run or an answer.
 */
export async function installationTokenForServer(orgId: number): Promise<string | null> {
  const c = await appConfig();
  if (!c) return null;
  const i = await liveInstallation(orgId);
  if (!i) { memo.delete(orgId); return null; }
  if (i.suspended_at) throw new PackError("the workspace's GitHub App installation is suspended", 409);
  const m = memo.get(orgId);
  if (m && m.installation === i.installation_id && m.expires - Date.now() > REUSE_MARGIN_MS) return m.token;
  if (!i.repositories.length || i.repositories.length > MAX_REPOS) throw new PackError("the workspace's GitHub App installation has no repository to read", 409);
  const t = await mintToken(c, i.installation_id, { repository_ids: i.repositories.map((r) => r.id), permissions: { ...TOKEN_PERMISSIONS } });
  memo.set(orgId, { token: t.token, expires: Date.parse(t.expires_at), installation: i.installation_id });
  return t.token;
}

// ---------- staff ----------

/** Every installation across workspaces, live and ended, for /admin (never a token). */
export async function adminInstallations() {
  const rows = await asPlatform(async () => (await getDb()).query<InstallationRow & { slug: string; name: string; live_tokens: number }>(
    `/* tenant: admin-only (platform staff): every workspace's installation */ SELECT i.id, i.org_id, i.installation_id::float8 AS installation_id, i.account_login, i.account_type, i.repository_selection, i.repositories,
            i.asset_repositories, i.suspended_at, i.connected_by, i.created_at, i.updated_at, i.removed_at, i.removed_reason, o.slug, o.name,
            (SELECT count(*)::int FROM run_github_app_tokens t WHERE t.org_id = i.org_id AND t.installation_id = i.installation_id AND t.revoked_at IS NULL AND t.expires_at > now()) AS live_tokens
       FROM workspace_github_installations i JOIN organizations o ON o.id = i.org_id
      ORDER BY i.removed_at IS NOT NULL, i.created_at DESC LIMIT 500`));
  return rows.map((r) => ({
    id: r.id, workspace: { id: r.org_id, slug: r.slug, name: r.name }, installation_id: r.installation_id, account: r.account_login, account_type: r.account_type,
    repository_selection: r.repository_selection, repositories: r.repositories.length, narrowed_assets: Object.keys(r.asset_repositories).length,
    suspended: !!r.suspended_at, connected_by: r.connected_by, connected_at: iso(r.created_at), removed_at: iso(r.removed_at), removed_reason: r.removed_reason,
    live_tokens: Number(r.live_tokens),
  }));
}
