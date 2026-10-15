/**
 * SERVER-TIMING: where a chat-open request spent its time on the server, in a header the browser can read.
 *
 * Every live figure about opening a chat was taken from outside: replay time did not follow bytes (4.5 MB took 7.0 s,
 * 29 MB took 4.7 s, one 187 KB read took 17.3 s), and nobody could say which hop was slow, because no response said.
 * The two routes an open reads (`/api/ops/chat-snapshots` for the saved copy, `/api/ops/chat-replay` for the stream)
 * now name their phases: sign-in, the access check, the saved copy's database read, eve's answer, and the total. The
 * chat-open record (lib/chat-open-timing.ts) keeps what they say beside the browser's own times.
 *
 * Durations only, never a value from the request: the header is visible to anything that can read the response.
 *
 * No imports, no `server-only`: the routes write the header with it and the browser (and node, in the tests) reads it.
 */

/** One phase: a short token name and a duration in milliseconds. */
export type ServerTimingEntry = readonly [name: string, ms: number];

const NAME = /^[a-z][a-z0-9-]{0,23}$/;

/** `name;dur=12.3, other;dur=4` for the entries whose name is a plain token and whose duration is a finite number. */
export function formatServerTiming(entries: readonly ServerTimingEntry[]): string {
  return entries
    .filter(([name, ms]) => NAME.test(name) && Number.isFinite(ms))
    .map(([name, ms]) => `${name};dur=${Math.max(0, Math.round(ms * 10) / 10)}`)
    .join(", ");
}

/**
 * Read a `Server-Timing` header into `{ name: ms }`. Entries without a duration, or with a name that is not a plain
 * token, are skipped; a missing or malformed header gives `{}`. Never throws.
 */
export function parseServerTiming(header: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!header) return out;
  try {
    for (const part of header.split(",")) {
      const [rawName, ...params] = part.split(";").map((p) => p.trim());
      if (!rawName || !NAME.test(rawName)) continue;
      for (const p of params) {
        const m = /^dur=(-?\d+(?:\.\d+)?)$/.exec(p);
        if (m) {
          out[rawName] = Math.max(0, Number(m[1]));
          break;
        }
      }
    }
  } catch {
    return {};
  }
  return out;
}

/**
 * A stopwatch for one request: `mark(name)` closes the phase that started at the previous mark (or at creation),
 * `header()` adds `total` (creation to now) and formats it. `now` is injected for tests.
 */
export function serverStopwatch(now: () => number = () => performance.now()) {
  const started = now();
  let last = started;
  const entries: [string, number][] = [];
  return {
    mark(name: string): void {
      const t = now();
      entries.push([name, t - last]);
      last = t;
    },
    /** Ms since the stopwatch started. */
    elapsed(): number {
      return now() - started;
    },
    header(): string {
      return formatServerTiming([...entries, ["total", now() - started]]);
    },
  };
}
