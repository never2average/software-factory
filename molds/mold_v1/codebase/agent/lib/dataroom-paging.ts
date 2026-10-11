/**
 * PAGED DATA-ROOM READS — `dataroom_read` and `dataroom_list` hand a large file or listing back one page at a time
 * (mold_v1-220).
 *
 * A tool result stays in the session's history, and every later step of the session resends the history. A
 * specialist that read a 600-page filing whole with `dataroom_read` sent that filing again on each of its next 20-40
 * steps. So a call returns at most one page (`DATAROOM_PAGE_CHARS`, default 40,000 characters, about 10,000 tokens)
 * and, when there is more, says so in the result: where this page ends, how much there is, and the exact call that
 * reads on. Nothing is cut off: the model can read every page, in order, and a file or listing that fits in one page
 * comes back exactly as it always did (no paging fields at all).
 *
 *   text          paged by CHARACTER: `offset` is where the page starts, `nextOffset` where the next one does. A page
 *                 ends at the last line break in its second half when there is one, so a line is not split.
 *   .jsonl        paged by RECORD: `offset` is the first record's index; a page holds whole records up to the size
 *                 (always at least one).
 *   listing       paged by PATH: `offset` is the first path's index; the paths are sorted when there is more than one
 *                 page, so the pages of one listing never overlap or skip.
 *
 * Pure functions: the tools in agent/lib/dataroom-tools.ts read the store and call these.
 */

/** Characters per page when DATAROOM_PAGE_CHARS is unset or not a whole number from 2,000 up. */
export const DEFAULT_PAGE_CHARS = 40_000;
const MIN_PAGE_CHARS = 2_000;

/** The page size in characters: DATAROOM_PAGE_CHARS, else the default. */
export function pageChars(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DATAROOM_PAGE_CHARS?.trim();
  if (!raw) return DEFAULT_PAGE_CHARS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_PAGE_CHARS ? n : DEFAULT_PAGE_CHARS;
}

const startAt = (offset: number | undefined) => (offset !== undefined && Number.isInteger(offset) && offset > 0 ? offset : 0);

/** The note a paged result carries, in plain words the model acts on. */
function moreNote(tool: string, what: string, from: number, to: number, total: number, unit: string, nextOffset: number): string {
  const same = tool === "dataroom_list" ? "the same prefix" : "the same path";
  return (
    `This is ${what} ${from}-${to} of ${total} ${unit}. MORE IS AVAILABLE: call ${tool} again with ${same} and offset: ${nextOffset} ` +
    `to read on (repeat until a result has no nextOffset). To search a large file instead of reading all of it, ` +
    `fetch it to your sandbox (dataroom_fetch_to_sandbox) and use grep there.`
  );
}

const lastNote = (tool: string, what: string, from: number, to: number, total: number, unit: string) =>
  `This is ${what} ${from}-${to} of ${total} ${unit}: the end. Nothing more to read in this ${tool === "dataroom_list" ? "listing" : "file"}.`;

export interface TextPage {
  content: string;
  /** Present only when the file is paged (longer than a page, or an offset was given). */
  paging?: { offset: number; nextOffset?: number; totalChars: number; more: string };
}

/** One page of a text file, starting at character `offset`. */
export function pageText(text: string, offset: number | undefined, size: number = pageChars()): TextPage {
  const from = startAt(offset);
  if (from === 0 && text.length <= size) return { content: text };
  if (from >= text.length) {
    return {
      content: "",
      paging: { offset: from, totalChars: text.length, more: `offset ${from} is past the end: this file has ${text.length} characters. Nothing more to read.` },
    };
  }
  let to = Math.min(text.length, from + size);
  if (to < text.length) {
    const cut = text.lastIndexOf("\n", to - 1);
    if (cut >= from + size / 2) to = cut + 1;
  }
  const next = to < text.length ? to : undefined;
  const more =
    next === undefined
      ? lastNote("dataroom_read", "characters", from, to, text.length, "characters")
      : moreNote("dataroom_read", "characters", from, to, text.length, "characters", next);
  return { content: text.slice(from, to), paging: { offset: from, ...(next === undefined ? {} : { nextOffset: next }), totalChars: text.length, more } };
}

export interface ListPage<T> {
  items: T[];
  /** Present only when the list is paged. */
  paging?: { offset: number; nextOffset?: number; total: number; more: string };
}

/**
 * One page of a list (`.jsonl` records or listing paths), starting at item `offset`: whole items up to `size`
 * characters of JSON, always at least one.
 */
export function pageList<T>(
  tool: "dataroom_read" | "dataroom_list",
  unit: "records" | "paths",
  items: T[],
  offset: number | undefined,
  size: number = pageChars(),
): ListPage<T> {
  const from = startAt(offset);
  const lengths = items.map((item) => (JSON.stringify(item) ?? "").length + 1);
  if (from === 0 && lengths.reduce((a, b) => a + b, 0) <= size) return { items };
  if (from >= items.length) {
    return { items: [], paging: { offset: from, total: items.length, more: `offset ${from} is past the end: there are ${items.length} ${unit}. Nothing more to read.` } };
  }
  let to = from;
  let used = 0;
  while (to < items.length && (to === from || used + lengths[to] <= size)) used += lengths[to++];
  const nextOffset = to < items.length ? to : undefined;
  const more =
    nextOffset === undefined
      ? lastNote(tool, unit, from, to, items.length, unit)
      : moreNote(tool, unit, from, to, items.length, unit, nextOffset);
  return { items: items.slice(from, to), paging: { offset: from, ...(nextOffset === undefined ? {} : { nextOffset }), total: items.length, more } };
}
