/**
 * EVERY MODEL CALL CARRIES AN OUTPUT BUDGET, CHOSEN FOR THE ROLE THAT MAKES IT.
 *
 * THE DEFECT, measured on the live deployment on 2026-09-23. `read_image` was
 * asked to read a scanned pdf page. The row PR #51's telemetry wrote:
 *
 *     Model returned an empty response · attempt 1 ·
 *     model=@cf/moonshotai/kimi-k2.6  path=generate
 *     finish=length  finish_raw=length  in=2999  out=1500  out_thinking=1500
 *
 * `finish=length` with completion tokens == reasoning tokens == 1500: the model
 * spent its ENTIRE output allowance thinking and emitted no answer and no tool
 * call. eve reports that as MODEL_CALL_FAILED "Empty model response"; before #51
 * the turn simply died. That is the fault the operator hit all day.
 *
 * WHERE THE 1500 CAME FROM — and this is the correction to the working theory.
 * It was not a provider default. `agent/lib/vision-tools.ts` set it itself:
 *
 *     const MAX_OUTPUT_TOKENS = 1_500;   // "A page description, not a report."
 *
 * — added with the vision TOOL in #50, and sized for the ANSWER. On a reasoning
 * model the budget pays for the THINKING FIRST, so a number sized for the answer
 * alone is a number the answer never reaches. `path=generate` on the row names
 * that call exactly: the chat streams (`path=stream`), only `read_image`
 * generates. #51's wire proof ("nothing sets `max_tokens`") was made by driving
 * `streamText` through `agentModel` — the CHAT path, which really does send
 * none, and which never touches this constant. Both measurements were right;
 * the conclusion drawn across them was not.
 *
 * WHAT WAS PROBED DIRECTLY against Cloudflare with the deployment's credentials:
 *   - the same model answers a simple question fine with NO cap (93–120
 *     completion tokens) — the model is not broken;
 *   - `max_tokens: 256` reproduces the failure exactly: `finish=length`, empty
 *     content, 256 completion tokens, all of them reasoning;
 *   - `max_tokens: 8192` and `16384` are accepted and answer normally.
 * Switching models is not an option on this account:
 * `@cf/meta/llama-3.2-11b-vision-instruct` is 403 (not entitled),
 * `@cf/llava-hf/llava-1.5-7b-hf` 400, `@cf/unum/uform-gen2-qwen-500m` 410
 * (retired). So the budget is the lever.
 *
 * THE TWO HALVES OF THE FIX.
 *   1. An EXPLICIT budget per role, here, instead of one hardcoded number in one
 *      tool and nothing anywhere else. The chat path sending no cap at all is not
 *      safe either — it leaves the ceiling to whatever the provider decides
 *      today, which is precisely the thing that cannot be diagnosed from a row.
 *   2. It is applied as MIDDLEWARE (`createOutputBudget`), so it lands on the
 *      call options the provider is handed — `maxOutputTokens`, which the
 *      openai-compatible provider writes out as `max_tokens` — for every caller,
 *      including eve's own `streamText`, which this repo never gets to touch.
 *      scripts/test-model-output-budget.mjs asserts on the REQUEST BODIES the
 *      scripted provider received, not on this source: a budget that does not
 *      reach the wire is not a budget.
 *
 * WHY A CEILING AT ALL, when "no cap" made the chat work. A per-call ceiling is
 * the only bound on a reasoning model that will not stop thinking, and the only
 * thing that makes `cap=` on an empty-response row mean something. Uncapped, the
 * next occurrence of this failure is undiagnosable in exactly the same way.
 */
import type { LanguageModelMiddleware } from "ai";
// Type-only, and therefore erased: model.ts imports `createOutputBudget` from
// here at run time, so a value import back would be a genuine cycle.
import type { AgentRole } from "./model.ts";

/**
 * THE NUMBERS, AND WHAT EACH ONE TRADES.
 *
 * None of these is the maximum. A ceiling near the model's window (262,144 on
 * Kimi K2.6, 1,310,720 on GLM 5.3) is indistinguishable from no ceiling: it
 * bounds nothing, and a call that really ran to it would hit the platform's
 * request timeout long before the provider stopped — a ceiling the call cannot
 * reach is not a ceiling. Nothing here is billed unless it is generated; what a
 * bigger number really buys is a worse worst case (a runaway thinking loop) and
 * a longer wait before it ends.
 */
export const DEFAULT_OUTPUT_BUDGET_TOKENS: Readonly<Record<AgentRole, number>> = {
  /**
   * 8,192 — the orchestrator talks to the person.
   *
   * Most of its calls end in a TOOL CALL, not prose: measured on the failing
   * workflow, one turn made three bash calls, i.e. four orchestrator calls, and
   * a simple answer probed at 93–120 completion tokens. So the budget is not
   * sized for the text — it is sized for the thinking that has to happen before
   * the text, with room left for a full chat reply after it. 8,192 is a probed-
   * accepted value and five times the 1,500 that failed.
   *
   * TRADED: this is the role that makes the most calls per turn, so it is where
   * a generous ceiling costs the most if a model loops; and nothing this role
   * writes into a chat bubble is 16k tokens long. That is why it is the smallest
   * of the three rather than matched to the specialist.
   */
  orchestrator: 8_192,
  /**
   * 16,384 — the specialist's OUTPUT is the deliverable.
   *
   * Delegated, text-heavy work: a memo, a table lifted out of a filing, an
   * extraction that is read as a document rather than as a chat reply. It runs
   * on GLM 5.3 (1.31M window) and is called once per delegation rather than once
   * per tool step, so the ceiling is paid rarely.
   *
   * TRADED: truncating one of these costs the WHOLE delegation — the work is
   * re-run, not resumed — which is why it is twice the orchestrator's despite
   * 16,384 also being the largest value probed as accepted.
   */
  specialist: 16_384,
  /**
   * 16,384 — the role that actually failed, and the densest single answer.
   *
   * The live row is `out=1500 out_thinking=1500`: the whole budget went on
   * thinking about ONE scanned page and nothing came back. And `read_image`
   * renders up to MAX_PAGES_PER_CALL = 4 pages into one call, so the answer
   * alone can be four page descriptions of the ~1,500 tokens each that constant
   * was sized for — before any of the thinking that produced them is paid for.
   * 16,384 is the largest value probed as accepted on this account, and 6% of
   * Kimi K2.6's 262,144 window.
   *
   * TRADED: not larger, because `read_image` gives the call 120 s
   * (VISION_TIMEOUT_MS) and then abandons it; a budget the call cannot spend
   * inside its own deadline turns a truncated answer into no answer at all.
   */
  vision: 16_384,
};

/**
 * One variable per role. UNPREFIXED, unlike CLOUDFLARE_MODEL_* and
 * CLOUDFLARE_CONTEXT_WINDOW_*, and deliberately: a model id and a context window
 * are facts ABOUT A PROVIDER'S MODEL, while an output budget is a fact about the
 * ROLE'S JOB — how much a page description or a chat reply needs — and the same
 * three numbers are right whichever provider serves them. `MODEL_` is the prefix
 * the one provider-agnostic variable in this area already uses (MODEL_PROVIDER).
 */
export const OUTPUT_BUDGET_ENV: Readonly<Record<AgentRole, string>> = {
  orchestrator: "MODEL_MAX_OUTPUT_TOKENS_ORCHESTRATOR",
  specialist: "MODEL_MAX_OUTPUT_TOKENS_SPECIALIST",
  vision: "MODEL_MAX_OUTPUT_TOKENS_VISION",
};

/**
 * The ceiling on anything this file will ever put on a request — an override and
 * the retry's raise alike.
 *
 * 65,536 is 8x the orchestrator's default and 4x the other two: far past any
 * answer this product produces, and still two orders of magnitude inside the
 * smallest window in use. It exists so that a typo in a Vercel variable
 * (`163840`) or a doubling ladder cannot put a ceiling on the wire that the
 * platform's own request timeout would reach first — which fails as a hung turn
 * rather than as a truncated one.
 */
export const MAX_OUTPUT_BUDGET_TOKENS = 65_536;

/** Words that mean "send no budget at all", the way CLOUDFLARE_MODEL_VISION spells "off". */
const OFF_VALUES = new Set(["off", "none", "false", "disabled", "0"]);

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The budget in force for a role, or undefined for "send nothing and let the
 * provider decide" — which is what the chat path did until today, and the state
 * the live failure was diagnosed out of.
 *
 * THE VALUE GRAMMAR, and why each case is what it is:
 *   unset          → the default above.
 *   EMPTY STRING   → the default above, NOT "off". #46/#47: a Vercel variable
 *                    marked Sensitive pulls down as an empty string, and an
 *                    empty string must never silently change behaviour. Removal
 *                    has to be typed, not fallen into. Same rule, same reason, as
 *                    `visionModelConfigured` in model.ts.
 *   off/none/false/
 *   disabled/0     → no budget on the request. The escape hatch for a provider
 *                    that rejects `max_tokens`, and the way to reproduce the
 *                    pre-fix behaviour without a deploy.
 *   a positive int → that, clamped to MAX_OUTPUT_BUDGET_TOKENS.
 *   anything else  → the default, said out loud. A silently ignored override is
 *                    how the fleet once ran on the wrong provider for a day.
 *
 * Trimmed before matching: `echo | vercel env add` leaves a trailing newline, and
 * "8192\n" parsing as NaN would read as "anything else".
 */
export function resolveOutputBudget(role: AgentRole, env: EnvLike): number | undefined {
  const raw = env[OUTPUT_BUDGET_ENV[role]];
  if (raw === undefined) return DEFAULT_OUTPUT_BUDGET_TOKENS[role];
  const value = raw.trim();
  if (value === "") return DEFAULT_OUTPUT_BUDGET_TOKENS[role];
  if (OFF_VALUES.has(value.toLowerCase())) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[model] ${OUTPUT_BUDGET_ENV[role]}="${value}" is not a positive whole number of tokens — using ${DEFAULT_OUTPUT_BUDGET_TOKENS[role]}`,
    );
    return DEFAULT_OUTPUT_BUDGET_TOKENS[role];
  }
  return Math.min(parsed, MAX_OUTPUT_BUDGET_TOKENS);
}

export interface OutputBudgetDeps {
  /** Read per call, not per process: a test sets the variable after this module loads. */
  budget(): number | undefined;
}

/**
 * Put the role's budget on every call that does not already carry one.
 *
 * `transformParams`, not a wrapper, because the budget has to be on the params
 * the provider is handed — and it has to be there before the empty-response
 * recovery reads them, or that middleware's `cap=` field goes on reporting
 * `cap=none` while a budget is in force. Hence the ORDER in `agentModel`: this
 * sits OUTSIDE `createEmptyResponseRecovery`, so its transform has already run by
 * the time the recovery sees a call.
 *
 * `??`, NOT an override. A caller that named its own number meant it — the two
 * small `generateText` calls in the web app ask for 220 and 1,200 tokens for a
 * one-line summary, and silently making those 8k would spend somebody's money on
 * a paragraph nobody reads. What this fills in is the case there is no call site
 * to edit at all: eve's own `streamText` for the chat.
 */
export function createOutputBudget(deps: OutputBudgetDeps): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    async transformParams({ params }) {
      if (typeof params.maxOutputTokens === "number") return params;
      const budget = deps.budget();
      if (budget === undefined) return params;
      return { ...params, maxOutputTokens: budget };
    },
  };
}
