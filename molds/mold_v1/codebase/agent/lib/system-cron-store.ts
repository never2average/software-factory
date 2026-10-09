/**
 * Pause / soft-delete state for the CODE-AUTHORED crons.
 *
 * The three static schedules (`agent/schedules/daily-standup.ts`,
 * `sla-sweep.ts`, `dynamic.ts`) become Vercel Cron Jobs at build time, so their
 * cadence and prompt live in code and cannot be changed from the UI. Vercel
 * fires them regardless of anything in the database — which means a "pause"
 * button has to be honoured by the schedule ITSELF. Each `run()` handler calls
 * `isSystemCronActive(name)` and returns before starting any agent session when
 * the row says paused or soft-deleted. That is the whole enforcement point.
 *
 * FAILS OPEN. No row means active, and no `DATABASE_URL` means active too: a
 * DB outage (or local dev, or CI) must never silently disable production crons.
 * The failure mode we want is "ran when it could have been skipped", never
 * "silently stopped running".
 *
 * Soft delete only (`deletedAt`): the schedule file still exists in the repo, so
 * a hard delete would be a lie — and the UI needs a way to restore it.
 *
 * NOTE: like `schedule-store.ts`, this module sticks to relative `.ts`
 * specifiers so it can run under plain `node --experimental-strip-types`, which
 * does not resolve the `#lib/*.js` subpath aliases the eve bundler rewrites.
 *
 * tenancy-ok: system_cron_overrides is a GLOBAL definitions table — a
 * code-authored cron is one definition shared by every workspace. No org_id,
 * no RLS. Which workspace a FIRE belongs to is decided on the automation_runs
 * row, which is scoped.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db/index.ts";
import { systemCronOverrides } from "./db/schema.ts";

/** The only names this store will ever write — a closed set, not user input. */
// Only the every-minute dispatcher remains code-authored; every operational cron
// is a DB `schedule_rules` row now (managed via the Ops Center Schedules).
export const SYSTEM_CRON_NAMES = ["dynamic"] as const;
export type SystemCronName = (typeof SYSTEM_CRON_NAMES)[number];

export function isSystemCronName(name: string): name is SystemCronName {
  return (SYSTEM_CRON_NAMES as readonly string[]).includes(name);
}

export interface SystemCronOverride {
  name: string;
  enabled: boolean;
  deletedAt: Date | null;
  lastError: string | null;
  lastRunAt: Date | null;
  /**
   * Override cron expression (5-field, UTC; validated by the API before it is
   * persisted). NULL = the authored cadence applies. When set, the authored
   * handler steps aside and the every-minute dispatcher
   * (agent/schedules/dynamic.ts) owns this cron's timing.
   */
  cron: string | null;
  /**
   * Override PROMPT. NULL = the authored prompt in
   * agent/lib/system-cron-defs.ts applies. Honoured by whichever clock fires
   * the cron — the authored handler on the authored cadence, or the
   * dispatcher on an override cadence.
   */
  prompt: string | null;
  /**
   * Alert targets, same meaning as on the other record types: when set, a
   * NOTIFY TARGET line naming these addresses is appended to the message.
   */
  notifyEmails: string[] | null;
  /**
   * DEPRECATED — superseded by `notifyEmails` (a list). Fallback-only: it is
   * honoured only when `notifyEmails` is null/empty.
   */
  notifyEmail: string | null;
}

/** Map a DB row to the public shape — one place, so no field is ever dropped. */
function toOverride(row: typeof systemCronOverrides.$inferSelect): SystemCronOverride {
  return {
    name: row.name,
    enabled: row.enabled,
    deletedAt: row.deletedAt,
    lastError: row.lastError,
    lastRunAt: row.lastRunAt,
    cron: row.cron,
    prompt: row.prompt,
    notifyEmails: row.notifyEmails,
    notifyEmail: row.notifyEmail,
  };
}

/**
 * The pause gate. True when the cron may run: no row, or a row that is enabled
 * and not soft-deleted. Fails OPEN on a missing DB or a query error.
 */
export async function isSystemCronActive(name: SystemCronName): Promise<boolean> {
  const db = getDb();
  if (!db) return true; // no Postgres configured — never disable the cron
  try {
    const rows = await db
      .select()
      .from(systemCronOverrides)
      .where(eq(systemCronOverrides.name, name))
      .limit(1);
    const row = rows[0];
    if (!row) return true; // no override row — active by default
    return row.enabled && row.deletedAt === null;
  } catch (error) {
    console.error(
      `[system-cron-store] could not read the override for ${name}; failing open:`,
      error,
    );
    return true;
  }
}

export async function listSystemCronOverrides(): Promise<SystemCronOverride[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db.select().from(systemCronOverrides);
  return rows.map(toOverride);
}

/**
 * Read one cron's override row. Fails OPEN like `isSystemCronActive`: no DB,
 * no row, or a query error all return null — i.e. "no override, the authored
 * cadence applies". Used by the authored handlers (to step aside when a
 * cadence override exists) and by the dispatcher (to evaluate it).
 */
export async function getSystemCronOverride(
  name: SystemCronName,
): Promise<SystemCronOverride | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(systemCronOverrides)
      .where(eq(systemCronOverrides.name, name))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return toOverride(row);
  } catch (error) {
    console.error(
      `[system-cron-store] could not read the override for ${name}; treating as no override:`,
      error,
    );
    return null;
  }
}

/** Upsert — the row does not exist until the cron is first paused or deleted. */
async function upsert(
  name: SystemCronName,
  values: Partial<
    Pick<
      SystemCronOverride,
      | "enabled"
      | "deletedAt"
      | "lastError"
      | "lastRunAt"
      | "prompt"
      | "notifyEmails"
      | "notifyEmail"
    >
  >,
): Promise<SystemCronOverride | null> {
  const db = getDb();
  if (!db) return null;
  const now = new Date();
  const [row] = await db
    .insert(systemCronOverrides)
    .values({ name, ...values, updatedAt: now })
    .onConflictDoUpdate({
      target: systemCronOverrides.name,
      set: { ...values, updatedAt: now },
    })
    .returning();
  return row ? toOverride(row) : null;
}

export function setSystemCronEnabled(
  name: SystemCronName,
  enabled: boolean,
): Promise<SystemCronOverride | null> {
  return upsert(name, { enabled });
}

export function softDeleteSystemCron(name: SystemCronName): Promise<SystemCronOverride | null> {
  return upsert(name, { deletedAt: new Date() });
}

export function restoreSystemCron(name: SystemCronName): Promise<SystemCronOverride | null> {
  return upsert(name, { deletedAt: null, enabled: true });
}

/**
 * Record a dispatch outcome. Best-effort: a bookkeeping failure must never take
 * down the cron run it is describing.
 */
export async function recordSystemCronRun(
  name: SystemCronName,
  { ranAt, error }: { ranAt: Date; error?: string },
): Promise<void> {
  try {
    await upsert(name, { lastRunAt: ranAt, lastError: error ?? null });
  } catch (bookkeepingError) {
    console.error(`[system-cron-store] could not record the run for ${name}:`, bookkeepingError);
  }
}
