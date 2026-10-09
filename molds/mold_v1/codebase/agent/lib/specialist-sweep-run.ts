/**
 * THE SPECIALIST SWEEP, WIRED: eve's runtime (agent/lib/specialist-sweep-world.ts), the ledger
 * (agent/lib/sweep-ledger.ts) and the bounds (agent/lib/specialist-sweep-settings.ts) behind the pure sweep
 * (agent/lib/specialist-sweep.ts; mold_v1-196).
 *
 * Two ways in:
 *
 *   sweepAllWorkspaces   the schedule (agent/schedules/sweep-specialists.ts, every 5 minutes): every workspace, each in
 *                        its own row-level scope, every main thread with a delegation within the window not yet seen
 *                        settled, or that the ledger still has something open for (agent/lib/sweep-ledger.ts
 *                        `sweepCandidates`; mold_v1-199: a pass is proportional to the delegations still outstanding).
 *   sweepOnTurnStart     the session guard, when a person's message starts a turn on a main thread
 *                        (agent/lib/session-guard.ts): that main thread, in the workspace the guard decided, in the
 *                        background, at most once every 30 s per thread in this process.
 *
 * Either way a main thread is swept only as a main thread OF THAT WORKSPACE: its owner record there names no root
 * (it is not a delegation itself). The specialists it looks at are the ones the main thread's own stream announced
 * (eve's history, never a client's). What it delivers goes to that main thread only. Either way, the delegations that
 * read saw settled for good are marked (`markSettled`), so the schedule does not read the thread for them again.
 */
import { sweepMainThread, type SweepOutcome } from "./specialist-sweep.ts";
import { specialistSweepSettings, type SpecialistSweepSettings } from "./specialist-sweep-settings.ts";
import { markSettled, sweepCandidates, sweepLedger } from "./sweep-ledger.ts";
import { runtimeWorld, type SweepRuntime } from "./specialist-sweep-world.ts";

export type { SweepRuntime } from "./specialist-sweep-world.ts";
import { readOwnerRecordIn, type GateDb } from "../../lib/session-gate.ts";

/** Loaded on first use: the session guard's tests and the plain-node scripts never load eve's runtime for it. */
async function defaultRuntime(): Promise<SweepRuntime> {
  const channels = (await import("eve/channels")) as unknown as { delegationSweep: SweepRuntime };
  return channels.delegationSweep;
}

/** Sweep one main thread of `orgId` — only if its owner record THERE says it is a main thread. Never throws. */
export async function sweepOneMainThread(
  db: Pick<GateDb, "inOrg">,
  orgId: string,
  sessionId: string,
  deps: { runtime?: SweepRuntime; settings?: SpecialistSweepSettings; counts?: { outstanding: number } } = {},
): Promise<SweepOutcome[]> {
  try {
    const settings = deps.settings ?? specialistSweepSettings();
    if (!settings.enabled) return [];
    const owner = await readOwnerRecordIn(db, orgId, sessionId);
    if (!owner || owner.orgId !== orgId || owner.rootSessionId) return [];
    const rt = deps.runtime ?? (await defaultRuntime());
    const seen = { outstanding: 0, settled: [] as string[] };
    const outcomes = await sweepMainThread(runtimeWorld(rt, sweepLedger(db, orgId), settings), sessionId, seen);
    if (deps.counts) deps.counts.outstanding += seen.outstanding;
    // What this read saw settled for good: the scheduled sweep does not read this main thread for those again.
    await markSettled(db, orgId, sessionId, seen.settled).catch((error) =>
      console.error("[specialist-sweep] could not mark delegations settled", { orgId, sessionId, error: error instanceof Error ? error.message : String(error) }),
    );
    const acted = outcomes.filter((o) => o.action !== "held");
    if (acted.length) console.log(`[specialist-sweep] ${JSON.stringify({ orgId, sessionId, outcomes: acted })}`);
    return outcomes;
  } catch (error) {
    console.error("[specialist-sweep] could not sweep a main thread", { orgId, sessionId, error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/** When this process last swept each main thread on a turn start, and which sweeps are running now. */
const lastOnTurn = new Map<string, number>();
const running = new Map<string, Promise<unknown>>();
const TURN_START_EVERY_MS = 30_000;
const MAX_REMEMBERED = 5_000;

/** The check at a turn start (the session guard): background, bounded, once per 30 s per main thread here. */
export function sweepOnTurnStart(db: Pick<GateDb, "inOrg">, orgId: string, sessionId: string, deps: { runtime?: SweepRuntime; settings?: SpecialistSweepSettings } = {}): Promise<unknown> {
  const now = Date.now();
  const key = `${orgId}\u0000${sessionId}`;
  const last = lastOnTurn.get(key);
  if ((last !== undefined && now - last < TURN_START_EVERY_MS) || running.has(key)) return running.get(key) ?? Promise.resolve();
  if (lastOnTurn.size >= MAX_REMEMBERED) lastOnTurn.delete(lastOnTurn.keys().next().value as string);
  lastOnTurn.set(key, now);
  const run = sweepOneMainThread(db, orgId, sessionId, deps).finally(() => running.delete(key));
  running.set(key, run);
  return run;
}

/** For tests: forget the turn-start throttle. */
export function clearSweepThrottle(): void {
  lastOnTurn.clear();
  running.clear();
}

/** The workspaces a system job may enumerate, and each one's scope (agent/lib/session-owner-backfill.ts). */
export interface SweepSystemDb extends Pick<GateDb, "inOrg"> {
  listOrgs(): Promise<string[]>;
}

/** What one scheduled pass did: counts only, never a session's contents or another workspace's anything. */
export interface SweepPassTally {
  workspaces: number;
  threads: number;
  outstanding: number;
  frozen: number;
  undelivered: number;
  unreported: number;
  surfaced: number;
  /** A pass that stopped early says why (the error's message, not a stack). */
  error?: string;
}

/** The acted-on count: what the sweep did something about (a surfaced note is shown, not acted on). */
export const actedOn = (t: SweepPassTally): number => t.frozen + t.undelivered + t.unreported;

/**
 * THE ONE LINE EVERY PASS WRITES (mold_v1-198), the same shape whether it found anything or not, so the journal shows the
 * sweep is alive every 5 minutes:
 *   [specialist-sweep] pass: 4 thread(s) checked in 2 workspace(s), 1 delegation(s) outstanding, acted on 1 (frozen 1,
 *   undelivered 0, unreported 0, surfaced 0) in 812 ms
 * …and, when the pass stopped early, `; stopped early: <message>`. Counts only.
 */
export function sweepPassLine(t: SweepPassTally, ms: number): string {
  const base =
    `[specialist-sweep] pass: ${t.threads} thread(s) checked in ${t.workspaces} workspace(s), ${t.outstanding} delegation(s) outstanding, ` +
    `acted on ${actedOn(t)} (frozen ${t.frozen}, undelivered ${t.undelivered}, unreported ${t.unreported}, surfaced ${t.surfaced}) in ${Math.max(0, Math.round(ms))} ms`;
  return t.error ? `${base}; stopped early: ${t.error.replace(/\s+/g, " ").slice(0, 200)}` : base;
}

/**
 * The scheduled sweep: every workspace, each in its own scope, until `budgetMs` is spent (what is left is swept on the
 * next run). Never throws. Writes its one pass line (`sweepPassLine`) every time — to the error log when it stopped
 * early — and returns the tally. Off (`SPECIALIST_SWEEP=off`): one line saying so.
 */
export async function sweepAllWorkspaces(
  db: SweepSystemDb | null,
  deps: { runtime?: SweepRuntime; settings?: SpecialistSweepSettings; budgetMs?: number; log?: (line: string) => void; logError?: (line: string) => void; now?: () => number } = {},
): Promise<SweepPassTally> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const logError = deps.logError ?? ((line: string) => console.error(line));
  const started = now();
  const settings = deps.settings ?? specialistSweepSettings();
  const tally: SweepPassTally = { workspaces: 0, threads: 0, outstanding: 0, frozen: 0, undelivered: 0, unreported: 0, surfaced: 0 };
  if (!settings.enabled) {
    log("[specialist-sweep] pass: off (SPECIALIST_SWEEP=off)");
    return tally;
  }
  if (!db) {
    tally.error = "no database configured";
    logError(sweepPassLine(tally, now() - started));
    return tally;
  }
  const deadline = started + (deps.budgetMs ?? 240_000);
  let rt: SweepRuntime | undefined = deps.runtime;
  const counts = { outstanding: 0 };
  try {
    for (const orgId of await db.listOrgs()) {
      if (now() >= deadline) break;
      tally.workspaces++;
      let ids: string[] = [];
      try {
        ids = await sweepCandidates(db, orgId, settings.lookbackMs);
      } catch (error) {
        console.error("[specialist-sweep] could not list a workspace's main threads", { orgId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      for (const id of ids) {
        if (now() >= deadline) break;
        rt ??= await defaultRuntime();
        tally.threads++;
        const outcomes = await sweepOneMainThread(db, orgId, id, { runtime: rt, settings, counts });
        for (const o of outcomes) {
          if (o.action === "held") continue;
          if (o.action === "surfaced") tally.surfaced++;
          else if (o.kind === "frozen" || o.kind === "undelivered" || o.kind === "unreported") tally[o.kind]++;
        }
      }
    }
  } catch (error) {
    tally.error = error instanceof Error ? error.message : String(error);
  }
  tally.outstanding = counts.outstanding;
  const line = sweepPassLine(tally, now() - started);
  if (tally.error) logError(line);
  else log(line);
  return tally;
}
