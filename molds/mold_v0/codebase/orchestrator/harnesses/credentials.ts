/**
 * Harness credential mapping (docs/credentials.md).
 *
 * The broker (`POST /api/worker/sessions/:id/credentials`) returns `providers`:
 *   gateway: {mode:"gateway", base_url: "{PUBLIC_URL}/gw/<provider>[/v1]", api_key: "ogw_…"}   (anthropic, openai, google, dashscope)
 *   direct:  {mode:"direct", api_key: "<real key>"}                                            (github_copilot, cursor, amp, factory)
 * Each harness maps them to its own env vars, plus a NON-SECRET setup snippet (config files holding base URLs) that
 * runs right before the CLI. Secrets only ever travel as env values injected at exec time (`env -i`), never in argv,
 * files written by the setup snippet, images or container env.
 *
 * Every base-URL override below was checked against the pinned CLI in its image (orchestrator/images) by a real run
 * through a stand-in gateway that requires the ogw_ token (see README "Credentials").
 */
import type { HarnessAdapter } from "./adapters.js";

export interface ProviderCred { mode: "gateway" | "direct"; base_url?: string | null; api_key: string }
export type Providers = Record<string, ProviderCred>;
export interface HarnessCreds {
  env: Record<string, string>;
  setup: string;
  /** Optional argv rewrite for gateway mode (applied by the session; the adapter's own argv stays unchanged). */
  argv?: (argv: string[]) => string[];
}

interface CredSpec {
  /** Broker provider ids this harness needs. */
  providers: string[];
  /** gateway: base URL override supported (and verified); direct: vendor-hosted, real key brokered. */
  mode: "gateway" | "direct";
  /** How the override works, for docs. */
  how: string;
  map(p: Providers, o: { model: string }): HarnessCreds;
}

export class MissingCredentialsError extends Error {}

function need(p: Providers, id: string): ProviderCred {
  const c = p[id];
  if (!c?.api_key) throw new MissingCredentialsError(`no "${id}" credentials for this session (broker providers: ${Object.keys(p).join(", ") || "none"})`);
  return c;
}
const trim = (u: string) => u.replace(/\/+$/, "");
/** Codex gateway provider id (a copy of the built-in openai provider with WebSockets off; see the codex entry). */
const CODEX_GW_PROVIDER = "octillion_gateway";
/** Append `suffix` unless the URL already ends with it. */
const withSuffix = (u: string, suffix: string) => (trim(u).endsWith(suffix) ? trim(u) : trim(u) + suffix);

/** Shell snippet: write a config file under $HOME once. Content must be non-secret and contain no single quote. */
function writeOnce(relPath: string, content: string): string {
  if (content.includes("'")) throw new Error("config content must not contain single quotes");
  return `f="$HOME/${relPath}"; [ -s "$f" ] || { mkdir -p "$(dirname "$f")" && printf '%s' '${content}' > "$f"; }; `;
}

/** Shell snippet: (re)write a config file under $HOME before every run, for configs that depend on the session's model. */
function writeAlways(relPath: string, content: string): string {
  if (content.includes("'")) throw new Error("config content must not contain single quotes");
  return `f="$HOME/${relPath}"; mkdir -p "$(dirname "$f")" && printf '%s' '${content}' > "$f"; `;
}

const anthropicEnv = (p: Providers) => {
  const c = need(p, "anthropic");
  return { c, env: { ANTHROPIC_API_KEY: c.api_key } as Record<string, string> };
};

export const CRED_SPECS: Record<string, CredSpec> = {
  "claude-code": {
    providers: ["anthropic"], mode: "gateway", how: "ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY (sent as x-api-key)",
    map(p) {
      const { c, env } = anthropicEnv(p);
      if (c.base_url) {
        env.ANTHROPIC_BASE_URL = trim(c.base_url);
        // The gateway's Claude upstream is Vertex, which rejects Claude Code 2.1.296's beta body params
        // ("400 context_management: Extra inputs are not permitted", seen live 2026-10-10). This flag drops them
        // (verified: the request body then has no context_management). Native Anthropic would accept them.
        env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
      }
      return { env, setup: "" };
    },
  },
  codex: {
    providers: ["openai"], mode: "gateway",
    how: "$CODEX_HOME/config.toml `openai_base_url` (<base>/v1) + an OpenAI-mirroring `model_provider` with supports_websockets = false + CODEX_API_KEY. Codex 0.162 IGNORES the OPENAI_BASE_URL env (it called api.openai.com); the built-in openai provider always tries the Responses WebSocket first",
    map(p) {
      const c = need(p, "openai");
      const env: Record<string, string> = { CODEX_API_KEY: c.api_key };
      if (!c.base_url) return { env, setup: "" };
      // Built-in openai provider + openai_base_url keeps codex's model catalog (tools, reasoning) and only moves the host.
      const url = withSuffix(c.base_url, "/v1");
      if (/["\\'%]/.test(url)) throw new Error("unsafe openai base URL");
      // The built-in `openai` provider hard-codes supports_websockets = true and cannot be overridden (reserved id), so
      // codex first tries wss://<gw>/responses, gets the gateway's 426 and logs an ERROR before falling back to HTTP.
      // A custom provider that mirrors the built-in one (name "OpenAI" keeps is_openai(); requires_openai_auth keeps the
      // CODEX_API_KEY auth path) with supports_websockets = false uses plain HTTP from the first request.
      const lines: [string, string][] = [
        ["openai_base_url", `openai_base_url = "${url}"`],
        ["model_provider", `model_provider = "${CODEX_GW_PROVIDER}"`],
        [`model_providers\\.${CODEX_GW_PROVIDER}`, `model_providers.${CODEX_GW_PROVIDER} = { name = "OpenAI", base_url = "${url}", wire_api = "responses", requires_openai_auth = true, supports_websockets = false, supports_standalone_web_search = true }`],
      ];
      // Top-level keys, so each is prepended when missing: the developer environment may already have written MCP tables.
      const f = `"$d/config.toml"`;
      const add = ([key, line]: [string, string]) => `grep -qsE '^${key}[[:space:]]*=' ${f} || { printf '%s\\n' '${line}' | cat - ${f} > ${f}.tmp && mv ${f}.tmp ${f}; }; `;
      return { env, setup: `d="\${CODEX_HOME:-$HOME/.codex}"; mkdir -p "$d"; touch ${f}; ` + lines.reverse().map(add).join("") };
    },
  },
  copilot: {
    providers: ["github_copilot"], mode: "direct", how: "COPILOT_GITHUB_TOKEN (GitHub-hosted models; BYOK COPILOT_PROVIDER_BASE_URL would change the product)",
    map: (p) => ({ env: { COPILOT_GITHUB_TOKEN: need(p, "github_copilot").api_key }, setup: "" }),
  },
  cursor: {
    providers: ["cursor"], mode: "direct", how: "CURSOR_API_KEY (Cursor-hosted backend, no base URL override)",
    map: (p) => ({ env: { CURSOR_API_KEY: need(p, "cursor").api_key }, setup: "" }),
  },
  opencode: {
    providers: ["anthropic"], mode: "gateway",
    how: "OPENCODE_CONFIG_CONTENT provider.anthropic.options.baseURL (<base>/v1) + ANTHROPIC_API_KEY; models `cloudflare/@cf/...` use a custom " +
         "OpenAI-compatible provider (Cloudflare Workers AI) at <gateway>/cloudflare/v1 with the token in CLOUDFLARE_API_TOKEN ({env:} in config)",
    map(p, o) {
      // Open models on Cloudflare Workers AI: OpenCode custom provider "cloudflare" (@ai-sdk/openai-compatible) pointed
      // at the gateway; the config only references the env var, the ogw_ token itself travels in env at exec time.
      if (o.model.startsWith("cloudflare/")) {
        const c = need(p, "cloudflare");
        const modelId = o.model.slice("cloudflare/".length);
        if (!c.base_url) return { env: { CLOUDFLARE_API_TOKEN: c.api_key }, setup: "" };
        const config = {
          provider: {
            cloudflare: {
              npm: "@ai-sdk/openai-compatible", name: "Cloudflare Workers AI",
              options: { baseURL: withSuffix(c.base_url, "/v1"), apiKey: "{env:CLOUDFLARE_API_TOKEN}" },
              models: { [modelId]: { name: modelId, tool_call: true } },
            },
          },
        };
        return { env: { CLOUDFLARE_API_TOKEN: c.api_key, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, setup: "" };
      }
      const { c, env } = anthropicEnv(p);
      if (c.base_url) env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { anthropic: { options: { baseURL: withSuffix(c.base_url, "/v1") } } } });
      return { env, setup: "" };
    },
  },
  kilo: {
    providers: ["anthropic"], mode: "gateway", how: "KILO_CONFIG_CONTENT provider.anthropic.options.baseURL (<base>/v1) + ANTHROPIC_API_KEY",
    map(p) {
      const { c, env } = anthropicEnv(p);
      if (c.base_url) env.KILO_CONFIG_CONTENT = JSON.stringify({ provider: { anthropic: { options: { baseURL: withSuffix(c.base_url, "/v1") } } } });
      return { env, setup: "" };
    },
  },
  "gemini-cli": {
    providers: ["google"], mode: "gateway", how: "GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY (x-goog-api-key); ~/.gemini/settings.json security.auth.selectedType=gemini-api-key",
    map(p) {
      const c = need(p, "google");
      const env: Record<string, string> = { GEMINI_API_KEY: c.api_key };
      if (!c.base_url) return { env, setup: "" };
      env.GOOGLE_GEMINI_BASE_URL = trim(c.base_url);
      return { env, setup: writeOnce(".gemini/settings.json", '{"security":{"auth":{"selectedType":"gemini-api-key"}}}') };
    },
  },
  antigravity: {
    providers: ["google"], mode: "gateway",
    how: "GOOGLE_GEMINI_BASE_URL + GEMINI_API_KEY (modelProvider gemini, set by the adapter). `--model` takes agy's display names " +
         "(\"Gemini 3.1 Pro (High)\"); an API model id (gemini-4-argon) that is not in the CLI's built-in list yet is passed as a " +
         "custom model URL, gemini-api://<gateway>/v1beta/models/<id>",
    map(p, o) {
      const c = need(p, "google");
      const env: Record<string, string> = { GEMINI_API_KEY: c.api_key };
      if (!c.base_url) return { env, setup: "" };
      env.GOOGLE_GEMINI_BASE_URL = trim(c.base_url);
      // agy 1.3.4: "model name does not look like a custom model URL. Expected format: gemini-api://<base_url>/models/<model_name>".
      const custom = /^gemini-[a-z0-9.-]+$/.test(o.model)
        ? `gemini-api://${trim(c.base_url).replace(/^https?:\/\//, "")}/v1beta/models/${o.model}` : null;
      return { env, setup: "", ...(custom ? { argv: (a: string[]) => a.map((x, i) => (a[i - 1] === "--model" ? custom : x)) } : {}) };
    },
  },
  "qwen-code": {
    providers: ["dashscope"], mode: "gateway", how: "OPENAI_BASE_URL (<base>/compatible-mode/v1) + OPENAI_API_KEY, --auth-type openai",
    map(p) {
      const c = need(p, "dashscope");
      const base = c.base_url ? (/\/v1$/.test(trim(c.base_url)) ? trim(c.base_url) : trim(c.base_url) + "/compatible-mode/v1")
        : "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
      return { env: { OPENAI_API_KEY: c.api_key, OPENAI_BASE_URL: base }, setup: "" };
    },
  },
  pi: {
    providers: ["anthropic"], mode: "gateway",
    how: "~/.pi/agent/models.json (rewritten per session): anthropic baseUrl + compat flags off (Vertex rejects pi's first-party-only " +
         "features) + ANTHROPIC_API_KEY; `openai/...` models: built-in openai provider baseUrl (<base>/v1) + OPENAI_API_KEY; " +
         "`cloudflare/@cf/...` models: custom openai-completions provider at <gateway>/cloudflare/v1, key from $CLOUDFLARE_API_TOKEN",
    map(p, o) {
      if (o.model.startsWith("openai/")) {
        const c = need(p, "openai");
        const cfg = c.base_url ? { providers: { openai: { baseUrl: withSuffix(c.base_url, "/v1") } } } : null;
        return { env: { OPENAI_API_KEY: c.api_key }, setup: cfg ? writeAlways(".pi/agent/models.json", JSON.stringify(cfg)) : "" };
      }
      if (o.model.startsWith("cloudflare/")) {
        // Not pi's built-in cloudflare-workers-ai provider: that one builds account-scoped URLs. A plain
        // OpenAI-compatible provider at the gateway (as OpenCode does); models.json only references the env var.
        const c = need(p, "cloudflare");
        if (!c.base_url) throw new MissingCredentialsError("pi on Cloudflare Workers AI needs the gateway (no direct mode)");
        const cfg = { providers: { cloudflare: {
          baseUrl: withSuffix(c.base_url, "/v1"), api: "openai-completions", apiKey: "$CLOUDFLARE_API_TOKEN",
          models: [{ id: o.model.slice("cloudflare/".length) }],
        } } };
        return { env: { CLOUDFLARE_API_TOKEN: c.api_key }, setup: writeAlways(".pi/agent/models.json", JSON.stringify(cfg)) };
      }
      const { c, env } = anthropicEnv(p);
      if (!c.base_url) return { env, setup: "" };
      // The gateway's Claude upstream is Vertex, which rejects pi's first-party-only Anthropic features (per-message
      // effort markers, strict tools, inline-tools beta for mid-conversation tool changes); pi gates them on compat.
      const cfg = { providers: { anthropic: { baseUrl: trim(c.base_url), compat: {
        supportsMidConvoEffort: false, supportsStrictTools: false, supportsMidConvoSystemMessages: false, supportsMidConvoToolChanges: false,
      } } } };
      return { env, setup: writeAlways(".pi/agent/models.json", JSON.stringify(cfg)) };
    },
  },
  cline: {
    providers: ["anthropic"], mode: "gateway",
    how: "cline 3.0.70's anthropic provider ignores any base URL (`-b` is refused for it; ANTHROPIC_BASE_URL and a providers.json baseUrl are ignored), " +
         "so gateway mode uses its OpenAI-compatible provider: `cline auth -p openai -b <base>/v1` + `-P openai` (key in $CLINE_API_KEY). " +
         "`openai/<model>` runs on the OpenAI gateway and `cloudflare/@cf/...` on Cloudflare Workers AI, both native /v1/chat/completions. " +
         "A bare Claude model needs Anthropic's OpenAI-compatible /v1/chat/completions, which the first-party API serves but Vertex does not",
    map(p, o) {
      // Which gateway provider serves this model, and the id Cline's openai provider should send.
      const [provider, modelId] = o.model.startsWith("openai/") ? ["openai", o.model.slice("openai/".length)]
        : o.model.startsWith("cloudflare/") ? ["cloudflare", o.model.slice("cloudflare/".length)]
        : ["anthropic", o.model];
      const c = need(p, provider);
      if (provider !== "anthropic" && !c.base_url) throw new MissingCredentialsError(`cline on ${provider} needs the gateway (no direct mode)`);
      // CLINE_API_KEY is what the adapter passes to -k; ANTHROPIC_API_KEY stays for direct (non-gateway) Anthropic runs.
      const env: Record<string, string> = provider === "anthropic" ? { ANTHROPIC_API_KEY: c.api_key, CLINE_API_KEY: c.api_key } : { CLINE_API_KEY: c.api_key };
      if (!c.base_url) return { env, setup: "" };
      if (/['"$`\\]/.test(modelId) || /['"$`\\]/.test(c.base_url)) throw new Error("unsafe model or base URL for cline setup");
      // OpenAI models use Cline's own OpenAI provider (`openai-native`, which takes a base URL): the generic `openai`
      // provider sends reasoning_effort with tools on /v1/chat/completions, which OpenAI rejects for gpt-6.1-sol
      // ("Function tools with reasoning_effort are not supported ... use /v1/responses"; seen live 2026-10-13).
      const clineProvider = provider === "openai" ? "openai-native" : "openai";
      // The key is referenced from the env ("$CLINE_API_KEY"), never written into argv by us. </dev/null: stdin is the prompt.
      const setup = `cline auth -p ${clineProvider} -k "$CLINE_API_KEY" -b "${withSuffix(c.base_url, "/v1")}" -m "${modelId}" </dev/null >/dev/null 2>&1 || true; `;
      // Adapter argv is `-P anthropic -m <registry model>`: switch to that provider and the provider-local model id.
      const argv = (a: string[]) => a.map((x, i) => (x === "anthropic" && a[i - 1] === "-P" ? clineProvider : a[i - 1] === "-m" ? modelId : x));
      // `cline --acp` (Zed personas) takes no -P/-m: without these it falls back to the Cline account provider.
      return { env: { ...env, CLINE_PROVIDER: clineProvider, CLINE_MODEL: modelId }, setup, argv };
    },
  },
  amp: {
    providers: ["amp"], mode: "direct", how: "AMP_API_KEY (Amp-hosted backend, no base URL override)",
    map: (p) => ({ env: { AMP_API_KEY: need(p, "amp").api_key }, setup: "" }),
  },
  droid: {
    providers: ["factory"], mode: "direct", how: "FACTORY_API_KEY (Factory-hosted models; BYOK customModels would change the model)",
    map: (p) => ({ env: { FACTORY_API_KEY: need(p, "factory").api_key }, setup: "" }),
  },
};

const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD)$/i;

/**
 * The full exec-time env + setup for one harness run: the adapter's neutral flags (with anything credential-like
 * removed, so a stray worker env var can never leak) + the mapped provider credentials.
 */
export function harnessCredentials(adapter: HarnessAdapter, providers: Providers, model: string): HarnessCreds {
  const spec = CRED_SPECS[adapter.id];
  if (!spec) throw new MissingCredentialsError(`no credential mapping for harness ${adapter.id}`);
  const neutral = Object.fromEntries(Object.entries(adapter.env({ anthropic: "", openai: "" }))
    .filter(([k, v]) => v !== "" && !SECRETISH.test(k) && !/_BASE_URL$/.test(k)));
  const mapped = spec.map(providers, { model });
  return { env: { ...neutral, ...mapped.env }, setup: mapped.setup, argv: mapped.argv };
}

/** Providers a harness needs (for docs / pre-checks). */
export function harnessProviders(id: string): string[] { return CRED_SPECS[id]?.providers ?? []; }

/** CREDENTIALS_MODE=env (dev fallback): build providers from the worker's own env vars. */
export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Providers {
  const p: Providers = {};
  const add = (id: string, key: string | undefined, base?: string) => { if (key) p[id] = { mode: base ? "gateway" : "direct", api_key: key, base_url: base || null }; };
  add("anthropic", env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL);
  add("openai", env.OPENAI_API_KEY ?? env.CODEX_API_KEY, env.OPENAI_BASE_URL);
  add("google", env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY, env.GOOGLE_GEMINI_BASE_URL);
  add("dashscope", env.DASHSCOPE_API_KEY, env.DASHSCOPE_BASE_URL);
  add("github_copilot", env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN);
  add("cursor", env.CURSOR_API_KEY);
  add("amp", env.AMP_API_KEY);
  add("factory", env.FACTORY_API_KEY);
  return p;
}

/** Apply the credential argv rewrite, then wrap so `setup` (config writes, no secret values) runs first in the same exec. */
export function withCredentialSetup(argv: string[], setup: string, rewrite?: (a: string[]) => string[]): string[] {
  const a = rewrite ? rewrite(argv) : argv;
  return setup ? ["bash", "-c", `${setup}exec "$@"`, "octi", ...a] : a;
}
