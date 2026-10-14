/**
 * ONE OPEN AT A TIME: a later click cancels the open in flight, and an abandoned open can never write.
 *
 * `openChat` (app/_components/chat-shell.tsx) awaits the network twice or three times before it mounts anything: the
 * saved copy, the seam read, the full replay. It had no guard, so a click on chat A followed by a click on chat B could
 * end with A on screen: A's saved copy landed after B had mounted and `setMountKey(A)` put A back, under B's sidebar
 * highlight. `resync` already guarded itself by comparing a mount-key ref; `openChat` did not, and the background
 * replacement of a saved copy the stream disagrees with (lib/chat-snapshot.ts `seamVerdict`) would have widened the
 * window further.
 *
 * Each open claims a ticket. Claiming aborts the previous ticket's signal (its requests are cancelled, so an abandoned
 * open stops costing bandwidth too) and makes its `current()` false for ever. The shell checks `current()` after every
 * await and before every state write, and passes `signal` to every request it makes for the open.
 *
 * Every other way of putting something else in the chat pane (a new chat, a fork, a shared chat, an automation's
 * session) claims a ticket as well, so an open in flight cannot land on top of it.
 */
export interface OpenTicket {
  /** Increments per claim. */
  readonly seq: number;
  /** Aborted when a later open claims, or when this one is released. */
  readonly signal: AbortSignal;
  /** Is this still the open the person asked for last? */
  current(): boolean;
}

export interface OpenGuard {
  /** Start an open: cancels the one in flight and returns this one's ticket. */
  claim(): OpenTicket;
  /** The ticket of the latest open, if any. */
  latest(): OpenTicket | null;
}

export function createOpenGuard(): OpenGuard {
  let seq = 0;
  let live: { ticket: OpenTicket; ctrl: AbortController } | null = null;
  return {
    claim() {
      if (live) {
        try {
          live.ctrl.abort();
        } catch {
          /* never */
        }
      }
      const ctrl = new AbortController();
      const mine = ++seq;
      const ticket: OpenTicket = {
        seq: mine,
        signal: ctrl.signal,
        current: () => seq === mine && !ctrl.signal.aborted,
      };
      live = { ticket, ctrl };
      return ticket;
    },
    latest() {
      return live?.ticket ?? null;
    },
  };
}
