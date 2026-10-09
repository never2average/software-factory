/**
 * WAIT FOR THE CONDITION, NOT FOR A CLOCK.
 *
 * The rendered-page checks slept a fixed time and then read the page ("1.5 s is enough for the list to load"). On a
 * loaded CI runner it is not always enough, and the check fails with nothing wrong (check:workspace-refused, CI run
 * 37207524888). A check that needs something to have happened asks for exactly that, with a generous limit: it
 * returns the moment the condition holds and fails by name when it never does.
 *
 * A check that needs something NOT to happen cannot wait on a condition; it watches for a stated window. `quiet`
 * and `settle` are for those: the window starts once the page has stopped doing what it was doing, whenever that is.
 */

/** Resolve with the first truthy value `fn` returns (a throw counts as "not yet"); reject by name at the limit. */
export async function until(what, fn, { timeout = 30_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      last = undefined;
    } catch (e) {
      last = e;
    }
    if (Date.now() >= end) throw new Error(`timed out after ${timeout} ms waiting for ${what}${last ? ` (${String(last.message ?? last).split("\n")[0]})` : ""}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

/**
 * Resolve once `list` (requests seen so far) has not grown for `ms`; reject at the limit, naming what kept arriving.
 * For "this page has finished asking": a page that never stops is the failure, and it is reported as one.
 */
export async function quiet(list, { ms = 1500, timeout = 30_000, name = (x) => x?.path ?? String(x) } = {}) {
  const start = Date.now();
  let seen = list.length;
  let since = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 50));
    if (list.length !== seen) {
      seen = list.length;
      since = Date.now();
    } else if (Date.now() - since >= ms) return seen;
    if (Date.now() - start >= timeout) throw new Error(`still making requests after ${timeout} ms: ${list.slice(-5).map(name).join(", ")}`);
  }
}

/**
 * The same, for a page that is ALLOWED to keep asking (a console that polls): returns when it has been quiet for
 * `ms` or at the limit, whichever is first, and never fails. Only to widen what a following assertion looks at;
 * the assertion must hold whenever this returns.
 */
export const settle = (list, { ms = 750, timeout = 5_000 } = {}) => quiet(list, { ms, timeout }).catch(() => list.length);
