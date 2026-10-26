/**
 * The time the credential code reads (mold_v0-014): when a token expires, when it is refreshed, when a run asks for a
 * fresh one. The real clock, unless a test moves it forward (a run of several hours in seconds:
 * scripts/oauth-providers-test.ts). Leases, deadlines and the database's own now() keep the real time.
 */
let offset = 0;
export const now = () => Date.now() + offset;
/** Tests only: move the credential clock `ms` forward (or back). */
export function advanceClockForTest(ms: number) { offset += ms; }
export function resetClockForTest() { offset = 0; }
/**
 * A short-lived token is handed out again only while it has more than this left; a runner asks for fresh ones once any
 * of its tokens has less (src/run-harness.ts). The same margin on both sides, so the runner's ask always gets a new one.
 */
export const REFRESH_MARGIN_MS = 10 * 60_000;
