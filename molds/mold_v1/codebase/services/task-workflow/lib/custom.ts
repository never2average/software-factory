/**
 * A task's OWN fields (`todos.custom`) and a status its caller derived, as this service handles them.
 *
 * The service knows no deployment profile. The web app and the agent check a write against the deployment's
 * definition of a task first (agent/lib/record-validate.ts in the app) and send on:
 *
 *   custom       the own fields that change, by key: a value sets it, null clears it. Merged per key onto what is
 *                stored AT WRITE TIME, in SQL, so two writers changing different keys both land and a key nobody
 *                names is never touched. Sent only by a deployment whose tasks declare own fields: a body without
 *                it is today's body, and this service deploys before the column exists.
 *   statusFrom   "category": the deployment gives tasks states of their own, and `status` is the one their state's
 *                category maps to. It is stored as sent, outside any stage pipeline (whose stages are not the
 *                deployment's states), with `done` following it.
 *
 * Import-free (the rest of lib/ goes through the `@/lib` alias only the Next bundler resolves), so it is unit-tested
 * under plain Node.
 */

/** An own field's key: what the app's definitions allow (snake_case, at most 40 characters). */
export const CUSTOM_KEY = /^[a-z][a-z0-9_]{0,39}$/;
/** The most a write's `custom` may weigh, as JSON. */
export const CUSTOM_MAX_BYTES = 65_536;

export interface CustomDelta {
  set: Record<string, unknown>;
  clear: string[];
}

/** `custom` as a per-key change: values to set, keys to clear (null). Undefined when it changes nothing. */
export function customDelta(custom: Record<string, unknown> | undefined): CustomDelta | undefined {
  if (!custom) return undefined;
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const [k, v] of Object.entries(custom)) {
    if (v === null) clear.push(k);
    else if (v !== undefined) set[k] = v;
  }
  return Object.keys(set).length || clear.length ? { set, clear } : undefined;
}

/** What a category-derived status writes: the status, `done`, and when it was done (kept if it already was). */
export function directStatus(status: string, before: { done: boolean; done_at: Date | null } | null, now = new Date()) {
  const done = status === "done";
  return { status, done, done_at: done ? (before?.done ? before.done_at ?? now : now) : null };
}
