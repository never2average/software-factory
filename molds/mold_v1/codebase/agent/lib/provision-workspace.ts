/**
 * Seed a newly-created workspace so it is usable on arrival.
 *
 * Creating an org used to write four things — the org row, the owner's
 * membership, a platform-admin row, and the global recipe catalog — and stop.
 * The workspace that came out had no workflows at all, so the first thing a new
 * customer saw was an empty product, and the only fix was an FDE remembering to
 * run `fde:seed-workflows` by hand against the right `--org`.
 *
 * Both creation paths (the `fde:new-org` CLI and the self-serve wizard's
 * POST /api/ops/orgs) call this, so they cannot drift apart. That is also why
 * the recipe catalog lives HERE and not in the CLI: for a while the CLI seeded
 * recipes and the wizard did not, so a self-serve workspace had an onboarding
 * checklist with nothing in it.
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
 * a re-provision must not silently discard a customer's changes.
 *
 * Scope note: the recipe catalog also advertises "default apps and crons";
 * nothing in the codebase defines either, so nothing is invented here. When
 * they exist, they belong in this function.
 */
import { and, eq, sql } from "drizzle-orm";
import { recipes, workflows } from "./db/schema.ts";
import { SUBAGENT_KEYS, SUBAGENT_SUMMARIES } from "./subagent-registry.generated.ts";
import { deploymentWorkflowLibrary } from "./workflow-library-view.ts";

/**
 * The built-in recipe catalog, seeded PER WORKSPACE (`recipes.org_id` is NOT
 * NULL and the policy scopes reads to one org, so a "global" row has nowhere to
 * live). Order is the checklist order. `satisfiesCheck` names the org-health
 * check the recipe turns green.
 */
export const BUILTIN_RECIPES = [
  { slug: "onboard-self", title: "Sign in & record yourself", summary: "Get signed in, wired to the data room over MCP, and recorded as an operator.", satisfiesCheck: "members" },
  { slug: "import-roster", title: "Import the roster", summary: "Pull people from Google Directory or a CSV into the roster.", satisfiesCheck: "roster" },
  { slug: "connect-sources", title: "Connect a source", summary: "Wire one connector (GitHub, Slack, …) and store its secret.", satisfiesCheck: "connector" },
  { slug: "seed-workflows", title: "Seed the workflow library", summary: "Install the starter workflow library, default apps, and crons.", satisfiesCheck: "workflows" },
  { slug: "onboard-customer", title: "Onboard the first customer", summary: "Create the first customer account and its data-room skeleton.", satisfiesCheck: "customer" },
] as const;

/** Minimal shape of the Drizzle transaction handle both callers hold. */
type AnyDb = {
  select: (...args: never[]) => any;
  insert: (...args: never[]) => any;
  execute: (...args: never[]) => any;
};

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
  for (let i = 0; i < BUILTIN_RECIPES.length; i++) {
    const r = BUILTIN_RECIPES[i];
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

  // The library as this deployment's profile has it: no workflow that needs an excluded specialist, and every
  // prompt in the profile's words (agent/lib/workflow-library-view.ts). The whole library by default.
  for (const wf of deploymentWorkflowLibrary()) {
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
  const sub = await seedSubagentWorkflowRows(db, orgId, actor);
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
 * row the next time this runs. provisionWorkspace calls it for a new workspace; for an EXISTING workspace run
 * `npm run fde:seed-subagent-rows -- --org <id>`, which touches nothing else.
 *
 * `db` must already be scoped to `orgId` (withOrgDb / withOrgRls), as for provisionWorkspace.
 */
export async function seedSubagentWorkflowRows(
  db: AnyDb,
  orgId: string,
  actor = "system",
): Promise<{ created: number; skipped: number }> {
  if (!orgId) throw new Error("seedSubagentWorkflowRows: orgId is required");
  let created = 0;
  let skipped = 0;
  for (const key of SUBAGENT_KEYS) {
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
      description: SUBAGENT_SUMMARIES[key] ?? "",
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
