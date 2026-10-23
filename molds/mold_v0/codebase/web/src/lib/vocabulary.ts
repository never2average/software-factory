/**
 * The build's words in the console (mold_v0-100): the same engine as the server's (src/words.ts, copied by gen-packs to
 * ./words.generated.ts) over the words gen-packs worked out for this build (../config/vocabulary.generated.ts: the
 * neutral BASE, under the packs' pack.json `words`, under profile.json `words`). Base text never spells a concept word:
 *
 *   fill("You can't launch {runs} yet")   "You can't launch runs yet" / "... audits yet" / "... simulations yet"
 *   W.runs, W.Run                         one word, for text built from parts (JSX)
 *
 * Relative imports only, so the server's tests can load it too.
 */
import { profile } from '../config/profile.generated';
import { WORDS } from '../config/vocabulary.generated';
import { capWord, fillWith, WORD_KEYS, type Words } from './words.generated';

const words = WORDS as Words;
/** Base text with its placeholders ({run}, {Runs}, {member}, {product} ...) filled from the build's words. */
export const fill = (text: string): string => fillWith(words, profile.name, text);

type Cap<K extends string> = K extends `${infer F}${infer R}` ? `${Uppercase<F>}${R}` : K;
type Key = keyof Words;
/** Every word, lower-case (`W.runs`) and with its first letter raised (`W.Runs`), and the product's name. */
export const W = Object.freeze({
  ...words,
  ...Object.fromEntries(Object.entries(words).map(([k, v]) => [capWord(k), capWord(v)])),
  product: profile.name,
}) as Readonly<Record<Key | Cap<Key>, string> & { product: string }>;

export { WORD_KEYS };
