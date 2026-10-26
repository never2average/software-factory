/**
 * The shell's texts in the build's words on the server (mold_v0-141): a pack's pack.json `texts` (src/hosts.generated.ts
 * PACK_CONFIG, the first pack that names the id), else the shell's neutral text (src/shell-texts.ts), its word
 * placeholders filled (src/vocabulary.ts fill).
 */
import { packConfigs } from "./host.js";
import { SHELL_TEXTS, type ShellTextId } from "./shell-texts.js";
import { fill } from "./vocabulary.js";

/** One shell text: the pack's, else the shell's, filled. */
export const shellText = (id: ShellTextId): string =>
  fill(packConfigs().find((c) => c.texts?.[id] !== undefined)?.texts?.[id] ?? SHELL_TEXTS[id].text);
