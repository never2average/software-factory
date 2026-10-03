/**
 * This specialist's prompt: ./prompt.md (compiled into agent/lib/prompts.generated.ts by `npm run
 * build:prompts`), spoken in the deployment's own words (agent/lib/agent-vocabulary.ts). Under the default
 * profile the result is prompt.md byte for byte; under a profile that renames the domains it names the tools,
 * fields and data-room folders the way this deployment's model is given them, and it never names a specialist
 * the profile excludes.
 *
 * One thing in it is not a word: `{fmt_xlsx}`, where the sandbox's workbook formatter lives. It is filled first, from
 * the sandbox backend this build is for (agent/lib/sandbox-settings.ts): `/root/fmt_xlsx.py` as it has always read,
 * unless `SANDBOX_BACKEND=microsandbox`, where the sandbox user is not root and the file is in its home.
 */
import { defineInstructions } from "eve/instructions";
import { speakPrompt } from "#lib/agent-vocabulary.js";
import { SUBAGENT_PROMPTS } from "#lib/prompts.generated.js";
import { withFmtXlsxPath } from "#lib/sandbox-settings.js";

export default defineInstructions({ markdown: speakPrompt(withFmtXlsxPath(SUBAGENT_PROMPTS["research"])) });
