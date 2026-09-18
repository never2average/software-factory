/**
 * Append-only change log for automations (`automation_audit`).
 *
 * One row per configuration change (create / patch / pause / delete), written
 * as a human-readable sentence, e.g. `Cadence changed 60m → 30m`. The Next-side
 * ops API writes its own rows via `lib/ops-audit.ts` (Next cannot import this
 * module — it uses `.ts` specifiers the Next bundler will not resolve); this
 * store is for the agent runtime and for scripts.
 *
 * Best-effort, exactly like `automation-runs.ts`: `recordAudit` swallows and
 * logs failures (an audit-write failure must never fail the change it
 * describes) and both functions are no-ops without a Postgres URL.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { automationAudit } from "./db/schema.ts";
import type { AutomationType } from "./automation-runs.ts";

export interface RecordAuditInput {
  /**
   * The workspace this row belongs to. REQUIRED.
   *
   * It was omitted and the column defaulted to 'org-onfinance' — a workspace
   * that does not exist — so the row landed where nobody could ever read it,
   * and once the isolation policy is fail-closed it would be unreadable
   * forever. There is no correct workspace to guess, so the caller must say.
   */
  orgId: string;
  automationType: AutomationType;
  /** The automation row's uuid, or the system cron's name. */
  automationId: string;
  /** The caller's email, or "system" for runtime-initiated changes. */
  actor: string;
  /** Human sentence describing the change. */
  event: string;
}

export interface AutomationAuditRecord {
  id: string;
  automationType: string;
  automationId: string;
  actor: string;
  event: string;
  createdAt: string;
}

/**
 * Append one audit row. Best-effort: never throws, no-op without a DB.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await withOrgDb(input.orgId, (tx) =>
      tx.insert(automationAudit).values({
        orgId: input.orgId,
        automationType: input.automationType,
        automationId: input.automationId,
        actor: input.actor,
        event: input.event,
      }),
    );
  } catch (bookkeepingError) {
    console.error(
      `[automation-audit] could not record the audit for ${input.automationType}/${input.automationId}:`,
      bookkeepingError,
    );
  }
}

/**
 * List the most recent audit entries for one automation, newest first.
 * Best-effort: returns [] without a DB or on a query error.
 */
export async function listAudit(
  /**
   * The workspace to read within. REQUIRED: this listed by automation id
   * alone, so it returned another workspace's history to anyone who knew (or
   * guessed) an id — the same hole the /api/ops/audit route had.
   */
  orgId: string,
  type: AutomationType,
  id: string,
  limit = 20,
): Promise<AutomationAuditRecord[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select()
        .from(automationAudit)
        .where(
          and(
            eq(automationAudit.orgId, orgId),
            eq(automationAudit.automationType, type),
            eq(automationAudit.automationId, id),
          ),
        )
        .orderBy(desc(automationAudit.createdAt))
        .limit(limit),
    );
    return rows.map((r) => ({
      id: r.id,
      automationType: r.automationType,
      automationId: r.automationId,
      actor: r.actor,
      event: r.event,
      createdAt: r.createdAt.toISOString(),
    }));
  } catch (error) {
    console.error(`[automation-audit] could not list audit for ${type}/${id}:`, error);
    return [];
  }
}
