/**
 * DICTATION: SPEECH TO TEXT FOR WRITING A PROMPT. Never a spoken reply, never sent on its own.
 *
 * The chat composer's microphone button (app/_components/dictation-button.tsx) records a short clip with the
 * browser's MediaRecorder and posts it to `POST /api/ops/dictation`. The route hands it to the deployment's
 * speech-to-text model (profiles: `asr`), returns the text, and the button puts that text into the message box at the
 * cursor, where the person edits it and sends it themselves. Nothing here sends a message.
 *
 * What this module holds, so one set of rules serves the route, the button and the tests:
 *   - the settings, from the deployment profile (`asr`): on or off, provider, model, language, the two limits;
 *   - `createDictationHandler(deps)`: the route's GET and POST, with every dependency (who is calling and in which
 *     workspace, the transcriber, the usage ledger) passed in, so scripts/test-dictation.mjs drives the real handler
 *     with fakes and no network, database or Next runtime;
 *   - the plain-words texts and the insert-at-cursor rule the button uses.
 *
 * THE LIMITS ARE CHECKED TWICE ON THE SERVER, before and after the paid call. Before: the upload's size
 * (`max_bytes`) and the length the recorder states (`duration_ms`, which the button sends and which an honest client
 * cannot exceed: it stops itself at `max_seconds`). After: the length the MODEL measured. A clip that turns out longer
 * than the limit has been paid for, so its usage is recorded, and its text is refused: the limit is a limit, not a
 * suggestion to clients that tell the truth.
 *
 * NO AUDIO IS KEPT. The clip is read into memory, sent to the provider and dropped with the request: no data-room
 * write, no blob, no file, no log line carrying it. The usage row records how long it was, never what was said.
 *
 * Client-safe: imports only the generated profile (plain data). Relative `.ts` specifiers, so it also runs under
 * plain `node --experimental-strip-types`.
 */
import { DEPLOYMENT_PROFILE } from "./deployment-profile.generated.ts";
import { type DictationCapability, lengthText, sizeText } from "./dictation-text.ts";

// The browser-side rules (texts, the clock, insert-at-cursor, the recorder's settings), kept import-free there.
export * from "./dictation-text.ts";

export interface DictationSettings {
  /** The profile's switch. The button also needs the provider's credentials on the server (`transcriber`). */
  readonly enabled: boolean;
  readonly provider: "cloudflare";
  readonly model: string;
  /** ISO 639-1, or null for the model to detect it. */
  readonly language: string | null;
  readonly maxSeconds: number;
  readonly maxBytes: number;
}

export const DICTATION_SETTINGS: DictationSettings = Object.freeze({
  enabled: DEPLOYMENT_PROFILE.asr.enabled,
  provider: DEPLOYMENT_PROFILE.asr.provider,
  model: DEPLOYMENT_PROFILE.asr.model,
  language: DEPLOYMENT_PROFILE.asr.language,
  maxSeconds: DEPLOYMENT_PROFILE.asr.max_seconds,
  maxBytes: DEPLOYMENT_PROFILE.asr.max_bytes,
});

/**
 * A recorder's stop and a container's own framing put a clip's measured length a little past the moment the button
 * stopped it. A clip is refused only past the limit by more than this.
 */
export const LENGTH_GRACE_MS = 2_000;
/** Multipart framing around the clip; a request whose stated length is past max_bytes by more is refused unread. */
export const FORM_OVERHEAD_BYTES = 64 * 1024;

export interface Transcript {
  readonly text: string;
  /** The audio's length as the model measured it, in seconds, or null when it did not say. */
  readonly durationSeconds: number | null;
}

export interface TranscribeInput {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly model: string;
  readonly language: string | null;
}

/** One speech-to-text provider (lib/dictation-cloudflare.ts is the production one). */
export interface Transcriber {
  transcribe(input: TranscribeInput): Promise<Transcript>;
}

/** Who is dictating, and in which workspace: from the verified sign-in, never from the request body. */
export interface DictationCaller {
  readonly orgId: string;
  readonly email: string | null;
}

/** One dictation's usage row (`chat_turn_usage`, kind "dictation"). */
export interface DictationUsage {
  readonly id: string;
  readonly orgId: string;
  readonly actorEmail: string | null;
  readonly model: string;
  readonly audioMs: number;
  readonly at: Date;
}

export interface DictationDeps {
  readonly settings: DictationSettings;
  /** Null when the provider's credentials are not set: dictation is then off, and the button hidden. */
  readonly transcriber: Transcriber | null;
  /**
   * The caller's workspace and email. Null = not signed in (401). A Response is a refusal to pass on as it is (a
   * request naming a workspace the caller is not a member of: 403, never served from another workspace).
   */
  authorize(request: Request): Promise<DictationCaller | Response | null>;
  /** Write the usage row in the caller's workspace. A failure is logged; the person still gets their text. */
  recordUsage(row: DictationUsage): Promise<void>;
  newId(): string;
  now(): Date;
  error(message: string, error: unknown): void;
}

export interface DictationHandler {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Is this an audio upload the providers take? MediaRecorder's own types, with their codec parameters. */
export function isAudioType(type: string): boolean {
  const base = type.split(";")[0]!.trim().toLowerCase();
  // Chromium has labelled an audio-only WebM recording "video/webm"; the container is the same.
  return base.startsWith("audio/") || base === "video/webm" || base === "video/mp4";
}

function statedDurationMs(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export function createDictationHandler(deps: DictationDeps): DictationHandler {
  const { settings } = deps;
  const available = () => settings.enabled && deps.transcriber !== null;
  const maxMs = settings.maxSeconds * 1000;
  const tooLong = () =>
    json({ error: `That recording is longer than ${lengthText(settings.maxSeconds)}. Record a shorter one.`, code: "too_long" }, 413);
  const tooBig = () =>
    json({ error: `That recording is larger than ${sizeText(settings.maxBytes)}. Record a shorter one.`, code: "too_large" }, 413);

  async function caller(request: Request): Promise<DictationCaller | Response> {
    const who = await deps.authorize(request);
    if (who === null) return json({ error: "Sign in to continue." }, 401);
    return who;
  }

  return {
    async GET(request) {
      const who = await caller(request);
      if (who instanceof Response) return who;
      const body: DictationCapability = { enabled: available(), max_seconds: settings.maxSeconds, max_bytes: settings.maxBytes };
      return json(body);
    },

    async POST(request) {
      const who = await caller(request);
      if (who instanceof Response) return who;
      if (!available()) return json({ error: "Dictation is turned off here.", code: "unavailable" }, 404);

      // Refused unread when the request says it is too big: the body is never buffered.
      const stated = Number(request.headers.get("content-length") ?? "");
      if (Number.isFinite(stated) && stated > settings.maxBytes + FORM_OVERHEAD_BYTES) return tooBig();

      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        return json({ error: "Expected a recording (multipart/form-data with an `audio` field)." }, 400);
      }
      const audio = form.get("audio");
      if (!audio || typeof audio === "string") return json({ error: "Missing the recording (`audio`)." }, 400);
      if (audio.size === 0) return json({ error: "The recording was empty. Try again.", code: "empty" }, 400);
      if (audio.size > settings.maxBytes) return tooBig();
      if (!isAudioType(audio.type || "")) return json({ error: "That file is not a recording this can transcribe.", code: "unsupported_type" }, 415);
      const statedMs = statedDurationMs(form.get("duration_ms"));
      if (statedMs !== null && statedMs > maxMs + LENGTH_GRACE_MS) return tooLong();

      // In memory for the length of this request only: never written anywhere.
      const bytes = new Uint8Array(await audio.arrayBuffer());
      let transcript: Transcript;
      try {
        transcript = await deps.transcriber!.transcribe({
          audio: bytes,
          mimeType: audio.type,
          model: settings.model,
          language: settings.language,
        });
      } catch (error) {
        deps.error("[dictation] transcription failed:", error);
        return json({ error: "The recording could not be turned into text. Try again, or type your message.", code: "provider_failed" }, 502);
      }

      // What it is billed on: the model's measurement when it gives one, else what the recorder stated.
      const measuredMs =
        transcript.durationSeconds !== null && Number.isFinite(transcript.durationSeconds) && transcript.durationSeconds >= 0
          ? Math.round(transcript.durationSeconds * 1000)
          : statedMs;
      try {
        await deps.recordUsage({
          id: deps.newId(),
          orgId: who.orgId,
          actorEmail: who.email,
          model: settings.model,
          audioMs: measuredMs ?? 0,
          at: deps.now(),
        });
      } catch (error) {
        deps.error("[dictation] usage could not be recorded:", error);
      }
      if (measuredMs !== null && measuredMs > maxMs + LENGTH_GRACE_MS) return tooLong();

      return json({ text: transcript.text.replace(/\s+/g, " ").trim(), duration_ms: measuredMs });
    },
  };
}
