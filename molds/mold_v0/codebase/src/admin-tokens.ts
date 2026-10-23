/**
 * Admin API tokens: how scripts (and people without a browser) call /api/admin and the admin MCP, replacing the old
 * static APP_ADMIN_TOKEN, a single never-expiring owner secret in the environment that could not be told apart,
 * scoped or revoked without a redeploy.
 *
 * Each token is minted for one purpose (`npm run admin:token -- create --label "ci deploy" --role operator`, on the
 * server, or by an owner through POST /api/admin/tokens), shown once, stored only as a sha256 hash, carries a platform
 * role (src/admin-roles.ts) so a script gets the least role it needs, always expires (ADMIN_TOKEN_MAX_DAYS at most),
 * and can be revoked at once. Requests made with one are logged under `token:<label>`.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db.js";
import { isRole, type PlatformRole } from "./admin-roles.js";
import { ENV } from "./env-names.js";

export const ADMIN_TOKEN_PREFIX = "adm_";
export const ADMIN_TOKEN_MAX_DAYS = 90;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class AdminTokenError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface AdminTokenRow { id: number; label: string; role: PlatformRole; token_prefix: string; created_by: string; created_at: Date;
  expires_at: Date; revoked_at: Date | null; last_used_at: Date | null }

/** Mint a token. Returns it once; only its hash is kept. */
export async function createAdminToken(opts: { label: string; role: string; days?: number; createdBy: string }) {
  const label = String(opts.label ?? "").trim();
  // The label is logged as token:<label> (admin log lines, the access log, who-changed-what columns): plain characters
  // only, so it can never forge or break a log line.
  if (!/^[\w.@-][\w.@ -]{0,79}$/.test(label)) throw new AdminTokenError("A label is required: up to 80 letters, digits, spaces and . @ - _ saying what the token is for");
  if (!isRole(opts.role)) throw new AdminTokenError("role must be viewer, support, operator or owner");
  const days = opts.days ?? 30;
  if (!Number.isFinite(days) || days <= 0 || days > ADMIN_TOKEN_MAX_DAYS) throw new AdminTokenError(`days must be between 1 and ${ADMIN_TOKEN_MAX_DAYS}`);
  const token = `${ADMIN_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const [row] = await (await getDb()).query<AdminTokenRow>(
    `INSERT INTO admin_tokens (label, role, token_prefix, token_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING id, label, role, token_prefix, created_by, created_at, expires_at, revoked_at, last_used_at`,
    [label, opts.role, token.slice(0, ADMIN_TOKEN_PREFIX.length + 6), sha256(token), String(opts.createdBy).slice(0, 200), Math.round(days * 86400)]);
  return { token, ...row };
}

/** The token's role and label, or null when it is unknown, revoked or expired. Marks it used (best effort). */
export async function resolveAdminToken(token: string | null | undefined): Promise<{ id: number; label: string; role: PlatformRole } | null> {
  if (!token || !token.startsWith(ADMIN_TOKEN_PREFIX)) return null;
  const db = await getDb();
  const [row] = await db.query<{ id: number; label: string; role: string }>(
    "SELECT id, label, role FROM admin_tokens WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()", [sha256(token)]);
  if (!row || !isRole(row.role)) return null;
  db.query("UPDATE admin_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [row.id]).catch(() => {});
  return { id: row.id, label: row.label, role: row.role };
}

export async function listAdminTokens(): Promise<AdminTokenRow[]> {
  return (await getDb()).query<AdminTokenRow>(
    "SELECT id, label, role, token_prefix, created_by, created_at, expires_at, revoked_at, last_used_at FROM admin_tokens ORDER BY created_at DESC LIMIT 500");
}

export async function revokeAdminToken(id: number): Promise<boolean> {
  if (!Number.isInteger(id) || id <= 0) throw new AdminTokenError("Bad token id");
  const rows = await (await getDb()).query("UPDATE admin_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id", [id]);
  return rows.length > 0;
}

/** Said once at startup when the retired variable is still set: it no longer opens anything. */
export function warnRetiredAdminToken() {
  if (ENV.APP_ADMIN_TOKEN)
    console.error("APP_ADMIN_TOKEN is set but no longer accepted: mint a scoped, expiring token with `npm run admin:token -- create --label <purpose> --role <role>` and remove the variable");
}
