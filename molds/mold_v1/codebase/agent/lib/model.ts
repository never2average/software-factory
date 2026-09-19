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
 *   CLOUDFLARE_MODEL_ORCHESTRATOR / CLOUDFLARE_MODEL_SPECIALIST   optional per-role models; the orchestrator
 *                           must be a vision model for native image input
 *   CLOUDFLARE_BASE_URL     default "https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1"
 *   CLOUDFLARE_CONTEXT_WINDOW default 262144   (GLM 5.2 on Workers AI)
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type AgentRole = "orchestrator" | "specialist";

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
export function agentModelId(role: AgentRole): string {
  if (providerChoice === "cloudflare") {
    // Tiered by role, like the gateway. CLOUDFLARE_MODEL_ORCHESTRATOR is the model that talks to the person —
    // so it is the one that must SEE images if the deployment wants native image input (the chat sends
    // images as file parts; a text-only model answers "I cannot see the image"). CLOUDFLARE_MODEL_SPECIALIST
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

export function agentModel(role: AgentRole): LanguageModel {
  const id = agentModelId(role);
  // A gateway id is a plain string the AI SDK resolves itself; Workers AI needs
  // the OpenAI-compatible provider wrapped around it.
  return providerChoice === "cloudflare" ? cloudflare(id) : id;
}
