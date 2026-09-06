/**
 * Envelope encryption for operator-supplied connector secrets.
 *
 * AES-256-GCM with a key from `OPS_SECRETS_KEY` (32 bytes, base64 or hex).
 * GCM is authenticated: a tampered ciphertext fails to decrypt rather than
 * decrypting to garbage.
 *
 * Rules this module exists to enforce:
 * - There is NO plaintext fallback. If the key is missing, storing a secret
 *   fails loudly (503) instead of quietly writing a readable token to a table.
 * - `decryptSecret` exists for a runtime that needs the value back, and is
 *   deliberately NOT reachable from any API route. Nothing in `app/api/ops/*`
 *   returns a plaintext secret — the routes return "is one stored" and the
 *   last-4 hint, never the value.
 */
import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** HKDF info label — must be byte-identical in the agent-side twin. */
const HKDF_INFO = "ops-connector-secret-v1";

export class MissingSecretsKeyError extends Error {
  constructor() {
    super(
      "OPS_SECRETS_KEY is not set. Generate one with `openssl rand -base64 32` and add it to the project's environment before storing secrets.",
    );
    this.name = "MissingSecretsKeyError";
  }
}

/* -------------------------------------------------------------------------- */
/* The keyring: versioned keys, so a compromised one can be retired            */
/* -------------------------------------------------------------------------- */

/**
 * Keys are numbered. `OPS_SECRETS_KEY` is version 1; `OPS_SECRETS_KEY_V2`,
 * `_V3`, … are the ones that come after it. Every stored secret records the
 * version it was sealed under, so:
 *
 *   - adding a new key is non-breaking — old rows keep decrypting under theirs,
 *     new writes use the newest available;
 *   - rotation is a background re-encrypt (see .rotate-connector-secrets.mjs),
 *     not a flag day where everything must change at once;
 *   - retiring a key is possible at all, which it is not when one key
 *     encrypts everything forever and nothing records which key that was.
 *
 * This is key MANAGEMENT, not a KMS. The keys are still environment variables
 * on the deployment, readable by anyone with project access; nothing here is
 * hardware-backed and no operation happens inside a key service. What it buys
 * is the ability to rotate, which was previously impossible.
 */
const KEY_ENV = (version: number): string =>
  version === 1 ? "OPS_SECRETS_KEY" : `OPS_SECRETS_KEY_V${version}`;

/** Highest version we could ever look for. Bounded so a typo can't loop. */
const MAX_KEY_VERSION = 16;

function decodeKey(raw: string, envName: string): Buffer {
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === KEY_BYTES) return b64;
  const hex = Buffer.from(raw, "hex");
  if (hex.length === KEY_BYTES) return hex;
  throw new Error(`${envName} must decode to ${KEY_BYTES} bytes (base64 or hex).`);
}

/** The raw key for one version, or throw naming the variable that is missing. */
function baseKeyForVersion(version: number): Buffer {
  const envName = KEY_ENV(version);
  const raw = process.env[envName];
  if (!raw) {
    if (version === 1) throw new MissingSecretsKeyError();
    throw new Error(
      `${envName} is not set, but a stored secret was sealed with key version ${version}. ` +
        "Retiring a key requires re-encrypting the rows that used it first.",
    );
  }
  return decodeKey(raw, envName);
}

/**
 * The version NEW secrets are sealed with: the highest one that has a key.
 * Rotation is therefore "add OPS_SECRETS_KEY_V2, deploy, re-encrypt" — no code
 * change and no window where writes fail.
 */
export function currentKeyVersion(): number {
  let latest = 1;
  for (let v = 2; v <= MAX_KEY_VERSION; v += 1) {
    if (process.env[KEY_ENV(v)]) latest = v;
  }
  return latest;
}

/**
 * The AES key: PER-WORKSPACE, via HKDF-SHA256 with the workspace id as salt, so
 * one workspace's secret dump cannot decrypt another's. The master key never
 * encrypts anything directly.
 *
 * `orgId` is REQUIRED. It used to be optional, falling back to the master key
 * for pre-tenancy rows — which meant a missing org silently produced ciphertext
 * that every workspace's key could open, and the fallback looked identical to
 * the safe path at the call site. There are no such rows left (org_id is NOT
 * NULL and the count is zero), so the fallback is gone: a caller that cannot
 * name a workspace now fails instead of quietly weakening the encryption.
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
  /**
   * Last 4 characters of the plaintext — enough to recognise a token, useless
   * alone. Stored in CLEAR: it is the one part of a secret this system shows a
   * human, and it is what makes "is this the token I think it is?" answerable
   * without ever decrypting. Deliberate, and the reason it is only four.
   */
  hint: string;
  /** Which key sealed it. Stored so keys can be rotated and retired. */
  keyVersion: number;
}

export function encryptSecret(
  plaintext: string,
  orgId: string,
  /** The connector's owner, for a personal connector. Omit for a shared one. */
  ownerEmail?: string | null,
): SealedSecret {
  // New writes always take the newest key; old rows stay readable under theirs.
  const keyVersion = currentKeyVersion();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(saltFor(orgId, ownerEmail), keyVersion), iv);
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: sealed.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    hint: plaintext.slice(-4),
    keyVersion,
  };
}

export function decryptSecret(
  sealed: Omit<SealedSecret, "hint" | "keyVersion"> & { keyVersion?: number | null },
  orgId: string,
  /** The connector's owner, for a personal connector. Omit for a shared one. */
  ownerEmail?: string | null,
): string {
  // Rows written before versioning carry no version; they are version 1 by
  // definition, since version 1 is the only key that existed then.
  const version = sealed.keyVersion ?? 1;
  const decipher = createDecipheriv(ALGORITHM, key(saltFor(orgId, ownerEmail), version), Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
