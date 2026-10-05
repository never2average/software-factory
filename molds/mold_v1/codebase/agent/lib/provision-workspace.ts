/**
 * Seed a newly-created workspace so it is usable on arrival.
 *
 * WHAT is seeded is not decided here. Base code carries no workflow and no recipe of its own:
 *
 *   - the recipe catalog and the workflow library are the deployment profile's (`library.sources` in
 *     profiles/*.json, compiled into workflow-library.generated.ts and read through workflow-library-view.ts).
 *     The default profile names none, so a deployment that adds nothing provisions neither;
 *   - one "on delegation" row per specialist THIS deployment has: the generated registry (base specialists and any
 *     pack's), minus the ones the profile excludes.
 *
 * This file used to hold a recipe list of its own (and the library was every script under one base directory), so
 * every deployment's workspaces received the first product's onboarding checklist and its thirteen workflows
 * whatever the deployment was for. `npm run check:neutral-names` now refuses a library in base code.
 *
 * Both creation paths (the `operator:new-org` CLI and the self-serve wizard's
 * POST /api/ops/orgs) call this, so they cannot drift apart.
 *
 * MUST RUN INSIDE THE WORKSPACE'S SCOPE — `withOrgRls(orgId, …)` on the Next
 * side, `withOrgDb(orgId, …)` on the agent side. `recipes` and `workflows` carry
 * the fail-closed `org_isolation` policy, so as `app_rw` an insert on a handle
 * with no `app.org_id` set is refused by the database. The wizard once passed
 * its unscoped handle here, caught the refusal as a "best-effort" error and
 * returned 201 with an empty workspace. Rather than let that happen quietly
 * again, this function checks the scope first and throws a message that names
 * the fix; a caller that swallows errors still logs something actionable.
 *
 * Idempotent: safe to re-run on an existing workspace. It only inserts what is
 * missing and never overwrites a workflow or recipe someone has since edited —
 * a re-provision must not silently discard a person's changes. It never deletes:
 * a row an earlier build seeded and this one would not is left where it is
 * (`npm run operator:library-cleanup` lists those, and removes them only when told to).
 */
import { and, eq, sql } from "drizzle-orm";
import { recipes, workflows } from "./db/schema.ts";
import { SUBAGENT_KEYS, SUBAGENT_SUMMARIES } from "./subagent-registry.generated.ts";
import { deploymentRecipes, deploymentWorkflowLibrary } from "./workflow-library-view.ts";
import { VOCABULARY } from "./agent-vocabulary.ts";
import type { LibraryRecipe, LibraryWorkflow } from "./workflow-library.generated.ts";

/** Minimal shape of the Drizzle transaction handle both callers hold. */
type AnyDb = {
  select: (...args: never[]) => any;
  insert: (...args: never[]) => any;
  execute: (...args: never[]) => any;
};

/**
 * What to provision, when it is not this build's own: a test hands in a library and a specialist list so it can
 * prove each rule against a database without rebuilding the tree. Every caller in the product passes nothing.
 */
export interface ProvisionSource {
  readonly workflows?: readonly LibraryWorkflow[];
  readonly recipes?: readonly LibraryRecipe[];
  /** The specialists that get a row: already without the excluded ones. */
  readonly specialists?: readonly { key: string; summary: string }[];
}

/** The specialists this deployment has: the generated registry, never one the profile excludes. */
export function deploymentSpecialists(
  keys: readonly string[] = SUBAGENT_KEYS,
  excluded: readonly string[] = VOCABULARY.excludedSpecialists,
  summaries: Record<string, string> = SUBAGENT_SUMMARIES,
): { key: string; summary: string }[] {
  return keys.filter((k) => !excluded.includes(k)).map((key) => ({ key, summary: summaries[key] ?? "" }));
}

export interface ProvisionResult {
  readonly recipesCreated: number;
  readonly recipesSkipped: number;
  readonly workflowsCreated: number;
  readonly workflowsSkipped: number;
}

export async function provisionWorkspace(
  db: AnyDb,
  orgId: string,
  actor = "system",
  source: ProvisionSource = {},
): Promise<ProvisionResult> {
  if (!orgId) throw new Error("provisionWorkspace: orgId is required");

  // Refuse an unscoped handle up front. `set_config(..., true)` is LOCAL to the
  // transaction, so this reads back what withOrgRls/withOrgDb set — and reads
  // back '' (or another org) when the caller forgot the wrapper.
  const scopeRows: Array<{ org_id: string | null }> = Array.from(
    await (db as any).execute(sql`select current_setting('app.org_id', true) as org_id`),
  );
  const scope = scopeRows[0]?.org_id ?? "";
  if (scope !== orgId) {
    throw new Error(
      `provisionWorkspace: not in workspace '${orgId}' scope (app.org_id is ${scope ? `'${scope}'` : "unset"}); ` +
        "call it inside withOrgRls(orgId, …) / withOrgDb(orgId, …) or the fail-closed policy refuses every insert",
    );
  }

  let recipesCreated = 0;
  let recipesSkipped = 0;
  // The deployment profile's catalog, in its words. None by default.
  const catalog = source.recipes ?? deploymentRecipes();
  for (let i = 0; i < catalog.length; i++) {
    const r = catalog[i];
    // Idempotent by slug within the org: an org can add or override its own.
    const have = await (db as any)
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.orgId, orgId), eq(recipes.slug, r.slug)))
      .limit(1);
    if (have.length > 0) {
      recipesSkipped++;
      continue;
    }
    await (db as any).insert(recipes).values({
      orgId,
      slug: r.slug,
      version: "1",
      title: r.title,
      summary: r.summary,
      satisfiesCheck: r.satisfiesCheck,
      sortOrder: i,
    });
    recipesCreated++;
  }

  let created = 0;
  let skipped = 0;

  // The library this deployment's profile names: no workflow that needs an excluded specialist, and every
  // prompt in the profile's words (agent/lib/workflow-library-view.ts). None by default.
  for (const wf of source.workflows ?? deploymentWorkflowLibrary()) {
    // Scoped by org: the same workflow name legitimately exists in every
    // workspace, so an unscoped existence check would seed only the first one.
    const existing = await (db as any)
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.name, wf.name), eq(workflows.orgId, orgId)))
      .limit(1);

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    await (db as any).insert(workflows).values({
      orgId,
      name: wf.name,
      description: wf.description,
      trigger: "manual",
      steps: wf.steps as unknown as string[],
      script: wf.script,
      instructions: null,
      instructionsEnabled: false,
      enabled: true,
      createdBy: actor,
    });
    created++;
  }

  // One "on delegation" row per declared subagent (see seedSubagentWorkflowRows).
  const sub = await seedSubagentWorkflowRows(db, orgId, actor, source.specialists);
  created += sub.created;
  skipped += sub.skipped;

  return { recipesCreated, recipesSkipped, workflowsCreated: created, workflowsSkipped: skipped };
}

/**
 * One "on delegation" `workflows` row per declared subagent, idempotent.
 *
 * The row's NAME is what a subagent's hooks/usage.ts files its runs under (workflow-usage.ts resolves by name)
 * and what its operator override is read from, so a subagent without one runs unrecorded and cannot be tuned.
 * Discovered from the generated registry, not listed: a subagent added as a directory, or by a pack, gets its
 * row the next time this runs. A specialist the profile EXCLUDES gets none: the registry is generated without
 * them, and the list is filtered here as well, so a registry generated before the exclusion cannot seed one. provisionWorkspace calls it for a new workspace; for an EXISTING workspace run
 * `npm run operator:seed-subagent-rows -- --org <id>`, which touches nothing else.
 *
 * `db` must already be scoped to `orgId` (withOrgDb / withOrgRls), as for provisionWorkspace.
 */
export async function seedSubagentWorkflowRows(
  db: AnyDb,
  orgId: string,
  actor = "system",
  specialists: readonly { key: string; summary: string }[] = deploymentSpecialists(),
): Promise<{ created: number; skipped: number }> {
  if (!orgId) throw new Error("seedSubagentWorkflowRows: orgId is required");
  let created = 0;
  let skipped = 0;
  for (const { key, summary } of specialists) {
    const existing = await (db as any)
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.name, key), eq(workflows.orgId, orgId)))
      .limit(1);
    if (existing.length > 0) {
      skipped++;
      continue;
    }
    await (db as any).insert(workflows).values({
      orgId,
      name: key,
      description: summary,
      trigger: "on delegation",
      steps: [],
      script: null,
      instructions: null,
      instructionsEnabled: false,
      enabled: true,
      createdBy: actor,
    });
    created++;
  }
  return { created, skipped };
}
