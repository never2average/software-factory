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
 *   CLOUDFLARE_MODEL        default "@cf/zai-org/glm-5.2"
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
export function modelContextWindowTokens(): number | undefined {
  if (providerChoice === "cloudflare") {
    return Number(process.env.CLOUDFLARE_CONTEXT_WINDOW ?? 262_144);
  }
  return undefined;
}

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
    // One model for the whole fleet on Workers AI — GLM 5.2, a thinking model
    // (streams `reasoning_content`, which is what surfaces as reasoning parts).
    return envTrim(process.env.CLOUDFLARE_MODEL) ?? "@cf/zai-org/glm-5.2";
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
