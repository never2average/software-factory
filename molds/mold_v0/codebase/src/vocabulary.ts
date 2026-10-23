/**
 * The build's vocabulary on the server (mold_v0-100; the engine is src/words.ts, the console's copy of it
 * web/src/lib/vocabulary.ts). Base text never spells a concept word: it writes `{run}`, `{Runs}`, `{member}`,
 * `{product}` ... and fill() gives it the build's words:
 *
 *   fill("You can't launch {runs} yet.")      "You can't launch runs yet." (zero packs), "... audits yet." (a pack
 *                                             whose pack.json says "words": {"run": "audit"}), "... simulations yet."
 *   word("Run")                               one placeholder's word, for a sentence built from parts
 *
 * The words: the neutral BASE (src/words.ts BASE_WORDS, the default profile's), under the installed packs' pack.json
 * `words` (src/packs.ts packs(): the first pack that names a word), under the profile's own `words` (profile.json, a
 * host pack's `host.profile.words` under it; src/vocabulary.generated.ts PROFILE_WORDS). `{product}` is profile.json
 * `name`. gen-packs works out the same words for the console (web/src/config/vocabulary.generated.ts) from the same
 * layers; scripts/run-words-test.ts holds the two to each other.
 */
import { packs } from "./packs.js";
import { PROFILE } from "./profile.js";
import { PROFILE_WORDS } from "./vocabulary.generated.js";
import { fillWith, resolveWords, wordOf, type Words } from "./words.js";

export { articleFor, capWord, pluralWord, BASE_WORDS, WORD_KEYS, type WordKey, type Words } from "./words.js";

let cached: { from: unknown; words: Words } | null = null;
/** The build's words, every key singular and plural (`run`, `runs`). */
export function vocabulary(): Words {
  const list = packs();
  if (cached?.from !== list) cached = { from: list, words: resolveWords([PROFILE_WORDS, ...list.map((p) => p.manifest.words)]) };
  return cached.words;
}

/** Base text with its placeholders filled from the build's words and the profile's name. */
export const fill = (text: string): string => fillWith(vocabulary(), PROFILE.name, text);

/** One placeholder's word: `word("runs")` -> "audits", `word("Run")` -> "Audit", `word("product")` -> the app's name. */
export function word(key: string): string {
  const w = wordOf(vocabulary(), PROFILE.name, key);
  if (w == null) throw new Error(`no word ${key}`);
  return w;
}
