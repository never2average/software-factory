/**
 * Speech to text on Cloudflare Workers AI, for dictation (lib/dictation.ts).
 *
 * Uses the credentials the chat's models already use (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN; agent/lib/model.ts),
 * so a deployment that runs on Workers AI gets dictation without a new secret. The call is Workers AI's REST "run"
 * endpoint, which every Whisper model on the platform takes:
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/<model>
 *   { "audio": "<base64>", "task": "transcribe", "vad_filter": true, "language"?: "en" }
 *   -> { "success": true, "result": { "text": "...", "transcription_info": { "duration": 12.3, ... } } }
 *
 * (Input and output schemas: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/, read on
 * 2026-10-11.) `vad_filter` drops silent stretches before decoding, which is where Whisper invents a "Thank you." on
 * a quiet clip; `duration` is still the ORIGINAL clip's length, which is what the usage row records.
 *
 * Works the same from Vercel and from a self-hosted server: a plain HTTPS call, no browser speech API. The token is
 * sent only in the Authorization header and never appears in an error this throws.
 */
import type { TranscribeInput, Transcriber, Transcript } from "./dictation.ts";

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

export function cloudflareTranscriber(options: CloudflareTranscriberOptions): Transcriber {
  const doFetch = options.fetch ?? fetch;
  const base = (options.baseUrl ?? CLOUDFLARE_API_BASE).replace(/\/+$/, "");
  return {
    async transcribe(input: TranscribeInput): Promise<Transcript> {
      // The model id goes into the path as it is written (`@cf/openai/whisper-large-v3-turbo`): that is the route.
      const url = `${base}/accounts/${encodeURIComponent(options.accountId)}/ai/run/${input.model}`;
      const body: Record<string, unknown> = { audio: base64(input.audio), task: "transcribe", vad_filter: true };
      if (input.language) body.language = input.language;
      const res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS),
      });
      const raw = await res.text();
      let parsed: {
        success?: boolean;
        errors?: { message?: string }[];
        result?: { text?: unknown; transcription_info?: { duration?: unknown } };
      } | null = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!res.ok || !parsed || parsed.success === false || !parsed.result) {
        const said = parsed?.errors?.map((e) => e.message).filter(Boolean).join("; ");
        throw new Error(`Workers AI answered ${res.status}${said ? `: ${said}` : ""}`);
      }
      const text = typeof parsed.result.text === "string" ? parsed.result.text : "";
      const duration = parsed.result.transcription_info?.duration;
      return { text, durationSeconds: typeof duration === "number" && Number.isFinite(duration) ? duration : null };
    },
  };
}
