/**
 * Client sessions and allowed origins (mold_v0-193; sql/migrations/0033_developer_surface.sql).
 *
 * A browser or a phone app never holds a key. The workspace's backend mints a client session with a key that holds
 * `sessions`, for one of its own signed-in users (`subject`), and hands the token (`cs_...`) to the client:
 *   - it lives at most the build's client_sessions.ttl_seconds (and as long as asked, from 60 seconds);
 *   - it holds at most the build's client_sessions.scopes (default read and write; `checks` or `checks:<name>` lets it
 *     ask the build's declarative checks, mold_v0-224), and never a scope the minting key lacks (an area- or
 *     check-narrowed key mints only sessions narrowed the same way or more);
 *   - its subject is the actor of every call made with it;
 *   - it is revocable, and goes with the key that minted it (revoking the key does not: expiry does; a revoked key's
 *     sessions are refused because the key is checked on each call).
 * A browser calls the API only from an allowed origin: the build's client_sessions.allowed_origins, plus the origins the
 * workspace adds (developer_origins). Preflights answer for any origin allowed to some workspace; the call itself is
 * checked against the session's own workspace (src/developer-api.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { findCheck } from "./checks.js";
import { DEFAULT_SESSION_SCOPES, SESSION_SCOPES } from "./developer-config.js";
import { ApiProblem, developerSurface } from "./developer-surface.js";
import { getDb } from "./db.js";
import { ENV } from "./env-names.js";
import { asPlatform } from "./tenant-scope.js";

export const SESSION_PREFIX = "cs_";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const SUBJECT = /^[A-Za-z0-9._:@+-]{1,128}$/;

/** Whether `held` (a key's or session's scopes) covers `want` (a scope, maybe narrowed). */
export function covers(held: readonly string[], want: string): boolean {
  if (held.includes(want)) return true;
  const [base, target] = want.split(":");
  return target !== undefined && held.includes(base!);
}

/** Mint a client session for `subject` with a key of workspace `orgId` that holds `keyScopes`. */
export async function mintClientSession(orgId: number, keyId: number, keyScopes: readonly string[], input: { subject?: unknown; scopes?: unknown; ttl_seconds?: unknown }) {
  const cfg = developerSurface();
  if (!cfg) throw new ApiProblem(404, "not_found", "Not found");
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!SUBJECT.test(subject)) throw new ApiProblem(400, "invalid_request", "subject: your user's id (1-128 letters, digits and . _ : @ + -)");
  const max = cfg.client_sessions.ttl_seconds;
  const ttl = input.ttl_seconds === undefined || input.ttl_seconds === null ? max : Number(input.ttl_seconds);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > max) throw new ApiProblem(400, "invalid_request", `ttl_seconds: 60 to ${max}`);
  const allowed = cfg.client_sessions.scopes ?? DEFAULT_SESSION_SCOPES;
  const asked = input.scopes === undefined || input.scopes === null ? allowed : input.scopes;
  if (!Array.isArray(asked) || !asked.length || asked.some((s) => typeof s !== "string")) throw new ApiProblem(400, "invalid_request", "scopes: a list of scopes");
  const scopes = [...new Set(asked as string[])];
  for (const s of scopes) {
    if (!(SESSION_SCOPES as readonly string[]).includes(s.split(":")[0]!)) throw new ApiProblem(400, "invalid_scope", `${s.slice(0, 80)}: a client session holds only ${SESSION_SCOPES.join(", ")}`);
    const [base, target] = s.split(":");
    if (base === "checks" && target !== undefined && !findCheck(target)) throw new ApiProblem(400, "invalid_scope", `${s.slice(0, 80)}: ${target.slice(0, 64)} is not one of the checks`);
    if (!covers(allowed, s)) throw new ApiProblem(403, "scope_not_allowed", `${s.slice(0, 80)}: client sessions of this app hold at most ${allowed.join(", ")}`);
    if (!covers(keyScopes, s)) throw new ApiProblem(403, "scope_not_held", `${s.slice(0, 80)}: the key that mints the session does not hold it`);
  }
  const token = `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = `cses_${randomBytes(12).toString("base64url")}`;
  const [r] = await asPlatform(async () => (await getDb()).query<{ expires_at: Date }>(
    `INSERT INTO developer_client_sessions (id, org_id, key_id, token_hash, subject, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::int)) RETURNING expires_at`, [id, orgId, keyId, sha256(token), subject, scopes, ttl]));
  return { id, token, subject, scopes, expires_at: new Date(r!.expires_at).toISOString() };
}

export async function revokeClientSession(orgId: number, id: string): Promise<boolean> {
  return (await asPlatform(async () => (await getDb()).query(
    "UPDATE developer_client_sessions SET revoked_at = now() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id", [orgId, String(id)]))).length > 0;
}

export interface ResolvedSession { id: string; orgId: number; subject: string; scopes: string[] }
/** A client session's workspace, subject and scopes, or null when it is unknown, revoked, expired or its key is gone. */
export async function resolveClientSession(token: string): Promise<ResolvedSession | null> {
  if (!token.startsWith(SESSION_PREFIX) || token.length > 200) return null;
  const db = await getDb();
  const [r] = await asPlatform(() => db.query<{ id: string; org_id: number; subject: string; scopes: string[] }>(
    `/* tenant: the session row found by its hash */ SELECT s.id, s.org_id, s.subject, s.scopes FROM developer_client_sessions s
       LEFT JOIN developer_keys k ON k.id = s.key_id AND k.org_id = s.org_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
        AND (s.key_id IS NULL OR (k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())))`, [sha256(token)]));
  if (!r) return null;
  return { id: r.id, orgId: r.org_id, subject: r.subject, scopes: r.scopes };
}

// ---------- allowed origins ----------

const ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{2,5})?$/;
/** A local origin is allowed only on a preview (dev) server: never in a deployed build. */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{2,5})?$/;
const preview = () => ENV.APP_PREVIEW === "1";
export function checkOrigin(v: unknown): string {
  const o = typeof v === "string" ? v.trim().toLowerCase().replace(/\/$/, "") : "";
  if (ORIGIN.test(o) || (preview() && LOCAL_ORIGIN.test(o))) return o;
  throw new ApiProblem(400, "invalid_origin", "origin: an https origin like https://app.example.com (scheme, host and port only)");
}
export async function listOrigins(orgId: number): Promise<string[]> {
  return (await asPlatform(async () => (await getDb()).query<{ origin: string }>("SELECT origin FROM developer_origins WHERE org_id = $1 ORDER BY origin", [orgId]))).map((r) => r.origin);
}
export async function addOrigin(orgId: number, origin: unknown, by: string | null): Promise<string> {
  const o = checkOrigin(origin);
  await asPlatform(async () => {
    const db = await getDb();
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM developer_origins WHERE org_id = $1", [orgId]);
    if (n >= 50) throw new ApiProblem(409, "too_many_origins", "at most 50 origins a workspace");
    await db.query("INSERT INTO developer_origins (org_id, origin, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [orgId, o, by]);
  });
  return o;
}
export async function removeOrigin(orgId: number, origin: unknown): Promise<boolean> {
  return (await asPlatform(async () => (await getDb()).query("DELETE FROM developer_origins WHERE org_id = $1 AND origin = $2 RETURNING origin", [orgId, String(origin).toLowerCase()]))).length > 0;
}
/** Whether a browser at `origin` may call for workspace `orgId` (or, for a preflight, for any workspace). */
export async function originAllowed(origin: string, orgId: number | null): Promise<boolean> {
  const cfg = developerSurface();
  if (!cfg) return false;
  const o = origin.toLowerCase();
  if (cfg.client_sessions.allowed_origins.includes(o)) return true;
  const rows = await asPlatform(async () => (await getDb()).query<{ ok: number }>(
    orgId === null ? "/* tenant: any workspace's allowed origin, for a preflight */ SELECT 1 AS ok FROM developer_origins WHERE origin = $1 LIMIT 1"
      : "SELECT 1 AS ok FROM developer_origins WHERE org_id = $2 AND origin = $1", orgId === null ? [o] : [o, orgId]));
  return rows.length > 0;
}
