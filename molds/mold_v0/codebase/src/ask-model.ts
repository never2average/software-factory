import { orchestratorBrain } from "./gateway.js";
import { getProvider, useCredential, useVertexCredential, VERTEX_LABEL } from "./keyvault.js";
import { settingText } from "./settings.js";
import { recordModelUsage } from "./usage.js";
import { toVertex, vertexAccessToken, vertexConfig, type VertexConfig } from "./vertex.js";

/**
 * One server-side model call (moved out of the product's access-request research, mold_v0-039): the first model that
 * answers among GLM on Cloudflare Workers AI, Claude (the vault's Anthropic key, or Claude on Vertex AI) and the
 * orchestrator's OpenAI model. Keys come from the key vault only; each answer is metered in gateway_model_usage. Used by
 * the docs answers (src/docs-answers.ts) and by packs through src/pack-host.ts.
 */
const MODEL = () => process.env.PROSPECT_MODEL ?? "claude-sonnet-5-5";

/** What one server-side model call answered, and what it cost in tokens (when the provider said). */
export interface ModelAnswer<T> { value: T; text: string; model: string; provider: "cloudflare" | "anthropic" | "openai"; input_tokens: number; output_tokens: number }
export interface AskOptions<T> {
  /** Output budget for Claude and OpenAI; Cloudflare's thinking model always gets room to reason first. */
  maxTokens?: number;
  /** Turns the text into the result; throwing moves on to the next model. */
  parse: (text: string) => T;
}

/**
 * One server-side model call, from the first model that answers: GLM 5.3 Flash on Cloudflare Workers AI (the cheapest),
 * then Claude (the vault's Anthropic key, or Claude on Vertex AI), then the orchestrator's OpenAI model. Keys come
 * from the vault only. Each answer's tokens are recorded in gateway_model_usage like the gateway's own requests;
 * failures count as errors there. Throws with every model's failure when none answered.
 */
export async function askModel<T>(system: string, user: string, opts: AskOptions<T>): Promise<ModelAnswer<T>> {
  const brain = orchestratorBrain();
  type Raw = { text: string; input: number; output: number };
  const tries: [ModelAnswer<T>["provider"], string, () => Promise<Raw>][] = [
    ["cloudflare", cloudflareModel(), () => cloudflareText(system, user)],
    ["anthropic", MODEL(), () => anthropicText(system, user, opts.maxTokens ?? 1500)],
    ...(brain.provider === "openai" ? [["openai", brain.model, () => openaiText(system, user, brain.model)] as [ModelAnswer<T>["provider"], string, () => Promise<Raw>]] : []),
  ];
  const errors: string[] = [];
  for (const [provider, model, ask] of tries) {
    let raw: Raw | null = null;
    try {
      raw = await ask();
      const value = opts.parse(raw.text);
      void meter(provider, model, raw, false);
      return { value, text: raw.text, model, provider, input_tokens: raw.input, output_tokens: raw.output };
    } catch (e) {
      // A call that answered but could not be parsed still spent tokens.
      if (raw) void meter(provider, model, raw, true);
      errors.push((e as Error).message);
    }
  }
  throw new Error(errors.join("; "));
}

const meter = (provider: string, model: string, raw: { input: number; output: number }, error: boolean) =>
  recordModelUsage(provider, model, "orchestrator", { requests: 1, errors: error ? 1 : 0, input: raw.input, cached: 0, output: raw.output })
    .catch((e) => console.error("model usage record failed:", (e as Error).message));

const tokens = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);

const cloudflareModel = () => settingText("CLOUDFLARE_AI_MODEL"); // global setting (/admin/compute), else env

/** Cloudflare Workers AI (OpenAI-compatible endpoint): the vault's cloudflare key; the account id (not a secret) from
 *  the provider's upstream URL (.../accounts/<id>/ai) or CLOUDFLARE_ACCOUNT_ID. CLOUDFLARE_API_URL points at another
 *  host (the smoke test's mock). */
async function cloudflareText(system: string, user: string) {
  const p = await getProvider("cloudflare");
  const account = p?.upstream_url?.match(/\/accounts\/([^/]+)/)?.[1] ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  const token = (await useCredential("cloudflare").catch(() => null))?.secret;
  if (!token) throw new Error("no Cloudflare Workers AI key in the vault");
  if (!account) throw new Error("no Cloudflare account id (the cloudflare provider's upstream URL, or CLOUDFLARE_ACCOUNT_ID)");
  const host = (process.env.CLOUDFLARE_API_URL ?? "https://api.cloudflare.com").replace(/\/$/, "");
  const r = await fetch(`${host}/client/v4/accounts/${encodeURIComponent(account)}/ai/v1/chat/completions`, {
    method: "POST", signal: AbortSignal.timeout(120_000), headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: cloudflareModel(), max_tokens: 8000 /* a thinking model: room to reason, then answer */, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Cloudflare answered ${r.status}`);
  const out = await r.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return { text: out.choices?.[0]?.message?.content ?? "", input: tokens(out.usage?.prompt_tokens), output: tokens(out.usage?.completion_tokens) };
}

/**
 * askModel for an answer read as it is written: the text comes through `onDelta` as the model produces it. GLM on
 * Cloudflare streams (server-sent events); Claude, the fallback, answers in one piece, passed on as one delta. When a
 * model fails after part of its text went out, `onReset` says to drop it before the next one starts. Metered like
 * askModel. Throws when no model answers.
 */
export async function askModelStream(system: string, user: string, opts: { maxTokens?: number; onDelta: (text: string) => void; onReset?: () => void }) {
  const errors: string[] = [];
  let sent = false;
  const delta = (t: string) => { if (t) { sent = true; opts.onDelta(t); } };
  const tries: [ModelAnswer<string>["provider"], string, () => Promise<{ text: string; input: number; output: number }>][] = [
    ["cloudflare", cloudflareModel(), () => cloudflareStream(system, user, delta)],
    ["anthropic", MODEL(), async () => { const raw = await anthropicText(system, user, opts.maxTokens ?? 1500); delta(raw.text); return raw; }],
  ];
  for (const [provider, model, ask] of tries) {
    try {
      const raw = await ask();
      if (!raw.text.trim()) throw new Error("empty answer");
      void meter(provider, model, raw, false);
      return { text: raw.text, model, provider, input_tokens: raw.input, output_tokens: raw.output };
    } catch (e) {
      errors.push(`${provider}: ${(e as Error).message}`);
      if (sent) { opts.onReset?.(); sent = false; }
    }
  }
  throw new Error(`no model answered (${errors.join("; ")})`);
}

/** Workers AI chat completions with stream: true; a reply that comes back whole (no event stream) is one delta. */
async function cloudflareStream(system: string, user: string, onDelta: (t: string) => void) {
  const p = await getProvider("cloudflare");
  const account = p?.upstream_url?.match(/\/accounts\/([^/]+)/)?.[1] ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  const token = (await useCredential("cloudflare").catch(() => null))?.secret;
  if (!token) throw new Error("no Cloudflare Workers AI key in the vault");
  if (!account) throw new Error("no Cloudflare account id (the cloudflare provider's upstream URL, or CLOUDFLARE_ACCOUNT_ID)");
  const host = (process.env.CLOUDFLARE_API_URL ?? "https://api.cloudflare.com").replace(/\/$/, "");
  const r = await fetch(`${host}/client/v4/accounts/${encodeURIComponent(account)}/ai/v1/chat/completions`, {
    method: "POST", signal: AbortSignal.timeout(120_000), headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: cloudflareModel(), max_tokens: 8000, stream: true, stream_options: { include_usage: true },
      messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Cloudflare answered ${r.status}`);
  type Chunk = { choices?: { delta?: { content?: string }; message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  if (!(r.headers.get("content-type") ?? "").includes("event-stream")) {
    const out = await r.json() as Chunk;
    const text = out.choices?.[0]?.message?.content ?? "";
    onDelta(text);
    return { text, input: tokens(out.usage?.prompt_tokens), output: tokens(out.usage?.completion_tokens) };
  }
  let text = "", input = 0, output = 0, buf = "";
  const decoder = new TextDecoder();
  for await (const part of r.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let c: Chunk;
      try { c = JSON.parse(data) as Chunk; } catch { continue; }
      const t = c.choices?.[0]?.delta?.content ?? "";
      if (t) { text += t; onDelta(t); }
      if (c.usage) { input = tokens(c.usage.prompt_tokens); output = tokens(c.usage.completion_tokens); }
    }
  }
  return { text, input, output };
}

async function openaiText(system: string, user: string, model: string) {
  const p = await getProvider("openai");
  const cred = p?.enabled ? await useCredential("openai", { excludeLabel: VERTEX_LABEL }).catch(() => null) : null;
  if (!p || !cred) throw new Error("no OpenAI key in the vault");
  const base = (p.upstream_url ?? "https://api.openai.com").replace(/\/$/, "").replace(/\/v1$/, "");
  const auth = { [p.auth_header]: `${p.auth_prefix}${cred.secret}` };
  const r = await fetch(`${base}/v1/chat/completions`, { method: "POST", signal: AbortSignal.timeout(90_000),
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ model, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
  if (!r.ok) throw new Error(`OpenAI answered ${r.status}`);
  const out = await r.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return { text: out.choices?.[0]?.message?.content ?? "", input: tokens(out.usage?.prompt_tokens), output: tokens(out.usage?.completion_tokens) };
}

async function anthropicText(system: string, user: string, maxTokens: number): Promise<{ text: string; input: number; output: number }> {
  const p = await getProvider("anthropic");
  const direct = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  const onVertex = async (cfg: VertexConfig | undefined, credentialProvider?: string, noKey?: string) => {
    const cred = await useVertexCredential("anthropic", credentialProvider)
      .catch((e) => { throw noKey ? new Error(`${noKey} (${(e as Error).message})`) : e; });
    const v = vertexConfig(cfg, cred.secret, settingText("VERTEX_REGION"));
    const auth = { "content-type": "application/json", authorization: `Bearer ${await vertexAccessToken(cred.id, cred.secret)}` };
    return anthropicCall("", auth, (payload) => toVertex(v, "/v1/messages", Buffer.from(JSON.stringify(payload))));
  };
  if (p?.enabled && p.backend === "vertex") return onVertex(p.backend_config, (p.backend_config as VertexConfig)?.credential_provider);
  // The vault's Anthropic key; without one, Claude on Vertex AI with the vault's Vertex service account.
  const cred = p?.enabled && p.upstream_url ? await useCredential("anthropic", { excludeLabel: VERTEX_LABEL }).catch(() => null) : null;
  if (cred) return anthropicCall(`${p!.upstream_url!.replace(/\/$/, "")}/v1/messages`, { ...direct, [p!.auth_header]: `${p!.auth_prefix}${cred.secret}` });
  return onVertex(undefined, undefined, "no Anthropic key in the vault");

  /** One Messages call; `rewrite` turns the request into Vertex's URL and body. */
  async function anthropicCall(url: string, headers: Record<string, string>, rewrite?: (payload: object) => { url: string; body: string }) {
    const payload = { model: MODEL(), max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] };
    const req = rewrite ? rewrite(payload) : { url, body: JSON.stringify(payload) };
    const r = await fetch(req.url, { method: "POST", headers, body: req.body, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`Anthropic answered ${r.status}`);
    const out = await r.json() as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    return { text: (out.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""), input: tokens(out.usage?.input_tokens), output: tokens(out.usage?.output_tokens) };
  }
}
