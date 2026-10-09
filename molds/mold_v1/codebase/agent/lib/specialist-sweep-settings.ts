/**
 * THE SPECIALIST SWEEP'S BOUNDS, read from the environment in one place (mold_v1-196). What the sweep does with them is
 * agent/lib/specialist-sweep.ts; where it runs is agent/schedules/sweep-specialists.ts (every 5 minutes) and the session
 * guard (each time a person's message starts a turn on a main thread).
 *
 *   SPECIALIST_SWEEP              "off" turns the sweep off (nothing is read, nothing is done). Default on.
 *   SPECIALIST_SWEEP_FROZEN_MIN   a specialist that has written nothing (no event, no progress) for this many minutes,
 *                                 and is not waiting on a person or for a free sandbox, is FROZEN: it is stopped and
 *                                 the main agent is told why. Default 30. Never less than 10: on Vercel a session's start
 *                                 can wait 300 s in the workflow queue, and "not started yet" is not "frozen".
 *   SPECIALIST_SWEEP_GRACE_S      how long after a specialist came to rest (finished, stopped, crashed) the sweep leaves
 *                                 the hand-back to eve before it hands the outcome back itself. Default 120; never
 *                                 less than 30.
 *   SPECIALIST_SWEEP_WAITING_H    a specialist that has waited on a person's answer or approval for this many hours is
 *                                 SURFACED (it is never stopped). Default 4.
 *   SPECIALIST_SWEEP_LOOKBACK_H   the scheduled sweep looks at main threads that delegated within this many hours,
 *                                 and of those only the ones with a delegation not yet seen settled (mold_v1-199).
 *                                 Default 72. (A main thread a person writes in is checked whatever its age.)
 *
 * A value that is set and not a number is reported once and the default is used: a typo must not turn the sweep off.
 * No imports, on purpose: tests and the plain-node scripts load this module.
 */

type Env = Record<string, string | undefined>;

export interface SpecialistSweepSettings {
  readonly enabled: boolean;
  /** No event for this long (ms) and not waiting on a person: frozen. */
  readonly frozenMs: number;
  /** Rested this long (ms) without the main agent being told: the sweep tells it. */
  readonly graceMs: number;
  /** Waiting on a person this long (ms): surfaced. */
  readonly waitingMs: number;
  /** The scheduled sweep's window (ms). */
  readonly lookbackMs: number;
}

export const SWEEP_DEFAULTS = { frozenMin: 30, graceS: 120, waitingH: 4, lookbackH: 72 } as const;
/** The floors: below them the sweep would act on work that is merely slow to start or to report. */
export const SWEEP_FLOORS = { frozenMin: 10, graceS: 30 } as const;

const reported = new Set<string>();

function numberSetting(env: Env, name: string, fallback: number, floor = 0): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    if (!reported.has(name)) {
      reported.add(name);
      console.error(`[specialist-sweep] ${name}=${JSON.stringify(raw)} is not a number of the right kind; using the default, ${fallback}.`);
    }
    return fallback;
  }
  return Math.max(floor, n);
}

export function specialistSweepSettings(env: Env = process.env): SpecialistSweepSettings {
  const off = (env.SPECIALIST_SWEEP ?? "").trim().toLowerCase();
  return {
    enabled: !(off === "off" || off === "0" || off === "false"),
    frozenMs: numberSetting(env, "SPECIALIST_SWEEP_FROZEN_MIN", SWEEP_DEFAULTS.frozenMin, SWEEP_FLOORS.frozenMin) * 60_000,
    graceMs: numberSetting(env, "SPECIALIST_SWEEP_GRACE_S", SWEEP_DEFAULTS.graceS, SWEEP_FLOORS.graceS) * 1000,
    waitingMs: numberSetting(env, "SPECIALIST_SWEEP_WAITING_H", SWEEP_DEFAULTS.waitingH) * 3_600_000,
    lookbackMs: numberSetting(env, "SPECIALIST_SWEEP_LOOKBACK_H", SWEEP_DEFAULTS.lookbackH) * 3_600_000,
  };
}
