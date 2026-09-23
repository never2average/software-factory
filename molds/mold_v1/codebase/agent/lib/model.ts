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
 *   CLOUDFLARE_MODEL_VISION default "@cf/moonshotai/kimi-k2.6" — the VLM behind the `read_image`
 *                           TOOL, called once per image instead of on every turn. "off"/"none"/
 *                           "false" removes the tool entirely (see visionModelConfigured).
 *   CLOUDFLARE_BASE_URL     default "https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1"
 *   CLOUDFLARE_CONTEXT_WINDOW default 262144   (GLM 5.2 on Workers AI)
 */
import { randomUUID } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import { createEmptyResponseRecovery, type ModelLike } from "./empty-model-response.ts";
import { publishEmptyResponse } from "./empty-model-response-log.ts";
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
  // (GLM 5.3 is 1.31M, Kimi K2.6 is 262k). An explicit override wins; then the known window of the role's
  // model; then the conservative 262,144 every Workers AI model this app has used supports.
  const override =
    envTrim(process.env[`CLOUDFLARE_CONTEXT_WINDOW_${role.toUpperCase()}`]) ?? envTrim(process.env.CLOUDFLARE_CONTEXT_WINDOW);
  if (override && Number.isFinite(Number(override)) && Number(override) > 0) return Number(override);
  return CLOUDFLARE_CONTEXT_WINDOWS[agentModelId(role)] ?? 262_144;
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
 * Only meaningful on the gateway (Claude). GLM 5.2 on Workers AI doesn't take
 * this knob — it already thinks by default (streams `reasoning_content`), so we
 * leave it unset there to avoid a provider error. Tune or disable with
 * GATEWAY_REASONING_EFFORT ("none"/"off" turns it off).
 */
export function agentReasoning(): ReasoningEffort | undefined {
  if (providerChoice !== "gateway") return undefined;
  const v = process.env.GATEWAY_REASONING_EFFORT?.trim().toLowerCase();
  if (v === "none" || v === "off") return undefined;
  if (v === "minimal" || v === "low" || v === "medium" || v === "high" || v === "xhigh") return v;
  return "medium";
}

/**
 * The model ID a role runs on, as a plain string — what a usage row records so
 * the read side can price it later (`lib/inference-pricing.ts`). Kept beside
 * `agentModel` so the two can never name different models.
 */
/**
 * The Workers AI vision model `read_image` uses when nothing names one.
 *
 * Kimi K2.6 is the model this account has actually been observed reading images
 * with — it was the orchestrator for exactly that reason. Its failure mode is an
 * EMPTY response on long text-heavy turns, which is survivable as one tool call
 * (the tool reports it and the agent tries something else) and fatal as the
 * orchestrator (the turn dies with nothing delivered).
 */
export const DEFAULT_VISION_MODEL = "@cf/moonshotai/kimi-k2.6";
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
  if (providerChoice !== "cloudflare") return id;
  return wrapLanguageModel({
    model: cloudflare(id),
    middleware: [
      uniqueToolCallIds,
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
