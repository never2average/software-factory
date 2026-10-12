/**
 * The composer's dictation rules that run in the BROWSER: the limits in plain words, the clock, where dictated text
 * goes in the box, what a microphone failure is called, and what the recorder asks for. The server's rules and the
 * profile's settings are lib/dictation.ts, which re-exports all of this.
 *
 * NO IMPORTS, on purpose. app/_components/dictation-button.tsx loads on demand (React.lazy), and a lazily loaded
 * module that imports something the chat's first load also holds (the deployment profile, the storage helpers, the
 * UI kit) makes the bundler split that shared module into a chunk of its own: one more first-load file on every page
 * and a few KB more brotli (scripts/check-bundle-budget.mjs measured it), more than the recorder it kept out.
 */

/** The recorder's bit rate: speech at 32 kbps Opus is clear, and two minutes is about 0.5 MB. */
export const RECORDER_BITS_PER_SECOND = 32_000;
/** The containers the button asks MediaRecorder for, best first (Chromium and Firefox: WebM/Ogg Opus; Safari: MP4). */
export const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"] as const;

/** What the server says to the button: whether to show it, and the limits to show and keep to. */
export interface DictationCapability {
  readonly enabled: boolean;
  readonly max_seconds: number;
  readonly max_bytes: number;
}
/** "2 minutes", "90 seconds", "1 minute". */
export function lengthText(seconds: number): string {
  if (seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} seconds`;
}

/** "4 MB", "512 KB". */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

/** m:ss */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}


/* ---- the button's rules ------------------------------------------------------------------------------------------ */

/**
 * `text` inserted into `value` over the selection [start, end), spaced from its neighbours: a space before it unless
 * it starts the box or follows whitespace, and one after unless it ends the box or meets whitespace. Returns the new
 * value and where the caret goes (just after the inserted text).
 */
export function insertDictated(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  const words = text.trim();
  if (!words) return { value, caret: e };
  const before = value.slice(0, s);
  const after = value.slice(e);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = after === "" || /^\s/.test(after) ? "" : " ";
  const inserted = `${lead}${words}${trail}`;
  return { value: before + inserted + after, caret: before.length + lead.length + words.length };
}

/** A recording or permission failure in plain words, from the error the browser raised. */
export function microphoneErrorText(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow the microphone for this site in your browser's settings, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Connect one and try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "The microphone could not be started. Close any other app using it and try again.";
  }
  return "Recording could not start. Try again, or type your message.";
}

export const UNSUPPORTED_TEXT = "This browser can't record audio here. Type your message instead.";
export const NO_SPEECH_TEXT = "No speech was heard. Try again a little closer to the microphone.";
