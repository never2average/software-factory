/**
 * The shell's texts in the build's words in the console (mold_v0-141): a pack's pack.json `texts`
 * (../config/build-facts.generated.ts TEXTS), else the shell's neutral text (./shell-texts.generated.ts, gen-packs' copy
 * of src/shell-texts.ts), its word placeholders filled (./vocabulary.ts fill). The server's are src/texts.ts.
 */
import * as facts from '../config/build-facts.generated';
import { SHELL_TEXTS, type ShellTextId } from './shell-texts.generated';
import { fill } from './vocabulary';

const PACK_TEXTS: Readonly<Record<string, string>> = (facts as { TEXTS?: Readonly<Record<string, string>> }).TEXTS ?? {};
/** One shell text: the pack's, else the shell's, filled. */
export const text = (id: ShellTextId): string => fill(PACK_TEXTS[id] ?? SHELL_TEXTS[id].text);
