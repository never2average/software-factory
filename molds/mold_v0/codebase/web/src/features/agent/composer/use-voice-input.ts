'use client';
// Speaking into the composer (mold_v0-290, ported from the reference product): the browser's speech recogniser (Web Speech
// API) turns the voice into text. Where it is missing (Firefox today) the state is `unsupported` and the composer shows no
// microphone. The browser stops a continuous session after a silence, so onend restarts it while the person still wants to
// listen. The reference product's glow is not ported: it needs its own package, and this hook only needs the recogniser.
import { useCallback, useEffect, useRef, useState } from 'react';
import { joinTranscripts, transcriptFromResults, voiceErrorWords } from './voice-transcript';

export type VoiceInputState = 'unsupported' | 'idle' | 'requesting' | 'listening' | 'denied' | 'error';
export interface VoiceTranscript { final: string; interim: string }

interface RecognitionEvent { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }
interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onstart: (() => void) | null; onresult: ((e: RecognitionEvent) => void) | null; onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** Why the microphone cannot be used, when the page's own header forbids it (a deployment setting no site permission can fix). */
function pageForbidsMicrophone(): boolean {
  const policy = (document as Document & { permissionsPolicy?: { allowsFeature: (name: string) => boolean } }).permissionsPolicy;
  return !!policy && !policy.allowsFeature('microphone');
}

export function useVoiceInput({ onTranscript, lang }: { onTranscript: (t: VoiceTranscript) => void; lang?: string }) {
  // Until the first effect: no microphone is drawn on the server, and none appears only to vanish.
  const [state, setState] = useState<VoiceInputState>('unsupported');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  // Set while the person wants to listen: onend tells "the browser gave up after a silence" from "we asked it to stop".
  const wantedRef = useRef(false);
  const committedRef = useRef('');
  const sessionFinalRef = useRef('');
  const heardRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => { setState(recognitionConstructor() ? 'idle' : 'unsupported'); }, []);

  const stop = useCallback(() => {
    wantedRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onstart = null; recognition.onresult = null; recognition.onerror = null; recognition.onend = null;
      try { recognition.stop(); } catch { /* already stopped */ }
    }
    setState((current) => (current === 'unsupported' ? current : 'idle'));
  }, []);

  /** Call from a press: Safari only opens the microphone inside a user gesture. */
  const start = useCallback(() => {
    const Constructor = recognitionConstructor();
    if (!Constructor) { setState('unsupported'); return; }
    if (pageForbidsMicrophone()) { setError("This page's security settings do not allow the microphone. That is a setting of this site's deployment, not one you can change here."); setState('denied'); return; }
    setError(null);
    wantedRef.current = true; committedRef.current = ''; sessionFinalRef.current = ''; heardRef.current = false;
    const recognition = new Constructor();
    recognition.lang = lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => setState('listening');
    recognition.onresult = (event) => {
      const { final, interim } = transcriptFromResults(event.results);
      sessionFinalRef.current = final;
      if (final || interim) heardRef.current = true;
      onTranscriptRef.current({ final: joinTranscripts(committedRef.current, final), interim });
    };
    recognition.onerror = (event) => {
      const said = voiceErrorWords(event.error, heardRef.current);
      if (!said) return; // A pause after words: the session restarts below. A stop the person asked for says nothing.
      wantedRef.current = false;
      recognitionRef.current = null;
      recognition.onend = null;
      try { recognition.abort(); } catch { /* already stopped */ }
      setError(said.message);
      setState(said.state);
    };
    recognition.onend = () => {
      if (!wantedRef.current) { setState((c) => (c === 'unsupported' ? c : 'idle')); return; }
      // The words so far move to the committed pile first, since the restarted session reports from empty.
      committedRef.current = joinTranscripts(committedRef.current, sessionFinalRef.current);
      sessionFinalRef.current = '';
      try { recognition.start(); } catch { wantedRef.current = false; setState('idle'); }
    };
    recognitionRef.current = recognition;
    setState('requesting');
    try { recognition.start(); }
    catch { wantedRef.current = false; recognitionRef.current = null; setError('Dictation could not start. Try again.'); setState('error'); }
  }, [lang]);

  const stopRef = useRef(stop);
  stopRef.current = stop;
  useEffect(() => () => stopRef.current(), []);

  return { state, error, supported: state !== 'unsupported', listening: state === 'listening', start, stop };
}
