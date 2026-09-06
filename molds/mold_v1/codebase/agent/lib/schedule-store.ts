/**
 * Durable dynamic-schedule rule engine for the FDE agent.
 *
 * POSTGRES IS THE SOURCE OF RECORD. When a `DATABASE_URL` (or `POSTGRES_URL`)
 * is configured, schedule rules persist in the `schedule_rules` table (see
 * `./db/schema.ts`) via Drizzle ORM + the postgres.js driver — durable across
 * sessions, processes, and teammates.
 *
 * FALLBACK: when no Postgres URL is set (dev / CI / tests), rules live in an
 * in-process `Map` so the create/list/update/delete tools and the dispatcher
 * (`agent/schedules/dynamic.ts`) keep working end-to-end with no credentials.
 * Single-threaded JS makes the fallback claim atomic per tick.
 *
 * RECURRENCE is driven by `everyMinutes` (the eve dynamic-scheduling pattern's
 * own design), NOT by a cron parser: there is no cron-parser dependency and
 * package.json is frozen. `cron` is a descriptive/future full-cron string only.
 *
 * DELIVERY IS AT-LEAST-ONCE: `claimDueRules` leases due rows; a rule executor
 * MUST be idempotent because a lease can expire and be re-claimed after a crash
 * mid-run.
 *
 * NOTE: this module (and its imports) sticks to relative `.ts` specifiers so
 * the fallback-path test (`scripts/test-schedules.mjs`) can run it under plain
 * `node --experimental-strip-types`, which does not resolve the `#lib/*.js`
 * subpath aliases the eve bundler rewrites (imitates `memory-store.ts`).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import { z } from "zod";
import { acrossOrgDbs, getDb, withOrgDb } from "./db/index.ts";
import { scheduleRules } from "./db/schema.ts";
import { nextCronTime } from "./cron-match.ts";

/**
 * Advance a rule's next run. A `cron` expression (when set) drives recurrence at
 * anchored UTC times — this is what makes a schedule rule a real DB-maintained
 * cron, not just an `everyMinutes` interval. Falls back to everyMinutes, else the
 * rule was one-time.
 */
function advanceNextRun(
  cron: string | null,
  everyMinutes: number | null,
  ranAt: Date,
  currentNext: Date,
): { nextRunAt: Date; recurring: boolean } {
  const expr = cron?.trim() || null;
  if (expr) {
    const next = (() => {
      try {
        return nextCronTime(expr, ranAt);
      } catch {
        return null;
      }
    })();
    // A valid recurring cron always yields a next time; on a bad/exhausted expr,
    // park it a day out rather than hot-loop.
    return { nextRunAt: next ?? new Date(ranAt.getTime() + 86_400_000), recurring: true };
  }
  if (everyMinutes !== null) {
    return { nextRunAt: new Date(ranAt.getTime() + everyMinutes * 60_000), recurring: true };
  }
  return { nextRunAt: currentNext, recurring: false };
}

/* -------------------------------------------------------------------------- */
/* Schedule rule record                                                       */
/* -------------------------------------------------------------------------- */

export const scheduleRuleKindSchema = z.enum(["prompt", "standup", "sla_sweep"]);

export const scheduleRuleSchema = z.object({
  id: z.string(),
  // The workspace this rule belongs to. Lets the dispatcher skip a SUSPENDED
  // org's rules. Not nullable and not defaulted: the old default pointed at
  // 'org-onfinance', which is not a workspace, so a rule that lost its org
  // became one nobody owned and nobody could fire.
  orgId: z.string(),
  customerId: z.string().nullable(),
  name: z.string(),
  cron: z.string().nullable(),
  everyMinutes: z.number().int().nullable(),
  kind: scheduleRuleKindSchema,
  prompt: z.string(),
  channelId: z.string().nullable(),
  enabled: z.boolean(),
  nextRunAt: z.string(), // ISO string out
  lockedAt: z.string().nullable(),
  leaseToken: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastError: z.string().nullable(),
  notifyEmails: z.array(z.string()).nullable(),
  // DEPRECATED — superseded by `notifyEmails`; fallback-only (see dynamic.ts).
  notifyEmail: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ScheduleRuleRecord = z.infer<typeof scheduleRuleSchema>;

/**
 * A rule claimed for execution by `claimDueRules`. Carries the `leaseToken`
 * that `completeRule` / `releaseRule` must present to release the lock, so a
 * stale worker whose lease already expired and was re-claimed cannot clobber
 * the current holder's state.
 */
export interface ClaimedRule extends ScheduleRuleRecord {
  leaseToken: string;
}

type ScheduleRow = typeof scheduleRules.$inferSelect;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function rowToRecord(row: ScheduleRow): ScheduleRuleRecord {
  return scheduleRuleSchema.parse({
    id: row.id,
    orgId: row.orgId,
    customerId: row.customerId,
    name: row.name,
    cron: row.cron,
    everyMinutes: row.everyMinutes,
    kind: row.kind,
    prompt: row.prompt,
    channelId: row.channelId,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt.toISOString(),
    lockedAt: iso(row.lockedAt),
    leaseToken: row.leaseToken,
    lastRunAt: iso(row.lastRunAt),
    lastError: row.lastError,
    notifyEmails: row.notifyEmails,
    notifyEmail: row.notifyEmail,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Fallback store — in-process, keyed by rule id                              */
/* -------------------------------------------------------------------------- */

/** Internal fallback shape holds real Dates so lease math matches Postgres. */
interface FallbackRule {
  id: string;
  customerId: string | null;
  name: string;
  cron: string | null;
  everyMinutes: number | null;
  kind: z.infer<typeof scheduleRuleKindSchema>;
  prompt: string;
  channelId: string | null;
  enabled: boolean;
  nextRunAt: Date;
  lockedAt: Date | null;
  leaseToken: string | null;
  lastRunAt: Date | null;
  lastError: string | null;
  notifyEmails: string[] | null;
  notifyEmail: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const fallbackRules = new Map<string, FallbackRule>();

function fallbackToRecord(r: FallbackRule): ScheduleRuleRecord {
  return scheduleRuleSchema.parse({
    id: r.id,
    customerId: r.customerId,
    name: r.name,
    cron: r.cron,
    everyMinutes: r.everyMinutes,
    kind: r.kind,
    prompt: r.prompt,
    channelId: r.channelId,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt.toISOString(),
    lockedAt: iso(r.lockedAt),
    leaseToken: r.leaseToken,
    lastRunAt: iso(r.lastRunAt),
    lastError: r.lastError,
    notifyEmails: r.notifyEmails,
    notifyEmail: r.notifyEmail,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  });
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface CreateScheduleRuleInput {
  /**
   * The workspace the rule belongs to. REQUIRED — it used to default to
   * 'org-onfinance', a workspace that does not exist, so a rule created by any
   * other workspace was filed where nobody could see or fire it.
   */
  orgId: string;
  name: string;
  prompt: string;
  kind?: z.infer<typeof scheduleRuleKindSchema>;
  customerId?: string | null;
  channelId?: string | null;
  firstRunAt: Date;
  everyMinutes?: number | null;
  cron?: string | null;
  notifyEmails?: string[] | null;
  /** DEPRECATED — superseded by `notifyEmails`; fallback-only. */
  notifyEmail?: string | null;
  createdBy: string;
}

/** Create one durable schedule rule (recurring if `everyMinutes` is set). */
export async function createScheduleRule(
  input: CreateScheduleRuleInput,
): Promise<ScheduleRuleRecord> {
  const kind = input.kind ?? "prompt";
  const everyMinutes = input.everyMinutes ?? null;
  // A cron-driven rule's first run is the next matching time, not "now".
  const cronExpr = input.cron?.trim() || null;
  const firstRunAt = cronExpr
    ? (() => {
        try {
          return nextCronTime(cronExpr, new Date()) ?? input.firstRunAt;
        } catch {
          return input.firstRunAt;
        }
      })()
    : input.firstRunAt;
  const db = getDb();
  if (db) {
    const inserted = await withOrgDb(input.orgId, (tx) =>
      tx
      .insert(scheduleRules)
      .values({
        orgId: input.orgId,
        name: input.name,
        prompt: input.prompt,
        kind,
        customerId: input.customerId ?? null,
        channelId: input.channelId ?? null,
        cron: input.cron ?? null,
        everyMinutes,
        nextRunAt: firstRunAt,
        notifyEmails: input.notifyEmails ?? null,
        notifyEmail: input.notifyEmail ?? null,
        createdBy: input.createdBy,
      })
      .returning(),
    );
    return rowToRecord(inserted[0]);
  }
  // Fallback: in-process insert.
  const now = new Date();
  const rule: FallbackRule = {
    id: randomUUID(),
    customerId: input.customerId ?? null,
    name: input.name,
    cron: input.cron ?? null,
    everyMinutes,
    kind,
    prompt: input.prompt,
    channelId: input.channelId ?? null,
    enabled: true,
    nextRunAt: firstRunAt,
    lockedAt: null,
    leaseToken: null,
    lastRunAt: null,
    lastError: null,
    notifyEmails: input.notifyEmails ?? null,
    notifyEmail: input.notifyEmail ?? null,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  };
  fallbackRules.set(rule.id, rule);
  return fallbackToRecord(rule);
}

/** List schedule rules, optionally filtered. `nextRunAt` asc, id tiebreak. */
export async function listScheduleRules(
  /**
   * The workspace to act within. REQUIRED: this took an id and no workspace, so
   * a rule belonging to another workspace could be read, changed or deleted by
   * anyone who knew its id.
   */
  orgId: string,
  filter?: {
    customerId?: string;
    enabled?: boolean;
  },
): Promise<ScheduleRuleRecord[]> {
  const db = getDb();
  if (db) {
    const conditions = [eq(scheduleRules.orgId, orgId)];
    if (filter?.customerId !== undefined)
      conditions.push(eq(scheduleRules.customerId, filter.customerId));
    if (filter?.enabled !== undefined)
      conditions.push(eq(scheduleRules.enabled, filter.enabled));
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select()
        .from(scheduleRules)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(asc(scheduleRules.nextRunAt), asc(scheduleRules.id)),
    );
    return rows.map(rowToRecord);
  }
  return [...fallbackRules.values()]
    .filter(
      (r) =>
        (filter?.customerId === undefined || r.customerId === filter.customerId) &&
        (filter?.enabled === undefined || r.enabled === filter.enabled),
    )
    .sort(
      (a, b) =>
        a.nextRunAt.getTime() - b.nextRunAt.getTime() || a.id.localeCompare(b.id),
    )
    .map(fallbackToRecord);
}

export interface UpdateScheduleRulePatch {
  name?: string;
  prompt?: string;
  channelId?: string | null;
  everyMinutes?: number | null;
  nextRunAt?: Date;
  enabled?: boolean;
  notifyEmails?: string[] | null;
  /** DEPRECATED — superseded by `notifyEmails`; fallback-only. */
  notifyEmail?: string | null;
}

/** Patch one rule (bumps `updatedAt`). Throws on an unknown id. */
export async function updateScheduleRule(
  /**
   * The workspace to act within. REQUIRED: this took an id and no workspace, so
   * a rule belonging to another workspace could be read, changed or deleted by
   * anyone who knew its id.
   */
  orgId: string,
  id: string,
  patch: UpdateScheduleRulePatch,
): Promise<ScheduleRuleRecord> {
  const now = new Date();
  const db = getDb();
  if (db) {
    const set: Record<string, unknown> = { updatedAt: now };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.prompt !== undefined) set.prompt = patch.prompt;
    if (patch.channelId !== undefined) set.channelId = patch.channelId;
    if (patch.everyMinutes !== undefined) set.everyMinutes = patch.everyMinutes;
    if (patch.nextRunAt !== undefined) set.nextRunAt = patch.nextRunAt;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.notifyEmails !== undefined) set.notifyEmails = patch.notifyEmails;
    if (patch.notifyEmail !== undefined) set.notifyEmail = patch.notifyEmail;
    const updated = await withOrgDb(orgId, (tx) =>
      tx
        .update(scheduleRules)
        .set(set)
        .where(and(eq(scheduleRules.orgId, orgId), eq(scheduleRules.id, id)))
        .returning(),
    );
    if (!updated[0]) throw new Error(`schedule rule not found: ${id}`);
    return rowToRecord(updated[0]);
  }
  const rule = fallbackRules.get(id);
  if (!rule) throw new Error(`schedule rule not found: ${id}`);
  if (patch.name !== undefined) rule.name = patch.name;
  if (patch.prompt !== undefined) rule.prompt = patch.prompt;
  if (patch.channelId !== undefined) rule.channelId = patch.channelId;
  if (patch.everyMinutes !== undefined) rule.everyMinutes = patch.everyMinutes;
  if (patch.nextRunAt !== undefined) rule.nextRunAt = patch.nextRunAt;
  if (patch.enabled !== undefined) rule.enabled = patch.enabled;
  if (patch.notifyEmails !== undefined) rule.notifyEmails = patch.notifyEmails;
  if (patch.notifyEmail !== undefined) rule.notifyEmail = patch.notifyEmail;
  rule.updatedAt = now;
  return fallbackToRecord(rule);
}

/** Delete one rule by id. Returns whether anything was removed. */
export async function deleteScheduleRule(
  /**
   * The workspace to act within. REQUIRED: this took an id and no workspace, so
   * a rule belonging to another workspace could be read, changed or deleted by
   * anyone who knew its id.
   */
  orgId: string,
  id: string,
): Promise<boolean> {
  const db = getDb();
  if (db) {
    const deleted = await withOrgDb(orgId, (tx) =>
      tx
      .delete(scheduleRules)
      .where(and(eq(scheduleRules.orgId, orgId), eq(scheduleRules.id, id)))
      .returning({ id: scheduleRules.id }),
    );
    return deleted.length > 0;
  }
  return fallbackRules.delete(id);
}

/* -------------------------------------------------------------------------- */
/* Lease — claim due rules, then complete or release                          */
/* -------------------------------------------------------------------------- */

const DEFAULT_LIMIT = 25;
const DEFAULT_LEASE_MS = 5 * 60_000;

/**
 * Atomically lease every due, enabled rule (up to `limit`) whose lock is free
 * or expired, stamping a fresh `leaseToken`. At-least-once: an executor that
 * crashes mid-run leaves a lock that expires after `leaseForMs` and is
 * re-claimed here, so rule executors MUST be idempotent.
 */
export async function claimDueRules(opts: {
  now: Date;
  limit?: number;
  leaseForMs?: number;
}): Promise<ClaimedRule[]> {
  const now = opts.now;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const leaseForMs = opts.leaseForMs ?? DEFAULT_LEASE_MS;
  const leaseToken = randomUUID();
  const expiredBefore = new Date(now.getTime() - leaseForMs);
  const db = getDb();
  if (db) {
    // THE LOAD-BEARING LEASE. A single atomic UPDATE ... RETURNING claims due
    // rows and stamps this batch's leaseToken in one round-trip, so two
    // dispatchers racing on the same tick cannot claim the same row. Rows are
    // selected via a FOR UPDATE SKIP LOCKED subselect (postgres.js/drizzle
    // lacks UPDATE ... LIMIT) to bound the batch to `limit`. Expired leases
    // (lockedAt older than the lease window) are recoverable.
    const duePredicate = and(
      eq(scheduleRules.enabled, true),
      lte(scheduleRules.nextRunAt, now),
      or(isNull(scheduleRules.lockedAt), lt(scheduleRules.lockedAt, expiredBefore)),
    );
    // Cross-workspace by construction: the dispatcher claims whatever is due,
    // in whichever workspace. Swept per workspace so it keeps claiming once the
    // policy fails closed.
    const claimed = await acrossOrgDbs((tx) =>
      tx
      .update(scheduleRules)
      .set({ lockedAt: now, leaseToken, updatedAt: now })
      .where(
        inArray(
          scheduleRules.id,
          // The SAME scoped transaction — a subquery on the unscoped handle
          // would pick candidates the outer update cannot then touch.
          tx
            .select({ id: scheduleRules.id })
            .from(scheduleRules)
            .where(duePredicate)
            .orderBy(asc(scheduleRules.nextRunAt), asc(scheduleRules.id))
            .limit(limit)
            .for("update", { skipLocked: true }),
        ),
      )
      .returning(),
    );
    return claimed.map((row) => rowToRecord(row) as ClaimedRule);
  }
  // Fallback: same predicate over the Map. Single-threaded JS makes the
  // read-then-write atomic within this tick.
  const due = [...fallbackRules.values()]
    .filter(
      (r) =>
        r.enabled &&
        r.nextRunAt.getTime() <= now.getTime() &&
        (r.lockedAt === null || r.lockedAt.getTime() < expiredBefore.getTime()),
    )
    .sort(
      (a, b) =>
        a.nextRunAt.getTime() - b.nextRunAt.getTime() || a.id.localeCompare(b.id),
    )
    .slice(0, limit);
  const claimed: ClaimedRule[] = [];
  for (const rule of due) {
    rule.lockedAt = now;
    rule.leaseToken = leaseToken;
    rule.updatedAt = now;
    claimed.push(fallbackToRecord(rule) as ClaimedRule);
  }
  return claimed;
}

/**
 * Accept a claimed run: clears the lock IF `leaseToken` still matches (a stale
 * worker whose lease was re-claimed is a no-op), sets `lastRunAt`, records the
 * optional delivery `error` in `lastError` (advancing the schedule either way
 * so an unwired channel can never hot-loop), then advances recurrence —
 * recurring rules re-arm `nextRunAt = ranAt + everyMinutes`, one-time rules
 * (`everyMinutes === null`) flip to `enabled = false`.
 */
export async function completeRule(
  claim: ClaimedRule,
  opts: { ranAt: Date; error?: string },
): Promise<void> {
  const now = new Date();
  const error = opts.error ?? null;
  const db = getDb();
  if (db) {
    // Read the current row so we can compute recurrence from its everyMinutes.
    const rows = await withOrgDb(claim.orgId, (tx) =>
      tx
        .select()
        .from(scheduleRules)
        .where(
          and(eq(scheduleRules.id, claim.id), eq(scheduleRules.leaseToken, claim.leaseToken)),
        )
        .limit(1),
    );
    const row = rows[0];
    if (!row) return; // lease no longer ours — no-op.
    const { nextRunAt, recurring } = advanceNextRun(
      row.cron,
      row.everyMinutes,
      opts.ranAt,
      row.nextRunAt,
    );
    await withOrgDb(claim.orgId, (tx) =>
      tx
      .update(scheduleRules)
      .set({
        lockedAt: null,
        leaseToken: null,
        lastRunAt: opts.ranAt,
        lastError: error,
        enabled: recurring ? row.enabled : false,
        nextRunAt,
        updatedAt: now,
      })
      .where(and(eq(scheduleRules.orgId, claim.orgId), eq(scheduleRules.id, claim.id)))
      .returning({ id: scheduleRules.id }),
    );
    return;
  }
  const rule = fallbackRules.get(claim.id);
  if (!rule || rule.leaseToken !== claim.leaseToken) return;
  rule.lockedAt = null;
  rule.leaseToken = null;
  rule.lastRunAt = opts.ranAt;
  rule.lastError = error;
  const adv = advanceNextRun(rule.cron, rule.everyMinutes, opts.ranAt, rule.nextRunAt);
  rule.nextRunAt = adv.nextRunAt;
  if (!adv.recurring) rule.enabled = false;
  rule.updatedAt = now;
}

/**
 * Release a claimed run after a failure: clears the lock IF `leaseToken` still
 * matches, records `String(error)` in `lastError`, and re-arms `nextRunAt` to
 * `retryAt` (does NOT advance recurrence — the run did not happen).
 */
export async function releaseRule(
  claim: ClaimedRule,
  failure: { error: unknown; retryAt: Date },
): Promise<void> {
  const now = new Date();
  const message = String(
    failure.error instanceof Error ? failure.error.message : failure.error,
  );
  const db = getDb();
  if (db) {
    await withOrgDb(claim.orgId, (tx) =>
      tx
        .update(scheduleRules)
        .set({
          lockedAt: null,
          leaseToken: null,
          lastError: message,
          nextRunAt: failure.retryAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(scheduleRules.orgId, claim.orgId),
            eq(scheduleRules.id, claim.id),
            eq(scheduleRules.leaseToken, claim.leaseToken),
          ),
        )
        .returning({ id: scheduleRules.id }),
    );
    return;
  }
  const rule = fallbackRules.get(claim.id);
  if (!rule || rule.leaseToken !== claim.leaseToken) return;
  rule.lockedAt = null;
  rule.leaseToken = null;
  rule.lastError = message;
  rule.nextRunAt = failure.retryAt;
  rule.updatedAt = now;
}

/** Test-only: drop all in-process fallback rules. */
export function __resetFallbackScheduleRules(): void {
  fallbackRules.clear();
}
