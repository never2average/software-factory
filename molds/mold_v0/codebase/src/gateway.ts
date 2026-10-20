import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Request, Response } from "express";
import { getDb } from "./db.js";
import { settingText } from "./settings.js";
import { findAgent } from "./agents.js";
import { getProvider, providersForEnv, useCredential, useVertexCredential, VERTEX_LABEL, type ProviderRow } from "./keyvault.js";
import { adaptGeminiBody, geminiWantsThinkingLevel, toVertex, toVertexGemini, vertexAccessToken, vertexConfig, type VertexConfig } from "./vertex.js";
import { costOf, recordModelUsage } from "./usage.js";
import { SCENARIO_ROWS } from "./queries.js";

/**
 * Inference gateway + credential broker (docs/credentials.md).
 *
 * Sub-agents get `ogw_` tokens scoped to a session, its providers and its lease; they call
 * {PUBLIC_URL}/gw/<provider>/... and the gateway swaps the token for a real key from the vault, streams the
 * request and response through, and meters requests/tokens/bytes per session. Vendor-hosted agents that cannot
 * take a custom base URL (mode `direct`) get the real key from the broker for that session only.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Agent sandboxes and orchestrators call the gateway here: the API directly (OCTILLION_INTERNAL_URL) when the public
 *  URL is a proxy in front of it (long model streams should not take the extra hop), else PUBLIC_URL. */
const PUBLIC_URL = () => (process.env.OCTILLION_INTERNAL_URL || process.env.PUBLIC_URL || `http://127.0.0.1:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
const SESSION_TOKEN_MINUTES = () => Number(process.env.OCTILLION_SESSION_TOKEN_MINUTES ?? 90);
const MAX_REQUESTS = () => Number(process.env.OCTILLION_GATEWAY_MAX_REQUESTS ?? 1000);
// Per-session budget. Cost is the real limit: token counts include cache reads, so long agent sessions re-read
// millions of cheap cached tokens. The token cap is a backstop for models without a price.
const MAX_TOKENS = () => Number(process.env.OCTILLION_GATEWAY_MAX_TOKENS ?? 30_000_000);
const MAX_COST_USD = () => Number(process.env.OCTILLION_GATEWAY_MAX_COST_USD ?? 10);

/** Requires-env fallback for sessions whose agent is not in the registry. */
export const HARNESS_ENV: Record<string, string[]> = { "claude-code": ["ANTHROPIC_API_KEY"], codex: ["CODEX_API_KEY", "OPENAI_API_KEY"] };

/** Conventional env names for gateway providers (adapters may map providers to their own variables instead). */
const GATEWAY_ENV: Record<string, (base: string, token: string) => Record<string, string>> = {
  anthropic: (b, t) => ({ ANTHROPIC_BASE_URL: b, ANTHROPIC_API_KEY: t }),
  openai: (b, t) => ({ OPENAI_BASE_URL: `${b}/v1`, OPENAI_API_KEY: t, CODEX_API_KEY: t }),
  google: (b, t) => ({ GOOGLE_GEMINI_BASE_URL: b, GEMINI_API_KEY: t }),
  dashscope: (b, t) => ({ DASHSCOPE_BASE_URL: `${b}/compatible-mode/v1`, DASHSCOPE_API_KEY: t }),
};

async function mintToken(kind: "session" | "orchestrator", providers: string[], expiresAt: Date, ref: { sessionId?: string; orchestratorId?: string }) {
  const token = `ogw_${randomBytes(24).toString("base64url")}`;
  await (await getDb()).query(
    `INSERT INTO gateway_tokens (token_hash, kind, session_id, orchestrator_id, providers, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [sha256(token), kind, ref.sessionId ?? null, ref.orchestratorId ?? null, providers, expiresAt],
  );
  return token;
}

/** Credentials for one running agent session: gateway providers get a scoped token, direct ones the real key. */
export async function brokerSessionCredentials(sessionId: string) {
  const db = await getDb();
  const [s] = await db.query<{ status: string; agent_id: string | null; harness: string; task_source: string | null }>(
    `/* tenant: session checked against the job token in http.ts (/sessions/:id) */ SELECT s.status, s.agent_id, s.harness, sc.source AS task_source
       FROM agent_sessions s LEFT JOIN ${SCENARIO_ROWS} sc ON sc.id = s.scenario_id WHERE s.id = $1`, [sessionId]);
  if (!s) throw Object.assign(new Error(`No session ${sessionId}`), { status: 404 });
  if (s.status !== "running") throw Object.assign(new Error(`Session ${sessionId} is ${s.status}, not running`), { status: 409 });

  const needs = (s.agent_id && findAgent(s.agent_id)?.requires_env) || HARNESS_ENV[s.harness] || [];
  // Real vendor keys (direct mode) reach a session only when explicitly allowed, never for a task a customer wrote
  // (its prompt steers an agent that can read its own environment), and never for orchestrator-only keys.
  const all = await providersForEnv(needs);
  const providers = all.filter((p) => p.mode === "gateway" || directKeyAllowed(p.slug, s.task_source));
  const withheld = needs.filter((v) => !providers.some((p) => p.env_vars.includes(v)) && all.some((p) => p.env_vars.includes(v)));
  if (withheld.length)
    throw Object.assign(new Error(`Real vendor keys (${withheld.join(", ")}) are not given to this session: direct-mode keys are off ` +
                                  "(OCTILLION_DIRECT_KEYS) or the task was written by a customer"), { status: 403 });
  const missing = needs.filter((v) => !providers.some((p) => p.env_vars.includes(v)));
  // 424, not 5xx: a missing key is configuration, not an outage. A 503 here matched the infrastructure-failure rule in
  // src/worker.ts, so the session was requeued and failed again on the same missing key.
  if (missing.length)
    throw Object.assign(new Error(`No vault provider supplies ${missing.join(", ")}`), { status: 424, code: "missing_credential", env: missing.join(",") });

  // Must outlive the longest session (orchestrator MAX_SESSION_MINUTES, 45): a 30-minute token killed slow sessions
  // mid-run ("Gateway token is invalid, expired or revoked" at 30:00, seen 2026-10-13). The token is revoked when
  // the session completes, so the lifetime only bounds a session whose completion never arrives.
  const expiresAt = new Date(Date.now() + SESSION_TOKEN_MINUTES() * 60_000);
  const gatewaySlugs = providers.filter((p) => p.mode === "gateway").map((p) => p.slug);
  const token = gatewaySlugs.length ? await mintToken("session", gatewaySlugs, expiresAt, { sessionId }) : null;
  const out: Record<string, { mode: string; base_url?: string; api_key: string }> = {};
  const env: Record<string, string> = {};
  for (const p of providers) {
    if (p.mode === "gateway") {
      const base = `${PUBLIC_URL()}/gw/${p.slug}`;
      out[p.slug] = { mode: "gateway", base_url: base, api_key: token! };
      Object.assign(env, GATEWAY_ENV[p.slug]?.(base, token!) ?? Object.fromEntries(p.env_vars.map((v) => [v, token!])));
    } else {
      const { secret } = await useCredential(p.slug);
      out[p.slug] = { mode: "direct", api_key: secret };
      for (const v of p.env_vars.filter((v) => needs.includes(v))) env[v] = secret;
    }
  }
  return { expires_at: expiresAt.toISOString(), providers: out, env };
}

/** What the orchestrator's brain (Pi) runs on; one place for every orchestrator. Default: GPT via the gateway. */
export const orchestratorBrain = () => ({
  provider: process.env.ORCHESTRATOR_PROVIDER ?? "openai",
  model: settingText("ORCHESTRATOR_MODEL"), // global setting (/admin/compute), else ORCHESTRATOR_MODEL, else gpt-6.1-sol
});
/** Path SDKs expect after the provider's host (OpenAI-style clients append /responses, /chat/completions to .../v1). */
const SDK_BASE_SUFFIX: Record<string, string> = { openai: "/v1", dashscope: "/compatible-mode/v1" };

/** Direct-mode providers whose key only the orchestrator uses; never brokered to an agent session. */
export const ORCHESTRATOR_ONLY_PROVIDERS = new Set(["boat", "vertex"]);
/** Real vendor keys in agent sessions are off unless OCTILLION_DIRECT_KEYS=allow (see docs/security.md). */
export const directKeysAllowed = () => process.env.OCTILLION_DIRECT_KEYS === "allow";
function directKeyAllowed(provider: string, taskSource: string | null): boolean {
  if (ORCHESTRATOR_ONLY_PROVIDERS.has(provider) || !directKeysAllowed()) return false;
  return taskSource === "library" || taskSource === "generated"; // curated or research-written, never customer-written
}

/** The orchestrator's own access: boat.dev key (if in the vault) and gateway access for its LLM. */
export async function brokerOrchestratorCredentials(orchestratorId: string) {
  const { provider: llmProvider, model: llmModel } = orchestratorBrain();
  const p = await getProvider(llmProvider);
  const expiresAt = new Date(Date.now() + 12 * 3600_000);
  const boat = await useCredential("boat").then((c) => ({ api_key: c.secret })).catch(() => null);
  const llm = p?.mode === "gateway" && p.enabled
    ? { provider: llmProvider, model: llmModel, base_url: `${PUBLIC_URL()}/gw/${llmProvider}${SDK_BASE_SUFFIX[llmProvider] ?? ""}`,
        api_key: await mintToken("orchestrator", [llmProvider], expiresAt, { orchestratorId }), expires_at: expiresAt.toISOString() }
    : null;
  return { boat, llm };
}

export async function revokeSessionTokens(sessionId: string) {
  await (await getDb()).query("UPDATE gateway_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL", [sessionId]);
}

/** Gateway-metered usage for a session (summed over providers). */
export async function sessionGatewayUsage(sessionId: string) {
  const [u] = await (await getDb()).query<{ requests: number; input_tokens: number; output_tokens: number; cost_usd: number }>(
    `/* tenant: session completed via the worker route, checked against the job token in http.ts */ SELECT coalesce(sum(requests), 0) AS requests, coalesce(sum(input_tokens), 0) AS input_tokens,
            coalesce(sum(output_tokens), 0) AS output_tokens, coalesce(sum(cost_usd), 0) AS cost_usd
       FROM gateway_usage WHERE session_id = $1`,
    [sessionId],
  );
  return { requests: Number(u.requests), input_tokens: Number(u.input_tokens), output_tokens: Number(u.output_tokens),
           cost_usd: Number(u.cost_usd) };
}

// ---------- the proxy ----------

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const CLIENT_AUTH = ["authorization", "x-api-key", "x-goog-api-key", "api-key", "cookie"];

function tokenFrom(req: Request): string | null {
  const h = req.headers;
  const candidates = [
    String(h["x-api-key"] ?? ""), String(h["x-goog-api-key"] ?? ""), String(h["api-key"] ?? ""),
    String(h.authorization ?? "").replace(/^Bearer\s+/i, ""), String((req.query as Record<string, unknown>).key ?? ""),
  ];
  return candidates.find((c) => c.startsWith("ogw_")) ?? null;
}

const gwError = (res: Response, status: number, type: string, message: string) =>
  void res.status(status).json({ type: "error", error: { type, message } });

/** Pulls token usage out of JSON or SSE bodies from Anthropic, OpenAI (chat + responses) and Gemini. */
class UsageMeter {
  input = 0; output = 0; cached = 0; bytes = 0; model = "";
  private buf = "";
  private sse: boolean;
  constructor(contentType: string) { this.sse = /event-stream/.test(contentType); }
  feed(chunk: Buffer) {
    this.bytes += chunk.length;
    this.buf += chunk.toString("utf8");
    if (this.sse) {
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      for (const l of lines) if (l.startsWith("data:")) this.json(l.slice(5).trim());
    } else if (this.buf.length > 4_000_000) this.buf = ""; // give up metering absurdly large bodies
  }
  end() { if (this.sse) { if (this.buf.startsWith("data:")) this.json(this.buf.slice(5).trim()); } else this.json(this.buf); }
  private json(text: string) {
    if (!text || text === "[DONE]") return;
    let e: any;
    try { e = JSON.parse(text); } catch { return; }
    // The model the provider actually served (OpenAI chat/responses, Anthropic message_start, Gemini modelVersion).
    const model = e?.model ?? e?.message?.model ?? e?.response?.model ?? e?.modelVersion ?? (Array.isArray(e) ? e.at(-1)?.modelVersion : undefined);
    if (typeof model === "string" && model) this.model = model;
    const u = e?.usage ?? e?.message?.usage ?? e?.response?.usage ?? null;
    if (u) {
      // Anthropic: message_start carries input, message_delta the cumulative output; OpenAI: prompt/completion or input/output.
      const inp = u.input_tokens ?? u.prompt_tokens ?? 0;
      const out = u.output_tokens ?? u.completion_tokens ?? 0;
      const anthropicCache = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (inp) this.input = Math.max(this.input, inp + anthropicCache);
      if (out) this.output = Math.max(this.output, out);
      const cached = u.cache_read_input_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      if (cached) this.cached = Math.max(this.cached, cached);
    }
    const g = e?.usageMetadata ?? (Array.isArray(e) ? e.at(-1)?.usageMetadata : null);
    if (g) {
      this.input = Math.max(this.input, g.promptTokenCount ?? 0); this.output = Math.max(this.output, g.candidatesTokenCount ?? 0);
      this.cached = Math.max(this.cached, g.cachedContentTokenCount ?? 0);
    }
  }
}

export async function gatewayHandler(req: Request, res: Response) {
  const slug = String(req.params.provider);
  const token = tokenFrom(req);
  if (!token) return gwError(res, 401, "authentication_error", "Missing Octillion gateway token");
  const db = await getDb();
  const hash = sha256(token);
  const [t] = await db.query<{ kind: string; session_id: string | null; orchestrator_id: string | null; providers: string[]; expires_at: Date; revoked_at: Date | null }>(
    "SELECT kind, session_id, orchestrator_id, providers, expires_at, revoked_at FROM gateway_tokens WHERE token_hash = $1", [hash]);
  if (!t || t.revoked_at || new Date(t.expires_at) < new Date()) return gwError(res, 401, "authentication_error", "Gateway token is invalid, expired or revoked");
  if (!t.providers.includes(slug)) return gwError(res, 403, "permission_error", `Token is not allowed to use ${slug}`);
  // Some CLIs (Codex) probe a WebSocket transport first; refuse fast so they fall back to HTTP immediately.
  if (req.headers.upgrade) return gwError(res, 426, "invalid_request_error", "WebSocket is not supported by the Octillion gateway; use HTTP");
  let p: ProviderRow | null = await getProvider(slug);
  if (!p?.enabled || p.mode !== "gateway" || (!p.upstream_url && p.backend !== "vertex")) return gwError(res, 404, "not_found_error", `No gateway provider ${slug}`);

  const [used] = await db.query<{ requests: number; tokens: number; cost: number }>(
    "/* tenant: by the gateway token's own hash (budget of that token) */ SELECT coalesce(sum(requests), 0) AS requests, coalesce(sum(input_tokens + output_tokens), 0) AS tokens, coalesce(sum(cost_usd), 0) AS cost FROM gateway_usage WHERE token_hash = $1", [hash]);
  if (Number(used.requests) >= MAX_REQUESTS() || Number(used.tokens) >= MAX_TOKENS() || Number(used.cost) >= MAX_COST_USD())
    return gwError(res, 429, "octillion_budget_exceeded", "This session's gateway budget is used up");

  let cred: { id: number; secret: string };
  // Vertex signs in with a service-account key (the Vertex AI provider's, or the provider's own "vertex" key, or
  // backend_config.credential_provider's); project from that key and region from the VERTEX_REGION setting unless
  // backend_config sets them. Every other backend uses the provider's own key.
  try {
    cred = p.backend === "vertex"
      ? await useVertexCredential(slug, (p.backend_config as VertexConfig)?.credential_provider)
      : await useCredential(slug, { excludeLabel: VERTEX_LABEL });
  } catch (e) {
    // Claude with no Anthropic key: run it on Vertex AI when the vault holds a Vertex key (project from the key,
    // region from the VERTEX_REGION setting), so adding the Vertex key is all it takes.
    const vertex = slug === "anthropic" && p.backend !== "vertex" ? await useVertexCredential(slug).catch(() => null) : null;
    if (!vertex) return gwError(res, 503, "api_error", (e as Error).message);
    cred = vertex;
    p = { ...p, backend: "vertex", backend_config: { region: "global" } }; // Claude 5 models are served from the global endpoint
  }
  const vcfg = p.backend === "vertex" ? vertexConfig(p.backend_config, cred.secret, settingText("VERTEX_REGION")) : p.backend_config;

  // Path after /gw/<provider>, query without our `key` parameter.
  const url = new URL(req.originalUrl, "http://x");
  url.searchParams.delete("key");
  const rest = url.pathname.replace(new RegExp(`^/gw/${slug}`), "") || "/";

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP.has(k) || CLIENT_AUTH.includes(k) || k === "accept-encoding") continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  headers.set("accept-encoding", "identity"); // keep the body readable for metering

  // Where and what to send: straight through to upstream_url, or rewritten for Google Cloud Vertex AI.
  let upstream: string;
  let body: BodyInit | undefined;
  let requestModel = "";                                  // fallback when the response does not name the model
  const isCountTokens = /\/count_tokens$|:countTokens$/.test(rest); // free endpoints: never billed as usage
  const hasBody = !["GET", "HEAD"].includes(req.method);
  if (p.backend === "vertex" && slug === "google") {
    // Gemini on Vertex: same body, different URL and auth; the request streams through.
    try {
      const v = toVertexGemini(vcfg, rest, url.search);
      upstream = v.url;
      requestModel = v.model;
      headers.delete("x-goog-api-key");
      headers.delete("x-goog-api-client");
      headers.set("authorization", `Bearer ${await vertexAccessToken(cred.id, cred.secret)}`);
      if (hasBody && geminiWantsThinkingLevel(v.model)) {
        // This model needs its request adjusted (thinking budget -> level), so the body is read in full first.
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) { size += (c as Buffer).length; if (size > 30 * 1024 * 1024) throw Object.assign(new Error("Request exceeds Vertex's 30 MB limit"), { status: 413 }); chunks.push(c as Buffer); }
        body = adaptGeminiBody(v.model, Buffer.concat(chunks)).toString("utf8");
        headers.delete("content-length");
      } else body = hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined;
    } catch (e) {
      const err = e as Error & { status?: number };
      return gwError(res, err.status ?? 502, err.status && err.status < 500 ? "invalid_request_error" : "api_error", err.message);
    }
  } else if (p.backend === "vertex") {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) { size += (c as Buffer).length; if (size > 30 * 1024 * 1024) throw Object.assign(new Error("Request exceeds Vertex's 30 MB limit"), { status: 413 }); chunks.push(c as Buffer); }
      const v = toVertex(vcfg, rest, Buffer.concat(chunks), String(req.headers["anthropic-beta"] ?? ""));
      upstream = v.url;
      body = v.body;
      requestModel = decodeURIComponent(v.url.match(/\/models\/([^/:]+):/)?.[1] ?? "");
      headers.delete("anthropic-version"); // carried in the body on Vertex
      headers.delete("anthropic-beta");
      headers.delete("content-length");
      headers.set("content-type", "application/json");
      headers.set("authorization", `Bearer ${await vertexAccessToken(cred.id, cred.secret)}`);
    } catch (e) {
      const err = e as Error & { status?: number };
      return gwError(res, err.status ?? 502, err.status && err.status < 500 ? "invalid_request_error" : "api_error", err.message);
    }
  } else {
    upstream = `${p.upstream_url!.replace(/\/$/, "")}${rest}${url.search}`;
    headers.set(p.auth_header, `${p.auth_prefix}${cred.secret}`);
    // Anthropic's OpenAI-compatible endpoint (used by Cline) is called with OpenAI-style auth; give it both forms.
    if (slug === "anthropic" && /\/chat\/completions$/.test(rest)) headers.set("authorization", `Bearer ${cred.secret}`);
    body = hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined;
  }

  let up: globalThis.Response;
  try {
    up = await fetch(upstream, {
      method: req.method, headers, redirect: "manual", body,
      // @ts-expect-error Node's fetch needs duplex for streamed request bodies
      duplex: body instanceof ReadableStream ? "half" : undefined,
      signal: AbortSignal.timeout(Number(process.env.OCTILLION_GATEWAY_TIMEOUT_MS ?? 600_000)),
    });
  } catch (e) {
    await record(hash, slug, t, { requests: 1, errors: 1, input: 0, cached: 0, output: 0, bytes: 0, model: requestModel });
    return gwError(res, 502, "api_error", `Upstream ${slug} unreachable: ${(e as Error).message}`);
  }

  res.status(up.status);
  up.headers.forEach((v, k) => { if (!HOP.has(k) && k !== "content-encoding" && k !== "content-length") res.setHeader(k, v); });
  const meter = new UsageMeter(up.headers.get("content-type") ?? "");
  try {
    if (up.body) for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) {
      const b = Buffer.from(chunk);
      meter.feed(b);
      res.write(b);
    }
  } finally {
    meter.end();
    res.end();
    const billed = !isCountTokens;
    await record(hash, slug, t, { requests: 1, errors: up.status >= 400 ? 1 : 0, input: billed ? meter.input : 0, cached: billed ? meter.cached : 0,
                                  output: billed ? meter.output : 0, bytes: meter.bytes, model: meter.model || requestModel });
  }
}

async function record(hash: string, provider: string, t: { kind: string; session_id: string | null; orchestrator_id: string | null },
                      u: { requests: number; errors: number; input: number; cached: number; output: number; bytes: number; model: string }) {
  await recordModelUsage(provider, u.model || "unknown", t.kind === "orchestrator" ? "orchestrator" : "session",
                         { requests: u.requests, errors: u.errors, input: u.input, cached: u.cached, output: u.output })
    .catch((e) => console.error("model usage record failed:", (e as Error).message));
  const cost = (await costOf(u.model || "unknown", u).catch(() => null)) ?? 0;
  await (await getDb()).query(
    `/* tenant: internal: metering for the gateway token's own session/orchestrator */ INSERT INTO gateway_usage (token_hash, provider, session_id, orchestrator_id, requests, errors, input_tokens, output_tokens, bytes, cost_usd, last_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (token_hash, provider) DO UPDATE SET requests = gateway_usage.requests + excluded.requests,
       errors = gateway_usage.errors + excluded.errors, input_tokens = gateway_usage.input_tokens + excluded.input_tokens,
       output_tokens = gateway_usage.output_tokens + excluded.output_tokens, bytes = gateway_usage.bytes + excluded.bytes,
       cost_usd = gateway_usage.cost_usd + excluded.cost_usd, last_at = now()`,
    [hash, provider, t.session_id, t.orchestrator_id, u.requests, u.errors, u.input, u.output, u.bytes, cost],
  ).catch((e) => console.error("gateway usage record failed:", e.message));
}
