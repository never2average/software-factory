/**
 * Private catalogs (mold_v0-260, flag private_catalogs; molds/mold_v0/MOLD.md "Generic gaps"): a shared catalog area
 * indexed from a private repository, pinned to its commit as a public one is (src/data-repositories.ts
 * syncUpstreamCatalog). A pack says only how it is read (`repositories.<name>.access`: "deploy_key" or "github_app");
 * what opens it is the platform's, set by staff in Admin › Key vault (Private catalogs), never in a pack:
 *
 *   deploy_key   an SSH private key with read access to that one repository, and its host's public key (one
 *                known_hosts line: the host is checked, never trusted on first use). The fetch runs git over SSH with
 *                that key alone (src/data-repositories.ts gitSource): the key is written 0600 into the fetch's own
 *                private directory and removed once the commit is fetched.
 *   github_app   the number of the platform's own installation of its GitHub App (the app's settings are the key vault's
 *                GitHub App entry, src/github-app.ts). Each fetch mints a token for that one repository with read
 *                contents only, sends it in a header (never in an address), and revokes it when the fetch is done.
 *
 * Kept as one sealed entry of the key vault per repository (provider catalog_access, label "<pack>/<repository>"). No
 * answer, log line or error ever carries a key or a token: staff read back which method is set, a fingerprint of the
 * key, the host its known_hosts line names, or the installation's number.
 */
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { decrypt, encrypt } from "./keyvault.js";
import { PackError, RepositorySchema } from "./pack-api.js";
import { packs } from "./packs.js";
import { asPlatform } from "./tenant-scope.js";

export const CATALOG_ACCESS_PROVIDER = "catalog_access";
export type CatalogAccessKind = "deploy_key" | "github_app";
export interface PrivateCatalog { pack: string; name: string; label: string; access: CatalogAccessKind; repo: string | null; host: string | null }

/** Every upstream catalog of the build read with a deploy key or the GitHub App, in pack order. */
export function privateCatalogs(): PrivateCatalog[] {
  return packs().flatMap((p) => Object.entries(p.definition.repositories ?? {}).flatMap(([name, raw]) => {
    const r = RepositorySchema.safeParse(raw);
    if (!r.success || r.data.kind !== "upstream_catalog") return [];
    const access = (r.data as { access?: string }).access;
    if (access !== "deploy_key" && access !== "github_app") return [];
    const up = typeof r.data.upstream === "object" ? r.data.upstream : (p.definition as { upstream?: { repo?: string } }).upstream ?? null;
    const repo = up && typeof up.repo === "string" ? up.repo : null;
    return [{ pack: p.id, name, label: r.data.label ?? name, access, repo, host: repo ? hostOf(repo) : null }];
  }));
}
const hostOf = (repo: string) => { const m = /^(?:ssh:\/\/git@|https:\/\/)([a-z0-9.-]+)(?::\d+)?\//i.exec(repo); return m ? m[1]!.toLowerCase() : null; };
const catalogOf = (pack: unknown, name: unknown) => {
  const c = privateCatalogs().find((x) => x.pack === pack && x.name === name);
  if (!c) throw new PackError("no private catalog by that name", 404);
  return c;
};
const labelOf = (c: Pick<PrivateCatalog, "pack" | "name">) => `${c.pack}/${c.name}`;

interface Stored { kind: CatalogAccessKind; private_key?: string; known_hosts?: string; installation_id?: string }

async function readStored(c: Pick<PrivateCatalog, "pack" | "name">): Promise<Stored | null> {
  const [r] = await asPlatform(async () => (await getDb()).query<{ ciphertext: string; iv: string; tag: string; key_id: string }>(
    "SELECT ciphertext, iv, tag, key_id FROM vault_credentials WHERE provider = $1 AND label = $2 AND enabled", [CATALOG_ACCESS_PROVIDER, labelOf(c)]));
  if (!r) return null;
  try { return JSON.parse(decrypt(r)) as Stored; }
  catch { throw new PackError("the catalog's access cannot be opened now (the key vault is locked?): try again", 503); }
}

const KEY = /^-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+\n-----END \1 PRIVATE KEY-----\n?$/;
const KNOWN = /^(\S+) (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) ([A-Za-z0-9+/]+={0,3})$/;
/** A key's fingerprint as staff see it: never the key (a hash of it, 12 characters). */
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

/**
 * Set (or replace) a catalog's access (staff with "keys"): a deploy key and its host's known_hosts line, or the
 * installation's number, as the catalog's declared method takes. Each is checked; an error never quotes what was given.
 */
export async function setCatalogAccess(pack: unknown, name: unknown, input: Record<string, unknown>) {
  const c = catalogOf(pack, name);
  const extra = Object.keys(input ?? {}).filter((k) => !["private_key", "known_hosts", "installation_id"].includes(k));
  if (extra.length) throw new PackError(`unknown setting ${extra[0]!.slice(0, 40)}`, 400);
  let stored: Stored;
  if (c.access === "deploy_key") {
    const key = typeof input.private_key === "string" ? input.private_key.replace(/\r\n/g, "\n").trim() + "\n" : "";
    if (key.length > 16 * 1024 || !KEY.test(key)) throw new PackError("private_key: the deploy key's private part, the whole file (-----BEGIN OPENSSH PRIVATE KEY----- ... -----END OPENSSH PRIVATE KEY-----)", 400);
    if (/ENCRYPTED|Proc-Type: 4,ENCRYPTED/.test(key)) throw new PackError("private_key: the key has a passphrase: make one without (ssh-keygen -N '')", 400);
    const kh = typeof input.known_hosts === "string" ? input.known_hosts.trim() : "";
    const m = KNOWN.exec(kh);
    if (!m || kh.length > 4096) throw new PackError("known_hosts: one line of the host's public key, as `ssh-keyscan <host>` prints it (<host> <type> <key>)", 400);
    const hosts = m[1]!.toLowerCase().split(",").map((h) => h.replace(/^\[([^\]]+)\](:\d+)?$/, "$1"));
    if (c.host && !hosts.includes(c.host)) throw new PackError(`known_hosts: the line is for ${hosts.join(", ").slice(0, 120)}, not ${c.host} (the repository's host)`, 400);
    stored = { kind: "deploy_key", private_key: key, known_hosts: kh };
  } else {
    const id = typeof input.installation_id === "string" || typeof input.installation_id === "number" ? String(input.installation_id).trim() : "";
    if (!/^[0-9]{1,12}$/.test(id)) throw new PackError("installation_id: the number at the end of the installation's address on GitHub (…/settings/installations/<number>)", 400);
    stored = { kind: "github_app", installation_id: id };
  }
  const enc = encrypt(JSON.stringify(stored));
  const hint = stored.kind === "deploy_key" ? `deploy key ${fingerprint(stored.private_key!)}` : `installation ${stored.installation_id}`;
  await asPlatform(async () => (await getDb()).query(
    `INSERT INTO vault_credentials (provider, label, ciphertext, iv, tag, key_id, hint, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
     ON CONFLICT (provider, label) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
       key_id = excluded.key_id, hint = excluded.hint, enabled = true, rotated_at = now()`,
    [CATALOG_ACCESS_PROVIDER, labelOf(c), enc.ciphertext, enc.iv, enc.tag, enc.key_id, hint]));
  return (await catalogAccessSummary()).find((x) => x.pack === c.pack && x.name === c.name)!;
}

/** Remove a catalog's access (staff with "keys"): its next index is refused until it is set again. */
export async function deleteCatalogAccess(pack: unknown, name: unknown): Promise<boolean> {
  const c = catalogOf(pack, name);
  return (await asPlatform(async () => (await getDb()).query("DELETE FROM vault_credentials WHERE provider = $1 AND label = $2 RETURNING id", [CATALOG_ACCESS_PROVIDER, labelOf(c)]))).length > 0;
}

/** What staff see (Admin › Key vault, Private catalogs): each catalog, its method, whether it is set and a hint. Never a key. */
export async function catalogAccessSummary() {
  const rows = await asPlatform(async () => (await getDb()).query<{ label: string; hint: string; created_at: Date; rotated_at: Date | null }>(
    "SELECT label, hint, created_at, rotated_at FROM vault_credentials WHERE provider = $1 AND enabled", [CATALOG_ACCESS_PROVIDER]));
  return privateCatalogs().map((c) => {
    const r = rows.find((x) => x.label === labelOf(c));
    return { ...c, set: !!r, hint: r?.hint ?? null, updated_at: r ? new Date(r.rotated_at ?? r.created_at).toISOString() : null };
  });
}

/** What a fetch of the catalog uses: the key and its host's line, or a token for the one repository (and how to revoke it). */
export type CatalogAuth =
  | { kind: "deploy_key"; private_key: string; known_hosts: string }
  | { kind: "github_app"; token: string; revoke: () => Promise<void> };

/**
 * The access a fetch of `pack`/`name` uses now. Refused (409) while the flag is off or nothing is set in the key vault,
 * saying where to set it; never a key in the message.
 */
export async function catalogAuth(pack: string, name: string): Promise<CatalogAuth> {
  const { featureOn } = await import("./features.js");
  const c = catalogOf(pack, name);
  if (!featureOn("private_catalogs")) throw new PackError(`repository ${name} is private (${c.access === "deploy_key" ? "a deploy key" : "the GitHub App"}): turn on features.private_catalogs to index it`, 409);
  const s = await readStored(c);
  if (!s || s.kind !== c.access) throw new PackError(`repository ${name} is private and its ${c.access === "deploy_key" ? "deploy key" : "GitHub App installation"} is not set: Admin › Key vault, Private catalogs`, 409);
  if (s.kind === "deploy_key") return { kind: "deploy_key", private_key: s.private_key!, known_hosts: s.known_hosts! };
  const m = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/([A-Za-z0-9._-]+?)(\.git)?$/.exec(c.repo ?? "");
  if (!m) throw new PackError(`repository ${name}: the GitHub App reads https://github.com/<owner>/<name> repositories`, 400);
  const { installationTokenForCatalog } = await import("./github-app.js");
  return { kind: "github_app", ...(await installationTokenForCatalog(Number(s.installation_id), m[1]!)) };
}
