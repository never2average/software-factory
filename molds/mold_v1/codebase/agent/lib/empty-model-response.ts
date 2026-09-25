/**
 * AN EMPTY MODEL RESPONSE MUST NOT THROW AWAY A TURN THAT HAS ALREADY DONE THE
 * WORK — AND IT MUST LEAVE ENOUGH BEHIND TO NAME ITS CAUSE NEXT TIME.
 *
 * THE DEFECT, measured on the live deployment on 2026-09-23. A person uploads a
 * pdf and asks for KPIs. The agent fetches it into the sandbox and `pdfplumber`
 * returns real page text. About three bash calls later, every attempt ends the
 * same way:
 *
 *     step.failed / turn.failed   MODEL_CALL_FAILED   "Empty model response"
 *     [eve:harness.tool-loop] empty model response; reissuing the model call once
 *
 * — twice, then the turn dies. Every attempt, always at the same depth, in two
 * separate sessions. The pdf WAS read; that work is thrown away with the turn,
 * and the person is left looking at a chat that simply stopped.
 *
 * WHAT WAS RULED OUT, by direct probes against `@cf/moonshotai/kimi-k2.6` on
 * Cloudflare Workers AI (the configured orchestrator):
 *   - not context size    — the whole stored transcript is 32 KB, the pdf text 11 KB
 *   - not the tool count  — 59 tool definitions answer fine
 *   - not streaming       — a streamed response returns 100+ content deltas fine
 *   - not the import error— the failure also happened when extraction SUCCEEDED
 *
 * REPRODUCED EXACTLY ONCE, AND ONLY THIS WAY: a low output cap. `max_tokens:
 * 256` returns `finish_reason: "length"` with EMPTY content and 256 completion
 * tokens burned — Kimi is a reasoning model and spends the budget thinking. With
 * no cap, or 8192, the same conversation answers correctly.
 *
 * AND THE `cap=` FIELD BELOW SETTLED IT — which is the job it was added for. The
 * row this middleware wrote on the live deployment:
 *
 *     model=@cf/moonshotai/kimi-k2.6  path=generate
 *     finish=length  finish_raw=length  in=2999  out=1500  out_thinking=1500
 *
 * `path=generate` names the call: the chat STREAMS, so the only generator in the
 * product is `read_image` — and `agent/lib/vision-tools.ts` set
 * `maxOutputTokens: 1_500` itself, sized for the ANSWER ("a page description, not
 * a report") on a model that pays for its thinking out of the same budget. The
 * cap was neither absent nor a provider default; it was this repo's own, on the
 * one path #51's wire proof did not drive (that proof ran `streamText`, the chat).
 * Every role now carries a budget chosen for its job, in
 * agent/lib/model-output-budget.ts, so a future row reads as a real number: `cap`
 * close to `out` with `out_thinking ≈ out` is this failure again, `cap` far above
 * `out` says the budget was fine and something else is wrong.
 *
 * eve's `maxOutputTokensPerSession`, for the avoidance of the same hunt: a
 * session BUDGET that parks a turn, never a per-call `max_tokens`
 * (harness/subagent-token-budget.js, harness/session-limit-enforcement.js).
 *
 * WHY THIS LIVES AT THE MODEL BOUNDARY and not in a fork of eve's tool-loop:
 * this is the one seam that sees BOTH halves of the problem. The
 * `LanguageModelMiddleware` call options carry `maxOutputTokens` — the single
 * field that settles the hypothesis — along with the prompt, the tool list and
 * the provider's `finishReason`/`usage`, none of which survive up to where eve
 * reports the failure. eve's own recovery (`attemptEmptyResponseRecovery`, one
 * reissue with a nudge) still sits ABOVE this and gets its go afterwards.
 *
 * Everything here is PURE and dependency-injected so
 * scripts/test-empty-model-response.mjs can drive the real middleware with a
 * scripted model and no provider, no network and no spend.
 */
import { MAX_OUTPUT_BUDGET_TOKENS } from "./model-output-budget.ts";
import { isReadOnlyTool } from "./read-only-tools.ts";
import type { LanguageModelMiddleware } from "ai";

/* Structural aliases off the SDK's own middleware type, so an AI SDK bump that
 * renames a call-option field breaks the typecheck here rather than silently
 * reading `undefined` for the output cap — which would read as "no cap in
 * force", the exact wrong answer to the one question this file exists to
 * settle. */
type WrapStream = NonNullable<LanguageModelMiddleware["wrapStream"]>;
type WrapGenerate = NonNullable<LanguageModelMiddleware["wrapGenerate"]>;
export type ModelCallParams = Parameters<WrapStream>[0]["params"];
export type ModelLike = Parameters<WrapStream>[0]["model"];
export type StreamResult = Awaited<ReturnType<WrapStream>>;
export type GenerateResult = Awaited<ReturnType<WrapGenerate>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;
type FinishPart = Extract<StreamPart, { type: "finish" }>;

/* -------------------------------------------------------------------------- */
/* What we are allowed to know about a call                                   */
/* -------------------------------------------------------------------------- */

/** The SHAPE of a request. No prompt text, no document content, no tool arguments. */
export interface ModelCallShape {
  /** How many messages went up (system + transcript), not what is in them. */
  readonly messages: number;
  /** How many tool DEFINITIONS were advertised. 59 on this deployment. */
  readonly tools: number;
  /** Approximate serialized size of prompt + tools, in bytes. */
  readonly approxBytes: number;
  /**
   * The per-call output cap actually in force, or null for "uncapped".
   *
   * THE FIELD THIS WHOLE FILE IS FOR, and the one that named the cause. Read off
   * the call options the provider is about to be handed, so it reflects whatever
   * eve, the AI SDK, the role's budget middleware, a call site or a provider
   * default put there — not what this repo's source says it puts there. Since
   * the budget landed it is a real number on every Workers AI call, and it is
   * read off the params of the ATTEMPT THAT FAILED, so a retry that raised the
   * budget and still came back empty records the raised number and not the
   * original.
   */
  readonly outputCap: number | null;
  /**
   * Does the request carry an image the model has to SEE?
   *
   * Decides whether falling back to the text-only specialist is honest. In the
   * measured workflow the pdf arrives as TEXT from the sandbox, so a text-only
   * model can finish the job; a turn with a real image part cannot be handed to
   * one without silently answering a different question.
   */
  readonly hasImageInput: boolean;
}

/** What came back. Again: shape only. */
export interface ModelCallOutcome {
  readonly empty: boolean;
  /**
   * The AI SDK's UNIFIED finish reason, and the provider's RAW one.
   *
   * Both, because they are not the same evidence. The one reproduction anybody
   * has is Workers AI answering `finish_reason: "length"` with empty content and
   * the whole completion budget spent on thinking — and `length` is exactly the
   * raw value a unified mapping can flatten into something blander. A row that
   * only kept the unified reason could not tell that reproduction apart from a
   * model that simply stopped.
   */
  readonly finishReason: string | null;
  readonly finishReasonRaw: string | null;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  /**
   * How many of the completion tokens went on THINKING.
   *
   * The provider-level usage breaks this out (`outputTokens.reasoning`), and it
   * is the single most discriminating number on the row. The one reproduction
   * anybody has is a reasoning model burning its whole output budget on thought
   * and emitting nothing: `reasoning ≈ completion` on an empty response says
   * that happened, whatever the cap turns out to be. `reasoning = 0` with
   * `completion = 0` says something else entirely — the model never started.
   */
  readonly reasoningTokens: number | null;
  /** Whether ANY tool call came back — the difference between "said nothing" and "did nothing". */
  readonly hadToolCalls: boolean;
}

/** One recorded empty response: the row's whole content. */
export interface EmptyResponseRecord extends ModelCallShape, ModelCallOutcome {
  /** Unique per record, so a drain that runs twice cannot write the row twice. */
  readonly id: string;
  /** 1 for the provider's first answer, 2 for the first reissue, and so on. */
  readonly attempt: number;
  /** The model that answered empty. */
  readonly modelId: string;
  /** `stream` or `generate` — eve streams the chat and generates nothing today, but both paths exist. */
  readonly path: "stream" | "generate";
  /** What this attempt's emptiness caused next. */
  readonly next: RecoveryAction;
  /** Why, in one word, when the plan could not do the obvious thing. */
  readonly nextReason: string | null;
  /**
   * The budget the next attempt was given, when this one was raised — null when
   * the next attempt reuses the budget on the row's `outputCap`.
   *
   * Without it two rows an operator reads as identical ("empty at 8192, retried,
   * empty at 16384") are indistinguishable from a ladder that changed nothing,
   * and the question "does raising it actually help?" cannot be answered from the
   * feed — which is the whole reason that question is still open.
   */
  readonly nextOutputCap: number | null;
  /**
   * Set when the attempt was NOT empty but its answer was still not delivered:
   * `unbacked-claim` is a recovered answer that said a write happened on a turn
   * where no tool had run (see `claimsCompletedWrite`). Null for an empty one.
   */
  readonly rejected: RejectionReason | null;
  /** The reasoning effort the next attempt asks for, when this one lowered it — see `raisedRecoveryReasoning`. */
  readonly nextReasoning: "low" | null;
}

/* -------------------------------------------------------------------------- */
/* Reading the shape off a request                                            */
/* -------------------------------------------------------------------------- */

function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as { type?: unknown; mediaType?: unknown };
  return p.type === "file" && typeof p.mediaType === "string" && p.mediaType.startsWith("image/");
}

/**
 * Computed ONLY when a call came back empty.
 *
 * `JSON.stringify` over a 32 KB transcript is cheap once per incident and
 * indefensible once per model call on a chat that is already the slowest thing
 * in the product.
 */
export function describeModelCall(params: ModelCallParams): ModelCallShape {
  const prompt = (params.prompt ?? []) as ReadonlyArray<{ content?: unknown }>;
  let hasImageInput = false;
  for (const message of prompt) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) if (isImagePart(part)) hasImageInput = true;
  }
  let approxBytes = 0;
  try {
    approxBytes = JSON.stringify(params.prompt ?? []).length + JSON.stringify(params.tools ?? []).length;
  } catch {
    // A prompt with a cycle or a BigInt in it must not turn a recoverable empty
    // response into a thrown middleware — the size is the least important field
    // on the row.
    approxBytes = -1;
  }
  return {
    messages: prompt.length,
    tools: (params.tools ?? []).length,
    approxBytes,
    outputCap: typeof params.maxOutputTokens === "number" ? params.maxOutputTokens : null,
    hasImageInput,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading the outcome off a response                                         */
/* -------------------------------------------------------------------------- */

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The AI SDK reports `finishReason` as `{ unified, raw }`, not a string.
 *
 * Read defensively rather than destructured: a provider that sends no finish
 * reason, or an SDK that changes the shape again, must degrade to `?` on a row
 * — never throw inside the recovery that is keeping a turn alive.
 */
/**
 * Provider-level usage is NESTED (`inputTokens.total`, `outputTokens.total`,
 * `outputTokens.reasoning`) — not the flat shape the `ai` package hands eve.
 * Read through one helper so a wrong guess about the shape shows up as `?` on
 * every field at once rather than as a plausible-looking zero on one of them.
 */
function totals(usage: unknown): { prompt: number | null; completion: number | null; reasoning: number | null } {
  const u = (usage ?? {}) as {
    inputTokens?: { total?: unknown };
    outputTokens?: { total?: unknown; reasoning?: unknown };
  };
  return {
    prompt: num(u.inputTokens?.total),
    completion: num(u.outputTokens?.total),
    reasoning: num(u.outputTokens?.reasoning),
  };
}

function finishReasons(value: unknown): { unified: string | null; raw: string | null } {
  if (typeof value === "string") return { unified: value, raw: null };
  if (value && typeof value === "object") {
    const v = value as { unified?: unknown; raw?: unknown };
    return {
      unified: typeof v.unified === "string" ? v.unified : null,
      raw: typeof v.raw === "string" ? v.raw : null,
    };
  }
  return { unified: null, raw: null };
}

/**
 * eve's own emptiness test, restated one layer down.
 *
 * `isEmptyModelResponse` in eve/harness/tool-loop.js is "no tool calls, no tool
 * results, no assistant text". At the model boundary that is: no `tool-call`
 * part and no non-blank `text` part. REASONING DOES NOT COUNT — a response that
 * is nothing but thinking is exactly the failure being recovered from, and
 * counting it as content would make this middleware agree that the turn went
 * fine while the person stares at nothing.
 */
export function summarizeGenerateResult(result: GenerateResult): ModelCallOutcome {
  const content = (result?.content ?? []) as ReadonlyArray<{ type?: string; text?: string }>;
  let hadText = false;
  let hadToolCalls = false;
  for (const part of content) {
    if (part?.type === "tool-call") hadToolCalls = true;
    else if (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") hadText = true;
  }
  const usage = totals(result?.usage);
  const finish = finishReasons(result?.finishReason);
  return {
    empty: !hadText && !hadToolCalls,
    finishReason: finish.unified,
    finishReasonRaw: finish.raw,
    promptTokens: usage.prompt,
    completionTokens: usage.completion,
    reasoningTokens: usage.reasoning,
    hadToolCalls,
  };
}

/** The same judgement, accumulated across a stream's parts. */
export function createStreamWatcher() {
  let hadText = false;
  let hadToolCalls = false;
  let hadError = false;
  let finishReason: string | null = null;
  let finishReasonRaw: string | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let reasoningTokens: number | null = null;
  return {
    observe(part: StreamPart): void {
      const p = part as { type?: string; delta?: string; finishReason?: unknown; usage?: unknown };
      switch (p?.type) {
        case "text-delta":
          if (typeof p.delta === "string" && p.delta.trim() !== "") hadText = true;
          break;
        case "tool-call":
        case "tool-input-start":
          hadToolCalls = true;
          break;
        case "error":
          // A provider error is a DIFFERENT failure with its own handling in
          // eve. Swallowing it behind an empty-response retry would hide a 429
          // or a bad request behind three extra calls and a fallback model.
          hadError = true;
          break;
        case "finish": {
          const finish = finishReasons(p.finishReason);
          finishReason = finish.unified;
          finishReasonRaw = finish.raw;
          const usage = totals(p.usage);
          promptTokens = usage.prompt;
          completionTokens = usage.completion;
          reasoningTokens = usage.reasoning;
          break;
        }
        default:
          break;
      }
    },
    get sawError(): boolean {
      return hadError;
    },
    outcome(): ModelCallOutcome {
      return {
        empty: !hadText && !hadToolCalls,
        finishReason,
        finishReasonRaw,
        promptTokens,
        completionTokens,
        reasoningTokens,
        hadToolCalls,
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* What to do about it                                                        */
/* -------------------------------------------------------------------------- */

export type RecoveryAction = "retry" | "fallback" | "explain";

export interface RecoveryStep {
  readonly action: RecoveryAction;
  readonly delayMs: number;
  /** Set when the obvious action was not the one chosen. */
  readonly reason: string | null;
  /**
   * The output budget the NEXT attempt must be made with, or null to keep the
   * one that just failed. See `raisedOutputBudget`.
   */
  readonly outputBudget: number | null;
}

/**
 * RETRYING A `length` FAILURE ON THE SAME BUDGET IS A CALL THAT CANNOT SUCCEED.
 *
 * `finish=length` with empty content means the model was cut off mid-thought:
 * the budget was the binding constraint, not the prompt. Reissuing at the same
 * ceiling — even with the nudge appended — asks a model that ran out of room to
 * do strictly more inside the same room, and the measured failure repeated on
 * every attempt for exactly that reason. So the retry doubles it.
 *
 * DOUBLING, not jumping straight to the ceiling: the budget in force is a number
 * somebody chose from a measurement (agent/lib/model-output-budget.ts), and one
 * doubling clears the case that number was merely a little short — 8,192 → 16,384
 * is still inside the range probed as accepted on this account — while going
 * straight to 65,536 would put a runaway thinking loop's worst case on a recovery
 * path that fires precisely when the model is already misbehaving.
 *
 * NULL, i.e. change nothing, in three cases, each for its own reason:
 *   - no cap was in force. Nothing to raise, and inventing one on a retry would
 *     make the retry a different experiment from the call it is retrying.
 *   - the model did NOT stop on `length`. It said nothing for some other reason;
 *     more room buys nothing and only widens the worst case.
 *   - the budget is already at MAX_OUTPUT_BUDGET_TOKENS. The ladder is a ladder:
 *     a raise that cannot raise must not read as one on the row.
 */
export const RETRY_BUDGET_MULTIPLIER = 2;

/** Did this answer stop because it ran out of output budget? Raw first: `length` is the provider's own word. */
export const ranOutOfBudget = (outcome: ModelCallOutcome): boolean =>
  outcome.finishReasonRaw === "length" || outcome.finishReason === "length";

export function raisedOutputBudget(shape: ModelCallShape, outcome: ModelCallOutcome): number | null {
  if (shape.outputCap === null) return null;
  if (!ranOutOfBudget(outcome)) return null;
  if (shape.outputCap >= MAX_OUTPUT_BUDGET_TOKENS) return null;
  return Math.min(shape.outputCap * RETRY_BUDGET_MULTIPLIER, MAX_OUTPUT_BUDGET_TOKENS);
}

/**
 * HOW MANY ATTEMPTS, AND WHY THIS MANY.
 *
 * The measured failure was deterministic: same depth, same conversation, every
 * attempt, twice over two sessions. A bare retry was therefore never going to be
 * the answer on its own — but it costs one call and provider blips are real, so
 * there is exactly ONE. Then the model changes, because a deterministic failure
 * of one model is the only thing a second model reliably fixes.
 *
 * The arithmetic: at most 3 provider calls for one step (first + one nudged
 * retry + one fallback), against the 2 it was before — for a step that
 * previously lost the whole turn. A third same-model attempt would have bought a
 * fourth call and nothing else.
 *
 * AND EVE'S OWN RECOVERY NO LONGER FIRES, deliberately. Because this ladder
 * always hands something non-empty up, eve's `attemptEmptyResponseRecovery`
 * never sees an empty response and its nudge never runs. That nudge was the only
 * part of eve's recovery that changed anything about the request, so it is not
 * dropped — it is taken over here (`buildNudgedParams`), where it can run BEFORE
 * the fallback rather than after the turn has already died. Its WORDS are not
 * eve's any more: eve's "answer from the tool results above; do not re-run
 * tools" assumes tool results exist, and on a first step they do not (see
 * `emptyResponseNudge`).
 *
 * The delays are short on purpose. A person is watching a chat that has already
 * run three bash calls; 250 ms buys the retry whatever a transient provider
 * hiccup needs, and anything longer just makes the failure look like a hang.
 */
export const SAME_MODEL_RETRIES = 1;
export const RETRY_DELAY_MS = 250;
export const FALLBACK_DELAY_MS = 250;

export function planRecovery(input: {
  readonly attempt: number;
  readonly shape: ModelCallShape;
  /** What the attempt that just failed looked like — `length` decides whether the budget is raised. */
  readonly outcome: ModelCallOutcome;
  readonly fallbackAvailable: boolean;
  /** Has the other role's model already had its go on this call? */
  readonly fallbackUsed: boolean;
}): RecoveryStep {
  // Computed once, for whichever attempt is planned. A fallback gets it too: by
  // then the raise has already failed to help on THIS model, and handing the
  // second model the budget that was too small for the first would make the one
  // genuinely independent attempt in the ladder the most constrained one.
  const outputBudget = raisedOutputBudget(input.shape, input.outcome);
  if (input.attempt <= SAME_MODEL_RETRIES) {
    return { action: "retry", delayMs: RETRY_DELAY_MS, reason: null, outputBudget };
  }
  if (input.fallbackUsed) {
    // The ladder is a LADDER, not a loop. Without this the second model's empty
    // answer plans a second fallback, and the middleware reissues for ever
    // against a model that has already said nothing — a hung chat and an
    // unbounded bill, which is strictly worse than the failure being fixed.
    return { action: "explain", delayMs: 0, reason: "fallback-also-empty", outputBudget: null };
  }
  if (!input.fallbackAvailable) {
    return { action: "explain", delayMs: 0, reason: "no-fallback-configured", outputBudget: null };
  }
  if (input.shape.hasImageInput) {
    // WHAT FALLING BACK COSTS: the specialist is text-only. On this deployment
    // the orchestrator is the vision model precisely because the chat sends
    // images as file parts, and a text-only model answers "I cannot see the
    // image" — a confident wrong answer, which is worse than the failure it
    // replaces. So a turn carrying a real image never falls back; it gets the
    // sentence instead. The measured pdf workflow is unaffected: the sandbox
    // hands the model TEXT.
    //
    // THE BUDGET DOES NOT WEAKEN THIS. A vision call that ran out of room is the
    // measured failure itself, and the answer to it is the raise on the retry
    // above — never a text-only model. This branch is reached after that raise
    // has already been tried, so the outcome here is still an explanation.
    return { action: "explain", delayMs: 0, reason: "vision-required", outputBudget: null };
  }
  return { action: "fallback", delayMs: FALLBACK_DELAY_MS, reason: null, outputBudget };
}

/**
 * The same call, with a different output budget. Null leaves it exactly as it
 * was — including leaving an uncapped call uncapped, which is a different request
 * from one capped at any number.
 */
export function withOutputBudget(params: ModelCallParams, budget: number | null): ModelCallParams {
  return budget === null ? params : { ...params, maxOutputTokens: budget };
}

/**
 * MORE ROOM IS HALF THE ANSWER TO A MODEL THAT THOUGHT UNTIL IT RAN OUT; LESS
 * THINKING IS THE OTHER HALF.
 *
 * The 2026-09-24 row on onfinance_hfc: GLM 5.3, first step of a turn, `out=8192
 * cap=8192`, empty, `next_cap=16384` — and the retry spent most of the doubled
 * budget thinking again before it wrote anything. Doubling alone lets a runaway
 * run twice as long. So a retry after a `length` finish also asks for LOW
 * reasoning effort (the AI SDK's `reasoning` call option, which the Workers AI
 * provider sends as `reasoning_effort`). Measured the same day: "low" cut GLM
 * 5.3's reasoning about five-fold on a planning prompt; Kimi K2.6 accepts the
 * field and ignores it, so it is safe on either orchestrator.
 *
 * Null (leave it) when the attempt did not run out of budget, or the call
 * already asked for as little thinking as this would.
 */
/**
 * ONLY MODELS MEASURED TO TAKE THE FIELD. Probed against Workers AI on
 * 2026-09-24: GLM 5.3 honours `reasoning_effort` (low cuts its reasoning about
 * five-fold), Kimi K2.6 accepts it and ignores it. Nothing else was measured —
 * and an older note in model.ts says GLM 5.2 errors on it — so a model not on
 * this list is never sent it: a 400 there would turn a recoverable empty
 * response into a failed turn. Add a model here only after probing it.
 *
 * GLM 5.3 Flash (`@cf/zai-org/glm-5.3-flash`, the default vision model since
 * 2026-09-25) is on it because Cloudflare documents its reasoning levels
 * (low/high/max, default max). The same list gates the reasoning level
 * `read_image` sends (agent/lib/vision-tools.ts), and that call keeps the same
 * belt: a 4xx naming the field is retried once without it.
 */
export const RECOVERY_REASONING_MODELS: ReadonlySet<string> = new Set([
  "@cf/zai-org/glm-5.3",
  "@cf/zai-org/glm-5.3-flash",
  "@cf/moonshotai/kimi-k2.6",
]);

export function raisedRecoveryReasoning(params: ModelCallParams, outcome: ModelCallOutcome, modelId?: string): "low" | null {
  if (!ranOutOfBudget(outcome)) return null;
  if (modelId !== undefined && !RECOVERY_REASONING_MODELS.has(modelId)) return null;
  const current = (params as { reasoning?: unknown }).reasoning;
  if (current === "none" || current === "minimal" || current === "low") return null;
  return "low";
}

export function withRecoveryReasoning(params: ModelCallParams, reasoning: "low" | null): ModelCallParams {
  return reasoning === null ? params : ({ ...params, reasoning } as ModelCallParams);
}

/**
 * The belt to the allow-list's braces: a provider that answers 4xx and names
 * the reasoning field gets the same call once more WITHOUT it. Read off the
 * AI SDK's APICallError shape (`statusCode`, `responseBody`, `message`).
 */
export function refusedReasoningField(error: unknown): boolean {
  const e = (error ?? {}) as { statusCode?: unknown; responseBody?: unknown; message?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : null;
  if (status === null || status < 400 || status >= 500) return false;
  return /reasoning/i.test(`${typeof e.message === "string" ? e.message : ""} ${typeof e.responseBody === "string" ? e.responseBody : ""}`);
}

/** Make a call; if it carried the recovery's `reasoning` and the provider refused that field, make it once without. */
export async function callWithoutRefusedReasoning<T>(params: ModelCallParams, added: boolean, call: (p: ModelCallParams) => PromiseLike<T>): Promise<T> {
  try {
    return await call(params);
  } catch (error) {
    if (!added || !refusedReasoningField(error)) throw error;
    const { reasoning: _dropped, ...rest } = params as ModelCallParams & { reasoning?: unknown };
    return await call(rest as ModelCallParams);
  }
}

/**
 * THE SENTENCE A PERSON GETS INSTEAD OF A CHAT THAT STOPS.
 *
 * Returned AS THE MODEL'S ANSWER, so eve finishes the turn normally and the
 * transcript — the fetched pdf, the extracted text, the three bash calls — stays
 * in the conversation to be continued from. The alternative is what happens
 * today: `MODEL_CALL_FAILED` parks the session and the person sees the reply
 * never arrive, with no way to tell a dead turn from a slow one.
 *
 * No jargon, because the person reading it is not an engineer: no "model", no
 * "empty response", no "token". It says what happened, that nothing was lost,
 * and what to type next.
 */
export const LAST_RESORT_SENTENCE =
  "I could not get a reply back just now, so I have stopped here rather than guessing. " +
  "Nothing is lost — everything I read and ran is still in this conversation. " +
  "Say \"carry on\" and I will pick up from where I got to.";

/**
 * WHAT THE RETRY SAYS THAT THE FIRST CALL DID NOT — AND ONLY WHAT IS TRUE.
 *
 * Reissuing an identical request against a failure that reproduced on EVERY
 * attempt at the same depth is close to useless, so the retry carries a note.
 * It is appended to a COPY of the prompt: a prod for one call, never a message
 * in the transcript that the person did not send.
 *
 * THE NOTE USED TO BE A FIXED SENTENCE, and it made the model lie. It said
 * "Answer now, in text, from the tool results already above. Do not re-run
 * tools" — eve's own wording, written for an empty reply AFTER tool calls. On
 * 2026-09-24 (onfinance_hfc, GLM 5.3) the first step of a turn spent its whole
 * 8,192-token budget reasoning about a write the person had asked for, and came
 * back empty with NO tool results anywhere in the prompt (`msgs=2` on the row).
 * The retry was told results existed that did not, forbidden the one tool the
 * request needed, and told to answer in text. It wrote "notes updated … set via
 * `upsert_company` … went through the usual approval gate". Nothing had run.
 *
 * THIS NOTE IS THE FIX; the output guard further down is a best-effort
 * backstop. So the note is built from what the prompt structurally shows
 * (`readTurnEvidence`), and claims only what that establishes:
 *   - tool results after the person's latest message: point at them;
 *   - none, no compaction, and no earlier write in the conversation: say, as a
 *     checked fact, that no tool has run since the person's message;
 *   - otherwise — eve compacted the conversation (its checkpoint drops every
 *     tool result), there is no real person's message to anchor on, or an
 *     earlier write exists — NEUTRAL: no claim either way, check before acting,
 *     and do not repeat an action that already ran. Write tools are approved
 *     `once()`, so a repeated write would run without asking the person again.
 * Every variant allows tools (the retry is the same model call, so a tool call
 * it returns runs through eve's tool loop and approval gate like any step), asks
 * for short reasoning, and says: never claim an action without its tool result.
 *
 * NOT given to the fallback model: "your previous attempt produced no reply" is
 * a lie told to a model that has not replied yet.
 */
const NEVER_CLAIM =
  "Never say an action happened (a record written, a field set, a file saved, a message sent) unless its tool result is in this conversation.";

/** The note when tool results exist after the person's latest message. */
export const NUDGE_AFTER_TOOL_RESULTS =
  "Your previous attempt produced no reply, so nothing was delivered. The tool results since the person's last message are above: " +
  "answer from them, or call a tool now if the request still needs one; do not repeat an action whose result is already there. Keep your reasoning short. " +
  `${NEVER_CLAIM} Do not mention this note.`;

/** The note when NO tool has run since the person's latest message and nothing was written before — the live 2026-09-24 case. */
export const NUDGE_NO_TOOL_RESULTS =
  "Your previous attempt produced no reply, and no tool has run since the person's last message, so nothing they asked for has been done yet. " +
  "If the request needs a tool, call that tool now; otherwise answer. Keep your reasoning short and act. " +
  `${NEVER_CLAIM} Do not mention this note.`;

/** The note when the prompt cannot establish either (compaction, no anchor, an earlier write): no claim either way. */
export const NUDGE_NEUTRAL =
  "Your previous attempt produced no reply, so nothing was delivered. Check the conversation above before acting: " +
  "do not repeat an action that already ran, and call a tool only if the request still needs one. Keep your reasoning short. " +
  `${NEVER_CLAIM} Do not mention this note.`;

/* -------------------------------------------------------------------------- */
/* What the prompt structurally shows                                         */
/* -------------------------------------------------------------------------- */

/**
 * eve's compaction checkpoint (`COMPACTION_CHECKPOINT_MARKER` in
 * eve/dist/src/harness/compaction-prompt.js): compactMessages replaces the
 * older conversation with a user message carrying exactly this, then the
 * summary, then the recent window WITHOUT any `tool` message, then — when the
 * window ends on the assistant — a synthetic user "Continue.". After it, the
 * absence of a tool result proves nothing.
 */
export const EVE_COMPACTION_MARKER = "Summary of our conversation so far:";
/** User messages eve writes itself: not the person. */
const EVE_SYNTHETIC_USER = new Set(["Continue.", EVE_COMPACTION_MARKER]);
/** eve's ask-the-person tool: an answer is the person speaking, never a write. */
const ASK_TOOL = "ask_question";

type PromptMessage = { role?: unknown; content?: unknown };
type ResultPart = { type?: unknown; toolName?: unknown; output?: { type?: unknown; value?: unknown } };

function messageText(message: PromptMessage): string {
  const c = message?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return (c as ReadonlyArray<{ type?: unknown; text?: unknown }>)
    .map((p) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
    .join("");
}

/**
 * Did this tool result SUCCEED? Not when it is an error output (`error-text`/
 * `error-json`), an approval denial (`execution-denied`), or a JSON result that
 * reports its own failure, at the top level or under `result` (mcp_call wraps a
 * remote tool's answer as `{ connector, tool, result }`): `error` as a string,
 * `ok: false`, `isError: true`, or `status` "failed" / "error".
 */
function reportsFailure(v: unknown): boolean {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as { error?: unknown; ok?: unknown; isError?: unknown; status?: unknown };
  const status = typeof o.status === "string" ? o.status.toLowerCase() : "";
  return typeof o.error === "string" || o.ok === false || o.isError === true || status === "failed" || status === "error";
}

function succeeded(part: ResultPart): boolean {
  const t = part.output?.type;
  if (t !== "json" && t !== "text" && t !== "content") return false;
  const v = part.output?.value;
  if (t === "json" && (reportsFailure(v) || reportsFailure((v as { result?: unknown } | null)?.result))) return false;
  return true;
}

/**
 * Tools that cannot have done a write: the explicit allow-list in
 * agent/lib/read-only-tools.ts, plus eve's own non-writes. Every other tool —
 * unknown ones included — is possible write evidence when it succeeds.
 */
export type ReadOnlyToolTest = (name: string) => boolean;
const EVE_NON_WRITES = new Set([ASK_TOOL, "final_output", "load_skill"]);
const readOnlyOrEve = (test: ReadOnlyToolTest): ReadOnlyToolTest => (name) => EVE_NON_WRITES.has(name) || test(name);

/** Name rule, used only when a caller hands `claimsCompletedWrite` a bare list of tool names. */
const MUTATING_TOOL_WORD =
  /(^|_)(upsert|create|update|delete|remove|set|write|save|add|put|patch|append|insert|record|log|archive|rename|move|send|submit|publish|assign|clear|upload|import|trigger)(_|$)/i;
export const nameLooksLikeWrite = (name: string): boolean => MUTATING_TOOL_WORD.test(name);

export interface TurnEvidence {
  /** eve compacted the conversation: tool results before the checkpoint are gone, so absence proves nothing. */
  readonly compacted: boolean;
  /** Index of the person's latest REAL message (eve's synthetic ones skipped), or -1. */
  readonly personIndex: number;
  readonly personText: string;
  /** Tool results of any kind since the person's latest message (ask-the-person answers excluded). */
  readonly resultsSince: number;
  /** Tools NOT known read-only with a SUCCESSFUL result since the person's latest message: possible writes. */
  readonly writesSince: readonly string[];
  /** The same, earlier in the conversation. */
  readonly writesBefore: readonly string[];
}

export function readTurnEvidence(prompt: unknown, readOnly: ReadOnlyToolTest = isReadOnlyTool): TurnEvidence {
  const isReadOnly = readOnlyOrEve(readOnly);
  const messages = (Array.isArray(prompt) ? prompt : []) as ReadonlyArray<PromptMessage>;
  let compacted = false;
  let personIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const text = messageText(m).trim();
    // eve appends "Continue." only after a compaction, so it marks one even when the checkpoint text itself is
    // not recognised. A person who really types "Continue." gets the neutral note and no guard: the safe side.
    if (text.startsWith(EVE_COMPACTION_MARKER) || text === "Continue.") compacted = true;
    if (personIndex === -1 && !EVE_SYNTHETIC_USER.has(text) && !text.startsWith(EVE_COMPACTION_MARKER)) personIndex = i;
  }
  let resultsSince = 0;
  const writesSince: string[] = [];
  const writesBefore: string[] = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m?.content)) return;
    for (const part of m.content as ReadonlyArray<ResultPart>) {
      if (part?.type !== "tool-result") continue;
      const name = typeof part.toolName === "string" ? part.toolName : "";
      const after = personIndex >= 0 && i > personIndex;
      if (after && name !== ASK_TOOL) resultsSince++;
      // A nameless result is unknown, and unknown is possible evidence.
      if ((name && isReadOnly(name)) || !succeeded(part)) continue;
      (after ? writesSince : writesBefore).push(name || "?");
    }
  });
  return {
    compacted,
    personIndex,
    personText: personIndex >= 0 ? messageText(messages[personIndex]) : "",
    resultsSince,
    writesSince,
    writesBefore,
  };
}

/** Kept for callers of #56: tool results (any kind) since the person's latest real message. */
export function toolResultsSinceLastUserMessage(prompt: unknown): number {
  return readTurnEvidence(prompt).resultsSince;
}

/** The note this prompt gets: true about the transcript it is appended to, and never a ban on tools. */
export function emptyResponseNudge(params: ModelCallParams, readOnly: ReadOnlyToolTest = isReadOnlyTool): string {
  const e = readTurnEvidence(params.prompt, readOnly);
  if (e.compacted || e.personIndex < 0) return NUDGE_NEUTRAL;
  if (e.resultsSince > 0) return NUDGE_AFTER_TOOL_RESULTS;
  if (e.writesBefore.length > 0) return NUDGE_NEUTRAL;
  return NUDGE_NO_TOOL_RESULTS;
}

export function buildNudgedParams(params: ModelCallParams, readOnly: ReadOnlyToolTest = isReadOnlyTool): ModelCallParams {
  const prompt = [...((params.prompt ?? []) as unknown[])] as ModelCallParams["prompt"];
  prompt.push({ role: "user", content: [{ type: "text", text: emptyResponseNudge(params, readOnly) }] });
  return { ...params, prompt };
}

/* -------------------------------------------------------------------------- */
/* The guard: a best-effort backstop                                          */
/* -------------------------------------------------------------------------- */

/**
 * A RECOVERED ANSWER MAY NOT CLAIM THE WRITE THIS TURN ASKED FOR WHEN NO WRITE
 * RAN — AND MUST NOT WITHHOLD A TRUE ANSWER.
 *
 * Withholding a true answer after an empty first attempt is as much a failure
 * as delivering a false one, so the guard is narrow on both axes.
 *
 * STRUCTURAL EVIDENCE (`readTurnEvidence`). The guard runs only when:
 *   - the answer is a recovery (a retry or a fallback) with no tool call;
 *   - the conversation was NOT compacted, and a real person's message anchors
 *     the turn (eve's "Continue." and checkpoint are not the person);
 *   - the person's message asks for a write (`writeTargets` finds a target);
 *   - EVERY successful tool result since that message came from a tool on the
 *     explicit read-only allow-list (agent/lib/read-only-tools.ts), or there
 *     are none. Any other successful result — a subagent or delegation (on
 *     onfinance_hfc the specialists do their writes there), `bash`, `remember`,
 *     a pack's own tool, an MCP call, a tool nobody listed — may be the write,
 *     and the guard stands down. Unknown fails safe: the answer is delivered.
 *     An error, an approval denial, a result reporting `isError`/`status:
 *     failed`, or an answered ask-the-person is not a success and backs nothing.
 * And it stands down when an earlier possible write in the conversation could
 * be what the answer reports: the same tool named, or any when the claim names
 * no tool.
 *
 * NARROW TEXT MATCH (`claimsCompletedWrite`). Quoted text is ignored ("…",
 * “…”, `> ` lines). A sentence counts only if it names the TARGET of this
 * turn's write — a non-read-only tool the model was given, or a word the person's
 * message asked to write (`writeTargets`: "set the notes field" -> notes) —
 * AND ties a past-tense write verb to it by construction: first person ("I've
 * updated", "I went ahead and updated"; never the conditional "I'd set"),
 * passive with the target as its subject ("Acme's notes have been changed",
 * not "the notes say the board has been changed"), the verb opening the sentence ("Updated Acme's notes"), the target
 * right before it ("Notes updated"), or a write tool named in the sentence
 * ("set via upsert_company"). A negation or modal in the verb's own clause
 * ("not updated yet", "I will set") clears it, and "set out" is not a write.
 *
 * KNOWN MISSES, accepted: "Done ✅", a markdown table saying "updated", "Acme's
 * notes now read X", "Your change is live", non-English text, a target the
 * person named without a write verb before it. The nudge is what prevents
 * these; the guard only catches the cheap, unambiguous shape the live answer had.
 */
const WRITE_VERBS =
  "updated|saved|created|deleted|removed|added|recorded|logged|written|wrote|changed|modified|stored|set|applied|sent|submitted|posted|uploaded|archived|renamed|inserted|replaced|appended|cleared|filled|marked";
const ASK_VERBS = "set|update|change|edit|save|add|record|log|write|create|delete|remove|rename|mark|put|store|fill|clear";
const TARGET_STOP = new Set([
  "the", "a", "an", "my", "our", "your", "this", "that", "these", "those", "its", "their", "his", "her",
  "field", "fields", "record", "records", "value", "values", "entry", "please", "it", "them", "new", "up",
]);
const TARGET_BOUNDARY = new Set(["to", "on", "in", "for", "with", "as", "from", "into", "at", "by", "of", "and", "using", "via", "so", "then"]);
const NEGATION =
  /\b(not|no|nothing|never|none|neither|nor|without|cannot|can't|couldn't|didn't|don't|doesn't|hasn't|haven't|wasn't|weren't|isn't|aren't|won't|wouldn't|will|would|could|should|shall|can|may|might|must|to|if|once|until|unless|yet|about|going|need|needs|want|wants|before|last)\b/i;

/** The words a person's message asks to write: "set the notes field on …" -> ["notes"]; "set Acme notes to X" -> ["acme", "notes"]. */
export function writeTargets(personText: string): string[] {
  const out = new Set<string>();
  const words = personText.toLowerCase().split(/[^\p{L}\p{N}_'-]+/u).filter(Boolean);
  const ask = new RegExp(`^(${ASK_VERBS})$`);
  for (let i = 0; i < words.length; i++) {
    if (!ask.test(words[i])) continue;
    for (let k = i + 1; k < Math.min(words.length, i + 6); k++) {
      const w = words[k].replace(/'s$/, "");
      if (TARGET_BOUNDARY.has(w)) break;
      if (TARGET_STOP.has(w) || w.length < 3) continue;
      out.add(w);
    }
  }
  return [...out];
}

/** Quoted material is someone else's words, never the model's claim. */
function withoutQuotes(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Negated or modal WITHIN the verb's own clause (the last clause boundary before it). */
function negatedInClause(before: string): boolean {
  const clause = before.split(/[,;:—–(]|\s-\s/).at(-1) ?? "";
  return NEGATION.test(clause.trim().split(/\s+/).slice(-4).join(" "));
}

export interface ClaimTargets {
  /** Write tools the model was given, as it reads them. */
  readonly writeTools: readonly string[];
  /** Words the person's latest message asked to write (`writeTargets`). */
  readonly targets: readonly string[];
}

export function claimsCompletedWrite(text: string, spec: ClaimTargets | readonly string[]): boolean {
  const { writeTools, targets } = Array.isArray(spec)
    ? { writeTools: (spec as readonly string[]).filter(nameLooksLikeWrite), targets: [] as string[] }
    : (spec as ClaimTargets);
  const clean = withoutQuotes(text);
  if (!clean.trim()) return false;
  const targetRes = targets.map((t) => new RegExp(`\\b${escapeRe(t)}(?:'s)?\\b`, "i"));
  for (const sentence of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const namesTool = writeTools.some((n) => sentence.includes(n));
    const namesTarget = targetRes.some((re) => re.test(sentence));
    if (!namesTool && !namesTarget) continue;
    for (const m of sentence.matchAll(new RegExp(`\\b(${WRITE_VERBS})\\b`, "gi"))) {
      const at = m.index ?? 0;
      const before = sentence.slice(0, at);
      if (negatedInClause(before)) continue;
      // "set out" (to present) is a phrasal verb, not a write.
      if (/^set$/i.test(m[1]) && /^\s+out\b/i.test(sentence.slice(at + m[1].length))) continue;
      if (namesTool) return true;
      const b = before.replace(/[*_`]/g, "");
      // First person, never conditional: "I'd set the notes, but…" is not a claim.
      if (/\b(?:I|we)(?:'ve|\s+have|\s+had)?\s+(?:[\p{L}']+\s+){0,3}$/iu.test(b) && !/\b(?:I|we)'d\s+(?:[\p{L}']+\s+){0,3}$/iu.test(b)) return true;
      // Passive, and its SUBJECT must be the target: "Acme's notes have been changed", not "the notes … say the
      // board has been changed".
      const passive = b.match(/\b(?:(?:has|have|had)\s+(?:\w+\s+)?been\s+(?:\w+\s+)?|(?:was|were)\s+(?:now\s+|just\s+|successfully\s+)?)$/i);
      if (passive) {
        const subject = b.slice(0, passive.index).split(/[,;:—–(]/).at(-1)!.trim().split(/\s+/).slice(-4).join(" ");
        if (targetRes.some((re) => re.test(subject))) return true;
      }
      if (!/[\p{L}\p{N}]/u.test(b)) return true;
      if (targetRes.some((re) => new RegExp(`${re.source}\\s*$`, "i").test(b))) return true;
    }
  }
  return false;
}

/** Why an answer that was not empty was still not delivered. */
export type RejectionReason = "unbacked-claim";

/** The names the model was given, as it reads them — `upsert_company`, not the base name. */
function advertisedToolNames(params: ModelCallParams): string[] {
  return ((params.tools ?? []) as ReadonlyArray<{ name?: unknown }>).map((t) => (typeof t?.name === "string" ? t.name : "")).filter(Boolean);
}

/** Should a recovered answer on THIS request be judged before it is delivered? See the block above. */
export function guardsRecoveredAnswer(params: ModelCallParams, readOnly: ReadOnlyToolTest = isReadOnlyTool): boolean {
  const e = readTurnEvidence(params.prompt, readOnly);
  return !e.compacted && e.personIndex >= 0 && e.writesSince.length === 0 && writeTargets(e.personText).length > 0;
}

/** The judgement on a recovered answer's text, given whether it made a tool call. */
export function rejectRecoveredAnswer(
  params: ModelCallParams,
  text: string,
  hadToolCalls: boolean,
  readOnly: ReadOnlyToolTest = isReadOnlyTool,
): RejectionReason | null {
  if (hadToolCalls) return null;
  const e = readTurnEvidence(params.prompt, readOnly);
  if (e.compacted || e.personIndex < 0 || e.writesSince.length > 0) return null;
  const targets = writeTargets(e.personText);
  // No target, no guard: the claim match needs one, and the stream path only holds an attempt when there is one.
  if (targets.length === 0) return null;
  const isReadOnly = readOnlyOrEve(readOnly);
  const writeTools = advertisedToolNames(params).filter((n) => !isReadOnly(n));
  if (!claimsCompletedWrite(text, { writeTools, targets })) return null;
  if (e.writesBefore.length > 0) {
    // An earlier write could be what this reports. Same tool named, or no tool named: stand down.
    const named = writeTools.filter((n) => text.includes(n));
    if (named.length === 0 || named.some((n) => e.writesBefore.includes(n))) return null;
  }
  return "unbacked-claim";
}

/* -------------------------------------------------------------------------- */
/* The record                                                                 */
/* -------------------------------------------------------------------------- */

const show = (value: number | null, none = "?") => (value === null ? none : String(value));

/**
 * The audit row's detail clause: shape, never content.
 *
 * Fits inside the 400 characters `/api/ops/chat-telemetry` accepts, so the same
 * string can travel either way into `automation_audit`.
 */
export function formatEmptyResponseDetail(record: EmptyResponseRecord): string {
  const parts = [
    `model=${record.modelId}`,
    `path=${record.path}`,
    // Both reasons: the unified one is comparable across providers, the raw one
    // is the `finish_reason: "length"` the single reproduction turns on.
    `finish=${record.finishReason ?? "?"}`,
    `finish_raw=${record.finishReasonRaw ?? "?"}`,
    `in=${show(record.promptTokens)}`,
    `out=${show(record.completionTokens)}`,
    // `out_thinking` beside `out` is the whole reproduction in two numbers.
    `out_thinking=${show(record.reasoningTokens)}`,
    `toolcalls=${record.hadToolCalls ? "yes" : "no"}`,
    `msgs=${record.messages}`,
    `tools=${record.tools}`,
    `bytes=${record.approxBytes < 0 ? "?" : record.approxBytes}`,
    // The cause, per occurrence. `cap=none` means nothing in the path — eve, the
    // AI SDK, the role's budget, a call site, a provider default — put a per-call
    // output cap on this request. On Workers AI it is now always a number, and
    // `cap` against `out`/`out_thinking` is the whole diagnosis in three figures:
    // `out == cap` with `out_thinking == out` is the 2026-09-23 failure, `out`
    // well under `cap` is a different fault wearing the same error message.
    `cap=${record.outputCap === null ? "none" : record.outputCap}`,
    // Only when the ladder raised it — an absent field reads as "the next attempt
    // ran on the same budget", which is what it means.
    ...(record.nextOutputCap === null ? [] : [`next_cap=${record.nextOutputCap}`]),
    ...(record.nextReasoning === null ? [] : [`next_reasoning=${record.nextReasoning}`]),
    `images=${record.hasImageInput ? "yes" : "no"}`,
    // Only on an answer that had content and was withheld anyway.
    ...(record.rejected === null ? [] : [`rejected=${record.rejected}`]),
    `next=${record.next}${record.nextReason ? `:${record.nextReason}` : ""}`,
  ];
  return parts.join(" ");
}

/** The kind an individual record files under. */
export function kindForRecord(record: EmptyResponseRecord): "model-empty" | "model-empty-gave-up" | "model-unbacked-claim" {
  if (record.rejected === "unbacked-claim") return "model-unbacked-claim";
  return record.next === "explain" ? "model-empty-gave-up" : "model-empty";
}

/* -------------------------------------------------------------------------- */
/* The middleware                                                             */
/* -------------------------------------------------------------------------- */

export interface EmptyResponseDeps {
  /** The model this middleware is wrapped around, for the record. */
  modelId(): string;
  /**
   * The other configured role model, or null when there is nothing to fall back
   * to (same id, or a provider where a second role makes no sense).
   */
  fallback(): { readonly id: string; readonly model: ModelLike } | null;
  /** Hand one record to the telemetry sink. MUST NOT throw and MUST NOT block. */
  publish(record: EmptyResponseRecord): void;
  /** Injected so a test runs the real ladder without real delays. */
  sleep(ms: number): Promise<void>;
  /** Injected so a test can assert record identity without matching a uuid. */
  newId(): string;
  /** Is this (model-facing) tool known read-only? Defaults to agent/lib/read-only-tools.ts; injected by tests. */
  isReadOnlyTool?(name: string): boolean;
}

function textParts(id: string, text: string): StreamPart[] {
  return [
    { type: "text-start", id } as StreamPart,
    { type: "text-delta", id, delta: text } as StreamPart,
    { type: "text-end", id } as StreamPart,
  ];
}

/**
 * Survive an empty response, and record what it looked like.
 *
 * Wrapped DIRECTLY around the provider model (see `agentModel`), inside
 * `uniqueToolCallIds`, so a fallback model's counter-style tool-call ids are
 * rewritten by the outer middleware exactly like the orchestrator's — the
 * failure that rewrite exists for (a repeated id silently REPLACING an earlier
 * subagent run) does not care which model minted the id.
 *
 * A RECOVERY IS STILL THE STEP'S ONE MODEL CALL. eve runs each step as a single
 * call (`stopWhen: isStepCount(1)`) and acts on whatever that call returns, so a
 * retry or fallback that answers with a tool call is executed by eve's tool loop
 * exactly as if the first attempt had made it — approval gate, `actions.requested`
 * and all. Nothing here has to "re-enter" the loop; it only has to not forbid
 * tools (the nudge) and not take a text answer that claims work nobody did (the
 * guard below).
 *
 * THE GUARD (a best-effort backstop; see `rejectRecoveredAnswer` for exactly
 * when it runs). A recovered answer that claims the write this turn asked for,
 * with no successful write result behind it, is treated like one more failed
 * attempt and the ladder carries on — the other model if there is one (which
 * can call the tool for real), otherwise the last-resort sentence. On the
 * stream path a guarded attempt is held WHOLE (reasoning included) until its
 * `finish`, so neither a withheld answer nor its thinking reaches the person.
 * Only a recovery the guard COULD reject is held: the person asked for a write
 * and nothing that could have written has run. Every other recovery — a
 * read-only question, a turn a subagent or `bash` already worked on — streams
 * live exactly as before, and so does the first attempt.
 *
 * THE COST, AND WHY THERE IS NO KEEP-ALIVE. While held, the chat shows nothing
 * new. GLM 5.3 on Workers AI streamed ~70 output tokens/s in the 2026-09-24
 * probe (1,126 tokens in 16 s), so the worst case — a 16,384-token retry — is
 * about four minutes of silence; with the retry asked for low reasoning the
 * measured answers were 70–600 tokens, a few seconds. Nothing times out on
 * that silence: the provider stream is being read the whole time, eve awaits
 * the model call in-process, and the browser's 90 s "stall" is a telemetry
 * count that changes nothing on screen — a subagent call is routinely silent
 * as long. An artificial keep-alive (an empty reasoning part) would render as
 * an empty thinking block, so it is accepted and documented instead.
 */
export function createEmptyResponseRecovery(deps: EmptyResponseDeps): LanguageModelMiddleware {
  const readOnly: ReadOnlyToolTest = deps.isReadOnlyTool ?? isReadOnlyTool;
  function record(input: {
    shape: ModelCallShape;
    outcome: ModelCallOutcome;
    attempt: number;
    modelId: string;
    path: "stream" | "generate";
    step: RecoveryStep;
    rejected?: RejectionReason | null;
    nextReasoning?: "low" | null;
  }): void {
    const row: EmptyResponseRecord = {
      ...input.shape,
      ...input.outcome,
      id: deps.newId(),
      attempt: input.attempt,
      modelId: input.modelId,
      path: input.path,
      next: input.step.action,
      nextReason: input.step.reason,
      nextOutputCap: input.step.outputBudget,
      rejected: input.rejected ?? null,
      nextReasoning: input.nextReasoning ?? null,
    };
    try {
      deps.publish(row);
    } catch (telemetryError) {
      // An instrument that can fail the thing it measures is worse than no
      // instrument: this middleware exists to keep a turn alive.
      console.error("[empty-model-response] could not publish the record:", telemetryError);
    }
  }

  return {
    specificationVersion: "v4",

    async wrapGenerate({ doGenerate, params, model }) {
      let attempt = 0;
      let activeId = deps.modelId();
      let fallbackUsed = false;
      /**
       * The params THIS attempt was made with — which is not `params` any more,
       * because a `length` failure has its output budget raised for the next go.
       * The row must describe the call that actually failed, and the next call
       * must inherit the raise rather than silently dropping back.
       *
       * Never carries the nudge: that is appended to a copy at the call, so one
       * retry cannot leave two copies of it in a later attempt's prompt.
       */
      let callParams = params;
      let result = await doGenerate();
      for (;;) {
        attempt++;
        const outcome = summarizeGenerateResult(result);
        let rejected: RejectionReason | null = null;
        if (!outcome.empty) {
          // Attempt 1 is the model answering first time: never second-guessed.
          if (attempt === 1) return result;
          const text = ((result?.content ?? []) as ReadonlyArray<{ type?: string; text?: string }>)
            .filter((part) => part?.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("");
          rejected = rejectRecoveredAnswer(callParams, text, outcome.hadToolCalls, readOnly);
          if (rejected === null) return result;
        }
        const shape = describeModelCall(callParams);
        const fallback = deps.fallback();
        const step = planRecovery({ attempt, shape, outcome, fallbackAvailable: fallback !== null, fallbackUsed });
        const nextModelId = step.action === "fallback" && fallback ? fallback.id : activeId;
        const nextReasoning = step.action === "explain" ? null : raisedRecoveryReasoning(callParams, outcome, nextModelId);
        record({ shape, outcome, attempt, modelId: activeId, path: "generate", step, rejected, nextReasoning });
        if (step.delayMs > 0) await deps.sleep(step.delayMs);
        if (step.action === "explain") {
          const explained: GenerateResult = {
            ...result,
            content: [{ type: "text", text: LAST_RESORT_SENTENCE }],
            finishReason: { unified: "stop", raw: "empty-response-explained" },
          };
          return explained;
        }
        // The budget raise sticks for later attempts; the reasoning level is
        // decided per call, because the next model may not take the field.
        callParams = withOutputBudget(callParams, step.outputBudget);
        const sent = withRecoveryReasoning(callParams, nextReasoning);
        if (step.action === "fallback" && fallback) {
          activeId = fallback.id;
          fallbackUsed = true;
          result = (await callWithoutRefusedReasoning(sent, nextReasoning !== null, (p) => fallback.model.doGenerate(p))) as GenerateResult;
        } else {
          // `model.doGenerate` rather than `doGenerate()`, because the latter
          // can only reissue the IDENTICAL request — and identical is what
          // already failed. This middleware is the innermost one, so calling the
          // model directly skips nothing.
          result = (await callWithoutRefusedReasoning(buildNudgedParams(sent, readOnly), nextReasoning !== null, (p) => model.doGenerate(p))) as GenerateResult;
        }
      }
    },

    async wrapStream({ doStream, params, model }) {
      const first = await doStream();
      const sink = new TransformStream<StreamPart, StreamPart>();
      const writer = sink.writable.getWriter();

      /**
       * Forward one attempt's parts as they arrive, holding back only `finish` —
       * and, on a GUARDED attempt, everything.
       *
       * The point of holding `finish` is that a consumer treats it as the end of
       * the response; releasing it before we know whether this attempt said
       * anything would end the turn on the empty answer we are trying to
       * replace. Everything else — including reasoning deltas — goes straight
       * out, because burying a streaming chat behind a buffer to make this
       * middleware simpler would trade the defect for a worse one.
       *
       * `hold` is the one exception, and only on a guarded recovery: its text
       * has to be judged whole before any of it reaches the person, because a
       * streamed "notes updated" cannot be taken back — and neither can the
       * reasoning that planned it.
       */
      async function pump(
        stream: StreamResult["stream"],
        suppressStart: boolean,
        hold: boolean,
      ): Promise<{ outcome: ModelCallOutcome; finish: StreamPart | null; sawError: boolean; held: StreamPart[]; text: string }> {
        const watcher = createStreamWatcher();
        const reader = stream.getReader();
        let finish: StreamPart | null = null;
        const held: StreamPart[] = [];
        let text = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            watcher.observe(value);
            const part = value as { type?: string; delta?: unknown };
            const type = part?.type;
            if (type === "text-delta" && typeof part.delta === "string") text += part.delta;
            if (type === "finish") {
              finish = value;
              continue;
            }
            // A second `stream-start` mid-response announces warnings for a call
            // the consumer already thinks it is inside; the first one stands.
            if (suppressStart && type === "stream-start") continue;
            // A held attempt holds its reasoning too: a withheld answer's thinking
            // ("I'll just say notes updated") must not reach the person either.
            if (hold) {
              held.push(value);
              continue;
            }
            await writer.write(value);
          }
        } finally {
          // A reader left locked on a cancelled turn keeps the provider
          // connection open for the life of the process; eve cancels streams
          // routinely (the Stop button, an abort signal on every turn).
          reader.releaseLock();
        }
        return { outcome: watcher.outcome(), finish, sawError: watcher.sawError, held, text };
      }

      void (async () => {
        let attempt = 0;
        let activeId = deps.modelId();
        let fallbackUsed = false;
        let stream = first.stream;
        let suppressStart = false;
        // See the generate path: the params of the attempt being judged, which a
        // raised output budget changes between attempts.
        let callParams = params;
        try {
          for (;;) {
            // Attempt 1 is never held: a model that answers first time streams
            // exactly as it always did. Every later attempt is a recovery.
            const hold = attempt > 0 && guardsRecoveredAnswer(callParams, readOnly);
            const { outcome, finish, sawError, held, text } = await pump(stream, suppressStart, hold);
            attempt++;
            let rejected: RejectionReason | null = null;
            // Judged whether or not the stream also carried an error part: an
            // error beside a held fabrication must not wave it through.
            if (!outcome.empty && hold) rejected = rejectRecoveredAnswer(callParams, text, outcome.hadToolCalls, readOnly);
            if ((!outcome.empty || sawError) && rejected === null) {
              for (const part of held) await writer.write(part);
              if (finish) await writer.write(finish);
              return;
            }
            const shape = describeModelCall(callParams);
            const fallback = deps.fallback();
            const step = planRecovery({ attempt, shape, outcome, fallbackAvailable: fallback !== null, fallbackUsed });
            const nextModelId = step.action === "fallback" && fallback ? fallback.id : activeId;
            const nextReasoning = step.action === "explain" ? null : raisedRecoveryReasoning(callParams, outcome, nextModelId);
            record({ shape, outcome, attempt, modelId: activeId, path: "stream", step, rejected, nextReasoning });
            if (step.delayMs > 0) await deps.sleep(step.delayMs);
            if (step.action === "explain") {
              for (const part of textParts(`empty-recovery-${attempt}`, LAST_RESORT_SENTENCE)) {
                await writer.write(part);
              }
              // finishReason "stop", so eve finishes the turn instead of parking
              // it. The row already says the model said nothing, and the usage
              // carried through is the real one — the tokens were genuinely
              // spent, and a turn this expensive must still be billed.
              const finished: FinishPart = {
                ...((finish as FinishPart | null) ??
                  ({
                    type: "finish",
                    usage: { inputTokens: {}, outputTokens: {} },
                    finishReason: { unified: "stop", raw: null },
                  } as unknown as FinishPart)),
                type: "finish",
                // `raw` names this middleware, so a reader of a live trace can
                // tell a turn that ended in an explanation from one the model
                // really finished.
                finishReason: { unified: "stop" as const, raw: "empty-response-explained" },
              };
              await writer.write(finished as StreamPart);
              return;
            }
            suppressStart = true;
            callParams = withOutputBudget(callParams, step.outputBudget);
            const sent = withRecoveryReasoning(callParams, nextReasoning);
            if (step.action === "fallback" && fallback) {
              activeId = fallback.id;
              fallbackUsed = true;
              stream = ((await callWithoutRefusedReasoning(sent, nextReasoning !== null, (p) => fallback.model.doStream(p))) as StreamResult).stream;
            } else {
              // See the generate path: a nudged reissue, not an identical one.
              stream = ((await callWithoutRefusedReasoning(buildNudgedParams(sent, readOnly), nextReasoning !== null, (p) => model.doStream(p))) as StreamResult).stream;
            }
          }
        } catch (error) {
          // A failed REISSUE is a normal model-call error; hand it to eve as one
          // rather than leaving the reader hanging on a stream nobody will close.
          // Wrapped, because the commonest cause of landing here is the consumer
          // having gone away (Stop, or an aborted turn) — and then this write
          // rejects too, and an unhandled rejection out of a detached task is
          // how a recovery that worked takes the process down instead.
          await writer.write({ type: "error", error } as StreamPart).catch(() => {});
        } finally {
          await writer.close().catch(() => {});
        }
      })();

      return { ...first, stream: sink.readable };
    },
  };
}
