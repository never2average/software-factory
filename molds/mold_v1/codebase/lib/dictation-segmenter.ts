/**
 * Dictation, cut into SECTIONS as the person speaks: the microphone's samples in, one short clip out per stretch of
 * speech, each a complete audio file the speech-to-text model can read on its own.
 *
 * Why sections: the text should arrive while the person is still talking, not after one long recording. A section
 * closes at a natural pause (`silenceMs` of quiet), or, when someone talks without one, at the first short breath past
 * `softMaxMs`, or at `hardMaxMs` whatever is being said. Quiet between sections is never sent (it is not paid for, and
 * a speech model given silence invents words), and a section starts `preRollMs` BEFORE the voice was noticed, so the
 * first consonant is not clipped.
 *
 * Why raw samples and a WAV per section, not a MediaRecorder restarted at each pause: a recorder's stop and start
 * loses the audio in between (tens of milliseconds, mid-word at a length cut), cannot reach back before the voice was
 * noticed, and gives a different container in each browser (WebM or Ogg Opus in Chromium and Firefox, fragmented MP4
 * AAC in Safari, whose first frames carry encoder priming). Samples cut by index lose nothing, and 16 kHz mono 16-bit
 * WAV is the same bytes from every browser and is what the models resample to anyway: 32 KB a second, 320 KB for the
 * longest section, far under every request limit.
 *
 * Voice activity is the input level against a noise floor that follows the room: a section opens after `openMs` of
 * level above `max(minLevel, floor x ratio)`. The floor is the quietest stretch of the last second and a half, so a
 * steady hum (a fan, a street) stops counting as speech within a couple of seconds instead of being sent forever.
 *
 * NO IMPORTS, like lib/dictation-text.ts, and for the same reason; and pure: scripts/test-dictation.mjs drives it with
 * arrays of numbers. The microphone, the AudioContext and the uploads are app/_components/dictation-engine.ts.
 */

/** What every section is sent as: speech models work at 16 kHz mono. */
export const SECTION_SAMPLE_RATE = 16_000;

export interface SegmenterOptions {
  readonly sampleRate?: number;
  /** Quiet this long closes a section. */
  readonly silenceMs?: number;
  /** Past this length a section closes at the first `softSilenceMs` of quiet… */
  readonly softMaxMs?: number;
  readonly softSilenceMs?: number;
  /** …and at this length whatever is being said. */
  readonly hardMaxMs?: number;
  /** Audio kept from before the voice was noticed. */
  readonly preRollMs?: number;
  /** Quiet kept at the end of a section closed by a pause. */
  readonly tailMs?: number;
  /** Level above the threshold for this long opens a section. */
  readonly openMs?: number;
  /** A section with less voice than this is a click or a cough: dropped, never sent. */
  readonly minVoicedMs?: number;
  /** The least level (RMS, 0 to 1) that can count as voice, however quiet the room. */
  readonly minLevel?: number;
  /** Voice is this many times the noise floor. */
  readonly floorRatio?: number;
  /**
   * Keep what was heard (up to `hardMaxMs`) until the first section, so `flush(true)` can send it. Press-to-talk asks
   * for that: if the whole hold closes without one section (a very quiet microphone the threshold never noticed),
   * what was recorded is sent anyway and the model decides, rather than answer a person who did speak with "nothing
   * heard". Hands-free listening flushes without it: there, silence is simply silence.
   */
  readonly keepUnvoiced?: boolean;
}

export interface Section {
  /** 0, 1, 2… in the order spoken: what the text is put back in order by. */
  readonly seq: number;
  readonly samples: Float32Array;
  readonly durationMs: number;
  readonly voicedMs: number;
  /** "pause": a natural pause. "length": cut at the limit. "stop": the person stopped. "unvoiced": see keepUnvoiced. */
  readonly reason: "pause" | "length" | "stop" | "unvoiced";
}

export interface Segmenter {
  /** Samples at `sampleRate`, any number at a time. */
  push(samples: Float32Array): void;
  /** The person stopped: close what is open. `sendUnvoiced`: see `keepUnvoiced`. */
  flush(sendUnvoiced?: boolean): void;
  /** Voice is being heard right now (a section is open). */
  readonly speaking: boolean;
  /** How long since voice was last heard, in ms of audio. */
  readonly quietMs: number;
  /** Audio seen so far, in ms. */
  readonly totalMs: number;
  /** Sections emitted so far. */
  readonly sections: number;
}

const HOP_MS = 20;
const FLOOR_WINDOW_MS = 1_500;
/** However loud the room, a raised voice still counts. */
const MAX_FLOOR = 0.05;

export function level(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
}

export function createSegmenter(options: SegmenterOptions, onSection: (section: Section) => void): Segmenter {
  const rate = options.sampleRate ?? SECTION_SAMPLE_RATE;
  const silenceMs = options.silenceMs ?? 600;
  const hardMaxMs = Math.max(1_000, options.hardMaxMs ?? 10_000);
  const softMaxMs = Math.min(options.softMaxMs ?? 8_000, hardMaxMs);
  const softSilenceMs = options.softSilenceMs ?? 200;
  const preRollMs = options.preRollMs ?? 240;
  const tailMs = options.tailMs ?? 200;
  const openMs = options.openMs ?? 60;
  const minVoicedMs = options.minVoicedMs ?? 120;
  const minLevel = options.minLevel ?? 0.012;
  const floorRatio = options.floorRatio ?? 3;
  const keepUnvoiced = options.keepUnvoiced ?? false;

  const hop = Math.round((rate * HOP_MS) / 1000);
  const ms = (samples: number) => (samples * 1000) / rate;
  const hops = (millis: number) => Math.max(1, Math.round(millis / HOP_MS));

  /** Samples not yet a whole hop. */
  let carry = new Float32Array(0);
  /** Hops not in a section: the pre-roll (or, for keepUnvoiced with nothing sent yet, everything up to hardMaxMs). */
  let waiting: Float32Array[] = [];
  /** How many of `waiting`'s last hops were above the threshold in a row. */
  let loudRun = 0;
  /** The open section's hops, or null between sections. */
  let open: Float32Array[] | null = null;
  let openVoicedHops = 0;
  let openQuietRun = 0;
  /** Levels of the last FLOOR_WINDOW_MS, for the noise floor. */
  const recent: number[] = [];
  let floor = minLevel / floorRatio;
  let seq = 0;
  let total = 0;
  let sinceVoice = 0;

  const keepWaiting = () => (keepUnvoiced && seq === 0 ? hops(hardMaxMs) : hops(preRollMs) + hops(openMs));

  function join(parts: Float32Array[], dropLast = 0): Float32Array {
    const use = dropLast > 0 ? parts.slice(0, Math.max(0, parts.length - dropLast)) : parts;
    const out = new Float32Array(use.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of use) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  function close(reason: Section["reason"]): void {
    if (!open) return;
    const voicedMs = openVoicedHops * HOP_MS;
    // A pause's quiet is cut back to a short tail; a length cut keeps every sample (the next section carries on).
    const drop = reason === "length" ? 0 : Math.max(0, openQuietRun - hops(tailMs));
    const samples = join(open, drop);
    open = null;
    openVoicedHops = 0;
    openQuietRun = 0;
    if (voicedMs < minVoicedMs || samples.length === 0) return;
    onSection({ seq: seq++, samples, durationMs: Math.round(ms(samples.length)), voicedMs, reason });
  }

  function take(frame: Float32Array): void {
    total += frame.length;
    const l = level(frame);
    recent.push(l);
    if (recent.length > hops(FLOOR_WINDOW_MS)) recent.shift();
    // The floor moves towards the quietest recent stretch: down quickly (the room got quieter), up slowly (a hum).
    const quietest = Math.min(...recent);
    floor = Math.min(MAX_FLOOR, floor + (quietest - floor) * (quietest < floor ? 0.5 : 0.01));
    const voiced = l > Math.max(minLevel, floor * floorRatio);
    sinceVoice = voiced ? 0 : sinceVoice + frame.length;

    if (open) {
      open.push(frame);
      if (voiced) {
        openVoicedHops++;
        openQuietRun = 0;
      } else {
        openQuietRun++;
      }
      const length = open.length * HOP_MS;
      if (openQuietRun * HOP_MS >= silenceMs) close("pause");
      else if (length >= softMaxMs && openQuietRun * HOP_MS >= softSilenceMs) close("length");
      else if (length >= hardMaxMs) {
        close("length");
        // Mid-speech: the next section starts at the very next sample.
        open = [];
      }
      return;
    }

    waiting.push(frame);
    loudRun = voiced ? loudRun + 1 : 0;
    if (loudRun >= hops(openMs)) {
      // Voice: the section starts with the pre-roll and the hops that proved it.
      open = waiting.slice(-(hops(preRollMs) + loudRun));
      openVoicedHops = loudRun;
      openQuietRun = 0;
      waiting = [];
      loudRun = 0;
      return;
    }
    const keep = keepWaiting();
    if (waiting.length > keep) waiting.splice(0, waiting.length - keep);
  }

  return {
    push(samples) {
      let data = samples;
      if (carry.length) {
        data = new Float32Array(carry.length + samples.length);
        data.set(carry);
        data.set(samples, carry.length);
      }
      let at = 0;
      for (; at + hop <= data.length; at += hop) take(data.slice(at, at + hop));
      carry = data.slice(at);
    },
    flush(sendUnvoiced = false) {
      if (open) close("stop");
      if (sendUnvoiced && keepUnvoiced && seq === 0 && waiting.length * HOP_MS >= 400) {
        const samples = join(waiting);
        onSection({ seq: seq++, samples, durationMs: Math.round(ms(samples.length)), voicedMs: 0, reason: "unvoiced" });
      }
      waiting = [];
      loudRun = 0;
      carry = new Float32Array(0);
    },
    get speaking() {
      return open !== null;
    },
    get quietMs() {
      return ms(sinceVoice);
    },
    get totalMs() {
      return ms(total);
    },
    get sections() {
      return seq;
    },
  };
}

/**
 * The microphone's rate (44.1 or 48 kHz, whatever the device runs at) down to `outRate`, a block at a time. Each
 * output sample is the mean of the input samples it covers, which is also the low-pass a plain "take every third"
 * lacks. The AudioContext is NOT asked for 16 kHz itself: Firefox refuses a microphone on a context whose rate is not
 * the device's.
 */
export function createDownsampler(inRate: number, outRate = SECTION_SAMPLE_RATE): (input: Float32Array) => Float32Array {
  if (inRate <= outRate) return (input) => input;
  const step = inRate / outRate;
  /** Input samples seen, and output samples given, since the start: where sample `given` ends is worked out from */
  /** these each time, never added up, so the result is the same however the blocks fall. */
  let seen = 0;
  let given = 0;
  let sum = 0;
  let count = 0;
  return (input) => {
    const out = new Float32Array(Math.ceil(input.length / step) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++, seen++) {
      if (seen >= (given + 1) * step) {
        out[n++] = sum / count;
        given++;
        sum = 0;
        count = 0;
      }
      sum += input[i]!;
      count++;
    }
    return out.subarray(0, n);
  };
}

/** Mono 16-bit PCM WAV: a 44-byte header and the samples. A complete file on its own. */
export function encodeWav(samples: Float32Array, sampleRate = SECTION_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + samples.length * 2));
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}
