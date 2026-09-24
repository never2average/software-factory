/**
 * The root prompt, assembled.
 *
 *   agent/prompt-core.md      the neutral rules every deployment keeps: organization scope, delegation,
 *                             deliverables, memory, files and sandboxes, scope, ground rules. Domain words in it
 *                             are spoken in the profile's words (agent/lib/agent-vocabulary.ts).
 *   agent/prompt-persona.md   the base product's persona: the forward-deployed engineering orchestrator, its
 *                             specialist roster, the customer spreadsheet, the daily stand-up.
 *   agent/prompt-neutral.md   what stands in the persona's place under `persona.base: false`: a plain opening
 *                             and a one-paragraph system of record. The pack's own agent/instructions/50-pack-*.md
 *                             (read after this) says what the work is.
 *
 * All three are compiled into agent/lib/prompts.generated.ts (`npm run build:prompts`).
 *
 * The core holds `{{name}}` slots. A slot alone on its line takes the section of that name, or — when the
 * chosen file has none — disappears together with the blank line before it; an inline slot takes the section's
 * text. Under the default profile the result is the former agent/instructions.md exactly (check:agent-vocabulary
 * holds that byte for byte). Specialists a profile excludes leave the persona's roster too.
 *
 * Pure (relative imports only): eve evaluates it at build time, the offline tests import it directly.
 */
import { speakPromptWith, VOCABULARY, type Vocabulary } from "./agent-vocabulary.ts";
import { PROMPTS } from "./prompts.generated.ts";

/** `<!-- section: name -->` blocks of a persona file, each without its trailing newline. */
export function promptSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = text.split(/^<!-- section: ([a-z0-9-]+) -->\n/m);
  for (let i = 1; i < parts.length; i += 2) out.set(parts[i], parts[i + 1].replace(/\n+$/, ""));
  return out;
}

/** Fill the core's slots from `sections`. */
export function fillSlots(core: string, sections: Map<string, string>): string {
  const lines = core.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const whole = /^\{\{([a-z0-9-]+)\}\}$/.exec(line);
    if (whole) {
      const section = sections.get(whole[1]);
      if (section === undefined || section === "") {
        if (out.length && out[out.length - 1] === "") out.pop();
        continue;
      }
      out.push(section);
      continue;
    }
    out.push(line.replace(/\{\{([a-z0-9-]+)\}\}/g, (m, name: string) => sections.get(name) ?? m));
  }
  return out.join("\n");
}

export function renderRootInstructions(v: Vocabulary = VOCABULARY): string {
  const sections = promptSections(v.personaBase ? PROMPTS.persona : PROMPTS.neutral);
  return speakPromptWith(v, fillSlots(PROMPTS.core, sections));
}
