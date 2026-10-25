/**
 * Credential fields connected through OAuth (mold_v0-014; molds/mold_v0/MOLD.md "Credentials connected through OAuth").
 * A pack declares OAuth providers (definePack oauthProviders, pack.json oauth_providers: the sign-in and token addresses,
 * the scopes, and the client id and secret by their key-vault labels) and a credential field names one (`oauth`).
 *
 *   connect     an owner asks for the provider's sign-in address for one slot of the field (the workspace, an asset of
 *               theirs, an asset's environment): the shared signed one-time state (src/oauth-state.ts, purpose "oauth",
 *               bound to the person and workspace) and, unless the provider says pkce: false, a PKCE challenge whose
 *               verifier stays here, sealed with the workspace's data key. On the return the state is checked and used
 *               up, the code is exchanged at the token address (with the verifier and the redirect address) and the
 *               tokens are stored sealed in workspace_oauth_connections, bound by additional data to their slot.
 *   tokens      tokenForSlot: the access token, refreshed with the refresh token once it has less than ten minutes left
 *               (src/clock.ts REFRESH_MARGIN_MS; the row is locked while refreshing, so a rotating refresh token is used
 *               once). A provider that refuses the refresh (invalid_grant: revoked, expired) marks the connection
 *               needs_reconnect: nothing is sent until an owner connects again.
 *   runs        runOAuthToken: the slot's access token for a run, recorded (sealed) in run_oauth_tokens so everything the
 *               run writes is redacted of it; a run longer than the token's life asks again (src/run-harness.ts) and
 *               gets the refreshed one. The server's own reads (an http_api repository's header) use serverOAuthToken.
 *   disconnect  removing the row stops every later delivery at once; the provider's revoke address is told (best effort).
 *               Removing a workspace does the same for each of its connections (src/tenancy.ts).
 *
 * The client secret, the refresh token and the PKCE verifier never leave the server; a run receives only the access
 * token, as its field delivers it. No answer, log or error carries a token or a secret.
 */
import { createHash, randomBytes } from "node:crypto";
import { now, REFRESH_MARGIN_MS } from "./clock.js";
import { consoleUrl } from "./console-url.js";
import { credentialSlot, findCredential, type CredentialSpec, type Slot } from "./credentials.js";
import { getDb, type Queryable } from "./db.js";
import { decrypt } from "./keyvault.js";
import { ensureOrgKey, openBytes, sealBytes } from "./orgcrypto.js";
import { consumeState, issueState, StateRefused } from "./oauth-state.js";
import { OAuthProviderSchema, PackError, z } from "./pack-api.js";
import { packs } from "./packs.js";
import { asPlatform } from "./tenant-scope.js";
import type { Secret } from "./credential-redact.js";

export const OAUTH_CLIENT_PROVIDER = "oauth_clients";
export type OAuthProvider = z.output<typeof OAuthProviderSchema> & { pack: string };

// ---------- declarations ----------

let cache: { from: unknown; providers: OAuthProvider[] } | null = null;
/** Every OAuth provider the packs declare. */
export function oauthProviders(): OAuthProvider[] {
  const list = packs();
  if (cache?.from === list) return cache.providers;
  cache = { from: list, providers: list.flatMap((p) => (p.definition.oauthProviders ?? []).map((o) => ({ ...OAuthProviderSchema.parse(o), pack: p.id }))) };
  return cache.providers;
}
export const providerFor = (spec: Pick<CredentialSpec, "pack" | "oauth">) => (spec.oauth ? oauthProviders().find((o) => o.pack === spec.pack && o.name === spec.oauth) ?? null : null);
/** The credential fields connected through OAuth. None: nothing of this module is mounted. */
export const oauthFields = () => packs().flatMap((p) => (p.definition.credentials ?? []).filter((c) => c.oauth).map((c) => ({ pack: p.id, name: c.name, oauth: c.oauth! })));

/** The address the providers send the browser back to: the console's, which forwards /api to this server. */
export const redirectUri = () => `${consoleUrl()}/api/credential-connections/callback`;

/** Tests only: the fetch the token, refresh and revoke calls use (a stand-in provider). */
let fetcher: typeof fetch = (...a) => fetch(...a);
export function setOAuthFetchForTest(f: typeof fetch) { fetcher = f; }

/** The platform's client id and secret for a provider, from the key vault (provider oauth_clients), or null. */
async function client(p: OAuthProvider): Promise<{ id: string; secret: string } | null> {
  const rows = await asPlatform(async () => (await getDb()).query<{ label: string; ciphertext: string; iv: string; tag: string; key_id: string }>(
    "SELECT label, ciphertext, iv, tag, key_id FROM vault_credentials WHERE provider = $1 AND label = ANY($2) AND enabled", [OAUTH_CLIENT_PROVIDER, [p.client_id.vault, p.client_secret.vault]]));
  const get = (label: string) => { const r = rows.find((x) => x.label === label); if (!r) return null; try { return decrypt(r); } catch { throw new PackError("the key vault is locked: try again", 503); } };
  const id = get(p.client_id.vault), secret = get(p.client_secret.vault);
  return id && secret ? { id, secret } : null;
}
/** Which of a provider's client values the vault holds (staff view). */
async function clientSet(p: OAuthProvider) {
  const rows = await asPlatform(async () => (await getDb()).query<{ label: string }>(
    "SELECT label FROM vault_credentials WHERE provider = $1 AND label = ANY($2) AND enabled", [OAUTH_CLIENT_PROVIDER, [p.client_id.vault, p.client_secret.vault]]));
  return { client_id: rows.some((r) => r.label === p.client_id.vault), client_secret: rows.some((r) => r.label === p.client_secret.vault) };
}

// ---------- the token endpoint ----------

interface Tokens { access_token: string; refresh_token: string | null; token_type: string | null }
interface TokenAnswer extends Tokens { expires_at: string | null; scope: string | null }
class TokenRefused extends Error { constructor(public code: string, public permanent: boolean) { super(code); } }

/** One call to the provider's token address: form-encoded, JSON (or form) back, no redirects, 15 s. Errors carry no token. */
async function tokenCall(p: OAuthProvider, c: { id: string; secret: string }, form: Record<string, string>): Promise<TokenAnswer> {
  const body = new URLSearchParams({ ...form, ...(p.token_auth === "body" ? { client_id: c.id, client_secret: c.secret } : {}) });
  let r: Response;
  try {
    r = await fetcher(p.token_url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), body,
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded",
        ...(p.token_auth === "basic" ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(c.id)}:${encodeURIComponent(c.secret)}`).toString("base64")}` } : {}) } });
  } catch { throw new TokenRefused("provider_unreachable", false); }
  const text = await r.text();
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); }
  const err = typeof j.error === "string" ? j.error.slice(0, 60).replace(/[^a-z_]/gi, "") : null;
  if (!r.ok || err) throw new TokenRefused(err ?? `status_${r.status}`, err === "invalid_grant" || err === "invalid_client" || err === "unauthorized_client");
  const access = j.access_token;
  if (typeof access !== "string" || access.length < 8 || access.length > 8192 || /[\r\n]/.test(access)) throw new TokenRefused("no_access_token", false);
  const exp = Number(j.expires_in);
  return {
    access_token: access,
    refresh_token: typeof j.refresh_token === "string" && j.refresh_token.length <= 8192 ? j.refresh_token : null,
    token_type: typeof j.token_type === "string" ? j.token_type.slice(0, 40) : null,
    expires_at: Number.isFinite(exp) && exp > 0 ? new Date(now() + exp * 1000).toISOString() : null,
    scope: typeof j.scope === "string" ? j.scope.slice(0, 2000) : null,
  };
}

// ---------- connections ----------

const aad = (orgId: number, s: Slot, provider: string) =>
  JSON.stringify(["oauth-connection/v1", orgId, s.spec.pack, s.spec.name, s.spec.bound_to, s.spec.area ?? null, s.asset, s.environment, provider]);
const seal = async (orgId: number, s: Slot, provider: string, t: Tokens) =>
  (await asPlatform(() => sealBytes(orgId, Buffer.from(JSON.stringify(t), "utf8"), aad(orgId, s, provider)))).toString("base64");
const open = async (orgId: number, s: Slot, provider: string, sealed: string): Promise<Tokens> =>
  JSON.parse((await asPlatform(() => openBytes(orgId, Buffer.from(sealed, "base64"), aad(orgId, s, provider)))).toString("utf8"));

interface Row { id: number; provider: string; sealed: string; access_expires_at: Date | string | null; status: string; scopes: string | null }
const SLOT_WHERE = "org_id = $1 AND pack = $2 AND name = $3 AND coalesce(asset_key, '') = $4 AND coalesce(environment, '') = $5";
const slotArgs = (orgId: number, s: Slot) => [orgId, s.spec.pack, s.spec.name, s.asset ?? "", s.environment ?? ""];

/** Why a connection was refused or failed: a code the console turns into words. */
export class ConnectRefused extends Error { constructor(public code: string, public status = 400) { super(code); } }

/** The provider's sign-in address for one slot of an OAuth field of workspace `orgId` (an owner: the route checks). */
export async function beginConnect(orgId: number, userId: string, input: { pack?: unknown; name?: unknown; asset?: unknown; environment?: unknown }): Promise<{ url: string; expires_at: string }> {
  const s = credentialSlot(input?.pack, input?.name, input?.asset, input?.environment);
  const p = providerFor(s.spec);
  if (!p) throw new PackError(`${s.spec.label} is not connected through a sign-in: paste its value instead`, 400);
  if (s.asset !== null) {
    const { getFor } = await import("./record-areas.js");
    if (!(await getFor(orgId, s.spec.area!, s.asset))) throw new PackError(`no ${s.spec.area} record ${s.asset} in this workspace`, 404);
  }
  const c = await client(p);
  if (!c) throw new PackError(`the platform has not set up ${p.label} yet (its client id and secret): paste a value instead, or ask the platform's staff`, 409);
  const verifier = p.pkce ? randomBytes(32).toString("base64url") : null;
  const sealedVerifier = verifier ? (await asPlatform(() => sealBytes(orgId, Buffer.from(verifier), `oauth-verifier/v1/${orgId}`))).toString("base64") : null;
  const { state, expires_at } = await issueState(orgId, userId, "oauth", {
    pack: s.spec.pack, name: s.spec.name, asset: s.asset, environment: s.environment, provider: p.name, verifier: sealedVerifier });
  const u = new URL(p.authorize_url);
  for (const [k, v] of Object.entries(p.authorize_params ?? {})) u.searchParams.set(k, v);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", c.id);
  u.searchParams.set("redirect_uri", redirectUri());
  if (p.scopes.length) u.searchParams.set("scope", p.scopes.join(p.scope_separator));
  u.searchParams.set("state", state);
  if (verifier) { u.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url")); u.searchParams.set("code_challenge_method", "S256"); }
  return { url: u.toString(), expires_at };
}

/** The provider's return: checks the state for the signed-in `who`, exchanges the code, stores the tokens sealed. */
export async function completeConnect(who: { org: number; user: string; by: string }, q: Record<string, unknown>): Promise<{ pack: string; name: string; label: string }> {
  let data: Record<string, unknown>;
  try { data = await consumeState(q.state, who, "oauth"); }
  catch (e) { if (e instanceof StateRefused) throw new ConnectRefused(e.code, e.status); throw e; }
  // The person said no at the provider (the state was theirs: it is used up all the same).
  if (typeof q.error === "string") throw new ConnectRefused("denied");
  const code = typeof q.code === "string" && q.code.length <= 2000 && /^[\x21-\x7e]+$/.test(q.code) ? q.code : null;
  if (!code) throw new ConnectRefused("no_code");
  let s: Slot;
  try { s = credentialSlot(data.pack, data.name, data.asset, data.environment); } catch { throw new ConnectRefused("field_gone"); }
  const p = providerFor(s.spec);
  if (!p || p.name !== data.provider) throw new ConnectRefused("field_gone");
  const c = await client(p);
  if (!c) throw new ConnectRefused("not_configured", 409);
  let verifier: string | null = null;
  if (typeof data.verifier === "string") {
    try { verifier = (await asPlatform(() => openBytes(who.org, Buffer.from(data.verifier as string, "base64"), `oauth-verifier/v1/${who.org}`))).toString("utf8"); }
    catch { throw new ConnectRefused("bad_state"); }
  }
  let t: TokenAnswer;
  try { t = await tokenCall(p, c, { grant_type: "authorization_code", code, redirect_uri: redirectUri(), ...(verifier ? { code_verifier: verifier } : {}) }); }
  catch (e) { throw new ConnectRefused(e instanceof TokenRefused && e.code === "provider_unreachable" ? "provider_unreachable" : "token_refused", 502); }
  const sealed = await seal(who.org, s, p.name, { access_token: t.access_token, refresh_token: t.refresh_token, token_type: t.token_type });
  await asPlatform(async () => (await getDb()).query(
    `INSERT INTO workspace_oauth_connections (org_id, pack, name, bound_to, asset_area, asset_key, environment, provider, sealed, scopes, access_expires_at, connected_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (org_id, pack, name, (coalesce(asset_key, '')), (coalesce(environment, '')))
     DO UPDATE SET bound_to = excluded.bound_to, asset_area = excluded.asset_area, provider = excluded.provider, sealed = excluded.sealed, scopes = excluded.scopes,
                   access_expires_at = excluded.access_expires_at, status = 'active', last_error = NULL, connected_by = excluded.connected_by, updated_at = now(), refreshed_at = NULL`,
    [who.org, s.spec.pack, s.spec.name, s.spec.bound_to, s.spec.area ?? null, s.asset, s.environment, p.name, sealed, t.scope ?? p.scopes.join(" "), t.expires_at ? new Date(t.expires_at) : null, who.by]));
  return { pack: s.spec.pack, name: s.spec.name, label: s.spec.label };
}

export type TokenResult = { value: string; expires_at: string | null } | { missing: string } | null;

/**
 * The slot's access token now, refreshed first when it has less than the margin left; null when the slot has no
 * connection (the pasted value applies). `{missing}` when the connection cannot give one (refused, expired).
 */
export async function tokenForSlot(orgId: number, s: Slot): Promise<TokenResult> {
  const p = providerFor(s.spec);
  if (!p) return null;
  const db = await getDb();
  const [row] = await asPlatform(() => db.query<Row>(`/* tenant: SLOT_WHERE starts org_id = $1 */ SELECT id, provider, sealed, access_expires_at, status, scopes FROM workspace_oauth_connections WHERE ${SLOT_WHERE}`, slotArgs(orgId, s)));
  if (!row) return null;
  if (row.status !== "active") return { missing: `the ${p.label} connection was refused by ${p.label}: connect it again` };
  const due = (r: Row) => r.access_expires_at !== null && new Date(r.access_expires_at).getTime() - now() < REFRESH_MARGIN_MS;
  if (!due(row)) {
    const t = await open(orgId, s, row.provider, row.sealed).catch(() => null);
    if (!t) return { missing: "the connection cannot be opened now (the key vault is locked?)" };
    return { value: t.access_token, expires_at: row.access_expires_at ? new Date(row.access_expires_at).toISOString() : null };
  }
  return refresh(orgId, s, p);
}

/** Refresh one connection, the row locked meanwhile (another process that got there first leaves a fresh token to use). */
async function refresh(orgId: number, s: Slot, p: OAuthProvider): Promise<TokenResult> {
  const db = await getDb();
  // Everything that reads the database besides the row itself, before the transaction (an embedded database has one
  // connection): the workspace's data key and the platform's client values.
  await ensureOrgKey(orgId);
  const c = await client(p);
  return asPlatform(() => db.transaction(async (tx: Queryable) => {
    const [row] = await tx.query<Row>(`/* tenant: SLOT_WHERE starts org_id = $1 */ SELECT id, provider, sealed, access_expires_at, status, scopes FROM workspace_oauth_connections WHERE ${SLOT_WHERE} FOR UPDATE`, slotArgs(orgId, s));
    if (!row) return null;
    if (row.status !== "active") return { missing: `the ${p.label} connection was refused by ${p.label}: connect it again` };
    const t = await open(orgId, s, row.provider, row.sealed).catch(() => null);
    if (!t) return { missing: "the connection cannot be opened now (the key vault is locked?)" };
    const exp = row.access_expires_at ? new Date(row.access_expires_at).getTime() : null;
    if (exp === null || exp - now() >= REFRESH_MARGIN_MS) return { value: t.access_token, expires_at: exp === null ? null : new Date(exp).toISOString() };
    const stillGood = exp > now() ? { value: t.access_token, expires_at: new Date(exp).toISOString() } : { missing: `the ${p.label} token expired and could not be refreshed` };
    if (!t.refresh_token || !c) return stillGood;
    try {
      const n = await tokenCall(p, c, { grant_type: "refresh_token", refresh_token: t.refresh_token });
      const tokens: Tokens = { access_token: n.access_token, refresh_token: n.refresh_token ?? t.refresh_token, token_type: n.token_type ?? t.token_type };
      await tx.query(`UPDATE workspace_oauth_connections SET sealed = $2, access_expires_at = $3, scopes = coalesce($4, scopes), refreshed_at = now(), updated_at = now(), last_error = NULL WHERE id = $1 AND org_id = $5`,
        [row.id, await seal(orgId, s, row.provider, tokens), n.expires_at ? new Date(n.expires_at) : null, n.scope, orgId]);
      return { value: n.access_token, expires_at: n.expires_at };
    } catch (e) {
      const r = e instanceof TokenRefused ? e : new TokenRefused("refresh_failed", false);
      if (r.permanent) {
        // Revoked or expired at the provider: nothing more is sent until an owner connects again.
        await tx.query("UPDATE workspace_oauth_connections SET status = 'needs_reconnect', last_error = $2, updated_at = now() WHERE id = $1 AND org_id = $3", [row.id, r.code, orgId]);
        return { missing: `${p.label} refused to refresh the connection (${r.code}): connect it again` };
      }
      await tx.query("UPDATE workspace_oauth_connections SET last_error = $2, updated_at = now() WHERE id = $1 AND org_id = $3", [row.id, r.code, orgId]);
      return stillGood;
    }
  }));
}

/** A run's access token for a slot, recorded (sealed) for redacting what the run writes. */
export async function runOAuthToken(runId: string, orgId: number, s: Slot): Promise<TokenResult> {
  const t = await tokenForSlot(orgId, s);
  if (!t || "missing" in t) return t;
  const sealed = (await asPlatform(() => sealBytes(orgId, Buffer.from(t.value, "utf8"), `run-oauth-token/v1/${orgId}/${runId}`))).toString("base64");
  await asPlatform(async () => (await getDb()).query(
    `INSERT INTO run_oauth_tokens (run_id, org_id, name, token_sha256, sealed, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (run_id, token_sha256) DO NOTHING`,
    [runId, orgId, s.spec.name, createHash("sha256").update(t.value).digest("hex"), sealed, t.expires_at ? new Date(t.expires_at) : null]));
  return t;
}
/** Every access token run `runId` received, for redaction. Throws while they cannot be opened. */
export async function runOAuthSecrets(runId: string, orgId: number): Promise<Secret[]> {
  const rows = await asPlatform(async () => (await getDb()).query<{ name: string; sealed: string }>("SELECT name, sealed FROM run_oauth_tokens WHERE run_id = $1 AND org_id = $2", [runId, orgId]));
  const out: Secret[] = [];
  for (const r of rows) {
    try { out.push({ name: r.name, value: (await asPlatform(() => openBytes(orgId, Buffer.from(r.sealed, "base64"), `run-oauth-token/v1/${orgId}/${runId}`))).toString("utf8") }); }
    catch { throw new PackError("the run's OAuth tokens cannot be opened now (the key vault is locked?): try again", 503); }
  }
  return out;
}
/** The server's own read with a workspace-bound OAuth field (never handed to a run or an answer). */
export const serverOAuthToken = (orgId: number, s: Slot) => tokenForSlot(orgId, s);

/** What the console shows of a workspace's connections: never a token. */
export async function listConnections(orgId: number) {
  const rows = await asPlatform(async () => (await getDb()).query<{ pack: string; name: string; asset_key: string | null; environment: string | null; provider: string; status: string; scopes: string | null;
    access_expires_at: Date | string | null; connected_by: string | null; created_at: Date | string; refreshed_at: Date | string | null; last_error: string | null }>(
    `SELECT pack, name, asset_key, environment, provider, status, scopes, access_expires_at, connected_by, created_at, refreshed_at, last_error FROM workspace_oauth_connections
      WHERE org_id = $1 ORDER BY pack, name, asset_key NULLS FIRST, environment NULLS FIRST`, [orgId]));
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return rows.filter((r) => findCredential(r.pack, r.name)?.oauth).map((r) => ({ pack: r.pack, name: r.name, asset: r.asset_key, environment: r.environment, provider: r.provider,
    status: r.status, scopes: r.scopes, expires_at: iso(r.access_expires_at), connected_by: r.connected_by, connected_at: iso(r.created_at), refreshed_at: iso(r.refreshed_at), last_error: r.last_error }));
}
/** The providers of the build's OAuth fields, for the console: never a client value. */
export const providerSummaries = () => oauthProviders().map((p) => ({ pack: p.pack, name: p.name, label: p.label, scopes: p.scopes }));

/** Tell the provider (RFC 7009) a connection's tokens are no longer wanted. Best effort. */
async function revokeAtProvider(p: OAuthProvider | null, t: Tokens | null): Promise<boolean> {
  if (!p?.revoke_url || !t) return false;
  const c = await client(p).catch(() => null);
  if (!c) return false;
  let ok = true;
  for (const [token, hint] of [[t.refresh_token, "refresh_token"], [t.access_token, "access_token"]] as const) {
    if (!token) continue;
    const body = new URLSearchParams({ token, token_type_hint: hint, ...(p.token_auth === "body" ? { client_id: c.id, client_secret: c.secret } : {}) });
    const r = await fetcher(p.revoke_url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), body, headers: { "content-type": "application/x-www-form-urlencoded",
      ...(p.token_auth === "basic" ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(c.id)}:${encodeURIComponent(c.secret)}`).toString("base64")}` } : {}) } }).catch(() => null);
    ok &&= !!r && r.ok;
  }
  return ok;
}

/** Remove one connection of workspace `orgId` (its owners, staff): nothing is sent from now on; the provider is told. */
export async function disconnect(orgId: number, input: { pack?: unknown; name?: unknown; asset?: unknown; environment?: unknown }): Promise<{ removed: boolean; revoked_at_provider: boolean }> {
  const s = credentialSlot(input?.pack, input?.name, input?.asset, input?.environment);
  const [row] = await asPlatform(async () => (await getDb()).query<{ provider: string; sealed: string }>(
    `/* tenant: SLOT_WHERE starts org_id = $1 */ DELETE FROM workspace_oauth_connections WHERE ${SLOT_WHERE} RETURNING provider, sealed`, slotArgs(orgId, s)));
  if (!row) return { removed: false, revoked_at_provider: false };
  const t = await open(orgId, s, row.provider, row.sealed).catch(() => null);
  return { removed: true, revoked_at_provider: await revokeAtProvider(providerFor(s.spec), t).catch(() => false) };
}

/** Every connection of a workspace that is being removed: the provider is told for each (the rows go with the workspace). */
export async function revokeWorkspace(orgId: number): Promise<number> {
  const rows = await asPlatform(async () => (await getDb()).query<{ pack: string; name: string; bound_to: string; asset_area: string | null; asset_key: string | null; environment: string | null; provider: string; sealed: string }>(
    "DELETE FROM workspace_oauth_connections WHERE org_id = $1 RETURNING pack, name, bound_to, asset_area, asset_key, environment, provider, sealed", [orgId]));
  let n = 0;
  for (const r of rows) {
    const spec = { pack: r.pack, name: r.name, bound_to: r.bound_to, ...(r.asset_area ? { area: r.asset_area } : {}), oauth: r.provider } as unknown as CredentialSpec;
    const t = await open(orgId, { spec, asset: r.asset_key, environment: r.environment }, r.provider, r.sealed).catch(() => null);
    if (await revokeAtProvider(oauthProviders().find((p) => p.pack === r.pack && p.name === r.provider) ?? null, t).catch(() => false)) n++;
  }
  return n;
}

// ---------- staff ----------

/** The providers (and whether the vault holds their client values) and every workspace's connections: never a token. */
export async function adminView() {
  const providers = await Promise.all(oauthProviders().map(async (p) => ({ pack: p.pack, name: p.name, label: p.label, authorize_host: new URL(p.authorize_url).host,
    scopes: p.scopes, client_id_label: p.client_id.vault, client_secret_label: p.client_secret.vault, set: await clientSet(p) })));
  const rows = await asPlatform(async () => (await getDb()).query<{ id: number; org_id: number; slug: string; org_name: string; pack: string; name: string; asset_key: string | null; environment: string | null;
    provider: string; status: string; access_expires_at: Date | string | null; connected_by: string | null; created_at: Date | string; refreshed_at: Date | string | null; last_error: string | null }>(
    `/* tenant: admin-only (platform staff): every workspace's connections */ SELECT c.id, c.org_id, o.slug, o.name AS org_name, c.pack, c.name, c.asset_key, c.environment, c.provider, c.status,
            c.access_expires_at, c.connected_by, c.created_at, c.refreshed_at, c.last_error
       FROM workspace_oauth_connections c JOIN organizations o ON o.id = c.org_id ORDER BY c.created_at DESC LIMIT 500`));
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return { redirect_uri: redirectUri(), providers, connections: rows.map((r) => ({ id: r.id, workspace: { id: r.org_id, slug: r.slug, name: r.org_name }, pack: r.pack, name: r.name,
    asset: r.asset_key, environment: r.environment, provider: r.provider, status: r.status, expires_at: iso(r.access_expires_at), connected_by: r.connected_by,
    connected_at: iso(r.created_at), refreshed_at: iso(r.refreshed_at), last_error: r.last_error })) };
}
/** Staff remove one connection by its id (the provider is told). */
export async function adminDisconnect(id: number): Promise<{ removed: boolean; revoked_at_provider: boolean }> {
  const [r] = await asPlatform(async () => (await getDb()).query<{ org_id: number; pack: string; name: string; asset_key: string | null; environment: string | null }>(
    "/* tenant: admin-only (platform staff): one connection by id */ SELECT org_id, pack, name, asset_key, environment FROM workspace_oauth_connections WHERE id = $1", [id]));
  if (!r) return { removed: false, revoked_at_provider: false };
  return disconnect(r.org_id, { pack: r.pack, name: r.name, asset: r.asset_key, environment: r.environment });
}
