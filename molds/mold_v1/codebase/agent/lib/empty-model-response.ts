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
 * no cap, or 8192, the same conversation answers correctly. That is the
 * strongest lead and it is UNCONFIRMED for the live call: `agent/agent.ts` sets
 * no `limits.*`, `agent/lib/model.ts` sets no `maxOutputTokens`, and eve's
 * `maxOutputTokensPerSession` is a session BUDGET that parks a turn, never a
 * per-call `max_tokens` (harness/subagent-token-budget.js,
 * harness/session-limit-enforcement.js). So the cap is reported as a field on
 * every empty rather than asserted here: `cap=none` on a live row kills the
 * hypothesis outright, `cap=256` proves it, and either answer is worth more than
 * another afternoon of probing from outside.
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
   * THE FIELD THIS WHOLE FILE IS FOR. Read off the call options the provider is
   * about to be handed, so it reflects whatever eve, the AI SDK, a provider
   * default or `agent/instrumentation.ts` put there — not what this repo's
   * source says it puts there.
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
 * the fallback rather than after the turn has already died.
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
  readonly fallbackAvailable: boolean;
  /** Has the other role's model already had its go on this call? */
  readonly fallbackUsed: boolean;
}): RecoveryStep {
  if (input.attempt <= SAME_MODEL_RETRIES) {
    return { action: "retry", delayMs: RETRY_DELAY_MS, reason: null };
  }
  if (input.fallbackUsed) {
    // The ladder is a LADDER, not a loop. Without this the second model's empty
    // answer plans a second fallback, and the middleware reissues for ever
    // against a model that has already said nothing — a hung chat and an
    // unbounded bill, which is strictly worse than the failure being fixed.
    return { action: "explain", delayMs: 0, reason: "fallback-also-empty" };
  }
  if (!input.fallbackAvailable) {
    return { action: "explain", delayMs: 0, reason: "no-fallback-configured" };
  }
  if (input.shape.hasImageInput) {
    // WHAT FALLING BACK COSTS: the specialist is text-only. On this deployment
    // the orchestrator is the vision model precisely because the chat sends
    // images as file parts, and a text-only model answers "I cannot see the
    // image" — a confident wrong answer, which is worse than the failure it
    // replaces. So a turn carrying a real image never falls back; it gets the
    // sentence instead. The measured pdf workflow is unaffected: the sandbox
    // hands the model TEXT.
    return { action: "explain", delayMs: 0, reason: "vision-required" };
  }
  return { action: "fallback", delayMs: FALLBACK_DELAY_MS, reason: null };
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
 * WHAT THE RETRY SAYS THAT THE FIRST CALL DID NOT.
 *
 * Reissuing an identical request against a failure that reproduced on EVERY
 * attempt at the same depth is close to useless. eve knew this — its own
 * recovery appends a note telling the model its last reply was empty and to
 * answer from the tool results it already has — but that note only ever ran
 * after eve had decided the step had failed. Here it runs on the retry, one
 * layer down, where the turn is still alive.
 *
 * Appended to a COPY of the prompt. The note is a prod for one call; writing it
 * into the session would leave a message in the transcript that the person never
 * sent and the model would carry for the rest of the conversation.
 *
 * NOT given to the fallback model: "your previous reply was empty" is a lie told
 * to a model that has not replied yet, and a model that starts by apologising
 * for something it did not do is a worse answer than one that just answers.
 */
export const EMPTY_RESPONSE_NUDGE =
  "Your previous reply came back empty and was not delivered. Answer now, in text, from the tool results already above. " +
  "Do not re-run tools and do not mention this notice.";

export function buildNudgedParams(params: ModelCallParams): ModelCallParams {
  const prompt = [...((params.prompt ?? []) as unknown[])] as ModelCallParams["prompt"];
  prompt.push({ role: "user", content: [{ type: "text", text: EMPTY_RESPONSE_NUDGE }] });
  return { ...params, prompt };
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
    // The hypothesis, settled per occurrence. `cap=none` means nothing in the
    // path — eve, the AI SDK, the provider default, instrumentation — put a
    // per-call output cap on this request.
    `cap=${record.outputCap === null ? "none" : record.outputCap}`,
    `images=${record.hasImageInput ? "yes" : "no"}`,
    `next=${record.next}${record.nextReason ? `:${record.nextReason}` : ""}`,
  ];
  return parts.join(" ");
}

/** The kind an individual record files under. */
export function kindForRecord(record: EmptyResponseRecord): "model-empty" | "model-empty-gave-up" {
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
 */
export function createEmptyResponseRecovery(deps: EmptyResponseDeps): LanguageModelMiddleware {
  function record(input: {
    shape: ModelCallShape;
    outcome: ModelCallOutcome;
    attempt: number;
    modelId: string;
    path: "stream" | "generate";
    step: RecoveryStep;
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
      let result = await doGenerate();
      for (;;) {
        attempt++;
        const outcome = summarizeGenerateResult(result);
        if (!outcome.empty) return result;
        const shape = describeModelCall(params);
        const fallback = deps.fallback();
        const step = planRecovery({ attempt, shape, fallbackAvailable: fallback !== null, fallbackUsed });
        record({ shape, outcome, attempt, modelId: activeId, path: "generate", step });
        if (step.delayMs > 0) await deps.sleep(step.delayMs);
        if (step.action === "explain") {
          const explained: GenerateResult = {
            ...result,
            content: [{ type: "text", text: LAST_RESORT_SENTENCE }],
            finishReason: { unified: "stop", raw: "empty-response-explained" },
          };
          return explained;
        }
        if (step.action === "fallback" && fallback) {
          activeId = fallback.id;
          fallbackUsed = true;
          result = (await fallback.model.doGenerate(params)) as GenerateResult;
        } else {
          // `model.doGenerate` rather than `doGenerate()`, because the latter
          // can only reissue the IDENTICAL request — and identical is what
          // already failed. This middleware is the innermost one, so calling the
          // model directly skips nothing.
          result = (await model.doGenerate(buildNudgedParams(params))) as GenerateResult;
        }
      }
    },

    async wrapStream({ doStream, params, model }) {
      const first = await doStream();
      const sink = new TransformStream<StreamPart, StreamPart>();
      const writer = sink.writable.getWriter();

      /**
       * Forward one attempt's parts as they arrive, holding back only `finish`.
       *
       * The point of holding `finish` is that a consumer treats it as the end of
       * the response; releasing it before we know whether this attempt said
       * anything would end the turn on the empty answer we are trying to
       * replace. Everything else — including reasoning deltas — goes straight
       * out, because burying a streaming chat behind a buffer to make this
       * middleware simpler would trade the defect for a worse one.
       */
      async function pump(
        stream: StreamResult["stream"],
        suppressStart: boolean,
      ): Promise<{ outcome: ModelCallOutcome; finish: StreamPart | null; sawError: boolean }> {
        const watcher = createStreamWatcher();
        const reader = stream.getReader();
        let finish: StreamPart | null = null;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            watcher.observe(value);
            const type = (value as { type?: string })?.type;
            if (type === "finish") {
              finish = value;
              continue;
            }
            // A second `stream-start` mid-response announces warnings for a call
            // the consumer already thinks it is inside; the first one stands.
            if (suppressStart && type === "stream-start") continue;
            await writer.write(value);
          }
        } finally {
          // A reader left locked on a cancelled turn keeps the provider
          // connection open for the life of the process; eve cancels streams
          // routinely (the Stop button, an abort signal on every turn).
          reader.releaseLock();
        }
        return { outcome: watcher.outcome(), finish, sawError: watcher.sawError };
      }

      void (async () => {
        let attempt = 0;
        let activeId = deps.modelId();
        let fallbackUsed = false;
        let stream = first.stream;
        let suppressStart = false;
        try {
          for (;;) {
            const { outcome, finish, sawError } = await pump(stream, suppressStart);
            attempt++;
            if (!outcome.empty || sawError) {
              if (finish) await writer.write(finish);
              return;
            }
            const shape = describeModelCall(params);
            const fallback = deps.fallback();
            const step = planRecovery({ attempt, shape, fallbackAvailable: fallback !== null, fallbackUsed });
            record({ shape, outcome, attempt, modelId: activeId, path: "stream", step });
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
            if (step.action === "fallback" && fallback) {
              activeId = fallback.id;
              fallbackUsed = true;
              stream = ((await fallback.model.doStream(params)) as StreamResult).stream;
            } else {
              // See the generate path: a nudged reissue, not an identical one.
              stream = ((await model.doStream(buildNudgedParams(params))) as StreamResult).stream;
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
