/**
 * WHO IS WAITING FOR A FREE SANDBOX, read live (mold_v1-194).
 *
 * Off Vercel, the sandbox guard (agent/lib/sandbox-guard.ts) lets at most `maxRunning` sandboxes run on the host; a
 * further command waits in line for up to SANDBOX_WAIT_S (180 s). Before this, the person saw nothing until the call's
 * result said it had waited. The guard now keeps, on each place in that line, the session that is waiting and since
 * when; this module reads the line for the session guard's status route (`GET /eve/v1/session/:id/sandbox-wait`,
 * agent/lib/session-guard.ts), which answers only for the caller's own session and its delegated children.
 *
 * The line lives in the guard's per-process pool, under a `Symbol.for` key on `globalThis`, so this module reads it
 * WITHOUT loading the guard: on Vercel (no guard, no cap) there is no pool, and every read here is an empty list.
 * No imports, on purpose: it is loaded by the session guard on every deployment.
 */

/** Where the guard keeps its pool on `globalThis` (agent/lib/sandbox-guard.ts `processPool`). */
export const SANDBOX_POOL_KEY = Symbol.for("app.sandbox.guard.pool");

/** One place in the line, as the guard records it. */
export interface SandboxWaitPlace {
  /** The session whose command is waiting (eve's `sessionId` tag: its OWN id), or null when eve gave none. */
  readonly sessionId: string | null;
  /** When it started waiting (ms since the epoch). */
  readonly since: number;
}

/** A place in the line, as a status read reports it: 1 = next to get a sandbox. */
export interface SandboxWaitView {
  readonly sessionId: string | null;
  readonly position: number;
  readonly since: number;
}

/** What a person's status read answers: their own waits only, nearest the front first. */
export interface SandboxWaitStatus {
  readonly ok: true;
  readonly waits: readonly { readonly position: number; readonly waitedS: number }[];
}

type PoolLike = { readonly waiting?: readonly Partial<SandboxWaitPlace>[] } | undefined;

/**
 * Every place in the line in this process (or in `pool`, for a test), front first. Empty when no guard runs here
 * (every Vercel deployment).
 */
export function sandboxWaitLine(pool: PoolLike = (globalThis as unknown as Record<symbol, PoolLike>)[SANDBOX_POOL_KEY]): SandboxWaitView[] {
  const line = pool?.waiting;
  if (!Array.isArray(line) || line.length === 0) return [];
  return line.map((w, i) => ({
    sessionId: typeof w?.sessionId === "string" && w.sessionId ? w.sessionId : null,
    position: i + 1,
    since: typeof w?.since === "number" ? w.since : Date.now(),
  }));
}

/**
 * The waits that belong to `sessionId`: its own, and those of any session `rootOf` says hangs off it (a delegated
 * specialist's child session, whose root is the chat). `rootOf` answers ONLY within the caller's workspace and
 * null for anything else, so a wait of another workspace's session is never counted, named or shown; only its
 * place in the shared line moves ours. Never throws: a session `rootOf` cannot place is left out.
 */
export async function sandboxWaitStatus(
  sessionId: string,
  rootOf: (waiting: string) => Promise<string | null>,
  line: readonly SandboxWaitView[] = sandboxWaitLine(),
  now: number = Date.now(),
): Promise<SandboxWaitStatus> {
  const waits: { position: number; waitedS: number }[] = [];
  const roots = new Map<string, string | null>();
  for (const place of line) {
    if (!place.sessionId) continue;
    let mine = place.sessionId === sessionId;
    if (!mine) {
      if (!roots.has(place.sessionId)) roots.set(place.sessionId, await rootOf(place.sessionId).catch(() => null));
      mine = roots.get(place.sessionId) === sessionId;
    }
    if (mine) waits.push({ position: place.position, waitedS: Math.max(0, Math.round((now - place.since) / 1000)) });
  }
  return { ok: true, waits };
}
