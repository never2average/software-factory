/**
 * How a run's transfer through object storage is sealed (mold_v0-182; src/run-transfers.ts on the engine's side,
 * src/run-harness.ts httpRunnerClient on the runner's): AES-256-GCM with the transfer's own key, which the engine made
 * for that one transfer and handed to the runner over its API. The object in the bucket is
 *
 *   "WST1" | iv (12 bytes) | ciphertext | tag (16 bytes)        additional data: "run-transfer:v1:<transfer id>"
 *
 * so the bucket never holds a workspace's files in the clear, and an object moved under another transfer does not open.
 * Node's own modules only: the run sandbox's runner loads it (src/run-sandbox-runner.ts).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("WST1");
/** The bytes a sealed transfer adds to its content. */
export const TRANSFER_OVERHEAD = MAGIC.length + 12 + 16;
const aad = (id: string) => Buffer.from(`run-transfer:v1:${id}`, "utf8");

export const sha256Hex = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export function sealTransfer(key: Buffer, id: string, body: Buffer): Buffer {
  if (key.length !== 32) throw new Error("a transfer key is 32 bytes");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(id));
  const out = Buffer.concat([MAGIC, iv, c.update(body), c.final(), c.getAuthTag()]);
  return out;
}

/** The content of a sealed transfer; throws when it is not one, or does not open with this key and id. */
export function openTransfer(key: Buffer, id: string, sealed: Buffer): Buffer {
  if (key.length !== 32) throw new Error("a transfer key is 32 bytes");
  if (sealed.length < TRANSFER_OVERHEAD || !sealed.subarray(0, 4).equals(MAGIC)) throw new Error("not a sealed transfer");
  const d = createDecipheriv("aes-256-gcm", key, sealed.subarray(4, 16));
  d.setAAD(aad(id));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(16, sealed.length - 16)), d.final()]);
}

/** A size in words: "4.5 MB" (decimal megabytes, as the hosted platforms state their limits). */
export const sizeInWords = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} bytes`;
