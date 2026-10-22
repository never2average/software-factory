/**
 * Limits (mold_v0-018): what one key, member, workspace or address may ask of the MCP front door, of the endpoints
 * that create people and keys, and the platform's ceilings on runs (src/runs.ts), which a pack may lower, never raise.
 *
 * Where a number comes from, last wins:
 *   1. the shell's defaults (DEFAULTS below);
 *   2. the profile (profile.json `limits`, merged by scripts/gen-packs.mjs into src/profile.generated.ts): the build's own;
 *   3. the workspace's plan (profile.json `limits.plans.<plan name>`), when the workspace has a live plan;
 *   4. the server's environment (OCTILLION_LIMIT_<SECTION>_<NAME>, e.g. OCTILLION_LIMIT_MCP_PER_KEY_PER_MINUTE; the
 *      older OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE still sets runs.live_per_workspace): the operator's knob.
 * A pack has no say in any of them: packs add files only under packs/<id>/ and never the profile (molds/mold_v0/MOLD.md),
 * and a job kind's own limits are clamped to the platform's (src/runs.ts effectiveKindLimits).
 *
 * Counting: fixed one-minute (or one-hour) windows in rate_limit_hits (sql/migrations/0009_usage_and_limits.sql), one
 * statement per request for every bucket it touches, so the count holds across processes and serverless instances.
 * A bucket names what it counts (a key's id, a member's id, a workspace's id, a hash of an address), never a secret.
 * Concurrency per workspace is counted in the process (requests in flight at once on this instance).
 * Counting never fails a request: a database error lets the request through and is logged.
 */
import { createHash } from "node:crypto";
import { getDb } from "./db.js";
import { PROFILE } from "./profile.js";
import { asPlatform } from "./tenant-scope.js";

export interface McpLimits {
  per_key_per_minute: number; per_member_per_minute: number; per_workspace_per_minute: number; per_ip_per_minute: number;
  concurrent_per_workspace: number; max_request_bytes: number; max_response_bytes: number;
}
export interface EndpointLimits {
  signup_per_hour_per_ip: number; invites_per_hour_per_workspace: number; keys_per_hour_per_workspace: number;
  /** Built-in sign-in (mold_v0-004, src/builtin-auth.ts): code requests and Google starts per IP, code checks and Google
   *  answers per IP, and codes per email address (an address also gets no more codes after 20 wrong tries in a day). */
  signin_per_hour_per_ip: number; signin_checks_per_hour_per_ip: number; signin_codes_per_hour_per_address: number;
}
export interface RunLimits { budget_usd_max: number; concurrency_per_workspace: number; kind_month_budget_usd: number; live_per_workspace: number }
export interface Limits { mcp: McpLimits; endpoints: EndpointLimits; runs: RunLimits }
type Section = keyof Limits;
export type ProfileLimits = { [S in Section]?: Partial<Limits[S]> } & { plans?: Record<string, { [S in Section]?: Partial<Limits[S]> }> };

export const DEFAULTS: Readonly<Limits> = Object.freeze({
  mcp: { per_key_per_minute: 300, per_member_per_minute: 300, per_workspace_per_minute: 600, per_ip_per_minute: 600,
    concurrent_per_workspace: 16, max_request_bytes: 4 * 1024 * 1024, max_response_bytes: 4 * 1024 * 1024 },
  endpoints: { signup_per_hour_per_ip: 5, invites_per_hour_per_workspace: 30, keys_per_hour_per_workspace: 20,
    signin_per_hour_per_ip: 30, signin_checks_per_hour_per_ip: 60, signin_codes_per_hour_per_address: 5 },
  runs: { budget_usd_max: 25, concurrency_per_workspace: 4, kind_month_budget_usd: 200, live_per_workspace: 20 },
});

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const envOf = (section: string, key: string) => {
  const legacy = section === "runs" && key === "live_per_workspace" ? process.env.OCTILLION_RUNS_MAX_LIVE_PER_WORKSPACE : undefined;
  const raw = process.env[`OCTILLION_LIMIT_${section}_${key}`.toUpperCase()] ?? legacy;
  return raw === undefined || raw === "" ? undefined : positive(Number(raw));
};

/** The limits in force for a workspace on `plan` (its plan's name; null for none). */
export function limitsFor(plan: string | null = null, profile: ProfileLimits | undefined = (PROFILE as { limits?: ProfileLimits }).limits): Limits {
  const planned = plan ? profile?.plans?.[plan] : undefined;
  const out = {} as Record<Section, Record<string, number>>;
  for (const section of Object.keys(DEFAULTS) as Section[]) {
    const base = DEFAULTS[section] as unknown as Record<string, number>;
    out[section] = {};
    for (const key of Object.keys(base)) {
      out[section][key] = envOf(section, key)
        ?? positive((planned?.[section] as Record<string, unknown> | undefined)?.[key])
        ?? positive((profile?.[section] as Record<string, unknown> | undefined)?.[key])
        ?? base[key]!;
    }
  }
  return out as unknown as Limits;
}

/** A workspace's plan name, for its limits: read at most once a minute per workspace; none when it cannot be read. */
const planCache = new Map<number, { at: number; plan: Promise<string | null> }>();
export function planOf(orgId: number): Promise<string | null> {
  if (!(PROFILE as { limits?: ProfileLimits }).limits?.plans) return Promise.resolve(null); // no per-plan limits: never look
  const hit = planCache.get(orgId);
  if (hit && Date.now() - hit.at < 60_000) return hit.plan;
  const plan = asPlatform(async () => {
    const { orgBudget } = await import("./billing.js");
    const b = await orgBudget(orgId);
    return b.subscription && ["active", "trialing"].includes(b.subscription.status) ? b.subscription.plan ?? null : null;
  }).catch(() => null);
  planCache.set(orgId, { at: Date.now(), plan });
  return plan;
}

export const hashed = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 24);

export interface Bucket { bucket: string; limit: number; what: string }
export interface Refusal { bucket: string; what: string; limit: number; retry_after: number; window_seconds: number }

let pruneAt = 0;
/**
 * Count one request against every bucket; the first over its limit is the refusal (null: go ahead). `windowSeconds`
 * is 60 (per minute) or 3600 (per hour). Old windows are pruned now and then.
 */
export async function hit(buckets: Bucket[], windowSeconds = 60, weight = 1): Promise<Refusal | null> {
  const w = Math.max(1, Math.floor(weight));
  const live = buckets.filter((b) => Number.isFinite(b.limit) && b.limit > 0);
  if (!live.length) return null;
  try {
    return await asPlatform(async () => {
      const db = await getDb();
      const rows = await db.query<{ bucket: string; hits: number; reset: number }>(
        `/* tenant: internal: rate-limit counters, platform rows named by key, member, workspace or address */
         INSERT INTO rate_limit_hits (bucket, window_start, hits)
         SELECT b, to_timestamp(floor(extract(epoch FROM now())::float8 / $2::int) * $2::int), $3::int FROM unnest($1::text[]) AS b
         ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limit_hits.hits + excluded.hits
         RETURNING bucket, hits, extract(epoch FROM window_start + make_interval(secs => $2::int) - now())::float AS reset`,
        [live.map((b) => `${b.bucket}@${windowSeconds}`), windowSeconds, w]);
      if (Date.now() > pruneAt) {
        pruneAt = Date.now() + 60_000;
        void db.query("/* tenant: internal: rate-limit counters */ DELETE FROM rate_limit_hits WHERE window_start < now() - interval '2 hours'").catch(() => {});
      }
      const by = new Map(rows.map((r) => [r.bucket, r]));
      for (const b of live) {
        const r = by.get(`${b.bucket}@${windowSeconds}`);
        if (r && Number(r.hits) > b.limit)
          return { bucket: b.bucket, what: b.what, limit: b.limit, retry_after: Math.max(1, Math.ceil(Number(r.reset))), window_seconds: windowSeconds };
      }
      return null;
    });
  } catch (e) {
    console.error(`rate limit count failed (request let through): ${(e as Error).message}`);
    return null;
  }
}

/** Requests in flight per workspace on this instance (the per-workspace concurrency cap). */
const inFlight = new Map<number, number>();
/** Take a slot for workspace `orgId`, or null when it already has `cap` in flight; call the returned function when done. */
export function takeSlot(orgId: number, cap: number, weight = 1): (() => void) | null {
  const k = Math.max(1, Math.floor(weight));
  const n = inFlight.get(orgId) ?? 0;
  if (n + k > cap && n > 0) return null; // a batch larger than the cap runs only when nothing else does
  inFlight.set(orgId, n + k);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const m = (inFlight.get(orgId) ?? k) - k;
    if (m <= 0) inFlight.delete(orgId); else inFlight.set(orgId, m);
  };
}

const PER = (s: number) => (s >= 3600 ? "hour" : "minute");
/** The words of a refusal, for an MCP error or an HTTP 429. */
export const refusalMessage = (r: Refusal) =>
  `Too many requests: this ${r.what} is limited to ${r.limit} a ${PER(r.window_seconds)}. Try again in ${r.retry_after} second${r.retry_after === 1 ? "" : "s"}.`;

type Req = { ip?: string; params: Record<string, unknown> };
type Res = { locals: Record<string, any>; status: (n: number) => Res; set: (k: string, v: string) => Res; json: (b: unknown) => unknown };
const ENDPOINT = {
  signup: { key: "signup_per_hour_per_ip", noun: "sign-up requests", scope: "address" },
  invite: { key: "invites_per_hour_per_workspace", noun: "invitations", scope: "workspace" },
  key: { key: "keys_per_hour_per_workspace", noun: "new keys", scope: "workspace" },
} as const;
/**
 * The endpoints that create people and keys (mold_v0-018): at most so many an hour per address (sign-up) or per
 * workspace (invitations, keys), the profile's `endpoints` limits. `subject` names the address or the workspace.
 */
export function endpointLimit(kind: keyof typeof ENDPOINT, subject: (req: Req, res: Res) => string) {
  return async (req: Req, res: Res, next: () => void) => {
    const e = ENDPOINT[kind];
    const limit = limitsFor(null).endpoints[e.key];
    const r = await hit([{ bucket: `${kind}:${hashed(subject(req, res))}`, limit, what: e.scope }], 3600);
    if (!r) return next();
    res.status(429).set("Retry-After", String(r.retry_after)).json({ error: `Too many ${e.noun} for this ${e.scope}: at most ${limit} an hour. Try again in ${Math.ceil(r.retry_after / 60)} minute${r.retry_after > 60 ? "s" : ""}.`,
      code: "rate_limited", retry_after: r.retry_after });
  };
}
