/**
 * The subagents a workflow script's `agent()` may name — discovered, not listed.
 *
 * prompt.md names the built-in ones. A deployment can declare more (a subagent is a directory under
 * agent/subagents/, and packs add them), and a script that cannot name them cannot use them. This appends the
 * full declared set from the generated registry; it is resolved at build time, like any defineInstructions, and
 * spoken in the deployment's words (agent/lib/agent-vocabulary.ts; identity under the default profile).
 */
import { defineInstructions } from "eve/instructions";
import { SUBAGENT_KEYS, SUBAGENT_SUMMARIES } from "#lib/subagent-registry.generated.js";
import { speakPrompt } from "#lib/agent-vocabulary.js";

const NOT_DELEGABLE = new Set(["workflow-author", "app-author", "browser"]);

export default defineInstructions({
  markdown: speakPrompt([
    "## Every subagent this deployment declares",
    "",
    "`agent()` may name any of these (this list is generated from the codebase and supersedes the shorter one above):",
    "",
    ...SUBAGENT_KEYS.filter((k) => !NOT_DELEGABLE.has(k)).map((k) => `- \`${k}\` — ${SUBAGENT_SUMMARIES[k] ?? ""}`),
  ].join("\n")),
});
