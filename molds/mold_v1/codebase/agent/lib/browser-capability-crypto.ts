/**
 * Encryption envelope for browser bearer capabilities (CDP + live-view URLs).
 *
 * Browserbase URLs grant control of a live browser. They must never be stored
 * in plaintext. This module intentionally uses a browser-specific HKDF info
 * label, so a ciphertext from another OPS_SECRETS_KEY consumer cannot be
 * replayed as a browser capability even within the same workspace.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const HKDF_INFO = "ops-browser-capability-v1";
const MAX_KEY_VERSION = 16;

function envName(version: number): string {
  return version === 1 ? "OPS_SECRETS_KEY" : `OPS_SECRETS_KEY_V${version}`;
}
function decodeKey(raw: string, name: string): Buffer {
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === KEY_BYTES) return b64;
  const hex = Buffer.from(raw, "hex");
  if (hex.length === KEY_BYTES) return hex;
  throw new Error(`${name} must decode to ${KEY_BYTES} bytes (base64 or hex).`);
}

function baseKey(version: number): Buffer {
  const name = envName(version);
  const raw = process.env[name];
  if (!raw) {
    throw new Error(
      `${name} is not set on the agent — browser connection capabilities cannot be persisted safely.`,
    );
  }
  return decodeKey(raw, name);
}

function currentVersion(): number {
  let latest = 1;
  for (let version = 2; version <= MAX_KEY_VERSION; version += 1) {
    if (process.env[envName(version)]) latest = version;
  }
  return latest;
}

function key(orgId: string, version: number): Buffer {
  if (!orgId) throw new Error("Browser capability encryption requires a workspace id.");
  return Buffer.from(
    hkdfSync(
      "sha256",
      baseKey(version),
      Buffer.from(orgId, "utf8"),
      Buffer.from(HKDF_INFO, "utf8"),
      KEY_BYTES,
    ),
  );
}

export interface SealedBrowserCapability {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
  readonly keyVersion: number;
}

export function sealBrowserCapability(value: string, orgId: string): SealedBrowserCapability {
  const keyVersion = currentVersion();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(orgId, keyVersion), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

export function openBrowserCapability(
  sealed: Omit<SealedBrowserCapability, "keyVersion"> & { readonly keyVersion?: number | null },
  orgId: string,
): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    key(orgId, sealed.keyVersion ?? 1),
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
