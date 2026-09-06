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
 * POST /api/ops/orgs) call this, so they cannot drift apart.
 *
 * Idempotent: safe to re-run on an existing workspace. It only inserts what is
 * missing and never overwrites a workflow someone has since edited — a
 * re-provision must not silently discard a customer's changes.
 *
 * Scope note: this seeds the workflow library, which is the part that actually
 * exists. The recipe catalog also advertises "default apps and crons"; nothing
 * in the codebase defines either, so nothing is invented here. When they exist,
 * they belong in this function.
 */
import { and, eq } from "drizzle-orm";
import { workflows } from "./db/schema.ts";
import { WORKFLOW_LIBRARY } from "./workflow-library.generated.ts";

/** Minimal shape of the Drizzle db handle both callers hold. */
type AnyDb = {
  select: (...args: never[]) => any;
  insert: (...args: never[]) => any;
};

export interface ProvisionResult {
  readonly workflowsCreated: number;
  readonly workflowsSkipped: number;
}

export async function provisionWorkspace(
  db: AnyDb,
  orgId: string,
  actor = "system",
): Promise<ProvisionResult> {
  if (!orgId) throw new Error("provisionWorkspace: orgId is required");

  let created = 0;
  let skipped = 0;

  for (const wf of WORKFLOW_LIBRARY) {
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

  return { workflowsCreated: created, workflowsSkipped: skipped };
}
