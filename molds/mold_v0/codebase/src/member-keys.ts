/**
 * Per-member MCP keys (mold_v0-007; sql/migrations/0013_member_keys.sql, molds/mold_v0/MOLD.md "Per-member MCP keys").
 * A signed-in person makes keys of their own for clients that send a header instead of signing in: each named, with
 * an expiry (at most a year), shown once (only its sha256 is stored), revocable at any time. A member key:
 *
 *   - works only in a header (Authorization: Bearer, or X-API-Key) on /mcp, never in a URL (src/auth.ts resolveKey);
 *   - acts as its person with their current role in the workspace, read on every call, so it can do no more than they
 *     can (a viewer's key cannot write or launch), and stops working when they leave, are removed or are suspended;
 *   - is refused on the next call once revoked or expired;
 *   - counts against the person's own rate limits (all their keys together) as well as its own and the workspace's.
 *
 * Existing keys keep working unchanged: the account's own keys (staff issue them, src/admin.ts) and the older keys
 * staff issued for a person (no role, no expiry). Owners see every key of the workspace here and can revoke any;
 * moving a client from an older key is: make a member key, paste it in, revoke the old one.
 *
 *   GET  /api/keys               your keys; an owner also every key of the workspace (who it belongs to, its kind)
 *   POST /api/keys               {name, expires_in_days?}: a new key for you, answered once with each client's setup
 *   POST /api/keys/:id/revoke    one of your own keys; an owner any key of the workspace
 * A change riding the session cookie carries X-Pack-Request: 1 (CSRF, as the data API). Key creation shares the
 * shell's hourly key number per person (src/rate-limits.ts endpointLimit "key", its own bucket, apart from staff's).
 *
 * Off (mold_v0-099): a profile with `member_keys: false` (src/profile.ts memberKeysOn) has no member keys. Every route
 * here answers 403 {code: "member_keys_off"} for a signed-in person (nothing is listed, made or revoked), the console has
 * no API keys page, and a member key made while they were on is refused on /mcp with a sentence saying so (src/auth.ts
 * resolveKey): clients connect with sign-in (OAuth) instead. Turning them on again brings back the keys that have not
 * expired or been revoked meanwhile.
 */
import { createHash, randomBytes } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { canAccount } from "./account-roles.js";
import { customerSession, type Session } from "./app.js";
import { getDb } from "./db.js";
import { memberSetup } from "./install-pages.js";
import { plain } from "./mcp-catalog.js";
import { memberKeysOn, PROFILE } from "./profile.js";
import { endpointLimit } from "./rate-limits.js";
import { asPlatform } from "./tenant-scope.js";

/** How long a member key may live, in days (the console offers these; 90 when none is asked for). */
export const KEY_EXPIRY_DAYS = [7, 30, 90, 180, 365] as const;
const DEFAULT_EXPIRY_DAYS = 90;
/** At most so many live member keys per person. */
export const MAX_KEYS_PER_MEMBER = 20;

const KEY_PREFIX = "oct_";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class KeyError extends Error { constructor(message: string, public status = 400, public code?: string) { super(message); } }

/** What a person is told when member keys are off (mold_v0-099): how to connect instead. */
export const keysOffMessage = (publicUrl: string) =>
  `API keys are turned off for ${PROFILE.name}: connect your AI client to ${publicUrl.replace(/\/$/, "")}/mcp and sign in when it asks (OAuth).`;

export interface KeyRow {
  id: number; name: string; key_prefix: string; kind: "member" | "person" | "account"; user_id: string | null;
  created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
  state: "active" | "expired" | "revoked";
}

type Raw = { id: number; label: string; key_prefix: string; user_id: string | null; scoped: boolean; created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null };
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const row = (r: Raw): KeyRow => ({
  id: Number(r.id), name: r.label, key_prefix: r.key_prefix, kind: r.scoped ? "member" : r.user_id ? "person" : "account", user_id: r.user_id,
  created_at: iso(r.created_at)!, last_used_at: iso(r.last_used_at), expires_at: iso(r.expires_at), revoked_at: iso(r.revoked_at),
  state: r.revoked_at ? "revoked" : r.expires_at && +new Date(r.expires_at) <= Date.now() ? "expired" : "active",
});
const COLS = "id, label, key_prefix, user_id, scoped, created_at, last_used_at, expires_at, revoked_at";

/** A key's name: one line of plain text, 1 to 80 characters. */
function nameOf(v: unknown): string {
  const n = plain(typeof v === "string" ? v : "", 80);
  if (!n) throw new KeyError("Give the key a name (for example the client and the machine it is for)");
  return n;
}
function daysOf(v: unknown): number {
  if (v === undefined || v === null || v === "") return DEFAULT_EXPIRY_DAYS;
  const d = Number(v);
  if (!(KEY_EXPIRY_DAYS as readonly number[]).includes(d)) throw new KeyError(`expires_in_days is one of ${KEY_EXPIRY_DAYS.join(", ")}`);
  return d;
}

/** A person's keys in one workspace (their member keys and any older key issued to them), newest first. */
export async function memberKeys(orgId: number, userId: string): Promise<KeyRow[]> {
  const rows = await (await getDb()).query<Raw>(
    `SELECT ${COLS} FROM api_keys WHERE org_id = $1 AND user_id = $2 ORDER BY revoked_at IS NOT NULL, created_at DESC, id DESC`, [orgId, userId]);
  return rows.map(row);
}
/** Every key of a workspace (owners): the account's, older person keys and every member's keys. */
export async function workspaceKeys(orgId: number): Promise<KeyRow[]> {
  const rows = await (await getDb()).query<Raw>(
    `SELECT ${COLS} FROM api_keys WHERE org_id = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC, id DESC LIMIT 1000`, [orgId]);
  return rows.map(row);
}

/** Make a member key for `userId` in workspace `orgId`. The key is returned once; only its hash is stored. */
export async function createMemberKey(orgId: number, userId: string, input: { name?: unknown; expires_in_days?: unknown }): Promise<{ key: string; row: KeyRow }> {
  if (!memberKeysOn()) throw new KeyError("API keys are turned off for this service", 403, "member_keys_off");
  const name = nameOf(input.name), days = daysOf(input.expires_in_days);
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  // The tenant role may not write keys (sql/migrations/0003): written by the platform, for the session's own person in
  // the session's own workspace, never from the request. The live count and the insert hold one lock per person, so
  // requests at once cannot pass the cap together.
  const r = await asPlatform(async () => (await getDb()).transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`member-keys:${orgId}:${userId}`]);
    const [{ n }] = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM api_keys WHERE org_id = $1 AND user_id = $2 AND scoped AND revoked_at IS NULL AND expires_at > now()", [orgId, userId]);
    if (n >= MAX_KEYS_PER_MEMBER) throw new KeyError(`You have ${n} live keys (at most ${MAX_KEYS_PER_MEMBER}): revoke one you no longer use first`, 409);
    const [x] = await tx.query<Raw>(
      `/* platform: a member key for the session's person, in the session's workspace */ INSERT INTO api_keys (org_id, label, key_prefix, key_hash, user_id, scoped, expires_at)
       VALUES ($1, $2, $3, $4, $5, true, now() + make_interval(days => $6)) RETURNING ${COLS}`,
      [orgId, name, key.slice(0, KEY_PREFIX.length + 6), sha256(key), userId, days]);
    return x;
  }));
  return { key, row: row(r!) };
}

/**
 * Revoke a key of workspace `orgId`: a person their own (`owner` false), an owner any. Refused (404) for a key of
 * another workspace or, for a person, another person's or the account's key; 409 when it is already revoked.
 */
export async function revokeKey(orgId: number, keyId: number, by: { userId: string; owner: boolean }): Promise<KeyRow> {
  if (!Number.isSafeInteger(keyId) || keyId <= 0) throw new KeyError("No such key", 404);
  const db = await getDb();
  const [k] = await db.query<Raw>(`SELECT ${COLS} FROM api_keys WHERE id = $1 AND org_id = $2`, [keyId, orgId]);
  if (!k || (!by.owner && k.user_id !== by.userId)) throw new KeyError("No such key", 404);
  if (k.revoked_at) throw new KeyError("This key is already revoked", 409);
  const [r] = await asPlatform(async () => (await getDb()).query<Raw>(
    `/* platform: a key of the session's workspace, checked above */ UPDATE api_keys SET revoked_at = now(), revoked_by = $3
      WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL${by.owner ? "" : " AND user_id = $4"} RETURNING ${COLS}`,
    by.owner ? [keyId, orgId, `owner:${by.userId}`] : [keyId, orgId, `member:${by.userId}`, by.userId]));
  if (!r) throw new KeyError("This key is already revoked", 409);
  return row(r);
}

const answer = (fn: (req: Request, res: Response) => unknown, status = 200) => async (req: Request, res: Response, next: NextFunction) => {
  try { res.status(status).json(await fn(req, res)); }
  catch (e) {
    if (e instanceof KeyError) return void res.status(e.status).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
    next(e);
  }
};

/** /api/keys: a signed-in person of a workspace (the portal's session, src/app.ts customerSession). */
export function memberKeyAppRouter(publicUrl: string): Router {
  const r = express.Router();
  r.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  r.use(express.json({ limit: "4kb" }));
  r.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) =>
    (err ? void res.status(err.status && err.status < 500 ? err.status : 400).json({ error: "The request body must be JSON" }) : next()));
  r.use(customerSession);
  // Member keys off (mold_v0-099): nothing here answers but the sentence saying how to connect instead.
  r.use((_req, res, next) => (memberKeysOn() ? next() : void res.status(403).json({ error: keysOffMessage(publicUrl), code: "member_keys_off" })));
  // A cross-site form cannot send a custom header: a change riding the session cookie must carry this one.
  r.use((req, res, next) => (req.method !== "GET" && req.method !== "HEAD" && res.locals.viaCookie && req.get("x-pack-request") !== "1"
    ? void res.status(403).json({ error: "Missing X-Pack-Request header" }) : next()));
  const S = (res: Response) => res.locals.session as Session;
  const person = (res: Response) => {
    const u = S(res).user;
    if (!u) throw new KeyError("Sign in as a person to manage keys", 403);
    return u;
  };
  const isOwner = (res: Response) => canAccount(S(res).accountRole, "team");
  r.get("/", answer(async (_req, res) => {
    const s = S(res), me = person(res), owner = isOwner(res);
    const mine = await memberKeys(s.org, me);
    if (!owner) return { me, can_manage_all: false, expiry_days: KEY_EXPIRY_DAYS, keys: mine };
    // Owners see who each key belongs to, by the workspace's own team list (email), else "Former member".
    let names = new Map<string, string>();
    try { const { team } = await import("./admin.js"); names = new Map((await team(s.slug)).members.filter((m) => m.user_id).map((m) => [m.user_id!, m.email ?? m.name ?? m.user_id!])); }
    catch { /* the team list is unreachable: ids stand in */ }
    const all = (await workspaceKeys(s.org)).map((k) => ({ ...k, owner_label: k.user_id ? (k.user_id === me ? "You" : names.get(k.user_id) ?? "Former member") : "Workspace key" }));
    return { me, can_manage_all: true, expiry_days: KEY_EXPIRY_DAYS, keys: mine, all };
  }));
  // A request that would be refused anyway is refused before it counts; the count is the person's own (in the shell's
  // hourly key number), apart from the workspace's bucket staff issue and rotate keys from, so no member can use it up.
  r.post("/", (req, res, next) => {
    try { person(res); const b = (req.body ?? {}) as Record<string, unknown>; nameOf(b.name); daysOf(b.expires_in_days); next(); }
    catch (e) { answer(() => { throw e; })(req, res, next); }
  },
    endpointLimit("key", (_req, res) => `member:${(res.locals.session as Session).slug}:${(res.locals.session as Session).user}`) as express.RequestHandler,
    answer(async (req, res) => {
      const s = S(res);
      const { key, row: k } = await createMemberKey(s.org, person(res), (req.body ?? {}) as Record<string, unknown>);
      // Shown once: the key, and each client's setup with it in a header (never in a URL).
      return { key, ...k, setup: memberSetup(publicUrl, key) };
    }, 201));
  r.post("/:id/revoke", answer(async (req, res) => ({ key: await revokeKey(S(res).org, Number(req.params.id), { userId: person(res), owner: isOwner(res) }) })));
  r.use((_req, res) => void res.status(404).json({ error: "Not found" }));
  return r;
}
