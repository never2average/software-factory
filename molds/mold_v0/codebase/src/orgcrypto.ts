/**
 * Per-organization encryption of private text at rest (docs/security.md): the personas and task prompts an
 * organization brings are stored encrypted with that organization's own data key (AES-256-GCM). The data key is kept
 * only wrapped by the vault master key (OCTILLION_VAULT_KEY, src/keyvault.ts), in org_keys. Deleting the
 * organization deletes its key, so its private text in the database cannot be read any more.
 *
 * A database dump alone (without the master key) does not reveal private text. Hourly dumps still hold the wrapped
 * key until they expire, so crypto-shredding is complete only once those age out (30 days).
 *
 * Sealed values look like `enc:v1:<iv>:<tag>:<ciphertext>` (base64 parts); anything else is returned as is, so rows
 * written before encryption keep working.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { decrypt, encrypt, vaultUnlocked } from "./keyvault.js";

const PREFIX = "enc:v1:";
const keys = new Map<number, Buffer>();

async function dataKey(orgId: number, create: boolean): Promise<Buffer | null> {
  const hit = keys.get(orgId);
  if (hit) return hit;
  const db = await getDb();
  const load = async () => (await db.query<{ wrapped: { ciphertext: string; iv: string; tag: string; key_id: string } }>(
    "SELECT wrapped FROM org_keys WHERE org_id = $1", [orgId]))[0];
  let row = await load();
  if (!row && create) {
    await db.query("INSERT INTO org_keys (org_id, wrapped) VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING",
      [orgId, JSON.stringify(encrypt(randomBytes(32).toString("base64")))]);
    row = await load();
  }
  if (!row) return null;
  const key = Buffer.from(decrypt(row.wrapped), "base64");
  keys.set(orgId, key);
  return key;
}

export const isSealed = (v: unknown): v is string => typeof v === "string" && v.startsWith(PREFIX);

/** Load (or create) the organization's key before a transaction, so seal() inside it needs no query. */
export async function ensureOrgKey(orgId: number): Promise<void> {
  if (vaultUnlocked()) await dataKey(orgId, true);
}

/** Encrypt `text` with the organization's data key (created on first use). Plain text when the vault is locked (dev). */
export async function seal(orgId: number, text: string): Promise<string> {
  if (!vaultUnlocked() || !text) return text;
  const key = (await dataKey(orgId, true))!;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt a sealed value of this organization (non-sealed values pass through). */
export async function open(orgId: number, value: string): Promise<string> {
  if (!isSealed(value)) return value;
  const key = await dataKey(orgId, false);
  if (!key) return "[private text unavailable: the organization's key was deleted]";
  const [iv, tag, ct] = value.slice(PREFIX.length).split(":");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64"));
  d.setAuthTag(Buffer.from(tag!, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct!, "base64")), d.final()]).toString("utf8");
}

/** JSON objects (persona attributes) are sealed as {"_sealed": "enc:v1:..."}. */
export async function sealJson(orgId: number, v: Record<string, unknown>): Promise<Record<string, unknown>> {
  return vaultUnlocked() && Object.keys(v).length ? { _sealed: await seal(orgId, JSON.stringify(v)) } : v;
}
export async function openJson(orgId: number, v: unknown): Promise<Record<string, unknown>> {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return isSealed(o._sealed) ? JSON.parse(await open(orgId, o._sealed)) : o;
}

/** Open the given text fields of rows belonging to one organization (in place) and return them. */
export async function openRows<T extends Record<string, any>>(orgId: number, rows: T[], fields: (keyof T)[]): Promise<T[]> {
  for (const r of rows) for (const f of fields) if (isSealed(r[f])) (r as any)[f] = await open(orgId, r[f]);
  return rows;
}

/** Forget a cached data key (organization deletion). */
export function forgetOrgKey(orgId: number): void { keys.delete(orgId); }

/** Re-wrap every data key under the current master key (called by keyvault rekey). */
export async function rewrapOrgKeys(): Promise<number> {
  const db = await getDb();
  const rows = await db.query<{ org_id: number; wrapped: { ciphertext: string; iv: string; tag: string; key_id: string } }>("SELECT org_id, wrapped FROM org_keys");
  for (const r of rows) await db.query("UPDATE org_keys SET wrapped = $2 WHERE org_id = $1", [r.org_id, JSON.stringify(encrypt(decrypt(r.wrapped)))]);
  return rows.length;
}
