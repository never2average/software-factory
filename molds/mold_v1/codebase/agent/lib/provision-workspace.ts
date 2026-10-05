/**
 * Seed a newly-created workspace so it is usable on arrival.
 *
 * WHAT is seeded is not decided here. Base code carries no workflow and no recipe of its own:
 *
 *   - the recipe catalog and the workflow library are the deployment profile's (`library.sources` in
 *     profiles/*.json, compiled into workflow-library.generated.ts and read through workflow-library-view.ts).
 *     The default profile names none, so a deployment that adds nothing provisions neither;
 *   - one "on delegation" row per specialist THIS deployment has: the generated registry (base specialists and any
 *     pack's), minus the ones the profile excludes;
 *   - the library's STARTER APPS (`<library>/apps.json`): the apps the workspace's Apps tab opens with. Created as
 *     definitions only; no model runs here (see provisionStarterApps).
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
import { apps, recipes, workflows } from "./db/schema.ts";
import { sourceProblem, workflowAppSource } from "../../lib/app-source.ts";
import { SUBAGENT_KEYS, SUBAGENT_SUMMARIES } from "./subagent-registry.generated.ts";
import { deploymentRecipes, deploymentStarterApps, deploymentWorkflowLibrary } from "./workflow-library-view.ts";
import { VOCABULARY } from "./agent-vocabulary.ts";
import type { LibraryRecipe, LibraryStarterApp, LibraryWorkflow } from "./workflow-library.generated.ts";

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
  /**
   * The starter apps to create. `false`: none, whatever the library ships. A caller that is provisioning a workspace
   * that ALREADY EXISTS passes false (`operator:new-org --force`): an existing workspace gets starter apps only from
   * `npm run operator:library-apply`, which shows what it would add first.
   */
  readonly starterApps?: readonly LibraryStarterApp[] | false;
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
  /** Starter apps created by this run, and the ones it left alone (already there, deleted by a person, …). */
  readonly starterAppsCreated: number;
  readonly starterAppsSkipped: number;
  readonly starterApps: StarterAppsResult;
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

  // The library's starter apps, last: each is generated by a row the two steps above created.
  const starter =
    source.starterApps === false
      ? { created: [], skipped: [] }
      : await provisionStarterApps(db, orgId, source.starterApps ?? deploymentStarterApps());

  return {
    recipesCreated,
    recipesSkipped,
    workflowsCreated: created,
    workflowsSkipped: skipped,
    starterAppsCreated: starter.created.length,
    starterAppsSkipped: starter.skipped.length,
    starterApps: starter,
  };
}

/** Who a starter app is created by. Never a person: nobody asked for it, the deployment's library did. */
export const STARTER_APP_AUTHOR = "system";

/** "Weekly digest" -> "weekly-digest": the app's url handle, as POST /api/ops/apps derives it. */
function appSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "app";
}

export interface StarterAppsResult {
  /** Created by this run (or, in a dry run, what would be). `id` is absent in a dry run. */
  readonly created: readonly { key: string; name: string; id?: string; firstContent: "on_open" | "on_create" }[];
  /** Left alone, with why. */
  readonly skipped: readonly { key: string; name: string; why: "present" | "deleted" | "name-taken" | "no-source"; detail: string }[];
}

/**
 * Create the deployment library's STARTER APPS in a workspace: the apps its Apps tab opens with.
 *
 * WHAT they are is the library's (`<library>/apps.json`, compiled into workflow-library.generated.ts and read through
 * workflow-library-view.ts in the profile's words). The default profile names no library, so there are none; base
 * code carries none of its own (`npm run check:neutral-names`).
 *
 * NOTHING IS GENERATED HERE. A starter app is created as a definition with no document: no model runs because a
 * workspace was created. Its first document is written when a person first opens it, or when its schedule first
 * comes due (`first_content: "on_open"`, the default), or by the request that created the workspace when the library
 * says `"on_create"` (POST /api/ops/orgs starts that refresh; this function only reports which ones asked).
 *
 * IDEMPOTENT, and it never brings back what a person removed. Every row carries `starter_key`
 * (`<library id>/<key>`), unique per workspace:
 *   - a row with the key exists                      -> left exactly as it is, whatever a person changed on it;
 *   - a row with the key exists and is soft-deleted  -> left deleted. A person removed it; it is not created again;
 *   - a live app already has the same name           -> not created (a person's app; two of one name cannot be told
 *                                                       apart in the Apps tab);
 *   - its source is not in the workspace             -> not created, and the reason says which command adds it.
 * The insert is ON CONFLICT DO NOTHING on the key, so two runs at once create one row.
 *
 * `db` must already be scoped to `orgId` (withOrgDb / withOrgRls), as for provisionWorkspace. `dryRun`: decide and
 * report, write nothing (`npm run operator:library-apply` without --apply).
 */
export async function provisionStarterApps(
  db: AnyDb,
  orgId: string,
  starterApps: readonly LibraryStarterApp[] = deploymentStarterApps(),
  options: { dryRun?: boolean } = {},
): Promise<StarterAppsResult> {
  if (!orgId) throw new Error("provisionStarterApps: orgId is required");
  const created: { key: string; name: string; id?: string; firstContent: "on_open" | "on_create" }[] = [];
  const skipped: { key: string; name: string; why: "present" | "deleted" | "name-taken" | "no-source"; detail: string }[] = [];
  if (!starterApps.length) return { created, skipped };

  // Every app row of the workspace, deleted ones included: a deleted starter app keeps its key.
  const existing: Array<{ id: string; name: string; starterKey: string | null; deletedAt: Date | null }> = await (db as any)
    .select({ id: apps.id, name: apps.name, starterKey: apps.starterKey, deletedAt: apps.deletedAt })
    .from(apps)
    .where(eq(apps.orgId, orgId));
  const rows: Array<{ name: string; script: string | null; trigger: string | null }> = await (db as any)
    .select({ name: workflows.name, script: workflows.script, trigger: workflows.trigger })
    .from(workflows)
    .where(eq(workflows.orgId, orgId));

  for (const app of starterApps) {
    const mine = existing.find((e) => e.starterKey === app.key);
    if (mine) {
      skipped.push(
        mine.deletedAt
          ? { key: app.key, name: app.name, why: "deleted", detail: "a person deleted it from this workspace; it is not created again" }
          : { key: app.key, name: app.name, why: "present", detail: "already in this workspace" },
      );
      continue;
    }
    if (existing.some((e) => !e.deletedAt && e.name.trim().toLowerCase() === app.name.trim().toLowerCase())) {
      skipped.push({ key: app.key, name: app.name, why: "name-taken", detail: "this workspace already has an app of that name" });
      continue;
    }
    // The decision every other door asks (lib/app-source.ts): can this row generate a document here?
    const source = workflowAppSource(rows.find((r) => r.name === app.source), app.source);
    if (!source.ok) {
      const add = app.sourceKind === "specialist" ? "npm run operator:seed-subagent-rows -- --org <id>" : "npm run operator:seed-workflows -- --org <id>";
      skipped.push({ key: app.key, name: app.name, why: "no-source", detail: `${sourceProblem(source)} (${add} adds what this build's library and specialists provide.)` });
      continue;
    }
    if (options.dryRun) {
      created.push({ key: app.key, name: app.name, firstContent: app.firstContent });
      continue;
    }
    const inserted: Array<{ id: string }> = await (db as any)
      .insert(apps)
      .values({
        orgId,
        slug: appSlug(app.name),
        name: app.name,
        description: app.description,
        // A starter app is generated by a row of this workspace: a specialist's row (its brief is what the
        // specialist is asked for) or a library workflow's (its script's return value is the document).
        sourceKind: "workflow",
        workflow: app.source,
        prompt: app.brief,
        refreshCron: app.refreshCron,
        enabled: true,
        createdBy: STARTER_APP_AUTHOR,
        starterKey: app.key,
      })
      .onConflictDoNothing({ target: [apps.orgId, apps.starterKey] })
      .returning({ id: apps.id });
    if (inserted.length) created.push({ key: app.key, name: app.name, id: inserted[0].id, firstContent: app.firstContent });
    else skipped.push({ key: app.key, name: app.name, why: "present", detail: "created by another run at the same moment" });
  }
  return { created, skipped };
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
