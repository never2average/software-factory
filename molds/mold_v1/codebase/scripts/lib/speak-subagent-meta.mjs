#!/usr/bin/env node
/**
 * The subagent roster the UI shows, in the deployment's words — the SAME words the model is given.
 *
 * scripts/gen-subagent-meta.mjs discovers each subagent's display name, summary, description, skills summary and
 * tool roster from the source, in the base product's words. The model never reads those as they are: under a
 * relabelling profile, modelFacing() (agent/lib/model-facing/tools/model-facing.ts) gives it each tool under
 * speakIdentifier(name) with speak(description), and a base specialist's description is speak()-wrapped in its
 * agent.ts. The cockpit and workspace panels show the same roster, so it is spoken here, with the same functions,
 * before it is written to app/_components/subagent-meta.generated.ts: the client bundle then carries the
 * profile's words and never the base ones.
 *
 * Run by gen-subagent-meta.mjs with --experimental-strip-types (it imports agent/lib/agent-vocabulary.ts).
 * stdin: { profile, specialists, meta }   stdout: meta, spoken. The identity under the default profile.
 */
import { readFileSync } from "node:fs";

const { createVocabulary, speakWith, speakIdentifierWith } = await import("../../agent/lib/agent-vocabulary.ts");
const { profile, specialists, meta } = JSON.parse(readFileSync(0, "utf8"));
const v = createVocabulary(profile, specialists);
const say = (s) => (typeof s === "string" ? speakWith(v, s) : s);
const out = {};
for (const [key, m] of Object.entries(meta)) {
  out[key] = {
    ...m,
    name: say(m.name),
    summary: say(m.summary),
    description: say(m.description),
    skillsSummary: say(m.skillsSummary),
    tools: m.tools.map((t) => ({ name: speakIdentifierWith(v, t.name), description: say(t.description) })),
  };
}
process.stdout.write(JSON.stringify(out));
