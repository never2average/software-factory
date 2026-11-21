// One status vocabulary for everything that runs (mold_v0-334): the console's copy of src/run-words.ts (the server's), held
// equal by scripts/run-words-test.ts. A job's run, an agent session, a child of a tree and an evaluation each keep their
// own stored values; people read these words, the same on every page.
export const RUN_STATUSES = ['queued', 'running', 'needs_you', 'paused', 'succeeded', 'failed', 'stopped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type RunNeeds = 'you' | 'staff';
export const RUN_STATUS_WORDS: Record<RunStatus, string> = {
  queued: 'Waiting to start', running: 'Working', needs_you: 'Needs you', paused: 'Paused', succeeded: 'Done', failed: 'Failed', stopped: 'Stopped'
};
/** Whose decision a run waits for, in words. */
export const NEEDS_WORDS: Record<RunNeeds, string> = { you: 'Needs you', staff: 'Needs staff' };

export const RUN_OUTCOME_BADGES = ['accepted', 'refused', 'waiting_for_staff', 'applied', 'rolled_back'] as const;
export type RunOutcomeBadge = (typeof RUN_OUTCOME_BADGES)[number];
export const OUTCOME_WORDS: Record<RunOutcomeBadge, string> = { accepted: 'Accepted', refused: 'Refused', waiting_for_staff: 'Waiting for staff', applied: 'Applied', rolled_back: 'Rolled back' };

/** Every stored value of every run-like table, as the one status. */
const FROM: Record<string, RunStatus> = {
  queued: 'queued', running: 'running', succeeded: 'succeeded', failed: 'failed', cancelled: 'stopped',
  done: 'succeeded', error: 'failed',
  pending: 'queued', decided: 'succeeded',
  starting: 'queued', working: 'running', waking: 'running', waiting: 'needs_you', awaiting_approval: 'needs_you', awaiting: 'needs_you',
  parked: 'paused', paused: 'paused', stopped: 'stopped', archived: 'stopped', live: 'running'
};
/** The one status of a stored value (unknown values read as working: never hidden as done). */
export const runStatusOf = (raw: string | null | undefined): RunStatus => (raw ? FROM[raw] ?? 'running' : 'queued');

/** An evaluation's outcome (accepted, refused, needs_review) as its badge. */
export const evaluationOutcome = (outcome: string | null | undefined): RunOutcomeBadge | null =>
  outcome === 'accepted' ? 'accepted' : outcome === 'refused' ? 'refused' : outcome === 'needs_review' ? 'waiting_for_staff' : null;

/** The words of a status, saying whose decision it waits for. */
export const statusWords = (s: RunStatus, needs?: RunNeeds | null) => (s === 'needs_you' ? NEEDS_WORDS[needs ?? 'you'] : RUN_STATUS_WORDS[s]);

/** Each status's and outcome's tone: working green, waiting for a decision amber, failed red, the rest neutral. */
export const STATUS_TONE: Record<RunStatus, string> = {
  queued: '', running: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300', needs_you: 'border-amber-500/50 text-amber-700 dark:text-amber-300',
  paused: '', succeeded: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300', failed: 'border-destructive/50 text-destructive', stopped: ''
};
export const OUTCOME_TONE: Record<RunOutcomeBadge, string> = {
  accepted: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300', applied: 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300',
  refused: 'border-destructive/50 text-destructive', waiting_for_staff: 'border-amber-500/50 text-amber-700 dark:text-amber-300', rolled_back: ''
};
