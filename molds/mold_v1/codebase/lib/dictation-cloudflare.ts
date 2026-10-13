/**
 * Speech to text on Cloudflare Workers AI, for dictation (lib/dictation.ts).
 *
 * Uses the credentials the chat's models already use (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN; agent/lib/model.ts),
 * so a deployment that runs on Workers AI gets dictation without a new secret. The call is Workers AI's REST "run"
 * endpoint, in the shape the deployment's model takes (lib/dictation-models.ts lists the models and their three shapes):
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/<model>
 *   whisper-json: { "audio": "<base64>", "task": "transcribe", "vad_filter": true, "language"?: "en" }
 *     -> { "success": true, "result": { "text": "...", "transcription_info": { "duration": 12.3, ... } } }
 *   audio-body:   the clip as the body -> { "success": true, "result": { "text": "...", "words": [...] } }
 *   deepgram:     the clip as the body, ?smart_format=true&language=en (or detect_language=true)
 *     -> { "success": true, "result": { "results": { "channels": [{ "alternatives": [{ "transcript": "..." }] }] } } }
 *
 * (Input and output schemas: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/, read on
 * 2026-10-11; /whisper/ and /nova-3/, 2026-10-12.) `vad_filter` drops silent stretches before decoding, which is where
 * Whisper invents a "Thank you." on a quiet clip; `duration` is still the ORIGINAL clip's length, which is what the
 * usage row records. A shape that reports no clip length leaves it null, and the recorder's stated length is used.
 *
 * Works the same from Vercel and from a self-hosted server: a plain HTTPS call, no browser speech API. The token is
 * sent only in the Authorization header and never appears in an error this throws.
 */
import type { TranscribeInput, Transcriber, Transcript } from "./dictation.ts";
import { type SpeechApi, speechModel } from "./dictation-models.ts";

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
/** A clip of two minutes is transcribed in a few seconds; past this the call is abandoned and the person told. */
export const TRANSCRIBE_TIMEOUT_MS = 60_000;

export interface CloudflareTranscriberOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const envTrim = (v: string | undefined) => v?.trim() || undefined;

/** The production transcriber, or null when the credentials are not set (dictation is then off). */
export function cloudflareTranscriberFromEnv(env: Record<string, string | undefined> = process.env): Transcriber | null {
  const accountId = envTrim(env.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = envTrim(env.CLOUDFLARE_API_TOKEN);
  if (!accountId || !apiToken) return null;
  return cloudflareTranscriber({ accountId, apiToken });
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

type Parsed = { success?: boolean; errors?: { message?: string }[]; result?: Record<string, unknown> } | null;

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The text and clip length out of a successful answer, per the model's response shape (lib/dictation-models.ts). */
function readResult(api: SpeechApi, result: Record<string, unknown>): Transcript {
  if (api === "deepgram") {
    const results = result.results as { channels?: { alternatives?: { transcript?: unknown }[] }[] } | undefined;
    const transcript = results?.channels?.[0]?.alternatives?.[0]?.transcript;
    const metadata = result.metadata as { duration?: unknown } | undefined;
    return { text: typeof transcript === "string" ? transcript : "", durationSeconds: finite(metadata?.duration) };
  }
  const text = typeof result.text === "string" ? result.text : "";
  if (api === "audio-body") return { text, durationSeconds: null }; // word timings only, never the clip's length
  const info = result.transcription_info as { duration?: unknown } | undefined;
  return { text, durationSeconds: finite(info?.duration) };
}

export function cloudflareTranscriber(options: CloudflareTranscriberOptions): Transcriber {
  const doFetch = options.fetch ?? fetch;
  const base = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
  return {
    async transcribe(input: TranscribeInput): Promise<Transcript> {
      // Fail closed: a model this app does not know how to call is never sent a guessed request.
      const row = speechModel(input.model);
      if (!row) throw new Error(`${input.model} is not a speech model dictation can call (lib/dictation-models.ts)`);
      // The model id goes into the path as it is written (`@cf/openai/whisper-large-v3-turbo`): that is the route.
      let url = `${base}/accounts/${encodeURIComponent(options.accountId)}/ai/run/${input.model}`;
      let body: BodyInit;
      let contentType: string;
      if (row.api === "whisper-json") {
        const json: Record<string, unknown> = { audio: base64(input.audio), task: "transcribe", vad_filter: true };
        if (input.language) json.language = input.language;
        body = JSON.stringify(json);
        contentType = "application/json";
      } else {
        // The clip itself, labelled with the recorder's own type (codec parameters and all).
        body = new Uint8Array(input.audio);
        contentType = input.mimeType || "application/octet-stream";
        if (row.api === "deepgram") {
          const q = new URLSearchParams({ smart_format: "true" });
          if (input.language) q.set("language", input.language);
          else q.set("detect_language", "true");
          url += `?${q}`;
        }
      }
      const res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiToken}`, "content-type": contentType },
        body,
        signal: AbortSignal.timeout(options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS),
      });
      const raw = await res.text();
      let parsed: Parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!res.ok || !parsed || parsed.success === false || !parsed.result || typeof parsed.result !== "object") {
        const said = parsed?.errors?.map((e) => e.message).filter(Boolean).join("; ");
        throw new Error(`Workers AI answered ${res.status}${said ? `: ${said}` : ""}`);
      }
      return readResult(row.api, parsed.result);
    },
  };
}
