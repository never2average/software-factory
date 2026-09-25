/**
 * Which stored workflows THIS deployment can run, derived from its profile — never written back.
 *
 * A workspace provisioned before its deployment excluded specialists (profiles/*.json `specialists.exclude`)
 * still holds the base workflow library: 13 rows, every one of which delegates to a base specialist and speaks
 * the base product's words. New workspaces are provisioned from agent/lib/workflow-library-view.ts and never get
 * them; existing ones are reconciled HERE, at read and run time, on the first request after a deploy:
 *
 *   - a row that is still the library's original (same name, script byte-identical once trimmed) and delegates to
 *     an excluded specialist is UNAVAILABLE: listed as such with the reason, refused by every run path (the run
 *     routes, cron, app refresh), never offered to the model;
 *   - a row a person EDITED or wrote that delegates to an excluded specialist is left alone — runnable, and
 *     reported (`needsExcluded`) so the workflows view can say which specialist it will not find.
 *
 * Nothing is written, so it is reversible by construction: drop the exclusion from the profile, redeploy, and the
 * same rows are available again. Under the default profile nothing is unavailable.
 */
import { VOCABULARY, type Vocabulary } from "../agent/lib/agent-vocabulary.ts";
import { WORKFLOW_LIBRARY, type LibraryWorkflow } from "../agent/lib/workflow-library.generated.ts";
import { delegatesTo, speakLibraryWorkflow } from "../agent/lib/workflow-library-view.ts";

export type WorkflowAvailability =
  | { available: true; needsExcluded?: string[] }
  | { available: false; reason: string; needsExcluded: string[] };

export function workflowAvailability(
  row: { name: string; script?: string | null },
  v: Vocabulary = VOCABULARY,
  library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY,
): WorkflowAvailability {
  const needs = delegatesTo(row.script ?? "").filter((k) => v.excludedSpecialists.includes(k));
  if (!needs.length) return { available: true };
  const original = library.find((w) => w.name === row.name);
  if (original && (row.script ?? "").trim() === original.script.trim()) {
    return {
      available: false,
      needsExcluded: needs,
      // No specialist's name: an excluded one is not shown to a person (its directory name is the base product's
      // word). `needsExcluded` carries the names for code.
      reason: `Part of the base workflow library, which does not apply to this workspace: it delegates to ${needs.length === 1 ? "a specialist" : `${needs.length} specialists`} this workspace does not use. Edit it to use this workspace's specialists and it becomes yours to run.`,
    };
  }
  return { available: true, needsExcluded: needs };
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
 * base product's words: `customer-context`, `deployment`). The unavailable rows themselves are left out of
 * GET /api/ops/workflows for the same reason.
 */
export function withheldLibraryNote(v: Vocabulary = VOCABULARY, library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY): string | null {
  const withheld = withheldLibraryWorkflows(v, library);
  if (!withheld.length) return null;
  return `${withheld.length} of the ${library.length} base library workflows are not part of this workspace: each delegates to a specialist it does not use. Add your own with “New workflow”.`;
}

/** The base library workflow this stored script is, untouched (trimmed script identical), or undefined. */
function libraryOriginalOf(script: string | null | undefined, library: readonly LibraryWorkflow[]): LibraryWorkflow | undefined {
  const t = (script ?? "").trim();
  return t ? library.find((w) => w.script.trim() === t) : undefined;
}

/**
 * A stored row as the workflows list, the detail route and the editor show it: with what this deployment can do with
 * it, and — for a row that is still a base library original, untouched — its product text (description, steps, the
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

/** A stored script version as a person reads it: a base library original spoken, anything else verbatim. */
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
