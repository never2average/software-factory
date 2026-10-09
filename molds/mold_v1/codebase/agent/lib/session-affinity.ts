/**
 * ONE SESSION, ONE MODEL INSTANCE — the `x-session-affinity` header on every Workers AI call.
 *
 * Workers AI caches the prefill of a prompt (prefix caching) on the model instance that computed it, and bills a
 * cached input token at a fraction of a fresh one (lib/inference-pricing.ts). An agent session resends its whole
 * history on every step, so consecutive calls share almost all of their prefix — but a hit needs the call to land on
 * the SAME instance, and without a hint the provider spreads calls across instances. Cloudflare's answer is a request
 * header: "send the `x-session-affinity` header with a unique identifier for your session or agent. This routes
 * requests with the same identifier to the same model instance"
 * (https://developers.cloudflare.com/workers-ai/features/prompt-caching/, updated 2026-04-21). Before this header
 * was sent, a measured workspace recorded 39.6% of its input tokens as cache reads (mold_v1-220).
 *
 * WHICH VALUE, AND WHY ONE PER SESSION. The cache matches a prompt from its first token, so the calls worth routing
 * together are the ones that share a prefix. Inside one eve session every step starts with the same instructions,
 * tools and earlier history; that is where nearly all the tokens are (a delegated specialist's run of tool steps,
 * each resending everything before it). A specialist runs in a CHILD session with its own instructions, so its
 * prompts share nothing past the first tokens with the parent's; one value for the parent and its children would
 * only pile unrelated prefixes onto one instance. So each session gets its own value: the root keeps one across all
 * of its turns, and every child session gets a fresh one that all of its steps share.
 *
 * WHERE IT LIVES. A `defineState` slot: eve's durable per-session memory, which "never crosses the parent/child
 * boundary" (eve docs, State), and which both the provider's `fetch` and the model middleware run inside (the same
 * ALS scope agent/lib/served-model.ts relies on). Its first read in a session creates the value and eve persists it
 * at the step boundary, so the next step, the next turn and a resumed session read the same one.
 *
 * WHAT THE VALUE IS. Random and opaque: `ses_` and 24 hex characters, made by this process. It is not derived from
 * anything about the session — no person, address, workspace or thread title — so nothing about who is talking
 * leaves in the header. The provider sees only that two calls belong together.
 *
 * WHERE IT IS SENT. Through the `fetch` of the one Workers AI provider in agent/lib/model.ts, so every model built
 * on it carries the header: the orchestrator, every specialist, the empty-response fallback, and the vision model
 * `read_image` calls from inside a tool (which reads its caller's session). Gateway mode never reaches that
 * provider and is unchanged. Outside an eve context (a script, a test with no session) there is no session to name,
 * and no header is sent rather than one value shared by unrelated callers.
 *
 * Never throws: a missing value costs a cache hit, never a model call.
 */
import { randomBytes } from "node:crypto";
import { defineState } from "eve/context";

/** The header name, exactly as Cloudflare's documentation spells it. */
export const SESSION_AFFINITY_HEADER = "x-session-affinity";

/** A fresh opaque value: `ses_` and 24 random hex characters. */
export function newSessionAffinityValue(): string {
  return `ses_${randomBytes(12).toString("hex")}`;
}

/** The slot's interface, so a test can drive it without an eve context (`__useSessionAffinitySlot`). */
interface Slot {
  get(): string | null;
}

let slot: Slot = defineState<string | null>("model.session-affinity", newSessionAffinityValue);

/** Test seam: replace the eve-scoped slot with another. Returns the previous slot. */
export function __useSessionAffinitySlot(next: Slot): Slot {
  const previous = slot;
  slot = next;
  return previous;
}

const SHAPE = /^ses_[0-9a-f]{24}$/;

/** This session's affinity value, or null outside an eve context. Never throws. */
export function sessionAffinity(): string | null {
  try {
    const value = slot.get();
    return typeof value === "string" && SHAPE.test(value) ? value : null;
  } catch {
    // No eve context here: see the header note.
    return null;
  }
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * A `fetch` that adds this session's `x-session-affinity` to every request it sends, for a provider's `fetch`
 * option. The value is read per request, inside the call, so one provider instance serves every session.
 */
export function withSessionAffinity(base: Fetch = (input, init) => globalThis.fetch(input, init)): Fetch {
  return (input, init) => {
    const value = sessionAffinity();
    if (!value) return base(input, init);
    const headers = new Headers(init?.headers);
    headers.set(SESSION_AFFINITY_HEADER, value);
    return base(input, { ...init, headers });
  };
}
