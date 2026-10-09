/**
 * This specialist's prompt: ./prompt.md (compiled into agent/lib/prompts.generated.ts by `npm run
 * build:prompts`), spoken in the deployment's own words (agent/lib/agent-vocabulary.ts). Under the default
 * profile the result is prompt.md byte for byte; under a profile that renames the domains it names the tools,
 * fields and data-room folders the way this deployment's model is given them, and it never names a specialist
 * the profile excludes.
 */
import { defineInstructions } from "eve/instructions";
import { speakPrompt } from "#lib/agent-vocabulary.js";
import { SUBAGENT_PROMPTS } from "#lib/prompts.generated.js";

export default defineInstructions({ markdown: speakPrompt(SUBAGENT_PROMPTS["data-migration"]) });
