/**
 * Central model selector — every agent (root + subagents) gets its model from
 * here, so we can switch the whole fleet with one env var.
 *
 * Providers:
 *   - "cloudflare": GLM 5.2 via Cloudflare Workers AI. OpenAI-compatible endpoint
 *     (`.../ai/v1/chat/completions`). GLM 5.2 is a thinking model — it streams
 *     `reasoning_content`, surfaced as reasoning parts. THIS IS THE ONLY
 *     auto-selected provider.
 *   - "gateway": Claude via the Vercel AI Gateway, tiered by role. Explicit
 *     opt-in ONLY (MODEL_PROVIDER=gateway) — never auto-selected, because
 *     silently falling through to a paid provider is exactly the bug that once
 *     ran the whole fleet on the wrong model.
 *
 * OpenCode Zen has been removed — Cloudflare is the sole inference provider.
 *
 * Env:
 *   MODEL_PROVIDER          "cloudflare" | "gateway"   (default: cloudflare)
 *   CLOUDFLARE_ACCOUNT_ID   your Cloudflare account id
 *   CLOUDFLARE_API_TOKEN    a Workers AI API token (Account > AI > Workers AI read/run)
 *   CLOUDFLARE_MODEL        default "@cf/zai-org/glm-5.2" (the whole fleet, unless a role is set below)
 *   CLOUDFLARE_MODEL_ORCHESTRATOR / CLOUDFLARE_MODEL_SPECIALIST   optional per-role models
 *   CLOUDFLARE_MODEL_VISION default "@cf/zai-org/glm-5.3-flash" — the VLM behind the `read_image`
 *                           TOOL, called once per image instead of on every turn. "off"/"none"/
 *                           "false" removes the tool entirely (see visionModelConfigured).
 *   MODEL_REASONING_VISION  default "low" — the reasoning effort `read_image` asks the vision model
 *                           for (minimal|low|medium|high|xhigh; "off"/"none" sends none). Sent only
 *                           to a model on RECOVERY_REASONING_MODELS (see visionReasoning).
 *   CLOUDFLARE_BASE_URL     default "https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1"
 *   CLOUDFLARE_CONTEXT_WINDOW default 262144   (GLM 5.2 on Workers AI)
 *   MODEL_MAX_OUTPUT_TOKENS_ORCHESTRATOR / _SPECIALIST / _VISION
 *                           the per-call OUTPUT budget, per role (8192 / 16384 / 16384).
 *                           Unprefixed because a budget is a property of the ROLE'S JOB, not of
 *                           a provider's model — see agent/lib/model-output-budget.ts, which
 *                           holds the measurement every default is chosen from.
 */
import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { createEmptyResponseRecovery, type ModelLike } from "./empty-model-response.ts";
import { publishEmptyResponse } from "./empty-model-response-log.ts";
import { createOutputBudget, resolveOutputBudget } from "./model-output-budget.ts";
import { uniqueToolCallIds } from "./unique-tool-call-ids.ts";
import type { LanguageModel } from "ai";

/**
 * The three jobs a model is picked for.
 *
 * `vision` is not an agent — it is the model behind ONE TOOL (`read_image`).
 * The orchestrator used to have to BE a vision model, because the chat sends an
 * upload as a file part and a text-only model answers "I cannot see the image".
 * That made image understanding a property of the fleet: every turn, on every
 * thread, paid for on a model chosen for its eyes rather than its reasoning —
 * and when `@cf/moonshotai/kimi-k2.6` started returning MODEL_CALL_FAILED
 * ("Empty model response") on real uploads there was nothing to move to without
 * losing images. Splitting the role means the orchestrator is chosen for
 * reasoning and reliability, and a VLM runs only when there is an image.
 */
export type AgentRole = "orchestrator" | "specialist" | "vision";

// Trim EVERYTHING that comes from env: values added via `echo | vercel env add`
// carry a trailing newline, and "cloudflare\n" matching no branch silently fell
// through to the gateway — the whole fleet ran (and billed) the wrong provider.
const envTrim = (v: string | undefined) => v?.trim() || undefined;

const cfAccount = envTrim(process.env.CLOUDFLARE_ACCOUNT_ID);
const cfToken = envTrim(process.env.CLOUDFLARE_API_TOKEN);
const cfConfigured = Boolean(cfAccount && cfToken);

const rawChoice = envTrim(process.env.MODEL_PROVIDER)?.toLowerCase();
const providerChoice = (() => {
  if (rawChoice === "cloudflare" || rawChoice === "gateway") return rawChoice;
  if (rawChoice) {
    // An unknown value must NOT silently pick another provider.
    console.warn(`[model] MODEL_PROVIDER="${rawChoice}" is not cloudflare|gateway — using "cloudflare"`);
  }
  return "cloudflare" as const;
})();

// Constructed unconditionally: `agentModel()` runs at MODULE LOAD (the agent
// definition calls it), so throwing here would make the build itself require
// runtime credentials — which is exactly what broke once Zen was removed. The
// deployed env supplies the real values; a local build without them still
// bundles fine and only a real call would fail, with the warning below to
// explain why.
if (!cfConfigured) {
  console.warn(
    "[model] CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set — Workers AI calls will fail at request time. Harmless during a build; set them in .env.local to run locally.",
  );
}
const cloudflare = createOpenAICompatible({
  name: "cloudflare-workers-ai",
  baseURL:
    envTrim(process.env.CLOUDFLARE_BASE_URL) ??
    `https://api.cloudflare.com/client/v4/accounts/${cfAccount ?? "unset"}/ai/v1`,
  apiKey: cfToken ?? "",
});

/**
 * Context window for the active model. eve looks gateway models up automatically,
 * but a custom OpenAI-compatible provider has no gateway metadata, so eve needs
 * the size to know when to compact. Returns undefined in gateway mode (let eve
 * look it up). Override with CLOUDFLARE_CONTEXT_WINDOW.
 */
export function modelContextWindowTokens(role: AgentRole = "orchestrator"): number | undefined {
  if (providerChoice !== "cloudflare") return undefined;
  // Per role, because the two roles may now run different models with very different windows
  // (GLM 5.3 and GLM 5.3 Flash are 1.31M, Kimi K2.6 is 262k). An explicit override wins; then the known window of the role's
  // model; then the conservative 262,144 every Workers AI model this app has used supports.
  const override =
    envTrim(process.env[`CLOUDFLARE_CONTEXT_WINDOW_${role.toUpperCase()}`]) ?? envTrim(process.env.CLOUDFLARE_CONTEXT_WINDOW);
  if (override && Number.isFinite(Number(override)) && Number(override) > 0) return Number(override);
  return CLOUDFLARE_CONTEXT_WINDOWS[agentModelId(role)] ?? 262_144;
}

/**
 * The per-call OUTPUT budget for a role, in tokens, or undefined for "send none".
 *
 * Same shape as `modelContextWindowTokens` above — a per-role number with an env
 * override — and deliberately NOT the same thing. The context window is how much
 * the model can READ; this is how much it may WRITE on one call, and on a
 * reasoning model the writing budget pays for the thinking first. On 2026-09-23
 * the vision call ran on 1,500 and spent all 1,500 of it thinking
 * (`finish=length  out=1500  out_thinking=1500`), delivering nothing.
 *
 * Applies on EVERY provider, unlike the window: `agentModel` installs it as
 * middleware only in cloudflare mode (gateway mode hands the AI SDK a plain id
 * with nowhere to hang middleware), so `agent/lib/vision-tools.ts` — the one call
 * site in this repo that sets its own — reads it from here directly and is
 * therefore budgeted on both.
 *
 * The values and what each trades: agent/lib/model-output-budget.ts.
 */
export function modelOutputBudgetTokens(role: AgentRole = "orchestrator"): number | undefined {
  return resolveOutputBudget(role, process.env);
}

/** Context windows of the Workers AI models this app is run on (Cloudflare model catalogue, 2026-09-19). */
const CLOUDFLARE_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "@cf/zai-org/glm-5.2": 262_144,
  "@cf/zai-org/glm-5.3": 1_310_720,
  "@cf/zai-org/glm-5.3-flash": 1_310_720,
  "@cf/moonshotai/kimi-k2.6": 262_144,
};

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Provider-agnostic reasoning effort forwarded to the model call. This is what
 * makes Claude stream extended-thinking (reasoning) tokens — without it the
 * gateway Claude models run with thinking OFF and emit no reasoning at all,
 * which is the "model supports it but nothing streams" symptom.
 *
 * On the gateway (Claude) it defaults to "medium"; tune or disable with
 * GATEWAY_REASONING_EFFORT ("none"/"off" turns it off).
 *
 * On Workers AI it is UNSET unless CLOUDFLARE_REASONING_EFFORT names a level,
 * so the default deployment's requests are unchanged. The knob exists because
 * the provider DOES take it, contrary to what this comment used to say about
 * GLM 5.2. Measured on 2026-09-24 against `@cf/zai-org/glm-5.3` (three runs
 * each, same planning prompt, `max_tokens` 4096): unset ≈ 380–570 completion
 * tokens with 1.4–2.3 k characters of reasoning; `reasoning_effort: "low"` ≈
 * 70–120 tokens and under 200 characters; "medium" ≈ unset; "none" is ignored.
 * `@cf/moonshotai/kimi-k2.6` accepts the field and is unaffected by it. The
 * orchestrator's runaway first step on onfinance_hfc (8,192 tokens of reasoning
 * and no answer) is what a deployment on GLM 5.3 would set this to "low" for —
 * after checking its answers hold up, which is a per-deployment judgement.
 * The empty-response ladder lowers it on its own retry regardless
 * (agent/lib/empty-model-response.ts, `raisedRecoveryReasoning`).
 */
export function agentReasoning(): ReasoningEffort | undefined {
  if (providerChoice !== "gateway") {
    const c = process.env.CLOUDFLARE_REASONING_EFFORT?.trim().toLowerCase();
    return c === "minimal" || c === "low" || c === "medium" || c === "high" || c === "xhigh" ? c : undefined;
  }
  const v = process.env.GATEWAY_REASONING_EFFORT?.trim().toLowerCase();
  if (v === "none" || v === "off") return undefined;
  if (v === "minimal" || v === "low" || v === "medium" || v === "high" || v === "xhigh") return v;
  return "medium";
}

/**
 * The reasoning effort `read_image` asks the vision model for, or undefined for
 * "send none". MODEL_REASONING_VISION, default "low".
 *
 * Unprefixed like MODEL_MAX_OUTPUT_TOKENS_VISION: it is a property of the role's
 * job (read a page, quote what is printed), not of a provider. EMPTY means unset,
 * i.e. the default — a Vercel Sensitive variable pulls down as an empty string and
 * must not change behaviour. "off"/"none"/"false"/"disabled" sends no field.
 * Anything unrecognised falls back to the default rather than to "none", loudly.
 *
 * This is the level ASKED FOR; whether it reaches the wire is the caller's
 * decision per model (agent/lib/vision-tools.ts sends it only to a model on
 * RECOVERY_REASONING_MODELS, and drops it if the provider refuses the field).
 */
export const DEFAULT_VISION_REASONING: ReasoningEffort = "low";
export function visionReasoning(): ReasoningEffort | undefined {
  const v = process.env.MODEL_REASONING_VISION?.trim().toLowerCase();
  if (!v) return DEFAULT_VISION_REASONING;
  if (v === "off" || v === "none" || v === "false" || v === "disabled") return undefined;
  if (v === "minimal" || v === "low" || v === "medium" || v === "high" || v === "xhigh") return v;
  console.warn(`[model] MODEL_REASONING_VISION="${v}" is not minimal|low|medium|high|xhigh|off — using "${DEFAULT_VISION_REASONING}"`);
  return DEFAULT_VISION_REASONING;
}

/**
 * The model ID a role runs on, as a plain string — what a usage row records so
 * the read side can price it later (`lib/inference-pricing.ts`). Kept beside
 * `agentModel` so the two can never name different models.
 */
/**
 * The Workers AI vision model `read_image` uses when nothing names one.
 *
 * GLM 5.3 Flash (operator decision, 2026-09-25): it reads images, it takes a
 * reasoning level (low/high/max, default max), and it costs $0.15/M in and
 * $0.50/M out against Kimi K2.6's $0.95/$4. It is sent reasoning "low" by
 * default (see `visionReasoning`): a page description is transcription, not
 * deliberation, and at the provider's default of max the output budget is spent
 * thinking first — the exact `finish=length out_thinking=1500` failure recorded
 * in agent/lib/vision-tools.ts. It needs Workers Paid, which an account running
 * `@cf/zai-org/glm-5.3` already has. CLOUDFLARE_MODEL_VISION still overrides it.
 */
export const DEFAULT_VISION_MODEL = "@cf/zai-org/glm-5.3-flash";
/** Gateway-mode default: Sonnet reads images and is allowed on the free tier (Opus is not). */
const DEFAULT_GATEWAY_VISION_MODEL = "anthropic/claude-sonnet-5";

/** The variable that names the vision model, per provider. */
const visionModelVar = () =>
  providerChoice === "cloudflare" ? "CLOUDFLARE_MODEL_VISION" : "GATEWAY_MODEL_VISION";

/**
 * Is there a vision model for this deployment at all?
 *
 * A deployment on an account with no vision model must not ship a `read_image`
 * that is present and fails — the model would keep calling it, burn a turn per
 * attempt and report a capability the deployment does not have. Naming the
 * variable "off"/"none"/"false" makes `agent/tools/read_image.ts` export
 * `disableTool()` instead, and eve's own docs are explicit that then "the model
 * never sees it". Same shape as ENABLE_WEB_SEARCH / ENABLE_BROWSER.
 *
 * UNSET and EMPTY both mean "use the default". Empty is deliberate: a Vercel
 * variable marked Sensitive pulls down as an empty string, and an empty string
 * silently deleting a capability is the trap already documented in .env.example
 * for the provider choice. Removal has to be typed, not fallen into.
 */
export function visionModelConfigured(): boolean {
  const raw = process.env[visionModelVar()];
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  return !(value === "off" || value === "none" || value === "false" || value === "disabled");
}

export function agentModelId(role: AgentRole): string {
  if (role === "vision") {
    // NOT chained to CLOUDFLARE_MODEL / GATEWAY_MODEL_*. The fleet variable names the
    // TEXT-ONLY model (GLM 5.3 today), and a text-only model handed an image does not
    // error — it answers "I cannot see the image", which reaches the analyst as a wrong
    // answer rather than as a missing capability. An explicit vision name or the default,
    // nothing in between.
    return providerChoice === "cloudflare"
      ? (envTrim(process.env.CLOUDFLARE_MODEL_VISION) ?? DEFAULT_VISION_MODEL)
      : (envTrim(process.env.GATEWAY_MODEL_VISION) ?? DEFAULT_GATEWAY_VISION_MODEL);
  }
  if (providerChoice === "cloudflare") {
    // Tiered by role, like the gateway. CLOUDFLARE_MODEL_ORCHESTRATOR is the model that talks to the person;
    // it no longer has to be a vision model, because images go to CLOUDFLARE_MODEL_VISION through the
    // `read_image` tool. CLOUDFLARE_MODEL_SPECIALIST
    // runs the delegated, text-heavy work. Either falls back to CLOUDFLARE_MODEL (one model for the whole
    // fleet, the previous behaviour), then to GLM 5.2. All are thinking models (they stream
    // `reasoning_content`, which is what surfaces as reasoning parts).
    return (
      envTrim(process.env[role === "orchestrator" ? "CLOUDFLARE_MODEL_ORCHESTRATOR" : "CLOUDFLARE_MODEL_SPECIALIST"]) ??
      envTrim(process.env.CLOUDFLARE_MODEL) ??
      "@cf/zai-org/glm-5.2"
    );
  }
  // Vercel AI Gateway (Claude), tiered by role. NOTE: Opus is blocked on the
  // gateway's FREE tier (403 "Free tier users do not have access to this model"),
  // while Sonnet 5 and Haiku 4.5 are allowed. So the defaults are free-tier-safe.
  // Once paid AI Gateway credits are added, bump the orchestrator back to Opus
  // with `GATEWAY_MODEL_ORCHESTRATOR=anthropic/claude-opus-4.8` — no code change.
  const orchestrator = process.env.GATEWAY_MODEL_ORCHESTRATOR ?? "anthropic/claude-sonnet-5";
  const specialist = process.env.GATEWAY_MODEL_SPECIALIST ?? "anthropic/claude-sonnet-5";
  return role === "orchestrator" ? orchestrator : specialist;
}

/**
 * The model a role falls back to when its own answers come back EMPTY, or null
 * when there is nothing to fall back to.
 *
 * On this deployment the two roles are different models on purpose: the
 * orchestrator must SEE images, the specialist (`@cf/zai-org/glm-5.3`, text-only,
 * a 1.31M window against Kimi's 262k) does the text-heavy work. That makes the
 * other role a genuinely independent second opinion for a model that has stopped
 * answering — which is the only thing that reliably fixes a failure that
 * reproduced on every attempt at the same depth in two separate sessions.
 *
 * Null when the two roles resolve to the SAME model id: reissuing an identical
 * call against an identical model and calling it a fallback would burn a paid
 * call to change nothing, and would put `next=fallback` on a row where nothing
 * was actually tried. What falling back COSTS — the specialist cannot see images
 * — is decided per call, not here: `planRecovery` refuses to fall back when the
 * request carries an image part.
 */
function fallbackFor(role: AgentRole): { id: string; model: ModelLike } | null {
  if (providerChoice !== "cloudflare") return null;
  // THE VISION ROLE HAS NO HONEST FALLBACK, and the ternary below would have given
  // it the worst possible one. It reads "the OTHER role's model", but it is written
  // as `orchestrator ? specialist : orchestrator` — so a third role resolves to the
  // ORCHESTRATOR, which on this deployment is the text-only GLM 5.3. Falling a
  // vision call back to a text-only model is the exact "confident wrong answer"
  // planRecovery's `vision-required` branch exists to prevent. That branch is live
  // and catches it today, so this is latent rather than a defect — but the two are
  // independent guards and only one of them is stated where the choice is made:
  // measured by deleting each in turn, removing only the other leaves the vision
  // call correctly on the vision model, and removing both sends it to GLM. There is
  // no second vision model configured, so there is nothing to fall back to.
  if (role === "vision") return null;
  const other: AgentRole = role === "orchestrator" ? "specialist" : "orchestrator";
  const id = agentModelId(other);
  if (id === agentModelId(role)) return null;
  return { id, model: cloudflare(id) as unknown as ModelLike };
}

export function agentModel(role: AgentRole): LanguageModel {
  const id = agentModelId(role);
  // A gateway id is a plain string the AI SDK resolves itself; Workers AI needs
  // the OpenAI-compatible provider wrapped around it.
  // Workers AI models are wrapped so their tool-call ids are unique (Kimi counts: functions.x:0, :1, … and
  // restarts after a compaction or a new session) — see unique-tool-call-ids.ts.
  //
  // ORDER IS LOAD-BEARING. The SDK wraps the LAST middleware directly around the
  // model, so the empty-response recovery sees the provider's raw answer (and
  // its raw `finishReason`/`usage`, which is what the diagnosis needs) while
  // `uniqueToolCallIds` stays outermost — so a FALLBACK model's counter-style
  // tool-call ids get rewritten exactly like the orchestrator's. Swap them and a
  // fallback turn's delegations start replacing each other in the Control Panel,
  // which is the bug unique-tool-call-ids.ts exists to prevent.
  //
  // THE OUTPUT BUDGET GOES IN THE MIDDLE, and that position is load-bearing too.
  // Its `transformParams` runs on the way DOWN, so by the time the recovery below
  // is entered the call already carries `maxOutputTokens` — which is the field the
  // recovery reports as `cap=` and the field its retry raises. Put it inside the
  // recovery instead and every empty-response row goes on saying `cap=none` while
  // a budget is in force, which is the exact reading that sent the 2026-09-23
  // diagnosis looking for a provider default that did not exist.
  if (providerChoice !== "cloudflare") return id;
  return wrapLanguageModel({
    model: cloudflare(id),
    middleware: [
      uniqueToolCallIds,
      createOutputBudget({ budget: () => modelOutputBudgetTokens(role) }),
      createEmptyResponseRecovery({
        modelId: () => id,
        fallback: () => fallbackFor(role),
        publish: publishEmptyResponse,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        newId: () => randomUUID(),
      }),
    ],
  });
}
