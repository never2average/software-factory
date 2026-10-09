/**
 * WHICH MODEL ANSWERED THIS MODEL CALL — carried from the model boundary to the hook that records the step.
 *
 * A specialist's run row (`automation_runs`, agent/lib/workflow-usage.ts) is assembled from eve's `step.completed`
 * events, one per model call. That event carries the call's tokens and, when the provider says so, its cost
 * (eve reads it from the AI Gateway's metadata). It does NOT carry the model id. Cloudflare Workers AI reports no
 * cost, so a run on it recorded tokens and `cost_usd = 0`, and nothing downstream could price the tokens because
 * nothing said which model spent them.
 *
 * "The role's configured model" is not the answer either, because ONE call can be served by a different model
 * than the one configured: the empty-response recovery (agent/lib/empty-model-response.ts) reissues a call that
 * came back empty to the OTHER role's model. Such a step's tokens are the fallback model's, and pricing them at the
 * configured model's rate is a wrong number that looks right.
 *
 * So each underlying model is wrapped (agent/lib/model.ts) in `servedModelNote(id)`, which writes its id into a
 * `defineState` slot as the call is made. The LAST call made for a step is the one whose answer — and whose usage —
 * eve reports, so the slot holds the model that served the step. The hook takes it (`takeServedModel`) when it
 * records the step. Same channel, same reason as agent/lib/empty-model-response-log.ts: the slot lives on eve's
 * ALS-scoped harness step, which both the model middleware and the hooks run inside, so two sessions on one warm
 * instance cannot read each other's model. A module-level "last model" could.
 *
 * Never throws: outside an eve context (a script, an eval, a test) `defineState` throws, and losing the note is the
 * right outcome there; failing the model call is not.
 */
import { defineState } from "eve/context";
import type { LanguageModelMiddleware } from "ai";

/** The slot's interface, so a test can drive the middleware without an eve context (`__useServedModelSlot`). */
interface Slot {
  get(): string | null;
  update(fn: (current: string | null) => string | null): void;
}

let slot: Slot = defineState<string | null>("usage.served-model", () => null);

/** Test seam: replace the eve-scoped slot with an in-memory one. Returns the previous slot. */
export function __useServedModelSlot(next: Slot): Slot {
  const previous = slot;
  slot = next;
  return previous;
}

/** Note that `modelId` is answering the current call. Never throws. */
export function noteServedModel(modelId: string): void {
  try {
    slot.update(() => modelId);
  } catch {
    // No eve context here — see above.
  }
}

/**
 * The model that served the step just completed, or null when none was noted (a model not wrapped in
 * `servedModelNote`, such as a gateway model id passed as a plain string, or no eve context). Clears the slot so a
 * later step that notes nothing cannot inherit this one's model. Never throws.
 */
export function takeServedModel(): string | null {
  try {
    const current = slot.get();
    if (current !== null) slot.update(() => null);
    return typeof current === "string" && current.trim() ? current.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Middleware that notes `modelId` on every call it passes through. Put it INNERMOST (last in the middleware list,
 * directly around the provider model) so every reissue the recovery makes on this model notes it again, and wrap
 * each fallback model in its own, so the last note of a step names the model that actually answered.
 */
export function servedModelNote(modelId: string): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      noteServedModel(modelId);
      return doGenerate();
    },
    async wrapStream({ doStream }) {
      noteServedModel(modelId);
      return doStream();
    },
  };
}
