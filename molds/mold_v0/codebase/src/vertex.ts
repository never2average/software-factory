import { createSign } from "node:crypto";

/**
 * Anthropic on Google Cloud Vertex AI, behind the inference gateway.
 *
 * Harnesses keep calling the gateway with the plain Anthropic Messages API (ANTHROPIC_BASE_URL + an ogw_ token).
 * For a provider with backend 'vertex' the gateway rewrites each call (docs: platform.claude.com, "Claude on
 * Google Cloud"):
 *   POST /v1/messages              -> .../publishers/anthropic/models/{model}:rawPredict  (or :streamRawPredict when stream)
 *   POST /v1/messages/count_tokens -> .../publishers/anthropic/models/count-tokens:rawPredict
 * `model` moves from the body into the URL, `anthropic_version: "vertex-2023-10-16"` goes into the body, and
 * anthropic-beta header values move into the body's `anthropic_beta`. Current models use their first-party ids on
 * Vertex (claude-opus-5-5); `model_map` can override per model. Auth is a Google OAuth token minted from the
 * service-account JSON key stored as this provider's credential in the key vault.
 */

export interface VertexConfig {
  project_id?: string; region?: string; model_map?: Record<string, string>; endpoint?: string;
  /** Use another provider's service-account credential (label "vertex"), e.g. google reusing anthropic's. */
  credential_provider?: string;
}
interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

const VERSION = "vertex-2023-10-16";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const cache = new Map<number, { token: string; exp: number }>();

export function parseServiceAccount(secret: string): ServiceAccount {
  let sa: ServiceAccount;
  try { sa = JSON.parse(secret); }
  catch { throw Object.assign(new Error("The Vertex credential must be a Google service-account JSON key"), { status: 503 }); }
  if (!sa?.client_email || !sa?.private_key)
    throw Object.assign(new Error("The service-account key is missing client_email or private_key"), { status: 503 });
  return sa;
}

/**
 * The Vertex location to call: the provider's own backend_config wins where it sets project_id or region; otherwise
 * the project comes from the service-account key and the region from the VERTEX_REGION setting (Agent configuration).
 */
export function vertexConfig(cfg: VertexConfig | undefined, secret: string, region: string): VertexConfig {
  let project: string | undefined;
  try { project = (JSON.parse(secret) as { project_id?: string }).project_id; } catch { /* parseServiceAccount says why */ }
  return { ...(cfg ?? {}), project_id: cfg?.project_id || project, region: cfg?.region || region };
}

/** A Google OAuth access token for the service account, cached until a minute before it expires. */
export async function vertexAccessToken(credentialId: number, secret: string): Promise<string> {
  const hit = cache.get(credentialId);
  if (hit && hit.exp - 60_000 > Date.now()) return hit.token;
  const sa = parseServiceAccount(secret);
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
  const res = await fetch(aud, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(signature)}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !body.access_token)
    throw Object.assign(new Error(`Google token exchange failed (${res.status}): ${body.error_description ?? body.error ?? "no access_token"}`), { status: 502 });
  cache.set(credentialId, { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

/** Base URL for a Vertex location: global, multi-region (us, eu) or a single region. */
export function vertexBase(cfg: VertexConfig): string {
  if (cfg.endpoint) return cfg.endpoint.replace(/\/$/, ""); // tests / private endpoints
  const r = cfg.region ?? "global";
  if (r === "global") return "https://aiplatform.googleapis.com";
  if (r === "us" || r === "eu") return `https://aiplatform.${r}.rep.googleapis.com`;
  return `https://${r}-aiplatform.googleapis.com`;
}

/** Translate a gateway request (path after /gw/<provider>, raw JSON body, client beta header) into a Vertex call. */
export function toVertex(cfg: VertexConfig, path: string, rawBody: Buffer, betaHeader?: string): { url: string; body: string } {
  if (!cfg.project_id) throw Object.assign(new Error("Vertex backend has no project_id configured"), { status: 503 });
  const p = path.replace(/\/+$/, "");
  const isCount = p === "/v1/messages/count_tokens";
  if (p !== "/v1/messages" && !isCount)
    throw Object.assign(new Error(`${p} is not available on Vertex AI (only /v1/messages and /v1/messages/count_tokens)`), { status: 404 });
  let json: Record<string, unknown>;
  try { json = JSON.parse(rawBody.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Request body is not valid JSON"), { status: 400 }); }
  const model = typeof json.model === "string" ? json.model : "";
  if (!model) throw Object.assign(new Error("model is required"), { status: 400 });
  const vertexModel = cfg.model_map?.[model] ?? model;
  json.anthropic_version = VERSION;
  // Vertex lags the first-party API: drop fields it rejects so third-party harnesses still work there.
  // `thinking.block_binding` (preserved-thinking controls) is not accepted on Vertex; strict tool schemas count as
  // structured outputs, which an organization policy may disallow for partner models. Tools work without `strict`.
  if (json.thinking && typeof json.thinking === "object") delete (json.thinking as Record<string, unknown>).block_binding;
  if (Array.isArray(json.tools)) for (const t of json.tools as Record<string, unknown>[]) if (t && typeof t === "object") delete t.strict;
  // A message is only {role, content}; some harnesses attach extra keys, which Vertex rejects. Pi marks effort changes
  // with empty system messages ({role: "system", content: [], output_config: {effort}}); Vertex has no per-message
  // effort, so drop those markers (the request's top-level output_config.effort still applies).
  if (Array.isArray(json.messages))
    json.messages = (json.messages as Record<string, unknown>[])
      .filter((m) => !(m && typeof m === "object" && m.role === "system" && (m.content === "" || (Array.isArray(m.content) && !m.content.length))))
      .map((m) => (m && typeof m === "object" ? { role: m.role, content: m.content } : m));
  const betas = (betaHeader ?? "").split(",").map((s) => s.trim()).filter((b) => b && !b.startsWith("thinking-binding-controls"));
  if (betas.length) json.anthropic_beta = [...new Set([...(Array.isArray(json.anthropic_beta) ? json.anthropic_beta as string[] : []), ...betas])];
  const loc = `${vertexBase(cfg)}/v1/projects/${encodeURIComponent(cfg.project_id)}/locations/${encodeURIComponent(cfg.region ?? "global")}/publishers/anthropic/models`;
  if (isCount) {
    json.model = vertexModel;
    return { url: `${loc}/count-tokens:rawPredict`, body: JSON.stringify(json) };
  }
  delete json.model;
  return { url: `${loc}/${encodeURIComponent(vertexModel)}:${json.stream ? "streamRawPredict" : "rawPredict"}`, body: JSON.stringify(json) };
}

/**
 * Gemini on Vertex AI, behind the gateway provider `google`. Harnesses (Antigravity CLI, Gemini CLI) call the Gemini
 * API shape, `/v1beta/models/{model}:generateContent | :streamGenerateContent | :countTokens`; Vertex serves the same
 * request and response bodies at `.../publishers/google/models/{model}:{method}`, so only the URL and the auth change
 * (a Google OAuth token from the service account instead of an API key). The body streams through untouched.
 */
export function toVertexGemini(cfg: VertexConfig, path: string, search = ""): { url: string; model: string } {
  if (!cfg.project_id) throw Object.assign(new Error("Vertex backend has no project_id configured"), { status: 503 });
  // The model and method are read from the end of the path. Normal calls are /v1beta/models/{model}:{method}; Antigravity
  // CLI's custom models (gemini-api://<base>/models/<id>) arrive as /models/<host>/<path>/v1beta/models/{model}:{method}.
  const m = /(?:^|\/)models\/([^/:]+):([A-Za-z]+)$/.exec(path.replace(/\/+$/, ""));
  if (!m) throw Object.assign(new Error(`${path} is not available on Vertex AI (only .../models/{model}:{method})`), { status: 404 });
  const [, rawModel, method] = m;
  const version = /^\/v1\//.test(path) ? "v1" : "v1beta";
  const model = cfg.model_map?.[rawModel] ?? rawModel;
  const api = version === "v1" ? "v1" : "v1beta1"; // preview fields (thinking, new tool types) live on v1beta1
  const loc = `${vertexBase(cfg)}/${api}/projects/${encodeURIComponent(cfg.project_id)}/locations/${encodeURIComponent(cfg.region ?? "global")}/publishers/google/models`;
  return { url: `${loc}/${encodeURIComponent(model)}:${method}${search}`, model };
}

/**
 * Gemini 4 (Argon) takes `thinkingConfig.thinkingLevel` (low | medium | high) and rejects `thinkingBudget` outright
 * ("Thinking budget is not supported for this model. Use thinking level instead"; `minimal` is unsupported too, probed
 * 2026-10-13). Clients released before it (Antigravity CLI 1.3.4 with a custom model) still send a budget, so the gateway
 * translates it: dynamic (-1) or large -> high, mid -> medium, small or 0 -> low. Other models and bodies pass untouched.
 */
const LEVEL_ONLY_MODEL = /^gemini-(?:[4-9]|\d{2})\b/;
export const geminiWantsThinkingLevel = (model: string) => LEVEL_ONLY_MODEL.test(model);
export function adaptGeminiBody(model: string, raw: Buffer): Buffer {
  if (!geminiWantsThinkingLevel(model)) return raw;
  let json: any;
  try { json = JSON.parse(raw.toString("utf8")); } catch { return raw; }
  const gc = json?.generationConfig ?? json?.generation_config;
  const tc = gc?.thinkingConfig ?? gc?.thinking_config;
  if (!tc || typeof tc !== "object") return raw;
  const budget = tc.thinkingBudget ?? tc.thinking_budget;
  if (budget === undefined) return raw;
  const b = Number(budget);
  if (tc.thinkingLevel === undefined && tc.thinking_level === undefined)
    tc.thinkingLevel = !Number.isFinite(b) || b < 0 || b > 16384 ? "high" : b > 4096 ? "medium" : "low";
  delete tc.thinkingBudget;
  delete tc.thinking_budget;
  return Buffer.from(JSON.stringify(json));
}
