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
import { delegatesTo } from "../agent/lib/workflow-library-view.ts";

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
      reason: `Part of the base workflow library, which does not apply to this workspace: it delegates to ${needs.join(", ")}, ${needs.length === 1 ? "a specialist" : "specialists"} this workspace does not use. Edit it to use this workspace's specialists and it becomes yours to run.`,
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

/** One sentence for the workflows view, or null when the whole library applies. */
export function withheldLibraryNote(v: Vocabulary = VOCABULARY, library: readonly LibraryWorkflow[] = WORKFLOW_LIBRARY): string | null {
  const withheld = withheldLibraryWorkflows(v, library);
  if (!withheld.length) return null;
  const specialists = [...new Set(withheld.flatMap((w) => w.needs))].sort();
  return `${withheld.length} of the ${library.length} base library workflows are not part of this workspace: each delegates to a specialist it does not use (${specialists.join(", ")}). Add your own with “New workflow”.`;
}
