/**
 * Agent-side twin of `lib/secret-crypto.ts` — same AES-256-GCM envelope with the
 * SAME `OPS_SECRETS_KEY`, so a credential the front-end ENCRYPTS (when an
 * operator stores it) the AGENT can DECRYPT here, inside a tool's execute(),
 * without the plaintext ever crossing a route boundary or entering the model's
 * context. (agent/lib can't import from the Next front-end's lib/, hence the
 * duplicate; keep the two in lockstep.)
 *
 * decrypt only — the agent never needs to seal a secret.
 */
import { createDecipheriv, hkdfSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** HKDF info label — must be byte-identical to lib/secret-crypto.ts. */
const HKDF_INFO = "ops-connector-secret-v1";

/**
 * Versioned keyring — must match lib/secret-crypto.ts exactly. `OPS_SECRETS_KEY`
 * is version 1; `OPS_SECRETS_KEY_V2`, `_V3`, … follow. Every stored secret
 * records its version, so the agent can still read rows sealed under an older
 * key while new writes use the newest one.
 */
const KEY_ENV = (version: number): string =>
  version === 1 ? "OPS_SECRETS_KEY" : `OPS_SECRETS_KEY_V${version}`;

function baseKeyForVersion(version: number): Buffer {
  const envName = KEY_ENV(version);
  const raw = process.env[envName];
  if (!raw) {
    throw new Error(
      version === 1
        ? "OPS_SECRETS_KEY is not set on the agent — cannot decrypt stored credentials."
        : `${envName} is not set on the agent, but a stored secret was sealed with key version ${version}.`,
    );
  }
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === KEY_BYTES) return b64;
  const hex = Buffer.from(raw, "hex");
  if (hex.length === KEY_BYTES) return hex;
  throw new Error(`${envName} must decode to ${KEY_BYTES} bytes (base64 or hex).`);
}

/**
 * The AES key — per-workspace (HKDF-SHA256, salt = orgId), matching the
 * front-end twin so a credential encrypted for a workspace decrypts with that
 * workspace's derived key. The orgId is REQUIRED: the old fallback to the
 * master key produced ciphertext readable with every workspace's key, and it
 * was reached by simply forgetting an argument.
 */
/**
 * The salt for a PERSONAL connector includes its owner.
 *
 * Without this, a workspace admin with database access could decrypt a
 * colleague's personal credential using the workspace key — which would make
 * "account-level" a label rather than a boundary. Organization-level
 * connectors are unchanged (salt = orgId), so nothing existing re-encrypts.
 *
 * Changed while `connector_secrets` was EMPTY. After the first row is stored,
 * this same change means re-encrypting every one of them.
 */
function saltFor(orgId: string, ownerEmail?: string | null): string {
  return ownerEmail ? `${orgId}\u0000${ownerEmail.toLowerCase()}` : orgId;
}

function key(orgId: string, version: number): Buffer {
  if (!orgId) {
    throw new Error("A workspace id is required to derive a secret key — refusing to use the master key directly.");
  }
  const base = baseKeyForVersion(version);
  return Buffer.from(hkdfSync("sha256", base, Buffer.from(orgId, "utf8"), Buffer.from(HKDF_INFO, "utf8"), KEY_BYTES));
}

export function hasSecretsKey(): boolean {
  try {
    baseKeyForVersion(1);
    return true;
  } catch {
    return false;
  }
}

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function decryptSecret(
  sealed: SealedSecret & { keyVersion?: number | null },
  orgId: string,
  /** The connector's owner, for a personal connector. Omit for a shared one. */
  ownerEmail?: string | null,
): string {
  // No recorded version means it predates versioning, which means version 1.
  const decipher = createDecipheriv(
    ALGORITHM,
    key(saltFor(orgId, ownerEmail), sealed.keyVersion ?? 1),
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
