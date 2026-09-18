/**
 * A line diff, small enough to keep in the repo.
 *
 * Written by hand rather than pulled in as a dependency: the data room holds
 * markdown, JSON and JSONL, and all any reviewer needs from a changeset is
 * "which lines did this write change". That is one LCS, and a diff library
 * would be several hundred kilobytes of client bundle for it.
 */

export interface DiffRow {
  kind: "same" | "add" | "del";
  text: string;
  /** 1-based line number on the before side, or null for an added line. */
  a: number | null;
  /** 1-based line number on the after side, or null for a removed line. */
  b: number | null;
}

/**
 * The LCS table is O(n·m) cells. A data-room file that changed wholesale (a
 * regenerated dataset, say) can be tens of thousands of lines on both sides,
 * which is gigabytes of table for a diff nobody would read line by line — past
 * this budget we fall back to "everything replaced", which is what such a diff
 * says anyway.
 */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): { rows: DiffRow[]; truncated: boolean } {
  const A = before.length ? before.split("\n") : [];
  const B = after.length ? after.split("\n") : [];

  // Trim the matching head and tail first. Real edits touch a few lines in a
  // long file, so this usually leaves the LCS a handful of lines to work on.
  let lo = 0;
  while (lo < A.length && lo < B.length && A[lo] === B[lo]) lo++;
  let hiA = A.length;
  let hiB = B.length;
  while (hiA > lo && hiB > lo && A[hiA - 1] === B[hiB - 1]) {
    hiA--;
    hiB--;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < lo; i++) rows.push({ kind: "same", text: A[i], a: i + 1, b: i + 1 });

  const midA = A.slice(lo, hiA);
  const midB = B.slice(lo, hiB);
  const n = midA.length;
  const m = midB.length;
  let truncated = false;

  if (n * m > MAX_CELLS) {
    truncated = true;
    for (let i = 0; i < n; i++) rows.push({ kind: "del", text: midA[i], a: lo + i + 1, b: null });
    for (let j = 0; j < m; j++) rows.push({ kind: "add", text: midB[j], a: null, b: lo + j + 1 });
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        rows.push({ kind: "same", text: midA[i], a: lo + i + 1, b: lo + j + 1 });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        rows.push({ kind: "del", text: midA[i], a: lo + i + 1, b: null });
        i++;
      } else {
        rows.push({ kind: "add", text: midB[j], a: null, b: lo + j + 1 });
        j++;
      }
    }
    while (i < n) {
      rows.push({ kind: "del", text: midA[i], a: lo + i + 1, b: null });
      i++;
    }
    while (j < m) {
      rows.push({ kind: "add", text: midB[j], a: null, b: lo + j + 1 });
      j++;
    }
  }

  for (let k = 0; hiA + k < A.length; k++) {
    rows.push({ kind: "same", text: A[hiA + k], a: hiA + k + 1, b: hiB + k + 1 });
  }
  return { rows, truncated };
}

export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === "add") added++;
    else if (r.kind === "del") removed++;
  }
  return { added, removed };
}

/* ------------------------------ Hunks + split ---------------------------- */

/**
 * A contiguous region of change with its unchanged context, addressed exactly
 * the way a unified diff addresses it: `@@ -aStart,aCount +bStart,bCount @@`.
 *
 * `collapseUnchanged` already decides what to show; this says WHERE what you
 * are shown sits in the file. Without it a gap marker tells you lines were
 * skipped but not which ones, so a diff of a long file gives you no way to
 * locate what you are reading.
 */
export interface Hunk {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  /** Lines skipped immediately before this hunk (0 for the first). */
  gapBefore: number;
  rows: DiffRow[];
}

export function hunks(rows: DiffRow[], context = 3): Hunk[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) {
      keep[k] = true;
    }
  });

  const out: Hunk[] = [];
  let hidden = 0;
  let current: DiffRow[] = [];
  let gapBefore = 0;

  const flush = () => {
    if (!current.length) return;
    const first = current[0];
    const aStart = first.a ?? (current.find((r) => r.a !== null)?.a ?? 1);
    const bStart = first.b ?? (current.find((r) => r.b !== null)?.b ?? 1);
    out.push({
      aStart,
      bStart,
      aCount: current.filter((r) => r.a !== null).length,
      bCount: current.filter((r) => r.b !== null).length,
      gapBefore,
      rows: current,
    });
    current = [];
  };

  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (hidden) {
        flush();
        gapBefore = hidden;
        hidden = 0;
      }
      current.push(rows[i]);
    } else {
      hidden++;
    }
  }
  flush();
  return out;
}

/** One rendered line of a side-by-side view: a left cell, a right cell, or both. */
export interface SplitRow {
  left: DiffRow | null;
  right: DiffRow | null;
  /** The two sides are a replacement pair, so their text can be word-diffed. */
  paired: boolean;
}

/**
 * Zip a hunk's rows into side-by-side pairs.
 *
 * Consecutive deletions and additions are one replacement, so they line up
 * across from each other rather than stacking — the read that makes "what did
 * this line become" a glance instead of a hunt. An unbalanced run leaves the
 * shorter side blank.
 */
export function splitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === "same") {
      out.push({ left: row, right: row, paired: false });
      i++;
      continue;
    }
    const dels: DiffRow[] = [];
    const adds: DiffRow[] = [];
    while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
    while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const left = dels[k] ?? null;
      const right = adds[k] ?? null;
      out.push({ left, right, paired: Boolean(left && right) });
    }
  }
  return out;
}

/* ------------------------------- Word diff ------------------------------- */

export interface WordSeg {
  text: string;
  changed: boolean;
}

/** Words, whitespace runs and single punctuation — the units an eye compares. */
function tokenize(s: string): string[] {
  return s.match(/\s+|[A-Za-z0-9_$]+|[^\s A-Za-z0-9_$]/g) ?? [];
}

/** Cap for the token LCS. A pathological single-line file (minified JSON) would
 *  otherwise build a table far larger than the line diff we already refused. */
const MAX_WORD_CELLS = 250_000;

/**
 * Which parts of a replaced line actually changed.
 *
 * Marking the whole line is technically true and practically useless: a
 * one-token edit inside a long line reads as "this entire line is different"
 * and the reviewer has to diff it themselves, by eye.
 */
export function wordDiff(before: string, after: string): { left: WordSeg[]; right: WordSeg[] } {
  const A = tokenize(before);
  const B = tokenize(after);
  if (A.length * B.length > MAX_WORD_CELLS || !A.length || !B.length) {
    return { left: [{ text: before, changed: true }], right: [{ text: after, changed: true }] };
  }
  const w = B.length + 1;
  const dp = new Uint32Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      dp[i * w + j] =
        A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const left: WordSeg[] = [];
  const right: WordSeg[] = [];
  const push = (arr: WordSeg[], text: string, changed: boolean) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text;
    else arr.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      push(left, A[i], false);
      push(right, B[j], false);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      push(left, A[i++], true);
    } else {
      push(right, B[j++], true);
    }
  }
  while (i < A.length) push(left, A[i++], true);
  while (j < B.length) push(right, B[j++], true);
  return { left, right };
}
