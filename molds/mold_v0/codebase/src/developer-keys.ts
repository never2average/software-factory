/**
 * A workspace's API keys for its own servers (mold_v0-193; sql/migrations/0032_developer_surface.sql developer_keys).
 * Beside the MCP keys (src/auth.ts, src/member-keys.ts: `oct_`, for AI clients on /mcp), and never accepted there: these
 * start `sk_`, answer only on the developer API (/v1), and each holds scopes (src/developer-config.ts BASE_SCOPES).
 *
 *   - shown once: only the sha256 is stored, and the first 9 characters (`sk_` and 6 more) to tell keys apart
 *   - scopes: read, write, run, sessions, webhooks; read, write and run may be narrowed to an area or a kind
 *   - integration keys hold exactly one scope (the database refuses another)
 *   - an expiry (or none), revocation, and rotation: a new key with the same name and scopes, the old one kept working
 *     for a grace period (24 hours unless asked otherwise, 0 to 168)
 *   - pinned to the API version current when it was made (API-Version on a request overrides it)
 * Made, rotated and revoked by a workspace's owners in the console (src/developer-routes.ts), never by a key.
 */
import { createHash, randomBytes } from "node:crypto";
import { BASE_SCOPES, SCOPE_PATTERN } from "./developer-config.js";
import { ApiProblem, currentApiVersion } from "./developer-surface.js";
import { getDb } from "./db.js";
import { recordAreas } from "./record-areas.js";
import { jobKinds } from "./runs.js";
import { asPlatform } from "./tenant-scope.js";

export const DEV_KEY_PREFIX = "sk_";
export const MAX_LIVE_KEYS = 100;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface DeveloperKeyRow {
  id: number; name: string; kind: "secret" | "integration"; scopes: string[]; key_prefix: string; api_version: string;
  created_by: string | null; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null;
  rotated_from: number | null; state: "active" | "expired" | "revoked";
}
type Raw = Omit<DeveloperKeyRow, "id" | "state" | "created_at" | "expires_at" | "last_used_at" | "revoked_at" | "rotated_from"> & {
  id: string | number; created_at: Date; expires_at: Date | null; last_used_at: Date | null; revoked_at: Date | null; rotated_from: string | number | null };
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const COLS = "id, name, kind, scopes, key_prefix, api_version, created_by, created_at, expires_at, last_used_at, revoked_at, rotated_from";
const row = (r: Raw): DeveloperKeyRow => ({
  id: Number(r.id), name: r.name, kind: r.kind, scopes: r.scopes, key_prefix: r.key_prefix, api_version: r.api_version, created_by: r.created_by,
  created_at: iso(r.created_at)!, expires_at: iso(r.expires_at), last_used_at: iso(r.last_used_at), revoked_at: iso(r.revoked_at),
  rotated_from: r.rotated_from === null ? null : Number(r.rotated_from),
  state: r.revoked_at ? "revoked" : r.expires_at && +new Date(r.expires_at) <= Date.now() ? "expired" : "active",
});

/** A scope list checked against the build: each a known scope, a narrowed one naming an area (read, write) or a kind (run). */
export function checkScopes(v: unknown, kind: "secret" | "integration"): string[] {
  const list = v === undefined || v === null ? (kind === "secret" ? [...BASE_SCOPES] : []) : v;
  if (!Array.isArray(list) || list.some((s) => typeof s !== "string")) throw new ApiProblem(400, "invalid_request", "scopes: a list of scopes");
  const scopes = [...new Set(list as string[])];
  for (const s of scopes) {
    if (!SCOPE_PATTERN.test(s)) throw new ApiProblem(400, "invalid_scope", `${s.slice(0, 80)} is not a scope (${BASE_SCOPES.join(", ")}, or read:<area>, write:<area>, run:<kind>)`);
    const [base, target] = s.split(":");
    if (target && (base === "read" || base === "write") && !recordAreas().some((a) => a.name === target)) throw new ApiProblem(400, "invalid_scope", `${s}: ${target} is not one of the record areas`);
    if (target && base === "run" && !jobKinds().some((k) => k.name === target)) throw new ApiProblem(400, "invalid_scope", `${s}: ${target} is not one of the job kinds`);
    if (target && (base === "sessions" || base === "webhooks")) throw new ApiProblem(400, "invalid_scope", `${s}: ${base} is not narrowed`);
  }
  if (!scopes.length) throw new ApiProblem(400, "invalid_scope", kind === "integration" ? "an integration key holds exactly one scope: name it" : "give the key at least one scope");
  if (kind === "integration" && scopes.length !== 1) throw new ApiProblem(400, "invalid_scope", `an integration key holds exactly one scope (got ${scopes.length})`);
  return scopes;
}

const nameOf = (v: unknown) => {
  const n = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : "";
  if (!n) throw new ApiProblem(400, "invalid_request", "name: what the key is for (the server or integration that holds it)");
  return n;
};
const daysOf = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const d = Number(v);
  if (!Number.isInteger(d) || d < 1 || d > 730) throw new ApiProblem(400, "invalid_request", "expires_in_days: 1 to 730, or none for a key that does not expire");
  return d;
};

/** Make a key for workspace `orgId`. The key is answered once; only its hash is stored. */
export async function createDeveloperKey(orgId: number, input: { name?: unknown; kind?: unknown; scopes?: unknown; expires_in_days?: unknown }, by: string | null,
                                         rotatedFrom: number | null = null): Promise<{ key: string; row: DeveloperKeyRow }> {
  const kind = input.kind === undefined || input.kind === null ? "secret" : input.kind;
  if (kind !== "secret" && kind !== "integration") throw new ApiProblem(400, "invalid_request", "kind: secret or integration");
  const name = nameOf(input.name), scopes = checkScopes(input.scopes, kind), days = daysOf(input.expires_in_days);
  const key = `${DEV_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const r = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`developer-keys:${orgId}`]);
    const [{ n }] = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM developer_keys WHERE org_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())", [orgId]);
    if (n >= MAX_LIVE_KEYS) throw new ApiProblem(409, "too_many_keys", `this workspace has ${n} live keys (at most ${MAX_LIVE_KEYS}): revoke one first`);
    const [x] = await tx.query<Raw>(
      `INSERT INTO developer_keys (org_id, name, kind, scopes, key_prefix, key_hash, api_version, created_by, expires_at, rotated_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9::int IS NULL THEN NULL ELSE now() + make_interval(days => $9::int) END, $10) RETURNING ${COLS}`,
      [orgId, name, kind, scopes, key.slice(0, DEV_KEY_PREFIX.length + 6), sha256(key), currentApiVersion(), by, days, rotatedFrom]);
    return x!;
  }));
  return { key, row: row(r) };
}

/** Every key of a workspace, newest first (live ones first). */
export async function listDeveloperKeys(orgId: number): Promise<DeveloperKeyRow[]> {
  return asPlatform(async () => (await (await getDb()).query<Raw>(
    `SELECT ${COLS} FROM developer_keys WHERE org_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC, id DESC LIMIT 500`, [orgId])).map(row));
}

export async function revokeDeveloperKey(orgId: number, id: number, by: string | null): Promise<DeveloperKeyRow> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new ApiProblem(404, "not_found", "No such key");
  const [r] = await asPlatform(async () => (await getDb()).query<Raw>(
    `UPDATE developer_keys SET revoked_at = now(), revoked_by = $3 WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING ${COLS}`, [orgId, id, by]));
  if (r) return row(r);
  const [x] = await asPlatform(async () => (await getDb()).query<Raw>(`SELECT ${COLS} FROM developer_keys WHERE org_id = $1 AND id = $2`, [orgId, id]));
  if (!x) throw new ApiProblem(404, "not_found", "No such key");
  throw new ApiProblem(409, "already_revoked", "This key is already revoked");
}

/**
 * Rotate a live key: a new key with its name, kind and scopes (answered once), and the old one kept working for
 * `grace_hours` (0 to 168, default 24): its expiry moves to then, unless it expires sooner.
 */
export async function rotateDeveloperKey(orgId: number, id: number, input: { grace_hours?: unknown; expires_in_days?: unknown }, by: string | null) {
  const grace = input.grace_hours === undefined || input.grace_hours === null ? 24 : Number(input.grace_hours);
  if (!Number.isInteger(grace) || grace < 0 || grace > 168) throw new ApiProblem(400, "invalid_request", "grace_hours: 0 to 168");
  const old = (await listDeveloperKeys(orgId)).find((k) => k.id === id);
  if (!old) throw new ApiProblem(404, "not_found", "No such key");
  if (old.state !== "active") throw new ApiProblem(409, "key_not_active", `This key is ${old.state}: make a new one instead`);
  const made = await createDeveloperKey(orgId, { name: old.name, kind: old.kind, scopes: old.scopes, expires_in_days: input.expires_in_days }, by, old.id);
  const [r] = await asPlatform(async () => (await getDb()).query<Raw>(
    `UPDATE developer_keys SET expires_at = LEAST(coalesce(expires_at, 'infinity'::timestamptz), now() + make_interval(hours => $3::int))
      WHERE org_id = $1 AND id = $2 RETURNING ${COLS}`, [orgId, id, grace]));
  return { key: made.key, row: made.row, previous: row(r!) };
}

/** What a key resolves to on a request. */
export interface ResolvedKey { id: number; orgId: number; kind: "secret" | "integration"; scopes: string[]; prefix: string; apiVersion: string }

/** A key's workspace and scopes, or null when it is unknown, revoked or expired. */
export async function resolveDeveloperKey(token: string): Promise<ResolvedKey | null> {
  if (!token.startsWith(DEV_KEY_PREFIX) || token.length > 200) return null;
  const db = await getDb();
  const [r] = await asPlatform(() => db.query<{ id: string; org_id: number; kind: "secret" | "integration"; scopes: string[]; key_prefix: string; api_version: string }>(
    `/* tenant: the key row found by its hash */ SELECT id, org_id, kind, scopes, key_prefix, api_version FROM developer_keys
      WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, [sha256(token)]));
  if (!r) return null;
  void asPlatform(() => db.query("UPDATE developer_keys SET last_used_at = now() WHERE org_id = $1 AND id = $2", [r.org_id, r.id])).catch(() => {});
  return { id: Number(r.id), orgId: r.org_id, kind: r.kind, scopes: r.scopes, prefix: r.key_prefix, apiVersion: r.api_version };
}
