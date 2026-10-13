/**
 * THE SPEECH-TO-TEXT MODELS DICTATION CAN USE, how each one is called, and which one THIS deployment uses.
 *
 * A deployment picks its model in its profile (`asr.model`, `asr.language`; scripts/gen-deployment-profile.mjs refuses
 * a model that is not here) and may override both at run time with its environment, the way the chat's models are
 * chosen per role (CLOUDFLARE_MODEL_<ROLE>):
 *
 *   ASR_MODEL      a model id from SPEECH_MODELS below            unset or blank: the profile's `asr.model`
 *   ASR_LANGUAGE   an ISO 639-1 code ("en"), or "auto"            unset or blank: the profile's `asr.language`
 *                  ("auto" = the model detects the language)
 *   ASR_ENABLED    "true" or "false"                              unset or blank: the profile's `asr.enabled`
 *
 * A model is usable only when it is in SPEECH_MODELS (this app knows how to call it) AND priced in
 * lib/inference-pricing.ts (AUDIO_PRICES), so every dictation's usage row has a price. Anything else FAILS CLOSED:
 * dictation is turned off and the route says why in its log (resolveDictationSettings); a profile that names one does
 * not build.
 *
 * The three request shapes Workers AI's REST "run" endpoint takes for speech to text
 * (POST https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/<model>; input and output schemas on each
 * model's page, read on 2026-10-12):
 *
 *   "whisper-json"  JSON { audio: "<base64>", task: "transcribe", vad_filter: true, language?: "en" }
 *                   -> { result: { text, transcription_info: { duration } } }
 *                   https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
 *   "audio-body"    the clip itself as the request body (its own content type); no language input
 *                   -> { result: { text, words: [{ word, start, end }] } }   (no clip length: the recorder's is used)
 *                   https://developers.cloudflare.com/workers-ai/models/whisper/
 *   "deepgram"      the clip itself as the request body; options in the query string
 *                   (smart_format=true, language=<code> or detect_language=true)
 *                   -> { result: { results: { channels: [{ alternatives: [{ transcript }] }] }, metadata?: { duration } } }
 *                   https://developers.cloudflare.com/workers-ai/models/nova-3/
 *
 * Import-free apart from the price table (plain data), so the profile generator and the browser can both read it.
 */
import { audioPriceForModel } from "./inference-pricing.ts";

export type SpeechApi = "whisper-json" | "audio-body" | "deepgram";

export interface SpeechModel {
  readonly api: SpeechApi;
  /**
   * The languages it can be told to transcribe in (ISO 639-1): "any" for every code, [] when it takes no language
   * (it always detects it), else the list it supports.
   */
  readonly languages: "any" | readonly string[];
}

export const SPEECH_MODELS: Readonly<Record<string, SpeechModel>> = Object.freeze({
  "@cf/openai/whisper-large-v3-turbo": { api: "whisper-json", languages: "any" },
  "@cf/openai/whisper": { api: "audio-body", languages: [] },
  // "Supported languages include English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, and
  // Dutch" (Workers AI changelog, 2026-03-06).
  "@cf/deepgram/nova-3": { api: "deepgram", languages: ["en", "es", "fr", "de", "hi", "ru", "pt", "ja", "it", "nl"] },
});

export const ASR_LANGUAGE_AUTO = "auto";
const LANGUAGE = /^[a-z]{2}$/;

/** The model's row, or null when dictation does not know how to call it. */
export function speechModel(model: string | null | undefined): SpeechModel | null {
  if (typeof model !== "string") return null;
  return Object.prototype.hasOwnProperty.call(SPEECH_MODELS, model) ? SPEECH_MODELS[model]! : null;
}

/** Why this model and language cannot be used together, in plain words, or null when they can. */
export function speechModelProblem(model: unknown, language: unknown): string | null {
  const known = Object.keys(SPEECH_MODELS).join(", ");
  if (typeof model !== "string" || model.trim() === "") return `no speech model is named; use one of: ${known}`;
  const row = speechModel(model);
  if (!row) return `${JSON.stringify(model)} is not a speech model dictation can call; use one of: ${known}`;
  if (!audioPriceForModel(model)) return `${model} has no price per audio minute in lib/inference-pricing.ts (AUDIO_PRICES), so its usage could not be priced`;
  if (language === null) return null;
  if (typeof language !== "string" || !LANGUAGE.test(language)) return `the language must be a two-letter ISO 639-1 code (for example "en") or none, not ${JSON.stringify(language)}`;
  if (row.languages === "any") return null;
  if (row.languages.length === 0) return `${model} takes no language (it always detects it); leave the language unset`;
  if (!row.languages.includes(language)) return `${model} does not transcribe ${JSON.stringify(language)}; it takes ${row.languages.join(", ")}, or no language`;
  return null;
}

export interface AsrChoice {
  readonly enabled: boolean;
  readonly model: string;
  readonly language: string | null;
}

/**
 * The deployment's choice: the profile's, with the environment's overrides (ASR_MODEL, ASR_LANGUAGE, ASR_ENABLED).
 * -> the choice to use and null, or, when anything is wrong, the same choice with `enabled: false` and the reason:
 * a deployment that names a model it cannot call or price has no dictation, never a guess.
 */
export function resolveAsrChoice<T extends AsrChoice>(
  base: T,
  env: Record<string, string | undefined>,
): { settings: T; problem: string | null } {
  const raw = (name: string) => {
    const v = env[name];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  const off = (problem: string) => ({ settings: Object.freeze({ ...base, enabled: false }) as T, problem });
  let enabled = base.enabled;
  const e = raw("ASR_ENABLED");
  if (e !== null) {
    if (e !== "true" && e !== "false") return off(`ASR_ENABLED must be "true" or "false", not ${JSON.stringify(e)}`);
    enabled = e === "true";
  }
  const model = raw("ASR_MODEL") ?? base.model;
  const l = raw("ASR_LANGUAGE");
  const language = l === null ? base.language : l === ASR_LANGUAGE_AUTO ? null : l;
  const same = enabled === base.enabled && model === base.model && language === base.language;
  const settings = same ? base : (Object.freeze({ ...base, enabled, model, language }) as T);
  if (!enabled) return { settings, problem: null };
  const why = speechModelProblem(model, language);
  if (why) {
    const from = [raw("ASR_MODEL") !== null ? "ASR_MODEL" : null, l !== null ? "ASR_LANGUAGE" : null].filter(Boolean);
    return off(`dictation is off: ${why}${from.length ? ` (set by ${from.join(" and ")})` : " (the profile's asr)"}`);
  }
  return { settings, problem: null };
}
