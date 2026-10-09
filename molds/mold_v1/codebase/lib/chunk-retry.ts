/**
 * A LAZY CHUNK THAT FAILED TO LOAD CAN BE LOADED AGAIN.
 *
 * Turbopack's browser runtime keeps one promise per chunk URL and rejects it for good when the chunk's <script>
 * errors (offline for a moment, a flaky proxy, a deploy that moved on). Every later `import()` needing that chunk
 * fails at once, for the life of the page, so a Retry button — or the network coming back — can never recover the
 * data room, a chart or a code highlighter: only a full reload can. React.lazy and next/dynamic then cache that
 * rejection a second time.
 *
 * So the rejection never happens. `installChunkRetry()` wraps `document.head.appendChild`, which is how the runtime
 * adds a chunk's <script>, and takes over the script's `error` event for chunk URLs: instead of rejecting the
 * runtime's promise it records the chunk as failed and loads it again later, with a fresh <script> for the SAME URL.
 * When that one runs, the chunk registers itself with the runtime exactly as the first would have, and the promise
 * every waiting `import()` holds resolves. Retries happen on their own (backing off to every 30 s, and at once when
 * the browser says it is back online) and on demand (`retryFailedChunks()`, the Retry button of a lazy panel).
 *
 * What a person sees meanwhile is decided where the chunk is used: a lazy panel shows its "could not load" card with
 * Retry once `failedChunkCount()` is non-zero (components/lazy-panel.tsx); a plugin or a highlighter simply keeps the
 * plain rendering it already shows.
 */

const CHUNK = /\/_next\/static\/chunks\/[^?#]+\.js(?:[?#]|$)/;
const BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

const failed = new Map<string, { attempts: number }>();
const listeners = new Set<() => void>();
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let installed = false;

function changed() {
  version += 1;
  for (const fn of listeners) fn();
}

export function subscribeFailedChunks(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** A number that changes whenever the set of failed chunks does (for useSyncExternalStore). */
export const failedChunksVersion = (): number => version;
export const failedChunkCount = (): number => failed.size;

function schedule() {
  if (timer || failed.size === 0) return;
  const attempts = Math.min(...[...failed.values()].map((f) => f.attempts));
  timer = setTimeout(() => {
    timer = null;
    retryFailedChunks();
  }, BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]);
}

let append: ((node: Node) => Node) | null = null;

function load(src: string) {
  const s = document.createElement("script");
  // The ATTRIBUTE, exactly as the runtime wrote it: a chunk registers itself under `getAttribute("src")`, so an
  // absolute URL here would load the code and resolve nothing.
  s.setAttribute("src", src);
  s.onerror = () => onFail(src, s);
  s.onload = () => {
    if (failed.delete(src)) changed();
  };
  append!(s);
}

function onFail(src: string, el: HTMLScriptElement) {
  el.remove();
  const f = failed.get(src);
  failed.set(src, { attempts: (f?.attempts ?? 0) + 1 });
  changed();
  schedule();
}

/** Load every failed chunk again, now. */
export function retryFailedChunks(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  for (const src of failed.keys()) load(src);
}

export function installChunkRetry(): void {
  if (installed || typeof document === "undefined" || !document.head) return;
  installed = true;
  const head = document.head;
  const original = head.appendChild.bind(head);
  append = original as (node: Node) => Node;
  head.appendChild = function appendChild<T extends Node>(node: T): T {
    if (node instanceof HTMLScriptElement && CHUNK.test(node.src) && typeof node.onerror === "function") {
      const src = node.getAttribute("src") ?? node.src;
      node.onerror = () => onFail(src, node);
    }
    return original(node) as T;
  };
  window.addEventListener("online", () => {
    if (failed.size) retryFailedChunks();
  });
}

installChunkRetry();
