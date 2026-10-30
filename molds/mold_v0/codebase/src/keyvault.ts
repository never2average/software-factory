import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { asPlatform } from "./tenant-scope.js";
import { ENV } from "./env-names.js";

/**
 * Key vault: provider credentials (Anthropic, OpenAI, boat.dev, ...) encrypted at rest with AES-256-GCM.
 *
 * The master key comes from APP_VAULT_KEY (32 bytes, base64 or hex; generate with
 * `openssl rand -base64 32`). Only ciphertext, IV, auth tag, the master key's id and a display hint are stored.
 * Plaintext leaves this module only to the gateway (injected upstream) or the broker (direct-mode vendors).
 * Rotate the master key by setting APP_VAULT_KEY_PREVIOUS to the old key and running `npm run keyvault -- rekey`.
 */

export interface ProviderRow {
  slug: string; mode: "gateway" | "direct"; upstream_url: string | null; auth_header: string; auth_prefix: string;
  env_vars: string[]; enabled: boolean;
  /** direct = forward to upstream_url; vertex = Anthropic Messages via Google Cloud Vertex AI (src/vertex.ts). */
  backend: "direct" | "vertex"; backend_config: { project_id?: string; region?: string; model_map?: Record<string, string>; endpoint?: string };
}

function parseKey(v: string | undefined): Buffer | null {
  if (!v) return null;
  const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (buf.length !== 32) throw new Error("APP_VAULT_KEY must be 32 bytes (base64 or hex); generate with `openssl rand -base64 32`");
  return buf;
}
const keyId = (k: Buffer) => createHash("sha256").update(k).digest("hex").slice(0, 12);

function masterKeys() {
  const current = parseKey(ENV.APP_VAULT_KEY);
  if (!current) throw new Error("The key vault is locked: set APP_VAULT_KEY (openssl rand -base64 32)");
  const previous = parseKey(ENV.APP_VAULT_KEY_PREVIOUS);
  const byId = new Map([[keyId(current), current]]);
  if (previous) byId.set(keyId(previous), previous);
  return { current, currentId: keyId(current), byId };
}

export const vaultUnlocked = () => Boolean(ENV.APP_VAULT_KEY);

/**
 * Bumped by every change this process makes to the vault (a key stored, replaced, turned on or off, deleted; a provider
 * changed; a rekey). A cache of something read from the vault (src/storage.ts: the object store's client) compares it
 * and drops itself when it moved, so a change on /admin takes effect at once on this instance (others: their TTL).
 */
let generation = 0;
export const vaultGeneration = () => generation;

/**
 * A key for one purpose derived from the current master key (mold_v0-014: the signed state of a sign-in in flight). Never
 * stored; rotating APP_VAULT_KEY changes it (states in flight then fail and are started again).
 */
export function derivedKey(purpose: string): Buffer {
  return createHmac("sha256", masterKeys().current).update(`derived/v1/${purpose}`).digest();
}

export function encrypt(plaintext: string) {
  const { current, currentId } = masterKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), key_id: currentId };
}

export function decrypt(row: { ciphertext: string; iv: string; tag: string; key_id: string }): string {
  const key = masterKeys().byId.get(row.key_id);
  if (!key) throw new Error(`Credential was encrypted with master key ${row.key_id}, which is not loaded (set APP_VAULT_KEY_PREVIOUS?)`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function hint(secret: string): string {
  // Google service-account keys: show the account only, never fragments of the JSON.
  if (secret.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(secret) as { client_email?: string };
      if (j.client_email) return j.client_email;
    } catch { /* not JSON: fall through */ }
    return "JSON credential";
  }
  return secret.length <= 10 ? "…" : `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

/** The vault provider that holds Google Cloud service-account keys for Claude (and Gemini) on Vertex AI. */
export const VERTEX_PROVIDER = "vertex";
/** Label of a key imported from a server environment variable (src/keyvault-env.ts). */
export const ENV_IMPORT_LABEL = "imported from environment";

export interface ServiceAccountInfo { project_id: string; client_email: string }
/**
 * A Google service-account JSON key, checked: valid JSON, type service_account, and project_id, client_email and
 * private_key present. Errors never quote the key.
 */
export function checkServiceAccount(secret: string): ServiceAccountInfo {
  let j: Record<string, unknown>;
  try { j = JSON.parse(secret); } catch { throw new Error("That is not valid JSON: paste the whole service-account key file from Google Cloud"); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("That is not a service-account key file");
  if (j.type !== "service_account") throw new Error('That is not a service-account key: "type" must be "service_account"');
  for (const f of ["project_id", "client_email", "private_key"] as const)
    if (typeof j[f] !== "string" || !(j[f] as string).trim()) throw new Error(`The service-account key has no ${f}`);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(j.private_key as string)) throw new Error("The service-account key's private_key is not a PEM key");
  return { project_id: j.project_id as string, client_email: j.client_email as string };
}

/** The vault provider that holds the object store's settings (src/storage.ts): one entry, four fields. */
export const OBJECT_STORAGE_PROVIDER = "object_storage";
/** Its one entry's label. */
export const OBJECT_STORAGE_LABEL = "default";
export const OBJECT_STORAGE_FIELDS = ["bucket", "endpoint", "access_key_id", "secret_access_key"] as const;
export interface ObjectStorageSettings { bucket: string; endpoint: string; access_key_id: string; secret_access_key: string }
export interface ObjectStorageInfo { bucket: string; endpoint: string; access_key_hint: string }

/**
 * "https://<account>.r2.cloudflarestorage.com" from what was pasted: a trailing slash dropped, and the bucket's own name
 * after it (Cloudflare's dashboard shows the S3 API address with the bucket at the end); throws in words.
 */
export function checkEndpoint(v: string, bucket?: string): string {
  let u: URL;
  try { u = new URL(v.trim()); } catch { throw new Error("endpoint: the bucket service's address, e.g. https://<account id>.r2.cloudflarestorage.com"); }
  // Plain http only on this machine (a test stand-in): the keys must never cross a network in the clear.
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("endpoint: must start with https://");
  if (u.username || u.password) throw new Error("endpoint: give the address without a user name or password in it");
  if (u.search || u.hash) throw new Error("endpoint: give the address without ? or # parts");
  const path = u.pathname.replace(/\/+$/, "");
  if (path && !(bucket && path === `/${bucket}`)) throw new Error("endpoint: give the service's address only, without the bucket or a path (e.g. https://<account id>.r2.cloudflarestorage.com)");
  return `${u.protocol}//${u.host}`;
}

/**
 * The object store's settings, checked: a bucket name as S3 and R2 allow it, an https endpoint, an access key id and a
 * secret access key. Accepts the JSON the vault stores or an object. Errors name the field, never quote a key.
 */
export function checkObjectStorage(input: unknown): ObjectStorageSettings {
  let j: Record<string, unknown>;
  if (typeof input === "string") {
    try { j = JSON.parse(input); } catch { throw new Error("Object storage takes four fields: bucket, endpoint, access_key_id and secret_access_key"); }
  } else j = (input ?? {}) as Record<string, unknown>;
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new Error("Object storage takes four fields: bucket, endpoint, access_key_id and secret_access_key");
  const extra = Object.keys(j).filter((k) => !(OBJECT_STORAGE_FIELDS as readonly string[]).includes(k));
  if (extra.length) throw new Error(`Object storage has no field ${extra[0]!.slice(0, 40)}`);
  const text = (k: string) => (typeof j[k] === "string" ? (j[k] as string).trim() : "");
  const bucket = text("bucket"), endpoint = text("endpoint"), id = text("access_key_id"), secret = text("secret_access_key");
  if (!bucket) throw new Error("bucket: the bucket's name is required");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw new Error("bucket: 3 to 63 lowercase letters, digits, dots and dashes (the bucket's name, not its address)");
  if (!endpoint) throw new Error("endpoint: the bucket service's address is required");
  if (!id) throw new Error("access_key_id: the access key id is required");
  if (id.length < 8 || id.length > 256 || /\s/.test(id)) throw new Error("access_key_id: 8 to 256 characters, no spaces");
  if (!secret) throw new Error("secret_access_key: the secret access key is required");
  if (secret.length < 8 || secret.length > 1024 || /\s/.test(secret)) throw new Error("secret_access_key: 8 to 1024 characters, no spaces");
  return { bucket, endpoint: checkEndpoint(endpoint, bucket), access_key_id: id, secret_access_key: secret };
}
/** What may be shown of the settings: the bucket, the endpoint and the access key id's hint. Never the secret. */
export const objectStorageInfo = (c: ObjectStorageSettings): ObjectStorageInfo => ({ bucket: c.bucket, endpoint: c.endpoint, access_key_hint: hint(c.access_key_id) });
const objectStorageHint = (c: ObjectStorageSettings) => `${c.bucket} at ${new URL(c.endpoint).host}`;

// ---------- providers ----------

export async function listProviders(): Promise<ProviderRow[]> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
  return (await getDb()).query<ProviderRow>("SELECT slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled, backend, backend_config FROM vault_providers ORDER BY slug");
});
}

export async function getProvider(slug: string): Promise<ProviderRow | null> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
  const [row] = await (await getDb()).query<ProviderRow>(
    "SELECT slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled, backend, backend_config FROM vault_providers WHERE slug = $1",
    [slug],
  );
  return row ?? null;
});
}

export async function upsertProvider(p: Partial<ProviderRow> & { slug: string }) {
  if (!/^[a-z0-9_]{2,40}$/.test(p.slug)) throw new Error("provider slug must be lowercase letters, digits or _");
  if (p.mode && !["gateway", "direct"].includes(p.mode)) throw new Error("mode must be gateway or direct");
  if (p.upstream_url && !/^https?:\/\//.test(p.upstream_url)) throw new Error("upstream_url must be http(s)");
  if (p.backend && !["direct", "vertex"].includes(p.backend)) throw new Error("backend must be direct or vertex");
  if (p.backend === "vertex") {
    const c = p.backend_config ?? {};
    // project_id and region are optional: by default the project comes from the service-account key and the region
    // from the VERTEX_REGION setting (Agent configuration).
    if (c.project_id && !/^[a-z][a-z0-9-]{4,29}$/.test(c.project_id)) throw new Error("backend_config.project_id must be a GCP project id");
    if (c.region && !/^[a-z0-9-]{2,30}$/.test(c.region)) throw new Error("backend_config.region must be global, us, eu or a region like us-east5");
  }
  await (await getDb()).query(
    `INSERT INTO vault_providers (slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled, backend, backend_config)
     VALUES ($1, coalesce($2, 'gateway'), $3, coalesce($4, 'authorization'), coalesce($5, 'Bearer '), coalesce($6::text[], '{}'), coalesce($7, true),
             coalesce($8, 'direct'), coalesce($9::jsonb, '{}'))
     ON CONFLICT (slug) DO UPDATE SET mode = coalesce($2, vault_providers.mode), upstream_url = coalesce($3, vault_providers.upstream_url),
       auth_header = coalesce($4, vault_providers.auth_header), auth_prefix = coalesce($5, vault_providers.auth_prefix),
       env_vars = coalesce($6::text[], vault_providers.env_vars), enabled = coalesce($7, vault_providers.enabled),
       backend = coalesce($8, vault_providers.backend), backend_config = coalesce($9::jsonb, vault_providers.backend_config), updated_at = now()`,
    [p.slug, p.mode ?? null, p.upstream_url ?? null, p.auth_header?.toLowerCase() ?? null, p.auth_prefix ?? null, p.env_vars ?? null, p.enabled ?? null,
     p.backend ?? null, p.backend_config ? JSON.stringify(p.backend_config) : null],
  );
  generation++;
  return getProvider(p.slug);
}

/** Providers that satisfy a list of required env var names (registry `requires_env`). */
export async function providersForEnv(envVars: string[]): Promise<ProviderRow[]> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
  if (!envVars.length) return [];
  return (await getDb()).query<ProviderRow>(
    "SELECT slug, mode, upstream_url, auth_header, auth_prefix, env_vars, enabled, backend, backend_config FROM vault_providers WHERE enabled AND env_vars && $1 ORDER BY slug",
    [envVars],
  );
});
}

// ---------- credentials ----------

export interface SavedCredential { id: number; provider: string; label: string; hint: string; project_id?: string; client_email?: string; bucket?: string; endpoint?: string }

/** Store a key (the same provider + label replaces that key). */
export async function setCredential(provider: string, secret: string, opts: { label?: string; priority?: number } = {}): Promise<SavedCredential> {
  return (await storeCredential(provider, secret, opts, false))!;
}
/** Store a key only when the provider has none under that label (never overwrites); null when one was there. */
export const addCredentialIfAbsent = (provider: string, secret: string, opts: { label?: string; priority?: number } = {}) =>
  storeCredential(provider, secret, opts, true);

async function storeCredential(provider: string, secret: string, opts: { label?: string; priority?: number }, insertOnly: boolean): Promise<SavedCredential | null> {
  const p = await getProvider(provider);
  if (!p) throw new Error(`Unknown provider ${provider}; add it first (keyvault provider ...)`);
  // A direct-mode key is handed to agent sessions as is; refuse to store one unless that is explicitly allowed.
  // Orchestrator-only keys (boat, vertex; search providers with no env_vars) never reach a session, so they are always fine.
  if (p.mode === "direct" && provider !== "boat" && p.env_vars.length && ENV.APP_DIRECT_KEYS !== "allow")
    throw new Error(`${provider} is a direct-mode provider: its real key would be handed to agent sessions. ` +
                    "Set APP_DIRECT_KEYS=allow only once those sessions run without customer-written tasks (docs/security.md)");
  let s = secret.trim();
  if (s.length < 8) throw new Error("That does not look like a credential");
  let label = opts.label ?? (provider === VERTEX_PROVIDER ? VERTEX_LABEL : "default");
  // Object storage: one entry of four fields (src/storage.ts), stored as their JSON, checked, under its one label.
  let objectInfo: ObjectStorageInfo | null = null, display: string | null = null;
  if (provider === OBJECT_STORAGE_PROVIDER) {
    const c = checkObjectStorage(s);
    s = JSON.stringify(c);
    label = OBJECT_STORAGE_LABEL;
    objectInfo = objectStorageInfo(c);
    display = objectStorageHint(c);
  }
  // Service-account keys: the Vertex provider's are checked in full; another provider's "vertex" key at least parses.
  let meta: ServiceAccountInfo | null = null;
  if (provider === VERTEX_PROVIDER) meta = checkServiceAccount(s);
  else if (label === VERTEX_LABEL) {
    let j: { client_email?: string; private_key?: string; project_id?: string };
    try { j = JSON.parse(s); } catch { throw new Error("A key labelled vertex must be a Google service-account JSON key"); }
    if (!j?.client_email || !j?.private_key) throw new Error("The service-account key has no client_email or private_key");
    meta = { project_id: j.project_id ?? "", client_email: j.client_email };
  }
  const enc = encrypt(s);
  const shown = display ?? hint(s), metaJson = meta ? JSON.stringify(meta) : objectInfo ? JSON.stringify(objectInfo) : null;
  const db = await getDb();
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO vault_credentials (provider, label, ciphertext, iv, tag, key_id, hint, priority, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (provider, label) DO ${insertOnly ? "NOTHING" : `UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
       key_id = excluded.key_id, hint = excluded.hint, priority = excluded.priority, meta = excluded.meta, enabled = true, rotated_at = now()`}
     RETURNING id`,
    [provider, label, enc.ciphertext, enc.iv, enc.tag, enc.key_id, shown, opts.priority ?? 0, metaJson],
  );
  if (!row) return null; // insertOnly and that label already exists: left alone
  generation++;
  return { id: row.id, provider, label, hint: shown, ...(meta ? { project_id: meta.project_id, client_email: meta.client_email } : {}),
           ...(objectInfo ? { bucket: objectInfo.bucket, endpoint: objectInfo.endpoint } : {}) };
}

export async function listCredentials() {
  return (await getDb()).query(
    `SELECT id, provider, label, hint, priority, enabled, uses, last_used_at, created_at, rotated_at, key_id, meta
       FROM vault_credentials ORDER BY provider, priority DESC, label`,
  );
}

export async function setCredentialEnabled(id: number, enabled: boolean) {
  const [row] = await (await getDb()).query("UPDATE vault_credentials SET enabled = $2 WHERE id = $1 RETURNING id", [id, enabled]);
  if (!row) throw new Error(`No credential ${id}`);
  generation++;
}

export async function deleteCredential(id: number) {
  const [row] = await (await getDb()).query("DELETE FROM vault_credentials WHERE id = $1 RETURNING id", [id]);
  if (!row) throw new Error(`No credential ${id}`);
  generation++;
}

/**
 * One entry's secret, opened without counting it as a use (an edit that keeps the fields it was not given, a Test).
 * Null when there is none. Turned-off entries too unless `enabledOnly`.
 */
export async function readCredential(provider: string, label: string, opts: { enabledOnly?: boolean } = {}): Promise<{ id: number; enabled: boolean; secret: string } | null> {
  return asPlatform(async () => {
    const [row] = await (await getDb()).query<{ id: number; enabled: boolean; ciphertext: string; iv: string; tag: string; key_id: string }>(
      `SELECT id, enabled, ciphertext, iv, tag, key_id FROM vault_credentials WHERE provider = $1 AND label = $2${opts.enabledOnly ? " AND enabled" : ""}`, [provider, label]);
    return row ? { id: row.id, enabled: row.enabled, secret: decrypt(row) } : null;
  });
}

/**
 * The secret to use for a provider now: highest priority first, least recently used among equals (spreads load
 * and rate limits across several keys). Throws when none is configured.
 */
/** Label of the Google service-account key a provider uses when its backend is Vertex AI. */
export const VERTEX_LABEL = "vertex";

export async function useCredential(provider: string, opts: { label?: string; excludeLabel?: string } = {}): Promise<{ id: number; secret: string }> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
  const db = await getDb();
  const [row] = await db.query<{ id: number; ciphertext: string; iv: string; tag: string; key_id: string }>(
    `UPDATE vault_credentials SET uses = uses + 1, last_used_at = now()
      WHERE id = (SELECT id FROM vault_credentials WHERE provider = $1 AND enabled
                     AND ($2::text IS NULL OR label = $2) AND ($3::text IS NULL OR label <> $3)
                   ORDER BY priority DESC, last_used_at ASC NULLS FIRST, id LIMIT 1)
      RETURNING id, ciphertext, iv, tag, key_id`,
    [provider, opts.label ?? null, opts.excludeLabel ?? null],
  );
  if (!row) throw Object.assign(new Error(opts.label === VERTEX_LABEL
    ? `No Vertex service-account key for ${provider}: store one with label "${VERTEX_LABEL}" (keyvault set ${provider} --label ${VERTEX_LABEL} < key.json)`
    : `No ${provider} credential in the vault`), { status: 503 });
  return { id: row.id, secret: decrypt(row) };
});
}

/**
 * The Google service-account key a Vertex backend signs in with: backend_config.credential_provider's "vertex" key
 * when one is named, else the provider's own "vertex" key (older setups), else the vault's Vertex AI provider.
 */
export async function useVertexCredential(slug: string, credentialProvider?: string): Promise<{ id: number; secret: string }> {
  // The vault is platform data, out of a tenant's reach (src/tenant-scope.ts): read as the platform.
  return asPlatform(async () => {
  if (credentialProvider && credentialProvider !== VERTEX_PROVIDER) return useCredential(credentialProvider, { label: VERTEX_LABEL });
  if (!credentialProvider && slug !== VERTEX_PROVIDER) {
    const own = await useCredential(slug, { label: VERTEX_LABEL }).catch(() => null);
    if (own) return own;
  }
  return useCredential(VERTEX_PROVIDER).catch(() => {
    throw Object.assign(new Error("No Vertex service-account key in the vault: add one to the Vertex AI provider on Key vault"), { status: 503 });
  });
});
}

/** Re-encrypt every credential with the current master key (after rotating APP_VAULT_KEY). */
export async function rekey() {
  const db = await getDb();
  const { currentId } = masterKeys();
  const rows = await db.query<{ id: number; ciphertext: string; iv: string; tag: string; key_id: string }>(
    "SELECT id, ciphertext, iv, tag, key_id FROM vault_credentials WHERE key_id <> $1", [currentId]);
  for (const r of rows) {
    const enc = encrypt(decrypt(r));
    await db.query("UPDATE vault_credentials SET ciphertext = $2, iv = $3, tag = $4, key_id = $5 WHERE id = $1", [r.id, enc.ciphertext, enc.iv, enc.tag, enc.key_id]);
  }
  generation++;
  // Organizations' data keys (src/orgcrypto.ts) are wrapped by the master key too.
  await (await import("./orgcrypto.js")).rewrapOrgKeys();
  return rows.length;
}
