/**
 * Which stored workflows THIS deployment can run, derived from its profile — never written back.
 *
 * A workspace keeps every row it was ever given. One provisioned before its deployment excluded specialists
 * (profiles/*.json `specialists.exclude`), or while base code still carried a library of its own, holds workflows
 * that delegate to specialists this deployment does not have, and the "on delegation" rows of those specialists.
 * New workspaces never get them (agent/lib/provision-workspace.ts); existing ones are reconciled HERE, at read and
 * run time, on the first request after a deploy:
 *
 *   - a row whose script delegates to an excluded specialist is UNAVAILABLE: listed as such with the reason, refused
 *     by every run path (the run routes, cron, app refresh), never offered to the model. Whether it is a library
 *     original or something a person wrote makes no difference to that: the step could only fail. Editing it to use
 *     this workspace's specialists makes it runnable;
 *   - the scriptless "on delegation" row of an excluded specialist is unavailable the same way.
 *
 * Nothing is written, so it is reversible by construction: drop the exclusion from the profile, redeploy, and the
 * same rows are available again. Under the default profile nothing is unavailable. Removing such rows for good is
 * an operator's explicit act: `npm run operator:library-cleanup`.
 */
import { VOCABULARY, type Vocabulary } from "../agent/lib/agent-vocabulary.ts";
import { WORKFLOW_LIBRARY, type LibraryWorkflow } from "../agent/lib/workflow-library.generated.ts";
import { delegatesTo, needsWorkPeriods, speakLibraryWorkflow } from "../agent/lib/workflow-library-view.ts";

export type WorkflowAvailability =
  | { available: true }
  | { available: false; reason: string; needsExcluded: string[] };

export function workflowAvailability(
  row: { name: string; script?: string | null; trigger?: string | null },
  v: Vocabulary = VOCABULARY,
  library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY,
): WorkflowAvailability {
  const script = row.script ?? "";
  // A row that files tasks into work periods, in a deployment whose profile turns them off (work_periods.mode
  // "off"): the tools it calls are not registered, so it cannot run. The feature is not named to a person.
  if (!v.periods.enabled && needsWorkPeriods({ script })) {
    return {
      available: false,
      needsExcluded: [],
      reason: "It uses a tool this workspace does not have, so it cannot run here. Edit it to use this workspace's tools and it becomes yours to run.",
    };
  }
  const needs = delegatesTo(script).filter((k) => v.excludedSpecialists.includes(k));
  if (!needs.length) {
    // The row a specialist's runs are filed under, for a specialist this deployment excludes: there is nothing to
    // delegate to. No name in the reason (see below).
    if (!script.trim() && (row.trigger ?? "on delegation") === "on delegation" && v.excludedSpecialists.includes(row.name)) {
      return {
        available: false,
        needsExcluded: [row.name],
        reason: "The row of a specialist this workspace does not use. It was added before the specialist was left out, and nothing here delegates to it.",
      };
    }
    return { available: true };
  }
  // No specialist's name: an excluded one is not shown to a person (its directory name is another deployment's
  // word). `needsExcluded` carries the names for code.
  const count = needs.length === 1 ? "a specialist" : `${needs.length} specialists`;
  const original = library.find((w) => w.name === row.name);
  if (original && script.trim() === original.script.trim()) {
    return {
      available: false,
      needsExcluded: needs,
      reason: `Part of the workflow library, which does not apply to this workspace: it delegates to ${count} this workspace does not use. Edit it to use this workspace's specialists and it becomes yours to run.`,
    };
  }
  return {
    available: false,
    needsExcluded: needs,
    reason: `It delegates to ${count} this workspace does not use, so it cannot run here. Edit it to use this workspace's specialists and it becomes yours to run.`,
  };
}

/** The library workflows this deployment does not provision, and why: shown where the list would be empty. */
export function withheldLibraryWorkflows(v: Vocabulary = VOCABULARY, library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY) {
  return library
    .map((w) => ({ name: w.name, needs: delegatesTo(w.script).filter((k) => v.excludedSpecialists.includes(k)) }))
    .filter((w) => w.needs.length > 0);
}

/**
 * One sentence for the workflows view, or null when the whole library applies. It does not name the specialists:
 * they are excluded, and an excluded specialist is not shown to a person at all (their directory names are the
 * words of whichever deployment they were written for: `customer-context`, `deployment`). The unavailable rows themselves are left out of
 * GET /api/ops/workflows for the same reason.
 */
export function withheldLibraryNote(v: Vocabulary = VOCABULARY, library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY): string | null {
  const withheld = withheldLibraryWorkflows(v, library);
  if (!withheld.length) return null;
  return `${withheld.length} of the ${library.length} library workflows are not part of this workspace: each delegates to a specialist it does not use. Add your own with “New workflow”.`;
}

/** The library workflow this stored script is, untouched (trimmed script identical), or undefined. */
function libraryOriginalOf(script: string | null | undefined, library: readonly LibraryWorkflow[]): LibraryWorkflow | undefined {
  const t = (script ?? "").trim();
  return t ? library.find((w) => w.script.trim() === t) : undefined;
}

/**
 * A stored row as the workflows list, the detail route and the editor show it: with what this deployment can do with
 * it, and — for a row that is still a library original, untouched — its product text (description, steps, the
 * script's prompts) in the profile's words, like a library workflow provisioned today. A row the profile cannot run
 * is listed "not in this workspace" and can be opened and adopted. A row a person edited or wrote is their text and
 * is returned exactly as stored.
 */
export function workflowForList<T extends { name: string; script?: string | null; description?: string | null; steps?: readonly string[] | null }>(
  row: T,
  v: Vocabulary = VOCABULARY,
  library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY,
): T & { availability: WorkflowAvailability } {
  const availability = workflowAvailability(row, v, library);
  const original = libraryOriginalOf(row.script, library);
  return { ...(original && original.name === row.name ? speakLibraryWorkflow(v, row) : row), availability };
}

/** A stored script version as a person reads it: a library original spoken, anything else verbatim. */
export function scriptForDisplay(script: string | null, v: Vocabulary = VOCABULARY, library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY): string | null {
  return libraryOriginalOf(script, library) ? (speakLibraryWorkflow(v, { script }).script ?? script) : script;
}

/**
 * ADOPTION. The editor holds a library original's script as displayed (spoken). Saving it back unchanged must not
 * turn the row into "edited here": the only difference is the translation. So a submitted script that is exactly a
 * library original's DISPLAYED text is stored as that original — the row stays a library original (still "not in
 * this workspace" where it was), and only a real edit makes it the workspace's own.
 */
export function scriptToStore(script: string, v: Vocabulary = VOCABULARY, library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY): string {
  if (!v.relabelled) return script;
  const t = script.trim();
  const hit = library.find((w) => (speakLibraryWorkflow(v, { script: w.script }).script ?? "").trim() === t);
  return hit ? hit.script : script;
}
