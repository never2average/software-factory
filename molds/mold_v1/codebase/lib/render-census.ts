/**
 * WHICH COMPONENT WAS RENDERING WHEN A RENDER LOOP THREW (mold_v1-095).
 *
 * React's "maximum update depth" error, minified in production to "Minified React error #185", carries no component
 * stack, and it reaches this app at the eve store's own setState call site (agent-chat's `onError`), outside every
 * ErrorBoundary. The one occurrence recorded (2026-09-21 13:33:52) therefore named nothing; #36 added the SCENE (what
 * the transcript held, which self-updating renderer was mounted), which says what was on screen but still not what
 * looped. A loop is a component rendering tens of times in a few milliseconds, so the census counts renders: each
 * instrumented component notes itself once per render, and when #185 fires the report says which ones rendered most
 * in the last second — "AgentMessage×2104 · ToolCluster×2080 · AgentChat×12" names the loop.
 *
 * Cheap on purpose: one array write per render into a fixed ring; nothing is kept per instance and nothing runs
 * unless a report asks. A render counted twice (React's development double render) only doubles every count.
 */

const SIZE = 4096;
const names: (string | undefined)[] = new Array(SIZE);
const times = new Float64Array(SIZE);
let head = 0;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Count one render of `name`. Call it from the component's body. */
export function noteRender(name: string, at: number = now()): void {
  names[head] = name;
  times[head] = at;
  head = (head + 1) % SIZE;
}

/**
 * The components that rendered most in the last `windowMs`, busiest first: "A×120 · B×40". Empty when nothing
 * rendered. `top` keeps it inside a telemetry detail.
 */
export function renderCensus(windowMs = 1_000, top = 4, at: number = now()): string {
  const counts = new Map<string, number>();
  for (let i = 0; i < SIZE; i++) {
    const name = names[i];
    if (name === undefined || at - times[i] > windowMs || times[i] > at) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([name, n]) => `${name}×${n}`)
    .join(" · ");
}

/** Tests only: forget every render counted so far. */
export function resetRenderCensus(): void {
  names.fill(undefined);
  times.fill(0);
  head = 0;
}
