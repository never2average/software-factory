/**
 * Dictation's text, put back IN ORDER and at a place that MOVES WITH THE PERSON'S EDITS.
 *
 * Sections of speech are transcribed one request each (lib/dictation-segmenter.ts), and the answers come back in any
 * order: a short section sent second is often answered before a long one sent first. `createOrderBuffer` holds an
 * answer until every section before it has been answered (or given up on), so the words always read as spoken.
 *
 * The text lands at an ANCHOR: where the cursor was when listening started, then just after whatever has landed. The
 * message box stays the person's while they talk: `shiftAnchor` moves the anchor by what they typed or deleted, so
 * dictated text never overwrites typed text and typed text is never moved out from under the cursor.
 *
 * NO IMPORTS, and pure (scripts/test-dictation.mjs).
 */

export interface OrderBuffer<T> {
  /**
   * Section `seq` is answered (`value`) or will never be (`null`: refused, failed, nothing heard). Returns what can
   * now be shown, in spoken order: nothing while an earlier section is still out.
   */
  settle(seq: number, value: T | null): T[];
  /** Answers held back, waiting for an earlier section. */
  readonly held: number;
  /** The next section the buffer is waiting for. */
  readonly next: number;
}

export function createOrderBuffer<T>(): OrderBuffer<T> {
  const waiting = new Map<number, T | null>();
  let next = 0;
  return {
    settle(seq, value) {
      if (!Number.isInteger(seq) || seq < next || waiting.has(seq)) return [];
      waiting.set(seq, value);
      const ready: T[] = [];
      while (waiting.has(next)) {
        const v = waiting.get(next) as T | null;
        waiting.delete(next);
        next++;
        if (v !== null) ready.push(v);
      }
      return ready;
    },
    get held() {
      return waiting.size;
    },
    get next() {
      return next;
    },
  };
}

/** Where dictated text lands in the box: over [start, end) the first time (the selection), then at a point. */
export interface Anchor {
  readonly start: number;
  readonly end: number;
}

/**
 * The anchor after the box's text changed from `before` to `after` by someone else's edit (typing, a paste, a delete,
 * the message being sent and the box emptied). The edit is the stretch between the longest common start and end:
 *   - an edit after the anchor leaves it alone; one before it moves it by the difference in length;
 *   - typing exactly AT the anchor puts the anchor after what was typed (dictation carries on after it);
 *   - an edit that reaches into the anchor's own range (the selection was typed over) collapses it to the edit's end.
 *
 * `caret` is where the person's cursor is after their edit, when it is known. Two texts alone cannot always say where
 * an edit was: " typed" put after "Start" and "typed " put before " end" give the same "Start typed end". The cursor
 * can: it sits at the end of what was just typed or pasted, and where a deletion was.
 */
export function shiftAnchor(anchor: Anchor, before: string, after: string, caret?: number | null): Anchor {
  if (before === after) return clamp(anchor, after.length);
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  if (typeof caret === "number") {
    // The same edit read further left, as far as the cursor: believed only if the texts allow it all the way there.
    let slide = after.length - s - caret;
    let [q, t] = [p, s];
    while (slide > 0 && q > 0 && before.charCodeAt(q - 1) === before.charCodeAt(before.length - t - 1) && after.charCodeAt(q - 1) === after.charCodeAt(after.length - t - 1)) {
      q--;
      t++;
      slide--;
    }
    if (slide === 0) [p, s] = [q, t];
  }
  const oldEnd = before.length - s;
  const newEnd = after.length - s;
  const move = (pos: number) => (pos >= oldEnd ? pos + (newEnd - oldEnd) : pos <= p ? pos : newEnd);
  const touched = anchor.end > anchor.start && p < anchor.end && oldEnd > anchor.start;
  return clamp(touched ? { start: newEnd, end: newEnd } : { start: move(anchor.start), end: move(anchor.end) }, after.length);
}

function clamp(anchor: Anchor, length: number): Anchor {
  const start = Math.max(0, Math.min(anchor.start, length));
  return { start, end: Math.max(start, Math.min(anchor.end, length)) };
}

/**
 * A cursor or selection edge at `pos`, after `inserted` characters replaced [start, end): the person's own cursor
 * keeps its place in THEIR text. One that sat at or after the landing point rides along to stay after the new words.
 */
export function shiftCaret(pos: number, start: number, end: number, inserted: number): number {
  if (pos < start) return pos;
  if (pos >= end) return pos + inserted - (end - start);
  return start + inserted;
}
