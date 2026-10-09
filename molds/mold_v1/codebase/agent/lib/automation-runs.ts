/**
 * Append-only run history for automations (`automation_runs`).
 *
 * One row per fire of a dynamic schedule rule, a code-authored system cron, a
 * connector sync, or a workflow delegation. Written by the run ITSELF, so it
 * is strictly best-effort: `recordRun` swallows and logs every failure — a
 * bookkeeping error must NEVER take down the run it describes (the same rule
 * `recordSystemCronRun` follows in `system-cron-store.ts`). With no Postgres
 * URL configured both functions are no-ops: run history is an observability
 * surface, not a fallback-worthy store.
 *
 * NOTE: like `schedule-store.ts`, this module sticks to relative `.ts`
 * specifiers so it can run under plain `node --experimental-strip-types`,
 * which does not resolve the `#lib/*.js` subpath aliases the eve bundler
 * rewrites.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb, withOrgDb } from "./db/index.ts";
import { automationRuns } from "./db/schema.ts";

/**
 * The closed set of automation kinds a run or AUDIT row may describe.
 *
 * `chat` is not an automation and never appears in `automation_runs`; it is here
 * because `automation-audit.ts` shares this union, and the web surface has
 * written `automation_type = 'chat'` audit rows since chat telemetry shipped
 * (`OpsAutomationType`, lib/ops-audit.ts). The agent runtime could not — a
 * server-side chat incident had no kind to file under. That is one reason an
 * empty model response killed live turns on 2026-09-23 and left no row anywhere
 * an operator could read.
 */
export const AUTOMATION_TYPES = ["schedule", "system_cron", "connector", "workflow", "browser", "chat"] as const;
export type AutomationType = (typeof AUTOMATION_TYPES)[number];

export type AutomationRunStatus = "success" | "failed" | "running";

export interface RecordRunInput {
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
  status: AutomationRunStatus;
  startedAt: Date;
  durationMs?: number;
  /** One-line human summary of what the run did. */
  summary?: string;
  error?: string;
}

export interface AutomationRunRecord {
  id: string;
  automationType: string;
  automationId: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  summary: string | null;
  error: string | null;
}

/**
 * Append one run row. Best-effort: never throws, no-op without a DB.
 */
export async function recordRun(input: RecordRunInput): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await withOrgDb(input.orgId, (tx) =>
      tx.insert(automationRuns).values({
        orgId: input.orgId,
        automationType: input.automationType,
        automationId: input.automationId,
        status: input.status,
        startedAt: input.startedAt,
        durationMs: input.durationMs ?? null,
        summary: input.summary ?? null,
        error: input.error ?? null,
      }),
    );
  } catch (bookkeepingError) {
    console.error(
      `[automation-runs] could not record the ${input.automationType} run for ${input.automationId}:`,
      bookkeepingError,
    );
  }
}

/**
 * List the most recent runs for one automation, newest first. Best-effort:
 * returns [] without a DB or on a query error.
 */
export async function listRuns(
  /**
   * The workspace to read within. REQUIRED: this listed by automation id
   * alone, so it returned another workspace's history to anyone who knew (or
   * guessed) an id — the same hole the /api/ops/audit route had.
   */
  orgId: string,
  type: AutomationType,
  id: string,
  limit = 10,
): Promise<AutomationRunRecord[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await withOrgDb(orgId, (tx) =>
      tx
        .select()
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.orgId, orgId),
            eq(automationRuns.automationType, type),
            eq(automationRuns.automationId, id),
          ),
        )
        .orderBy(desc(automationRuns.startedAt))
        .limit(limit),
    );
    return rows.map((r) => ({
      id: r.id,
      automationType: r.automationType,
      automationId: r.automationId,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      durationMs: r.durationMs,
      summary: r.summary,
      error: r.error,
    }));
  } catch (error) {
    console.error(`[automation-runs] could not list runs for ${type}/${id}:`, error);
    return [];
  }
}
