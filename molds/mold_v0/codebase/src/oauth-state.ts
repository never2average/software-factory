/**
 * The signed, one-time state of a sign-in in flight (mold_v0-014): a GitHub App's install and a generic OAuth provider's
 * authorization both carry one to the provider and back. `payload.signature`: the payload names the workspace, a random
 * nonce, what it is for and when it expires; the signature is an HMAC under a key derived from the vault's master key
 * (src/keyvault.ts derivedKey), so nobody without the server's key can make or change one. The nonce is stored only as
 * its sha256 in `oauth_states` with the workspace and person it was made for (and what the return needs: the slot, a
 * sealed PKCE verifier), ten minutes, used once.
 *
 * consumeState refuses, each with a code the console turns into words (never an echo of what came back): a state that
 * is not ours or was changed (bad_state), one past its time (expired), one made in another workspace than the session's
 * (other_workspace: left unused, so its own person can still finish), and one used already, made by another person, or
 * never issued (state_used).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "./db.js";
import { derivedKey } from "./keyvault.js";
import { asPlatform } from "./tenant-scope.js";

const MINUTES = 10;
export class StateRefused extends Error { constructor(public code: "bad_state" | "expired" | "other_workspace" | "state_used", public status = 400) { super(code); } }

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** The signature of a payload (exported for tests that forge or age a state). */
export const signState = (payload: string) => createHmac("sha256", derivedKey("signed-state")).update(`signed-state/v1.${payload}`).digest("base64url");

/** A new state for workspace `orgId` and person `userId`; `data` is kept server-side for the return. */
export async function issueState(orgId: number, userId: string, purpose: string, data: Record<string, unknown> = {}): Promise<{ state: string; expires_at: string }> {
  const nonce = randomBytes(24).toString("base64url");
  const exp = Date.now() + MINUTES * 60_000;
  await asPlatform(async () => {
    const db = await getDb();
    await db.query("/* tenant: platform sweep of expired sign-in states */ DELETE FROM oauth_states WHERE expires_at < now() - interval '1 day'");
    await db.query("INSERT INTO oauth_states (nonce_sha256, org_id, user_id, purpose, data, expires_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [sha256(nonce), orgId, userId, purpose, JSON.stringify(data), new Date(exp)]);
  });
  const payload = Buffer.from(JSON.stringify({ v: 1, o: orgId, n: nonce, p: purpose, e: exp })).toString("base64url");
  return { state: `${payload}.${signState(payload)}`, expires_at: new Date(exp).toISOString() };
}

/** Check a state that came back for the signed-in `who`, and use it up. Returns the data stored with it. */
export async function consumeState(state: unknown, who: { org: number; user: string }, purpose: string): Promise<Record<string, unknown>> {
  const s = typeof state === "string" ? state : "";
  const [payload, sig] = s.split(".");
  if (!payload || !sig || s.length > 1000) throw new StateRefused("bad_state");
  const want = Buffer.from(signState(payload)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new StateRefused("bad_state");
  let p: { v?: number; o?: number; n?: string; p?: string; e?: number };
  try { p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new StateRefused("bad_state"); }
  if (p.v !== 1 || !Number.isSafeInteger(p.o) || typeof p.n !== "string" || typeof p.e !== "number" || p.p !== purpose) throw new StateRefused("bad_state");
  if (p.e < Date.now()) throw new StateRefused("expired");
  if (p.o !== who.org) throw new StateRefused("other_workspace", 403);
  const [row] = await asPlatform(async () => (await getDb()).query<{ data: Record<string, unknown> }>(
    `UPDATE oauth_states SET used_at = now() WHERE nonce_sha256 = $1 AND org_id = $2 AND user_id = $3 AND purpose = $4 AND used_at IS NULL AND expires_at > now() RETURNING data`,
    [sha256(p.n!), who.org, who.user, purpose]));
  if (!row) throw new StateRefused("state_used", 403);
  return row.data ?? {};
}
