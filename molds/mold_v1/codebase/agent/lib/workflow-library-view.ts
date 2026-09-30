/**
 * The workflow library as THIS deployment provisions it (agent/lib/provision-workspace.ts seeds every new
 * workspace from it).
 *
 * The library (scripts/operator/workflows/*.workflow.js, compiled into workflow-library.generated.ts) was written for
 * the base product: its scripts delegate to base specialists and its step prompts name base tools ("Call
 * list_fdes…", "get_customer"). Under a profile:
 *   - a workflow that delegates to a specialist the profile EXCLUDES is not provisioned at all — it would fail
 *     at its first step, and offering it would tell the model about work this deployment does not do;
 *   - every other workflow's name-free text — its description, step names, and the string literals of its script
 *     (the prompts it sends) — is spoken in the profile's words, like any prompt. Code is not touched: the script
 *     still reads `args.customerId`, which trigger_workflow maps the model's `companyId` back to, and still names
 *     its specialists by directory.
 * Identity under the default profile.
 */
import { speakPromptWith, VOCABULARY, type Vocabulary } from "./agent-vocabulary.ts";
import { WORKFLOW_LIBRARY, type LibraryWorkflow } from "./workflow-library.generated.ts";

/** The specialists a script delegates to (`agent(…, { subagent: "key" })`). */
export function delegatesTo(script: string): string[] {
  return [...new Set([...script.matchAll(/subagent:\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]))];
}

/** A script with only its double-quoted string literals spoken; code, and specialist names, unchanged. */
function speakLiterals(v: Vocabulary, script: string): string {
  return script.replace(/"(?:[^"\\\n]|\\.)*"/g, (literal) => {
    let text: string;
    try {
      text = JSON.parse(literal);
    } catch {
      return literal;
    }
    if (v.specialists.includes(text) || v.excludedSpecialists.includes(text)) return literal;
    const spoken = speakPromptWith(v, text);
    return spoken === text ? literal : JSON.stringify(spoken);
  });
}

/** One library workflow's name-free text in the profile's words: description, step names, script literals. */
export function speakLibraryWorkflow<T extends { description?: string | null; steps?: readonly string[] | null; script?: string | null }>(v: Vocabulary, w: T): T {
  if (!v.relabelled) return w;
  return {
    ...w,
    ...(typeof w.description === "string" ? { description: speakPromptWith(v, w.description) } : {}),
    ...(Array.isArray(w.steps) ? { steps: w.steps.map((s) => speakPromptWith(v, s)) } : {}),
    ...(typeof w.script === "string" ? { script: speakLiterals(v, w.script) } : {}),
  };
}

export function deploymentWorkflowLibrary(v: Vocabulary = VOCABULARY, library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY): LibraryWorkflow[] {
  if (!v.relabelled && !v.excludedSpecialists.length) return [...library];
  return library
    .filter((w) => !delegatesTo(w.script).some((k) => v.excludedSpecialists.includes(k)))
    .map((w) => speakLibraryWorkflow(v, w));
}
