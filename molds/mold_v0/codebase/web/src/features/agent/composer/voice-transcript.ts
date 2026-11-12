/**
 * How a spoken transcript lands in the composer (mold_v0-290, ported from the reference product). Speech recognition reports
 * in two layers: words it has committed to (`final`) and the phrase it is still hearing (`interim`), which it rewrites on
 * every event. The composer shows both and both survive a stop: stopping right after speaking is the normal way to stop,
 * and the last phrase is usually still interim then. Whatever was typed is left exactly alone. Pure, so the seam between
 * "what was typed" and "what was said" is a function, not a side effect of event ordering.
 */

/** The composer text while listening: the typed base, then the said words. */
export function composeVoiceInput(base: string, finalText: string, interim: string): string {
  const said = [finalText.trim(), interim.trim()].filter(Boolean).join(' ');
  if (!said) return base;
  const typed = base.trimEnd();
  return typed ? `${typed} ${said}` : said;
}

/** Join the committed text of earlier recognition sessions with the current one's (a pause restarts the recogniser from empty). */
export function joinTranscripts(earlier: string, current: string): string {
  return [earlier.trim(), current.trim()].filter(Boolean).join(' ');
}

/** The words said since `from` characters of the transcript were folded into what the person typed. */
export const spokenSince = (finalText: string, from: number) => finalText.slice(Math.min(from, finalText.length)).trimStart();

/** Fold one recognition event: browsers resend every result of the session, so the committed text is rebuilt, not appended. */
export function transcriptFromResults(results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>): { final: string; interim: string } {
  const finals: string[] = [], interims: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    (result.isFinal ? finals : interims).push(result[0]?.transcript ?? '');
  }
  const tidy = (x: string[]) => x.join(' ').replace(/\s+/g, ' ').trim();
  return { final: tidy(finals), interim: tidy(interims) };
}

/** One recognition error in plain words; null: not worth saying (the person stopped it, or a pause while words were heard). */
export function voiceErrorWords(code: string, heardAnything: boolean): { message: string; state: 'denied' | 'error' } | null {
  switch (code) {
    case 'aborted': return null;
    case 'no-speech': return heardAnything ? null : { message: 'No speech was heard. Hold the microphone while you speak.', state: 'error' };
    case 'not-allowed':
    case 'service-not-allowed': return { message: 'Microphone access is blocked for this site. Allow it from the icon in the address bar, then try again.', state: 'denied' };
    case 'network': return { message: "Your browser's speech service could not be reached. Check your connection and try again.", state: 'error' };
    case 'audio-capture': return { message: 'No microphone was found on this device.', state: 'error' };
    case 'language-not-supported': return { message: "Your browser's speech service does not support this language.", state: 'error' };
    default: return { message: 'Dictation stopped unexpectedly. Try again.', state: 'error' };
  }
}
