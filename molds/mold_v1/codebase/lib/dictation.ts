/**
 * DICTATION: SPEECH TO TEXT FOR WRITING A PROMPT. Never a spoken reply, never sent on its own.
 *
 * The chat composer's microphone button (app/_components/dictation-button.tsx) listens while it is held (or, after a
 * double-click, until it is clicked again), cuts what it hears into SECTIONS at the natural pauses
 * (lib/dictation-segmenter.ts) and posts each one, as it closes, to `POST /api/ops/dictation`. The route hands it to
 * the deployment's speech-to-text model (profiles: `asr`), returns the text, and the button puts that text into the
 * message box at the cursor, in the order spoken (lib/dictation-order.ts), where the person edits it and sends it
 * themselves. Nothing here sends a message.
 *
 * ONE REQUEST IS ONE CLIP, as it always was: a section is a complete audio file, and a client that sends a single
 * recording with no `session_id` is served exactly as before. A section also says which stretch of listening it
 * belongs to (`session_id`, the browser's own random id) and where in it (`seq`). The server uses the two for three
 * things only: the usage row is filed under them (so a stretch's sections group, and a resent section is not a second
 * row), the stretch's audio is bounded (`max_session_seconds`), and so is how fast it may send
 * (SESSION_SECTIONS_PER_MINUTE). The ORDER of the text is the browser's business: answers are independent.
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
  /** The longest single clip (a section). */
  readonly maxSeconds: number;
  readonly maxBytes: number;
  /** The most audio one stretch of listening (a `session_id`) may have transcribed. */
  readonly maxSessionSeconds: number;
  /** How long hands-free listening waits in silence before the button stops it (the browser keeps this one). */
  readonly idleStopSeconds: number;
}

export const DICTATION_SETTINGS: DictationSettings = Object.freeze({
  enabled: DEPLOYMENT_PROFILE.asr.enabled,
  provider: DEPLOYMENT_PROFILE.asr.provider,
  model: DEPLOYMENT_PROFILE.asr.model,
  language: DEPLOYMENT_PROFILE.asr.language,
  maxSeconds: DEPLOYMENT_PROFILE.asr.max_seconds,
  maxBytes: DEPLOYMENT_PROFILE.asr.max_bytes,
  maxSessionSeconds: DEPLOYMENT_PROFILE.asr.max_session_seconds,
  idleStopSeconds: DEPLOYMENT_PROFILE.asr.idle_stop_seconds,
});

/**
 * A recorder's stop and a container's own framing put a clip's measured length a little past the moment the button
 * stopped it. A clip is refused only past the limit by more than this.
 */
export const LENGTH_GRACE_MS = 2_000;
/** Multipart framing around the clip; a request whose stated length is past max_bytes by more is refused unread. */
export const FORM_OVERHEAD_BYTES = 64 * 1024;
/**
 * The most sections one stretch of listening may send in any minute. Speech closes a section at a pause of 600 ms or
 * more, so a person talking gives 10 to 20 a minute; past this it is not a person talking.
 */
export const SESSION_SECTIONS_PER_MINUTE = 40;
/** A stretch of listening's id: the browser's random UUID, or any token of this shape. Never a path, never free text. */
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Sections are numbered from 0; ten thousand is far past any stretch the session limit allows. */
const MAX_SEQ = 9_999;

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

/** One clip's usage row (`chat_turn_usage`, kind "dictation"). */
export interface DictationUsage {
  readonly id: string;
  readonly orgId: string;
  readonly actorEmail: string | null;
  readonly model: string;
  readonly audioMs: number;
  readonly at: Date;
  /** The stretch of listening this section belongs to and its place in it; both null for a clip sent on its own. */
  readonly sessionId: string | null;
  readonly seq: number | null;
}

/** What one stretch of listening has used so far, from the usage rows already written for it. */
export interface SessionTotals {
  /** Audio transcribed, in milliseconds. */
  readonly audioMs: number;
  /** Sections transcribed in the last minute. */
  readonly lastMinute: number;
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
  /**
   * What the caller's stretch of listening `sessionId` has used, read in the caller's workspace (another workspace's
   * rows are never counted, whatever id it sends). A failure is logged and the section is served: the limit is a
   * bound on spend, not a reason to lose someone's words when the ledger cannot be read.
   */
  sessionTotals(caller: DictationCaller, sessionId: string, now: Date): Promise<SessionTotals>;
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
  const maxSessionMs = settings.maxSessionSeconds * 1000;

  async function caller(request: Request): Promise<DictationCaller | Response> {
    const who = await deps.authorize(request);
    if (who === null) return json({ error: "Sign in to continue." }, 401);
    return who;
  }

  return {
    async GET(request) {
      const who = await caller(request);
      if (who instanceof Response) return who;
      const body: DictationCapability = {
        enabled: available(),
        max_seconds: settings.maxSeconds,
        max_bytes: settings.maxBytes,
        max_session_seconds: settings.maxSessionSeconds,
        idle_stop_seconds: settings.idleStopSeconds,
      };
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

      // A section of a longer stretch of listening: which stretch, and where in it. Both or neither.
      const rawSession = form.get("session_id");
      const rawSeq = form.get("seq");
      let sessionId: string | null = null;
      let seq: number | null = null;
      if (rawSession !== null || rawSeq !== null) {
        if (typeof rawSession !== "string" || !SESSION_ID.test(rawSession)) return json({ error: "`session_id` must be 8 to 64 letters, digits, - or _.", code: "bad_session" }, 400);
        if (typeof rawSeq !== "string" || !/^\d{1,4}$/.test(rawSeq) || Number(rawSeq) > MAX_SEQ) return json({ error: "`seq` must be a whole number from 0 to 9999, sent with `session_id`.", code: "bad_seq" }, 400);
        sessionId = rawSession;
        seq = Number(rawSeq);
        // Before the paid call: what this stretch has already used. (Sections in flight at the same moment are not
        // yet counted, so a stretch can pass its limit by the few that were: bounded by the browser's three at once.)
        try {
          const used = await deps.sessionTotals(who, sessionId, deps.now());
          if (used.audioMs >= maxSessionMs)
            return json({ error: `That was the limit of ${lengthText(settings.maxSessionSeconds)} of dictation in one go. Press the microphone to start again.`, code: "session_limit" }, 429);
          if (used.lastMinute >= SESSION_SECTIONS_PER_MINUTE)
            return json({ error: "That is more dictation than can be taken in at once. Wait a moment and try again.", code: "rate_limited" }, 429);
        } catch (error) {
          deps.error("[dictation] the session's usage could not be read:", error);
        }
      }

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
          sessionId,
          seq,
        });
      } catch (error) {
        deps.error("[dictation] usage could not be recorded:", error);
      }
      if (measuredMs !== null && measuredMs > maxMs + LENGTH_GRACE_MS) return tooLong();

      const text = transcript.text.replace(/\s+/g, " ").trim();
      // Echoed so a client can match an answer to its section without holding the request.
      return json(sessionId === null ? { text, duration_ms: measuredMs } : { text, duration_ms: measuredMs, session_id: sessionId, seq });
    },
  };
}
