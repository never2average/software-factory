import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The one-time code itself.
 *
 * Six digits, because it is typed by a human from their phone. Six digits is
 * only a million possibilities, so the security does NOT come from the code's
 * length — it comes from the three things around it: a ten-minute expiry, a
 * hard cap on attempts, and single use. Those are enforced by the verify route;
 * this module only mints and compares.
 *
 * Stored as an HMAC, not a bare SHA-256. A plain hash of a six-digit code is
 * a rainbow table you can build in a second, so a leaked database row would
 * hand over the code. Keyed with OPS_SECRETS_KEY — already required, already
 * secret, and not in the database — so the rows alone are worthless. The email
 * is mixed in so the same code minted for two people yields different hashes.
 */

function pepper(): string {
  const key = process.env.OPS_SECRETS_KEY;
  if (!key) throw new Error("OPS_SECRETS_KEY is required to hash sign-in codes.");
  return key;
}

/** `randomInt` is the CSPRNG — `Math.random()` here would be a real weakness. */
export function mintLoginCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashLoginCode(email: string, code: string): string {
  return createHmac("sha256", pepper()).update(`${email.toLowerCase()}:${code}`).digest("hex");
}

/** Constant-time compare, so the response time can't be walked digit by digit. */
export function loginCodeMatches(email: string, code: string, storedHash: string): boolean {
  const expected = Buffer.from(hashLoginCode(email, code), "hex");
  const actual = Buffer.from(storedHash, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
