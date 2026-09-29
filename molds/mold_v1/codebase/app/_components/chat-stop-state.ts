/**
 * WHAT A STOP LEFT BEHIND, held for the page's lifetime — and whose it is (mold_v1-141).
 *
 * Three module-level maps outlive a chat's remount (a refresh of the transcript, a hand-back, a resync), which is
 * why they are not component state:
 *
 *   - the Stop's transcript MARKERS (`client.turn.stopped`) — the Stop's answer and the remount race, so the marker
 *     must reach whichever mounted instance is current (review of #72/#74);
 *   - the Stop's NOTE shown above the composer;
 *   - the turn ids THIS TAB asked to stop, so a cancelled turn can say who stopped it.
 *
 * They were keyed by chatKey alone and nothing cleared them. chatKey is a chat's id, not a person's: on a shared
 * machine the next person to sign in, or the same person in another workspace, opening a chat with the same key
 * was shown the previous one's Stop markers and notes. Now every entry is keyed `${email}:${orgId}:${chatKey}`
 * (`stopKey`), and sign-out forgets all of it (`forgetStopState`, from auth-gate's signOut).
 *
 * Plain TypeScript, no React: the auth gate imports it without pulling in the chat, and the test loads it in node.
 */
import type { TurnEvent } from "@/lib/chat-turn-state";

/**
 * The key every map here is read and written under. `scope` is the chat cache's `${email}:${orgId}` (AgentChat's
 * `storageScope`); a mount without one (no signed-in email) gets a scope of its own that no person's key can equal.
 */
export function stopKey(scope: string | null | undefined, chatKey: string): string {
  return `${scope && scope.trim() ? scope.trim().toLowerCase() : ":"}:${chatKey}`;
}

/** A Stop's note, by stopKey — it must outlive the remount a refresh or a hand-back causes. */
export const stopNotes = new Map<string, string>();
/** Turn ids this tab asked to stop, by stopKey — so a cancelled turn can say who stopped it. */
export const stoppedHere = new Map<string, Set<string>>();

const stopMarkers = new Map<string, TurnEvent[]>();
const stopMarkerListeners = new Map<string, Set<() => void>>();

/** Record a Stop's marker and tell every mounted instance of that chat. */
export function recordStopMarker(key: string, marker: TurnEvent): void {
  stopMarkers.set(key, [...(stopMarkers.get(key) ?? []), marker]);
  for (const listen of stopMarkerListeners.get(key) ?? []) listen();
}

/** The Stop markers recorded for this key so far. */
export function stopMarkersFor(key: string): TurnEvent[] {
  return stopMarkers.get(key) ?? [];
}

/** Be told when a marker is recorded for this key. Returns the unsubscribe. */
export function onStopMarker(key: string, listen: () => void): () => void {
  const listeners = stopMarkerListeners.get(key) ?? new Set<() => void>();
  listeners.add(listen);
  stopMarkerListeners.set(key, listeners);
  return () => {
    listeners.delete(listen);
    if (!listeners.size) stopMarkerListeners.delete(key);
  };
}

/**
 * Sign-out: nothing a Stop left survives into the next person's session. Mounted listeners are told, so a chat
 * still on screen drops the markers it was showing.
 */
export function forgetStopState(): void {
  stopNotes.clear();
  stoppedHere.clear();
  stopMarkers.clear();
  for (const listeners of stopMarkerListeners.values()) for (const listen of listeners) listen();
}
