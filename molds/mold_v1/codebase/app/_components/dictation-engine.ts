/**
 * Dictation's listening: the microphone, the level the button beats to, the cut into sections, and each section's
 * trip to the server and back. No drawing here (app/_components/dictation-button.tsx) and no rules of its own: the cut
 * is lib/dictation-segmenter.ts, the order is lib/dictation-order.ts, the limits are the server's
 * (GET /api/ops/dictation).
 *
 * Loaded on the FIRST press of the microphone, never with the page or the button: a person who does not dictate never
 * downloads it.
 *
 * How the audio is taken, and why: raw samples from the Web Audio graph (an AudioWorklet, public/
 * dictation-capture.worklet.js; a ScriptProcessorNode where a browser has no worklet or the worklet's file cannot
 * load), brought down to 16 kHz and written as one small WAV per section. Not MediaRecorder: see lib/
 * dictation-segmenter.ts. Chromium, Firefox and Safari (desktop and iOS, 14.5 and later) all run this path; an older
 * browser gets the ScriptProcessorNode, which every browser with a microphone has.
 *
 * Imports the three import-free lib modules only, for the reason lib/dictation-text.ts gives.
 */
import { createOrderBuffer } from "@/lib/dictation-order";
import { createDownsampler, createSegmenter, encodeWav, type Section } from "@/lib/dictation-segmenter";
import {
  type DictationCapability,
  MAX_UPLOADS_AT_ONCE,
  microphoneErrorText,
  SECTION_FAILED_TEXT,
  SEND_FAILED_TEXT,
  sizeText,
  STALLED_TEXT,
  UNSUPPORTED_TEXT,
} from "@/lib/dictation-text";

/** Served from this origin (public/): the content-security policy takes scripts from nowhere else. */
export const WORKLET_PATH = "/dictation-capture.worklet.js";
/** The longest section, whatever the profile's per-clip limit allows: text should keep arriving. */
const SECTION_HARD_MAX_MS = 10_000;
const SECTION_SOFT_MAX_MS = 8_000;
/** No sample at all this long after the microphone came on: the audio never started. */
const STALL_MS = 3_000;

/**
 * Why listening ended. "stopped": the person (release, click, Escape). "discarded": a tap, nothing is sent. "quiet":
 * hands-free listening heard nothing for `idle_stop_seconds`. "limit": `max_session_seconds`, here or on the server.
 * "failed": the microphone could not be started.
 */
export type StopReason = "stopped" | "discarded" | "quiet" | "limit" | "failed";

export interface ListenOptions {
  readonly capability: DictationCapability;
  /** Where sections go (POST /api/ops/dictation). */
  readonly path: string;
  readonly authHeaders: () => Record<string, string>;
  /** Hands-free (latched) from the start. */
  readonly handsFree: boolean;
  /** False under prefers-reduced-motion: the level is not read, since nothing moves to it. */
  readonly animate: boolean;
  /** The microphone is live. */
  onReady(): void;
  /** 0 to 1, each animation frame. */
  onLevel(level: number): void;
  onSpeaking(speaking: boolean): void;
  /** A section's text, always in the order spoken. */
  onText(text: string): void;
  /** Sections sent and not yet answered. */
  onPending(count: number): void;
  /** Something to tell the person, in plain words. At most one per stretch of listening. */
  onProblem(text: string): void;
  /** The microphone is off. Sections may still be out. */
  onStopped(reason: StopReason): void;
  /** The microphone is off and every section is answered. */
  onSettled(summary: { reason: StopReason; sections: number; words: boolean; problem: boolean }): void;
}

export interface Listening {
  stop(reason?: StopReason): void;
  setHandsFree(on: boolean): void;
  /** Groups this stretch of listening's sections on the server (usage, the session limit). */
  readonly sessionId: string;
}

type AudioContextClass = typeof AudioContext;
const audioContextClass = (): AudioContextClass | undefined =>
  typeof window === "undefined" ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext);

export function listeningSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function" && audioContextClass() !== undefined;
}

function newSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined") crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function startListening(o: ListenOptions): Listening {
  const { capability } = o;
  const sessionId = newSessionId();
  const order = createOrderBuffer<string>();
  const hardMaxMs = Math.min(SECTION_HARD_MAX_MS, capability.max_seconds * 1000);
  const sessionMs = capability.max_session_seconds * 1000;
  const idleMs = capability.idle_stop_seconds * 1000;

  let state: "starting" | "listening" | "stopped" = "starting";
  let reason: StopReason = "stopped";
  let handsFree = o.handsFree;
  let discarded = false;
  let sections = 0;
  let pending = 0;
  let inFlight = 0;
  let words = false;
  let problem = false;
  let settled = false;
  let speaking = false;
  const queue: Section[] = [];
  let teardown: () => void = () => {};
  /** Asked after an await: `state` may have moved on while it waited. */
  const isStopped = () => state === "stopped";

  const say = (text: string) => {
    if (problem) return;
    problem = true;
    o.onProblem(text);
  };

  function finishIfSettled(): void {
    if (state !== "stopped" || pending > 0 || settled) return;
    settled = true;
    o.onSettled({ reason, sections, words, problem });
  }

  function answered(seq: number, text: string | null): void {
    for (const ready of order.settle(seq, text)) {
      words = true;
      o.onText(ready);
    }
    pending--;
    o.onPending(pending);
    finishIfSettled();
  }

  async function send(section: Section): Promise<void> {
    inFlight++;
    let text: string | null = null;
    try {
      const wav = encodeWav(section.samples);
      if (wav.byteLength > capability.max_bytes) {
        say(`That recording is larger than ${sizeText(capability.max_bytes)}. Record a shorter one.`);
      } else {
        const form = new FormData();
        form.append("audio", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
        form.append("duration_ms", String(section.durationMs));
        form.append("session_id", sessionId);
        form.append("seq", String(section.seq));
        const res = await fetch(o.path, { method: "POST", headers: o.authHeaders(), body: form });
        const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string; code?: string };
        if (res.ok) text = body.text?.trim() || null;
        else {
          say(body.error ?? SECTION_FAILED_TEXT);
          // The server's own count of this stretch of listening is used up: stop asking it.
          if (body.code === "session_limit") stop("limit");
        }
      }
    } catch {
      say(SEND_FAILED_TEXT);
    } finally {
      inFlight--;
    }
    answered(section.seq, discarded ? null : text);
    pump();
  }

  function pump(): void {
    while (inFlight < MAX_UPLOADS_AT_ONCE && queue.length > 0) void send(queue.shift()!);
  }

  const segmenter = createSegmenter(
    { hardMaxMs, softMaxMs: Math.min(SECTION_SOFT_MAX_MS, hardMaxMs * 0.8), keepUnvoiced: true },
    (section) => {
      if (discarded) return;
      sections++;
      pending++;
      o.onPending(pending);
      queue.push(section);
      pump();
    },
  );

  function stop(why: StopReason = "stopped"): void {
    if (state === "stopped") return;
    const was = state;
    state = "stopped";
    reason = why;
    if (why === "discarded" || why === "failed") {
      discarded = true;
      // Sections that never left are given up on, so nothing waits for them.
      for (const s of queue.splice(0)) answered(s.seq, null);
    } else if (was === "listening") {
      // Press-to-talk that heard nothing it recognised as a voice still sends what it has (lib/dictation-segmenter.ts).
      segmenter.flush(why === "stopped" && !handsFree);
    }
    teardown();
    if (speaking) {
      speaking = false;
      o.onSpeaking(false);
    }
    o.onLevel(0);
    o.onStopped(why);
    finishIfSettled();
  }

  function heard(block: Float32Array, down: (input: Float32Array) => Float32Array): void {
    if (state !== "listening") return;
    segmenter.push(down(block));
    if (segmenter.speaking !== speaking) {
      speaking = segmenter.speaking;
      o.onSpeaking(speaking);
    }
    if (segmenter.totalMs >= sessionMs) stop("limit");
    else if (handsFree && !segmenter.speaking && segmenter.quietMs >= idleMs) stop("quiet");
  }

  void (async () => {
    // The context is made NOW, in the same turn as the press, before the microphone is asked for: a browser that only
    // starts audio from a person's gesture (Safari, iOS above all) counts this as one.
    let ctx: AudioContext | null = null;
    try {
      ctx = new (audioContextClass()!)();
      void ctx.resume().catch(() => {});
    } catch {
      ctx = null;
    }
    const closeContext = () => void ctx?.close().catch(() => {});
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      closeContext();
      if (!isStopped()) {
        say(microphoneErrorText(e));
        stop("failed");
      }
      return;
    }
    const release = () => stream.getTracks().forEach((track) => track.stop());
    if (isStopped()) {
      closeContext();
      return release();
    }

    let frame = 0;
    let guard: ReturnType<typeof setInterval> | null = null;
    teardown = () => {
      if (frame) cancelAnimationFrame(frame);
      if (guard) clearInterval(guard);
      release();
      closeContext();
    };
    try {
      if (!ctx) throw new Error("no audio context");
      // Again now that the microphone is on, which is what some browsers wait for. Not awaited: a context a browser
      // will not start yet leaves this pending for good.
      void ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const down = createDownsampler(ctx.sampleRate);
      // Nothing is played back: the graph only has to reach the output for the browser to run it.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      let tap: AudioNode | null = null;
      if (ctx.audioWorklet && typeof AudioWorkletNode === "function") {
        try {
          await ctx.audioWorklet.addModule(WORKLET_PATH);
          const node = new AudioWorkletNode(ctx, "dictation-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
          node.port.onmessage = (event: MessageEvent<Float32Array>) => heard(event.data, down);
          tap = node;
        } catch {
          tap = null;
        }
      }
      if (!tap) {
        const node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (event) => heard(new Float32Array(event.inputBuffer.getChannelData(0)), down);
        tap = node;
      }
      if (isStopped()) return teardown();
      source.connect(tap);
      tap.connect(sink);

      state = "listening";
      const startedAt = performance.now();
      const running = ctx;
      guard = setInterval(() => {
        const now = performance.now();
        // The limit by the clock too, should the audio stop arriving while the microphone is held.
        if (now - startedAt >= sessionMs + 1_000) return stop("limit");
        // The microphone is on and nothing is coming through it: the browser has not started the audio. Ask again;
        // if it still will not, say so rather than listen to nothing.
        if (segmenter.totalMs === 0 && now - startedAt >= STALL_MS) {
          say(STALLED_TEXT);
          stop("failed");
        } else if (segmenter.totalMs === 0) void running.resume().catch(() => {});
      }, 500);
      if (o.animate) {
        const wave = new Uint8Array(analyser.fftSize);
        let shown = 0;
        const beat = () => {
          analyser.getByteTimeDomainData(wave);
          let sum = 0;
          for (const v of wave) sum += ((v - 128) / 128) ** 2;
          // A speaking voice is around 0.05 to 0.2 RMS: scaled to fill the ring, rising at once and falling gently.
          const now = Math.min(1, Math.sqrt(sum / wave.length) * 6);
          shown = now > shown ? now : shown * 0.88;
          o.onLevel(shown);
          frame = requestAnimationFrame(beat);
        };
        frame = requestAnimationFrame(beat);
      }
      o.onReady();
    } catch {
      if (!isStopped()) {
        say(UNSUPPORTED_TEXT);
        stop("failed");
      } else teardown();
    }
  })();

  return {
    stop,
    setHandsFree(on) {
      handsFree = on;
    },
    sessionId,
  };
}
