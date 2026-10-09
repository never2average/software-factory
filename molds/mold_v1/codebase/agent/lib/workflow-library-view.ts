/**
 * The workflow library and the recipe catalog as THIS deployment provisions them (agent/lib/provision-workspace.ts
 * seeds every new workspace from here).
 *
 * Base code carries neither. Both are the content of the directories the deployment profile names under
 * `library.sources` (profiles/*.json; scripts/build-workflow-library.mjs compiles them into
 * workflow-library.generated.ts): none in the default profile, so a deployment that adds nothing provisions an empty
 * library. A library's scripts delegate to specialists and its prompts are written with the placeholders the profile
 * fills. Under a profile:
 *   - a workflow that delegates to a specialist the profile EXCLUDES is not provisioned at all — it would fail
 *     at its first step, and offering it would tell the model about work this deployment does not do;
 *   - a workflow that needs work periods is not provisioned when the profile turns them off (`needsWorkPeriods`);
 *   - every other workflow's name-free text — its description, step names, and the string literals of its script
 *     (the prompts it sends) — is spoken in the profile's words, like any prompt. Code is not touched: the script
 *     still reads `args.customerId`, which trigger_workflow maps the model's `companyId` back to, and still names
 *     its specialists by directory;
 *   - a recipe's title and summary are spoken the same way.
 * Under the default profile only the role placeholders are filled.
 */
import { hasRolePlaceholder, speakPromptWith, VOCABULARY, type Vocabulary } from "./agent-vocabulary.ts";
import { RECIPE_LIBRARY, STARTER_APP_LIBRARY, WORKFLOW_LIBRARY, type LibraryRecipe, type LibraryStarterApp, type LibraryWorkflow } from "./workflow-library.generated.ts";

/** The specialists a script delegates to (`agent(…, { subagent: "key" })`). */
export function delegatesTo(script: string): string[] {
  return [...new Set([...script.matchAll(/subagent:\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]))];
}

/**
 * Does a workflow need work periods (the deployment profile's `work_periods`, agent/lib/work-periods.ts)? It does
 * when its script or its text names one of the model's period tools, the period parameter of a task, or a period
 * placeholder. Under mode "off" none of those exist, so such a workflow is not provisioned, and one a workspace
 * already holds is unavailable (lib/workflow-availability.ts): it would fail at the first step that files a task
 * into a period, and offering it would tell the model about a feature this deployment does not have.
 */
export function needsWorkPeriods(w: { script?: string | null; description?: string | null; steps?: readonly string[] | null }): boolean {
  const text = [w.script, w.description, ...(w.steps ?? [])].filter((t): t is string => typeof t === "string").join("\n");
  return /\b(?:list_cycles|upsert_cycle|cycleId|cycle_id)\b|(?<!\$)\{(?:period_items?|Period_items?|periods?|Periods?)\}/.test(text);
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

/**
 * One library workflow's name-free text in the profile's words: description, step names, script literals. Under
 * every profile its role placeholders (`{owner}`, `{member}`) are filled; under a relabelling one, every base word
 * is spoken too. A workflow with neither is returned as it is.
 */
export function speakLibraryWorkflow<T extends { description?: string | null; steps?: readonly string[] | null; script?: string | null }>(v: Vocabulary, w: T): T {
  const placeholders = [w.description, ...(w.steps ?? []), w.script].some((t) => typeof t === "string" && hasRolePlaceholder(t));
  if (!v.relabelled && !placeholders) return w;
  return {
    ...w,
    ...(typeof w.description === "string" ? { description: speakPromptWith(v, w.description) } : {}),
    ...(Array.isArray(w.steps) ? { steps: w.steps.map((s) => speakPromptWith(v, s)) } : {}),
    ...(typeof w.script === "string" ? { script: speakLiterals(v, w.script) } : {}),
  };
}

export function deploymentWorkflowLibrary(v: Vocabulary = VOCABULARY, library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY): LibraryWorkflow[] {
  return library
    .filter((w) => !delegatesTo(w.script).some((k) => v.excludedSpecialists.includes(k)))
    // …nor one that needs work periods, in a deployment whose profile turns them off.
    .filter((w) => v.periods.enabled || !needsWorkPeriods(w))
    .map((w) => speakLibraryWorkflow(v, w));
}

/** The recipe catalog a new workspace receives, in checklist order, in the profile's words. Empty unless the profile names a library. */
export function deploymentRecipes(v: Vocabulary = VOCABULARY, library: readonly LibraryRecipe[] = RECIPE_LIBRARY): LibraryRecipe[] {
  return library.map((r) => ({ ...r, title: speakPromptWith(v, r.title), summary: r.summary === null ? null : speakPromptWith(v, r.summary) }));
}

/**
 * The starter apps a new workspace of this deployment is created with, in the profile's words (name, description and
 * the brief its source is asked for). Empty unless the profile names a library that ships some (`<library>/apps.json`).
 *
 * The build already refused a starter app whose source it does not have (scripts/lib/profile-library.mjs). The same
 * rule is applied here, so a library handed in by a test, or a registry generated before a specialist was excluded,
 * cannot provision an app that could only fail: one whose specialist this deployment does not have, or whose
 * workflow is not provisioned, is left out.
 */
export function deploymentStarterApps(
  v: Vocabulary = VOCABULARY,
  library: readonly LibraryStarterApp[] = STARTER_APP_LIBRARY,
  workflows: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY,
): LibraryStarterApp[] {
  const provisioned = new Set(deploymentWorkflowLibrary(v, workflows).map((w) => w.name));
  return library
    .filter((a) => (a.sourceKind === "specialist" ? v.specialists.includes(a.source) : provisioned.has(a.source)))
    .map((a) => ({ ...a, name: speakPromptWith(v, a.name), description: speakPromptWith(v, a.description), brief: speakPromptWith(v, a.brief) }));
}
