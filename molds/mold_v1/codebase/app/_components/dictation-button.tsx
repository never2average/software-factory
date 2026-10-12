"use client";

/**
 * The composer's microphone: press, speak, stop, and the words land in the message box at the cursor, to edit and send
 * yourself. Never sent on its own; no spoken replies. Rules, limits and texts: lib/dictation-text.ts. Server: POST
 * /api/ops/dictation. Checked by tests/dictation.spec.ts on /preview/user-message.
 *
 * Loaded and drawn only when the server says dictation is on (app/_components/dictation-slot.tsx asks, once per tab):
 * not part of the chat's first load.
 *
 * MediaRecorder in the browser, the deployment's model on the server: no browser speech service, so it behaves the
 * same on Vercel and on a self-hosted server, and in every browser that records audio (Chromium, Firefox, Safari).
 *
 * Keyboard: the button is a real button (Enter or Space). While recording, focus is on Stop; Escape cancels.
 * A screen reader hears the state change once (role=status), not the clock every second.
 */
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import {
  clockText,
  type DictationCapability,
  insertDictated,
  lengthText,
  microphoneErrorText,
  NO_SPEECH_TEXT,
  RECORDER_BITS_PER_SECOND,
  RECORDER_TYPES,
  sizeText,
  UNSUPPORTED_TEXT,
} from "@/lib/dictation-text";

/*
 * Imports React and lib/dictation-text.ts only, and that is load-bearing: this module loads on demand, and importing
 * anything the chat's first load also holds (the UI kit's button, the icon set, the storage helpers, the profile) made
 * the bundler split that module out into one more first-load file on every page (lib/dictation-text.ts says what was
 * measured). So the buttons below carry the composer buttons' own classes (components/ui/button.tsx, ghost; input-group
 * sizes), the icons are drawn here (the icon set's own paths), and the slot hands in the address and the headers.
 */
const BUTTON =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap shadow-none transition-all outline-none " +
  "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 " +
  "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 min-h-9 min-w-9 sm:min-h-8 sm:min-w-8";

const Btn = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly wide?: boolean }>(function Btn(
  { wide = false, className, ...props },
  ref,
) {
  return <button ref={ref} type="button" className={`${BUTTON} ${wide ? "h-8 px-2.5" : "size-8 p-0"} ${className ?? ""}`} {...props} />;
});

function Icon({ d, spin = false }: { readonly d: string[]; readonly spin?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-4${spin ? " animate-spin motion-reduce:animate-none" : ""}`}
    >
      {d.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  );
}
const MIC = ["M12 19v3", "M19 10v2a7 7 0 0 1-14 0v-2", "M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Z"];
const CHECK = ["M20 6 9 17l-5-5"];
const CROSS = ["M18 6 6 18", "m6 6 12 12"];
const SPINNER = ["M21 12a9 9 0 1 1-6.219-8.56"];

type Phase = "idle" | "starting" | "recording" | "transcribing";

function recorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

function pickType(): string | undefined {
  const is = window.MediaRecorder.isTypeSupported?.bind(window.MediaRecorder);
  return is ? RECORDER_TYPES.find((t) => is(t)) : undefined;
}

export function DictationButton({
  capability,
  path,
  authHeaders,
  disabled = false,
}: {
  readonly capability: DictationCapability;
  /** Where to send the clip (POST /api/ops/dictation). */
  readonly path: string;
  /** The bearer and this tab's workspace, as every ops call sends them. */
  readonly authHeaders: () => Record<string, string>;
  readonly disabled?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const live = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: Blob[];
    startedAt: number;
    timer: ReturnType<typeof setInterval>;
    cancelled: boolean;
  } | null>(null);
  const mounted = useRef(true);
  /** After a cancel, focus goes back to the microphone once it is drawn again (it is not while recording). */
  const refocusMic = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const r = live.current;
      if (r) {
        r.cancelled = true;
        clearInterval(r.timer);
        if (r.recorder.state !== "inactive") r.recorder.stop();
        r.stream.getTracks().forEach((track) => track.stop());
        live.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (phase === "recording") stopRef.current?.focus();
    if (phase === "idle" && refocusMic.current) {
      refocusMic.current = false;
      micRef.current?.focus();
    }
  }, [phase]);

  const textarea = () => rootRef.current?.closest("form")?.querySelector("textarea") ?? null;

  /** The words into the box at the cursor (over a selection), focused, caret after them. Never submitted. */
  const insert = useCallback((text: string) => {
    const box = textarea();
    if (!box) return;
    const { value, caret } = insertDictated(box.value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, text);
    // The native setter, so a controlled box (PromptInputProvider) sees the change through its onChange too.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(box, value);
    else box.value = value;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus();
    box.setSelectionRange(caret, caret);
  }, []);

  const transcribe = useCallback(
    async (blob: Blob, durationMs: number) => {
      if (blob.size === 0) {
        setError(NO_SPEECH_TEXT);
        setPhase("idle");
        return;
      }
      if (blob.size > capability.max_bytes) {
        setError(`That recording is larger than ${sizeText(capability.max_bytes)}. Record a shorter one.`);
        setPhase("idle");
        return;
      }
      setPhase("transcribing");
      try {
        const form = new FormData();
        const ext = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
        form.append("audio", blob, `dictation.${ext}`);
        form.append("duration_ms", String(Math.round(durationMs)));
        const res = await fetch(path, { method: "POST", headers: authHeaders(), body: form });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!mounted.current) return;
        if (!res.ok) {
          setError(body.error ?? "The recording could not be turned into text. Try again, or type your message.");
        } else if (!body.text?.trim()) {
          setError(NO_SPEECH_TEXT);
        } else {
          insert(body.text);
        }
      } catch {
        if (mounted.current) setError("The recording could not be sent. Check the connection and try again.");
      } finally {
        if (mounted.current) setPhase("idle");
      }
    },
    [capability, insert, path, authHeaders],
  );

  const finish = useCallback((cancel: boolean) => {
    const r = live.current;
    if (!r) return;
    r.cancelled = cancel;
    clearInterval(r.timer);
    if (r.recorder.state !== "inactive") r.recorder.stop();
    else r.stream.getTracks().forEach((track) => track.stop());
  }, []);

  const start = useCallback(async () => {
    if (phase !== "idle") return;
    setError(null);
    if (!recorderSupported()) {
      setError(UNSUPPORTED_TEXT);
      return;
    }
    setPhase("starting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (mounted.current) {
        setError(microphoneErrorText(e));
        setPhase("idle");
      }
      return;
    }
    if (!mounted.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    let recorder: MediaRecorder;
    const mimeType = pickType();
    try {
      recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: RECORDER_BITS_PER_SECOND });
    } catch {
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        stream.getTracks().forEach((track) => track.stop());
        setError(UNSUPPORTED_TEXT);
        setPhase("idle");
        return;
      }
    }
    const maxMs = capability.max_seconds * 1000;
    const startedAt = performance.now();
    const session = {
      recorder,
      stream,
      chunks: [] as Blob[],
      startedAt,
      cancelled: false,
      timer: setInterval(() => {
        const ms = performance.now() - startedAt;
        setElapsed(ms);
        // The recorder stops itself at the limit; what was said so far is transcribed.
        if (ms >= maxMs) finish(false);
      }, 250),
    };
    live.current = session;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) session.chunks.push(event.data);
    };
    recorder.onstop = () => {
      clearInterval(session.timer);
      stream.getTracks().forEach((track) => track.stop());
      if (live.current === session) live.current = null;
      const durationMs = Math.min(performance.now() - startedAt, maxMs);
      if (!mounted.current) return;
      setElapsed(0);
      if (session.cancelled) {
        refocusMic.current = true;
        setPhase("idle");
        return;
      }
      void transcribe(new Blob(session.chunks, { type: recorder.mimeType || mimeType || "audio/webm" }), durationMs);
    };
    recorder.onerror = () => {
      session.cancelled = true;
      if (mounted.current) setError("Recording stopped unexpectedly. Try again, or type your message.");
      finish(true);
    };
    setElapsed(0);
    recorder.start(1000);
    setPhase("recording");
  }, [capability, phase, finish, transcribe]);

  const limit = lengthText(capability.max_seconds);
  const status =
    phase === "recording"
      ? `Recording. Up to ${limit}. Press Stop to turn it into text, or Escape to cancel.`
      : phase === "transcribing"
        ? "Turning your recording into text…"
        : phase === "starting"
          ? "Starting the microphone…"
          : "";

  return (
    <span
      ref={rootRef}
      className="contents"
      data-testid="dictation"
      data-phase={phase}
      onKeyDown={(e) => {
        if (e.key === "Escape" && phase === "recording") {
          e.preventDefault();
          e.stopPropagation();
          finish(true);
        }
      }}
    >
      {phase === "recording" ? (
        <span className="flex items-center gap-1" data-testid="dictation-recording">
          <span className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-2 py-1 text-red-700 text-xs tabular-nums dark:text-red-400">
            <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-red-600 motion-reduce:animate-none" />
            <span data-testid="dictation-timer" aria-hidden="true">
              {clockText(elapsed)} / {clockText(capability.max_seconds * 1000)}
            </span>
          </span>
          <Btn ref={stopRef} wide onClick={() => finish(false)} aria-label="Stop recording and turn it into text" title="Stop and turn into text">
            <Icon d={CHECK} />
            <span className="text-xs">Stop</span>
          </Btn>
          <Btn onClick={() => finish(true)} aria-label="Cancel recording" title="Cancel (Esc)">
            <Icon d={CROSS} />
          </Btn>
        </span>
      ) : (
        <Btn
          ref={micRef}
          onClick={() => void start()}
          disabled={disabled || phase !== "idle"}
          aria-label={phase === "transcribing" ? "Turning your recording into text" : `Dictate a message (up to ${limit})`}
          title={`Dictate (up to ${limit}). The text goes into the box for you to edit and send.`}
          aria-busy={phase !== "idle"}
        >
          {phase === "idle" ? <Icon d={MIC} /> : <Icon d={SPINNER} spin />}
        </Btn>
      )}
      <span role="status" aria-live="polite" className="sr-only" data-testid="dictation-status">
        {status}
      </span>
      {error ? (
        <span role="alert" data-testid="dictation-error" className="flex basis-full items-start gap-2 px-1 text-amber-800 text-xs dark:text-amber-400">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 rounded px-1.5 py-0.5 hover:bg-amber-500/20"
          >
            Dismiss
          </button>
        </span>
      ) : null}
    </span>
  );
}
